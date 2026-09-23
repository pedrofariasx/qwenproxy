import type { Context } from 'hono';
import crypto from 'crypto';
import { createQwenStream, RetryableQwenStreamError, QwenUpstreamError } from '../services/qwen.js';
import { recordAccountBlock, requiresCrossAccountBootstrap, noteAccountRecovery } from '../core/account-isolation.js';
import type { OpenAIRequest } from '../utils/types.js';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.js';
import { getNextAccount, getNextAvailableAccount, getAccountById, onAccountFreed, getAccountCooldownInfo, markAccountInUse, releaseAccountInUse, getInUseAccounts } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { registerStream, removeStream, getStream } from '../core/stream-registry.js';
import { metrics } from '../core/metrics.js'
import { config } from '../core/config.js';

// Tracks the last time each session's server-side history was verified, so the
// HYBRID_SESSION_VERIFY_EVERY_MS throttle can skip the network round-trip.
const lastSessionVerify = new Map<string, number>();

function pruneStaleVerifyEntries(): void {
  if (lastSessionVerify.size <= 1000) return;
  const cutoff = Date.now() - (config.hybridSessions.ttlMs || 86400000);
  for (const [key, ts] of lastSessionVerify) {
    if (ts < cutoff) lastSessionVerify.delete(key);
  }
}

function msUntilMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}
import { getSession, resolveSessionKey } from '../services/session-manager.js';
import { lookupToolCall } from '../core/tool-call-registry.js';
import type { SessionEntry } from '../services/session-manager.js';
import { fetchQwenChatHistory } from '../services/qwen.js';
import {
  getForcedToolName,
  getRecentToolNames,
  selectCandidateTools,
  buildCompactToolManifest,
  buildToolCallContract,
  getToolChoiceMode,
} from './tool-handler.js';
import { handleStreamingResponse, collectNonStreamingResult } from './stream-handler.js';
import { buildAnswerDirective } from '../utils/degenerate-answer.js';
import { checkUserRateLimit, tryAcquireUserSlot, releaseUserSlot, getUserActiveStreams } from '../core/user-manager.js';
import { getRuntimeBool } from '../core/runtime-config.js';
import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE, wrapToolCallPayload } from '../tools/toolcall-tags.js';
import type { UserIdentity } from '../core/user-manager.js';
import { trackUsage, trackModelUsage } from '../core/usage-tracker.js';

export { getIncrementalDelta } from './sse-parser.js';
export type { DeltaResult } from './sse-parser.js';

/**
 * Verifies against the Qwen server that the pinned session chat still mirrors
 * the client's conversation before economical mode is allowed. A mismatch (edited
 * messages, reset conversation, stale parent) forces a fresh bootstrap so the
 * served context — and therefore the answers — never diverge from what the
 * client believes the conversation is.
 */
async function verifyServerContextMatches(sessionKey: string, session: SessionEntry, _lastUserContent: string): Promise<boolean> {
  try {
    const history = await fetchQwenChatHistory(
      session.chatId,
      session.headers,
      session.accountId === 'global' ? undefined : session.accountId,
      12,
    );
    if (!history.hasHistory || history.messages.length === 0) return false;
    const msgs = history.messages;
    const last = msgs[msgs.length - 1];

    // The server must be synced exactly to our parent: the last message must
    // be the assistant reply we threaded onto. If it moved past it (extra user
    // turn / edits elsewhere), fall back to a full re-bootstrap.
    if (last.role !== 'assistant') return false;

    // Adopt the parent when we do not have one yet (e.g. the stream never
    // emitted response.created). The chat is pinned to this session, so its
    // most recent assistant reply is ours to thread onto.
    if (!session.parentId) {
      session.parentId = last.id;
      return true;
    }
    if (last.id !== session.parentId) {
      console.warn(`[Chat] Session ${sessionKey}: server parent (${last.id}) != tracked (${session.parentId}). Re-syncing.`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[Chat] Session verification failed for ${sessionKey}:`, err.message);
    return false;
  }
}

/**
 * Builds a compact summary of the most recent assistant tool calls and tool
 * responses to embed in the economical prompt. Without this, economical mode
 * only sends `system + last user message` and the model loses stateful context
 * like to-do lists, file edits, or other actions it performed on prior turns.
 */
function buildRecentToolContext(
  messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }>,
): string {
  if (!messages || messages.length === 0) return '';

  const idToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) idToName.set(tc.id, tc.function.name);
      }
    }
  }

  // Peel trailing user message(s): the current prompt is the LAST user message,
  // so the tool activity of THIS cycle sits just before it.
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role === 'user') i--;

  const toolTurns: string[] = [];
  const MAX_TOOL_TURNS = 6;
  const MAX_ARG_CHARS = 400;
  const MAX_RESPONSE_CHARS = 600;

  for (; i >= 0 && toolTurns.length < MAX_TOOL_TURNS * 2; i--) {
    const msg = messages[i];
    // A user message below the trailing tail marks the start of the cycle.
    if (msg.role === 'user') break;

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (let j = msg.tool_calls.length - 1; j >= 0; j--) {
        const tc = msg.tool_calls[j];
        const name = tc.function?.name || 'unknown';
        let argsStr = tc.function?.arguments || '';
        if (typeof argsStr !== 'string') {
          try { argsStr = JSON.stringify(argsStr); } catch { argsStr = ''; }
        }
        if (argsStr.length > MAX_ARG_CHARS) argsStr = argsStr.slice(0, MAX_ARG_CHARS) + '...[truncated]';
        toolTurns.unshift(`  [call] ${name}(${argsStr})`);
      }
      const assistantText = (typeof msg.content === 'string' ? msg.content : '').trim();
      if (assistantText) {
        const truncated = assistantText.length > MAX_RESPONSE_CHARS
          ? assistantText.slice(assistantText.length - MAX_RESPONSE_CHARS) + '...[truncated]'
          : assistantText;
        toolTurns.unshift(`  [assistant] ${truncated}`);
      }
    } else if (msg.role === 'tool' || msg.role === 'function') {
      const name = msg.name || idToName.get(msg.tool_call_id || '') || 'tool';
      const contentStr = (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)) || '';
      const truncated = contentStr.length > MAX_RESPONSE_CHARS
        ? contentStr.slice(0, MAX_RESPONSE_CHARS) + '...[truncated]'
        : contentStr;
      toolTurns.unshift(`  [tool_response ${name}] ${truncated}`);
    }
  }

  if (toolTurns.length === 0) return '';
  return `# RECENT TOOL ACTIVITY (you performed these actions earlier in this session — preserve state awareness):\n${toolTurns.join('\n')}\n`;
}

export async function chatCompletions(c: Context) {
  const user = (c as any).get?.('user') as UserIdentity | undefined;
  let userSlotHeld = false;
  let userSlotReleased = false;
  const releaseUserSlotOnce = () => {
    if (!userSlotHeld || userSlotReleased || !user) return;
    userSlotReleased = true;
    releaseUserSlot(user.id);
  };
  let usageInputText = '';
  let usageModel = '';
  const completionStart = Date.now();

  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;

    const VALID_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (body.reasoning_effort !== undefined && !VALID_REASONING_EFFORTS.includes(body.reasoning_effort)) {
      return c.json({ error: { message: `Invalid reasoning_effort: '${body.reasoning_effort}'. Valid values: ${VALID_REASONING_EFFORTS.join(', ')}` } }, 400);
    }

    metrics.increment('requests.completions');

    if (user) {
      if (!checkUserRateLimit(user.id, user.rateLimitRpm)) {
        return c.json({ error: { message: `Rate limit exceeded for user ${user.id}` } }, 429);
      }
      if (!tryAcquireUserSlot(user.id, user.maxConcurrency)) {
        return c.json({ error: { message: `Concurrency limit exceeded for user ${user.id} (max ${user.maxConcurrency})` } }, 429);
      }
      userSlotHeld = true;
      if (getUserActiveStreams(user.id) <= user.maxConcurrency) {
        console.log(`[Chat] user=${user.id} activeStreams=${getUserActiveStreams(user.id)}`);
      }
    }
    
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    // Accumulate into arrays and join once at the end. For long conversations this
    // avoids repeated O(n) string reallocation on every `+=`.
    const promptParts: string[] = [];
    const systemPromptParts: string[] = [];
    const pendingMultimodal: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>> = [];

    const toolCallIdToName = new Map<string, string>();
    // Resolve the session's chat id early so the tool_response replay below can
    // fall back to the emitted-tool registry when the client omits the original
    // assistant tool_calls message from history.
    const earlyRawSessionKey = (typeof (body as any).user === 'string' && (body as any).user.trim())
      ? (body as any).user.trim()
      : (c.req.header('x-qwen-session') || c.req.header('x-session-id') || undefined);
    const sessionChatId = earlyRawSessionKey
      ? getSession(resolveSessionKey(earlyRawSessionKey) ?? earlyRawSessionKey)?.chatId
      : undefined;
    let lastUserContent = '';
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
        for (const tc of (msg as any).tool_calls) {
          if (tc.id && tc.function?.name) {
            toolCallIdToName.set(tc.id, tc.function.name);
          }
        }
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const multimodalParts: Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }> = [];
        
        for (const p of msg.content as any[]) {
          if (p.type === "text" && p.text) {
            textParts.push(p.text);
          } else if (
            (p.type === "image_url" && p.image_url?.url) ||
            (p.type === "video_url" && p.video_url?.url) ||
            (p.type === "audio_url" && p.audio_url?.url) ||
            (p.type === "file_url" && p.file_url?.url)
          ) {
            multimodalParts.push(p);
          }
        }
        
        contentStr = textParts.join("\n");
        if (multimodalParts.length > 0) {
          pendingMultimodal.push(multimodalParts);
        }
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPromptParts.push((contentStr || '') + '\n');
      } else if (msg.role === 'user') {
        lastUserContent = contentStr || '';
        promptParts.push(`User: ${contentStr || ''}\n`);
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); }
               catch { parsedArgs = args; } // keep the raw string: better than losing the tool call details
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
              const payload = { name: tc.function?.name, arguments: parsedArgs };
              const toolCallStr = wrapToolCallPayload(JSON.stringify(payload));
              assistantContent = assistantContent ? assistantContent + '\n' + toolCallStr : toolCallStr;
           }
        }
        promptParts.push(`Assistant: ${assistantContent.trim()}\n`);
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          toolName = toolCallIdToName.get(msg.tool_call_id);
          if (!toolName) {
            const rec = sessionChatId ? lookupToolCall(sessionChatId, msg.tool_call_id) : undefined;
            if (rec) toolName = rec.name;
          }
        }
        promptParts.push(`Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n`);
      }
    }

    systemPrompt = systemPromptParts.length ? systemPromptParts.join('\n') + '\n' : '';
    prompt = promptParts.length ? promptParts.join('\n') + '\n' : '';

    const bodyAny = body as any;
    const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;
    // A conversation is a tool loop whenever `tools` is declared OR the history
    // contains tool responses / assistant tool_calls — even if the client stops
    // sending the `tools` parameter on later turns. Economical mode must never
    // kick in here, otherwise the tool responses vanish from context and the
    // model degenerates into repeating "Tool Response".
    const hasToolConversation =
      hasTools ||
      messages.some(
        (m) =>
          m.role === 'tool' ||
          m.role === 'function' ||
          (m.role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0)
      );
    const toolChoiceMode = getToolChoiceMode(bodyAny.tool_choice);
    // Surface/parse tool calls whenever the conversation is a tool loop, even on
    // turns where the client stopped sending the `tools` parameter.
    const parseToolCalls = hasToolConversation && toolChoiceMode !== 'none';
    if (hasTools && toolChoiceMode !== 'none') {
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in ${TOOL_CALL_OPEN} ... ${TOOL_CALL_CLOSE} tags:\n\n${TOOL_CALL_OPEN}\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n${TOOL_CALL_CLOSE}\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n${TOOL_CALL_OPEN}\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n${TOOL_CALL_CLOSE}\n${TOOL_CALL_OPEN}\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n${TOOL_CALL_CLOSE}\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple ${TOOL_CALL_OPEN} blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your ${TOOL_CALL_OPEN} blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n6. NEVER invent, guess, or hallucinate tool names. You MUST ONLY use the exact tool names provided in the 'TOOLS AVAILABLE' list above. Calling an unlisted tool will result in a hard execution error.\n\n`;
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const modelId = body.model.replace('-no-thinking', '').replace('-thinking', '');
    const inputText = systemPrompt + prompt;
    usageInputText = inputText;
    usageModel = modelId;
    const modelContextWindow = getModelContextWindow(modelId)
    const estimatedTokens = estimateTokenCount(inputText, modelId);
    const forcedToolName = getForcedToolName(bodyAny.tool_choice);
    const parallelToolCalls = bodyAny.parallel_tool_calls !== false && toolChoiceMode !== 'forced';
    const toolContextText = `${systemPrompt}\n${prompt}`;
    const recentToolNames = hasTools ? getRecentToolNames(messages) : new Set<string>();
    const candidateTools = hasTools ? selectCandidateTools(bodyAny.tools, toolContextText, forcedToolName, recentToolNames) : [];
    
    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt, modelId);
      const truncatedBody = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
      finalPrompt = systemPrompt ? `${systemPrompt}\n\n${truncatedBody}` : truncatedBody;
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    if (hasTools && toolChoiceMode === 'none') {
      finalPrompt += '\n\n[TOOL USE DISABLED]\nDo not call tools in this response. Answer directly using available context.';
    }

    if (hasTools && toolChoiceMode !== 'none') {
      const compactManifest = buildCompactToolManifest(candidateTools, forcedToolName);
      const toolContract = buildToolCallContract(candidateTools, forcedToolName, parallelToolCalls);
      finalPrompt += `\n\n${toolContract}`;
      if (compactManifest) finalPrompt += `\n\n${compactManifest}`;
    }

    const isThinkingModel = body.reasoning_effort !== undefined
      ? body.reasoning_effort !== 'none'
      : !body.model.includes('no-thinking');

    const rawSessionKey = (typeof bodyAny.user === 'string' && bodyAny.user.trim())
      ? bodyAny.user.trim()
      : (c.req.header('x-qwen-session') || c.req.header('x-session-id') || undefined);
    const sessionKey = rawSessionKey ? (resolveSessionKey(rawSessionKey) ?? rawSessionKey) : undefined;
    const session = sessionKey ? getSession(sessionKey) : undefined;
    const lastMsg = messages[messages.length - 1];
    // Economical mode sends only the trailing cycle (tool calls, tool
    // responses and the final user message). It is safe for tool loops because
    // the cycle text carries the tool state; older turns stay server-side.
    // Economical mode is safe for tool conversations: it sends the final user
    // message plus a compact summary of the trailing tool activity while the
    // rest of the conversation stays threaded server-side. Prior context is
    // guaranteed by historyComplete + the parent-based server verification, so
    // even all-tool_calls conversations can economize.
    // Tool loops send intermediate turns whose LAST message is a tool/function
    // result (not a user message). Without this, every intermediate turn was
    // treated as non-economical, so the proxy minted a FRESH chat each turn,
    // re-registering the session and losing Qwen's server-side history — the
    // full conversation was re-sent every time (huge prompts) and the session
    // never stabilised. Threading the tool responses into the pinned chat keeps
    // continuity exactly like the Qwen web UI (tool results are user messages).
    const isToolResultTurn = hasToolConversation &&
      (lastMsg?.role === 'tool' || lastMsg?.role === 'function');

    let canEconomize = !!(
      session?.historyComplete &&
      session.accountId !== 'guest' &&
      pendingMultimodal.length === 0 &&
      (
        (lastMsg?.role === 'user' && !!lastUserContent) ||
        isToolResultTurn
      )
    );

    if (canEconomize && config.hybridSessions.verify) {
      // Throttle the server-history verification: it is a network round-trip to
      // Qwen on every economical turn. Once verified, skip for verifyEveryMs
      // (default 60s) — sessions rarely diverge mid-tool-loop.
      const verifyEveryMs = config.hybridSessions.verifyEveryMs || 60000;
      let usable = true;
      const lastVerify = lastSessionVerify.get(sessionKey!) || 0;
      if (Date.now() - lastVerify >= verifyEveryMs) {
        usable = await verifyServerContextMatches(sessionKey!, session!, lastUserContent);
        if (usable) {
          lastSessionVerify.set(sessionKey!, Date.now());
          pruneStaleVerifyEntries();
        }
      }
      if (!usable) {
        console.warn(`[Chat] Session ${sessionKey} diverged from server; falling back to full bootstrap.`);
        canEconomize = false;
      }
    }
    let economicalPrompt: string | undefined;
    if (canEconomize) {
      const recentToolContext = buildRecentToolContext(messages);
      const parts: string[] = [];
      if (systemPrompt) parts.push(systemPrompt);
      if (recentToolContext) parts.push(recentToolContext);
      if (lastMsg?.role === 'user') {
        parts.push(`User: ${lastUserContent}`);
      }
      economicalPrompt = parts.join('\n');
      if (!economicalPrompt.trim()) canEconomize = false;
    }
    const baseStreamOptions = { sessionKey, economicalPrompt };

    const isGuestModeOnly = getRuntimeBool('QWEN_GUEST_MODE_ONLY', false);
    const completionId = 'chatcmpl-' + crypto.randomUUID();
    const stopToken = crypto.randomUUID();
    let lastError: any = null;

    const obtainStream = async (
      promptForStream: string,
      forceBootstrapOverride = false,
    ): Promise<{ stream: ReadableStream; uiSessionId: string; accountId: string }> => {
      if (isGuestModeOnly) {
        console.log('[Chat] Guest mode only enabled. Bypassing account rotation.');
        try {
          const result = await createQwenStream(
            promptForStream,
            isThinkingModel,
            body.model,
            null,
            'guest',
            undefined,
            pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
            { ...baseStreamOptions, forceBootstrap: true }
          );
          registerStream(completionId, {
            abortController: result.controller,
            accountId: 'guest',
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
            stopToken,
          });
          return { stream: result.stream, uiSessionId: result.uiSessionId, accountId: 'guest' };
        } catch (err: any) {
          console.error('[Chat] Guest mode failed:', err.message);
          throw err;
        }
      }

      let account = sessionKey
        ? (getAccountById(session?.accountId ?? '') ?? getNextAccount())
        : getNextAccount();
      const triedAccountIds = new Set<string>();

      if (!account) {
        const inUse = getInUseAccounts();
        if (inUse.length === 0) {
          throw new RetryableQwenStreamError('No available account lanes', 1000);
        }

        const waitStart = Date.now();
        const MAX_LANE_WAIT_MS = 30000;
        while (!account) {
          const elapsed = Date.now() - waitStart;
          if (elapsed > MAX_LANE_WAIT_MS) {
            throw new RetryableQwenStreamError(
              `All configured account lanes are busy: ${getInUseAccounts().join(', ')}`,
              1000
            );
          }
          // Drain-based wait: pop as soon as any account slot frees, with a
          // short poll interval as a safety net instead of a blind 300ms sleep.
          const freed = onAccountFreed();
          await Promise.race([
            new Promise(r => setTimeout(r, 300)),
            freed.promise,
          ]);
          freed.cancel();
          account = getNextAccount();
        }
        console.log(`[Chat] Waited ${Date.now() - waitStart}ms for a free lane`);
      }

      while (account) {
        const accountId = account.id;
        const accountEmail = account.email;

        // Session-state isolation guard: if this request's pinned session belongs
        // to a DIFFERENT account than the one we are about to route to (e.g. the
        // pinned account is on cooldown), do NOT reuse the cross-account chat —
        // force a fresh bootstrap on the selected account and re-pin there.
        const mustBootstrap = requiresCrossAccountBootstrap(accountId, session?.accountId);

        if (triedAccountIds.has(accountId)) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }
        triedAccountIds.add(accountId);

        const cooldownInfo = getAccountCooldownInfo(accountId);
        if (cooldownInfo && accountId !== 'global') {
          console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }

        console.log(`[Chat] Routing request to account: ${accountEmail} (${accountId})`);
        markAccountInUse(accountId);

        let retries = 3;
        let retryDelay = 500;
        let success = false;
        let attempt = 0;

        try {
          while (retries > 0) {
            attempt++;
            try {
              const result = await createQwenStream(
                promptForStream,
                isThinkingModel,
                body.model,
                null,
                accountId === 'global' ? undefined : accountId,
                undefined,
                pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
                { ...baseStreamOptions, forceBootstrap: forceBootstrapOverride || attempt > 1 || mustBootstrap }
              );
              registerStream(completionId, {
                abortController: result.controller,
                accountId: result.accountId,
                uiSessionId: result.uiSessionId,
                targetResponseId: '',
                headers: result.headers,
                stopToken,
              });
              success = true;
              releaseAccountInUse(accountId);
              noteAccountRecovery(accountId);
              return { stream: result.stream, uiSessionId: result.uiSessionId, accountId };
            } catch (err: any) {
              retries--;

              if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
                const hourHint = err.message?.match(/Wait about (\d+) hour/);
                const hours = hourHint ? parseInt(hourHint[1]) : 24;
                const cooldownMs = hours * 60 * 60 * 1000;
                recordAccountBlock(accountId, 'rate-limited', err.message, { cooldownMs });
                console.warn(`[Chat] Account ${accountEmail} (${accountId}) rate-limited. Entering cooldown for ${hours} hours.`);
                lastError = err;
                break;
              }

              // Hard anti-bot block (captcha / TMD challenge). Quarantine AND rotate
              // the account's fingerprint + reset its browser context so recovery is
              // as a fresh device — this prevents the flag from re-propagating.
              if (err instanceof QwenUpstreamError && err.upstreamStatus === 403) {
                recordAccountBlock(accountId, 'captcha', err.message);
                console.warn(`[Chat] Account ${accountEmail} (${accountId}) hit an anti-bot challenge. Quarantined with fingerprint rotation.`);
                lastError = err;
                break;
              }

              if (retries === 0) {
                if (err instanceof QwenUpstreamError && err.upstreamStatus && err.upstreamStatus >= 500) {
                  recordAccountBlock(accountId, 'server-error', err.message);
                  console.warn(`[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
                }
                lastError = err;
                break;
              }

              let useDelay = retryDelay;
              if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
                useDelay = err.retryAfterMs;
              }
              const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
              if (!isRetryable) {
                lastError = err;
                break;
              }
              console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
              await new Promise(r => setTimeout(r, useDelay));
              retryDelay = Math.min(retryDelay * 2, 5000);
            }
          }
        } finally {
          if (!success) {
            releaseAccountInUse(accountId);
          }
        }

        if (success) {
          break;
        }

        account = getNextAvailableAccount(triedAccountIds);
      }

      removeStream(completionId);
      const accounts = loadAccounts();
      const allOnCooldown = accounts.length === 0 || accounts.every(a => getAccountCooldownInfo(a.id) !== null);

      if (allOnCooldown) {
        console.warn(`[Chat] CRITICAL: All accounts are rate-limited, on cooldown, or none configured! Falling back to GUEST mode.`);
        const result = await createQwenStream(
          promptForStream,
          isThinkingModel,
          body.model,
          null,
          'guest',
          undefined,
          pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
          { ...baseStreamOptions, forceBootstrap: true }
        );
        registerStream(completionId, {
          abortController: result.controller,
          accountId: 'guest',
          uiSessionId: result.uiSessionId,
          targetResponseId: '',
          headers: result.headers,
          stopToken,
        });
        return { stream: result.stream, uiSessionId: result.uiSessionId, accountId: 'guest' };
      }

      throw lastError || new Error('All accounts failed');
    };

    const acquired = await obtainStream(finalPrompt);

    c.header('X-Stop-Token', stopToken);

    if (!isStream) {
      const collectResponse = async (acquiredStream: ReadableStream, acquiredSession: string) =>
        collectNonStreamingResult(c, acquiredStream, completionId, body.model, acquiredSession, parseToolCalls, bodyAny.tools || []);

      let completed = await collectResponse(acquired.stream, acquired.uiSessionId);

      let degenerateRetriesLeft = 1;
      while (
        degenerateRetriesLeft > 0 &&
        completed.status === 200 &&
        completed.degenerate &&
        completed.toolCalls.length === 0
      ) {
        degenerateRetriesLeft--;
        console.warn(`[Chat] Degenerate reply detected (${JSON.stringify((completed.content || '').slice(0, 60))}). Retrying on a clean chat with corrective directive.`);
        // Retry on a fresh chat (forceBootstrap=true) so the degenerate reply and
        // corrective directive never pollute the pinned conversation history.
        const correctedPrompt = `${finalPrompt}\n${buildAnswerDirective()}`;
        const retried = await obtainStream(correctedPrompt, true);
        completed = await collectResponse(retried.stream, retried.uiSessionId);
      }

      if (completed.status === 200 && completed.updateMember) {
        console.warn('[Chat] Account membership limit hit in non-streaming mode. Retrying with another account...');
        recordAccountBlock(acquired.accountId, 'membership-limit', undefined, { cooldownMs: msUntilMidnight() });
        const retried = await obtainStream(finalPrompt, true);
        completed = await collectResponse(retried.stream, retried.uiSessionId);
      }

      trackUsage(user ? user.id : 'anonymous', inputText, completed.status !== 200, completed.body?.usage?.completion_tokens ?? 0, completed.body?.usage?.prompt_tokens);
      trackModelUsage(modelId);
      releaseUserSlotOnce();
      metrics.histogram('latency.completion', Date.now() - completionStart);
      return c.json(completed.body, completed.status as any);
    }

    trackModelUsage(modelId);
    metrics.histogram('latency.completion', Date.now() - completionStart);

    // Degenerate/tool-call retry guards hold up to GUARD_HOLD_BYTES (800) of
    // output before flushing — a real latency cost on every stream. `prone`
    // (default) only enables the guard when a terse reply is actually likely:
    // economical turns, tool loops, and requests with attached files (text
    // documents and oversized prompts routed through OSS are the classic
    // "Yes"-reply triggers). `off` disables it entirely for lowest
    // time-to-first-byte. `always` keeps the historical behavior.
    const guardMode = config.streamDegenerateGuard;
    const hasUploadContext =
      pendingMultimodal.length > 0 ||
      Buffer.byteLength(finalPrompt, 'utf-8') > config.largePromptThreshold;
    const guardEnabled =
      guardMode === 'always' ||
      (guardMode === 'prone' && (canEconomize || hasToolConversation || hasUploadContext));

    return handleStreamingResponse(c, {
      stream: acquired.stream,
      completionId,
      model: body.model,
      uiSessionId: acquired.uiSessionId,
      hasTools: parseToolCalls,
      tools: bodyAny.tools || [],
      finalPrompt,
      streamOptions: body.stream_options,
      onUsage: (promptTokens, completionTokens) => {
        trackUsage(user ? user.id : 'anonymous', inputText, false, completionTokens, promptTokens);
      },
      onComplete: releaseUserSlotOnce,
      onUpdateMemberRetry: async () => {
        console.warn('[Chat] Account membership limit hit. Retrying with another account...');
        recordAccountBlock(acquired.accountId, 'membership-limit', undefined, { cooldownMs: msUntilMidnight() });
        const retried = await obtainStream(finalPrompt, true);
        return { stream: retried.stream, uiSessionId: retried.uiSessionId };
      },
      ...(guardEnabled ? {
        onDegenerateRetry: async () => {
          console.warn('[Chat] Streaming degenerate reply detected. Regenerating on a clean chat...');
          const retried = await obtainStream(`${finalPrompt}\n${buildAnswerDirective()}`, true);
          return { stream: retried.stream, uiSessionId: retried.uiSessionId };
        },
        onToolCallRetry: hasToolConversation ? async () => {
          console.warn('[Chat] Tool call attempted but unparseable. Regenerating with corrective directive...');
          const corrected = `${finalPrompt}\nIMPORTANT: Your previous tool call was malformed and could not be parsed. If a tool is needed, emit ONE valid JSON object wrapped EXACTLY in ${TOOL_CALL_OPEN} and ${TOOL_CALL_CLOSE} tags, nothing else.`;
          const retried = await obtainStream(corrected, true);
          return { stream: retried.stream, uiSessionId: retried.uiSessionId };
        } : undefined,
      } : {}),
    });
  } catch (err: any) {
    releaseUserSlotOnce();
    console.error('Error in chatCompletions:', err)
    const status = err.upstreamStatus || 500
    metrics.histogram('latency.completion', Date.now() - completionStart)
    trackUsage(user ? user.id : 'anonymous', usageInputText, true);
    trackModelUsage(usageModel);
    return c.json({ error: { message: err.message } }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id, stop_token } = body;

    if (!chat_id || !response_id || !stop_token) {
      return c.json({ error: 'chat_id, response_id and stop_token are required' }, 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    const tokenBuf = Buffer.from(String(stop_token));
    const expectedBuf = Buffer.from(stream.stopToken);
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
      return c.json({ error: 'Invalid stop_token' }, 403);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    const stopResponse = await fetch(`https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': stream.headers.cookie,
        'Origin': 'https://chat.qwen.ai',
        'Referer': `https://chat.qwen.ai/c/${chat_id}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': crypto.randomUUID(),
        'bx-ua': stream.headers['bx-ua'],
        'bx-umidtoken': stream.headers['bx-umidtoken'],
        'bx-v': stream.headers['bx-v'],
      },
      body: JSON.stringify({ chat_id, response_id }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(`[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}

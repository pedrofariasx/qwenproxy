/*
 * File: qwen.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-12
 */

import { getQwenHeaders, getBasicHeaders } from './playwright.ts';
import { v4 as uuidv4 } from 'uuid';

function isDebugEnabled(): boolean {
  return process.env.DEBUG_QWEN_PROXY === '1';
}

const HYBRID_SESSION_TTL_MS = 30 * 60 * 1000;
const HYBRID_CHAT_COOLDOWN_MS = 1000;

/**
 * Erro retryable para quando o Qwen retorna "chat in progress".
 * O retryAfterMs sugere quanto tempo aguardar antes de tentar novamente.
 */
export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

interface HybridConversationState {
  key: string;
  modelId: string;
  systemPrompt: string;
  messageEntries: string[];
  chatSessionId: string;
  parentMessageId: string | null;
  updatedAt: number;
}

interface HybridRequestGateState {
  tail: Promise<void>;
  releaseAt: number;
}

export interface HybridConversationPlan {
  key: string;
  prompt: string;
  chatSessionId: string | null;
  parentMessageId: string | null;
  reusedSession: boolean;
}

export interface CreateQwenStreamOptions {
  chatSessionId: string | null;
  parentMessageId: string | null;
  forceFreshChat: boolean;
  pageKey?: string | null;
}

const hybridConversationStates = new Map<string, HybridConversationState>();
const hybridRequestGates = new Map<string, HybridRequestGateState>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetHybridConversationState(): void {
  hybridConversationStates.clear();
  hybridRequestGates.clear();
}

function pruneHybridConversationStates(): void {
  const now = Date.now();

  for (const [key, state] of hybridConversationStates.entries()) {
    if (now - state.updatedAt > HYBRID_SESSION_TTL_MS) {
      hybridConversationStates.delete(key);
    }
  }
}

function isExactPrefix(source: string[], target: string[]): boolean {
  if (source.length > target.length) {
    return false;
  }

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== target[index]) {
      return false;
    }
  }

  return true;
}

export function prepareHybridConversation(
  conversationKey: string | null,
  modelId: string,
  systemPrompt: string,
  messageEntries: string[]
): HybridConversationPlan {
  pruneHybridConversationStates();

  if (!conversationKey) {
    return {
      key: uuidv4(),
      prompt: `${systemPrompt}${messageEntries.join('')}`,
      chatSessionId: null,
      parentMessageId: null,
      reusedSession: false,
    };
  }

  const existingState = hybridConversationStates.get(conversationKey);

  if (!existingState) {
    return {
      key: conversationKey,
      prompt: `${systemPrompt}${messageEntries.join('')}`,
      chatSessionId: null,
      parentMessageId: null,
      reusedSession: false,
    };
  }

  const isCompatibleConversation =
    existingState.modelId === modelId &&
    existingState.systemPrompt === systemPrompt &&
    isExactPrefix(existingState.messageEntries, messageEntries) &&
    existingState.messageEntries.length < messageEntries.length;

  if (!isCompatibleConversation) {
    hybridConversationStates.delete(conversationKey);

    return {
      key: conversationKey,
      prompt: `${systemPrompt}${messageEntries.join('')}`,
      chatSessionId: null,
      parentMessageId: null,
      reusedSession: false,
    };
  }

  const deltaEntries = messageEntries.slice(existingState.messageEntries.length);

  return {
    key: existingState.key,
    prompt: deltaEntries.join(''),
    chatSessionId: existingState.chatSessionId,
    parentMessageId: existingState.parentMessageId,
    reusedSession: true,
  };
}

export function finalizeHybridConversation(
  key: string,
  modelId: string,
  systemPrompt: string,
  messageEntries: string[],
  chatSessionId: string,
  parentMessageId: string | null
): void {
  hybridConversationStates.set(key, {
    key,
    modelId,
    systemPrompt,
    messageEntries,
    chatSessionId,
    parentMessageId,
    updatedAt: Date.now(),
  });
}

export async function acquireHybridRequestWindow(
  key: string,
  reusedSession: boolean
): Promise<() => void> {
  if (!reusedSession) {
    return () => undefined;
  }

  const currentGate = hybridRequestGates.get(key) ?? {
    tail: Promise.resolve(),
    releaseAt: 0,
  };

  let releaseGate!: () => void;
  const nextTail = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  hybridRequestGates.set(key, {
    tail: currentGate.tail.then(() => nextTail),
    releaseAt: currentGate.releaseAt,
  });

  await currentGate.tail;

  const latestGate = hybridRequestGates.get(key);
  const releaseAt = latestGate?.releaseAt ?? 0;
  const waitMs = Math.max(0, releaseAt - Date.now());

  if (waitMs > 0) {
    await delay(waitMs);
  }

  return () => {
    releaseGate();
  };
}

export function markHybridRequestCooldown(key: string, reusedSession: boolean): void {
  if (!reusedSession) {
    return;
  }

  const gate = hybridRequestGates.get(key);
  if (!gate) {
    return;
  }

  gate.releaseAt = Date.now() + HYBRID_CHAT_COOLDOWN_MS;
  hybridRequestGates.set(key, gate);
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

export async function disableNativeTools(preloadedHeaders?: Record<string, string>): Promise<void> {
  const headers = preloadedHeaders ?? (await getQwenHeaders()).headers;
  
  const payload = {
    tools_enabled: {
      web_extractor: false,
      web_search_image: false,
      web_search: false,
      image_gen_tool: false,
      code_interpreter: false,
      history_retriever: false,
      image_edit_tool: false,
      bio: false,
      image_zoom_in_tool: false
    }
  };

  console.log('[Qwen] Disabling native tools...');
  const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': headers['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': 'https://chat.qwen.ai/',
      'user-agent': headers['user-agent'],
      'x-request-id': uuidv4(),
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v']
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Qwen] Failed to disable native tools: ${response.status} - ${text}`);
  } else {
    console.log('[Qwen] Native tools disabled successfully.');
  }
}

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) { // 1 hour cache
    return cachedModels;
  }

  const { cookie, userAgent, bxV } = await getBasicHeaders();
  
  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': uuidv4(),
      'bx-v': bxV,
      'timezone': new Date().toString(),
      'source': 'web'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) => ({
      id: m.id,
      object: 'model',
      created: m.info?.created_at || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'qwen'
    }));

    // Add -no-thinking versions for models that support thinking
    const extendedModels = [...models];
    for (const m of models) {
      extendedModels.push({
        ...m,
        id: `${m.id}-no-thinking`
      });
    }

    cachedModels = extendedModels;
    lastModelsFetch = now;
    return extendedModels;
  }

  return [];
}

export async function createQwenStream(
  prompt: string, 
  enableThinking: boolean, 
  modelId: string,
  options: CreateQwenStreamOptions
): Promise<{ stream: ReadableStream; headers: Record<string, string>; chatSessionId: string }> {
  const shouldCreateFreshChat = options.forceFreshChat || !options.chatSessionId;
  const headerSession = await getQwenHeaders(shouldCreateFreshChat, options.pageKey);
  const headers = headerSession.headers;
  const chatSessionId = shouldCreateFreshChat ? headerSession.chatSessionId : options.chatSessionId;

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const model = modelId.replace('-no-thinking', '');
  const parentMessageId = shouldCreateFreshChat ? null : options.parentMessageId;

  if (!chatSessionId) {
    throw new Error('Failed to obtain a fresh Qwen chat_id for this request');
  }

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatSessionId,
    chat_mode: 'normal',
    model: model,
    parent_id: parentMessageId,
    messages: [
      {
        fid: fid,
        parentId: parentMessageId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: true
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: parentMessageId
      }
    ],
    timestamp: timestamp + 1
  };

  const url = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${encodeURIComponent(chatSessionId)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': headers['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': 'https://chat.qwen.ai/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': new Date().toString().split(' (')[0], // Match closer to browser format
      'user-agent': headers['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': uuidv4(),
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v']
    },
    body: JSON.stringify(payload)
  });

  if (isDebugEnabled()) {
    console.log('[Qwen][Debug] Response status:', response.status, response.statusText);
    console.log('[Qwen][Debug] Response content-type:', response.headers.get('content-type'));
  }

  const responseContentType = response.headers.get('content-type') || '';

  if (responseContentType.includes('application/json')) {
    const responseText = await response.text();

    if (isDebugEnabled()) {
      console.log('[Qwen][Debug] JSON response body:', responseText);
    }

    // Detecta erro temporário "chat in progress" e lança erro retryable
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson?.data?.details?.includes('The chat is in progress!')) {
        // Retry após 2-4 segundos (jitter simples)
        const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
        throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
      }
    } catch (parseOrRetryError) {
      // Se for erro de retry, propaga para o handler de stream
      if (parseOrRetryError instanceof RetryableQwenStreamError) {
        throw parseOrRetryError;
      }
      // Se não conseguir parsear o JSON, segue com erro genérico
    }

    throw new Error(`Qwen returned JSON instead of stream: ${responseText}`);
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers, chatSessionId };
}

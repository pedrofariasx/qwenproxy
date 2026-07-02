import { getModelTokenDivisor } from '../core/model-registry.js'

export function estimateTokenCount(text: string, modelId?: string): number {
  const divisor = getModelTokenDivisor(modelId)
  return Math.ceil(text.length / divisor)
}

function truncateSemantically(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  
  const truncated = content.slice(0, maxChars);
  
  if (truncated.trimStart().startsWith('{') || truncated.trimStart().startsWith('[')) {
    const lastBrace = Math.max(truncated.lastIndexOf('}'), truncated.lastIndexOf(']'));
    if (lastBrace > maxChars * 0.7) {
      return truncated.slice(0, lastBrace + 1) + ' /* truncated */';
    }
  }
  
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.8) {
    return truncated.slice(0, lastNewline) + '\n[Truncated]';
  }
  
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.9) {
    return truncated.slice(0, lastSpace) + '... [Truncated]';
  }
  
  return truncated + '... [Truncated]';
}

const TOOL_MEMORY_MAX_ITEMS = 24;
const TOOL_MEMORY_ITEM_MAX_CHARS = 180;

function summarizeContent(content: string, maxChars = TOOL_MEMORY_ITEM_MAX_CHARS): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}... [truncated]`;
}

function stringifyToolArgs(args: unknown): string {
  try {
    return summarizeContent(JSON.stringify(args), 220);
  } catch {
    return summarizeContent(String(args), 220);
  }
}

function buildToolMemory(messages: Array<{ role: string; content: string | null | any[] | Record<string, unknown>; tool_calls?: any[]; name?: string; tool_call_id?: string }>, cutoffIndex: number): string {
  const lines: string[] = [];

  for (let i = 0; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = call?.function?.name || call?.name || 'unknown_tool';
        let args: unknown = {};
        if (typeof call?.function?.arguments === 'string') {
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = call.function.arguments;
          }
        } else if (call?.function?.arguments !== undefined) {
          args = call.function.arguments;
        }
        lines.push(`- call ${call.id || 'unknown'}: ${name}(${stringifyToolArgs(args)})`);
        if (lines.length >= TOOL_MEMORY_MAX_ITEMS) return lines.join('\n');
      }
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      const contentStr = Array.isArray(msg.content)
        ? msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : typeof msg.content === 'object' && msg.content !== null
          ? JSON.stringify(msg.content)
          : msg.content || '';
      const toolName = msg.name || msg.tool_call_id || 'tool';
      lines.push(`- ${toolName} response: ${summarizeContent(contentStr)}`);
      if (lines.length >= TOOL_MEMORY_MAX_ITEMS) return lines.join('\n');
    }
  }

  return lines.join('\n');
}

export function truncateMessages(
  messages: Array<{ role: string; content: string | null | any[] | Record<string, unknown> }>,
  maxContextLength: number,
  systemPrompt: string = '',
  modelId?: string
): Array<{ role: string; content: string }> {
  const divisor = getModelTokenDivisor(modelId)
  const systemTokens = estimateTokenCount(systemPrompt, modelId);
  const availableTokens = maxContextLength - systemTokens - 500;
  
  if (availableTokens <= 0) {
    return [{ role: 'user', content: systemPrompt }];
  }
  
  const result: Array<{ role: string; content: string }> = [];
  let usedTokens = 0;
  let droppedToolMemory = '';
  
  const normalizedMessages = messages.map(msg => {
    let contentStr: string;
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }
    return { role: msg.role, content: contentStr, tool_calls: (msg as any).tool_calls, name: (msg as any).name, tool_call_id: (msg as any).tool_call_id };
  });
  
  for (let i = normalizedMessages.length - 1; i >= 0; i--) {
    const msg = normalizedMessages[i];
    const msgTokens = estimateTokenCount(msg.content, modelId);
    
    if (usedTokens + msgTokens <= availableTokens) {
      result.push(msg);
      usedTokens += msgTokens;
    } else {
      const remainingTokens = availableTokens - usedTokens;
      if (remainingTokens > 100) {
        const maxChars = Math.floor(remainingTokens * divisor);
        const truncatedContent = truncateSemantically(msg.content, maxChars);
        result.push({ role: msg.role, content: `[Truncated] ${truncatedContent}` });
      }
      droppedToolMemory = buildToolMemory(normalizedMessages, i);
      break;
    }
  }
  
  if (result.length === 0 && normalizedMessages.length > 0) {
    const lastMsg = normalizedMessages[normalizedMessages.length - 1];
    const maxChars = Math.max(200, Math.floor(availableTokens * divisor));
    const truncatedContent = truncateSemantically(lastMsg.content, maxChars);
    result.push({ role: lastMsg.role, content: `[Truncated] ${truncatedContent}` });
  }
  
  const truncated = result.reverse();
  if (!droppedToolMemory) return truncated;
  return [{ role: 'user', content: `[Earlier tool memory]\n${droppedToolMemory}` }, ...truncated];
}

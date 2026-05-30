export interface TruncatedMessage {
  role: string;
  content: string;
}

/**
 * Best-effort token count estimation for Qwen models.
 *
 * Qwen does not publish an official tokenizer, so this uses a rough heuristic:
 * `ceil(bytes * 0.40)` approximating ~2.5 characters per token for mixed
 * Chinese/English text. This is not exact — use only for context window
 * budgeting, not for billing or precise token accounting.
 */
export function estimateTokenCount(text: string): number {
  const bytes = new TextEncoder().encode(text).length;
  return Math.ceil(bytes * 0.40);
}

export function truncateMessages(
  messages: Array<{ role: string; content: string | null | any[] }>,
  maxContextLength: number,
  systemPrompt: string = ''
): Array<{ role: string; content: string }> {
  const systemTokens = estimateTokenCount(systemPrompt);
  const availableTokens = maxContextLength - systemTokens - 500;
  
  if (availableTokens <= 0) {
    return [{ role: 'user', content: systemPrompt }];
  }
  
  const result: Array<{ role: string; content: string }> = [];
  let usedTokens = 0;
  
  const normalizedMessages = messages.map(msg => {
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }
    return { role: msg.role, content: contentStr };
  });
  
  for (let i = normalizedMessages.length - 1; i >= 0; i--) {
    const msg = normalizedMessages[i];
    const msgTokens = estimateTokenCount(msg.content);
    
    if (usedTokens + msgTokens <= availableTokens) {
      result.unshift(msg);
      usedTokens += msgTokens;
    } else {
      const remainingTokens = availableTokens - usedTokens;
      if (remainingTokens > 100) {
        const truncatedContent = msg.content.slice(0, remainingTokens * 2.5);
        result.unshift({ role: msg.role, content: `[Truncated] ${truncatedContent}...` });
      }
      break;
    }
  }
  
  if (result.length === 0 && normalizedMessages.length > 0) {
    const lastMsg = normalizedMessages[normalizedMessages.length - 1];
    const truncatedContent = lastMsg.content.slice(0, Math.max(200, availableTokens * 2.5));
    result.push({ role: lastMsg.role, content: `[Truncated] ${truncatedContent}...` });
  }
  
  return result;
}

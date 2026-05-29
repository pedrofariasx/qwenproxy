/*
 * #==========# Response store
 * Persist OpenAI Responses-style conversation state in memory so
 * previous_response_id can resume the same conversation flow.
 */

import type { Message } from '../utils/types.ts';

type StoredResponse = {
  messages: Message[];
  createdAt: number;
};

const storedResponses = new Map<string, StoredResponse>();

export function storeResponseContext(responseId: string, messages: Message[]): void {
  storedResponses.set(responseId, {
    messages: messages.map((message) => ({
      ...message,
      tool_calls: message.tool_calls?.map((call) => ({
        ...call,
        function: { ...call.function },
      })),
    })),
    createdAt: Date.now(),
  });
}

export function getResponseContext(responseId?: string | null): Message[] {
  if (!responseId) return [];
  const entry = storedResponses.get(responseId);
  if (!entry) return [];
  return entry.messages.map((message) => ({
    ...message,
    tool_calls: message.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function },
    })),
  }));
}

export function pruneResponseContexts(maxEntries = 250): void {
  if (storedResponses.size <= maxEntries) return;

  const entries = [...storedResponses.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt);

  while (entries.length > maxEntries) {
    const [responseId] = entries.shift()!;
    storedResponses.delete(responseId);
  }
}

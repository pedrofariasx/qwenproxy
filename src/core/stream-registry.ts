import { metrics } from './metrics.js'

export interface StreamRegistryEntry {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
  stopToken: string;
  createdAt: number;
  cancel?: (reason?: unknown) => Promise<void>;
}

const activeStreams = new Map<string, StreamRegistryEntry>();
const knownStreamAccounts = new Set<string>();

function updateStreamGauges(): void {
  const byAccount = new Map<string, number>();
  for (const entry of activeStreams.values()) {
    const key = entry.accountId || 'unknown';
    byAccount.set(key, (byAccount.get(key) || 0) + 1);
    knownStreamAccounts.add(key);
  }
  metrics.gauge('streams.active', activeStreams.size);
  for (const acct of knownStreamAccounts) {
    metrics.gauge('streams.by.account', byAccount.get(acct) || 0, { account: acct });
  }
}

export function registerStream(
  key: string,
  entry: Omit<StreamRegistryEntry, 'createdAt'> & { createdAt?: number },
): void {
  activeStreams.set(key, { ...entry, createdAt: entry.createdAt ?? Date.now() })
  updateStreamGauges()
}

export function getStreamRegistry(): Map<string, StreamRegistryEntry> {
  return activeStreams
}

export function getStream(key: string): StreamRegistryEntry | undefined {
  return activeStreams.get(key)
}

export function updateStreamResponseId(key: string, chatId: string, responseId: string): void {
  const entry = activeStreams.get(key);
  if (entry && entry.uiSessionId === chatId && !entry.targetResponseId) entry.targetResponseId = responseId;
}

export function removeStream(key: string, expected?: StreamRegistryEntry): void {
  if (expected && activeStreams.get(key) !== expected) return;
  activeStreams.delete(key)
  updateStreamGauges()
}

export function abortStream(key: string): boolean {
  const entry = activeStreams.get(key)
  if (entry) {
    if (entry.cancel) {
      void entry.cancel(new Error('Stream stopped by administrator')).then(() => removeStream(key, entry)).catch(() => {});
    } else {
      entry.abortController.abort();
      removeStream(key, entry);
    }
    return true
  }
  return false
}

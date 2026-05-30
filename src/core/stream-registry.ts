interface StreamEntry {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
  lastAccessed: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

const activeStreams = new Map<string, StreamEntry>();

const mutex = {
  _queue: Promise.resolve() as Promise<void>,

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    let release: () => void;
    const prev = this._queue;
    this._queue = new Promise<void>(resolve => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
};

export function registerStream(key: string, entry: {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
}): void {
  activeStreams.set(key, {
    ...entry,
    lastAccessed: Date.now(),
  });
}

export async function getStream(key: string): Promise<StreamEntry | undefined> {
  return mutex.run(() => {
    const entry = activeStreams.get(key);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
    return entry;
  });
}

export async function removeStream(key: string): Promise<void> {
  return mutex.run(() => {
    activeStreams.delete(key);
  });
}

export async function abortStream(key: string): Promise<boolean> {
  return mutex.run(() => {
    const entry = activeStreams.get(key);
    if (entry) {
      entry.abortController.abort();
      activeStreams.delete(key);
      return true;
    }
    return false;
  });
}

function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of activeStreams) {
    if (now - entry.lastAccessed > TTL_MS) {
      entry.abortController.abort();
      activeStreams.delete(key);
    }
  }
}

setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS).unref();

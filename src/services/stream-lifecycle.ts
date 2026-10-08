export function manageQwenStream(
  source: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  label: string,
  abortTransport: (() => void | Promise<void>) | undefined,
  onDone: () => void,
  onActivity: () => void,
  parentSignal?: AbortSignal,
): { stream: ReadableStream<Uint8Array>; cancel: (reason?: unknown) => Promise<void> } {
  const reader = source.getReader();
  const sourceClosed = reader.closed.then(() => ({ errored: false as const }), error => ({ errored: true as const, error }));
  let output: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishing = false;
  let consumerCancelled = false;
  let finished: Promise<void> | undefined;

  const finish = (reason?: unknown, normal = false): Promise<void> => {
    if (finished) return finished;
    finishing = true;
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    parentSignal?.removeEventListener('abort', onParentAbort);
    finished = Promise.resolve().then(async () => {
      if (!normal && !controller.signal.aborted) controller.abort(reason);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => abortTransport?.()),
        normal ? Promise.resolve() : reader.cancel(reason).catch(async error => {
          const state = await sourceClosed;
          if (!state.errored || state.error !== error) throw error;
        }),
      ]);
      reader.releaseLock();
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      onDone();
      if (!consumerCancelled) {
        if (normal) output.close();
        else output.error(reason instanceof Error ? reason : new Error(String(reason ?? 'Qwen stream cancelled')));
      }
    }).catch(error => {
      if (!consumerCancelled) output.error(error);
      throw error;
    });
    return finished;
  };

  const onAbort = () => { void finish(controller.signal.reason).catch(() => {}); };
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  const resetTimer = () => {
    onActivity();
    clearTimeout(timer);
    timer = setTimeout(() => {
      void finish(new Error(`${label} idle timeout after ${idleTimeoutMs}ms without upstream data`)).catch(() => {});
    }, idleTimeoutMs);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      output = streamController;
      controller.signal.addEventListener('abort', onAbort, { once: true });
      parentSignal?.addEventListener('abort', onParentAbort, { once: true });
      if (parentSignal?.aborted) onParentAbort();
      if (controller.signal.aborted) onAbort();
      else resetTimer();
    },
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (finishing) return;
        if (done) await finish(undefined, true);
        else {
          resetTimer();
          streamController.enqueue(value);
        }
      } catch (error) {
        if (!finishing) await finish(error).catch(() => {});
      }
    },
    cancel(reason) {
      consumerCancelled = true;
      return finish(reason);
    },
  });
  return { stream, cancel: reason => finish(reason) };
}

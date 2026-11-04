type SearchBatch<T> = { value: T; nextCursor: string | null; scanned: number; found: boolean };

function yieldBatch(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 0);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Keep only one response page. An empty bounded scan is not a finished search.
 * Pause checkpoints at the next acknowledged page; abort never publishes stale
 * results, including when a transport ignores AbortSignal during completion.
 */
export async function progressiveSearch<T>(options: {
  cursor?: string; signal: AbortSignal; continuous: boolean; paused(): boolean;
  fetch(cursor?: string): Promise<SearchBatch<T>>;
  progress(batch: SearchBatch<T>, scanned: number): void;
}) {
  let cursor = options.cursor; let scanned = 0;
  for (;;) {
    options.signal.throwIfAborted();
    const batch = await options.fetch(cursor);
    options.signal.throwIfAborted();
    scanned += batch.scanned;
    options.progress(batch, scanned);
    if (!options.continuous || batch.found || !batch.nextCursor || options.paused()) return batch;
    cursor = batch.nextCursor;
    await yieldBatch(options.signal);
    if (options.paused()) return batch;
  }
}

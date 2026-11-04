/** Local, disposable Chromium driver for reproducible performance experiments.
 * The caller owns the browser/profile; no existing user tab or credential is read.
 */
export async function connectPerformanceBrowser(port: number, url: string) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(url)) throw new Error('invalid_fixture_browser');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const page = await response.json() as { id?: string; webSocketDebuggerUrl?: string };
  if (!page.id || !/^[A-Za-z0-9_-]{1,128}$/.test(page.id) || !page.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/devtools/page/`)) throw new Error('invalid_fixture_target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', () => reject(new Error('fixture_browser_unavailable')), { once: true }); });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const listeners = new Map<string, Set<(value: any) => void>>();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const operation = pending.get(message.id);
    if (operation) {
      clearTimeout(operation.timer); pending.delete(message.id);
      if (message.error) operation.reject(new Error('fixture_browser_command_failed')); else operation.resolve(message.result);
    } else for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  });
  const command = <T = any>(method: string, params: object = {}): Promise<T> => new Promise((resolve, reject) => {
    if (pending.size >= 32 || ws.readyState !== WebSocket.OPEN) return reject(new Error('fixture_browser_busy'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture_browser_timeout')); }, 15_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('fixture_browser_evaluation_failed');
    return result.result.value as T;
  };
  return { command, evaluate,
    on(method: string, listener: (params: any) => void) { const set = listeners.get(method) ?? new Set(); set.add(listener); listeners.set(method, set); return () => set.delete(listener); },
    async close() {
      try {
        // Closing the target may destroy its socket before Page.close replies.
        // The browser HTTP endpoint acknowledges closure of this owned target.
        const result = await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`, { signal: AbortSignal.timeout(5000) });
        if (!result.ok && result.status !== 404) throw new Error('fixture_browser_close_failed');
      } finally {
        for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('fixture_browser_closed')); }
        pending.clear(); listeners.clear(); ws.close();
      }
    },
  };
}

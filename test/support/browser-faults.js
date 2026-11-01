/** Install with page.evaluate(installBrowserFaults) in your own test page only. */
export function installBrowserFaults() {
  if (window.zhVerify) throw new Error('verification_faults_already_installed');
  const original = window.fetch;
  const originalStorage = Storage.prototype.setItem;
  let armed;
  let held;
  const journal = [];
  function note(value) { journal.push(value); if (journal.length > 200) journal.shift(); }
  window.fetch = async function (url, options) {
    const path = new URL(typeof url === 'string' ? url : url instanceof Request ? url.url : url.href, location.href).pathname;
    const method = options?.method ?? (url instanceof Request ? url.method : 'GET');
    const match = armed && path === armed.path && method === armed.method ? armed : undefined;
    if (match) armed = undefined;
    // Deliberately allow a captured stale response to arrive after the app aborts
    // its read. This exercises the UI's generation/epoch checks independently.
    const response = await original.call(this, url, match?.kind === 'hold' ? { ...options, signal: undefined } : options);
    if (!match) return response;
    const event = { path, method, kind: match.kind, status: response.status };
    if (method === 'POST' && /\/(conversations|operations)$/.test(path)) {
      try { event.id = JSON.parse(options.body).id; } catch { /* never record body or credentials */ }
    }
    note(event);
    if (match.kind === 'drop') { await response.body?.cancel(); throw new TypeError('verification_response_lost'); }
    await new Promise(resolve => { held = { release: resolve, path }; });
    held = undefined;
    return response;
  };
  const arm = (kind, path, method) => {
    if (armed || held || !path.startsWith('/api/') || path.includes('?') || !['GET', 'POST'].includes(method)) throw new Error('invalid_or_busy_fault');
    armed = { kind, path, method };
  };
  window.zhVerify = {
    dropNext: (path, method = 'POST') => arm('drop', path, method),
    holdNext: (path, method = 'GET') => arm('hold', path, method),
    status: () => ({ armed: !!armed, held: held?.path ?? null, journal: [...journal] }),
    release: () => { if (!held) throw new Error('no_held_response'); held.release(); },
    denyDraftStorage: () => { Storage.prototype.setItem = function (key, value) { if (key.startsWith('zhongshu:draft:v1:')) throw new DOMException('verification quota', 'QuotaExceededError'); return originalStorage.call(this, key, value); }; },
    restore: () => { armed = undefined; held?.release(); window.fetch = original; Storage.prototype.setItem = originalStorage; delete window.zhVerify; },
  };
}

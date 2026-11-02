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
    const target = new URL(typeof url === 'string' ? url : url instanceof Request ? url.url : url.href, location.href);
    const path = target.pathname;
    const method = options?.method ?? (url instanceof Request ? url.method : 'GET');
    const match = armed && target.origin === location.origin && path === armed.path && method === armed.method ? armed : undefined;
    if (match) armed = undefined;
    let outgoing = options;
    if (match?.kind === 'invalid-request' || match?.kind === 'oversized-request') {
      // Exercise the real server's strict schema/body limit. Never manufacture
      // a response or put a fault endpoint in the application being tested.
      if (typeof options?.body !== 'string') throw new Error('verification_json_body_required');
      const body = JSON.parse(options.body);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('verification_json_body_required');
      outgoing = { ...options, body: JSON.stringify({ ...body, fixtureFault: match.kind === 'invalid-request' ? true : 'x'.repeat(70 * 1024) }) };
    }
    // Deliberately allow a captured stale response to arrive after the app aborts
    // its read. This exercises the UI's generation/epoch checks independently.
    const response = await original.call(this, url, match?.kind === 'hold' ? { ...outgoing, signal: undefined } : outgoing);
    if (!match) return response;
    const event = { path, method, kind: match.kind, status: response.status };
    if (method === 'POST' && /\/(conversations|operations)$/.test(path)) {
      try { event.id = JSON.parse(options.body).id; } catch { /* never record body or credentials */ }
    }
    note(event);
    if (match.kind === 'drop') { await response.body?.cancel(); throw new TypeError('verification_response_lost'); }
    if (match.kind === 'hold') {
      await new Promise(resolve => { held = { release: resolve, path }; });
      held = undefined;
    }
    return response;
  };
  const arm = (kind, path, method) => {
    if (armed || held || !path.startsWith('/api/') || path.includes('?') || !['GET', 'POST'].includes(method)) throw new Error('invalid_or_busy_fault');
    armed = { kind, path, method };
  };
  window.zhVerify = {
    dropNext: (path, method = 'POST') => arm('drop', path, method),
    holdNext: (path, method = 'GET') => arm('hold', path, method),
    rejectNextRequest: (path, status) => {
      if (![400, 413].includes(status) || !/^\/api\/private\/workbench\/conversations\/[0-9a-f-]{36}\/operations$/i.test(path)) throw new Error('invalid_rejection_fault');
      arm(status === 400 ? 'invalid-request' : 'oversized-request', path, 'POST');
    },
    status: () => ({ armed: !!armed, held: held?.path ?? null, journal: [...journal] }),
    release: () => { if (!held) throw new Error('no_held_response'); held.release(); },
    denyDraftStorage: () => { Storage.prototype.setItem = function (key, value) { if (key.startsWith('zhongshu:draft:v1:')) throw new DOMException('verification quota', 'QuotaExceededError'); return originalStorage.call(this, key, value); }; },
    restore: () => { armed = undefined; held?.release(); window.fetch = original; Storage.prototype.setItem = originalStorage; delete window.zhVerify; },
  };
}

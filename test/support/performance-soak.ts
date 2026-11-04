/** Sustained real HTTP + Chromium workload for a private performance fixture.
 * The app/worker resource limit is imposed by its container, outside this client.
 * Execution is explicitly synthetic; physical history import is served by the
 * fixture's real native readers. No instance configuration or credentials load.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { connectPerformanceBrowser } from './cdp-browser.ts';
import { performanceProfile } from './performance-profile.ts';

const args = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, port: { type: 'string' }, browser: { type: 'string' }, seconds: { type: 'string' } }, strict: true });
const input = z.object({ root: z.string().refine(isAbsolute), output: z.string().refine(isAbsolute), port: z.coerce.number().int().min(1024).max(65535),
  browser: z.coerce.number().int().min(1024).max(65535), seconds: z.coerce.number().int().min(30).max(86400).default(86400) }).parse(args.values);
const corpus = z.object({ conversationId: z.uuid(), giant: z.object({ id: z.string(), bytes: z.number(), sha256: z.string() }) }).parse(JSON.parse(await readFile(join(input.root, 'corpus.json'), 'utf8')));
const origin = `http://127.0.0.1:${input.port}`, password = await readFile(join(input.root, 'private/password'), 'utf8');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let cookie = '', csrf = '', stopped = false;
process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
const browser = await connectPerformanceBrowser(input.browser, origin + '/#' + corpus.conversationId);
let exceptions = 0; browser.on('Runtime.exceptionThrown', () => { exceptions++; });
async function waitBrowser(expression: string) {
  for (let n = 0; n < 400; n++) { if (await browser.evaluate(expression)) return; await pause(50); }
  throw new Error('soak_browser_condition_timeout');
}
async function login() {
  const result = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000) });
  if (!result.ok) throw new Error('soak_login_failed');
  csrf = (await result.json() as { csrfToken: string }).csrfToken; cookie = result.headers.getSetCookie()[0]!.split(';')[0]!;
  await browser.evaluate(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})});if(!r.ok)throw Error('login_failed');return true})()`);
}
type Metric = { path: string; ms: number; bytes: number; status: number; operationId?: string; expectedConflict?: string };
async function request(path: string, body?: unknown, metrics?: Metric[]) {
  const start = performance.now();
  const result = await fetch(origin + '/api/private/workbench' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const bytes = new Uint8Array(await result.arrayBuffer());
  const operationId = body && typeof body === 'object' && 'id' in body ? z.uuid().safeParse(body.id).data : undefined;
  metrics?.push({ path: path.split('?')[0]!, ms: performance.now() - start, bytes: bytes.length, status: result.status, ...(operationId ? { operationId } : {}) });
  if (!result.ok) {
    let code: string | undefined;
    try { code = z.object({ error: z.string().regex(/^[a-z_]{1,100}$/) }).parse(JSON.parse(Buffer.from(bytes).toString())).error; } catch { /* No raw response or credentials enter error evidence. */ }
    throw Object.assign(new Error('soak_http_' + result.status), { endpoint: path.split('?')[0], code });
  }
  if (bytes.length > 256 * 1024) throw new Error('soak_response_budget_exceeded');
  return JSON.parse(Buffer.from(bytes).toString());
}
async function waitState(id: string, status: string) {
  for (let n = 0; n < 100; n++) {
    const value = await request('/conversations/' + id);
    if (value.conversation.readiness === 'ready' && value.conversation.state.status === status) return value;
    await pause(50);
  }
  throw new Error('soak_execution_condition_timeout');
}
async function create(harness: 'codex' | 'dsh') {
  const id = randomUUID();
  await request('/conversations', { id, harnessId: harness, workspaceId: 'b', title: 'Soak synthetic ' + harness + ' ' + id,
    configuration: { modelId: 'fixture-model', permissionId: 'fixture-write' } });
  await waitState(id, 'idle'); return id;
}
const summaries: { firstVisibleMs: number; inputPaintMs: number; heapBytes: number; dom: number; failures: number }[] = [];
// Duration uses a monotonic clock. Wall-clock adjustments must not turn a
// shorter experiment into a completed 24-hour run.
const started = performance.now(); let cycles = 0, failures = 0;
let previousCycleAt: number | undefined;
let active: string[] = [], directoryCursor: string | null = null, historyCursor: string | undefined;
const streamControllers: AbortController[] = []; const streams: Promise<void>[] = [];
async function directoryPage(metrics: Metric[]) {
  try {
    return await request('/workspaces/a/files?' + new URLSearchParams(cycles % 10 === 0 ? { refresh: '1', limit: '50' } : { limit: '50', ...(directoryCursor ? { cursor: directoryCursor } : {}) }), undefined, metrics);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'directory_cursor_expired')) throw error;
    const expired = metrics.findLast(value => value.path === '/workspaces/a/files' && value.status === 409);
    if (expired) expired.expectedConflict = 'directory_cursor_expired';
    // A generation held across 30-second samples can exceed the documented
    // retention window after refresh. Follow the UI's explicit fresh-page path.
    directoryCursor = null;
    return request('/workspaces/a/files?limit=50', undefined, metrics);
  }
}
async function startStreams() {
  for (const controller of streamControllers) controller.abort(); await Promise.allSettled(streams); streamControllers.length = 0; streams.length = 0;
  for (let n = 0; n < 2; n++) {
    const controller = new AbortController(); streamControllers.push(controller);
    streams.push((async () => {
      try {
        const response = await fetch(origin + '/api/private/workbench/events', { headers: { cookie }, signal: controller.signal });
        if (!response.ok) throw new Error('soak_stream_rejected');
        const reader = response.body!.getReader();
        while (!controller.signal.aborted) { const value = await reader.read(); if (value.done) break; if (n === 1) await pause(1000); }
      } catch (error) { if (!controller.signal.aborted) throw error; }
    })());
    // Capture failures immediately; the aggregate is awaited during cleanup.
    void streams.at(-1)!.catch(() => { failures++; });
  }
}
try {
  await writeFile(input.output, '', { flag: 'wx', mode: 0o600 });
  await browser.command('Runtime.enable'); await browser.command('Page.enable'); await browser.command('Network.enable'); await browser.command('Performance.enable');
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await browser.command('Emulation.setCPUThrottlingRate', { rate: 4 });
  await waitBrowser(`location.origin===${JSON.stringify(origin)}&&document.readyState!=='loading'`);
  await login(); await startStreams();
  await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const o=new MutationObserver(()=>{if(document.querySelector('.message-text')?.textContent?.trim()){o.disconnect();requestAnimationFrame(()=>performance.mark('soak-visible'))}});o.observe(document,{childList:true,subtree:true,characterData:true})})()` });
  await browser.command('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 10_000_000 / 8, uploadThroughput: 10_000_000 / 8 });
  while (!stopped && performance.now() - started < input.seconds * 1000) {
    const begin = performance.now(), metrics: Metric[] = [];
    const sampleGapSeconds = previousCycleAt === undefined ? null : (begin - previousCycleAt) / 1000;
    previousCycleAt = begin;
    try {
      if (cycles && cycles % 120 === 0) { await login(); await startStreams(); }
      if (cycles % 40 === 0) active = [await create('codex'), await create('dsh')];
      const runs: { id: string; runId: string }[] = [];
      for (const id of active) {
        const operation = randomUUID();
        await request('/conversations/' + id + '/operations', { id: operation, type: 'message', payload: { text: 'SYNTHETIC SOAK ' + cycles } }, metrics);
        const current = await waitState(id, 'running'); runs.push({ id, runId: current.conversation.state.runId });
      }
      const work: Promise<any[]> = Promise.all([
        request('/conversations/' + corpus.conversationId, undefined, metrics),
        request('/conversation-search', { title: cycles % 2 ? 'Performance' : 'no-such-synthetic-title' }, metrics),
        request('/workspaces?query=performance', undefined, metrics),
        directoryPage(metrics),
        request('/capacity', undefined, metrics),
      ]);
      void work.catch(() => {});
      const previous = await browser.evaluate<number>('performance.timeOrigin');
      await browser.command('Page.reload', { ignoreCache: cycles % 120 === 0 });
      await waitBrowser(`performance.timeOrigin!==${previous}&&performance.getEntriesByName('soak-visible').length>0`);
      const firstVisibleMs = await browser.evaluate<number>("performance.getEntriesByName('soak-visible')[0].startTime");
      // A gated or read-only input must not count as a fast successful edit.
      // Readiness waiting is separate from the measured keystroke and paint.
      await waitBrowser("(()=>{const e=document.querySelector('.writing-surface textarea');return !!e&&!e.disabled&&!e.readOnly})()");
      const before = await browser.evaluate<{ at: number; value: string }>("(()=>{const e=document.querySelector('.writing-surface textarea');e.focus();e.setSelectionRange(e.value.length,e.value.length);return {at:performance.now(),value:e.value}})()");
      await browser.command('Input.insertText', { text: '测' });
      const after = await browser.evaluate<{ at: number; value: string }>("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({at:performance.now(),value:document.querySelector('.writing-surface textarea')?.value}))))");
      if (after.value !== before.value + '测') throw new Error('soak_input_not_applied');
      const browserMetrics = await browser.command('Performance.getMetrics');
      const heapBytes = browserMetrics.metrics.find((value: any) => value.name === 'JSHeapUsedSize')?.value ?? 0;
      const dom = await browser.evaluate<number>("document.querySelectorAll('*').length");
      const results = await work; directoryCursor = results[3].nextCursor;
      historyCursor = historyCursor ?? results[0].history.olderBeforeItemId;
      if (historyCursor) { const page = await request('/conversations/' + corpus.conversationId + '/older?' + new URLSearchParams({ beforeItemId: historyCursor }), undefined, metrics); historyCursor = page.history.olderBeforeItemId ?? undefined; }
      const query = new URLSearchParams({ item: corpus.giant.id, field: 'text', version: corpus.giant.sha256, bytes: String(corpus.giant.bytes), offset: String((cycles % Math.ceil(corpus.giant.bytes / 65536)) * 65536) });
      const bodyStart = performance.now(); const body = await fetch(origin + '/api/private/workbench/conversations/' + corpus.conversationId + '/body?' + query, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
      const chunk = new Uint8Array(await body.arrayBuffer()); if (!body.ok || chunk.length > 65536) throw new Error('soak_body_chunk_failed');
      metrics.push({ path: 'body', ms: performance.now() - bodyStart, bytes: chunk.length, status: body.status });
      for (const run of runs) {
        await request('/conversations/' + run.id + '/operations', { id: randomUUID(), type: 'stop', payload: { runId: run.runId } }, metrics);
        await waitState(run.id, 'interrupted');
      }
      if (dom > performanceProfile.data.chatDomNodes || heapBytes > performanceProfile.browser.steadyHeapBytes || exceptions) failures++;
      const sample = { firstVisibleMs, inputPaintMs: after.at - before.at, inputVerified: true, heapBytes, dom, failures };
      summaries.push(sample); await appendFile(input.output, JSON.stringify({ cycle: cycles, time: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000, sampleGapSeconds, ...sample, metrics }) + '\n');
    } catch (error) {
      failures++;
      await appendFile(input.output, JSON.stringify({ cycle: cycles, time: new Date().toISOString(), failure: error instanceof Error && /^soak_[a-z_0-9]+$/.test(error.message) ? error.message : 'soak_cycle_failed',
        endpoint: error && typeof error === 'object' && 'endpoint' in error ? error.endpoint : undefined,
        code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z_]{1,100}$/.test(error.code) ? error.code : undefined, metrics }) + '\n');
      // An uncertain send must not be retried with a fresh operation ID.
      stopped = true;
    }
    cycles++; const remaining = 30_000 - (performance.now() - begin);
    if (!stopped && remaining > 0) await pause(Math.min(remaining, Math.max(0, input.seconds * 1000 - (performance.now() - started))));
  }
  const p95 = (key: 'firstVisibleMs' | 'inputPaintMs') => summaries.map(value => value[key]).sort((a, b) => a - b)[Math.max(0, Math.ceil(summaries.length * .95) - 1)] ?? null;
  const result = { mode: 'synthetic-execution-real-app-browser-physical-import', clock: 'monotonic', plannedSeconds: input.seconds, elapsedSeconds: (performance.now() - started) / 1000,
    complete: !stopped && performance.now() - started >= input.seconds * 1000, cycles, failures, exceptions, p95: { firstVisibleMs: p95('firstVisibleMs'), inputPaintMs: p95('inputPaintMs') },
    peakHeapBytes: Math.max(0, ...summaries.map(value => value.heapBytes)), peakDom: Math.max(0, ...summaries.map(value => value.dom)) };
  await writeFile(input.output + '.summary.json', JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result));
  if (!result.complete || failures || (p95('firstVisibleMs') ?? Infinity) > performanceProfile.latency.archiveVisibleP95Ms || (p95('inputPaintMs') ?? Infinity) > performanceProfile.latency.inputPaintP95Ms) process.exitCode = 1;
} finally {
  for (const controller of streamControllers) controller.abort(); await Promise.allSettled(streams); await browser.close();
}

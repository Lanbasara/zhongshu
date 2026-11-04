/** Browser journey over an isolated corpus: actual clipboard, streamed download,
 * bounded older-page navigation and a narrow viewport. No native execution. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { connectPerformanceBrowser } from './cdp-browser.ts';
const args = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, port: { type: 'string' }, browser: { type: 'string' } }, strict: true });
const options = z.object({ root: z.string().refine(isAbsolute), output: z.string().refine(isAbsolute), port: z.coerce.number().int().min(1024).max(65535), browser: z.coerce.number().int().min(1024).max(65535) }).parse(args.values);
const corpus = JSON.parse(readFileSync(join(options.root, 'corpus.json'), 'utf8'));
const origin = `http://127.0.0.1:${options.port}`;
const downloads = join(options.root, 'private/downloads'); mkdirSync(downloads, { recursive: true, mode: 0o700 });
const browser = await connectPerformanceBrowser(options.browser, origin + '/#' + corpus.conversationId);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(expression: string, ms = 15000) {
  const end = Date.now() + ms;
  do { if (await browser.evaluate(expression)) return; await pause(50); } while (Date.now() < end);
  throw new Error('journey_condition_timeout');
}
async function click(expression: string) {
  const box = await browser.evaluate<{ x: number; y: number }>(`(()=>{const e=(${expression});if(!e||e.disabled)throw Error('missing_action');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await browser.command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
}
let downloadGuid: string | undefined; let downloadComplete = false; let exceptions = 0;
browser.on('Runtime.exceptionThrown', () => { exceptions++; });
browser.on('Browser.downloadWillBegin', event => { downloadGuid = event.guid; });
browser.on('Browser.downloadProgress', event => { if (event.guid === downloadGuid && event.state === 'completed') downloadComplete = true; });
try {
  await browser.command('Runtime.enable'); await browser.command('Page.enable'); await browser.command('Network.enable'); await browser.command('Performance.enable');
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await waitFor(`location.origin===${JSON.stringify(origin)}&&document.readyState!=='loading'`);
  const password = readFileSync(join(options.root, 'private/password'), 'utf8');
  await browser.evaluate(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})});if(!r.ok)throw Error('login_failed');return true})()`);
  await browser.command('Page.reload'); await waitFor("document.querySelector('.body-preview-link')&&!document.querySelector('.body-preview-link').disabled");
  await browser.command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await browser.command('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
  await browser.command('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 10_000_000 / 8, uploadThroughput: 10_000_000 / 8 });
  await click("document.querySelector('.body-preview-link')"); await waitFor("document.querySelector('.body-reader pre')?.textContent.length>0");
  await click("[...document.querySelectorAll('.body-reader button')].find(e=>e.textContent==='复制全文')");
  await waitFor("[...document.querySelectorAll('.body-reader button')].some(e=>e.textContent==='已复制全文')", 60000);
  const copied = await browser.evaluate<{ bytes: number; sha256: string }>(`(async()=>{const text=await navigator.clipboard.readText();const bytes=new TextEncoder().encode(text);const hash=await crypto.subtle.digest('SHA-256',bytes);return{bytes:bytes.length,sha256:[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('')}})()`);
  if (copied.bytes !== corpus.giant.bytes || copied.sha256 !== corpus.giant.sha256) throw new Error('clipboard_content_mismatch');
  await click("document.querySelector('.body-reader a[download]')");
  for (let n = 0; n < 600 && !downloadComplete; n++) await pause(100);
  if (!downloadComplete || !downloadGuid) throw new Error('download_did_not_complete');
  const downloaded = readFileSync(join(downloads, downloadGuid));
  if (downloaded.byteLength !== corpus.giant.bytes || createHash('sha256').update(downloaded).digest('hex') !== corpus.giant.sha256) throw new Error('download_content_mismatch');
  await click("document.querySelector('[aria-label=\"关闭完整正文\"]')");
  await waitFor("!document.querySelector('.body-reader')");
  const focusReturned = await browser.evaluate("document.activeElement?.classList.contains('body-preview-link')");
  const pages: { first: string; last: string; rows: number; dom: number; heapBytes: number }[] = [];
  for (let n = 0; n < 20; n++) {
    const before = await browser.evaluate<string>("document.querySelector('.transcript-row')?.getAttribute('data-message-id')");
    await click("document.querySelector('.load-history')");
    await waitFor(`document.querySelector('.transcript-row')?.getAttribute('data-message-id')!==${JSON.stringify(before)}&&!document.querySelector('.load-history')?.disabled`);
    await browser.evaluate("document.querySelector('.message-scroll').scrollTop=0"); await pause(100);
    const page = await browser.evaluate("(()=>{const rows=[...document.querySelectorAll('.transcript-row')];const ids=rows.map(row=>Number(row.getAttribute('data-message-id').split(':').at(-1)));return{first:rows[0].getAttribute('data-message-id'),last:rows.at(-1).getAttribute('data-message-id'),rows:rows.length,contiguous:ids.every((id,n)=>n===0||id===ids[n-1]+1),dom:document.querySelectorAll('*').length}})()");
    const metrics = await browser.command('Performance.getMetrics'); page.heapBytes = metrics.metrics.find((metric: any) => metric.name === 'JSHeapUsedSize')?.value;
    pages.push(page);
    writeFileSync(options.output + '.partial', JSON.stringify({ complete: false, clipboard: copied, downloadExact: true, focusReturned, pages }, null, 2), { mode: 0o600 });
    // Fifty is the wire-page budget; the existing browser window may retain
    // up to 500 previews, with only nearby rows mounted and an 8 MiB text cap.
    if (page.rows > 500 || page.dom > 5000 || page.heapBytes > 256 * 1024 ** 2) throw new Error('reading_window_exceeded');
    const first = Number(page.first.split(':').at(-1)), last = Number(page.last.split(':').at(-1)), priorFirst = Number(before.split(':').at(-1));
    if (!page.contiguous || first >= priorFirst || last < priorFirst - 1) throw new Error('history_page_gap_or_duplicate');
  }
  await click("[...document.querySelectorAll('button')].find(e=>e.textContent==='回到最新内容')");
  await waitFor(`document.querySelector('.transcript-row:last-child')?.getAttribute('data-message-id')===${JSON.stringify(corpus.giant.id)}`);
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.command('Emulation.setCPUThrottlingRate', { rate: 4 });
  await pause(200);
  const mobile = await browser.evaluate("({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,dom:document.querySelectorAll('*').length})");
  if (mobile.overflow) throw new Error('narrow_viewport_overflow');
  await click("document.querySelector('.body-preview-link')"); await waitFor("document.querySelector('.body-reader pre')?.textContent.length>0");
  const screenshot = await browser.command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(options.output.replace(/\.json$/, '.png'), Buffer.from(screenshot.data, 'base64'));
  const result = { mode: 'real-chromium-reading-journey-synthetic-corpus', totalItems: corpus.totalItems ?? corpus.items, clipboard: copied,
    download: { bytes: downloaded.byteLength, exact: true }, focusReturned, pages, mobile, exceptions, physicalPhone: false };
  if (!focusReturned || exceptions) throw new Error('reader_interaction_regression');
  writeFileSync(options.output, JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result));
} finally { await browser.close(); }

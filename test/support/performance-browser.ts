/** Real Chromium measurements against the disposable offline corpus. Native
 * execution and resource-constrained deployment are separate experiments.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { StringDecoder } from 'node:string_decoder';
import { connectPerformanceBrowser } from './cdp-browser.ts';
import { corpusItem } from './performance-corpus.ts';

const args = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, port: { type: 'string' }, browser: { type: 'string' } }, strict: true });
const options = z.object({ root: z.string().refine(isAbsolute), output: z.string().refine(isAbsolute), port: z.coerce.number().int().min(1024).max(65535), browser: z.coerce.number().int().min(1024).max(65535) }).parse(args.values);
const corpus = JSON.parse(readFileSync(join(options.root, 'corpus.json'), 'utf8'));
const browser = await connectPerformanceBrowser(options.browser, `http://127.0.0.1:${options.port}/#${encodeURIComponent(corpus.conversationId)}`);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(expression: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await browser.evaluate(expression)) return; await pause(50); }
  throw new Error('browser_condition_timeout');
}
const samples: object[] = []; let exceptionCount = 0;
browser.on('Runtime.exceptionThrown', () => { exceptionCount++; });
try {
  await browser.command('Runtime.enable'); await browser.command('Page.enable'); await browser.command('Network.enable'); await browser.command('Performance.enable');
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await waitFor(`location.origin === ${JSON.stringify(`http://127.0.0.1:${options.port}`)} && document.readyState !== 'loading'`);
  const password = readFileSync(join(options.root, 'private/password'), 'utf8');
  await browser.evaluate(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})});if(!r.ok)throw Error('fixture_login_failed');return true})()`);
  await browser.command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const observer=new MutationObserver(()=>{if(document.querySelector('.message-text')?.textContent?.trim()){observer.disconnect();requestAnimationFrame(()=>performance.mark('fixture-first-message'))}});observer.observe(document,{childList:true,subtree:true,characterData:true}); })();` });
  await browser.command('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 10_000_000 / 8, uploadThroughput: 10_000_000 / 8 });
  for (const cpu of [1, 4]) {
    await browser.command('Emulation.setCPUThrottlingRate', { rate: cpu });
    for (let trial = 0; trial < 10; trial++) {
      const previous = await browser.evaluate<number>('performance.timeOrigin');
      await browser.command('Page.reload', { ignoreCache: trial === 0 });
      await waitFor(`performance.timeOrigin !== ${previous} && performance.getEntriesByName('fixture-first-message').length > 0`);
      const firstVisibleMs = await browser.evaluate<number>("performance.getEntriesByName('fixture-first-message')[0].startTime");
      await browser.evaluate("document.querySelector('.writing-surface textarea').focus()");
      const keyStart = await browser.evaluate<number>('performance.now()');
      await browser.command('Input.insertText', { text: '测' });
      const paintedAt = await browser.evaluate<number>('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()))))');
      const metrics = await browser.command('Performance.getMetrics');
      const dom = await browser.evaluate("({elements:document.querySelectorAll('*').length,rows:document.querySelectorAll('.transcript-row').length,mounted:document.querySelectorAll('.message').length})");
      samples.push({ cpu, trial, cache: trial === 0 ? 'cold' : 'warm', firstVisibleMs, inputPaintMs: paintedAt - keyStart, ...dom,
        heapBytes: metrics.metrics.find((metric: any) => metric.name === 'JSHeapUsedSize')?.value });
      writeFileSync(options.output + '.partial', JSON.stringify({ complete: false, samples }, null, 2), { mode: 0o600 });
    }
  }
  await browser.command('Emulation.setCPUThrottlingRate', { rate: 1 });
  await browser.evaluate("document.querySelector('.body-preview-link').click()");
  await waitFor("document.querySelector('.body-reader pre')?.textContent.length > 0");
  const reader = await browser.evaluate("({text:document.querySelector('.body-reader pre').textContent,dialog:document.querySelector('.body-reader').open,dom:document.querySelectorAll('*').length})");
  if (!reader.dialog || reader.text.includes('\ufffd') || new TextEncoder().encode(reader.text).byteLength > 65536) throw new Error('reader_page_invalid');
  await browser.evaluate("[...document.querySelectorAll('.body-reader button')].find(button=>button.textContent==='下一页').click()");
  await waitFor("document.querySelector('.body-reader nav span')?.textContent.startsWith('2 /') && document.querySelector('.body-reader pre')?.textContent.length > 0");
  const second = await browser.evaluate("({text:document.querySelector('.body-reader pre').textContent,dom:document.querySelectorAll('*').length})");
  if (second.text.includes('\ufffd')) throw new Error('reader_utf8_boundary_invalid');
  const expectedPrefix = new StringDecoder('utf8').write(Buffer.from(corpusItem(corpus.items - 1, corpus.items).text).subarray(0, 2 * 65536));
  if (reader.text + second.text !== expectedPrefix) throw new Error('reader_content_mismatch');
  const screenshot = await browser.command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(options.output.replace(/\.json$/, '.png'), Buffer.from(screenshot.data, 'base64'));
  const result = { mode: 'real-chromium-synthetic-archive', corpus: { items: corpus.items, conversations: corpus.conversations, workspaces: corpus.workspaces, files: corpus.files },
    network: { rttMs: 80, throughputMbps: 10 }, viewport: { width: 1280, height: 800 }, samples,
    reader: { firstPageBytes: new TextEncoder().encode(reader.text).byteLength, secondPageBytes: new TextEncoder().encode(second.text).byteLength, dom: second.dom, utf8Exact: true }, exceptionCount };
  writeFileSync(options.output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }

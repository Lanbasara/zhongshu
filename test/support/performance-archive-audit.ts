/** Offline integrity audit only. Never constructs Workbench/native readers or
 * invokes archive/repair commands. Original source files and product DB remain
 * in place; only an owned temporary expectation index is written and removed.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { productMigrations } from '../../src/server/migrations.ts';
import { createStorageClient, type StorageClient } from '../../src/server/storage-client.ts';
import type { NativeItem } from '../../src/harness/types.ts';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const parameters = z.object({ root: z.string().refine(isAbsolute), output: z.string().refine(isAbsolute),
  seconds: z.coerce.number().int().min(10).max(86400).default(3600) }).strict();
const stateSchema = z.object({ format: z.literal(1), harness: z.enum(['codex', 'dsh']), bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  cwd: z.string().refine(isAbsolute), count: z.number().int().min(0).max(1_000_000), sourceBytes: z.number().int().min(0).safe(), manifestBytes: z.number().int().min(0).safe() }).strict();
const recordSchema = z.tuple([z.string().min(1).max(1024), z.string().regex(/^[a-f0-9]{64}$/), z.number().int().min(0).max(256 * 1024 ** 2)]);
type Fingerprint = { bytes: number; dev: string; ino: string; mtimeNs: string; ctimeNs: string; sha256: string };
type Source = { harness: 'codex' | 'dsh'; id: string; state: z.infer<typeof stateSchema>; files: string[]; before: Fingerprint[] };
const fail = (code: string): never => { throw new Error(code); };
function inside(root: string, path: string) { const part = relative(root, path); return !part || !part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part); }

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid() || await realpath(path) !== resolve(path)) fail('unsafe_audit_directory');
}
async function privateFile(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.mode & 0o077n || process.getuid && info.uid !== BigInt(process.getuid())) fail('unsafe_audit_file');
  return info;
}
async function readSmall(path: string, limit: number) {
  if ((await privateFile(path)).size > BigInt(limit)) fail('audit_metadata_too_large');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const buffer = Buffer.alloc(limit + 1); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); if (bytesRead > limit) fail('audit_metadata_too_large'); return buffer.subarray(0, bytesRead).toString('utf8'); }
  finally { await file.close(); }
}
async function stopped(root: string) {
  try { await lstat(join(root, 'app.lock')); fail('fixture_lock_present_stop_and_verify_app_first'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function fingerprint(path: string, check: () => void): Promise<Fingerprint> {
  const before = await privateFile(path), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash('sha256');
  let bytes = 0;
  try {
    const opened = await file.stat({ bigint: true }); if (opened.dev !== before.dev || opened.ino !== before.ino) fail('audit_source_replaced');
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) { check(); bytes += chunk.length; digest.update(chunk); }
    const after = await file.stat({ bigint: true });
    if (before.size !== BigInt(bytes) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail('audit_source_changed');
  } finally { await file.close(); }
  return { bytes, dev: String(before.dev), ino: String(before.ino), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), sha256: digest.digest('hex') };
}
async function* lines(path: string, check: () => void) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let pending = Buffer.alloc(0);
  try {
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      check(); const data = Buffer.concat([pending, chunk]); let start = 0;
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        if (end - start > 4096 || end === start) fail('invalid_expected_manifest_line');
        yield data.subarray(start, end).toString('utf8'); start = end + 1;
      }
      pending = data.subarray(start); if (pending.length > 4096) fail('expected_manifest_line_too_large');
    }
    if (pending.length) fail('expected_manifest_missing_newline');
  } finally { await file.close(); }
}
function nativeSource(root: string, state: Source['state']) {
  if (state.harness === 'codex') return join(root, 'native/sessions/2026/rollout-synthetic.jsonl');
  let encoded = '', separator = false;
  for (let n = 0; n < state.cwd.length; n++) {
    const character = state.cwd[n]!;
    if ('/\\:'.includes(character)) { if (!separator) encoded += '-'; separator = true; }
    else { encoded += /^[A-Za-z0-9._-]$/.test(character) ? character : `~${state.cwd.charCodeAt(n).toString(16).toUpperCase().padStart(4, '0')}`; separator = false; }
  }
  return join(root, 'native', `--${(encoded.replace(/^-+/, '') || 'root').slice(0, 251)}--`, state.bindingId, 'session.v4.jsonl');
}

export async function auditPhysicalArchives(input: z.input<typeof parameters>) {
  const options = parameters.parse(input), began = performance.now(), deadline = Date.now() + options.seconds * 1000;
  let aborted = false; const abort = () => { aborted = true; }; const check = () => { if (aborted) fail('audit_cancelled'); if (Date.now() > deadline) fail('audit_deadline_exceeded'); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const report: Record<string, unknown> = { format: 1, mode: 'stopped-physical-fixture-read-only-integrity-audit', repairAttempted: false,
    status: 'FAIL', complete: false, passes: [], assets: 'Current factory manifest contains text only. Unexpected images/tool/file shapes fail; none are claimed verified.',
    budgets: { pageItems: 100, bodyChunkBytes: 65536, manifestLineBytes: 4096, failureExamples: 16, inFlightRpc: 1 }, startedAt: new Date().toISOString() };
  let scratch: string | undefined, index: DatabaseSync | undefined, observer: DatabaseSync | undefined, storage: StorageClient | undefined, outputReserved = false;
  try {
    const root = resolve(options.root); await privateDirectory(root); await stopped(root);
    if (inside(root, resolve(options.output))) fail('audit_output_must_be_outside_fixture');
    await privateDirectory(dirname(resolve(options.output)));
    await writeFile(options.output, '', { flag: 'wx', mode: 0o600 }); outputReserved = true;
    const marker = z.object({ format: z.literal(1), repository: z.literal(fileURLToPath(new URL('../../', import.meta.url))) }).strict().parse(JSON.parse(await readSmall(join(root, 'fixture.json'), 4096)));
    void marker; await privateDirectory(join(root, 'private')); await privateDirectory(join(root, 'data'));
    await privateFile(join(root, 'data/zhongshu.sqlite'));
    observer = new DatabaseSync(join(root, 'data/zhongshu.sqlite'), { readOnly: true }); observer.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const applied = observer.prepare('SELECT version,digest FROM app_migrations ORDER BY version').all();
    if (applied.length !== productMigrations.length + 1 || Number(applied.at(-1)?.version) !== productMigrations.at(-1)?.version ||
      productMigrations.some(migration => applied.find(row => row.version === migration.version)?.digest !== hash(migration.sql))) fail('audit_requires_exact_existing_schema_no_migration');
    const databaseVersion = observer.prepare('PRAGMA data_version').get()!.data_version;
    report.schema = Number(applied.at(-1)!.version);
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'zh-archive-audit-'))); await privateDirectory(scratch);
    index = new DatabaseSync(join(scratch, 'expected.sqlite'));
    // Disposable expected/seen index only: no durability requirement and no
    // per-item fsync. Product DB durability settings are never changed here.
    index.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE');
    index.exec('CREATE TABLE expected(harness TEXT,id TEXT,ordinal INTEGER,digest TEXT,bytes INTEGER,seen INTEGER DEFAULT 0,PRIMARY KEY(harness,id),UNIQUE(harness,ordinal)) STRICT; CREATE INDEX expected_missing ON expected(harness,seen,ordinal)');
    const insert = index.prepare('INSERT INTO expected(harness,id,ordinal,digest,bytes) VALUES(?,?,?,?,?)');
    const sources: Source[] = [];
    for (const harness of ['codex', 'dsh'] as const) {
      const physical = join(root, 'physical-' + harness); await privateDirectory(physical);
      const state = stateSchema.parse(JSON.parse(await readSmall(join(physical, 'state.json'), 4096)));
      if (state.harness !== harness || !inside(root, state.cwd)) fail('physical_fixture_identity_mismatch'); await privateDirectory(state.cwd);
      const id = z.uuid().parse(await readSmall(join(root, 'private', harness + '-physical-conversation'), 128));
      const source = nativeSource(physical, state); let parent = dirname(source);
      while (parent !== physical) { if (!inside(physical, parent)) fail('physical_source_outside_fixture'); await privateDirectory(parent); parent = dirname(parent); }
      const files = [join(physical, 'state.json'), join(physical, 'expected.ndjson'), source, join(root, 'private', harness + '-physical-conversation')];
      const before: Fingerprint[] = []; for (const file of files) before.push(await fingerprint(file, check));
      if (before[1]!.bytes !== state.manifestBytes || before[2]!.bytes !== state.sourceBytes) fail('physical_fixture_checkpoint_mismatch');
      let ordinal = 0, transaction = false;
      try {
        for await (const line of lines(files[1]!, check)) {
          if (!transaction) { index.exec('BEGIN'); transaction = true; }
          const [itemId, digest, bytes] = recordSchema.parse(JSON.parse(line));
          insert.run(harness, itemId, ordinal++, digest, bytes);
          if (ordinal % 256 === 0) { index.exec('COMMIT'); transaction = false; }
          if (ordinal > state.count) fail('physical_manifest_count_mismatch');
        }
        if (transaction) { index.exec('COMMIT'); transaction = false; }
      } finally { if (transaction) index.exec('ROLLBACK'); }
      if (ordinal !== state.count) fail('physical_manifest_count_mismatch');
      sources.push({ harness, id, state, files, before });
    }
    report.sources = sources.map(source => ({ harness: source.harness, conversationId: source.id, count: source.state.count,
      files: source.files.map((path, n) => ({ path: relative(root, path), ...source.before[n]! })) }));
    const codeFiles = ['./performance-archive-audit.ts', '../../src/server/storage-client.ts', '../../src/server/storage-worker.ts', '../../src/server/workbench-store.ts', '../../src/server/body-store.ts', '../../src/server/migrations.ts'];
    const codeHashes: Record<string, string> = {};
    for (const path of codeFiles) codeHashes[path] = hash(await readFile(new URL(path, import.meta.url)));
    report.codeHashes = codeHashes; report.runtime = { node: process.version, platform: process.platform };
    const passes: object[] = [];
    for (let pass = 1; pass <= 2; pass++) {
      await stopped(root); check(); index.prepare('UPDATE expected SET seen=0').run();
      storage = createStorageClient({ dataDirectory: join(root, 'data') }); await storage.ready;
      const results: object[] = [];
      for (const source of sources) {
        const conversation = await storage.store.getConversation(source.id);
        if (!conversation || conversation.harnessId !== source.harness || conversation.binding?.id !== source.state.bindingId || conversation.cwd !== source.state.cwd) fail('product_physical_binding_mismatch');
        const initialJobs = await storage.store.archiveJobs(source.id);
        const stats = { harness: source.harness, expected: source.state.count, actual: 0, verifiedBodies: 0, bodyChunks: 0, bodyBytes: 0, pages: 0,
          missing: 0, unexpected: 0, duplicates: 0, orderErrors: 0, bodyErrors: 0, incompleteItems: 0, unsupportedShapes: 0, liveItems: 0, liveItemsLimited: false,
          issues: [] as object[], missingExamples: [] as string[], jobs: initialJobs, complete: false };
        const issue = (value: object) => { if (stats.issues.length < 16) stats.issues.push(value); };
        let cursor: string | undefined, previousOrdinal = source.state.count;
        do {
          check(); const page = await storage.store.readHistory(source.id, { beforeItemId: cursor, limit: 100 }); stats.pages++;
          if (stats.pages === 1) { stats.liveItems = page.liveItems.length; stats.liveItemsLimited = page.liveItemsLimited; }
          if (page.items.length > 100 || page.olderBeforeItemId && (!page.items.length || page.olderBeforeItemId === cursor)) fail('audit_history_cursor_not_progressing');
          if (stats.pages > source.state.count + 1000) fail('audit_unexpected_history_page_budget');
          for (const item of page.items.toReversed()) {
            check(); stats.actual++;
            const expected = index.prepare('SELECT ordinal,digest,bytes,seen FROM expected WHERE harness=? AND id=?').get(source.harness, item.id);
            if (!expected) { stats.unexpected++; issue({ kind: 'unexpected', id: item.id }); continue; }
            if (expected.seen) { stats.duplicates++; issue({ kind: 'duplicate', id: item.id }); continue; }
            index.prepare('UPDATE expected SET seen=1 WHERE harness=? AND id=?').run(source.harness, item.id);
            if (Number(expected.ordinal) >= previousOrdinal) { stats.orderErrors++; issue({ kind: 'order', id: item.id }); }
            previousOrdinal = Number(expected.ordinal);
            if (item.status !== 'completed' || item.previewOnly || item.mediaPending) { stats.incompleteItems++; issue({ kind: 'incomplete', id: item.id }); }
            // The factory's strict 3-tuple manifest declares text-only assistant
            // messages. Do not silently pretend future asset shapes were audited.
            if (item.kind !== 'assistant' || item.images?.length || item.tool || item.fileEdits?.length || item.fileEditsLimited || item.references?.length || item.bodies && Object.keys(item.bodies).some(field => field !== 'text')) {
              stats.unsupportedShapes++; issue({ kind: 'manifest_has_no_asset_or_tool_oracle', id: item.id });
            }
            try {
              const actual = await bodyDigest(storage, source.id, item, Number(expected.bytes), check);
              stats.bodyChunks += actual.chunks; stats.bodyBytes += actual.bytes;
              if (actual.bytes !== Number(expected.bytes) || actual.digest !== expected.digest) { stats.bodyErrors++; issue({ kind: 'body_mismatch', id: item.id }); }
              else stats.verifiedBodies++;
            } catch (error) { stats.bodyErrors++; issue({ kind: 'body_unreadable', id: item.id, code: safeError(error) }); }
          }
          cursor = page.olderBeforeItemId ?? undefined;
        } while (cursor);
        stats.missing = Number(index.prepare('SELECT count(*) AS n FROM expected WHERE harness=? AND seen=0').get(source.harness)!.n);
        stats.missingExamples = index.prepare('SELECT id FROM expected WHERE harness=? AND seen=0 ORDER BY ordinal LIMIT 16').all(source.harness).map(row => String(row.id));
        stats.complete = stats.actual === stats.expected && stats.verifiedBodies === stats.expected && !stats.missing && !stats.unexpected && !stats.duplicates && !stats.orderErrors && !stats.bodyErrors && !stats.incompleteItems && !stats.unsupportedShapes && !stats.liveItems && !stats.liveItemsLimited;
        results.push(stats);
      }
      await storage.close(); storage = undefined;
      await stopped(root);
      for (const source of sources) for (let n = 0; n < source.files.length; n++) {
        if (JSON.stringify(await fingerprint(source.files[n]!, check)) !== JSON.stringify(source.before[n])) fail('physical_source_changed_during_audit');
      }
      if (observer.prepare('PRAGMA data_version').get()!.data_version !== databaseVersion) fail('product_database_changed_during_audit');
      for (const path of codeFiles) if (hash(await readFile(new URL(path, import.meta.url))) !== codeHashes[path]) fail('audit_code_changed_during_run');
      passes.push({ pass, workerRestarted: pass === 2, sourcesUnchanged: true, databaseUnchanged: true, results }); report.passes = passes;
      await writeFile(options.output, JSON.stringify({ ...report, checkpoint: 'pass-' + pass, elapsedMs: performance.now() - began }, null, 2) + '\n', { mode: 0o600 });
    }
    const first = passes[0] as { results: { complete: boolean }[] }, second = passes[1] as { results: { complete: boolean }[] };
    report.complete = first.results.every(value => value.complete) && second.results.every(value => value.complete);
    report.restartIdentical = JSON.stringify(first.results) === JSON.stringify(second.results);
    if (report.complete && report.restartIdentical) report.status = 'PASS';
  } catch (error) { report.error = safeError(error); }
  finally {
    await storage?.close().catch(() => {}); observer?.close(); index?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    report.elapsedMs = performance.now() - began; report.temporaryIndexRemoved = true;
    if (outputReserved) await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

function safeError(error: unknown) { return error instanceof z.ZodError ? 'invalid_fixture_manifest' : error instanceof Error && /^[a-z][a-z0-9_]{0,120}$/.test(error.message) ? error.message : 'audit_failed'; }
async function bodyDigest(storage: StorageClient, conversationId: string, item: NativeItem, expectedBytes: number, check: () => void) {
  const digest = createHash('sha256'); let bytes = 0, chunks = 0;
  if (item.bodies?.text) {
    if (item.bodies.text.bytes !== expectedBytes) fail('body_reference_bytes_mismatch');
    let offset: number | null = 0;
    while (offset !== null) {
      check(); const chunk = await storage.store.readBody(conversationId, item.id, 'text', item.bodies.text, offset);
      if (chunk.data.byteLength > 65536 || chunk.offset !== offset || chunk.nextOffset !== null && chunk.nextOffset !== offset + chunk.data.byteLength || !chunk.data.byteLength && expectedBytes) fail('invalid_body_chunk');
      bytes += chunk.data.byteLength; if (bytes > expectedBytes) fail('body_bytes_exceed_manifest'); digest.update(chunk.data); chunks++; offset = chunk.nextOffset;
    }
  } else { const data = Buffer.from(item.text); bytes = data.length; digest.update(data); }
  return { bytes, chunks, digest: digest.digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string' } }, strict: true });
    const report = await auditPhysicalArchives(parameters.parse(args.values)); console.log(JSON.stringify(report)); if (report.status !== 'PASS') process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: safeError(error), repairAttempted: false })); process.exitCode = 1; }
}

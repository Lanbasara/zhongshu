import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/server/database.ts';
import { productMigrations } from '../../src/server/migrations.ts';
import { createWorkbenchStore } from '../../src/server/workbench-store.ts';
import { createWorkspaceStore } from '../../src/server/workspace-store.ts';

/** Product repository commands seed synthetic metadata, never native processes.
 * Instrumented lower/LIKE delegate to a separate SQLite connection's original
 * functions. Counters measure actual predicate evaluations, not returned rows.
 */
export function metadataSearchExperiment(count: number) {
  assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 100_000);
  const root = mkdtempSync(join(tmpdir(), 'zhongshu-search-'));
  const db = openDatabase(root, productMigrations); const builtins = new DatabaseSync(':memory:');
  const result = { count, seedMs: 0, scenarios: [] as unknown[], cleanup: false };
  try {
    let timestamp = 1;
    const store = createWorkbenchStore(db, { now: () => timestamp++ }); const workspaces = createWorkspaceStore(db);
    const expectedConversations: string[] = []; const expectedWorkspaces: string[] = [];
    const seedStart = performance.now();
    for (let index = 0; index < count; index++) {
      const workspaceId = 'workspace-' + index.toString().padStart(6, '0');
      const hit = index === 1 || index === Math.floor(count / 2) || index === count - 2;
      const label = index.toString().padStart(6, '0') + (hit ? ' 中 Ab%_\\Cd' : ' ordinary');
      workspaces.register({ id: workspaceId, label, directory: join(root, 'synthetic-' + index), identity: 'synthetic-' + index, root_id: 'root', pinned: index % 7 ? 0 : 1, removed: 0 });
      const id = randomUUID();
      store.createConversation({ id, harnessId: 'codex', workspaceId, cwd: join(root, 'synthetic-' + index), title: label, configuration: { modelId: 'synthetic', permissionId: 'workspace' } });
      if (hit) { expectedConversations.unshift(id); expectedWorkspaces.push(workspaceId); }
    }
    result.seedMs = performance.now() - seedStart;
    let lowerCalls = 0; let likeCalls = 0;
    const lower = builtins.prepare('SELECT lower(?) AS value'); const like = builtins.prepare('SELECT ? LIKE ? ESCAPE ? AS value');
    db.function('lower', { deterministic: true }, value => { lowerCalls++; return lower.get(value)!.value ?? null; });
    db.function('like', { deterministic: true }, (pattern, value, escape) => { likeCalls++; return like.get(value, pattern, escape)!.value ?? null; });
    for (const term of ['absent-substring', 'aB%_\\cD', '中']) {
      lowerCalls = 0; const oldConversationStart = performance.now();
      const oldConversations = db.prepare('SELECT id FROM workbench_conversations WHERE archived=0 AND instr(lower(title),lower(?))>0 ORDER BY created_at DESC,id DESC LIMIT 30').all(term);
      const oldConversation = { elapsedMs: performance.now() - oldConversationStart, predicateCalls: lowerCalls, returned: oldConversations.length };
      let beforeId: string | undefined; let pages = 0; let scanned = 0; let maxCalls = 0; let maxMs = 0; const ids: string[] = [];
      const conversationStart = performance.now();
      do {
        lowerCalls = 0; const started = performance.now(); const page = store.searchConversations({ title: term, archived: false, beforeId });
        maxMs = Math.max(maxMs, performance.now() - started); maxCalls = Math.max(maxCalls, lowerCalls);
        assert.ok(lowerCalls <= 202); assert.ok(page.scanned <= 200);
        ids.push(...page.entries.map(entry => entry.id)); scanned += page.scanned; pages++; beforeId = page.beforeId ?? undefined;
      } while (beforeId);
      assert.deepEqual(ids, term === 'absent-substring' ? [] : expectedConversations); assert.equal(scanned, count);
      const conversations = { elapsedMs: performance.now() - conversationStart, pages, scanned, maxPredicateCalls: maxCalls, maxPageMs: maxMs, found: ids.length };
      likeCalls = 0; const pattern = '%' + term.replace(/[\\%_]/g, value => '\\' + value) + '%'; const oldWorkspaceStart = performance.now();
      const oldWorkspaces = db.prepare("SELECT id FROM workbench_workspaces WHERE removed=0 AND label LIKE ? ESCAPE ? ORDER BY pinned DESC,label COLLATE NOCASE,id LIMIT 51").all(pattern, '\\');
      const oldWorkspace = { elapsedMs: performance.now() - oldWorkspaceStart, predicateCalls: likeCalls, returned: oldWorkspaces.length };
      let cursor: string | undefined; pages = 0; scanned = 0; maxCalls = 0; maxMs = 0; const workspaceIds: string[] = [];
      const workspaceStart = performance.now();
      do {
        likeCalls = 0; const started = performance.now(); const page = workspaces.page({ query: term, cursor });
        maxMs = Math.max(maxMs, performance.now() - started); maxCalls = Math.max(maxCalls, likeCalls);
        assert.ok(likeCalls <= 257); assert.ok(page.scanned <= 256);
        workspaceIds.push(...page.entries.map(entry => entry.id)); scanned += page.scanned; pages++; cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(workspaceIds.toSorted(), term === 'absent-substring' ? [] : expectedWorkspaces.toSorted()); assert.equal(scanned, count);
      result.scenarios.push({ query: term === 'absent-substring' ? 'zero-hit' : term === '中' ? 'CJK-sparse' : 'literal-wildcards-ASCII-case-sparse', oldConversation, conversations, oldWorkspace,
        workspaces: { elapsedMs: performance.now() - workspaceStart, pages, scanned, maxPredicateCalls: maxCalls, maxPageMs: maxMs, found: workspaceIds.length } });
    }
    return result;
  } finally { builtins.close(); db.close(); rmSync(root, { recursive: true, force: true }); result.cleanup = true; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]; if (output && !isAbsolute(output)) throw new Error('output must be an absolute new file');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const sourceHashes = Object.fromEntries(['src/server/conversation-search.ts', 'src/server/workspace-store.ts', 'src/server/workbench-store.ts', 'src/server/migrations.ts', 'test/support/metadata-search.ts']
    .map(path => [path, createHash('sha256').update(readFileSync(join(repository, path))).digest('hex')]));
  const results = { schema: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim(), sourceHashes, node: process.version, platform: process.platform, createdAt: new Date().toISOString(),
    evidence: 'Repository/SQLite metadata; instrumented original SQLite predicates; no native/browser/SLA claim', results: [10_000, 100_000].map(metadataSearchExperiment) };
  const json = JSON.stringify(results, null, 2) + '\n'; if (output) writeFileSync(output, json, { flag: 'wx', mode: 0o600 }); else process.stdout.write(json);
}

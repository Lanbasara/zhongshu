/** Offline archive/UI corpus. This seeds synthetic product data; it does not
 * demonstrate native history import or real model execution. Run only after
 * stopping the disposable feature-fixture app.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { openDatabase } from '../../src/server/database.ts';
import { productMigrations } from '../../src/server/migrations.ts';
import { createWorkbenchStore } from '../../src/server/workbench-store.ts';
import { createWorkspaceStore } from '../../src/server/workspace-store.ts';
import { directoryIdentity } from '../../src/server/workspace-documents.ts';
import type { NativeItem } from '../../src/harness/types.ts';

export function corpusItem(index: number, total: number): NativeItem {
  const text = index === total - 1 ? '# 完整正文 · UTF-8\n\n' + '中文🙂\t| code | <script>not executable</script> |\n'.repeat(80_000)
    : `第 ${index + 1} 条 · 可独立核对的长期存档\n\n` + (index % 3 === 0 ? '这里是中文与 emoji 🙂 的完整正文。' : 'A synthetic archived message with a stable ordinal. ').repeat(8);
  return { id: `performance:item:${String(index).padStart(7, '0')}`, kind: 'assistant', status: 'completed', text };
}
async function main() {
  const parsed = parseArgs({ options: { root: { type: 'string' }, items: { type: 'string' }, 'total-items': { type: 'string' }, conversations: { type: 'string' }, workspaces: { type: 'string' }, files: { type: 'string' } }, strict: true });
  const options = z.object({ root: z.string().refine(isAbsolute), items: z.coerce.number().int().min(100).max(1_000_000).default(60_000),
    'total-items': z.coerce.number().int().min(100).max(1_000_000).optional(),
    conversations: z.coerce.number().int().min(1).max(100_000).default(10_001), workspaces: z.coerce.number().int().min(1).max(1000).default(300), files: z.coerce.number().int().min(1).max(100_000).default(10_000) })
    .refine(value => value['total-items'] === undefined || value['total-items'] >= value.items && (value['total-items'] === value.items || value.conversations > 1)).parse(parsed.values);
  const root = realpathSync(options.root); const info = lstatSync(root);
  if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()) || existsSync(join(root, 'app.lock'))) throw new Error('requires_stopped_private_fixture');
  const marker = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
  if (marker.format !== 1 || marker.repository !== fileURLToPath(new URL('../../', import.meta.url))) throw new Error('invalid_fixture_identity');
  if (existsSync(join(root, 'corpus.json'))) throw new Error('corpus_already_seeded');
  const db = openDatabase(join(root, 'data'), productMigrations);
  try {
    const store = createWorkbenchStore(db), registry = createWorkspaceStore(db);
    const conversations = store.listConversations({ limit: 100 });
    const selected = conversations.find(value => value.title === 'Performance 60000');
    if (!selected?.binding || store.readHistory(selected.id).items.length) throw new Error('requires_empty_bound_performance_conversation');
    const expected = createHash('sha256'); const began = performance.now();
    for (let start = 0; start < options.items; start += 100) {
      const batch = Array.from({ length: Math.min(100, options.items - start) }, (_, n) => corpusItem(start + n, options.items));
      for (const item of batch) expected.update(JSON.stringify([item.id, createHash('sha256').update(item.text).digest('hex')]) + '\n');
      store.mergeHistory(selected.id, batch);
    }
    store.setHistoryCursor(selected.id, { loaded: true, olderCursor: null, beforeItemId: null });
    const workspaces = Array.from({ length: options.workspaces }, (_, number) => {
      const id = `performance-${String(number).padStart(4, '0')}`, directory = join(root, 'workspace-roots', id);
      mkdirSync(directory, { mode: 0o700 });
      const identity = directoryIdentity(statSync(directory, { bigint: true })); if (!identity) throw new Error('missing_directory_identity');
      registry.register({ id, label: `Performance ${String(number).padStart(4, '0')}`, directory, identity, root_id: 'fixture-root', pinned: 0, removed: 0 });
      return { id, directory };
    });
    let lastConversation = ''; let totalItems = options.items;
    const targetItems = options['total-items'] ?? options.items;
    const globalExpected = createHash('sha256');
    for (let number = 1; number < options.conversations; number++) {
      const workspace = workspaces[number <= 1000 ? 0 : number % workspaces.length]!;
      lastConversation = randomUUID();
      store.createConversation({ id: lastConversation, harnessId: 'codex', workspaceId: workspace.id, cwd: workspace.directory,
        title: `Navigation ${String(number).padStart(7, '0')}`, configuration: selected.configuration });
      // These additional conversations are archive-only fixtures. Startup must
      // not create thousands of unrelated synthetic native execution sessions.
      store.setConversationState(lastConversation, { readiness: 'blocked', error: 'performance_fixture_offline' });
      const remainingConversations = options.conversations - number;
      const count = Math.ceil((targetItems - totalItems) / remainingConversations);
      for (let start = 0; start < count; start += 100) {
        const batch = Array.from({ length: Math.min(100, count - start) }, (_, n) => corpusItem(start + n, count + 1));
        for (const item of batch) globalExpected.update(JSON.stringify([lastConversation, item.id, createHash('sha256').update(item.text).digest('hex')]) + '\n');
        store.mergeHistory(lastConversation, batch); totalItems += batch.length;
      }
    }
    for (let number = 0; number < options.files; number++) writeFileSync(join(root, 'workspace-a', `performance-${String(number).padStart(6, '0')}.txt`), `Synthetic file ${number}\n`, { flag: 'wx', mode: 0o600 });
    const giant = corpusItem(options.items - 1, options.items);
    const result = { mode: 'synthetic-offline-archive-not-native-evidence', ...options, conversationId: selected.id, lastConversation,
      totalItems, remainingExpectedDigest: globalExpected.digest('hex'),
      expectedDigest: expected.digest('hex'), giant: { id: giant.id, bytes: Buffer.byteLength(giant.text), sha256: createHash('sha256').update(giant.text).digest('hex') }, seedMs: performance.now() - began };
    writeFileSync(join(root, 'corpus.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result));
  } finally { db.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) void main().catch(error => { console.error(error instanceof Error ? error.message : 'corpus_failed'); process.exitCode = 1; });

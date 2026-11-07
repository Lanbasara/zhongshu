import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Binding, Catalog, Configuration, HarnessAdapter, HarnessId, HistoryPage, NativeChange, NativeState, Receipt } from '../src/harness/types.ts';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import { conversationConfigurationLabel } from '../src/web/conversation-configuration-label.ts';

/** Synthetic peer for the preset contract (ADR 0017); it proves workbench rules, not DSH behaviour. */
class Peer implements HarnessAdapter {
  readonly id: HarnessId; created: Configuration[] = [];
  presets: Catalog['presets'];
  constructor(id: HarnessId, presets?: Catalog['presets']) { this.id = id; this.presets = presets; }
  async catalog(): Promise<Catalog> { return { id: this.id, available: true, models: [{ id: 'model', label: 'Model' }], permissions: [{ id: 'workspace', label: '工作区读写', description: 'synthetic' }], ...(this.presets ? { presets: this.presets, defaultPresetId: 'standard' } : {}) }; }
  async create(input: { cwd: string; configuration: Configuration }, bound: (value: Binding) => void): Promise<Binding> { this.created.push(input.configuration); const value = { id: `root-${this.created.length}`, cwd: input.cwd, configuration: input.configuration, details: {} }; bound(value); return value; }
  async state(): Promise<NativeState> { return { status: 'idle', pendingInputs: 0, configurationVerified: true }; }
  async history(): Promise<HistoryPage> { return { items: [], olderCursor: null }; }
  async submit(): Promise<Receipt> { return { outcome: 'accepted' }; }
  async reconcile(): Promise<Receipt> { return { outcome: 'unknown', reason: 'not_found' }; }
  async stop(_binding: Binding, runId: string): Promise<Receipt> { return { outcome: 'accepted', runId }; }
  async watch(_binding: Binding, _listener: (change: NativeChange) => void) { return () => {}; }
  async close() {}
}
function fixture(t: TestContext, peer: Peer) {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshu-preset-')); const db = openDatabase(directory, productMigrations);
  const store = createWorkbenchStore(db);
  const workspaces = [{ id: 'fixture', label: 'fixture', directory: '/synthetic/workspace' }];
  const service = new Workbench(store, workspaces, new Map([[peer.id, peer]]));
  t.after(async () => { await service.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service };
}
async function until(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error('condition_timeout'); await delay(5); } }
const standardAndPtc = [{ id: 'standard', label: '标准', description: 'd', available: true }, { id: 'ptc', label: 'PTC', description: 'd', available: true }];

test('a DSH preset is part of the fixed configuration and must be offered and usable', async t => {
  const peer = new Peer('dsh', standardAndPtc); const f = fixture(t, peer);
  const conversation = await f.service.create({ id: randomUUID(), harnessId: 'dsh', workspaceId: 'fixture', title: 'PTC', configuration: { modelId: 'model', permissionId: 'workspace', agentPreset: 'ptc' } });
  await until(() => f.store.getConversation(conversation.id)!.readiness !== 'preparing').catch(() => {});
  const after = f.store.getConversation(conversation.id)!; assert.equal(after.readiness, 'ready', JSON.stringify({ readiness: after.readiness, error: after.error }));
  assert.equal(peer.created[0]!.agentPreset, 'ptc');
  assert.equal(f.store.getConversation(conversation.id)!.configuration.agentPreset, 'ptc');
});

test('an unavailable DSH preset blocks creation instead of being swapped', async t => {
  const peer = new Peer('dsh', [standardAndPtc[0]!, { ...standardAndPtc[1]!, available: false }]); const f = fixture(t, peer);
  const refused = await f.service.create({ id: randomUUID(), harnessId: 'dsh', workspaceId: 'fixture', title: 'gone', configuration: { modelId: 'model', permissionId: 'workspace', agentPreset: 'ptc' } });
  await until(() => f.store.getConversation(refused.id)!.readiness === 'blocked');
  assert.equal(peer.created.length, 0, 'an unavailable preset is never created or swapped');
});

test('a Codex conversation never carries a preset; older conversations without one still read and label', async t => {
  const peer = new Peer('codex'); const f = fixture(t, peer);
  const refused = await f.service.create({ id: randomUUID(), harnessId: 'codex', workspaceId: 'fixture', title: 'x', configuration: { modelId: 'model', permissionId: 'workspace', agentPreset: 'ptc' } });
  await until(() => f.store.getConversation(refused.id)!.readiness === 'blocked');
  assert.equal(peer.created.length, 0);
  const legacy = await f.service.create({ id: randomUUID(), harnessId: 'codex', workspaceId: 'fixture', title: 'old', configuration: { modelId: 'model', permissionId: 'workspace' } });
  await until(() => f.store.getConversation(legacy.id)!.readiness === 'ready');
  const catalogs = [{ id: 'dsh' as const, available: true, models: [{ id: 'model', label: 'Model' }], permissions: [], presets: standardAndPtc, defaultPresetId: 'standard' }];
  assert.deepEqual(conversationConfigurationLabel({ harnessId: 'dsh', configuration: { modelId: 'model', permissionId: 'workspace', agentPreset: 'ptc' } }, catalogs), { model: 'Model', reasoningEffort: undefined, agentPreset: 'PTC' });
  assert.equal('agentPreset' in conversationConfigurationLabel({ harnessId: 'dsh', configuration: { modelId: 'model', permissionId: 'workspace' } }, catalogs), false);
});

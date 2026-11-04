import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ExecutionCoordinator, executionGateSchema } from '../src/server/execution-coordinator.ts';
import type { ExecutionCoordinatorPort, ExecutionGate, ExecutionCursor, PendingExecution, GroupRevision, SaveAdmission, SavePermit, SaveWriteIdentity } from '../src/server/execution-coordinator.ts';
import type { ExecutionController, ExecutionControllerMutation, ExecutionControllerResult, ExecutionEpoch, ExecutionGroupState } from '../src/server/execution-controller.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const writeIdentity: SaveWriteIdentity = { workspaceId: 'workspace', directoryIdentity: 'directory-identity', path: 'edit.txt', expectedVersion: digest('old version'), contentDigest: digest('new bytes') };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** Contract test port: JSON round trips emulate persistence, not SQLite/OS proof. */
class Port implements ExecutionCoordinatorPort {
  gates = new Map<string, ExecutionGate>();
  operations = new Map<string, PendingExecution[]>();
  memberships = new Map<string, Set<string>>();
  saves = new Map<string, { permit: SavePermit; outcome: 'pending' | 'committed' | 'rejected' }>();
  pageReads: { limit: number; after?: ExecutionCursor }[] = [];
  freezeOrder: string[][] = [];
  failNextSave = false;
  constructor(ids: string[]) {
    for (const groupId of ids) {
      this.gates.set(groupId, { groupId, revision: 0, baselineComplete: true, phase: 'online', controller: { groupId, generation: 'durable-' + groupId, epoch: 0, admission: 'open', writers: 'running', durable: true } });
      this.operations.set(groupId, []);
    }
  }
  add(groupId: string, number: number, kind: Exclude<PendingExecution['kind'], 'host'> = 'queued') {
    assert.equal(this.gates.get(groupId)!.phase, 'online', 'new admissions must be closed');
    this.operations.get(groupId)!.push({ id: groupId + '-operation-' + number, sequence: number, groupId, bindingId: 'native-binding', workspaceId: 'workspace', directoryIdentity: 'directory-identity', kind });
  }
  async load(ids: string[]) { return ids.map(id => copy(this.gates.get(id)!)); }
  async save(groupId: string, revision: number, next: ExecutionGate) {
    if (this.failNextSave) { this.failNextSave = false; return false; }
    if (this.gates.get(groupId)?.revision !== revision) return false;
    assert.equal(next.revision, revision + 1); this.gates.set(groupId, copy(executionGateSchema.parse(next))); return true;
  }
  private checked(groups: GroupRevision[]) {
    const rows = groups.map(({ groupId, revision }) => { const row = this.gates.get(groupId)!; assert.equal(row.revision, revision); return row; });
    assert.deepEqual(groups.map(group => group.groupId), groups.map(group => group.groupId).sort());
    return rows;
  }
  async freezeAdmissions(input: { windowId: string; groups: GroupRevision[] }) {
    const rows = this.checked(input.groups); assert.ok(rows.every(row => row.phase === 'online' && row.baselineComplete));
    const windowGroups = rows.map(row => row.groupId); this.freezeOrder.push(windowGroups);
    for (const row of rows) {
      const members = this.operations.get(row.groupId)!.map(operation => operation.id);
      const frozenSetId = digest([input.windowId, row.groupId, members]);
      this.memberships.set(frozenSetId, new Set(members));
      this.gates.set(row.groupId, { ...row, revision: row.revision + 1, phase: 'draining', stage: 'fence', windowId: input.windowId, windowGroups, frozenSetId });
    }
    return this.load(windowGroups);
  }
  async pendingPage(input: { groupId: string; frozenSetId: string; after?: ExecutionCursor; limit: number; byteLimit: number }) {
    this.pageReads.push({ limit: input.limit, after: input.after });
    const members = this.memberships.get(input.frozenSetId)!;
    const remaining = this.operations.get(input.groupId)!.filter(operation => members.has(operation.id) && (!input.after || operation.sequence > input.after.sequence || operation.sequence === input.after.sequence && operation.id > input.after.id));
    const entries = remaining.slice(0, input.limit);
    const last = entries.at(-1);
    return copy({ entries, nextCursor: remaining.length > entries.length && last ? { id: last.id, sequence: last.sequence } : null });
  }
  async beginResume(input: { windowId: string; groups: GroupRevision[] }) {
    const rows = this.checked(input.groups); assert.ok(rows.every(row => row.windowId === input.windowId && row.phase === 'editable'));
    for (const row of rows) this.gates.set(row.groupId, { ...row, revision: row.revision + 1, phase: 'resuming', stage: 'resume' });
    return this.load(rows.map(row => row.groupId));
  }
  async hasUnsettledSaves(windowId: string) { return [...this.saves.values()].some(save => save.permit.windowId === windowId && save.outcome === 'pending'); }
  async completeResume(input: { windowId: string; groups: GroupRevision[] }) {
    const rows = this.checked(input.groups);
    assert.equal(await this.hasUnsettledSaves(input.windowId), false);
    assert.ok(rows.every(row => row.windowId === input.windowId && row.phase === 'resuming' && row.stage === 'opened' && row.controller.admission === 'open'));
    for (const row of rows) this.gates.set(row.groupId, { groupId: row.groupId, revision: row.revision + 1, baselineComplete: true, phase: 'online', controller: row.controller });
    return this.load(rows.map(row => row.groupId));
  }
  async acquireSave(input: { saveId: string; windowId: string; write: SaveWriteIdentity; groups: GroupRevision[] }): Promise<SaveAdmission> {
    const rows = this.checked(input.groups); assert.ok(rows.every(row => row.windowId === input.windowId && row.phase === 'editable'));
    const old = this.saves.get(input.saveId);
    if (old) { assert.deepEqual(old.permit.write, input.write); assert.equal(old.permit.windowId, input.windowId); return { created: false, outcome: old.outcome }; }
    const permit = { saveId: input.saveId, windowId: input.windowId, write: copy(input.write), groups: rows.map(row => ({ groupId: row.groupId, controller: { generation: row.controller.generation, epoch: row.controller.epoch } })) };
    this.saves.set(input.saveId, { permit, outcome: 'pending' }); return { created: true, permit };
  }
  async settleSave(saveId: string, outcome: 'committed' | 'rejected', proof: string) {
    assert.match(proof, /^[a-f0-9]{64}$/);
    const save = this.saves.get(saveId)!;
    if (save.outcome !== 'pending') return save.outcome === outcome;
    save.outcome = outcome; return true;
  }
  settled(operation: PendingExecution) { this.operations.set(operation.groupId, this.operations.get(operation.groupId)!.filter(candidate => candidate.id !== operation.id)); }
}

class Controller implements ExecutionController {
  state: ExecutionGroupState;
  calls: { action: string; request: ExecutionControllerMutation }[] = [];
  receipts = new Map<string, { request: string; state: ExecutionGroupState }>();
  lostNext?: 'fence' | 'quiesce' | 'resume';
  unknownInspect = false;
  before?: (action: string) => void;
  constructor(state: ExecutionGroupState) { this.state = copy(state); }
  async inspect(_requestId: string, expected?: ExecutionEpoch): Promise<ExecutionControllerResult> {
    if (this.unknownInspect || expected && (expected.generation !== this.state.generation || expected.epoch !== this.state.epoch)) return { status: 'unknown', reason: 'controller_unknown' };
    return { status: 'known', state: copy(this.state) };
  }
  private async mutate(action: 'fence' | 'quiesce' | 'resume', request: ExecutionControllerMutation): Promise<ExecutionControllerResult> {
    this.before?.(action); this.calls.push({ action, request: copy(request) });
    const old = this.receipts.get(request.requestId); const identity = JSON.stringify([action, request]);
    if (old) { assert.equal(old.request, identity); return { status: 'known', state: copy(old.state) }; }
    if (this.state.generation !== request.expected.generation || this.state.epoch !== request.expected.epoch) return { status: 'unknown', reason: 'epoch_mismatch' };
    this.state = { groupId: this.state.groupId, generation: this.state.generation, epoch: this.state.epoch + 1, admission: action === 'fence' ? 'drain' : action === 'quiesce' ? 'closed' : 'open', writers: action === 'quiesce' ? 'quiescent' : 'running', durable: true,
      ...(action === 'resume' ? {} : { frozenSetId: request.frozenSetId }) };
    this.receipts.set(request.requestId, { request: identity, state: copy(this.state) });
    if (this.lostNext === action) { this.lostNext = undefined; return { status: 'unknown', reason: 'timeout' }; }
    return { status: 'known', state: copy(this.state) };
  }
  fence(request: ExecutionControllerMutation) { return this.mutate('fence', request); }
  quiesce(request: ExecutionControllerMutation) { return this.mutate('quiesce', request); }
  resume(request: Omit<ExecutionControllerMutation, 'frozenSetId'>) { return this.mutate('resume', request); }
}
function fixture(ids = ['group']) {
  const port = new Port(ids);
  const controllers = new Map(ids.map(id => [id, new Controller(port.gates.get(id)!.controller)]));
  const resolve = async (operation: PendingExecution) => { port.settled(operation); return 'settled' as const; };
  return { port, controllers, resolve, coordinator: new ExecutionCoordinator(port, controllers, resolve), target: { windowId: 'window-1', groupIds: ids } };
}

test('all conflicting groups fence before draining; admitted queued work continues and newcomers are rejected', async () => {
  const f = fixture(['B', 'A']); f.port.add('A', 1); f.port.add('B', 1, 'waiting');
  let ready = false; const resolved: string[] = [];
  const coordinator = new ExecutionCoordinator(f.port, f.controllers, async (operation, permission) => {
    assert.deepEqual(permission.groups.map(group => group.groupId), ['A', 'B']);
    assert.ok([...f.controllers.values()].every(controller => controller.state.admission === 'drain'));
    assert.throws(() => f.port.add(operation.groupId, 99));
    if (!ready) return 'pending';
    resolved.push(operation.id); f.port.settled(operation); return 'settled';
  });
  assert.equal((await coordinator.enterEdit(f.target)).phase, 'draining');
  assert.ok([...f.controllers.values()].every(controller => !controller.calls.some(call => call.action === 'quiesce')));
  ready = true;
  assert.equal((await coordinator.advance(f.target)).phase, 'editable');
  assert.equal(resolved.length, 2); assert.deepEqual(f.port.freezeOrder, [['A', 'B']]);
  assert.equal((await coordinator.resume(f.target)).phase, 'online');
  f.port.add('A', 99);
});

for (const action of ['fence', 'quiesce', 'resume'] as const) test('lost ' + action + ' receipt replays one persisted intent after coordinator restart', async () => {
  const f = fixture(); const controller = f.controllers.get('group')!;
  if (action === 'resume') { assert.equal((await f.coordinator.enterEdit(f.target)).phase, 'editable'); controller.lostNext = action; assert.equal((await f.coordinator.resume(f.target)).phase, 'unknown'); }
  else { controller.lostNext = action; assert.equal((await f.coordinator.enterEdit(f.target)).phase, 'unknown'); }
  const before = copy(f.port.gates.get('group')!.intent!);
  assert.equal(before.action, action);
  const restarted = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
  assert.equal((await restarted.advance(f.target)).phase, action === 'resume' ? 'online' : 'editable');
  const retries = controller.calls.filter(call => call.action === action);
  assert.equal(retries.length, 2); assert.deepEqual(retries[0]!.request, retries[1]!.request);
  assert.equal(controller.receipts.size, action === 'resume' ? 3 : 2);
});

test('pending recovery is keyset-batched and never scans finished history', async () => {
  const f = fixture(); for (let number = 0; number < 130; number++) f.port.add('group', number);
  assert.equal((await f.coordinator.enterEdit(f.target)).phase, 'draining');
  assert.equal(f.port.operations.get('group')!.length, 66);
  assert.equal((await f.coordinator.advance(f.target)).phase, 'draining');
  assert.equal((await f.coordinator.advance(f.target)).phase, 'editable');
  assert.ok(f.port.pageReads.every(read => read.limit <= 64));
  assert.equal(f.port.pageReads.filter(read => read.limit === 64).length, 3);
});

test('unknown native work keeps its identity, blocks saving, and is reconciled without automatic cancellation', async () => {
  const f = fixture(); f.port.add('group', 1, 'receipt-unknown');
  const first = new ExecutionCoordinator(f.port, f.controllers, async () => 'unknown');
  const waiting = await first.enterEdit(f.target);
  assert.equal(waiting.phase, 'draining'); assert.equal(waiting.reason, 'execution_pending_unknown');
  assert.equal(f.port.operations.get('group')!.length, 1);
  await assert.rejects(first.withSave({ ...f.target, write: writeIdentity, saveId: 'save' }, async () => ({ outcome: 'committed', proof: digest('file'), value: 'saved' })));
  const restarted = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
  assert.equal((await restarted.advance(f.target)).phase, 'editable');
  assert.deepEqual(f.controllers.get('group')!.calls.map(call => call.action), ['fence', 'quiesce']);
});

test('an unknown native member does not revoke a proven fence or starve other members of the fixed set', async () => {
  const f = fixture(); f.port.add('group', 1, 'receipt-unknown'); f.port.add('group', 2, 'queued');
  const visited: string[] = [];
  const coordinator = new ExecutionCoordinator(f.port, f.controllers, async pending => {
    visited.push(pending.id);
    assert.equal(f.port.gates.get('group')!.phase, 'draining');
    if (pending.sequence === 1) return 'unknown';
    f.port.settled(pending); return 'settled';
  });
  assert.equal((await coordinator.enterEdit(f.target)).phase, 'draining');
  assert.equal(visited.length, 2); assert.equal(f.port.operations.get('group')!.length, 1);
  assert.deepEqual(f.controllers.get('group')!.calls.map(call => call.action), ['fence']);
  assert.throws(() => f.port.add('group', 3));
  await assert.rejects(coordinator.withSave({ ...f.target, saveId: 'blocked', write: writeIdentity }, async () => { throw new Error('must not write'); }));
});

test('a second coordinator cannot resume while an admitted save is still running', async () => {
  const f = fixture(); await f.coordinator.enterEdit(f.target);
  const entered = deferred<void>(); const release = deferred<void>();
  const save = f.coordinator.withSave({ ...f.target, write: writeIdentity, saveId: 'saving' }, async () => {
    entered.resolve(); await release.promise; return { outcome: 'committed', proof: digest('saved bytes'), value: 'saved' };
  });
  await entered.promise;
  const second = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
  const waiting = await second.resume(f.target);
  assert.equal(waiting.phase, 'resuming'); assert.equal(waiting.reason, 'execution_save_unresolved');
  assert.equal(f.controllers.get('group')!.state.admission, 'closed');
  await assert.rejects(second.withSave({ ...f.target, write: writeIdentity, saveId: 'late-save' }, async () => { assert.fail('must not write'); }));
  release.resolve(); assert.equal((await save).status, 'committed');
  assert.equal((await second.resume(f.target)).phase, 'online');
});

test('unknown save effects remain blocked across restart and duplicate save IDs never repeat the effect', async () => {
  const f = fixture(); await f.coordinator.enterEdit(f.target); let calls = 0;
  const result = await f.coordinator.withSave({ ...f.target, write: writeIdentity, saveId: 'lost-save' }, async () => { calls++; throw new Error('lost confirmation'); });
  assert.equal(result.status, 'unknown');
  const restarted = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
  assert.deepEqual(await restarted.withSave({ ...f.target, write: writeIdentity, saveId: 'lost-save' }, async () => { calls++; assert.fail('must not replay'); }), { status: 'duplicate', outcome: 'pending' });
  assert.equal(calls, 1);
  assert.equal((await restarted.resume(f.target)).reason, 'execution_save_unresolved');
  // A separate trusted filesystem reconciler supplies actual effect proof.
  await f.port.settleSave('lost-save', 'committed', digest('verified file version'));
  assert.equal((await restarted.resume(f.target)).phase, 'online');
});

test('incomplete migration, partial group scopes, stale controller epochs and CAS failures cannot authorize saves', async () => {
  const f = fixture(['A', 'B']);
  f.port.gates.get('A')!.baselineComplete = false;
  await assert.rejects(f.coordinator.enterEdit(f.target), { code: 'execution_baseline_incomplete' });
  assert.equal(f.controllers.get('A')!.calls.length, 0);
  f.port.gates.get('A')!.baselineComplete = true;
  f.port.failNextSave = true;
  await assert.rejects(f.coordinator.enterEdit(f.target), { code: 'execution_state_changed' });
  assert.equal(f.controllers.get('A')!.calls.length, 0, 'intent must commit before native mutation');
  assert.equal((await f.coordinator.advance(f.target)).phase, 'editable');
  await assert.rejects(f.coordinator.withSave({ windowId: f.target.windowId, groupIds: ['A'], write: writeIdentity, saveId: 'subset' }, async () => { assert.fail('subset must not save'); }), { code: 'execution_window_changed' });
  f.controllers.get('A')!.state.generation = 'replacement-controller';
  await assert.rejects(f.coordinator.withSave({ ...f.target, write: writeIdentity, saveId: 'stale-generation' }, async () => { assert.fail('stale proof must not save'); }), { code: 'execution_controller_unknown' });
});

test('a resolver claim alone cannot remove durable pending work or authorize quiescence', async () => {
  const f = fixture(); f.port.add('group', 1);
  const coordinator = new ExecutionCoordinator(f.port, f.controllers, async () => 'settled');
  assert.equal((await coordinator.enterEdit(f.target)).phase, 'draining');
  assert.equal(f.controllers.get('group')!.calls.some(call => call.action === 'quiesce'), false);
});

test('a late successful native receipt cannot overwrite a newer durable revision', async () => {
  const f = fixture(); const controller = f.controllers.get('group')!;
  controller.before = action => {
    if (action !== 'fence') return;
    controller.before = undefined;
    f.port.gates.get('group')!.revision++;
  };
  await assert.rejects(f.coordinator.enterEdit(f.target), { code: 'execution_state_changed' });
  assert.equal(f.port.gates.get('group')!.stage, 'fence');
  assert.equal(f.port.gates.get('group')!.phase, 'draining');
  const restarted = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
  assert.equal((await restarted.advance(f.target)).phase, 'editable');
  assert.equal(controller.receipts.size, 2);
  assert.equal(controller.calls.filter(call => call.action === 'fence').length, 2);
});

test('partial multi-group resume leaves application admission closed until every exact receipt is recovered', async () => {
  const f = fixture(['A', 'B']); await f.coordinator.enterEdit(f.target);
  f.controllers.get('B')!.lostNext = 'resume';
  assert.equal((await f.coordinator.resume(f.target)).phase, 'unknown');
  assert.throws(() => f.port.add('A', 1)); assert.throws(() => f.port.add('B', 1));
  const restarted = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
  assert.equal((await restarted.advance(f.target)).phase, 'online');
  assert.equal(f.controllers.get('A')!.calls.filter(call => call.action === 'resume').length, 1);
  assert.equal(f.controllers.get('B')!.calls.filter(call => call.action === 'resume').length, 2);
});

test('contradictory persisted gates, foreign save permits and non-progressing cursors fail closed', async () => {
  const f = fixture(); await f.coordinator.enterEdit(f.target);
  const closed = copy(f.port.gates.get('group')!.controller);
  f.port.gates.get('group')!.controller = { ...closed, admission: 'open', writers: 'running', frozenSetId: undefined };
  await assert.rejects(f.coordinator.withSave({ ...f.target, write: writeIdentity, saveId: 'invalid' }, async () => { assert.fail('invalid gate must not save'); }), { code: 'execution_gate_invalid' });
  f.port.gates.get('group')!.controller = closed;
  const originalAcquire = f.port.acquireSave.bind(f.port);
  f.port.acquireSave = async input => {
    const result = await originalAcquire(input);
    if (result.created) result.permit.windowId = 'foreign-window';
    return result;
  };
  await assert.rejects(f.coordinator.withSave({ ...f.target, write: writeIdentity, saveId: 'foreign' }, async () => { assert.fail('foreign permit must not save'); }), { code: 'execution_save_permit_invalid' });
  const another = fixture();
  another.port.pendingPage = async () => ({ entries: [], nextCursor: { sequence: 0, id: 'no-progress' } });
  await assert.rejects(another.coordinator.enterEdit(another.target), { code: 'execution_pending_cursor_invalid' });
  assert.equal(another.controllers.get('group')!.state.admission, 'drain');
});

test('a successful historical receipt is not proof of the current controller gate', async () => {
  for (const action of ['quiesce', 'resume'] as const) {
    const f = fixture(); const controller = f.controllers.get('group')!;
    if (action === 'resume') { await f.coordinator.enterEdit(f.target); controller.lostNext = action; await f.coordinator.resume(f.target); }
    else { controller.lostNext = action; await f.coordinator.enterEdit(f.target); }
    controller.state = { ...controller.state, epoch: controller.state.epoch + 1, admission: 'open', writers: 'running', frozenSetId: undefined };
    const restarted = new ExecutionCoordinator(f.port, f.controllers, f.resolve);
    assert.equal((await restarted.advance(f.target)).phase, 'unknown');
    assert.notEqual(f.port.gates.get('group')!.phase, 'online');
  }
});

test('save journal retains immutable filesystem identity and rejects same-ID different-body replay', async () => {
  const f = fixture(); await f.coordinator.enterEdit(f.target); let calls = 0;
  const input = { ...f.target, saveId: 'versioned-save', write: writeIdentity };
  assert.equal((await f.coordinator.withSave(input, async permit => {
    calls++; assert.deepEqual(permit.write, writeIdentity);
    return { outcome: 'committed', proof: digest('actual new file version'), value: 'saved' };
  })).status, 'committed');
  assert.deepEqual(await f.coordinator.withSave(input, async () => { calls++; assert.fail('completed save must not replay'); }), { status: 'duplicate', outcome: 'committed' });
  await assert.rejects(f.coordinator.withSave({ ...input, write: { ...writeIdentity, contentDigest: digest('another body') } }, async () => { calls++; assert.fail('conflicting save must not execute'); }));
  assert.equal(calls, 1);
  assert.deepEqual(f.port.saves.get(input.saveId)!.permit.write, writeIdentity);
});

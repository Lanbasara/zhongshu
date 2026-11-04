import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { foldBounded, initialFold } from '../src/harness/dsh/bounded-host-plugin.ts';
import { boundedStateFrom, boundedStateSchema } from '../src/harness/dsh/bounded-state.ts';
import { modelId } from '../src/harness/dsh/native.ts';

const model = { provider: 'synthetic', model: 'bounded' };
const binding = { id: 'synthetic-session', cwd: '/synthetic', configuration: { modelId: modelId(model), permissionId: 'read-only' }, details: {} };
const baseline = () => ({ protocol: 1, nativeVersion: '0.2.1-rc.4', epoch: randomUUID(), sessionId: binding.id, cwd: binding.cwd, cursor: 10,
  boundary: { openTurnStartSeq: null, lastTurn: 1 }, pendingInputs: 0, waiting: false, latestEnd: 'completed',
  values: { modelSelection: { next: model, lastUsed: model }, permissions: { currentValue: 'read-only' } } });

test('DSH Host projection remains bounded after 50,000 turns and never retains message bodies', () => {
  let state = initialFold();
  for (let turn = 1; turn <= 50_000; turn++) {
    state = foldBounded(state, { type: 'turn/start', seq: turn * 3, data: { turn } });
    state = foldBounded(state, { type: 'user/message', seq: turn * 3 + 1, data: { source: { rpcId: `input-${turn}` }, content: [{ type: 'text', text: 'private synthetic body' }] } });
    state = foldBounded(state, { type: 'turn/end', seq: turn * 3 + 2, data: { turn, reason: { kind: 'completed' } } });
  }
  assert.equal(state.terminals.length, 64); assert.equal(state.accepted.length, 64); assert.equal(state.turn, 50_000);
  assert(Buffer.byteLength(JSON.stringify(state)) < 8192); assert(!JSON.stringify(state).includes('private synthetic body'));
  const before = state; state = foldBounded(state, { type: 'assistant/message', seq: 200_000, data: { message: 'x'.repeat(2_000_000) } }); assert.equal(state, before);
});

test('DSH bounded state never invents idle or exact target completion from missing or mismatched evidence', () => {
  const value = baseline(); const parsed = boundedStateSchema.parse(value);
  assert.equal(boundedStateFrom(binding, parsed).status, 'idle');
  assert.equal(boundedStateFrom(binding, { ...parsed, latestEnd: undefined }).status, 'unknown');
  const running = { ...parsed, boundary: { lastTurn: 2, openTurnStartSeq: 8 }, latestEnd: undefined };
  assert.equal(boundedStateFrom(binding, running).status, 'running');
  assert.equal(boundedStateFrom(binding, { ...running, waiting: true }).status, 'waiting');
  const target = `dsh:${binding.id}:turn:1`, terminal = { turn: 1, seq: 7, reason: 'completed' as const };
  assert.equal(boundedStateFrom(binding, { ...running, terminal }, target).terminalStatus, 'completed');
  assert.equal(boundedStateFrom(binding, { ...running, terminal }, `dsh:${binding.id}:turn:2`).terminalStatus, undefined);
  assert.equal(boundedStateFrom(binding, { ...running, terminal: { ...terminal, seq: 11 } }, target).terminalStatus, undefined);
  assert.throws(() => boundedStateFrom(binding, { ...parsed, cwd: '/other' }));
  assert.equal(boundedStateSchema.safeParse({ ...value, nativeVersion: '0.2.2' }).success, false);
  assert.equal(boundedStateSchema.safeParse({ ...value, values: { permissions: { currentValue: 'read-only' } } }).success, false);
  assert.equal(boundedStateFrom(binding, { ...parsed, values: { ...parsed.values, permissions: { currentValue: 'danger-full-access' } } }).configurationVerified, false);
});

test('DSH approval overflow remains explicit until a native turn boundary settles it', () => {
  let state = foldBounded(initialFold(), { type: 'turn/start', seq: 0, data: { turn: 1 } });
  for (let i = 0; i < 129; i++) state = foldBounded(state, { type: 'approval/asked', seq: i + 1, data: { id: `approval-${i}` } });
  assert.equal(state.approvals.length, 128); assert(state.overflow);
  state = foldBounded(state, { type: 'approval/decided', seq: 130, data: { id: 'approval-0' } }); assert(state.overflow);
  state = foldBounded(state, { type: 'turn/end', seq: 131, data: { turn: 1, reason: { kind: 'aborted' } } }); assert.equal(state.overflow, false); assert.equal(state.approvals.length, 0);
});

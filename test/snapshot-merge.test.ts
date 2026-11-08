import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptFull, applyState } from '../src/web/snapshot-merge.ts';
import type { ConversationState, WorkbenchSnapshot } from '../src/shared/workbench.ts';

const id = '00000000-0000-4000-8000-000000000001';
const conversation = (status: 'idle' | 'running', title = 'T') => ({ id, title, harnessId: 'codex' as const, workspaceId: 'w', configuration: { modelId: 'm', permissionId: 'p' },
  readiness: 'ready' as const, archived: false, state: { status, pendingInputs: 0, configurationVerified: true }, error: null, createdAt: 1 });
function snapshot(revision: number, status: 'idle' | 'running', extra: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot {
  return { conversation: conversation(status), history: { items: [{ id: 'h' + revision, kind: 'assistant', text: 'body ' + revision, status: 'completed' }], liveItems: [], liveItemsLimited: false, olderCursor: null, loaded: true },
    operations: [], revision, live: { epoch: 'epoch-123456', sequence: revision }, ...extra };
}

test('a state read replaces only the state and keeps history, live position and history revision (ADR 0020)', () => {
  const current = snapshot(5, 'running', { usage: { total: 1 }, planReady: { runId: 'r' }, turnFiles: [{ runId: 'r', paths: ['a.ts'], limited: false }] });
  const state: ConversationState = { conversation: conversation('idle', 'Renamed'), operations: [], usage: { total: 9 }, revision: 8 };
  const next = applyState(current, state);
  assert.equal(next.conversation.state.status, 'idle'); assert.equal(next.conversation.title, 'Renamed'); assert.deepEqual(next.usage, { total: 9 });
  assert.equal(next.planReady, undefined, 'a field the state no longer has is removed');
  assert.deepEqual(next.history, current.history); assert.deepEqual(next.turnFiles, current.turnFiles); assert.deepEqual(next.live, current.live);
  assert.equal(next.revision, 5, 'the history revision belongs to full reads');
});

test('a full read older than the last state read keeps the newer state but takes the history', () => {
  const current = applyState(snapshot(5, 'running'), { conversation: conversation('idle'), operations: [], revision: 9 });
  const slow = snapshot(7, 'running');
  const adopted = adoptFull(current, slow, 9);
  assert.equal(adopted.conversation.state.status, 'idle', 'the older full read does not undo the newer state');
  assert.equal(adopted.history.items[0]!.id, 'h7'); assert.equal(adopted.revision, 7);
  assert.equal(adoptFull(current, snapshot(10, 'running'), 9).conversation.state.status, 'running', 'a newer full read wins');
  assert.equal(adoptFull(undefined, slow, 9), slow);
  const other = { ...slow, conversation: { ...slow.conversation, id: '00000000-0000-4000-8000-000000000002' } };
  assert.equal(adoptFull(current, other, 9), other, 'another conversation never borrows this state');
});

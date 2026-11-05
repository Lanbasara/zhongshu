import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotSchema } from '../src/shared/workbench.ts';
import { conversationFeedback } from '../src/web/conversation-feedback.ts';
import { abortableTask } from '../src/web/abortable-task.ts';

const id = 'd91ad8d5-1f51-4207-9ae4-13973a9b42b7';
function snapshot() {
  return snapshotSchema.parse({ conversation: { id, title: 'feedback', harnessId: 'codex', workspaceId: 'a',
    configuration: { modelId: 'model', permissionId: 'read' }, readiness: 'ready', error: null, createdAt: 0,
    state: { status: 'idle', pendingInputs: 0, configurationVerified: true } },
    history: { items: [], liveItems: [], liveItemsLimited: false, olderBeforeItemId: null, hasOlder: false, loaded: true },
    operations: [], revision: 1, operationState: { unresolved: false, latestAcceptedMessage: null } });
}

test('an accepted message without an observed run does not claim the conversation is ready', () => {
  const value = snapshot();
  value.operationState!.latestAcceptedMessage = { id, runId: null };
  assert.equal(conversationFeedback(value).label, '等待执行确认');
  assert.equal(conversationFeedback(value).settled, false);
  value.operationState!.latestAcceptedMessage.runId = 'run';
  value.conversation.state = { ...value.conversation.state, status: 'running', runId: 'run' };
  assert.equal(conversationFeedback(value).label, '运行中');
  value.conversation.state = { status: 'idle', terminalRunId: 'run', pendingInputs: 0, configurationVerified: true };
  assert.equal(conversationFeedback(value).label, '就绪');
});

test('unknown outcomes remain distinct from ordinary acceptance and preserve unresolved admission', () => {
  const value = snapshot();
  value.operationState!.unresolved = true;
  value.operations.push({ id, conversationId: id, type: 'message', status: 'unknown', runId: null, reason: null, createdAt: 0, updatedAt: 0 });
  assert.equal(conversationFeedback(value).uncertain, true);
  assert.equal(conversationFeedback(value).label, '状态待确认');
  assert.equal(conversationFeedback(value).unresolved, true);
});

test('a different terminal run is not mistaken for completion of the accepted message', () => {
  const value = snapshot();
  value.operationState!.latestAcceptedMessage = { id, runId: 'original' };
  value.conversation.state.terminalRunId = 'other';
  assert.equal(conversationFeedback(value).settled, false);
  assert.equal(conversationFeedback(value).label, '等待执行确认');
});

test('cancelling a native promise that never settles releases its UI wait', async () => {
  const controller = new AbortController();
  const task = abortableTask(new Promise<void>(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
});

test('late native completion cannot turn a cancelled operation into success', async () => {
  const controller = new AbortController(); let complete!: (value: string) => void;
  const task = abortableTask(new Promise<string>(resolve => { complete = resolve; }), controller.signal);
  controller.abort(); complete('late result');
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(await abortableTask(Promise.resolve('next result'), new AbortController().signal), 'next result');
});

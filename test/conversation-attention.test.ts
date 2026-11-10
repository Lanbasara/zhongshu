import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, WorkbenchOperation } from '../src/shared/workbench.ts';
import { conversationAttention, stateReasonText, type Attention } from '../src/web/conversation-attention.ts';
import { nativeRunState } from '../src/web/conversation-status.ts';

const conversationId = '11111111-1111-4111-8111-111111111111';
function conversation(state: Partial<Conversation['state']> = {}, rest: { error?: string | null; readiness?: Conversation['readiness'] } = {}): Conversation {
  return {
    id: conversationId, title: '测试对话', harnessId: 'dsh', workspaceId: 'workspace',
    configuration: { modelId: 'model', permissionId: 'permission' },
    readiness: rest.readiness ?? 'ready', archived: false,
    state: { status: 'idle', pendingInputs: 0, configurationVerified: true, ...state },
    error: rest.error === undefined ? null : rest.error, createdAt: 0,
  };
}
let sequence = 0;
function operation(status: WorkbenchOperation['status'], overrides: Partial<WorkbenchOperation> = {}): WorkbenchOperation {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, conversationId,
    status, runId: null, reason: null, createdAt: sequence, updatedAt: sequence, type: 'message', ...overrides,
  };
}
const attentionOf = (conversationValue: Conversation, operations: WorkbenchOperation[] = [], stuckMessage = false): Attention | null =>
  conversationAttention({ conversation: conversationValue, operations, stuckMessage });
/** Detail is the only place a machine code may appear; the title always reads as a state in words. */
function assertWordsOnly(attention: Attention | null): Attention {
  assert.ok(attention);
  assert.ok(attention.title.trim());
  assert.ok(!/^[a-z][a-z0-9_]*$/.test(attention.title));
  return attention;
}

test('ordinary waiting after a send shows no hint', () => {
  // queued and dispatching are normal sends in flight; an accepted message that has just arrived may not have
  // its native run yet either — none of that is something the reader must act on.
  assert.equal(attentionOf(conversation(), [operation('queued'), operation('dispatching')]), null);
  assert.equal(attentionOf(conversation(), [operation('accepted')]), null);
  assert.equal(attentionOf(conversation({ status: 'running', runId: 'run-1' }), [operation('accepted', { runId: 'run-1' })]), null);
});
test('an unverifiable native state is one unknown hint that names the cause and the promise', () => {
  const attention = assertWordsOnly(attentionOf(conversation({ status: 'unknown', reason: 'native_observation_unavailable' }), [operation('unknown')], true));
  assert.equal(attention.tone, 'unknown');
  assert.equal(attention.title, '运行状态暂时无法核实');
  assert.equal(attention.action, 'reconcile');
  assert.match(attention.detail!, /连接中断/);
  assert.match(attention.detail!, /已收到的内容都会保留，消息不会自动重发/);
  assert.match(attention.detail!, /页面打开期间会自动重试/);
  assert.doesNotMatch(attention.detail!, /原因码/);
});
test('every known state reason has words of its own', () => {
  for (const [code, words] of Object.entries(stateReasonText)) {
    const attention = assertWordsOnly(attentionOf(conversation({ status: 'unknown', reason: code })));
    assert.equal(attention.tone, 'unknown', code);
    assert.ok(attention.detail!.includes(words), `${code} should read as its own sentence`);
    assert.doesNotMatch(attention.detail!, /原因码/, `${code} must not fall back to the neutral code sentence`);
  }
});
test('an unrecognised reason code stays neutral and keeps the code in the detail', () => {
  const attention = assertWordsOnly(attentionOf(conversation({ status: 'unknown', reason: 'future_native_loss' })));
  assert.equal(attention.tone, 'unknown');
  assert.match(attention.detail!, /无法识别/);
  assert.match(attention.detail!, /原因码：future_native_loss/);
  assert.doesNotMatch(attention.title, /future_native_loss/);
  assert.doesNotMatch(attention.detail!, /成功/);
});
test('blocked conversation errors say what cannot continue, with their own words', () => {
  const codes = ['conversation_configuration_changed', 'conversation_preparation_incomplete', 'native_creation_result_unknown',
    'native_configuration_unverified', 'workspace_restore_pending', 'workspace_directory_changed', 'workspace_directory_unavailable',
    'workspace_identity_unavailable', 'native_receipt_unknown', 'native_run_changed', 'harness_unavailable'];
  for (const code of codes) {
    const attention = assertWordsOnly(attentionOf(conversation({ status: 'idle', configurationVerified: code !== 'native_configuration_unverified' }, { error: code, readiness: 'blocked' })));
    assert.equal(attention.tone, 'blocked', code);
    assert.ok(attention.detail && attention.detail.length > 10, code);
    assert.doesNotMatch(attention.detail!, /原因码/, `${code} must not fall back to the neutral code sentence`);
    assert.doesNotMatch(attention.detail!, /^[a-z_]+$/, `${code} must not be shown raw`);
  }
  // The two reasons that can be resolved by asking the native side again offer the same lookup action.
  assert.equal(attentionOf(conversation({}, { error: 'native_configuration_unverified', readiness: 'blocked' }))!.action, 'reconcile');
  assert.equal(attentionOf(conversation({}, { error: 'workspace_restore_pending', readiness: 'blocked' }))!.action, 'reconcile');
  assert.equal(attentionOf(conversation({}, { error: 'conversation_configuration_changed', readiness: 'blocked' }))!.action, undefined);
});
test('an unrecognised conversation error is neutral, not a success and not a bare code', () => {
  const attention = assertWordsOnly(attentionOf(conversation({}, { error: 'some_future_block', readiness: 'blocked' })));
  assert.equal(attention.tone, 'blocked');
  assert.match(attention.detail!, /原因码：some_future_block/);
  assert.doesNotMatch(attention.detail!, /成功/);
});
test('a removed workspace keeps its own restore entry and produces no hint', () => {
  assert.equal(attentionOf(conversation({ status: 'idle' }, { error: 'workspace_removed', readiness: 'blocked' }), [operation('unknown')], true), null);
  assert.equal(attentionOf(conversation({ status: 'unknown', reason: 'workspace_removed' }, { error: 'workspace_removed' })), null);
});
test('an operation with an unknown result is a pending hint; ordinary dispatch is not', () => {
  assert.equal(attentionOf(conversation(), [operation('queued'), operation('dispatching'), operation('accepted', { runId: 'run-1' })]), null);
  const attention = assertWordsOnly(attentionOf(conversation(), [operation('unknown')]));
  assert.equal(attention.tone, 'pending');
  assert.equal(attention.action, 'reconcile');
  assert.match(attention.title, /消息/);
  assert.match(attention.detail!, /不会自动重发/);
  // The operation is reconciled on request, not retried on a timer; do not promise a retry.
  assert.doesNotMatch(attention.detail!, /自动重试/);
  const stop = assertWordsOnly(attentionOf(conversation(), [operation('unknown', { type: 'stop' })]));
  assert.match(stop.title, /停止/);
});
test('a message still without a native run only becomes a hint after the delay', () => {
  assert.equal(attentionOf(conversation(), [operation('accepted')], false), null);
  const attention = assertWordsOnly(attentionOf(conversation(), [operation('accepted')], true));
  assert.equal(attention.tone, 'pending');
  assert.equal(attention.action, 'reconcile');
  assert.equal(attention.title, '已发送，正在确认是否开始执行');
  assert.match(attention.detail!, /不会重复发送/);
  // The workbench combines the flag with the settled check, so a settled message never passes `true`.
});
test('the hint priority is: unknown state, then blocked error, then unknown operation, then a stuck message', () => {
  const everything = attentionOf(conversation({ status: 'unknown', reason: 'native_state_unavailable' }, { error: 'workspace_directory_unavailable', readiness: 'blocked' }), [operation('unknown')], true);
  assert.equal(everything!.tone, 'unknown');
  const blockedFirst = attentionOf(conversation({}, { error: 'workspace_directory_unavailable', readiness: 'blocked' }), [operation('unknown')], true);
  assert.equal(blockedFirst!.tone, 'blocked');
  const operationFirst = attentionOf(conversation(), [operation('unknown')], true);
  assert.match(operationFirst!.title, /消息/);
});

test('the native run state handed to the process block follows the verified state only', () => {
  const run = (state: Partial<Conversation['state']>, runId: string) => nativeRunState(conversation(state).state, runId);
  assert.equal(run({ status: 'running', runId: 'run-1' }, 'run-1'), 'running');
  assert.equal(run({ status: 'waiting', runId: 'run-1' }, 'run-1'), 'running');
  assert.equal(run({ status: 'idle', runId: 'run-1' }, 'run-1'), 'completed');
  assert.equal(run({ status: 'failed', runId: 'run-1' }, 'run-1'), 'failed');
  assert.equal(run({ status: 'unknown', runId: 'run-1' }, 'run-1'), 'unknown');
  // A verified terminal state outranks a stale active status.
  assert.equal(run({ status: 'interrupted', runId: 'run-1', terminalRunId: 'run-1', terminalStatus: 'completed' }, 'run-1'), 'completed');
  assert.equal(run({ status: 'idle', terminalRunId: 'run-0', terminalStatus: 'failed' }, 'run-0'), 'failed');
  assert.equal(run({ status: 'idle', latest: { runId: 'run-2', status: 'interrupted' } }, 'run-2'), 'interrupted');
  // A historical turn with no verified terminal state stays neutral.
  assert.equal(run({ status: 'idle' }, 'run-old'), undefined);
  assert.equal(run({ status: 'idle', runId: 'run-1' }, 'run-old'), undefined);
});

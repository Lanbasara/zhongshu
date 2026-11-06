import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapItem, nativeItem } from '../src/harness/codex/protocol.ts';
import { itemFrom, textBlocks } from '../src/harness/dsh/native.ts';

// Shapes follow captured Codex 0.166.0-alpha.5.1 and DSH 0.2.1-rc.4 records (synthetic identities).
const child = '01a1b025-3337-7de3-a97f-e0b95900eede';

test('Codex collaboration records become cards naming child threads; unrelated tools stay notices', () => {
  const started = mapItem(nativeItem.parse({ id: 'a1', type: 'subAgentActivity', kind: 'started', agentThreadId: child, agentPath: '/root/gate_alpha' }), 'turn', '/w');
  assert.deepEqual([started.kind, started.collaboration], ['notice', { action: 'started', agentIds: [child] }]);
  const completed = mapItem(nativeItem.parse({ id: 'a2', type: 'subAgentActivity', kind: 'completed', agentThreadId: child, agentPath: '/root/gate_alpha' }), 'turn', '/w');
  assert.deepEqual(completed.collaboration, { action: 'completed', agentIds: [child] });
  const wait = mapItem(nativeItem.parse({ id: 'w', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress', senderThreadId: 'root', receiverThreadIds: [child], prompt: null }), 'turn', '/w', true);
  assert.deepEqual([wait.status, wait.collaboration], ['running', { action: 'waiting', agentIds: [child] }]);
  const list = mapItem(nativeItem.parse({ id: 'l', type: 'collabAgentToolCall', tool: 'listAgents', status: 'completed', receiverThreadIds: [] }), 'turn', '/w');
  assert.equal(list.collaboration, undefined);
  assert.equal(list.text, '查看子 Agent 列表');
  const unsafe = mapItem(nativeItem.parse({ id: 'u', type: 'subAgentActivity', kind: 'started', agentThreadId: '../x', agentPath: '/root/x' }), 'turn', '/w');
  assert.equal(unsafe.collaboration, undefined, 'unsafe native identities never reach URLs');
});

test('DSH catalog and settlement events become cards; injected context snapshots are not messages', () => {
  const session = 'session-36b3a1df-25fe-45cb-b79c-664511e67f3f';
  const catalog = itemFrom(session, { type: 'subagent/catalog', seq: 12, time: 1, data: { version: 1, childId: '60fbb4f8-b9dd-46c3-a02f-542cf68d1d93', childCreatedAt: 1, mode: 'continuable', label: 'Run gate dalpha' } }, false, 1);
  assert.deepEqual(catalog?.collaboration, { action: 'started', agentIds: ['60fbb4f8-b9dd-46c3-a02f-542cf68d1d93'] });
  const settled = itemFrom(session, { type: 'user/message', seq: 30, time: 2, data: { source: { kind: 'subagent-settled', form: 'notice', summary: 'Run gate dalpha 已完成', senderSessionId: '60fbb4f8-b9dd-46c3-a02f-542cf68d1d93' }, content: [{ type: 'text', text: 'result' }] } }, false, 2);
  assert.deepEqual([settled?.text, settled?.collaboration], ['Run gate dalpha 已完成', { action: 'completed', agentIds: ['60fbb4f8-b9dd-46c3-a02f-542cf68d1d93'] }]);
  const runtime = itemFrom(session, { type: 'user/message', seq: 9, time: 3, data: { source: { kind: 'runtime-context', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'Current runtime context.' }] } });
  assert.equal(runtime, undefined);
});

test('DSH delegated instructions keep their text parts apart', () => {
  assert.deepEqual(textBlocks([{ type: 'text', text: 'Run the gate.' }, { type: 'image' }, { type: 'text', text: '' }, { type: 'text', text: 'Report the exit code.' }]), ['Run the gate.', 'Report the exit code.']);
  assert.deepEqual(textBlocks('not content'), []);
});

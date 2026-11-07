import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyItems, itemFrom, snapshotSchema, usageFrom, type Event } from '../src/harness/dsh/native.ts';

const event = (type: string, seq: number, data: Record<string, unknown>): Event => ({ type, seq, time: seq, data });
test('DSH usage uses complete projections and preserves cumulative counts when context shrinks', () => {
  const tokenUsage = { uncachedInputTokens: 800, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 50 };
  const observe = (contextPressure: unknown, asOfSeq = 2) => usageFrom(snapshotSchema.parse({
    type: 'snapshot', header: { id: 'session' }, cursor: 2, records: [], hasMore: false,
    projections: { asOfSeq, values: { tokenUsage, contextPressure } },
  }));
  assert.deepEqual(observe({ pressureTokens: 600, projectedTokens: 210, contextWindow: 1000 }),
    { total: 1000, context: { used: 210, capacity: 1000, estimated: true } });
  assert.equal(observe({ pressureTokens: 600, contextWindow: 1000 })?.context?.used, 600);
  assert.deepEqual(observe({ pressureTokens: 600 }), { total: 1000 });
  assert.equal(observe({ pressureTokens: 600, contextWindow: 1000 }, 1), undefined);
});
test('DSH producer exit outcome survives tool result and keeps original readable arguments', () => {
  const events = [
    event('tool/call',1,{ turn:1, callId:'missing', name:'bash', arguments:'{"command":"cat missing.txt"}' }),
    event('job/settled',2,{ kind:'bash', producerReported:true, toolCall:{callId:'missing'}, detail:'exit code: 1', status:'completed' }),
    event('tool/result',3,{ turn:1, message:{toolCallId:'missing',isError:false,content:[{type:'text',text:'No such file\n[exit code: 1]'}]} }),
  ];
  const [item] = historyItems('session',events);
  assert.equal(item?.status,'failed');
  assert.deepEqual(item?.tool,{name:'bash',input:'{"command":"cat missing.txt"}',exitCode:1,output:'No such file\n[exit code: 1]'});
  const success = historyItems('session',events.map(e => e.type === 'job/settled' ? {...e,data:{...e.data,detail:'exit code: 0'}} : e));
  assert.equal(success[0]?.status,'completed');
  // A command can print text resembling an error marker. It is not authority.
  const textOnly = historyItems('session',events.filter(e=>e.type!=='job/settled'));
  assert.equal(textOnly[0]?.status,'completed');
  assert.equal(itemFrom('session',event('job/settled',2,{kind:'bash',producerReported:false,toolCall:{callId:'missing'},detail:'exit code: 1'})),undefined);
});
test('DSH PTC: each tool a run_code script calls shows as its own tool step with name, arguments and output', () => {
  const root = 'call_00_root'; const sub = `${root}:ptc:1`;
  const events = [
    event('tool/call', 1, { turn: 1, step: 1, callId: root, name: 'run_code', arguments: { code: 'await tools.bash({ command: "ls" })' } }),
    event('tool/ptc-dispatch-start', 2, { rootCallId: root, parentCallId: root, subCallId: sub, name: 'bash', arguments: { description: 'List files', command: 'ls -la' } }),
    event('tool/ptc-dispatch', 3, { rootCallId: root, parentCallId: root, subCallId: sub, name: 'bash', arguments: { description: 'List files', command: 'ls -la' }, isError: false, content: [{ type: 'text', text: 'total 0\n' }], meta: {} }),
    event('tool/ptc-dispatch', 4, { rootCallId: root, parentCallId: root, subCallId: `${root}:ptc:2`, name: 'glob', arguments: { pattern: '**/*' }, isError: true, content: [{ type: 'text', text: 'denied' }], meta: {} }),
  ];
  const started = itemFrom('session', events[1]!, false, 1);
  assert.equal(started?.id, `dsh:session:tool:${sub}`); assert.equal(started?.status, 'running'); assert.equal(started?.tool?.name, 'bash');
  const done = itemFrom('session', events[2]!, false, 1);
  assert.equal(done?.id, started?.id, 'start and finish are one step');
  assert.deepEqual(done?.tool, { name: 'bash', input: JSON.stringify({ description: 'List files', command: 'ls -la' }), output: 'total 0\n' });
  assert.equal(done?.status, 'completed');
  assert.equal(itemFrom('session', events[3]!, false, 1)?.status, 'failed');
});

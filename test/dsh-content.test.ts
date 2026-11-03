import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyItems, itemFrom, type Event } from '../src/harness/dsh/native.ts';

const event = (type: string, seq: number, data: Record<string, unknown>): Event => ({ type, seq, time: seq, data });
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

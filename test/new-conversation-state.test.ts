import { test } from 'node:test';
import { normalizeDraftPreference } from '../src/web/conversation-configuration-label.ts';
import assert from 'node:assert/strict';
import { initialConversationTitle, readPreference, rememberConversation } from '../src/web/conversation-preferences.ts';
import { emptyNewDraft, readNewDraft, saveNewDraft, removeNewDraft, clearNewDrafts } from '../src/web/new-conversation-state.ts';

// Enumerable keys match browser Storage, including the logout cleanup path.
function storage() {
  const result: Record<string, unknown> = {};
  Object.defineProperties(result, {
    getItem: { value: (key: string) => result[key] ?? null },
    setItem: { value: (key: string, value: string) => { result[key] = String(value); } },
    removeItem: { value: (key: string) => { delete result[key]; } },
  });
  return result as unknown as Storage;
}
function withStorage(run: (local: Storage, session: Storage) => void) {
  const localDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const local = storage(), session = storage();
  Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable:true, value:session });
  try { run(local, session); } finally {
    if (localDescriptor) Object.defineProperty(globalThis, 'localStorage', localDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (sessionDescriptor) Object.defineProperty(globalThis, 'sessionStorage', sessionDescriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}
const preferenceKey = 'zhongshu:conversation-preferences:v1';
const draftKey = 'zhongshu:new-draft:v1:';
const config = { modelId:'native-model', permissionId:'read-only', reasoningEffort:'high' };
const first = { workspaceId:'first', harnessId:'codex' as const, configuration:config };
const second = { workspaceId:'second', harnessId:'dsh' as const, configuration:{ modelId:'dsh-native', permissionId:'ask', reasoningEffort:'off' } };

test('initial title normalizes whitespace, limits Unicode code points without splitting emoji, and handles attachment-only input', () => {
  assert.equal(initialConversationTitle('  第一行\n\t第二行  '), '第一行 第二行');
  assert.equal(initialConversationTitle('文'.repeat(31) + '😀后续'), '文'.repeat(31) + '😀');
  assert.equal(Array.from(initialConversationTitle('😀'.repeat(40))).length, 32);
  assert.equal(initialConversationTitle(' \n\t'), '新对话');
});

test('preferences preserve each workspace and update recent independently', () => withStorage(() => {
  assert.equal(rememberConversation(first), true);
  assert.equal(rememberConversation(second), true);
  assert.deepEqual(readPreference(), second);
  assert.deepEqual(readPreference('first'), first);
  assert.deepEqual(readPreference('second'), second);
  assert.equal(readPreference('unknown'), undefined);
  assert.equal(rememberConversation({ ...first, configuration:{ ...config, reasoningEffort:'low' } }), true);
  assert.equal(readPreference()?.configuration.reasoningEffort, 'low');
  assert.deepEqual(readPreference('second'), second);
}));

test('invalid, oversized, or mismatched preference cache is ignored and corrupt JSON recovers on a successful conversation', () => withStorage(local => {
  for (const raw of ['{broken', JSON.stringify({recent:first,workspaces:{first:{...first,harnessId:'unknown'}}}), 'x'.repeat(262145)]) {
    local.setItem(preferenceKey, raw);
    assert.equal(readPreference('first'), undefined);
  }
  local.setItem(preferenceKey, JSON.stringify({ recent:first, workspaces:{first:second} }));
  assert.equal(readPreference('first'), undefined);
  local.setItem(preferenceKey, '{broken');
  assert.equal(rememberConversation(first), true);
  assert.deepEqual(readPreference('first'), first);
}));

test('fresh draft with incomplete selection survives reload without creating a conversation', () => withStorage(() => {
  const draft = emptyNewDraft('first');
  draft.text = '尚未选择模型，但已有输入';
  assert.equal(saveNewDraft(draft), true);
  assert.deepEqual(readNewDraft('first'), draft);
  assert.equal(readNewDraft('second'), undefined);
  const unassigned = emptyNewDraft('');
  assert.equal(saveNewDraft(unassigned), true);
  assert.deepEqual(readNewDraft(''), unassigned);
}));

test('draft restoration retains references, independent Power choices and accepted submission identity', () => withStorage(() => {
  const draft = emptyNewDraft('first', first);
  draft.text = '继续检查';
  draft.references = [{type:'file',path:'src/main.ts'}];
  draft.powers = { codex:config, dsh:second.configuration };
  draft.submission = {creation:{id:draft.id,workspaceId:'first',harnessId:'codex',configuration:config,title:'继续检查'},operationId:crypto.randomUUID(),uploaded:{},dispatchStarted:true};
  const other = emptyNewDraft('second', second);
  assert.equal(saveNewDraft(draft), true);
  assert.equal(saveNewDraft(other), true);
  assert.deepEqual(readNewDraft('first'), draft);
  assert.deepEqual(readNewDraft('second'), other);
  removeNewDraft('first');
  assert.equal(readNewDraft('first'), undefined);
  assert.deepEqual(readNewDraft('second'), other);
}));

test('draft cache rejects corrupt data and workspace mismatch rather than restoring another workspace content', () => withStorage((_local, session) => {
  const draft = emptyNewDraft('first', first);
  for (const raw of ['{broken', 'x'.repeat(262145), JSON.stringify({...draft,workspaceId:'second'}), JSON.stringify({...draft,text:'x'.repeat(16001)}), JSON.stringify({...draft,skills:[{id:'a'.repeat(64),label:'skill',start:0,end:5}]})]) {
    session.setItem(draftKey+'first',raw);
    assert.equal(readNewDraft('first'),undefined);
  }
}));

test('authentication exit clears drafts and preferences while preserving unrelated browser keys', () => withStorage((local, session) => {
  rememberConversation(first);
  saveNewDraft(emptyNewDraft('first',first));
  saveNewDraft(emptyNewDraft('second',second));
  local.setItem('unrelated','keep'); session.setItem('unrelated','keep');
  clearNewDrafts();
  assert.equal(readPreference(),undefined);
  assert.equal(readNewDraft('first'),undefined);
  assert.equal(readNewDraft('second'),undefined);
  assert.equal(local.getItem('unrelated'),'keep');
  assert.equal(session.getItem('unrelated'),'keep');
}));

test('unavailable browser storage degrades to in-memory behavior without throwing', () => withStorage((local, session) => {
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('Storage disabled');}});
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw new Error('Storage disabled');}});
  assert.equal(readPreference(),undefined);
  assert.equal(rememberConversation(first),false);
  assert.equal(readNewDraft('first'),undefined);
  assert.equal(saveNewDraft(emptyNewDraft('first',first)),false);
  assert.doesNotThrow(()=>removeNewDraft('first'));
  assert.doesNotThrow(()=>clearNewDrafts());
}));

test('legacy DSH browser preference initializes a compatible new draft while preserving original effort and permission', () => withStorage(() => {
  const legacyId = Buffer.from(JSON.stringify({provider:'account',model:'model',reasoningEffort:'high'})).toString('base64url');
  const currentId = Buffer.from(JSON.stringify({provider:'account',model:'model'})).toString('base64url');
  const preference = {...second,configuration:{modelId:legacyId,permissionId:'unchanged-permission',reasoningEffort:'high'}};
  const catalogs = [{id:'dsh' as const,available:true,models:[{id:currentId,label:'Current model',reasoningEfforts:[{id:'high',label:'High'}]}],permissions:[]}];
  rememberConversation(preference);
  const restored = readPreference('second')!;
  const normalized = normalizeDraftPreference(restored,catalogs);
  const draft = emptyNewDraft('second',normalized);
  assert.deepEqual(draft.configuration,{modelId:currentId,permissionId:'unchanged-permission',reasoningEffort:'high'});
  assert.deepEqual(readPreference('second'),preference);
  assert.deepEqual(normalizeDraftPreference(restored,[{...catalogs[0]!,available:false}]),restored);
  assert.deepEqual(normalizeDraftPreference(restored,[{...catalogs[0]!,models:[{...catalogs[0]!.models[0]!,reasoningEfforts:[{id:'low',label:'Low'}]}]}]),restored);
  assert.deepEqual(normalizeDraftPreference({...restored,configuration:{...restored.configuration,reasoningEffort:'low'}},catalogs).configuration.modelId,legacyId);
}));


test('frozen submission cannot restore with a different conversation identity or configuration', () => withStorage((_local, session) => {
  const draft = emptyNewDraft('first', first);
  const creation = {id:draft.id,workspaceId:'first',harnessId:'codex',configuration:config,title:'first'};
  for (const wrong of [{...creation,id:crypto.randomUUID()}, {...creation,workspaceId:'second'}, {...creation,configuration:{...config,reasoningEffort:'low'}}]) {
    session.setItem(draftKey+'first',JSON.stringify({...draft,submission:{creation:wrong,operationId:crypto.randomUUID(),uploaded:{},dispatchStarted:false}}));
    assert.equal(readNewDraft('first'),undefined);
  }
}));

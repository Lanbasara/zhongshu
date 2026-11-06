import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationConfigurationLabel } from '../src/web/conversation-configuration-label.ts';
import type { WorkbenchConfiguration } from '../src/shared/workbench.ts';
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const modelId = encoded({provider:'provider',model:'原生模型'});
const catalogs: WorkbenchConfiguration['harnesses'] = [{id:'dsh',available:true,models:[{id:modelId,label:'模型展示名',reasoningEfforts:[{id:'high',label:'High'}]}],permissions:[]}];
test('existing conversation displays fixed effort from catalog without changing saved configuration',()=>{
  const conversation = {harnessId:'dsh' as const,configuration:{modelId,permissionId:'read',reasoningEffort:'high'}};
  const before = structuredClone(conversation);
  assert.deepEqual(conversationConfigurationLabel(conversation,catalogs),{model:'模型展示名',reasoningEffort:'High'});
  assert.deepEqual(conversation,before);
});
test('legacy DSH IDs display catalog model and embedded effort, including Unicode',()=>{
  const legacy = encoded({provider:'provider',model:'原生模型',reasoningEffort:'high'});
  assert.deepEqual(conversationConfigurationLabel({harnessId:'dsh',configuration:{modelId:legacy,permissionId:'read'}},catalogs),{model:'模型展示名',reasoningEffort:'High'});
  assert.deepEqual(conversationConfigurationLabel({harnessId:'dsh',configuration:{modelId:legacy,permissionId:'read'}},[]),{model:'原生模型',reasoningEffort:'high'});
});
test('invalid legacy model never exposes its encoded identifier as a display label',()=>{
  for (const modelId of ['not-json',encoded({model:'model'}),encoded({provider:42,model:'model'}),'A'.repeat(2049)]) {
    assert.deepEqual(conversationConfigurationLabel({harnessId:'dsh',configuration:{modelId,permissionId:'read'}}),{model:'配置按对话固定',reasoningEffort:undefined});
  }
});

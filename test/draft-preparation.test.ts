import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/server/database.ts';
import { productMigrations } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { Workbench } from '../src/server/workbench.ts';
import type { Binding, HarnessAdapter } from '../src/harness/types.ts';

const configuration = { modelId: 'model', permissionId: 'read-only' };
const idle = { status: 'idle' as const, pendingInputs: 0, configurationVerified: true };

test('prepared slots are bounded, opaque, durable, workspace-bound and atomically claimed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zh-draft-'));
  const db = openDatabase(root, productMigrations);
  t.after(() => { db.close(); rmSync(root,{recursive:true,force:true}); });
  const store = createWorkbenchStore(db);
  const first = store.reservePreparation('a', '/a', randomUUID());
  assert.notEqual(first.preparationId, first.nativeId);
  for (let i=0;i<20;i++) assert.deepEqual(store.reservePreparation('a','/a',randomUUID()),first);
  assert.deepEqual(createWorkbenchStore(db).reservePreparation('a','/a',randomUUID(),first.preparationId),first);
  assert.throws(()=>store.reservePreparation('a','/elsewhere',randomUUID()),/draft_preparation_workspace_changed/);
  const input = {id:randomUUID(),harnessId:'dsh' as const,workspaceId:'a',cwd:'/a',configuration,preparationId:first.preparationId};
  const created=store.createConversation(input);
  assert.equal(created.conversation.nativePreparationId,first.nativeId);
  assert.equal(store.createConversation(input).created,false);
  const other=randomUUID();
  assert.throws(()=>store.createConversation({...input,id:other}),/draft_preparation_claimed/);
  assert.equal(store.getConversation(other),null);
  assert.throws(()=>store.reservePreparation('a','/a',randomUUID(),first.preparationId),/draft_preparation_claimed/);
  const second=store.reservePreparation('a','/a',randomUUID());
  assert.notEqual(second.nativeId,first.nativeId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workbench_draft_preparations').get()!.n,1);
  assert.equal(store.createConversation(input).created,false);
  assert.throws(()=>store.createConversation({...input,preparationId:second.preparationId}),/conversation_id_conflict/);
});

test('preparation failure and app restart recover exact identity, configure only on first send', async t => {
  const root=mkdtempSync(join(tmpdir(),'zh-draft-'));
  const db=openDatabase(root,productMigrations); const store=createWorkbenchStore(db);
  const native=new Map<string,{cwd:string;configured:boolean}>();
  let fail=true; let configurations=0;
  const adapter: HarnessAdapter = {
    id:'dsh', async catalog(){return{id:'dsh',available:true,models:[{id:'model',label:'model'}],permissions:[{id:'read-only',label:'read-only',description:''}]};},
    async prepareDraft(input){native.set(input.id,{cwd:input.cwd,configured:false}); if(fail){fail=false;throw Error('lost response');} return [];},
    async create(input,onBound){assert.ok(input.preparedId);assert.equal(native.get(input.preparedId)?.cwd,input.cwd); configurations++;
      const binding:Binding={id:input.preparedId,cwd:input.cwd,configuration:input.configuration,details:{}};onBound(binding);return binding;},
    async state(){return idle;},async history(){return{items:[],olderCursor:null};},async submit(){throw Error('must not send');},async reconcile(){return{outcome:'unknown',reason:'none'};},async stop(){throw Error('must not stop');},async watch(){return()=>{};},async close(){},
  };
  let service=new Workbench(store,[{id:'a',directory:'/a',label:'A'}],new Map([['dsh',adapter]]));
  t.after(async()=>{await service.close();db.close();rmSync(root,{recursive:true,force:true});});
  await assert.rejects(service.prepareDraft('a','dsh'),/draft_preparation_unavailable/);
  assert.equal(native.size,1);assert.equal(configurations,0);assert.equal(store.listConversations().length,0);
  await service.close();service=new Workbench(createWorkbenchStore(db),[{id:'a',directory:'/a',label:'A'}],new Map([['dsh',adapter]]));
  const prepared=await service.prepareDraft('a','dsh');assert.equal(native.size,1);
  const id=randomUUID();const input={id,harnessId:'dsh' as const,workspaceId:'a',configuration,preparationId:prepared.preparationId};
  await service.create(input);
  for(let i=0;i<100 && store.getConversation(id)?.readiness!=='ready';i++)await delay(10);
  assert.equal(store.getConversation(id)?.binding?.id,[...native.keys()][0]);
  assert.equal(store.getConversation(id)?.readiness,'ready');assert.equal(configurations,1);
  await service.create(input);assert.equal(configurations,1);
});

test('a claimed preparation survives configuration failure and resumes without replacing native identity', async t => {
  const root=mkdtempSync(join(tmpdir(),'zh-draft-'));const db=openDatabase(root,productMigrations);const store=createWorkbenchStore(db);
  let configurationAttempts=0;let preparedCalls=0;let fail=true;const bindings:Binding[]=[];
  const adapter:HarnessAdapter={id:'dsh',async catalog(){return{id:'dsh',available:true,models:[{id:'model',label:'model'}],permissions:[{id:'read-only',label:'read-only',description:''}]};},
    async prepareDraft(){preparedCalls++;return[];},async create(input,onBound){configurationAttempts++;assert.ok(input.preparedId);const binding={id:input.preparedId,cwd:input.cwd,configuration:input.configuration,details:{}};bindings.push(binding);onBound(binding);if(fail){fail=false;throw Error('configure unavailable');}return binding;},
    async state(){return idle;},async history(){return{items:[],olderCursor:null};},async submit(){throw Error('not sent');},async reconcile(){return{outcome:'unknown',reason:'none'};},async stop(){throw Error('not stopped');},async watch(){return()=>{};},async close(){}};
  let service=new Workbench(store,[{id:'a',directory:'/a',label:'A'}],new Map([['dsh',adapter]]));
  t.after(async()=>{await service.close();db.close();rmSync(root,{recursive:true,force:true});});
  const prep=await service.prepareDraft('a','dsh');const id=randomUUID();
  await service.create({id,harnessId:'dsh',workspaceId:'a',configuration,preparationId:prep.preparationId});
  for(let i=0;i<100 && store.getConversation(id)?.readiness!=='blocked';i++)await delay(10);
  const failed=store.getConversation(id)!;assert.equal(failed.readiness,'blocked');assert.ok(failed.nativePreparationId);assert.equal(failed.binding?.id,failed.nativePreparationId);
  await service.close();service=new Workbench(createWorkbenchStore(db),[{id:'a',directory:'/a',label:'A'}],new Map([['dsh',adapter]]));await service.start();
  for(let i=0;i<100 && store.getConversation(id)?.readiness!=='ready';i++)await delay(10);
  assert.equal(store.getConversation(id)?.readiness,'ready');assert.equal(store.getConversation(id)?.nativePreparationId,undefined);
  assert.equal(preparedCalls,1);assert.equal(configurationAttempts,2);assert.equal(bindings[0]!.id,bindings[1]!.id);
});

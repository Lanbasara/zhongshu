import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, backupDatabase, restoreDatabase } from '../src/server/database.ts';
import { productMigrations, afterProductRestore } from '../src/server/migrations.ts';
import { createWorkbenchStore } from '../src/server/workbench-store.ts';
import { createAuth } from '../src/server/auth.ts';
import { buildApp } from '../src/server/app.ts';
import { Workbench } from '../src/server/workbench.ts';
import { createWorkbenchHttp } from '../src/server/workbench-http.ts';
import { decodeImage, workspacePath, workspaceFiles } from '../src/server/resources.ts';
import { itemSchema, enqueueOperationSchema } from '../src/shared/workbench.ts';
import type { HarnessAdapter } from '../src/harness/types.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==','base64');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(),'zhongshu-resource-'));
  const db = openDatabase(join(root,'data'),productMigrations);
  const store = createWorkbenchStore(db); const id = randomUUID();
  store.createConversation({ id, harnessId:'codex', workspaceId:'test', cwd:root, configuration:{modelId:'model',permissionId:'write'} });
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
  return {root,db,store,id};
}

test('image resources are scoped, pinned with immutable operations and included in backup/restore',async t=>{
  const {root,db,store,id}=await fixture(t);
  const image=store.resources.put(id,'sample.png',png);
  assert.deepEqual(store.resources.get(id,image.id).data,png);
  assert.throws(()=>store.resources.get(randomUUID(),image.id));
  const operation={id:randomUUID(),conversationId:id,type:'message' as const,payload:{text:'',images:[image]}};
  store.enqueueOperation(operation);
  assert.equal(store.enqueueOperation(operation).created,false);
  assert.throws(()=>store.enqueueOperation({...operation,payload:{text:'changed',images:[image]}}));
  store.resources.remove(id,image.id);
  assert.deepEqual(store.resources.get(id,image.id).data,png);
  const unused=store.resources.put(id,'unused.png',Buffer.concat([png,Buffer.from('unused')]));
  db.prepare('UPDATE workbench_resources SET created_at=0').run();
  store.resources.put(id,'new.png',Buffer.concat([png,Buffer.from('new')]));
  assert.throws(()=>store.resources.get(id,unused.id));
  assert.deepEqual(store.resources.get(id,image.id).data,png);
  store.mergeHistory(id,[{id:'native-image',kind:'assistant',text:'',status:'completed',images:[image]}]);
  assert.deepEqual(store.readHistory(id).items[0]?.images,[image]);
  const backup=join(root,'backup.sqlite');await backupDatabase(db,backup);
  const target=join(root,'restored');await restoreDatabase(backup,target,afterProductRestore);
  const restored=openDatabase(target,productMigrations);
  try{const read=createWorkbenchStore(restored);assert.deepEqual(read.resources.get(id,image.id).data,png);assert.deepEqual(read.readHistory(id).items[0]?.images,[image]);}finally{restored.close();}
});

test('resource HTTP keeps authentication, CSRF, content limits and conversation ownership',async t=>{
  const {db,store,id}=await fixture(t);const origin='https://resource.example';
  const auth=createAuth(db);await auth.initialize('synthetic-test-password-123');
  const workbench=new Workbench(store,[],new Map());const transport=createWorkbenchHttp(workbench);
  const app=await buildApp({db,origin,privateRoutes:transport.routes});
  t.after(async()=>{transport.close();await workbench.close();await app.close();});
  const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{password:'synthetic-test-password-123'}});
  const cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');const csrf=login.json().csrfToken;
  const url='/api/private/workbench/conversations/'+id+'/resources';
  const body={name:'sample.png',data:png.toString('base64')};
  assert.equal((await app.inject({method:'POST',url,headers:{origin},payload:body})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url,headers:{origin,cookie},payload:body})).statusCode,403);
  const response=await app.inject({method:'POST',url,headers:{origin,cookie,'x-csrf-token':csrf},payload:body});assert.equal(response.statusCode,200);
  const resource=response.json();const read=url+'/'+resource.id;
  assert.equal((await app.inject({url:read})).statusCode,401);
  const valid=await app.inject({url:read,headers:{cookie}});assert.equal(valid.statusCode,200);assert.deepEqual(valid.rawPayload,png);assert.equal(valid.headers['content-type'],'image/png');
  const foreign=read.replace(id,randomUUID());assert.equal((await app.inject({url:foreign,headers:{cookie}})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url,headers:{origin,cookie,'x-csrf-token':csrf},payload:{name:'x.svg',data:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}})).statusCode,400);
  const revoked=await app.inject({method:'POST',url:'/api/private/logout',headers:{origin,cookie,'x-csrf-token':csrf},payload:{}});assert.equal(revoked.statusCode,200);
  assert.equal((await app.inject({url:read,headers:{cookie}})).statusCode,401);
});

test('workspace references reject traversal and symlinks and retain original-file semantics',async t=>{
  const {root}=await fixture(t);const work=join(root,'work');await mkdir(work);await writeFile(join(work,'a.txt'),'old');
  await writeFile(join(root,'outside.txt'),'synthetic-outside');await symlink(join(root,'outside.txt'),join(work,'escape.txt'));
  assert.deepEqual((await workspaceFiles(work,'')).map(f=>f.name),['a.txt']);
  await assert.rejects(workspacePath(work,'../outside.txt'));await assert.rejects(workspacePath(work,'escape.txt'));
  const path=await workspacePath(work,'a.txt');await writeFile(path,'new');assert.equal(await workspacePath(work,'a.txt'),path);
  await assert.rejects(workspacePath(work,'missing.txt'));
  assert.throws(()=>decodeImage('not-an-image'));
  assert.equal(enqueueOperationSchema.safeParse({id:randomUUID(),type:'message',payload:{text:'',references:[{type:'file',path:'a.txt'}]}}).success,true);
  assert.equal(enqueueOperationSchema.safeParse({id:randomUUID(),type:'message',payload:{text:''}}).success,false);
  assert.equal(itemSchema.safeParse({id:'x',kind:'assistant',text:'',status:'completed',imageSources:[{path:'/secret'}]}).success,false);
});

test('Markdown workspace images use the native reader and pin per-message snapshots without a host file proxy',async t=>{
  const {root,store,id}=await fixture(t);await writeFile(join(root,'plot.png'),png);
  const config={modelId:'model',permissionId:'write'};
  store.saveBinding(id,{id:'native-test',cwd:root,configuration:config,details:{}});
  store.mergeHistory(id,[{id:'plot-message',kind:'assistant',text:'![Plot](plot.png)',status:'completed'}]);
  let reads=0;
  const canonicalImage = await realpath(join(root,'plot.png'));
  const adapter: HarnessAdapter={id:'codex',catalog:async()=>({id:'codex',available:true,models:[],permissions:[]}),create:async()=>{throw Error('unused');},state:async()=>({status:'idle',pendingInputs:0,configurationVerified:true}),history:async()=>({items:[],olderCursor:null}),submit:async()=>({outcome:'unknown',reason:'unused'}),reconcile:async()=>({outcome:'unknown',reason:'unused'}),stop:async()=>({outcome:'unknown',reason:'unused'}),watch:async()=>()=>{},close:async()=>{},readImage:async(_binding,path)=>{assert.equal(path,canonicalImage);reads++;return png.toString('base64');}};
  const workbench=new Workbench(store,[{id:'test',label:'Test',directory:root}],new Map([['codex',adapter]]));t.after(()=>workbench.close());
  const image=await workbench.workspaceImage(id,'plot-message','plot.png');assert.deepEqual(image.data,png);assert.equal(reads,1);
  await rm(join(root,'plot.png'));assert.deepEqual((await workbench.workspaceImage(id,'plot-message','plot.png')).data,png);assert.equal(reads,1);
  store.mergeHistory(id,[{id:'bad-message',kind:'assistant',text:'![Bad](../outside.png)',status:'completed'}]);
  await assert.rejects(workbench.workspaceImage(id,'bad-message','../outside.png'));assert.equal(reads,1);
  await assert.rejects(workbench.workspaceImage(id,'plot-message','another.png'));assert.equal(reads,1);
});

test('workspace documents enforce auth, CSRF, registered roots, format and path boundaries', async t => {
  const { root, db, store } = await fixture(t);
  const work = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-documents-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, 'notes.md'), '# Original');
  await writeFile(join(work, 'report.html'), '<h1>Report</h1>');
  await writeFile(join(work, 'sample.tsx'), 'export const sample = <strong>Source</strong>;');
  await writeFile(join(root, 'outside.txt'), 'synthetic canary');
  await symlink(join(root, 'outside.txt'), join(work, 'escape.txt'));
  const origin = 'https://documents.example';
  const password = 'synthetic-test-password-123';
  await createAuth(db).initialize(password);
  const workbench = new Workbench(store, [{ id: 'documents', label: 'Documents', directory: work, managedWrites: true }], new Map());
  const transport = createWorkbenchHttp(workbench);
  const app = await buildApp({ db, origin, privateRoutes: transport.routes });
  t.after(async () => { transport.close(); await workbench.close(); await app.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { password } });
  const cookie = login.cookies.map(c => c.name + '=' + c.value).join('; ');
  const headers = { cookie, origin, 'x-csrf-token': login.json().csrfToken };
  const url = '/api/private/workbench/workspaces/documents/file';
  const read = (path: string) => app.inject({ url: url + '?path=' + encodeURIComponent(path), headers });
  assert.equal((await app.inject({ url: url + '?path=notes.md' })).statusCode, 401);
  assert.equal((await read('../outside.txt')).statusCode, 403);
  assert.equal((await read('escape.txt')).statusCode, 409);
  assert.equal((await app.inject({ url: url.replace('/documents/', '/unregistered/') + '?path=notes.md', headers })).statusCode, 404);
  const report = await read('report.html');
  assert.equal(report.json().kind, 'html');
  assert.match(String(report.headers['content-type']), /^application\/json/);
  const update = (path: string, version: string, requestHeaders = headers) =>
    app.inject({ method: 'POST', url, headers: requestHeaders, payload: { path, version, text: 'changed' } });
  assert.equal((await update('report.html', report.json().version)).statusCode, 403);
  const source = (await read('sample.tsx')).json();
  assert.equal(source.kind, 'source');
  assert.equal(source.text, 'export const sample = <strong>Source</strong>;');
  assert.equal((await update('sample.tsx', source.version)).json().error, 'file_read_only');
  const original = await read('notes.md');
  assert.equal((await update('notes.md', original.json().version, { ...headers, 'x-csrf-token': '' })).statusCode, 403);
  assert.equal((await update('notes.md', original.json().version)).statusCode, 200);
  assert.equal((await read('notes.md')).json().text, 'changed');
});

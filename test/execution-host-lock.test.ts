import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireExecutionFileLock } from '../src/server/execution-host-lock.ts';

test('Linux owner lock survives helper exit until the actual descriptor owner exits', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zh-owner-lock-')); const path = join(root, 'owner.lock');
  const script = join(root, 'owner.mjs'); await writeFile(script, `import { acquireExecutionFileLock } from ${JSON.stringify(new URL('../src/server/execution-host-lock.ts', import.meta.url).href)};\nconst lock=await acquireExecutionFileLock(process.argv[2]);process.send({ready:true});setInterval(()=>lock.assertOwned(),1000);`);
  const child = fork(script, [path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('exit', () => reject(new Error('owner exited before ready'))); });
  await assert.rejects(acquireExecutionFileLock(path), { code: 'execution_host_owned' });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  const recovered = await acquireExecutionFileLock(path); recovered.assertOwned(); await recovered.close();
});

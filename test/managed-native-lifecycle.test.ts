import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { superviseManagedNativeChild } from '../src/server/managed-harness-server.ts';

test('unexpected native process death triggers bounded owner failure even when cleanup hangs', async t => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  t.after(() => { child.kill(); });
  let finish!: () => void; const cleanup = new Promise<void>(resolve => { finish = resolve; });
  let notices = 0; const started = Date.now();
  let failed!: () => void; const failure = new Promise<void>(resolve => { failed = resolve; });
  superviseManagedNativeChild(child, () => cleanup, () => { notices++; failed(); });
  await once(child, 'exit'); await failure;
  assert.ok(Date.now() - started < 6500, 'dead native cannot leave an indefinitely live RPC container');
  finish(); await delay(20); assert.equal(notices, 1);
});

test('intentional native stop is not reported as a crash and fast crash cleanup reports once', async t => {
  const intentional = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const unexpected = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  t.after(() => { intentional.kill(); unexpected.kill(); });
  let notices = 0;
  const disarm = superviseManagedNativeChild(intentional, async () => {}, () => { notices++; });
  let failed!: () => void; const failure = new Promise<void>(resolve => { failed = resolve; });
  superviseManagedNativeChild(unexpected, async () => {}, () => { notices++; failed(); });
  disarm(); intentional.kill(); await Promise.all([once(intentional, 'exit'), failure]);
  assert.equal(notices, 1, 'an unrequested exit code zero is still native service loss');
});

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

export async function pausedWriter(t: TestContext, dataDirectory: string, stage: 'intent' | 'renamed' | 'recorded') {
  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL('./workspace-writer-process.ts', import.meta.url))], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, WORKSPACE_WRITER_TEST_STAGE: stage } });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = once(child, 'message'); child.send({ type: 'initialize', dataDirectory });
  const [message] = await ready; assert.equal(message.type, 'ready');
  return { ownerId: String(message.ownerId), child, exited, write: async (input: unknown) => {
    const reached = once(child, 'message'); child.send({ type: 'request', id: 1, method: 'write', input });
    const [event] = await reached; assert.equal(event.type, 'test-stage'); assert.equal(event.stage, stage);
  } };
}


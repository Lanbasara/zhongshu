import { serveWorkspaceWriter } from '../../src/server/workspace-writer-worker.ts';

// Test-only crash barrier; production starts the same implementation without a
// callback and has no request/environment switch for pausing file effects.
const barrier = process.env.WORKSPACE_WRITER_TEST_STAGE;
if (!['intent', 'renamed', 'recorded'].includes(barrier ?? '')) throw new Error('invalid_test_barrier');
await serveWorkspaceWriter({ onStage: async (stage, saveId) => {
  if (stage !== barrier) return;
  process.send?.({ type: 'test-stage', stage, saveId });
  await new Promise<void>(() => {});
} });

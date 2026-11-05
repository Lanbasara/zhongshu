/** Browser fixture for the real editing coordinator and file writer. Only the
 * native processes/controller are synthetic; this is not containment evidence. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { HarnessAdapter, HarnessId, NativeChange } from '../../src/harness/types.ts';
import type { ExecutionController, ExecutionControllerMutation, ExecutionGroupState } from '../../src/server/execution-controller.ts';
import { ManagedWorkspaceExecution } from '../../src/server/execution-workspaces.ts';
import type { StorageClient } from '../../src/server/storage-client.ts';
import type { ManagedWorkbenchOptions } from '../../src/server/workbench.ts';
import { WorkspaceFileWriter } from '../../src/server/workspace-writer.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function managedUiFixture(storage: StorageClient, db: DatabaseSync, root: string,
  adapters: Map<HarnessId, HarnessAdapter>, busy: (id: HarnessId) => boolean): ManagedWorkbenchOptions {
  db.exec('CREATE TABLE IF NOT EXISTS fixture_hosts (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS fixture_receipts (id TEXT PRIMARY KEY, signature TEXT NOT NULL, body TEXT NOT NULL) STRICT');
  const groups = [...adapters].map(([id, adapter]) => {
    const groupId = 'fixture-' + id;
    const listeners = new Set<(change: NativeChange) => void>();
    const initial: ExecutionGroupState = { groupId, generation: randomUUID(), epoch: 0, admission: 'open', writers: 'running', durable: true };
    db.prepare('INSERT OR IGNORE INTO fixture_hosts VALUES (?, ?)').run(groupId, JSON.stringify(initial));
    const state = () => JSON.parse(String(db.prepare('SELECT body FROM fixture_hosts WHERE id=?').get(groupId)!.body)) as ExecutionGroupState;
    async function mutation(action: 'fence' | 'quiesce' | 'resume', input: Omit<ExecutionControllerMutation, 'frozenSetId'> & { frozenSetId?: string }) {
      const signature = digest([groupId, action, input]);
      const prior = db.prepare('SELECT signature,body FROM fixture_receipts WHERE id=?').get(input.requestId);
      if (prior) return prior.signature === signature ? { status: 'known' as const, state: JSON.parse(String(prior.body)) as ExecutionGroupState } : { status: 'unknown' as const, reason: 'controller_unknown' as const };
      const current = state();
      if (current.generation !== input.expected.generation || current.epoch !== input.expected.epoch || action === 'quiesce' && busy(id))
        return { status: 'unknown' as const, reason: 'controller_unknown' as const };
      const next: ExecutionGroupState = { ...current, epoch: current.epoch + 1, admission: action === 'resume' ? 'open' : action === 'fence' ? 'drain' : 'closed',
        writers: action === 'quiesce' ? 'quiescent' : 'running', frozenSetId: action === 'resume' ? undefined : input.frozenSetId };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE fixture_hosts SET body=? WHERE id=?').run(JSON.stringify(next), groupId);
        db.prepare('INSERT INTO fixture_receipts VALUES (?, ?, ?)').run(input.requestId, signature, JSON.stringify(next)); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (action === 'quiesce') for (const listener of listeners) listener({ type: 'unavailable', reason: 'managed_native_disconnected' });
      return { status: 'known' as const, state: next };
    }
    const controller: ExecutionController = { inspect: async () => ({ status: 'known', state: state() }),
      fence: input => mutation('fence', input), quiesce: input => mutation('quiesce', input), resume: input => mutation('resume', input) };
    adapters.set(id, { ...adapter,
      state: (binding, target) => { if (state().admission === 'closed') throw new Error('fixture_host_stopped'); return adapter.state(binding, target); },
      watch: async (binding, listener) => { listeners.add(listener); const stop = await adapter.watch(binding, listener); return () => { listeners.delete(listener); stop(); }; },
    });
    return { groupId, harnessId: id, workspaceIds: ['a', 'b'], workspaceRootIds: ['fixture-root'], conflicts: ['fixture-' + (id === 'codex' ? 'dsh' : 'codex')], controller };
  });
  return {
    execution: new ManagedWorkspaceExecution({ port: storage.execution, workspaces: storage.workspaces, groups }),
    writer: new WorkspaceFileWriter({ dataDirectory: join(root, 'data/workspace-writer') }),
    managedAdapter: async (conversation, adapter, context) => ({ ...adapter,
      state: async (binding, target) => {
        const wireDigest = digest(['state', binding.id, target ?? null]);
        if (context?.baseline) await storage.execution.registerBaselineObservation({ ...context.baseline, conversationId: conversation.id, wireDigest });
        else if (context?.admissionId) await storage.execution.bindObservationRequest({ admissionId: context.admissionId, requestId: randomUUID(), wireDigest });
        else await storage.execution.registerObservation({ requestId: randomUUID(), workspaceId: conversation.workspaceId, conversationId: conversation.id, bindingId: binding.id, wireDigest });
        return adapter.state(binding, target);
      },
      submit: async (binding, input) => { await storage.execution.bindNativeRequest(input.id, digest(['submit', binding.id, input])); return adapter.submit(binding, input); },
    }),
  };
}

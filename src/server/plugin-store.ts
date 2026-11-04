import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { pluginCommand, pluginHarness, pluginOperation, pluginStatus, pluginSourceCommand, pluginSourceOperation, type PluginCommand, type PluginHarness, type PluginSourceCommand } from '../shared/plugins.ts';
import { StoreError } from './workbench-store.ts';
import { createExecutionPluginHooks } from './execution-store.ts';
import { createCapacityGuard, type CapacityOptions } from './storage-capacity.ts';

const rowSchema = pluginOperation.safeExtend({ harness: pluginHarness }).strict();
export type StoredPluginOperation = z.infer<typeof rowSchema>;
const sourceRowSchema = pluginSourceOperation.extend({ harness: pluginHarness }).strict();
export type StoredPluginSourceOperation = z.infer<typeof sourceRowSchema>;
export function createPluginStore(db: DatabaseSync, capacity?: CapacityOptions) {
  const guard = createCapacityGuard(db, capacity);
  function sourceRow(row: Record<string, unknown> | undefined): StoredPluginSourceOperation | undefined {
    return row ? sourceRowSchema.parse({ requestId: row.id, harness: row.harness, command: JSON.parse(String(row.command_json)), status: row.status }) : undefined;
  }
  function findSource(id: string) { z.uuid().parse(id); return sourceRow(db.prepare('SELECT * FROM plugin_source_operations WHERE id=?').get(id)); }
  function currentSource(harness: PluginHarness) {
    pluginHarness.parse(harness);
    return sourceRow(db.prepare("SELECT * FROM plugin_source_operations WHERE harness=? AND status IN ('applying','unknown') LIMIT 1").get(harness) ?? db.prepare('SELECT * FROM plugin_source_operations WHERE harness=? ORDER BY sequence DESC LIMIT 1').get(harness));
  }
  const execution = createExecutionPluginHooks(db);
  function find(id: string): StoredPluginOperation | undefined {
    z.uuid().parse(id);
    const row = db.prepare('SELECT id,harness,plugin_id AS pluginId,action,status,version FROM plugin_operations WHERE id=?').get(id);
    return row ? rowSchema.parse({ ...row, version: row.version ?? undefined }) : undefined;
  }
  function current(harness: PluginHarness): StoredPluginOperation | undefined {
    pluginHarness.parse(harness);
    const row = db.prepare("SELECT id,harness,plugin_id AS pluginId,action,status,version FROM plugin_operations WHERE harness=? AND status IN ('applying','unknown','restart-required') LIMIT 1").get(harness) ??
      db.prepare('SELECT id,harness,plugin_id AS pluginId,action,status,version FROM plugin_operations WHERE harness=? ORDER BY sequence DESC LIMIT 1').get(harness);
    return row ? rowSchema.parse({ ...row, version: row.version ?? undefined }) : undefined;
  }
  return {
    find, current, findSource, currentSource,
    recoverSources() { return Number(db.prepare("UPDATE plugin_source_operations SET status='unknown' WHERE status='applying'").run().changes); },
    claimSource(harness: PluginHarness, requestId: string, input: PluginSourceCommand): { operation: StoredPluginSourceOperation; created: boolean } {
      pluginHarness.parse(harness); z.uuid().parse(requestId); const command = pluginSourceCommand.parse(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = findSource(requestId);
        if (old) {
          if (old.harness !== harness || JSON.stringify(old.command) !== JSON.stringify(command)) throw new StoreError('operation_id_conflict', 409);
          db.exec('COMMIT'); return { operation: old, created: false };
        }
        const active = current(harness); const source = currentSource(harness);
        if (active && ['applying','unknown','restart-required'].includes(active.status) || source && ['applying','unknown'].includes(source.status)) throw new StoreError('plugin_operation_in_progress', 409);
        if (find(requestId)) throw new StoreError('operation_id_conflict', 409);
        guard.assertWritable('admission', 32768);
        db.prepare("INSERT INTO plugin_source_operations(id,harness,command_json,status) VALUES(?,?,?,'applying')").run(requestId, harness, JSON.stringify(command));
        execution.claim({ operationId: requestId, harnessId: harness, kind: 'source', command });
        const operation = findSource(requestId)!; db.exec('COMMIT'); return { operation, created: true };
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    settleSource(id: string, status: 'unknown' | 'applied' | 'failed') {
      z.uuid().parse(id); pluginSourceOperation.shape.status.exclude(['applying']).parse(status);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE plugin_source_operations SET status=? WHERE id=? AND status IN ('applying','unknown')").run(status, id);
        execution.settle({ operationId: id, status }); db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    recoverApplying() { return Number(db.prepare("UPDATE plugin_operations SET status='unknown' WHERE status='applying'").run().changes); },
    claim(harness: PluginHarness, input: PluginCommand): { operation: StoredPluginOperation; created: boolean } {
      pluginHarness.parse(harness); const command = pluginCommand.parse(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = find(command.id);
        if (existing) {
          if (existing.harness !== harness || existing.pluginId !== command.pluginId || existing.action !== command.action || existing.version !== command.version)
            throw new StoreError('operation_id_conflict', 409);
          db.exec('COMMIT'); return { operation: existing, created: false };
        }
        const active = current(harness);
        const source = currentSource(harness);
        if (findSource(command.id)) throw new StoreError('operation_id_conflict', 409);
        if (source && ['applying', 'unknown'].includes(source.status)) throw new StoreError('plugin_operation_in_progress', 409);
        if (active && ['applying', 'unknown', 'restart-required'].includes(active.status)) throw new StoreError('plugin_operation_in_progress', 409);
        guard.assertWritable('admission', 32768);
        db.prepare("INSERT INTO plugin_operations(id,harness,plugin_id,action,status,version) VALUES(?,?,?,?,'applying',?)")
          .run(command.id, harness, command.pluginId, command.action, command.version ?? null);
        execution.claim({ operationId: command.id, harnessId: harness, kind: 'plugin', command });
        const operation = find(command.id)!;
        db.exec('COMMIT'); return { operation, created: true };
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* caller must reconcile an unknown storage result */ } throw error; }
    },
    settle(id: string, status: Exclude<z.infer<typeof pluginStatus>, 'applying'>): void {
      z.uuid().parse(id); pluginStatus.exclude(['applying']).parse(status);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE plugin_operations SET status=? WHERE id=? AND status IN ('applying','unknown','restart-required')").run(status, id);
        execution.settle({ operationId: id, status });
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
  };
}
export type PluginStore = ReturnType<typeof createPluginStore>;
export type AsyncPluginStore = { [K in keyof PluginStore]: (...args: Parameters<PluginStore[K]>) => Promise<ReturnType<PluginStore[K]>> };

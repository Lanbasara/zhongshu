import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { pluginCommand, pluginHarness, pluginOperation, type PluginCommand, type PluginHarness, type PluginOperation, type PluginView } from '../shared/plugins.ts';
import type { PluginBackend, PluginResult } from './plugin-backend.ts';

const row = pluginOperation.extend({ harness: pluginHarness }).strict();
const pathSchema = z.object({ harness: pluginHarness }).strict();
const recoverySchema = z.object({ id: z.uuid() }).strict();

export function createPluginManagement(db: DatabaseSync, backends: Partial<Record<PluginHarness, PluginBackend>>) {
  db.exec("UPDATE plugin_operations SET status='unknown' WHERE status='applying'");
  let closed = false;
  const recovering = new Set<PluginHarness>();

  function find(id: string) {
    const result = db.prepare('SELECT id, harness, plugin_id AS pluginId, action, status FROM plugin_operations WHERE id=?').get(id);
    return result ? row.parse(result) : undefined;
  }
  function current(harness: PluginHarness) {
    const result = db.prepare(`SELECT id, harness, plugin_id AS pluginId, action, status FROM plugin_operations
      WHERE harness=? ORDER BY (status IN ('applying','unknown','restart-required')) DESC, sequence DESC LIMIT 1`).get(harness);
    return result ? row.parse(result) : undefined;
  }
  function present(operation: z.infer<typeof row> | undefined): PluginOperation | null {
    if (!operation) return null;
    const { harness: _harness, ...value } = operation;
    return value;
  }
  function finish(id: string, status: PluginResult) {
    if (!closed) db.prepare('UPDATE plugin_operations SET status=? WHERE id=?').run(status, id);
  }
  async function view(harness: PluginHarness): Promise<PluginView> {
    const backend = backends[harness];
    if (!backend) return { availability: 'unconfigured', entries: [], operation: present(current(harness)) };
    try {
      const entries = await backend.list();
      const operation = current(harness);
      return {
        availability: 'available',
        operation: present(operation),
        entries: entries.map(entry => operation?.status === 'restart-required' && operation.pluginId === entry.id
          ? { ...entry, application: 'restart-required', actions: [] }
          : entry),
      };
    } catch {
      return { availability: 'offline', entries: [], operation: present(current(harness)) };
    }
  }

  async function dispatch(harness: PluginHarness, command: PluginCommand, backend: PluginBackend) {
    let status: PluginResult = 'unknown';
    try { status = await backend.change(command); } catch { /* Native result can be unknown. */ }
    finish(command.id, status);
    return { harness, status };
  }
  async function routes(app: FastifyInstance) {
    app.get('/plugins/:harness', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      return await view(params.data.harness);
    });
    app.post('/plugins/:harness/operations', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      const input = pluginCommand.safeParse(request.body);
      if (!params.success || !input.success) return reply.code(400).send({ error: 'invalid_request' });
      const { harness } = params.data;
      const command = input.data;
      const backend = backends[harness];
      const duplicate = () => {
        const existing = find(command.id);
        if (!existing) return false;
        if (existing.harness !== harness || existing.pluginId !== command.pluginId || existing.action !== command.action)
          return reply.code(409).send({ error: 'operation_id_conflict' });
        return reply.code(202).send(present(existing));
      };
      if (duplicate()) return reply;
      if (!backend || closed) return reply.code(503).send({ error: 'plugin_management_unavailable' });
      const snapshot = await view(harness);
      if (duplicate()) return reply;
      if (closed || snapshot.availability !== 'available') return reply.code(503).send({ error: 'plugin_management_unavailable' });
      const inFlight = current(harness);
      if ((inFlight && ['applying', 'unknown', 'restart-required'].includes(inFlight.status)) || recovering.has(harness))
        return reply.code(409).send({ error: 'plugin_operation_in_progress' });
      if (!snapshot.entries.find(entry => entry.id === command.pluginId)?.actions.includes(command.action))
        return reply.code(403).send({ error: 'plugin_action_forbidden' });
      db.prepare("INSERT INTO plugin_operations(id,harness,plugin_id,action,status) VALUES(?,?,?,?,'applying')")
        .run(command.id, harness, command.pluginId, command.action);
      void dispatch(harness, command, backend).then(result => {
        request.log.info({ event: 'plugin_operation_settled', operationId: command.id, harness: result.harness, outcome: result.status });
      }).catch(() => request.log.error({ event: 'plugin_operation_persistence_failed', operationId: command.id, harness }));
      return reply.code(202).send(present(find(command.id)));
    });
    app.post('/plugins/:harness/reconcile', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      const input = recoverySchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.code(400).send({ error: 'invalid_request' });
      const { harness } = params.data;
      const backend = backends[harness];
      const operation = find(input.data.id);
      if (!operation || operation.harness !== harness) return reply.code(404).send({ error: 'not_found' });
      if (!backend || closed) return reply.code(503).send({ error: 'plugin_management_unavailable' });
      if (recovering.has(harness)) return reply.code(409).send({ error: 'plugin_operation_in_progress' });
      if (operation.status === 'unknown' || operation.status === 'restart-required') {
        const newest = current(harness);
        if (newest && newest.id !== operation.id && ['applying', 'unknown'].includes(newest.status))
          return reply.code(409).send({ error: 'plugin_operation_in_progress' });
        recovering.add(harness);
        try {
          const status = await backend.recover({ id: operation.id, pluginId: operation.pluginId, action: operation.action });
          if (status !== 'unknown') finish(operation.id, status);
        } catch { /* Keep the last verified state. */ }
        finally { recovering.delete(harness); }
      }
      return present(find(operation.id));
    });
  }

  return {
    routes,
    close: async () => {
      closed = true;
      await Promise.allSettled(Object.values(backends).map(backend => backend?.close?.()));
    },
  };
}

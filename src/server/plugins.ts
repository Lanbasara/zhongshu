import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { pluginCommand, pluginHarness, pluginKey, pluginSourceRequest, type PluginCommand, type PluginHarness, type PluginOperation, type PluginView } from '../shared/plugins.ts';
import { PluginSourceError, type PluginBackend, type PluginResult } from './plugin-backend.ts';
import { createPluginStore, type AsyncPluginStore, type StoredPluginOperation } from './plugin-store.ts';
import { StoreError } from './workbench-store.ts';
import { StorageClientError } from './storage-client.ts';
import { githubIndex, githubRepository } from './plugin-sources.ts';

const pathSchema = z.object({ harness: pluginHarness }).strict();
const recoverySchema = z.object({ id: z.uuid() }).strict();

export function createPluginManagement(input: DatabaseSync | AsyncPluginStore, backends: Partial<Record<PluginHarness, PluginBackend>>) {
  const store = 'prepare' in input ? createPluginStore(input) : input;
  const ready = Promise.resolve().then(async () => { await store.recoverApplying(); await store.recoverSources(); });
  void ready.catch(() => {});
  let closed = false;
  const tasks = new Set<Promise<unknown>>();
  const executing = new Set<string>();
  const recovering = new Set<PluginHarness>();
  const admitting = new Map<PluginHarness, { id: string; done: Promise<void> }>();
  const editingSources = new Set<PluginHarness>();

  const find = async (id: string) => { await ready; return await store.find(id); };
  const current = async (harness: PluginHarness) => { await ready; return await store.current(harness); };
  function present(operation: StoredPluginOperation | undefined): PluginOperation | null {
    if (!operation) return null;
    const { harness: _harness, ...value } = operation;
    return value;
  }
  async function finish(id: string, status: PluginResult) {
    await store.settle(id, status);
  }
  async function view(harness: PluginHarness): Promise<PluginView> {
    const backend = backends[harness];
    const source = await store.currentSource(harness);
    const sourceOperation = source ? { requestId: source.requestId, command: source.command, status: source.status } : null;
    if (!backend) return { availability: 'unconfigured', entries: [], sourceOperation, operation: present((await current(harness))) };
    try {
      const { entries, sources } = backend.catalog ? await backend.catalog() : {
        entries: await backend.list(), sources: await backend.sources?.().catch(() => undefined),
      };
      const operation = (await current(harness));
      return {
        availability: 'available', sourceOperation,
        operation: present(operation),
        sources,
        entries: entries.map(entry => operation?.status === 'restart-required' && operation.pluginId === entry.id
          ? { ...entry, application: 'restart-required', actions: [] }
          : entry),
      };
    } catch {
      return { availability: 'offline', entries: [], sourceOperation, operation: present((await current(harness))), sources: await backend.sources?.().catch(() => undefined) };
    }
  }

  async function dispatch(harness: PluginHarness, command: PluginCommand, backend: PluginBackend) {
    executing.add(command.id);
    try {
      let status: PluginResult = 'unknown';
      try { status = await backend.change(command); } catch { /* Native result can be unknown. */ }
      await finish(command.id, status);
      return { harness, status };
    } finally { executing.delete(command.id); }
  }
  async function routes(app: FastifyInstance) {
    await ready;
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof StoreError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(503).send({ error: 'plugin_management_unavailable' });
    });
    app.get('/plugins/:harness', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      return await view(params.data.harness);
    });
    app.get('/plugins/:harness/detail', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      const query = z.object({ id: pluginKey }).strict().safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_request' });
      const backend = backends[params.data.harness];
      if (!backend) return reply.code(503).send({ error: 'plugin_management_unavailable' });
      try {
        const entry = backend.detail ? await backend.detail(query.data.id) :
          (await backend.list()).find(item => item.id === query.data.id);
        return entry ?? reply.code(404).send({ error: 'not_found' });
      } catch { return reply.code(503).send({ error: 'plugin_management_unavailable' }); }
    });
    app.post('/plugins/:harness/operations', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      const input = pluginCommand.safeParse(request.body);
      if (!params.success || !input.success) return reply.code(400).send({ error: 'invalid_request' });
      const { harness } = params.data;
      const command = input.data;
      const backend = backends[harness];
      const duplicate = async () => {
        const existing = (await find(command.id));
        if (!existing) return false;
        if (existing.harness !== harness || existing.pluginId !== command.pluginId || existing.action !== command.action || existing.version !== command.version)
          { reply.code(409).send({ error: 'operation_id_conflict' }); return true; }
        reply.code(202).send(present(existing)); return true;
      };
      if ((await duplicate())) return reply;
      const pending = admitting.get(harness);
      if (pending) {
        if (pending.id !== command.id) return reply.code(409).send({ error: 'plugin_operation_in_progress' });
        await pending.done;
        if (await duplicate()) return reply;
        return reply.code(503).send({ error: 'plugin_management_unavailable' });
      }
      if (editingSources.has(harness) || recovering.has(harness)) return reply.code(409).send({ error: 'plugin_operation_in_progress' });
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      admitting.set(harness, { id: command.id, done });
      try {
        if (!backend || closed) return reply.code(503).send({ error: 'plugin_management_unavailable' });
        const snapshot = await view(harness);
        if ((await duplicate())) return reply;
        if (closed || snapshot.availability !== 'available') return reply.code(503).send({ error: 'plugin_management_unavailable' });
        const inFlight = (await current(harness));
        if ((inFlight && ['applying', 'unknown', 'restart-required'].includes(inFlight.status)) || recovering.has(harness) || editingSources.has(harness))
          return reply.code(409).send({ error: 'plugin_operation_in_progress' });
        const entry = snapshot.entries.find(entry => entry.id === command.pluginId);
        if (!entry?.actions.includes(command.action) ||
          command.action === 'install' && entry.installed && (!command.version || entry.version === command.version) ||
          command.version && !entry.releases?.some(release => release.version === command.version && release.installable))
          return reply.code(403).send({ error: 'plugin_action_forbidden' });
        const claimed = await store.claim(harness, command);
        if (!claimed.created) return reply.code(202).send(present(claimed.operation));
        if (closed) { await finish(command.id, 'unknown'); return reply.code(503).send({ error: 'plugin_management_unavailable' }); }
        const task = dispatch(harness, command, backend).then(result => {
          request.log.info({ event: 'plugin_operation_settled', operationId: command.id, harness: result.harness, outcome: result.status });
        }).catch(() => request.log.error({ event: 'plugin_operation_persistence_failed', operationId: command.id, harness }));
        tasks.add(task); void task.finally(() => tasks.delete(task));
        return reply.code(202).send(present((await find(command.id))));
      } catch (error) {
        if (error instanceof StorageClientError && (error.outcome === 'unknown' || error.outcome === 'committed')) { try { await store.settle(command.id, 'unknown'); } catch { /* retain original unknown storage outcome */ } }
        throw error;
      } finally { admitting.delete(harness); release(); }
    });
    app.post('/plugins/:harness/sources', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      const input = pluginSourceRequest.safeParse(request.body);
      if (!params.success || !input.success) return reply.code(400).send({ error: 'invalid_request' });
      const { harness } = params.data; const { requestId, command } = input.data;
      const old = await store.findSource(requestId);
      if (old) {
        if (old.harness !== harness || JSON.stringify(old.command) !== JSON.stringify(command)) return reply.code(409).send({ error: 'operation_id_conflict' });
        return reply.code(202).send(await view(harness));
      }
      if (command.action === 'add') {
        try {
          if (harness === 'codex') {
            githubRepository(command.source);
            if (command.ref && !/^(?!.*(?:\.\.|\/\/))[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/.test(command.ref)) throw new PluginSourceError('invalid_plugin_source');
          } else { githubIndex(command.source); if (command.ref) throw new PluginSourceError('invalid_plugin_source'); }
        } catch { return reply.code(400).send({ error: 'invalid_plugin_source' }); }
      }
      const backend = backends[harness];
      if (!backend?.updateSource || closed) return reply.code(503).send({ error: 'plugin_management_unavailable' });
      if (editingSources.has(harness) || recovering.has(harness) || admitting.has(harness)) return reply.code(409).send({ error: 'plugin_operation_in_progress' });
      editingSources.add(harness);
      try {
        const claimed = await store.claimSource(harness, requestId, command);
        if (claimed.created) {
          executing.add(requestId);
          const task = (async () => {
            let status: 'applied' | 'failed' | 'unknown' = 'unknown';
            try { await backend.updateSource!(command, requestId); status = 'applied'; }
            catch (error) { if (error instanceof PluginSourceError) status = 'failed'; }
            await store.settleSource(requestId, status);
          })().finally(() => { executing.delete(requestId); editingSources.delete(harness); });
          tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task));
        } else editingSources.delete(harness);
        return reply.code(202).send(await view(harness));
      } catch (error) {
        if (error instanceof StorageClientError && (error.outcome === 'unknown' || error.outcome === 'committed')) { try { await store.settleSource(requestId, 'unknown'); } catch { /* retain original unknown storage outcome */ } }
        editingSources.delete(harness); throw error;
      }
    });
    app.post('/plugins/:harness/sources/reconcile', async (request, reply) => {
      const params = pathSchema.safeParse(request.params); const input = recoverySchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.code(400).send({ error: 'invalid_request' });
      const { harness } = params.data; const backend = backends[harness];
      const operation = await store.findSource(input.data.id);
      if (!operation || operation.harness !== harness) return reply.code(404).send({ error: 'not_found' });
      if (!backend || closed) return reply.code(503).send({ error: 'plugin_management_unavailable' });
      if (executing.has(operation.requestId) || editingSources.has(harness) || recovering.has(harness) || admitting.has(harness)) return reply.code(409).send({ error: 'plugin_operation_in_progress' });
      recovering.add(harness);
      try {
        if (['applying','unknown'].includes(operation.status)) {
          const status = await backend.recoverSource?.(operation.command, operation.requestId).catch(() => 'unknown' as const) ?? 'unknown';
          await store.settleSource(operation.requestId, status);
        }
        return await view(harness);
      } finally { recovering.delete(harness); }
    });
    app.post('/plugins/:harness/reconcile', async (request, reply) => {
      const params = pathSchema.safeParse(request.params);
      const input = recoverySchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.code(400).send({ error: 'invalid_request' });
      const { harness } = params.data;
      const backend = backends[harness];
      if (!backend || closed) return reply.code(503).send({ error: 'plugin_management_unavailable' });
      if (recovering.has(harness) || editingSources.has(harness) || admitting.has(harness)) return reply.code(409).send({ error: 'plugin_operation_in_progress' });
      recovering.add(harness);
      try {
        let operation = await find(input.data.id);
        if (!operation || operation.harness !== harness) return reply.code(404).send({ error: 'not_found' });
        if (operation.status === 'applying' && !executing.has(operation.id)) {
          // A lost claim receipt may have committed without native dispatch.
          // Explicit reconciliation may inspect it, but never redispatch it.
          await finish(operation.id, 'unknown'); operation = { ...operation, status: 'unknown' };
        }
        if (operation.status === 'unknown' || operation.status === 'restart-required') {
          const newest = await current(harness);
          if (newest && newest.id !== operation.id && ['applying', 'unknown'].includes(newest.status))
            return reply.code(409).send({ error: 'plugin_operation_in_progress' });
          try {
            const status = await backend.recover({ id: operation.id, pluginId: operation.pluginId, action: operation.action, version: operation.version });
            if (status !== 'unknown') await finish(operation.id, status);
          } catch { /* Keep the last verified state. */ }
        }
        return present(await find(operation.id));
      } finally { recovering.delete(harness); }
    });
  }

  return {
    routes, ready,
    close: async () => {
      closed = true;
      await Promise.allSettled(Object.values(backends).map(backend => backend?.close?.()));
      await Promise.allSettled([...tasks]);
    },
  };
}

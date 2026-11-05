import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { conversationManagementSchema, conversationSearchSchema, createConversationSchema, enqueueOperationSchema, identifierSchema, queueCommandSchema, workbenchConfigurationSchema,
  workspaceAddSchema, workspaceBrowseSchema, workspaceDirectoryListSchema, workspaceIdSchema, workspaceManagementSchema } from '../shared/workbench.ts';
import type { Conversation as ConversationView, WorkbenchOperation, WorkbenchSnapshot } from '../shared/workbench.ts';
import type { PrivateContext } from './app.ts';
import type { Workbench } from './workbench.ts';
import type { NativeItem } from '../harness/types.ts';
import { bodyFieldSchema } from '../shared/content.ts';
import { StoreError, type Conversation, type Operation, type WorkbenchChange } from './workbench-store.ts';
import { decodeImage, ResourceError } from './resources.ts';
import { textLimit, validateWorkspaceText } from './workspace-documents.ts';
import { imageSchema, skillCatalogSchema } from '../shared/content.ts';
import { DirectoryIndexError } from './directory-index.ts';

const uuidParams = z.object({ id: z.uuid() }).strict();
const workspaceParams = z.object({ id: workspaceIdSchema }).strict();
const documentPath = z.string().min(1).max(1024);
const noQuery = z.object({}).strict();
const listQuery = z.object({ beforeId: z.uuid().optional() }).strict();
const olderQuery = z.object({ beforeItemId: identifierSchema.optional() }).strict();
const cursorSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).refine(Number.isSafeInteger);
const eventsQuery = z.object({ cursor: cursorSchema.optional(), navigation: z.literal('1').optional() }).strict();
const directoryPageOptions = z.object({ cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(100).optional(), refresh: z.boolean().optional() });
const optionsSchema = z.object({
  heartbeatMs: z.number().int().min(20).max(30_000).default(15_000),
  slowClientMs: z.number().int().min(100).max(30_000).default(5000),
  maxConnections: z.number().int().min(1).max(32).default(16),
  maxConnectionsPerSession: z.number().int().min(1).max(8).default(8),
}).strict();
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 128 * 1024;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StoreError('invalid_request', 400);
  return parsed.data;
}
function conversationView(value: Conversation): ConversationView {
  return { id: value.id, title: value.title, harnessId: value.harnessId, workspaceId: value.workspaceId, archived: value.archived,
    configuration: value.configuration, readiness: value.readiness, state: value.state, error: value.error, createdAt: value.createdAt };
}
function operationView(value: Operation): WorkbenchOperation {
  const common = { id: value.id, conversationId: value.conversationId, status: value.status, runId: value.runId,
    reason: value.reason, createdAt: value.createdAt, updatedAt: value.updatedAt };
  return { ...common, type: value.type, ...(value.type === 'message' && value.queuedInput ? { delivery: value.queuedInput.delivery } : {}) };
}
function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function itemView(item: NativeItem) { const { sourceRevision: _sourceRevision, ...view } = item; return view; }
function newestWithin<T>(values: T[], budget: number, newestFirst = false): T[] {
  const kept: T[] = [];
  for (const value of newestFirst ? values : values.toReversed()) {
    budget -= size(value) + 1; if (budget < 0) break; kept.push(value);
  }
  return newestFirst ? kept : kept.reverse();
}
function snapshotView(value: Awaited<ReturnType<Workbench['snapshot']>>): WorkbenchSnapshot {
  const { history } = value;
  const conversation = conversationView(value.conversation);
  const operations = newestWithin(value.operations, 16 * 1024, true);
  const { queue } = value;
  const summaries = new Map(value.turnFiles.map(summary => [summary.runId, summary]));
  // Account for escaped UTF-8 JSON and associated file descriptors before
  // selecting a contiguous suffix. Repeated run descriptors are overestimated.
  let remaining = MAX_SNAPSHOT_BYTES - size({ conversation, operations, queue, operationState: value.operationState }) - 4096;
  const select = (source: NativeItem[], budget: number, limit: number) => {
    const kept: ReturnType<typeof itemView>[] = [];
    for (const raw of source.toReversed()) {
      if (kept.length >= limit) break;
      const item = itemView(raw); const summary = item.runId ? summaries.get(item.runId) : undefined;
      const bytes = size(item) + (summary ? size(summary) : 0) + 4;
      if (bytes > budget) break;
      budget -= bytes; remaining -= bytes; kept.push(item);
    }
    return kept.reverse();
  };
  const items = select(history.items, Math.floor(remaining * (history.liveItems.length ? 0.75 : 1)), 50 - Math.min(history.liveItems.length, 16));
  const liveItems = select(history.liveItems, remaining, 50 - items.length);
  const runs = new Set([...items, ...liveItems].flatMap(item => item.runId ? [item.runId] : []));
  const turnFiles = value.turnFiles.filter(summary => runs.has(summary.runId));
  const trimmed = items.length < history.items.length;
  const hasOlder = trimmed || Boolean(history.olderBeforeItemId || history.nativeOlderCursor);
  const progress = (kind: 'latest' | 'backfill') => {
    const job = value.archive.find(job => job.kind === kind);
    return job ? { complete: !job.working && !job.coverageError && !job.error && (kind === 'latest' ? job.cursor === null && job.lastSuccessAt !== null && job.updatesComplete === true : job.complete),
      error: job.error ?? job.coverageError, lastSuccessAt: kind === 'latest' && job.updatesLastSuccessAt !== undefined
        ? job.lastSuccessAt === null || job.updatesLastSuccessAt === null ? null : Math.min(job.lastSuccessAt, job.updatesLastSuccessAt) : job.lastSuccessAt, pages: job.pages } : null;
  };
  const result = { conversation, operationState: value.operationState, archive: { latest: progress('latest'), backfill: progress('backfill') }, history: {
    items, liveItems, liveItemsLimited: history.liveItemsLimited || liveItems.length < history.liveItems.length, loaded: history.historyLoaded,
    olderBeforeItemId: hasOlder ? (trimmed ? items[0]?.id : history.olderBeforeItemId) ?? items[0]?.id ?? null : null, hasOlder,
  }, operations, queue, ...(turnFiles.length ? { turnFiles } : {}), ...(value.conversation.usage ? { usage: value.conversation.usage } : {}), revision: value.revision };
  if (size(result) > MAX_SNAPSHOT_BYTES) throw new StoreError('snapshot_budget_exceeded', 503);
  return result;
}
function json(reply: FastifyReply, value: unknown): FastifyReply {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new StoreError('response_too_large', 413);
  return reply.type('application/json; charset=utf-8').send(body);
}

type Connection = {
  response: ServerResponse; sessionId: string; token: string; context: PrivateContext; cursor: number; navigation: boolean;
  closed: boolean; blocked: boolean; pumping?: boolean; again?: boolean; heartbeating?: boolean; timeout?: NodeJS.Timeout; scheduled?: NodeJS.Immediate; drain: () => void;
};

/** One authenticated event stream per page. Durable cursors replace an in-memory replay queue. */
export function createWorkbenchHttp(workbench: Workbench, input: Partial<z.input<typeof optionsSchema>> = {}) {
  const options = optionsSchema.parse(input);
  const connections = new Set<Connection>();
  let closed = false;

  function disconnect(connection: Connection, destroy = true): void {
    if (connection.closed) return;
    connection.closed = true; connections.delete(connection);
    if (connection.timeout) clearTimeout(connection.timeout);
    if (connection.scheduled) clearImmediate(connection.scheduled);
    connection.response.off('drain', connection.drain);
    connection.token = '';
    if (destroy) connection.response.destroy();
  }
  async function authorized(connection: Connection): Promise<boolean> {
    if (connection.closed) return false;
    try {
      if ((await connection.context.auth.authenticate(connection.token))?.id === connection.sessionId && !connection.closed) return true;
    } catch { /* fail closed, including database shutdown */ }
    disconnect(connection); return false;
  }
  function write(connection: Connection, frame: string): boolean {
    if (connection.closed || connection.blocked) return false;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || connection.response.writableLength > MAX_BUFFER_BYTES) { disconnect(connection); return false; }
    try {
      if (!connection.response.write(frame)) {
        connection.blocked = true;
        connection.timeout = setTimeout(() => disconnect(connection), options.slowClientMs).unref();
      }
      if (connection.response.writableLength > MAX_BUFFER_BYTES) disconnect(connection);
      return !connection.closed;
    } catch { disconnect(connection); return false; }
  }
  function event(connection: Connection, name: string, value: unknown, cursor?: number): boolean {
    return write(connection, `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  function schedule(connection: Connection): void {
    if (closed || connection.closed || connection.blocked || connection.scheduled) return;
    if (connection.pumping) { connection.again = true; return; }
    connection.scheduled = setImmediate(() => { connection.scheduled = undefined; void pump(connection); });
  }
  async function pump(connection: Connection): Promise<void> {
    if (closed || connection.closed || connection.blocked || connection.pumping) return;
    connection.pumping = true;
    try {
      if (!await authorized(connection)) return;
      const batch = (await workbench.store.changes(connection.cursor, 64));
      if (!await authorized(connection)) return;
      if (batch.reset) {
        if (event(connection, 'reset', { type: 'reset', revision: batch.latest }, batch.latest)) connection.cursor = batch.latest;
        return;
      }
      for (const change of batch.events) {
        const value: { type: 'change'; revision: number; conversationId: string; navigation?: { workspaceId: string; version: string }; item?: Awaited<ReturnType<Workbench['store']['getItem']>> } = {
          type: 'change', revision: change.sequence, conversationId: change.conversationId,
        };
        if (connection.navigation) {
          // Archive progress, bodies and usage are not sidebar changes. This
          // bounded local metadata read never activates a native conversation.
          const row = await workbench.store.getConversation(change.conversationId);
          if (row) value.navigation = { workspaceId: row.workspaceId, version: createHash('sha256')
            .update(JSON.stringify([row.title, row.workspaceId, row.harnessId, row.archived, row.readiness, row.state.status, row.createdAt])).digest('hex') };
        }
        if (change.itemId) {
          const item = (await workbench.store.getItem(change.conversationId, change.itemId));
          // Large bodies use the same invalidation + snapshot path, never fragmented deltas.
          if (item && Buffer.byteLength(item.text) <= MAX_FRAME_BYTES) {
            value.item = itemView(item);
            if (size(value) > MAX_FRAME_BYTES - 256) delete value.item;
          }
        }
        if (!await authorized(connection) || !event(connection, 'change', value, change.sequence)) return;
        connection.cursor = change.sequence;
        if (connection.blocked) return;
      }
      if (connection.cursor < batch.latest) schedule(connection);
    } catch { disconnect(connection); }
    finally {
      connection.pumping = false;
      if (connection.again) { connection.again = false; schedule(connection); }
    }
  }
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (connection.heartbeating) continue;
      connection.heartbeating = true;
      void (async () => {
        try { if (await authorized(connection) && !connection.blocked) { event(connection, 'heartbeat', {}); schedule(connection); } }
        finally { connection.heartbeating = false; }
      })();
    }
  }, options.heartbeatMs).unref();
  function close(): void { if (closed) return; closed = true; clearInterval(heartbeat); for (const connection of [...connections]) disconnect(connection); }
  function logout(sessionId: string): void { for (const connection of [...connections]) if (connection.sessionId === sessionId) disconnect(connection); }
  function changed(_change: WorkbenchChange): void { for (const connection of connections) schedule(connection); }
  function invalidate(): void { for (const connection of connections) schedule(connection); }

  async function routes(app: FastifyInstance, context: PrivateContext): Promise<void> {
    // This plugin is installed inside buildApp's authenticated/CSRF-protected scope.
    await app.register(async privateApp => {
      privateApp.addHook('preClose', async () => close());
      privateApp.setErrorHandler((error, _request, reply) => {
        if (error instanceof StoreError && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)) return reply.code(error.statusCode).send({ error: error.code });
        if (error instanceof ResourceError) return reply.code(error.statusCode).send({ error: error.message });
        if (error instanceof DirectoryIndexError) return reply.code(error.statusCode).send({ error: error.code });
        const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
        const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
        if (status === 500) privateApp.log.error({ event: 'workbench_request_failed' });
        return reply.code(status).send({ error: status === 500 ? 'workbench_unavailable' : 'invalid_request' });
      });
      privateApp.get('/configuration', async (request, reply) => {
        parse(noQuery, request.query);
        const result = workbenchConfigurationSchema.parse({ harnesses: await workbench.catalogs(), ...await workbench.workspaceView() });
        return json(reply, result);
      });
      privateApp.get('/capacity', async (request, reply) => {
        parse(noQuery, request.query); return json(reply, await workbench.store.capacity());
      });
      privateApp.get('/workspaces', async (request, reply) => {
        const input = parse(z.object({ cursor: z.string().min(1).max(4096).optional(), query: z.string().max(200).optional(),
          removed: z.enum(['0', '1']).optional().transform(value => value === '1') }).strict(), request.query);
        return json(reply, await workbench.workspacePage(input));
      });
      privateApp.get('/workspaces/:id', async (request, reply) => {
        parse(noQuery, request.query); const { id } = parse(workspaceParams, request.params);
        return json(reply, { workspace: await workbench.workspaceMetadata(id) });
      });
      privateApp.post('/workspace-directories', { bodyLimit: 8192 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { rootId, path, ...options } = parse(workspaceBrowseSchema.extend(directoryPageOptions.shape).strict(), request.body);
        return json(reply, await workbench.browseWorkspaceRoot(rootId, path, options));
      });
      privateApp.post('/workspaces', { bodyLimit: 8192 }, async (request, reply) => {
        parse(noQuery, request.query);
        const id = await workbench.addWorkspace(parse(workspaceAddSchema, request.body));
        privateApp.log.info({ event: 'workspace_registration_changed', action: 'add' });
        return json(reply, { id });
      });
      privateApp.post('/workspaces/:id/manage', { bodyLimit: 4096 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { id } = parse(workspaceParams, request.params);
        const input = parse(workspaceManagementSchema, request.body);
        await workbench.manageWorkspace(id, input);
        privateApp.log.info({ event: 'workspace_registration_changed', action: input.action });
        return json(reply, { id });
      });
      privateApp.get('/conversations', async (request, reply) => {
        const query = parse(listQuery, request.query);
        const values = (await workbench.store.listConversations({ ...query, limit: 51 }));
        const conversations = newestWithin(values.slice(0, 50).map(conversationView), MAX_SNAPSHOT_BYTES - 1024, true);
        return json(reply, { conversations, olderBeforeId: values.length > conversations.length ? conversations.at(-1)!.id : null, revision: (await workbench.store.version()) });
      });
      // Titles stay in the body, outside request URL logs.
      privateApp.post('/conversation-search', { bodyLimit: 4096 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { unregistered, ...query } = parse(conversationSearchSchema, request.body);
        const limit = query.workspaceId || unregistered ? 6 : 30;
        const page = await workbench.store.searchConversations({ ...query, limit: unregistered ? 100 : limit });
        let values: Conversation[] = page.entries;
        let olderBeforeId = page.beforeId;
        if (unregistered) {
          values = [];
          const registered = new Map<string, boolean>();
          let consumed = 0;
          for (const conversation of page.entries) {
            let known = registered.get(conversation.workspaceId);
            if (known === undefined) { known = await workbench.isRegisteredWorkspace(conversation.workspaceId); registered.set(conversation.workspaceId, known); }
            consumed++;
            if (!known) values.push(conversation);
            if (values.length === limit) break;
          }
          if (consumed < page.entries.length) olderBeforeId = page.entries[consumed - 1]!.id;
        }
        // Labels belong to this result page, not the browser's first workspace
        // page. Reserve room for at most 30 bounded IDs/labels and look up only
        // those distinct workspaces through their primary keys.
        const conversations = newestWithin(values.map(conversationView), MAX_SNAPSHOT_BYTES - 64 * 1024, true);
        if (conversations.length < values.length) olderBeforeId = conversations.at(-1)?.id ?? query.beforeId ?? null;
        const workspaceLabels: { id: string; label: string }[] = [];
        for (const id of new Set(conversations.map(value => value.workspaceId))) {
          try { const workspace = await workbench.workspaceMetadata(id); workspaceLabels.push({ id, label: workspace.label }); }
          catch (error) { if (!(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404)) throw error; }
        }
        const result = { conversations, workspaceLabels, olderBeforeId, scanned: page.scanned, scanLimited: !!olderBeforeId && conversations.length < limit, revision: await workbench.store.version() };
        if (size(result) > MAX_SNAPSHOT_BYTES) throw new StoreError('snapshot_budget_exceeded', 503);
        return json(reply, result);
      });
      privateApp.post('/conversations/:id/manage', { bodyLimit: 4096 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { id } = parse(uuidParams, request.params);
        const body = parse(conversationManagementSchema, request.body);
        const conversation = body.action === 'rename' ? (await workbench.store.renameConversation(id, body.title)) :
          await workbench.setArchived(id, body.archived);
        return json(reply, { conversation: conversationView(conversation) });
      });
      privateApp.post('/conversations', async (request, reply) => {
        parse(noQuery, request.query);
        const conversation = await workbench.create(parse(createConversationSchema, request.body));
        return json(reply.code(202), { conversation: conversationView(conversation) });
      });
      privateApp.get('/conversations/:id', async (request, reply) => {
        parse(noQuery, request.query); const { id } = parse(uuidParams, request.params);
        return json(reply, snapshotView(await workbench.open(id)));
      });
      privateApp.get('/conversations/:id/skills', async (request, reply) => {
        parse(noQuery, request.query);
        const { id } = parse(uuidParams, request.params);
        return json(reply, skillCatalogSchema.parse({ skills: await workbench.skills(id) }));
      });
      privateApp.get('/conversations/:id/queue/:entry', async (request, reply) => {
        const { id, entry } = parse(z.object({ id: z.uuid(), entry: z.uuid() }).strict(), request.params);
        const { version } = parse(z.object({ version: cursorSchema }).strict(), request.query);
        return json(reply, await workbench.store.readQueueEntry(id, entry, version));
      });
      privateApp.get('/conversations/:id/turn-files', async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        const { run, after } = parse(z.object({ run: identifierSchema, after: z.string().min(1).max(1024).optional() }).strict(), request.query);
        if (!await workbench.store.getConversation(id)) throw new StoreError('conversation_not_found', 404);
        return json(reply, await workbench.store.readTurnFilesPage(id, run, after));
      });
      privateApp.get('/workspaces/:id/files', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        const { directory, ...options } = parse(z.object({ directory: z.string().max(1024).default(''),
          cursor: directoryPageOptions.shape.cursor, limit: z.coerce.number().int().min(1).max(100).optional(),
          refresh: z.literal('1').optional().transform(value => value === '1') }).strict(), request.query);
        const { entries, ...page } = await workbench.listWorkspaceFiles(id, directory, options);
        return json(reply, { files: entries, ...page });
      });
      privateApp.get('/workspaces/:id/file', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        const { path } = parse(z.object({ path: documentPath }).strict(), request.query);
        return json(reply, await workbench.openWorkspaceFile(id, path));
      });
      privateApp.get('/workspaces/:id/edit-status', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        parse(noQuery, request.query);
        return json(reply, (await workbench.workspaceEditStatus(id)));
      });
      privateApp.post('/workspaces/:id/maintenance', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        parse(noQuery, request.query);
        const { action } = parse(z.object({ action: z.enum(['pause', 'resume']) }).strict(), request.body);
        return json(reply, await workbench.changeWorkspaceMaintenance(id, action));
      });
      privateApp.post('/workspaces/:id/file', { bodyLimit: 6 * textLimit + 8192 }, async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        parse(noQuery, request.query);
        const { path, version, text, saveId } = parse(z.object({ path: documentPath,
          version: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(6 * textLimit), saveId: z.uuid().optional() }).strict(), request.body);
        validateWorkspaceText(text);
        return json(reply, await workbench.saveWorkspaceFile(id, path, version, text, saveId));
      });
      privateApp.get('/conversations/:id/files', async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        const { directory, ...options } = parse(z.object({ directory: z.string().max(1024).default(''),
          cursor: directoryPageOptions.shape.cursor, limit: z.coerce.number().int().min(1).max(100).optional(),
          refresh: z.literal('1').optional().transform(value => value === '1') }).strict(), request.query);
        const { entries, ...page } = await workbench.files(id, directory, options);
        return json(reply, { files: entries, ...page });
      });
      privateApp.get('/conversations/:id/workspace-image', async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        const { item, source } = parse(z.object({ item: identifierSchema, source: z.string().min(1).max(2048) }).strict(), request.query);
        const image = await workbench.workspaceImage(id, item, source);
        return reply.type(image.mediaType).header('Content-Disposition', 'inline').send(image.data);
      });
      privateApp.post('/conversations/:id/resources', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        if (!(await workbench.store.getConversation(id))) throw new StoreError('conversation_not_found', 404);
        const body = parse(z.object({ name: z.string().min(1).max(120), data: z.string().max(3 * 1024 * 1024) }).strict(), request.body);
        return json(reply, imageSchema.parse((await workbench.store.resources.put(id, body.name, decodeImage(body.data, 2 * 1024 * 1024)))));
      });
      const resourceParams = z.object({ id: z.uuid(), resource: z.uuid() }).strict();
      privateApp.get('/conversations/:id/resources/:resource', async (request, reply) => {
        const { id, resource } = parse(resourceParams, request.params); parse(noQuery, request.query);
        const image = (await workbench.store.resources.get(id, resource));
        return reply.type(image.mediaType).header('Content-Disposition', 'inline').send(image.data);
      });
      privateApp.delete('/conversations/:id/resources/:resource', async (request, reply) => {
        const { id, resource } = parse(resourceParams, request.params); parse(noQuery, request.query);
        (await workbench.store.resources.remove(id, resource)); return reply.code(204).send();
      });
      privateApp.get('/conversations/:id/older', async (request, reply) => {
        const { id } = parse(uuidParams, request.params); const { beforeItemId } = parse(olderQuery, request.query);
        return json(reply, snapshotView(await workbench.older(id, beforeItemId)));
      });
      privateApp.get('/conversations/:id/body', async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        const query = parse(z.object({ item: identifierSchema, field: bodyFieldSchema,
          version: z.string().regex(/^[a-f0-9]{64}$/), bytes: cursorSchema,
          offset: cursorSchema.default(0).refine(value => value % (64 * 1024) === 0), download: z.literal('1').optional(),
        }).strict(), request.query);
        if (query.download && query.offset !== 0) throw new StoreError('invalid_request', 400);
        const reference = { version: query.version, bytes: query.bytes };
        const first = await workbench.store.readBody(id, query.item, query.field, reference, query.offset);
        reply.header('Cache-Control', 'no-store').header('ETag', '"' + first.version + '"').header('X-Body-Bytes', first.bytes);
        if (!query.download) return reply.type('application/octet-stream').header('X-Body-Next-Offset', first.nextOffset ?? -1)
          .send(Buffer.from(first.data.buffer, first.data.byteOffset, first.data.byteLength));
        const token = context.token(request);
        async function* chunks() {
          let chunk = first;
          for (;;) {
            if (reply.raw.destroyed || !await context.auth.authenticate(token)) return;
            yield Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
            if (chunk.nextOffset === null) return;
            chunk = await workbench.store.readBody(id, query.item, query.field, reference, chunk.nextOffset);
          }
        }
        return reply.type('text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="conversation-message.txt"')
          .header('Content-Length', first.bytes).send(Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 }));
      });
      privateApp.post('/conversations/:id/operations', async (request, reply) => {
        parse(noQuery, request.query); const { id } = parse(uuidParams, request.params);
        const operation = await workbench.enqueue({ ...parse(enqueueOperationSchema, request.body), conversationId: id });
        return json(reply.code(202), { operation: operationView(operation) });
      });
      privateApp.post('/conversations/:id/queue', async (request, reply) => {
        parse(noQuery, request.query);
        const { id } = parse(uuidParams, request.params);
        return json(reply, await workbench.changeQueue(id, parse(queueCommandSchema, request.body)));
      });
      privateApp.get('/operations/:id', async (request, reply) => {
        parse(noQuery, request.query); const { id } = parse(uuidParams, request.params);
        const operation = (await workbench.store.getOperation(id)); if (!operation) throw new StoreError('operation_not_found', 404);
        return json(reply, { operation: operationView(operation) });
      });
      privateApp.post('/conversations/:id/reconcile', async (request, reply) => {
        parse(noQuery, request.query); const { id } = parse(uuidParams, request.params); parse(noQuery, request.body ?? {});
        await workbench.reconcile(id);
        return json(reply, snapshotView((await workbench.snapshot(id))));
      });
      privateApp.get('/events', async (request: FastifyRequest, reply: FastifyReply) => {
        const query = parse(eventsQuery, request.query);
        const previous = request.headers['last-event-id'];
        const cursor = previous === undefined ? query.cursor ?? (await workbench.store.version()) : parse(cursorSchema, previous);
        const token = context.token(request); const session = await context.auth.authenticate(token);
        if (!session) return reply.code(401).send({ error: 'unauthenticated' });
        if (closed) return reply.code(503).send({ error: 'workbench_closing' });
        if (connections.size >= options.maxConnections || [...connections].filter(item => item.sessionId === session.id).length >= options.maxConnectionsPerSession)
          return reply.code(429).header('Retry-After', '5').send({ error: 'event_connection_limit' });
        reply.header('Content-Type', 'text/event-stream; charset=utf-8');
        reply.header('Cache-Control', 'no-store, no-transform'); reply.header('X-Accel-Buffering', 'no');
        reply.header('Connection', 'keep-alive');
        reply.hijack();
        // writeHead must preserve buildApp's CSP, HSTS and other security headers.
        const headers = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, Array.isArray(value) ? value : String(value)]));
        reply.raw.writeHead(200, headers); reply.raw.setTimeout(0);
        const connection: Connection = { response: reply.raw, sessionId: session.id, token, context, cursor, navigation: query.navigation === '1', closed: false, blocked: false, drain: () => {
          if (connection.timeout) clearTimeout(connection.timeout); connection.timeout = undefined; connection.blocked = false; schedule(connection);
        } };
        connections.add(connection);
        reply.raw.on('drain', connection.drain);
        reply.raw.once('close', () => disconnect(connection, false));
        reply.raw.once('error', () => disconnect(connection));
        event(connection, 'ready', { type: 'ready', revision: cursor }); schedule(connection);
      });
    }, { prefix: '/workbench' });
  }
  return { routes, changed, invalidate, logout, close };
}

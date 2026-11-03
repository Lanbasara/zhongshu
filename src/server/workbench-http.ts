import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { conversationManagementSchema, conversationSearchSchema, createConversationSchema, enqueueOperationSchema, identifierSchema, queueCommandSchema, workbenchConfigurationSchema,
  workspaceAddSchema, workspaceBrowseSchema, workspaceDirectoryListSchema, workspaceIdSchema, workspaceManagementSchema } from '../shared/workbench.ts';
import type { Conversation as ConversationView, WorkbenchOperation, WorkbenchSnapshot } from '../shared/workbench.ts';
import type { PrivateContext } from './app.ts';
import type { Workbench } from './workbench.ts';
import { StoreError, type Conversation, type Operation, type WorkbenchChange } from './workbench-store.ts';
import { decodeImage, ResourceError } from './resources.ts';
import { textLimit } from './workspace-documents.ts';
import { imageSchema } from '../shared/content.ts';

const uuidParams = z.object({ id: z.uuid() }).strict();
const workspaceParams = z.object({ id: workspaceIdSchema }).strict();
const documentPath = z.string().min(1).max(1024);
const noQuery = z.object({}).strict();
const listQuery = z.object({ beforeId: z.uuid().optional() }).strict();
const olderQuery = z.object({ beforeItemId: identifierSchema.optional() }).strict();
const cursorSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).refine(Number.isSafeInteger);
const eventsQuery = z.object({ cursor: cursorSchema.optional() }).strict();
const optionsSchema = z.object({
  heartbeatMs: z.number().int().min(20).max(30_000).default(15_000),
  slowClientMs: z.number().int().min(100).max(30_000).default(5000),
  maxConnections: z.number().int().min(1).max(32).default(16),
  maxConnectionsPerSession: z.number().int().min(1).max(8).default(8),
}).strict();
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
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
function newestWithin<T>(values: T[], budget: number, newestFirst = false): T[] {
  const kept: T[] = [];
  for (const value of newestFirst ? values : values.toReversed()) {
    budget -= size(value) + 1; if (budget < 0) break; kept.push(value);
  }
  return newestFirst ? kept : kept.reverse();
}
function snapshotView(value: ReturnType<Workbench['snapshot']>): WorkbenchSnapshot {
  const { history } = value;
  const conversation = conversationView(value.conversation);
  const operations = newestWithin(value.operations.map(operationView), 1024 * 1024, true);
  // Keep a contiguous latest suffix, preserving whole messages and a usable older-page anchor.
  // A single maximum-size native message (including JSON escaping) fits this budget.
  const items = newestWithin(history.items, 7 * 1024 * 1024);
  const { queue } = value;
  const liveItems = newestWithin(history.liveItems, MAX_RESPONSE_BYTES - size({ conversation, operations, items, queue }) - 4096);
  const trimmed = items.length < history.items.length;
  const hasOlder = trimmed || Boolean(history.olderBeforeItemId || history.nativeOlderCursor);
  return { conversation, history: {
    items, liveItems, liveItemsLimited: history.liveItemsLimited || liveItems.length < history.liveItems.length, loaded: history.historyLoaded,
    olderBeforeItemId: hasOlder ? (trimmed ? items[0]?.id : history.olderBeforeItemId) ?? items[0]?.id ?? null : null, hasOlder,
  }, operations, queue, revision: value.revision };
}
function json(reply: FastifyReply, value: unknown): FastifyReply {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new StoreError('response_too_large', 413);
  return reply.type('application/json; charset=utf-8').send(body);
}

type Connection = {
  response: ServerResponse; sessionId: string; token: string; context: PrivateContext; cursor: number;
  closed: boolean; blocked: boolean; timeout?: NodeJS.Timeout; scheduled?: NodeJS.Immediate; drain: () => void;
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
  function authorized(connection: Connection): boolean {
    if (connection.closed) return false;
    try {
      if (connection.context.auth.authenticate(connection.token)?.id === connection.sessionId) return true;
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
    connection.scheduled = setImmediate(() => { connection.scheduled = undefined; pump(connection); });
  }
  function pump(connection: Connection): void {
    if (closed || connection.blocked || !authorized(connection)) return;
    try {
      const batch = workbench.store.changes(connection.cursor, 64);
      if (batch.reset) {
        if (event(connection, 'reset', { type: 'reset', revision: batch.latest }, batch.latest)) connection.cursor = batch.latest;
        return;
      }
      for (const change of batch.events) {
        const value: { type: 'change'; revision: number; conversationId: string; item?: ReturnType<Workbench['store']['getItem']> } = {
          type: 'change', revision: change.sequence, conversationId: change.conversationId,
        };
        if (change.itemId) {
          const item = workbench.store.getItem(change.conversationId, change.itemId);
          // Large bodies use the same invalidation + snapshot path, never fragmented deltas.
          if (item && Buffer.byteLength(item.text) <= MAX_FRAME_BYTES) {
            value.item = item;
            if (size(value) > MAX_FRAME_BYTES - 256) delete value.item;
          }
        }
        if (!event(connection, 'change', value, change.sequence)) return;
        connection.cursor = change.sequence;
        if (connection.blocked) return;
      }
      if (connection.cursor < batch.latest) schedule(connection);
    } catch { disconnect(connection); }
  }
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (authorized(connection) && !connection.blocked) { event(connection, 'heartbeat', {}); schedule(connection); }
    }
  }, options.heartbeatMs).unref();
  function close(): void { if (closed) return; closed = true; clearInterval(heartbeat); for (const connection of [...connections]) disconnect(connection); }
  function logout(sessionId: string): void { for (const connection of [...connections]) if (connection.sessionId === sessionId) disconnect(connection); }
  function changed(_change: WorkbenchChange): void { for (const connection of connections) schedule(connection); }

  async function routes(app: FastifyInstance, context: PrivateContext): Promise<void> {
    // This plugin is installed inside buildApp's authenticated/CSRF-protected scope.
    await app.register(async privateApp => {
      privateApp.addHook('preClose', async () => close());
      privateApp.setErrorHandler((error, _request, reply) => {
        if (error instanceof StoreError && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)) return reply.code(error.statusCode).send({ error: error.code });
        if (error instanceof ResourceError) return reply.code(error.statusCode).send({ error: error.message });
        const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
        const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
        if (status === 500) privateApp.log.error({ event: 'workbench_request_failed' });
        return reply.code(status).send({ error: status === 500 ? 'workbench_unavailable' : 'invalid_request' });
      });
      privateApp.get('/configuration', async (request, reply) => {
        parse(noQuery, request.query);
        const result = workbenchConfigurationSchema.parse({ harnesses: await workbench.catalogs(), ...workbench.workspaceView() });
        return json(reply, result);
      });
      privateApp.post('/workspace-directories', { bodyLimit: 8192 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { rootId, path } = parse(workspaceBrowseSchema, request.body);
        return json(reply, workspaceDirectoryListSchema.parse(workbench.browseWorkspaceRoot(rootId, path)));
      });
      privateApp.post('/workspaces', { bodyLimit: 8192 }, async (request, reply) => {
        parse(noQuery, request.query);
        const id = workbench.addWorkspace(parse(workspaceAddSchema, request.body));
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
        const values = workbench.store.listConversations({ ...query, limit: 101 });
        const conversations = values.slice(0, 100).map(conversationView);
        return json(reply, { conversations, olderBeforeId: values.length > 100 ? conversations.at(-1)!.id : null, revision: workbench.store.version() });
      });
      // Titles stay in the body, outside request URL logs.
      privateApp.post('/conversation-search', { bodyLimit: 4096 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { unregistered, ...query } = parse(conversationSearchSchema, request.body);
        const limit = query.workspaceId || unregistered ? 6 : 30;
        const workspaces = unregistered ? workbench.workspaceView() : undefined;
        const values = workbench.store.listConversations({
          ...query, limit: limit + 1,
          ...(workspaces ? { excludeWorkspaces: [...workspaces.workspaces, ...(workspaces.removedWorkspaces ?? [])].map(workspace => workspace.id) } : {}),
        });
        const conversations = values.slice(0, limit).map(conversationView);
        return json(reply, { conversations, olderBeforeId: values.length > limit ? conversations.at(-1)!.id : null, revision: workbench.store.version() });
      });
      privateApp.post('/conversations/:id/manage', { bodyLimit: 4096 }, async (request, reply) => {
        parse(noQuery, request.query);
        const { id } = parse(uuidParams, request.params);
        const body = parse(conversationManagementSchema, request.body);
        const conversation = body.action === 'rename' ? workbench.store.renameConversation(id, body.title) :
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
      privateApp.get('/workspaces/:id/files', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        const { directory } = parse(z.object({ directory: z.string().max(1024).default('') }).strict(), request.query);
        return json(reply, { files: await workbench.listWorkspaceFiles(id, directory) });
      });
      privateApp.get('/workspaces/:id/file', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        const { path } = parse(z.object({ path: documentPath }).strict(), request.query);
        return json(reply, await workbench.openWorkspaceFile(id, path));
      });
      privateApp.get('/workspaces/:id/edit-status', async (request, reply) => {
        const { id } = parse(workspaceParams, request.params);
        parse(noQuery, request.query);
        return json(reply, workbench.workspaceEditStatus(id));
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
        const { path, version, text } = parse(z.object({ path: documentPath,
          version: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(textLimit) }).strict(), request.body);
        return json(reply, await workbench.saveWorkspaceFile(id, path, version, text));
      });
      privateApp.get('/conversations/:id/files', async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        const { directory } = parse(z.object({ directory: z.string().max(1024).default('') }).strict(), request.query);
        return json(reply, { files: await workbench.files(id, directory) });
      });
      privateApp.get('/conversations/:id/workspace-image', async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        const { item, source } = parse(z.object({ item: identifierSchema, source: z.string().min(1).max(2048) }).strict(), request.query);
        const image = await workbench.workspaceImage(id, item, source);
        return reply.type(image.mediaType).header('Content-Disposition', 'inline').send(image.data);
      });
      privateApp.post('/conversations/:id/resources', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
        const { id } = parse(uuidParams, request.params);
        if (!workbench.store.getConversation(id)) throw new StoreError('conversation_not_found', 404);
        const body = parse(z.object({ name: z.string().min(1).max(120), data: z.string().max(3 * 1024 * 1024) }).strict(), request.body);
        return json(reply, imageSchema.parse(workbench.store.resources.put(id, body.name, decodeImage(body.data, 2 * 1024 * 1024))));
      });
      const resourceParams = z.object({ id: z.uuid(), resource: z.uuid() }).strict();
      privateApp.get('/conversations/:id/resources/:resource', async (request, reply) => {
        const { id, resource } = parse(resourceParams, request.params); parse(noQuery, request.query);
        const image = workbench.store.resources.get(id, resource);
        return reply.type(image.mediaType).header('Content-Disposition', 'inline').send(image.data);
      });
      privateApp.delete('/conversations/:id/resources/:resource', async (request, reply) => {
        const { id, resource } = parse(resourceParams, request.params); parse(noQuery, request.query);
        workbench.store.resources.remove(id, resource); return reply.code(204).send();
      });
      privateApp.get('/conversations/:id/older', async (request, reply) => {
        const { id } = parse(uuidParams, request.params); const { beforeItemId } = parse(olderQuery, request.query);
        return json(reply, snapshotView(await workbench.older(id, beforeItemId)));
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
        const operation = workbench.store.getOperation(id); if (!operation) throw new StoreError('operation_not_found', 404);
        return json(reply, { operation: operationView(operation) });
      });
      privateApp.post('/conversations/:id/reconcile', async (request, reply) => {
        parse(noQuery, request.query); const { id } = parse(uuidParams, request.params); parse(noQuery, request.body ?? {});
        await workbench.reconcile(id);
        return json(reply, snapshotView(workbench.snapshot(id)));
      });
      privateApp.get('/events', (request: FastifyRequest, reply: FastifyReply) => {
        const query = parse(eventsQuery, request.query);
        const previous = request.headers['last-event-id'];
        const cursor = previous === undefined ? query.cursor ?? workbench.store.version() : parse(cursorSchema, previous);
        const token = context.token(request); const session = context.auth.authenticate(token);
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
        const connection: Connection = { response: reply.raw, sessionId: session.id, token, context, cursor, closed: false, blocked: false, drain: () => {
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
  return { routes, changed, logout, close };
}

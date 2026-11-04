import { deserialize } from 'node:v8';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { openDatabase } from './database.ts';
import { productMigrations } from './migrations.ts';
import { ResourceError } from './resources.ts';
import { createWorkbenchStore, StoreError, type WorkbenchChange } from './workbench-store.ts';
import { createAuthStore } from './auth-store.ts';
import { createPluginStore } from './plugin-store.ts';
import { createWorkspaceStore } from './workspace-store.ts';
import { createExecutionStore } from './execution-store.ts';
import { encodeStorageValue, storageCommandSchema, storageConfigurationSchema, storageCommandMethods, type StorageOutcome } from './storage-client.ts';

// No SQL, paths, functions or migrations are supplied by RPC callers. The worker
// owns the connection and invokes whole repository commands synchronously, so no
// native I/O or promise can be awaited inside a database transaction.
if (!isMainThread && parentPort) {
  const port = parentPort;
  try {
    const options = storageConfigurationSchema.parse(workerData);
    const db = openDatabase(options.dataDirectory, productMigrations);
    let changes: WorkbenchChange[] = [];
    let reset = false;
    const store = createWorkbenchStore(db, { capacity: options.capacity, onChange(event) {
      if (reset) return;
      if (changes.length === 128) { changes = []; reset = true; }
      else changes.push(event);
    } });
    const repositories = { auth: createAuthStore(db), store, resources: store.resources, plugins: createPluginStore(db, options.capacity), workspaces: createWorkspaceStore(db, options.capacity), execution: createExecutionStore(db) };
    let closed = false;
    let lastId = 0;
    let completed = 0;
    const requestSchema = z.object({ type: z.literal('request'), id: z.number().int().positive().safe(), payload: z.instanceof(Uint8Array) }).strict();
    const send = (id: number, result: unknown, write: boolean, error?: { code: string; statusCode: number; outcome: StorageOutcome }) => {
      let payload: Buffer;
      try { payload = encodeStorageValue({ result, changes, reset, ...(error ? { error } : {}) }, options.maxResultBytes); }
      catch {
        // A successful write has already committed; over-budget results cannot
        // turn it into a retryable rejection. The caller must read durable state.
        payload = encodeStorageValue({ changes: [], reset: changes.length > 0 || reset,
          error: { code: 'storage_result_too_large', statusCode: 413, outcome: write && !error ? 'committed' : error?.outcome ?? 'rejected' },
        }, options.maxResultBytes);
      }
      port.postMessage({ type: 'result', id, payload });
      if (++completed % 128 === 0) {
        const memory = process.memoryUsage();
        // RSS belongs to the whole process; V8 heap/external belong to this worker.
        port.postMessage({ type: 'telemetry', memory: { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external,
          arrayBuffers: memory.arrayBuffers, processRss: memory.rss, processMaxRss: process.resourceUsage().maxRSS, completed } });
      }
    };
    port.on('message', (message: unknown) => {
      if (closed) return;
      if (message && typeof message === 'object' && 'type' in message && message.type === 'close' && Object.keys(message).length === 1) {
        closed = true; db.close(); port.postMessage({ type: 'closed' }); port.close(); return;
      }
      const parsed = requestSchema.safeParse(message);
      if (!parsed.success || parsed.data.id <= lastId || parsed.data.payload.byteLength > options.maxRequestBytes) {
        closed = true; db.close(); port.postMessage({ type: 'fatal' }); port.close(); return;
      }
      const { id, payload } = parsed.data;
      lastId = id; changes = []; reset = false;
      let write = false;
      let transaction = false;
      try {
        const command = storageCommandSchema.parse(deserialize(payload));
        const methods: Record<string, 'read' | 'write' | 'unsupported'> = storageCommandMethods[command.scope];
        if (!Object.hasOwn(methods, command.method) || methods[command.method as keyof typeof methods] === 'unsupported')
          throw new StoreError('storage_method_unsupported', 400);
        write = methods[command.method as keyof typeof methods] === 'write';
        const target = repositories[command.scope];
        // Resource commands lack their own transaction because store operations
        // compose them inside an existing transaction. Direct resource RPCs get
        // the same all-or-nothing boundary here.
        if (command.scope === 'resources' && write) { db.exec('BEGIN IMMEDIATE'); transaction = true; }
        const method = target[command.method as keyof typeof target] as (...args: unknown[]) => unknown;
        const result = Reflect.apply(method, target, command.args);
        if (transaction) { db.exec('COMMIT'); transaction = false; }
        send(id, result, write);
      } catch (error) {
        if (transaction) { try { db.exec('ROLLBACK'); } catch { /* mutation outcome stays unknown */ } }
        const known = error instanceof StoreError || error instanceof ResourceError;
        const code = known && /^[a-z][a-z0-9_]{0,99}$/.test(error.message) ? error.message : 'storage_command_failed';
        const statusCode = known ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
        send(id, undefined, write, { code, statusCode, outcome: write && statusCode >= 500 ? 'unknown' : 'rejected' });
      }
    });
    port.postMessage({ type: 'ready' });
  } catch {
    port.postMessage({ type: 'fatal' }); port.close();
  }
}

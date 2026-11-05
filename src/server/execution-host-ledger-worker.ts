import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { deserialize } from 'node:v8';
import { z } from 'zod';
import { openDatabase } from './database.ts';
import { createCapacityGuard } from './storage-capacity.ts';
import { encodeStorageValue } from './storage-client.ts';
import { hostControlSchema, hostRecoverySchema, hostEpochSchema, hostIdentifier, hostSha256, hostPermissionSchema, hostLedgerMethods, hostLedgerOptionsSchema,
  type HostControl, type HostForward, type HostRecord } from './execution-host-ledger.ts';
import { ExecutionHostError, type ContainerProof } from './execution-host-docker.ts';
import type { ExecutionGroupState } from './execution-controller.ts';

if (!parentPort) throw new Error('execution_ledger_worker_only');
const port = parentPort;
try {
  const options = hostLedgerOptionsSchema.parse(workerData);
  const db = openDatabase(options.directory, [{ version: 2, sql: `
    CREATE TABLE execution_host_identity (id INTEGER PRIMARY KEY CHECK(id=1), configuration_digest TEXT NOT NULL, state_json TEXT NOT NULL,
      container_id TEXT, initialized INTEGER NOT NULL DEFAULT 0, intent_json TEXT) STRICT;
    CREATE TABLE execution_host_controls (request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT) STRICT;
    CREATE TABLE execution_host_forwards (request_id TEXT PRIMARY KEY, admission_id TEXT NOT NULL, content_digest TEXT NOT NULL, wire_digest TEXT NOT NULL,
      purpose TEXT NOT NULL, groups_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, binding_json TEXT) STRICT;
  ` }, { version: 3, sql: `
    ALTER TABLE execution_host_identity ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 3);
    ALTER TABLE execution_host_identity ADD COLUMN recovery_next_at INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE execution_host_recoveries (request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL) STRICT;
  ` }]);
  const capacity = createCapacityGuard(db, options.capacity);
  const stateSchema = hostEpochSchema.extend({ groupId: hostIdentifier, admission: z.enum(['open', 'drain', 'closed']), writers: z.enum(['running', 'quiescent']), durable: z.literal(true), frozenSetId: hostSha256.optional() }).strict();
  const proofSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), groupId: hostIdentifier, generation: hostIdentifier, configurationDigest: hostSha256,
    running: z.boolean(), pid: z.number().int().nonnegative().safe(), status: z.string().min(1).max(30) }).strict();
  const encode = (value: unknown) => { const result = JSON.stringify(value); if (Buffer.byteLength(result) > 64 * 1024) throw new ExecutionHostError('execution_ledger_value_too_large', 413); return result; };
  const initial: ExecutionGroupState = { groupId: options.groupId, generation: randomUUID(), epoch: 0, admission: 'open', writers: 'running', durable: true };
  db.prepare('INSERT OR IGNORE INTO execution_host_identity(id,configuration_digest,state_json) VALUES(1,?,?)').run(options.configurationDigest, encode(initial));
  function load(): HostRecord {
    const row = db.prepare('SELECT * FROM execution_host_identity WHERE id=1').get()!;
    const state = stateSchema.parse(JSON.parse(String(row.state_json)));
    if (row.configuration_digest !== options.configurationDigest || state.groupId !== options.groupId) throw new ExecutionHostError('execution_host_configuration_changed');
    return { configurationDigest: options.configurationDigest, state, containerId: row.container_id === null ? null : String(row.container_id), initialized: row.initialized === 1,
      intent: row.intent_json === null ? null : hostControlSchema.parse(JSON.parse(String(row.intent_json))), capacity: capacity.status(),
      recovery: { attempts: Number(row.recovery_attempts), nextAttemptAt: Number(row.recovery_next_at) } };
  }
  load();
  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve uncertainty. */ } throw error; }
  }
  function proof(input: ContainerProof, row: HostRecord, running: boolean) {
    const value = proofSchema.parse(input);
    if (value.groupId !== row.state.groupId || value.generation !== row.state.generation || value.configurationDigest !== row.configurationDigest ||
      row.containerId !== value.id || value.running !== running || (running ? value.pid <= 0 || value.status !== 'running' : value.pid !== 0 || !['created', 'exited'].includes(value.status)))
      throw new ExecutionHostError('execution_container_proof_changed');
  }
  function current(row: HostRecord, expected: { generation: string; epoch: number }) {
    if (!row.initialized || row.state.generation !== expected.generation || row.state.epoch !== expected.epoch) throw new ExecutionHostError('execution_host_epoch_changed');
  }
  function forward(requestId: string, wireDigest: string): HostForward | null {
    const row = db.prepare('SELECT * FROM execution_host_forwards WHERE request_id=?').get(hostIdentifier.parse(requestId));
    if (!row) return null;
    if (row.wire_digest !== hostSha256.parse(wireDigest)) throw new ExecutionHostError('execution_forward_identity_changed');
    return { created: false, status: z.enum(['forwarding', 'settled']).parse(row.status),
      ...(row.result_json !== null ? { result: JSON.parse(String(row.result_json)) } : {}), ...(row.binding_json !== null ? { binding: JSON.parse(String(row.binding_json)) } : {}) };
  }
  const methods = {
    load,
    attachContainer(input: ContainerProof) {
      transaction(() => { const row = load(); const value = proofSchema.parse(input);
        if (value.groupId !== row.state.groupId || value.generation !== row.state.generation || value.configurationDigest !== row.configurationDigest ||
          row.containerId && row.containerId !== value.id) throw new ExecutionHostError('execution_container_identity_changed');
        db.prepare('UPDATE execution_host_identity SET container_id=? WHERE id=1').run(value.id);
      });
    },
    initialize(input: ContainerProof) {
      return transaction(() => { const row = load(); if (row.initialized || row.intent) throw new ExecutionHostError('execution_host_already_initialized');
        proof(input, row, true); db.prepare('UPDATE execution_host_identity SET initialized=1 WHERE id=1').run(); return row.state;
      });
    },
    beginControl(input: HostControl) {
      return transaction(() => { const request = hostControlSchema.parse(input); const encoded = encode(request);
        const previous = db.prepare('SELECT * FROM execution_host_controls WHERE request_id=?').get(request.requestId);
        if (previous) {
          if (previous.request_json !== encoded) throw new ExecutionHostError('execution_control_identity_changed');
          return previous.result_json === null ? { status: 'pending' } : { status: 'complete', state: stateSchema.parse(JSON.parse(String(previous.result_json))) };
        }
        capacity.assertWritable('archive', 16 * 1024);
        const row = load(); current(row, request.expected);
        if (row.intent || row.state.epoch === Number.MAX_SAFE_INTEGER) throw new ExecutionHostError('execution_control_unresolved');
        if (request.action === 'fence' ? row.state.admission !== 'open' || !request.frozenSetId
          : request.action === 'quiesce' ? row.state.admission !== 'drain' || !request.frozenSetId || row.state.frozenSetId !== request.frozenSetId
          : row.state.admission !== 'closed' || request.frozenSetId !== undefined) throw new ExecutionHostError('execution_control_transition_invalid');
        db.prepare('INSERT INTO execution_host_controls(request_id,request_json) VALUES(?,?)').run(request.requestId, encoded);
        db.prepare('UPDATE execution_host_identity SET intent_json=? WHERE id=1').run(encoded);
        return { status: 'pending' };
      });
    },
    completeControl(requestId: string, input: ContainerProof) {
      return transaction(() => { hostIdentifier.parse(requestId); const row = load(); const request = row.intent;
        if (!request || request.requestId !== requestId) throw new ExecutionHostError('execution_control_intent_changed');
        current(row, request.expected); proof(input, row, request.action !== 'quiesce');
        const state: ExecutionGroupState = { groupId: row.state.groupId, generation: row.state.generation, epoch: row.state.epoch + 1,
          admission: request.action === 'fence' ? 'drain' : request.action === 'quiesce' ? 'closed' : 'open',
          writers: request.action === 'quiesce' ? 'quiescent' : 'running', durable: true,
          ...(request.action === 'resume' ? {} : { frozenSetId: request.frozenSetId! }) };
        db.prepare('UPDATE execution_host_identity SET state_json=?,intent_json=NULL WHERE id=1').run(encode(state));
        db.prepare('UPDATE execution_host_controls SET result_json=? WHERE request_id=?').run(encode(state), requestId); return state;
      });
    },
    confirm(expected: { generation: string; epoch: number }, input: ContainerProof) {
      return transaction(() => { const row = load(); current(row, hostEpochSchema.parse(expected));
        if (row.intent) throw new ExecutionHostError('execution_control_unresolved'); proof(input, row, row.state.admission !== 'closed'); return row.state;
      });
    },
    claimRecovery(input: z.infer<typeof hostRecoverySchema>, physical: ContainerProof) {
      transaction(() => {
        const request = hostRecoverySchema.parse(input); const row = load(); current(row, request.expected);
        if (row.intent || row.state.admission !== 'open' || row.state.writers !== 'running' || row.state.frozenSetId)
          throw new ExecutionHostError('execution_host_recovery_blocked');
        proof(physical, row, false);
        const previous = db.prepare('SELECT request_json FROM execution_host_recoveries WHERE request_id=?').get(request.requestId);
        if (previous) throw new ExecutionHostError(previous.request_json === encode(request) ? 'execution_host_recovery_unknown' : 'execution_control_identity_changed');
        const now = Date.now(); const attempts = request.explicit ? 0 : row.recovery.attempts;
        if (attempts >= 3) throw new ExecutionHostError('execution_host_recovery_exhausted');
        if (!request.explicit && now < row.recovery.nextAttemptAt) throw new ExecutionHostError('execution_host_recovery_backoff');
        capacity.assertWritable('archive', 16 * 1024);
        // Commit the budget before Docker I/O. A lost start receipt consumes an
        // attempt; reopening either application or ledger cannot grant more.
        db.prepare('INSERT INTO execution_host_recoveries(request_id,request_json) VALUES(?,?)').run(request.requestId, encode(request));
        db.prepare('UPDATE execution_host_identity SET recovery_attempts=?,recovery_next_at=? WHERE id=1').run(attempts + 1, now + 1000 * 2 ** attempts);
      });
    },
    claimForward(input: z.infer<typeof hostPermissionSchema>): HostForward {
      return transaction(() => { const permission = hostPermissionSchema.parse(input); const previous = forward(permission.requestId, permission.wireDigest);
        if (previous) {
          const old = db.prepare('SELECT admission_id,content_digest,purpose FROM execution_host_forwards WHERE request_id=?').get(permission.requestId)!;
          if (old.admission_id !== permission.admissionId || old.content_digest !== permission.contentDigest || old.purpose !== permission.purpose) throw new ExecutionHostError('execution_forward_identity_changed');
          return previous;
        }
        capacity.assertWritable(permission.purpose === 'stop' ? 'archive' : 'admission', 96 * 1024);
        const row = load(); const token = permission.groups.find(group => group.groupId === row.state.groupId);
        if (!token) throw new ExecutionHostError('execution_forward_group_missing'); current(row, token);
        if (row.intent || row.state.admission === 'closed' || row.state.writers !== 'running' ||
          (row.state.admission === 'drain' && permission.purpose !== 'stop' && token.frozenSetId !== row.state.frozenSetId) ||
          (row.state.admission === 'open' && token.frozenSetId !== undefined)) throw new ExecutionHostError('execution_forward_closed');
        db.prepare("INSERT INTO execution_host_forwards(request_id,admission_id,content_digest,wire_digest,purpose,groups_json,status) VALUES(?,?,?,?,?,?,'forwarding')")
          .run(permission.requestId, permission.admissionId, permission.contentDigest, permission.wireDigest, permission.purpose, encode(permission.groups));
        return { created: true, status: 'forwarding' };
      });
    },
    readForward: forward,
    readCreatedBinding(conversationId: string) {
      z.uuid().parse(conversationId);
      const row = db.prepare('SELECT binding_json FROM execution_host_forwards WHERE request_id=?').get('create:' + conversationId);
      return row?.binding_json ? JSON.parse(String(row.binding_json)) : null;
    },
    recordBinding(requestId: string, binding: unknown) {
      transaction(() => { hostIdentifier.parse(requestId); const encoded = encode(binding);
        const row = db.prepare('SELECT status,binding_json FROM execution_host_forwards WHERE request_id=?').get(requestId);
        if (!row || row.status !== 'forwarding' || row.binding_json !== null && row.binding_json !== encoded) throw new ExecutionHostError('execution_forward_binding_changed');
        db.prepare('UPDATE execution_host_forwards SET binding_json=? WHERE request_id=?').run(encoded, requestId);
      });
    },
    settleForward(requestId: string, result: unknown) {
      transaction(() => { hostIdentifier.parse(requestId); const encoded = encode(result);
        const row = db.prepare('SELECT status,result_json FROM execution_host_forwards WHERE request_id=?').get(requestId);
        if (!row || row.status === 'settled' && row.result_json !== encoded) throw new ExecutionHostError('execution_forward_result_changed');
        db.prepare("UPDATE execution_host_forwards SET status='settled',result_json=? WHERE request_id=?").run(encoded, requestId);
      });
    },
  };
  let lastId = 0;
  port.on('message', message => {
    if (message?.type === 'close') { db.close(); port.close(); return; }
    try {
      const request = z.object({ type: z.literal('request'), id: z.number().int().positive().safe(), data: z.instanceof(Uint8Array) }).strict().parse(message);
      if (request.id <= lastId || request.data.byteLength > 96 * 1024) throw new Error('invalid_message'); lastId = request.id;
      const command = z.object({ method: z.enum(hostLedgerMethods), args: z.array(z.unknown()).max(3) }).strict().parse(deserialize(request.data));
      let reply: { result?: unknown; error?: string };
      try { reply = { result: Reflect.apply(methods[command.method], methods, command.args) }; }
      catch (error) { reply = { error: error instanceof ExecutionHostError ? error.code : error instanceof Error && 'code' in error && error.code === 'storage_capacity_reached' ? 'execution_ledger_capacity_reached' : 'execution_ledger_command_unknown' }; }
      port.postMessage({ type: 'result', id: request.id, data: encodeStorageValue(reply, 128 * 1024) });
    } catch { db.close(); port.postMessage({ type: 'fatal' }); port.close(); }
  });
  port.postMessage({ type: 'ready' });
} catch { port.postMessage({ type: 'fatal' }); port.close(); }

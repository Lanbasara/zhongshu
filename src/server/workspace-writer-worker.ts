import { createHash, randomUUID } from 'node:crypto';
import { constants, statfsSync, statSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { workspaceDocumentPath } from '../shared/content.ts';
import { openDatabase } from './database.ts';
import { openWorkspaceDocument, saveWorkspaceDocument, textLimit, withWorkspaceDirectory } from './workspace-documents.ts';
import { createCapacityGuard } from './storage-capacity.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'));
export const writerPermitSchema = z.object({ mode: z.literal('concurrent').optional(), saveId: id, windowId: id, writerId: id.optional(),
  write: z.object({ workspaceId: id, directoryIdentity: z.string().min(1).max(200), path: workspaceDocumentPath, expectedVersion: digest, contentDigest: digest }).strict(),
  groups: z.array(z.object({ groupId: id, controller: z.object({ generation: id, epoch: z.number().int().nonnegative().safe() }).strict() }).strict()).min(1).max(32),
}).strict();
const targetSchema = z.object({ root: absolute, permit: writerPermitSchema }).strict();
const writeSchema = targetSchema.extend({ text: z.string().max(textLimit).refine(text => Buffer.byteLength(text) <= textLimit) }).strict();
export type WriterTarget = z.infer<typeof targetSchema>;
export type WriterRequest = z.infer<typeof writeSchema>;
export type WriterResult = { outcome: 'committed' | 'rejected'; proof: string; reason?: string; document?: Awaited<ReturnType<typeof openWorkspaceDocument>> }
  | { outcome: 'unknown' | 'pending'; reason: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');
const journalMigration = [{ version: 2, sql: `CREATE TABLE workspace_file_effects (
  save_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, input_digest TEXT NOT NULL, intent_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent','committed','rejected','unknown')), result_json TEXT
) STRICT;` }];

/** The owner connection holds a kernel SQLite write lock for this process's
 * whole effect lifetime. It is NEVER closed before the active filesystem work
 * finishes. Other owners cannot steal it by PID lookup, lease expiry or unlink.
 */
export async function serveWorkspaceWriter(options: { onStage?: (stage: 'intent' | 'renamed' | 'recorded', saveId: string) => Promise<void> } = {}) {
  let owner: DatabaseSync | undefined; let journal: DatabaseSync | undefined;
  let capacity: ReturnType<typeof createCapacityGuard> | undefined;
  let ownerId: string | undefined; let initialized = false; let closing = false; let active = false; let lastId = 0;
  function send(value: unknown) { if (process.connected) process.send?.(value as object); }
  function close() {
    if (active) return;
    journal?.close(); journal = undefined;
    // Closing the owner last is the fence: recovery can begin only after every
    // old effect and journal write has ended, including asynchronous fs work.
    owner?.close(); owner = undefined;
    send({ type: 'closed' }); if (process.connected) process.disconnect();
  }
  function commit(action: () => void) {
    journal!.exec('BEGIN IMMEDIATE');
    try { action(); journal!.exec('COMMIT'); } catch (error) { try { journal!.exec('ROLLBACK'); } catch {} closing = true; throw error; }
  }
  function record(target: WriterTarget, outcome: 'committed' | 'rejected' | 'unknown', detail: unknown, reason?: string) {
    const proof = hash(['workspace-writer-v1', ownerId, target, outcome, detail]);
    const result = outcome === 'unknown' ? { outcome, reason: reason ?? 'file_effect_unknown' } : { outcome, proof, ...(reason ? { reason } : {}) };
    try { capacity!.assertWritable('archive', 16384); } catch (error) { closing = true; throw error; }
    commit(() => journal!.prepare('UPDATE workspace_file_effects SET state=?,result_json=? WHERE save_id=?').run(outcome, JSON.stringify(result), target.permit.saveId));
    return result as Exclude<WriterResult, { outcome: 'pending' }>;
  }
  async function syncParent(target: WriterTarget) {
    const parts = target.permit.write.path.split('/').slice(0, -1);
    await withWorkspaceDirectory(target.root, parts, async path => {
      const handle = await open(path + '/.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }, target.permit.write.directoryIdentity);
  }
  async function reconcile(target: WriterTarget): Promise<WriterResult> {
    try {
      const document = await openWorkspaceDocument(target.root, target.permit.write.path, target.permit.write.directoryIdentity);
      if (contentHash(document.text) === target.permit.write.contentDigest) {
        await syncParent(target);
        const result = record(target, 'committed', { version: document.version, digest: target.permit.write.contentDigest });
        return { ...result, document } as WriterResult;
      }
      if (document.version === target.permit.write.expectedVersion) return record(target, 'rejected', { version: document.version }, 'file_write_not_applied');
      return record(target, 'unknown', { version: document.version }, 'file_effect_target_changed');
    } catch { return record(target, 'unknown', null, 'file_effect_unavailable'); }
  }
  async function execute(method: 'write' | 'recover', raw: unknown): Promise<WriterResult> {
    const input = method === 'write' ? writeSchema.parse(raw) : targetSchema.parse(raw);
    const target: WriterTarget = { root: input.root, permit: input.permit };
    if (method === 'write' && contentHash((input as WriterRequest).text) !== input.permit.write.contentDigest) throw new Error('file_writer_input_mismatch');
    const inputDigest = hash(target); const old = journal!.prepare('SELECT owner_id,input_digest,state,result_json FROM workspace_file_effects WHERE save_id=?').get(input.permit.saveId);
    if (old && old.input_digest !== inputDigest) throw new Error('file_writer_save_conflict');
    if (old && ['committed', 'rejected'].includes(String(old.state))) return JSON.parse(String(old.result_json)) as WriterResult;
    if (method === 'recover') {
      if (!input.permit.writerId || input.permit.writerId === ownerId && !old) return { outcome: 'pending', reason: 'file_writer_same_owner_pending' };
      // Existing intents are also safe to reconcile in this owner: requests
      // are strictly serial, so its earlier effect has returned. A same-owner
      // permit WITHOUT an intent may still be in transit and must stay pending.
      if (!old) {
        // The former owner has ended (we hold its kernel lock), and its journal
        // has no intent. No effect from that permit could ever have started.
        const result = { outcome: 'rejected' as const, reason: 'file_write_not_started', proof: hash(['workspace-writer-no-intent', ownerId, target]) };
        try { capacity!.assertWritable('archive', 16384); } catch (error) { closing = true; throw error; }
        commit(() => journal!.prepare("INSERT INTO workspace_file_effects(save_id,owner_id,input_digest,intent_json,state,result_json) VALUES(?,?,?,?,'rejected',?)")
          .run(input.permit.saveId, input.permit.writerId!, inputDigest, JSON.stringify(target), JSON.stringify(result)));
        return result;
      }
      return reconcile(target);
    }
    if (input.permit.writerId !== ownerId) throw new Error('file_writer_owner_changed');
    if (old) return { outcome: 'unknown', reason: 'file_write_already_attempted' };
    const text = (input as WriterRequest).text;
    try { capacity!.assertWritable('admission', 32768); }
    catch {
      // Reserve enough journal space to durably reject a new identity. Old
      // receipts above remain readable, and recovery uses the reserve below.
      try { capacity!.assertWritable('archive', 16384); } catch (error) { closing = true; throw error; }
      const result = { outcome: 'rejected' as const, reason: 'file_writer_capacity_reached', proof: hash(['workspace-writer-capacity', ownerId, target]) };
      commit(() => journal!.prepare("INSERT INTO workspace_file_effects(save_id,owner_id,input_digest,intent_json,state,result_json) VALUES(?,?,?,?,'rejected',?)")
        .run(input.permit.saveId, ownerId!, inputDigest, JSON.stringify(target), JSON.stringify(result)));
      return result;
    }
    commit(() => journal!.prepare("INSERT INTO workspace_file_effects(save_id,owner_id,input_digest,intent_json,state) VALUES(?,?,?,?,'intent')")
      .run(input.permit.saveId, ownerId!, inputDigest, JSON.stringify(target)));
    await options.onStage?.('intent', input.permit.saveId);
    try {
      if (await realpath(input.root) !== input.root) return record(target, 'rejected', null, 'file_reference_changed');
      const before = await openWorkspaceDocument(input.root, input.permit.write.path, input.permit.write.directoryIdentity);
      if (before.kind === 'html' || before.kind === 'source') return record(target, 'rejected', null, 'file_read_only');
      if (before.version !== input.permit.write.expectedVersion) return record(target, 'rejected', { version: before.version }, 'file_version_changed');
    } catch (error) { return record(target, 'rejected', null, error instanceof Error && /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'file_reference_unavailable'); }
    try {
      const document = await saveWorkspaceDocument(input.root, input.permit.write.path, input.permit.write.expectedVersion, text, () => {
        if (!owner?.isTransaction) throw new Error('file_writer_owner_lost');
      }, input.permit.write.directoryIdentity);
      await options.onStage?.('renamed', input.permit.saveId);
      await syncParent(target);
      const result = record(target, 'committed', { version: document.version, digest: input.permit.write.contentDigest });
      await options.onStage?.('recorded', input.permit.saveId);
      return { ...result, document } as WriterResult;
    } catch { return reconcile(target); }
  }
  process.on('disconnect', () => { closing = true; close(); });
  process.on('SIGTERM', () => { closing = true; close(); });
  process.on('message', async message => {
    if (closing) return;
    if (!initialized) {
      initialized = true; active = true;
      try {
        const config = z.object({ type: z.literal('initialize'), dataDirectory: absolute,
          capacity: z.object({ quotaBytes: z.number().int().min(1024 ** 2).safe(), reserveBytes: z.number().int().nonnegative().safe(), minimumFreeBytes: z.number().int().nonnegative().safe() }).strict().optional(),
        }).strict().parse(message);
        owner = openDatabase(join(config.dataDirectory, 'owner'));
        owner.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
        journal = openDatabase(join(config.dataDirectory, 'journal'), journalMigration);
        capacity = createCapacityGuard(journal, { quotaBytes: 2 * 1024 ** 3, reserveBytes: 64 * 1024 ** 2, minimumFreeBytes: 512 * 1024 ** 2, ...config.capacity,
          sample() {
            let usedBytes = 0;
            for (const directory of ['owner', 'journal']) for (const suffix of ['', '-wal', '-shm']) {
              try { usedBytes += statSync(join(config.dataDirectory, directory, 'zhongshu.sqlite' + suffix)).size; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            const disk = statfsSync(config.dataDirectory, { bigint: true }); const free = disk.bavail * disk.bsize;
            return { usedBytes, freeBytes: Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free) };
          },
        });
        for (const path of [join(config.dataDirectory, 'journal'), join(config.dataDirectory, 'owner'), config.dataDirectory]) {
          const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await directory.sync(); } finally { await directory.close(); }
        }
        ownerId = randomUUID(); send({ type: 'ready', ownerId });
      } catch { closing = true; send({ type: 'fatal', code: 'file_writer_unavailable' }); }
      finally { active = false; if (closing) close(); }
      return;
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'close') { closing = true; close(); return; }
    const parsed = z.object({ type: z.literal('request'), id: z.number().int().positive().safe(), method: z.enum(['write', 'recover']), input: z.unknown() }).strict().safeParse(message);
    if (!parsed.success || active || parsed.data.id <= lastId) { send({ type: 'fatal', code: 'file_writer_protocol_invalid' }); closing = true; close(); return; }
    active = true; lastId = parsed.data.id;
    try { send({ type: 'result', id: lastId, result: await execute(parsed.data.method, parsed.data.input) }); }
    catch (error) { send({ type: 'result', id: lastId, error: error instanceof Error && /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'file_writer_rejected' }); }
    finally { active = false; if (closing) close(); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void serveWorkspaceWriter();

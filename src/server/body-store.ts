import { createHash, randomUUID, type Hash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { bodyFieldSchema, bodyReferenceSchema, type BodyReference, type BodyReferences } from '../shared/content.ts';
import type { NativeItem } from '../harness/types.ts';
import { StoreError } from './workbench-store.ts';

export const bodyChunkBytes = 64 * 1024;
export const itemPreviewBytes = 8 * 1024;
const idSchema = z.string().min(1).max(1024).refine(value => !value.includes('\0'));
export type BodyRead = { version: string; bytes: number; offset: number; nextOffset: number | null; data: Uint8Array };
export type BodyStage = { stageId: string; nextOffset: number; reference: BodyReference };

function boundedPreview(text: string, budget: number) {
  let end = 0; let used = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    const bytes = point < 0x20 ? ([8, 9, 10, 12, 13].includes(point) ? 2 : 6)
      : point === 34 || point === 92 ? 2 : point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used + bytes > budget) break;
    used += bytes; end += character.length;
  }
  return { text: text.slice(0, end), used, complete: end === text.length };
}

/** Compatible reads of pre-chunk databases. Their old schema bounds a field to
 * 1 MiB; only the finite preview crosses the worker boundary. A subsequent
 * replacement must preserve the old version before changing its source row.
 */
export function projectBodyPreview(item: NativeItem): NativeItem {
  let remaining = itemPreviewBytes; const bodies: BodyReferences = item.previewOnly ? {} : { ...item.bodies };
  const preview = (field: z.infer<typeof bodyFieldSchema>, text: string) => {
    const prefix = boundedPreview(text, remaining); remaining -= prefix.used;
    if (prefix.complete) return text;
    const bytes = Buffer.from(text);
    if (!item.previewOnly && !bodies[field]) bodies[field] = { version: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    return prefix.text;
  };
  const text = preview('text', item.text);
  const tool = item.tool ? { ...item.tool,
    ...(item.tool.input === undefined ? {} : { input: preview('input', item.tool.input) }),
    ...(item.tool.output === undefined ? {} : { output: preview('output', item.tool.output) }),
  } : undefined;
  const referencesText = item.references ? JSON.stringify(item.references, null, 2) : '';
  const references = preview('references', referencesText) === referencesText ? item.references : undefined;
  const result = { ...item, text, references, ...(tool ? { tool } : {}) };
  if (Object.keys(bodies).length) result.bodies = bodies; else delete result.bodies;
  return result;
}

/** Bodies remain private to an item even when immutable content is deduplicated.
 * All publication calls run inside the owning store's transaction. No native I/O
 * or user callbacks are allowed while that transaction is open.
 */
export function createBodyStore(db: DatabaseSync, options: { transientBytes?: number; assertRetentionCapacity?: (bytes: number) => void } = {}) {
  const transientBytes = options.transientBytes ?? 512 * 1024 ** 2;
  if (!Number.isSafeInteger(transientBytes) || transientBytes < bodyChunkBytes) throw new StoreError('invalid_storage_capacity', 500);
  const managed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_body_usage'").get());
  const revisions = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_body_stage_revisions'").get());
  const revisionSchema = z.object({ generation: z.string().min(1).max(256), sequence: z.number().int().nonnegative().safe() }).strict();
  const validations = new Map<string, { hash: Hash; offset: number; part: number; version: string }>();
  const owned = db.prepare(`SELECT b.bytes,b.chunks FROM workbench_body_refs r JOIN workbench_bodies b ON b.version=r.version
    WHERE r.conversation_id=? AND r.item_id=? AND r.field=? AND r.version=? AND b.complete=1`);
  const staged = db.prepare(`SELECT b.bytes,b.chunks,s.id FROM workbench_body_stages s JOIN workbench_bodies b ON b.version=s.version
    WHERE s.conversation_id=? AND s.item_id=? AND s.field=? AND s.version=? AND b.complete=1`);
  const bind = db.prepare('INSERT OR IGNORE INTO workbench_body_refs VALUES(?,?,?,?)');
  function assertCurrent(stageId: string) {
    if (revisions && db.prepare(`SELECT 1 FROM workbench_body_stages s JOIN workbench_body_heads h USING(conversation_id,item_id,field)
      JOIN workbench_body_stage_revisions r ON r.stage_id=s.id WHERE s.id=? AND s.version!=h.version AND r.generation=h.generation AND r.sequence<h.sequence`).get(stageId))
      throw new StoreError('body_stage_superseded', 409);
  }
  function begin(conversationId: string, itemId: string, field: z.infer<typeof bodyFieldSchema>, reference: BodyReference, sourceRevision?: NativeItem['sourceRevision']): BodyStage {
    if (!z.uuid().safeParse(conversationId).success || !idSchema.safeParse(itemId).success || !bodyFieldSchema.safeParse(field).success ||
      !bodyReferenceSchema.safeParse(reference).success || reference.bytes === 0) throw new StoreError('invalid_body_request', 400);
    if (sourceRevision !== undefined && !revisionSchema.safeParse(sourceRevision).success) throw new StoreError('invalid_body_request', 400);
    if (managed) {
      const old = db.prepare('SELECT id FROM workbench_body_stages WHERE conversation_id=? AND item_id=? AND field=? AND version=?').get(conversationId, itemId, field, reference.version);
      if (!old && Number(db.prepare('SELECT stages FROM workbench_body_usage WHERE id=1').get()!.stages) >= 4096) throw new StoreError('body_staging_capacity_reached', 507);
      // Reserve a complete body's declared bytes before accepting a new import.
      // Existing stages can finish inside their reservation even at the limit.
      if (revisions && !db.prepare('SELECT 1 FROM workbench_bodies WHERE version=?').get(reference.version) &&
        Number(db.prepare('SELECT reserved_bytes FROM workbench_body_usage WHERE id=1').get()!.reserved_bytes) + reference.bytes > transientBytes)
        throw new StoreError('body_staging_capacity_reached', 507);
    }
    db.prepare('INSERT OR IGNORE INTO workbench_bodies(version,bytes,chunks,complete) VALUES(?,?,?,0)').run(reference.version, reference.bytes, Math.ceil(reference.bytes / bodyChunkBytes));
    const manifest = db.prepare('SELECT bytes,complete FROM workbench_bodies WHERE version=?').get(reference.version)!;
    if (Number(manifest.bytes) !== reference.bytes) throw new StoreError('body_reference_invalid', 409);
    db.prepare('INSERT OR IGNORE INTO workbench_body_stages VALUES(?,?,?,?,?,?,?)').run(randomUUID(), conversationId, itemId, field, reference.version,
      manifest.complete === 1 ? reference.bytes : 0, Date.now());
    const stage = db.prepare('SELECT id,next_offset FROM workbench_body_stages WHERE conversation_id=? AND item_id=? AND field=? AND version=?').get(conversationId, itemId, field, reference.version)!;
    if (revisions && sourceRevision) db.prepare(`INSERT INTO workbench_body_stage_revisions VALUES(?,?,?) ON CONFLICT(stage_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence) WHERE generation=excluded.generation`)
      .run(String(stage.id), sourceRevision.generation, sourceRevision.sequence);
    return { stageId: String(stage.id), nextOffset: Number(stage.next_offset), reference };
  }
  function append(stageId: string, offset: number, data: Uint8Array): number {
    if (!z.uuid().safeParse(stageId).success || !Number.isSafeInteger(offset) || offset < 0 || offset % bodyChunkBytes !== 0 ||
      !(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > bodyChunkBytes) throw new StoreError('invalid_body_request', 400);
    assertCurrent(stageId);
    const stage = db.prepare('SELECT s.version,s.next_offset,b.bytes FROM workbench_body_stages s JOIN workbench_bodies b ON b.version=s.version WHERE s.id=?').get(stageId);
    if (!stage) throw new StoreError('body_stage_not_found', 404);
    if (offset > Number(stage.next_offset) || data.byteLength !== Math.min(bodyChunkBytes, Number(stage.bytes) - offset)) throw new StoreError('body_offset_invalid', 409);
    const previous = db.prepare('SELECT data FROM workbench_body_chunks WHERE version=? AND part=?').get(String(stage.version), offset / bodyChunkBytes);
    if (previous && !Buffer.from(previous.data as Uint8Array).equals(data)) throw new StoreError('body_chunk_conflict', 409);
    if (!previous && managed && db.prepare('SELECT retained FROM workbench_bodies WHERE version=?').get(String(stage.version))?.retained === 0 &&
      Number(db.prepare('SELECT transient_bytes FROM workbench_body_usage WHERE id=1').get()!.transient_bytes) + data.byteLength > transientBytes)
      throw new StoreError('body_staging_capacity_reached', 507);
    db.prepare('INSERT OR IGNORE INTO workbench_body_chunks VALUES(?,?,?)').run(String(stage.version), offset / bodyChunkBytes, data);
    const next = Math.max(Number(stage.next_offset), offset + data.byteLength);
    db.prepare('UPDATE workbench_body_stages SET next_offset=? WHERE id=?').run(next, stageId);
    return next;
  }
  function finish(stageId: string): BodyReference {
    if (!z.uuid().safeParse(stageId).success) throw new StoreError('invalid_body_request', 400);
    assertCurrent(stageId);
    const stage = db.prepare('SELECT s.version,s.next_offset,b.bytes,b.chunks,b.complete FROM workbench_body_stages s JOIN workbench_bodies b ON b.version=s.version WHERE s.id=?').get(stageId);
    if (!stage) throw new StoreError('body_stage_not_found', 404);
    const reference = { version: String(stage.version), bytes: Number(stage.bytes) };
    if (stage.complete !== 1) {
      if (Number(stage.next_offset) !== reference.bytes) throw new StoreError('body_incomplete', 409);
      const hash = createHash('sha256'); let part = 0; let bytes = 0;
      for (const row of db.prepare('SELECT part,data FROM workbench_body_chunks WHERE version=? ORDER BY part').iterate(reference.version)) {
        if (Number(row.part) !== part++ || !(row.data instanceof Uint8Array) || row.data.byteLength !== Math.min(bodyChunkBytes, reference.bytes - bytes)) throw new StoreError('body_incomplete', 409);
        bytes += row.data.byteLength; hash.update(row.data);
      }
      if (bytes !== reference.bytes || part !== Number(stage.chunks) || hash.digest('hex') !== reference.version) throw new StoreError('body_digest_mismatch', 409);
      db.prepare('UPDATE workbench_bodies SET complete=1 WHERE version=?').run(reference.version);
    }
    return reference;
  }
  /** Yield between 512 KiB hash batches so giant bodies cannot monopolize the
   * single storage worker. Hash state is bounded and disposable; after a crash
   * validation restarts from immutable chunks without re-downloading the body.
   */
  function validate(stageId: string): { complete: boolean; verifiedBytes: number } {
    if (!z.uuid().safeParse(stageId).success) throw new StoreError('invalid_body_request', 400);
    assertCurrent(stageId);
    const stage = db.prepare('SELECT s.version,s.next_offset,b.bytes,b.chunks,b.complete FROM workbench_body_stages s JOIN workbench_bodies b ON b.version=s.version WHERE s.id=?').get(stageId);
    if (!stage) throw new StoreError('body_stage_not_found', 404);
    const bytes = Number(stage.bytes);
    if (stage.complete === 1) { validations.delete(stageId); return { complete: true, verifiedBytes: bytes }; }
    if (Number(stage.next_offset) !== bytes) throw new StoreError('body_incomplete', 409);
    let progress = validations.get(stageId);
    if (!progress) {
      if (validations.size >= 32) validations.delete(validations.keys().next().value!);
      progress = { hash: createHash('sha256'), offset: 0, part: 0, version: String(stage.version) };
    }
    validations.delete(stageId); validations.set(stageId, progress);
    try {
      const before = progress.offset;
      for (const row of db.prepare('SELECT part,data FROM workbench_body_chunks WHERE version=? AND part>=? ORDER BY part LIMIT 8').iterate(progress.version, progress.part)) {
        if (Number(row.part) !== progress.part++ || !(row.data instanceof Uint8Array) || row.data.byteLength !== Math.min(bodyChunkBytes, bytes - progress.offset)) throw new StoreError('body_incomplete', 409);
        progress.offset += row.data.byteLength; progress.hash.update(row.data);
      }
      if (progress.offset === before && progress.offset < bytes) throw new StoreError('body_incomplete', 409);
      if (progress.offset < bytes) return { complete: false, verifiedBytes: progress.offset };
      if (progress.offset !== bytes || progress.part !== Number(stage.chunks) || progress.hash.digest('hex') !== progress.version) throw new StoreError('body_digest_mismatch', 409);
      db.prepare('UPDATE workbench_bodies SET complete=1 WHERE version=?').run(progress.version);
      validations.delete(stageId);
      return { complete: true, verifiedBytes: bytes };
    } catch (error) { validations.delete(stageId); throw error; }
  }
  function read(conversationId: string, itemId: string, field: z.infer<typeof bodyFieldSchema>, reference: BodyReference, offset = 0): BodyRead {
    if (!z.uuid().safeParse(conversationId).success || !idSchema.safeParse(itemId).success || !bodyFieldSchema.safeParse(field).success ||
      !bodyReferenceSchema.safeParse(reference).success || !Number.isSafeInteger(offset) || offset < 0 || offset % bodyChunkBytes !== 0)
      throw new StoreError('invalid_body_request', 400);
    const manifest = owned.get(conversationId, itemId, field, reference.version);
    if (!manifest) {
      const rows = db.prepare(`SELECT text,metadata_json FROM workbench_live_items WHERE conversation_id=? AND id=?
        UNION ALL SELECT text,metadata_json FROM workbench_items WHERE conversation_id=? AND id=?`).all(conversationId, itemId, conversationId, itemId);
      for (const row of rows) {
        const metadata = JSON.parse(String(row.metadata_json));
        if (metadata.previewOnly) continue;
        const text = field === 'text' ? row.text : field === 'references'
          ? (metadata.references ? JSON.stringify(metadata.references, null, 2) : undefined) : metadata.tool?.[field];
        if (typeof text !== 'string') continue;
        const bytes = Buffer.from(text);
        if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.version) continue;
        if (offset >= bytes.length && !(offset === 0 && bytes.length === 0)) throw new StoreError('body_offset_invalid', 416);
        const data = bytes.subarray(offset, offset + bodyChunkBytes); const next = offset + data.length;
        return { ...reference, offset, nextOffset: next < bytes.length ? next : null, data };
      }
      throw new StoreError('body_not_found', 404);
    }
    if (Number(manifest.bytes) !== reference.bytes) throw new StoreError('body_not_found', 404);
    if (offset >= reference.bytes && !(offset === 0 && reference.bytes === 0)) throw new StoreError('body_offset_invalid', 416);
    if (reference.bytes === 0) {
      if (Number(manifest.chunks) !== 0 || reference.version !== createHash('sha256').digest('hex')) throw new StoreError('body_incomplete', 503);
      return { ...reference, offset: 0, nextOffset: null, data: new Uint8Array(0) };
    }
    const row = db.prepare('SELECT data FROM workbench_body_chunks WHERE version=? AND part=?').get(reference.version, offset / bodyChunkBytes);
    if (!row || !(row.data instanceof Uint8Array) || row.data.byteLength !== Math.min(bodyChunkBytes, reference.bytes - offset))
      throw new StoreError('body_incomplete', 503);
    const next = offset + row.data.byteLength;
    return { ...reference, offset, nextOffset: next < reference.bytes ? next : null, data: row.data };
  }
  /** Inline completed fields become immutable records only when superseded.
   * Unchanged metadata and streaming drafts incur no body/chunk/ref writes.
   * The caller's item/checkpoint transaction also owns these retention writes.
   */
  function retainReplaced(conversationId: string, previous: NativeItem, replacement: NativeItem) {
    if (previous.status === 'running' || previous.previewOnly) return;
    const value = (item: NativeItem, field: z.infer<typeof bodyFieldSchema>) => field === 'text' ? item.text
      : field === 'references' ? item.references === undefined ? undefined : JSON.stringify(item.references, null, 2) : item.tool?.[field];
    const pending: { field: z.infer<typeof bodyFieldSchema>; bytes: Buffer; version: string }[] = [];
    for (const field of ['text', 'input', 'output', 'references'] as const) {
      if (previous.bodies?.[field]) continue; // Already published with immutable ownership.
      const old = value(previous, field); if (old === undefined) continue;
      const nextReference = replacement.bodies?.[field];
      if (!nextReference && old === value(replacement, field)) continue;
      const bytes = Buffer.from(old), version = createHash('sha256').update(bytes).digest('hex');
      if (nextReference?.version === version && nextReference.bytes === bytes.length || owned.get(conversationId, previous.id, field, version)) continue;
      pending.push({ field, bytes, version });
    }
    if (!pending.length) return;
    options.assertRetentionCapacity?.(pending.reduce((sum, entry) => sum + entry.bytes.length + 4096, 0));
    for (const { field, bytes, version } of pending) {
      const chunks = Math.ceil(bytes.length / bodyChunkBytes);
      db.prepare('INSERT OR IGNORE INTO workbench_bodies(version,bytes,chunks,complete) VALUES(?,?,?,0)').run(version, bytes.length, chunks);
      const manifest = db.prepare('SELECT bytes,chunks,complete FROM workbench_bodies WHERE version=?').get(version)!;
      if (Number(manifest.bytes) !== bytes.length || Number(manifest.chunks) !== chunks) throw new StoreError('body_reference_invalid', 409);
      if (manifest.complete !== 1) {
        const write = db.prepare('INSERT INTO workbench_body_chunks VALUES(?,?,?) ON CONFLICT(version,part) DO UPDATE SET data=excluded.data');
        for (let part = 0; part < chunks; part++) write.run(version, part, bytes.subarray(part * bodyChunkBytes, (part + 1) * bodyChunkBytes));
        db.prepare('UPDATE workbench_bodies SET complete=1 WHERE version=?').run(version);
      }
      bind.run(conversationId, previous.id, field, version);
    }
  }
  function publish(conversationId: string, item: NativeItem): NativeItem {
    let remaining = itemPreviewBytes;
    const bodies: BodyReferences = {};
    const preview = (field: z.infer<typeof bodyFieldSchema>, text: string): string => {
      const bytes = Buffer.from(text, 'utf8');
      const prefix = boundedPreview(text, remaining); remaining -= prefix.used;
      // A live projection is not an immutable complete body. The physical
      // reader supplies the authoritative revision after it becomes durable.
      if (item.previewOnly) return prefix.text;
      const previous = item.bodies?.[field];
      if (previous) {
        // Only this item's already published descriptor may travel back through
        // a historical merge; an adapter cannot manufacture a cross-item ref.
        const manifest = owned.get(conversationId, item.id, field, previous.version) ?? staged.get(conversationId, item.id, field, previous.version);
        if (!manifest || Number(manifest.bytes) !== previous.bytes) throw new StoreError('body_reference_invalid', 409);
        const first = db.prepare('SELECT data FROM workbench_body_chunks WHERE version=? AND part=0').get(previous.version);
        if (bytes.length > itemPreviewBytes || (previous.bytes === 0
          ? bytes.length !== 0 || Number(manifest.chunks) !== 0
          : !first || !(first.data instanceof Uint8Array) || !Buffer.from(first.data).subarray(0, bytes.length).equals(bytes)))
          throw new StoreError('body_preview_invalid', 409);
        bind.run(conversationId, item.id, field, previous.version);
        db.prepare('DELETE FROM workbench_body_stages WHERE conversation_id=? AND item_id=? AND field=? AND version=?').run(conversationId, item.id, field, previous.version);
        bodies[field] = previous;
      }
      if (prefix.complete) return text;
      if (previous) return prefix.text;
      const version = createHash('sha256').update(bytes).digest('hex');
      const chunks = Math.ceil(bytes.length / bodyChunkBytes);
      const inserted = db.prepare('INSERT OR IGNORE INTO workbench_bodies(version,bytes,chunks) VALUES(?,?,?)').run(version, bytes.length, chunks);
      if (Number(inserted.changes) || db.prepare('SELECT complete FROM workbench_bodies WHERE version=?').get(version)?.complete !== 1) {
        const write = db.prepare('INSERT INTO workbench_body_chunks VALUES(?,?,?) ON CONFLICT(version,part) DO UPDATE SET data=excluded.data');
        for (let part = 0; part < chunks; part++) write.run(version, part, bytes.subarray(part * bodyChunkBytes, (part + 1) * bodyChunkBytes));
        db.prepare('UPDATE workbench_bodies SET complete=1 WHERE version=?').run(version);
      }
      bind.run(conversationId, item.id, field, version);
      bodies[field] = { version, bytes: bytes.length };
      return prefix.text;
    };
    const text = preview('text', item.text);
    const tool = item.tool ? { ...item.tool,
      ...(item.tool.input === undefined ? {} : { input: preview('input', item.tool.input) }),
      ...(item.tool.output === undefined ? {} : { output: preview('output', item.tool.output) }),
    } : undefined;
    const referencesText = item.references ? JSON.stringify(item.references, null, 2) : '';
    const references = preview('references', referencesText) === referencesText ? item.references : undefined;
    const result = { ...item, text, references, ...(tool ? { tool } : {}) };
    if (Object.keys(bodies).length) result.bodies = bodies; else delete result.bodies;
    return result;
  }
  function confirmPublication(conversationId: string, item: NativeItem) {
    if (!revisions || !item.sourceRevision || item.previewOnly) return;
    for (const field of ['text', 'input', 'output'] as const) {
      const text = field === 'text' ? item.text : item.tool?.[field];
      if (text === undefined && !item.bodies?.[field]) continue;
      if (!db.prepare('SELECT 1 FROM workbench_body_stages WHERE conversation_id=? AND item_id=? AND field=? LIMIT 1').get(conversationId, item.id, field)) continue;
      const version = item.bodies?.[field]?.version ?? createHash('sha256').update(text!).digest('hex');
      db.prepare(`INSERT INTO workbench_body_heads(conversation_id,item_id,field,version,generation,sequence) VALUES(?,?,?,?,?,?)
        ON CONFLICT(conversation_id,item_id,field) DO UPDATE SET version=excluded.version,sequence=excluded.sequence
        WHERE generation=excluded.generation AND sequence<excluded.sequence`).run(conversationId, item.id, field, version, item.sourceRevision.generation, item.sourceRevision.sequence);
      db.prepare('INSERT OR IGNORE INTO workbench_body_retire VALUES(?,?,?)').run(conversationId, item.id, field);
    }
  }
  /** Only a published, comparable later source revision retires a stage.
   * Timeouts, concurrent begins and different source generations prove nothing. */
  function maintenance(): boolean {
    if (!revisions) return false;
    let changed = false;
    const key = db.prepare('SELECT * FROM workbench_body_retire ORDER BY conversation_id,item_id,field LIMIT 1').get();
    if (key) {
      const args = [String(key.conversation_id), String(key.item_id), String(key.field)];
      const rows = db.prepare(`SELECT s.id FROM workbench_body_stages s JOIN workbench_body_heads h USING(conversation_id,item_id,field)
        JOIN workbench_body_stage_revisions r ON r.stage_id=s.id
        WHERE s.conversation_id=? AND s.item_id=? AND s.field=? AND s.version!=h.version AND r.generation=h.generation AND r.sequence<h.sequence LIMIT 16`).all(...args);
      for (const row of rows) { db.prepare('DELETE FROM workbench_body_stages WHERE id=?').run(String(row.id)); validations.delete(String(row.id)); }
      if (rows.length < 16) db.prepare('DELETE FROM workbench_body_retire WHERE conversation_id=? AND item_id=? AND field=?').run(...args);
      changed = true;
    }
    const candidate = db.prepare('SELECT version FROM workbench_body_gc ORDER BY version LIMIT 1').get();
    if (candidate) {
      const version = String(candidate.version);
      // Recheck authority inside the same transaction, even if a legacy database
      // or interrupted migration supplied a stale candidate.
      const body = db.prepare('SELECT retained FROM workbench_bodies WHERE version=?').get(version);
      if (body?.retained === 0 && !db.prepare('SELECT 1 FROM workbench_body_stages WHERE version=? LIMIT 1').get(version)) {
        db.prepare('DELETE FROM workbench_body_chunks WHERE version=? AND part IN (SELECT part FROM workbench_body_chunks WHERE version=? ORDER BY part LIMIT 8)').run(version, version);
        if (!db.prepare('SELECT 1 FROM workbench_body_chunks WHERE version=? LIMIT 1').get(version)) db.prepare('DELETE FROM workbench_bodies WHERE version=?').run(version);
      } else db.prepare('DELETE FROM workbench_body_gc WHERE version=?').run(version);
      changed = true;
    }
    return changed;
  }
  return { publish, read, begin, append, validate, finish, confirmPublication, retainReplaced, maintenance };
}

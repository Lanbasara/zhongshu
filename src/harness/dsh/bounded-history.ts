import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding, HistoryPage, NativeBodyChunk, NativeBodySource, NativeItem } from '../types.ts';
import { HarnessError } from '../types.ts';
import { BoundedDshReader } from './bounded-reader.ts';
import type { BoundedItemGroup } from './bounded-reader.ts';
import { eventSchema, historyItems, itemFrom } from './native.ts';
import type { TurnOutline } from './native.ts';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pageCursor = z.object({ v: z.literal(2), binding: hash, generation: z.string().uuid(), through: integer, before: integer }).strict();
const bodyToken = z.object({ v: z.literal(1), binding: hash, generation: z.string().uuid(), seq: integer, field: z.enum(['text', 'input']), version: hash, bytes: integer, lease: z.string().uuid() }).strict();
const identity = (binding: Binding) => createHash('sha256').update(JSON.stringify([binding.id, binding.cwd])).digest('hex');
function decode<T>(value: string, schema: z.ZodType<T>, prefix: string): T {
  if (value.length > 2048 || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))) throw new HarnessError('history_cursor_invalid');
  try { return schema.parse(JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8'))); }
  catch { throw new HarnessError('history_cursor_invalid'); }
}
const encode = (prefix: string, value: unknown) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url');

export function boundedHistory(reader: BoundedDshReader) {
  async function releaseAll(leases: Iterable<string>) { for (const lease of leases) await reader.release(lease).catch(() => {}); }
  async function materialize(binding: Binding, generation: string, groups: BoundedItemGroup[]) {
    const source = { sessionId: binding.id, cwd: binding.cwd }, key = identity(binding);
    const items: NativeItem[] = [], allLeases = new Set<string>(); let processed = 0;
    try {
      for (const group of groups) {
        const leases = new Set<string>(), fields: NonNullable<NativeItem['bodySources']> = {};
        const events: z.infer<typeof eventSchema>[] = [], outline: TurnOutline = [];
        try {
          for (const row of group.records) {
            if (row.turn !== null && outline.at(-1)?.turn !== row.turn) outline.push({ turn: row.turn, seq: row.seq });
            if (row.raw && row.bytes <= 8192) { events.push(eventSchema.parse(JSON.parse(Buffer.from(row.raw).toString('utf8')))); continue; }
            const projected = await reader.project({ ...source, sourceGeneration: generation, seq: row.seq }), m = projected.metadata;
            for (const field of Object.values(projected.fields)) if (field.lease) leases.add(field.lease);
            const content = projected.fields.text ? [{ type: 'text', text: projected.fields.text.preview }] : [];
            const event = eventSchema.parse({ type: row.type, seq: row.seq, time: row.time, data: {
              turn: m['/data/turn'] ?? row.turn, step: m['/data/step'], interrupted: m['/data/interrupted'], callId: m['/data/callId'], name: m['/data/name'], input: projected.fields.input?.preview,
              source: { rpcId: m['/data/source/rpcId'] }, content, message: { content, toolCallId: m['/data/message/toolCallId'], isError: m['/data/message/isError'] },
              kind: m['/data/kind'], producerReported: m['/data/producerReported'], detail: m['/data/detail'], outcome: m['/data/outcome'],
              toolCall: { callId: m['/data/toolCall/callId'] }, reason: { kind: m['/data/reason/kind'] },
              meta: { path: m['/data/meta/path'], operation: m['/data/meta/operation'], diffs: m['/data/meta/hasDiffs'] ? [{}] : [] },
            } });
            events.push(event);
            if (!itemFrom(binding.id, event, false, row.turn ?? undefined)) continue;
            const reference = (field: 'text' | 'input'): NativeBodySource | undefined => {
              const body = projected.fields[field];
              return body ? { version: body.version, bytes: body.bytes, token: encode('bb1.', { v: 1, binding: key, generation, seq: row.seq, field, version: body.version, bytes: body.bytes, lease: body.lease }) } : undefined;
            };
            if (projected.fields.text) { fields.text = reference('text'); if (row.type === 'tool/result') fields.output = fields.text; }
            if (projected.fields.input) fields.input = reference('input');
          }
          const normalized = historyItems(binding.id, events, undefined, outline, binding.cwd);
          if (normalized.length > 1) throw new HarnessError('DSH_ITEM_IDENTITY_CONFLICT');
          const item = normalized[0];
          if (item) {
            const sequence = Math.max(...events.filter(event => itemFrom(binding.id, event, false, group.records.find(row => row.seq === event.seq)?.turn ?? undefined)?.id === item.id).map(event => event.seq));
            items.push({ ...item, sourceRevision: { generation, sequence }, ...(Object.keys(fields).length ? { bodySources: fields } : {}) });
            const used = new Set(Object.values(fields).map(field => decode(field!.token, bodyToken, 'bb1.').lease));
            for (const lease of leases) if (used.has(lease)) allLeases.add(lease); else await reader.release(lease);
          } else await releaseAll(leases);
          processed++;
        } catch (error) {
          await releaseAll(leases);
          if (processed && error instanceof Error && /^dsh_bounded_cache_(paused|item_capacity|lease_limit)$/.test(error.message)) break;
          throw error;
        }
      }
      return { items, processed };
    } catch (error) { await releaseAll(allLeases); throw error; }
  }
  async function history(binding: Binding, olderCursor?: string, limit = 30): Promise<HistoryPage> {
    z.number().int().min(1).max(100).parse(limit);
    const source = { sessionId: binding.id, cwd: binding.cwd }, key = identity(binding);
    let generation: string, through: number, before: number | undefined;
    if (olderCursor) {
      const cursor = decode(olderCursor, pageCursor, 'bd2.');
      if (cursor.binding !== key || cursor.before > cursor.through) throw new HarnessError('history_cursor_invalid');
      generation = cursor.generation; through = cursor.through; before = cursor.before;
    } else {
      const scan = await reader.scan(source); if (!scan.complete) throw new HarnessError('DSH_HISTORY_INDEXING');
      generation = scan.sourceGeneration; through = scan.throughSeq;
    }
    const page = await reader.items({ ...source, sourceGeneration: generation, throughSeq: through, beforeSeq: before, maxRecords: Math.min(limit, 16), maxBytes: 256 * 1024 });
    const result = await materialize(binding, generation, page.groups);
    const next = result.processed < page.groups.length ? page.groups[result.processed - 1]!.orderSeq : page.beforeSeq;
    return { items: result.items.reverse(), olderCursor: next === null ? null : encode('bd2.', { v: 2, binding: key, generation, through, before: next }) };
  }
  async function readItems(binding: Binding, ids: string[]): Promise<NativeItem[]> {
    z.array(z.string().min(1).max(1024)).min(1).max(16).parse(ids);
    const prefix = `dsh:${binding.id}:`, keys = ids.map(id => {
      if (!id.startsWith(prefix)) throw new HarnessError('DSH_BODY_IDENTITY_MISMATCH');
      const key = id.slice(prefix.length);
      if (!/^(?:tool:.{1,512}|assistant:[0-9]{1,16}:[0-9]{1,16}|event:[0-9]{1,16})$/.test(key)) throw new HarnessError('DSH_ITEM_IDENTITY_INVALID');
      return key;
    });
    const source = { sessionId: binding.id, cwd: binding.cwd }, scan = await reader.scan(source);
    if (!scan.complete) throw new HarnessError('DSH_HISTORY_INDEXING'); if (scan.throughSeq < 0) return [];
    const page = await reader.itemsByKeys({ ...source, sourceGeneration: scan.sourceGeneration, throughSeq: scan.throughSeq, keys });
    return (await materialize(binding, scan.sourceGeneration, page.groups)).items;
  }
  async function readBodyChunk(binding: Binding, token: string, offset: number, maxBytes: number): Promise<NativeBodyChunk> {
    const source = decode(token, bodyToken, 'bb1.');
    if (source.binding !== identity(binding)) throw new HarnessError('DSH_BODY_IDENTITY_MISMATCH');
    integer.parse(offset); z.number().int().min(1).max(64 * 1024).parse(maxBytes);
    const body = await reader.readBody({ sessionId: binding.id, cwd: binding.cwd, sourceGeneration: source.generation, seq: source.seq, field: source.field, offset, maxBytes, lease: source.lease });
    if (body.sha256 !== source.version || body.totalBytes !== source.bytes) throw new HarnessError('DSH_BODY_VERSION_MISMATCH');
    const next = offset + body.bytes.length;
    return { version: source.version, bytes: source.bytes, offset, data: body.bytes, nextOffset: next < source.bytes ? next : null };
  }
  async function releaseBodySource(binding: Binding, token: string): Promise<void> {
    const source = decode(token, bodyToken, 'bb1.'); if (source.binding !== identity(binding)) throw new HarnessError('DSH_BODY_IDENTITY_MISMATCH');
    await reader.release(source.lease);
  }
  return { history, readItems, readBodyChunk, releaseBodySource };
}

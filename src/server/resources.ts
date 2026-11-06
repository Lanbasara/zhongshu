import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { imageSchema, referenceSchema } from '../shared/content.ts';
import { createStorageAccounting, type StorageAccounting } from './storage.ts';

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export class ResourceError extends Error {
  readonly statusCode: number;
  constructor(code: string, statusCode = 400) { super(code); this.statusCode = statusCode; }
}
export function imageType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  const b = Buffer.from(data);
  if (b.length < 12 || b.length > MAX_IMAGE_BYTES) throw new ResourceError('image_size_invalid', 413);
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new ResourceError('unsupported_image');
}
export function decodeImage(value: string, limit = MAX_IMAGE_BYTES): Buffer {
  if (value.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ResourceError('invalid_image_data');
  const data = Buffer.from(value, 'base64');
  if (data.length > limit || data.toString('base64') !== value) throw new ResourceError('invalid_image_data');
  imageType(data); return data;
}
/** `upload` is application-owned and stops at the storage budget; `copy` is a regenerable native or workspace image copy. */
export type ResourceKind = 'upload' | 'copy';
export function createResourceStore(db: DatabaseSync, accounting: StorageAccounting = createStorageAccounting(db)) {
  function get(conversationId: string, id: string) {
    const row = db.prepare('SELECT * FROM workbench_resources WHERE conversation_id=? AND id=?').get(z.uuid().parse(conversationId), z.uuid().parse(id));
    if (!row) throw new ResourceError('image_unavailable', 404);
    return { id: String(row.id), name: String(row.name), mediaType: imageSchema.shape.mediaType.parse(row.media_type), data: Buffer.from(row.data as Uint8Array) };
  }
  return {
    get,
    owned(conversationId: string, owner: string) {
      const row = db.prepare('SELECT r.id FROM workbench_resources r JOIN workbench_resource_refs f ON f.resource_id=r.id WHERE r.conversation_id=? AND f.owner_id=? LIMIT 1').get(conversationId, owner);
      return row ? get(conversationId, String(row.id)) : undefined;
    },
    put(conversationId: string, name: string, data: Buffer, kind: ResourceKind = 'upload') {
      z.uuid().parse(conversationId); z.string().min(1).max(120).parse(name);
      const mediaType = imageType(data); const digest = createHash('sha256').update(data).digest('hex');
      const old = db.prepare('SELECT id FROM workbench_resources WHERE conversation_id=? AND digest=?').get(conversationId, digest);
      if (old) { const resource = get(conversationId, String(old.id)); return { id: resource.id, name: resource.name, mediaType: resource.mediaType }; }
      // Only unattached uploads expire. Pending operations and history pin resources durably.
      db.prepare('DELETE FROM workbench_resources WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM workbench_resource_refs WHERE resource_id=workbench_resources.id)').run(Date.now() - 7 * 86400_000);
      // The instance budget replaces the former fixed image quota (ADR 0014).
      if (kind === 'upload') accounting.assertRoom(data.length); else accounting.makeRoom(data.length);
      const id = randomUUID();
      db.prepare('INSERT INTO workbench_resources(id,conversation_id,name,media_type,data,digest,created_at) VALUES(?,?,?,?,?,?,?)').run(id, conversationId, name, mediaType, data, digest, Date.now());
      return { id, name, mediaType };
    },
    pin(conversationId: string, id: string, owner: string) {
      get(conversationId, id);
      db.prepare('INSERT OR IGNORE INTO workbench_resource_refs(resource_id,owner_id) VALUES(?,?)').run(id, owner);
    },
    remove(conversationId: string, id: string) {
      get(conversationId, id);
      db.prepare('DELETE FROM workbench_resources WHERE conversation_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM workbench_resource_refs WHERE resource_id=?)').run(conversationId, id, id);
    },
  };
}

/** No arbitrary server path is accepted: every component must remain in the configured workspace. */
async function scopedPath(root: string, path: string, directory = false): Promise<string> {
  if (path) referenceSchema.parse({ type: 'file', path });
  const canonicalRoot = await realpath(root);
  let target = canonicalRoot;
  for (const part of path.split('/').filter(Boolean)) {
    target = join(target, part); if ((await lstat(target)).isSymbolicLink()) throw new ResourceError('file_reference_forbidden', 403);
  }
  const canonical = await realpath(target); const inside = relative(canonicalRoot, canonical);
  if (inside.startsWith('..') || isAbsolute(inside) || (!directory && !inside)) throw new ResourceError('file_reference_forbidden', 403);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (directory ? !info.isDirectory() : !info.isFile()) throw new ResourceError('file_reference_unavailable'); }
  finally { await handle.close(); }
  return canonical;
}
export async function workspacePath(root: string, path: string, directory = false): Promise<string> {
  try { return await scopedPath(root, path, directory); }
  catch (error) { if (error instanceof ResourceError) throw error; throw new ResourceError('file_reference_unavailable', 409); }
}
export async function workspaceFiles(root: string, directory: string) {
  const target = await workspacePath(root, directory, true);
  const handle = await opendir(target);
  const entries = []; let scanned = 0;
  for await (const entry of handle) {
    if (++scanned > 2000 || entries.length >= 200) break;
    if (!entry.name.startsWith('.') && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())) entries.push(entry);
  }
  // A rename/symlink replacement during listing must not publish another directory's names.
  if (await workspacePath(root, directory, true) !== target) throw new ResourceError('file_reference_changed', 409);
  return entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(e => ({ path: directory ? directory + '/' + e.name : e.name, name: e.name, directory: e.isDirectory() }));
}

import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { referenceSchema } from '../shared/content.ts';
import { ResourceError } from './resources.ts';

const formats = new Map<string, 'markdown' | 'text' | 'html'>([['.md', 'markdown'], ['.markdown', 'markdown'], ['.txt', 'text'],
  ['.json', 'text'], ['.yaml', 'text'], ['.yml', 'text'], ['.toml', 'text'], ['.ini', 'text'], ['.html', 'html'], ['.htm', 'html']] as const);
export const textLimit = 256 * 1024;
const htmlLimit = 1024 * 1024;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export function directoryIdentity(info: BigIntStats): string | null {
  return info.ino > 0n && info.birthtimeNs > 0n ? [info.dev, info.ino, info.birthtimeNs].join(':') : null;
}

// On Linux each lookup is relative to an open directory, even if an Agent renames it.
async function withWorkspaceDirectory<T>(root: string, parts: string[], action: (directory: string) => Promise<T>, identity?: string): Promise<T> {
  async function walk(path: string, index: number): Promise<T> {
    const handle = await open(path, directoryFlags);
    try {
      if (index === 0 && identity && directoryIdentity(await handle.stat({ bigint: true })) !== identity)
        throw new ResourceError('workspace_directory_changed', 409);
      const anchored = process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : path;
      if (process.platform !== 'linux' && await realpath(path) !== path) throw new ResourceError('file_reference_forbidden', 403);
      if (index < parts.length) return await walk(join(anchored, parts[index]!), index + 1);
      const expected = join(root, ...parts);
      if (await realpath(anchored) !== expected) throw new ResourceError('file_reference_changed', 409);
      const result = await action(anchored);
      if (await realpath(anchored) !== expected) throw new ResourceError('file_reference_changed', 409);
      return result;
    } finally { await handle.close(); }
  }
  try {
    if (await realpath(root) !== root) throw new ResourceError('file_reference_forbidden', 403);
    return await walk(root, 0);
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    throw new ResourceError('file_reference_unavailable', 409);
  }
}

function documentParts(path: string, directory = false): string[] {
  if (!path && directory) return [];
  if (!referenceSchema.safeParse({ type: 'file', path }).success || path.split('/').some(part => part.startsWith('.')))
    throw new ResourceError('file_reference_forbidden', 403);
  return path.split('/');
}

function format(path: string) {
  const kind = formats.get(extname(path).toLowerCase());
  if (!kind) throw new ResourceError('file_type_unsupported', 415);
  return kind;
}

async function readDocument(directory: string, name: string, kind: ReturnType<typeof format>) {
  const file = join(directory, name);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new ResourceError('file_reference_forbidden', 403);
    const limit = kind === 'html' ? htmlLimit : textLimit;
    if (before.size > limit) throw new ResourceError('file_too_large', 413);
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
    if (length !== Number(before.size) || identity(before) !== identity(after) || identity(after) !== identity(current))
      throw new ResourceError('file_version_changed', 409);
    const bytes = buffer.subarray(0, length);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ResourceError('file_encoding_unsupported', 415); }
    if (text.includes('\0')) throw new ResourceError('file_encoding_unsupported', 415);
    const version = createHash('sha256').update(identity(after) + ':').update(bytes).digest('hex');
    return { text, kind, version, mode: Number(before.mode & 0o777n), uid: Number(before.uid), gid: Number(before.gid) };
  } finally { await handle.close(); }
}

export function openWorkspaceDocument(root: string, path: string, identity?: string) {
  const parts = documentParts(path);
  const kind = format(path);
  return withWorkspaceDirectory(root, parts.slice(0, -1), async directory => {
    const { mode: _mode, uid: _uid, gid: _gid, ...document } = await readDocument(directory, basename(path), kind);
    return document;
  }, identity);
}

export function saveWorkspaceDocument(root: string, path: string, version: string, text: string, assertWritable: () => void, identity?: string) {
  const parts = documentParts(path);
  const kind = format(path);
  if (kind === 'html') throw new ResourceError('file_read_only', 403);
  if (Buffer.byteLength(text) > textLimit) throw new ResourceError('file_too_large', 413);
  if (text.includes('\0') || /\p{Surrogate}/u.test(text)) throw new ResourceError('file_encoding_unsupported', 415);
  return withWorkspaceDirectory(root, parts.slice(0, -1), async directory => {
    const name = basename(path);
    const original = await readDocument(directory, name, kind);
    if (original.version !== version) throw new ResourceError('file_version_changed', 409);
    const temporary = join(directory, '.zhongshu-' + randomUUID());
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      const temporaryInfo = await handle.stat();
      if (temporaryInfo.uid !== original.uid || temporaryInfo.gid !== original.gid) {
        await handle.chown(original.uid, original.gid);
      }
      await handle.chmod(original.mode);
      await handle.sync();
      await handle.close();
      if ((await readDocument(directory, name, kind)).version !== version) throw new ResourceError('file_version_changed', 409);
      if (await realpath(directory) !== join(root, ...parts.slice(0, -1))) throw new ResourceError('file_reference_changed', 409);
      assertWritable();
      await rename(temporary, join(directory, name));
      const { mode: _mode, uid: _uid, gid: _gid, ...document } = await readDocument(directory, name, kind);
      return document;
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }, identity);
}

export function listWorkspaceDocuments(root: string, path: string, identity?: string) {
  return withWorkspaceDirectory(root, documentParts(path, true), async directory => {
    const entries = [];
    let scanned = 0;
    for await (const entry of await opendir(directory)) {
      if (++scanned > 2000 || entries.length >= 200) break;
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isFile())) continue;
      const relative = path ? path + '/' + entry.name : entry.name;
      if (!referenceSchema.safeParse({ type: 'file', path: relative }).success) continue;
      entries.push({ name: entry.name, path: relative, directory: entry.isDirectory(),
        supported: entry.isDirectory() || formats.has(extname(entry.name).toLowerCase()) });
    }
    return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }, identity);
}

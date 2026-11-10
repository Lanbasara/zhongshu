import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { workspaceDocumentPath } from '../shared/content.ts';
import { timelineLineSchema } from '../shared/automations.ts';
import { ResourceError } from './resources.ts';

const formats = new Map<string, 'markdown' | 'text' | 'html' | 'source'>([['.md', 'markdown'], ['.markdown', 'markdown'], ['.txt', 'text'],
  ['.json', 'text'], ['.yaml', 'text'], ['.yml', 'text'], ['.toml', 'text'], ['.ini', 'text'], ['.html', 'html'], ['.htm', 'html']] as const);
for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.css', '.scss', '.py', '.sh', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.sql']) {
  formats.set(extension, 'source');
}
export const textLimit = 256 * 1024;
const htmlLimit = 1024 * 1024;
/** ADR 0025: the timeline may grow to 10 MiB; a write compacts it once it reaches 8 MiB. */
export const TIMELINE_LIMIT_BYTES = 10 * 1024 * 1024;
export const TIMELINE_NEAR_LIMIT_BYTES = 8 * 1024 * 1024;
/** A file already past the cap can still be compacted; this bounds that recovery read. */
const TIMELINE_COMPACT_LIMIT_BYTES = 32 * 1024 * 1024;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export function directoryIdentity(info: BigIntStats): string | null {
  return info.ino > 0n && info.birthtimeNs > 0n ? [info.dev, info.ino, info.birthtimeNs].join(':') : null;
}
function fileIdentity(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(':');
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
  if (!workspaceDocumentPath.safeParse(path).success)
    throw new ResourceError('file_reference_forbidden', 403);
  return path.split('/');
}

function format(path: string) {
  const kind = formats.get(extname(path).toLowerCase());
  if (!kind) throw new ResourceError('file_type_unsupported', 415);
  return kind;
}

async function readDocument(directory: string, name: string, kind: ReturnType<typeof format>, maximum?: number) {
  const file = join(directory, name);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new ResourceError('file_reference_forbidden', 403);
    const limit = maximum ?? (kind === 'html' ? htmlLimit : textLimit);
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
    if (length !== Number(before.size) || fileIdentity(before) !== fileIdentity(after) || fileIdentity(after) !== fileIdentity(current))
      throw new ResourceError('file_version_changed', 409);
    const bytes = buffer.subarray(0, length);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ResourceError('file_encoding_unsupported', 415); }
    if (text.includes('\0')) throw new ResourceError('file_encoding_unsupported', 415);
    const version = createHash('sha256').update(fileIdentity(after) + ':').update(bytes).digest('hex');
    return { text, kind, version, identity: fileIdentity(after), mode: Number(before.mode & 0o777n), uid: Number(before.uid), gid: Number(before.gid) };
  } finally { await handle.close(); }
}

export function openWorkspaceDocument(root: string, path: string, identity?: string) {
  const parts = documentParts(path);
  const kind = format(path);
  return withWorkspaceDirectory(root, parts.slice(0, -1), async directory => {
    const { mode: _mode, uid: _uid, gid: _gid, identity: _identity, ...document } = await readDocument(directory, basename(path), kind);
    return document;
  }, identity);
}

/** Cheap identity of the timeline file, so an unchanged file is not read or parsed again (ADR 0025). */
export async function workspaceTimelineStat(root: string, identity?: string): Promise<{ identity: string; size: number } | null> {
  try {
    return await withWorkspaceDirectory(root, ['.zhongshu'], async directory => {
      const handle = await open(join(directory, 'timeline.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.nlink !== 1n) throw new ResourceError('file_reference_forbidden', 403);
        return { identity: fileIdentity(info), size: Number(info.size) };
      } finally { await handle.close(); }
    }, identity);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || (error instanceof ResourceError && error.message === 'file_reference_unavailable')) return null;
    throw error;
  }
}

/**
 * The workspace timeline (ADR 0021): agents append `.zhongshu/timeline.jsonl`; Zhongshu only reads it. The hidden
 * path is fixed here and never served by the document reader. A workspace without the file has no timeline.
 */
export async function readWorkspaceTimelineFile(root: string, identity?: string): Promise<{ text: string; identity: string; size: number } | null> {
  try {
    return await withWorkspaceDirectory(root, ['.zhongshu'], async directory => {
      const document = await readDocument(directory, 'timeline.jsonl', 'text', TIMELINE_LIMIT_BYTES);
      return { text: document.text, identity: document.identity, size: Buffer.byteLength(document.text) };
    }, identity);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || (error instanceof ResourceError && error.message === 'file_reference_unavailable')) return null;
    throw error;
  }
}

/** The text form kept for callers that only need the lines (司辰's commands and tests). */
export async function readWorkspaceTimeline(root: string, identity?: string): Promise<string | null> {
  return (await readWorkspaceTimelineFile(root, identity))?.text ?? null;
}

/** Keep the last line per id; malformed lines stay so the "problems" report does not change (ADR 0025). */
export function compactTimeline(text: string): string {
  const lines = text.split('\n');
  const last = new Map<string, number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim(); if (!line) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const parsed = timelineLineSchema.safeParse(raw);
    if (parsed.success) last.set(parsed.data.id, index);
  }
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) { kept.push(line); continue; }
    let id: string | undefined;
    try { const parsed = timelineLineSchema.safeParse(JSON.parse(trimmed)); if (parsed.success) id = parsed.data.id; } catch { /* malformed lines are kept */ }
    if (id !== undefined && last.get(id) !== index) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Writes to one timeline are serialized: a compaction rewrite must not swallow an append (ADR 0025). */
const timelineWrites = new Map<string, Promise<unknown>>();
async function withTimelineWrite<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = timelineWrites.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  timelineWrites.set(root, tail);
  await previous.catch(() => {});
  try { return await action(); }
  finally { release(); if (timelineWrites.get(root) === tail) timelineWrites.delete(root); }
}

/** Replace a file's text atomically, keeping its owner and mode. */
async function replaceFile(directory: string, file: string, text: string, original: { mode: number; uid: number; gid: number }) {
  const temporary = join(directory, '.zhongshu-' + randomUUID());
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    const info = await handle.stat();
    if (info.uid !== original.uid || info.gid !== original.gid) await handle.chown(original.uid, original.gid);
    await handle.chmod(original.mode);
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/**
 * Append one already validated line to the workspace timeline (司辰, ADR 0022). The hidden directory is created inside
 * the workspace when missing; links and other escapes are refused like any workspace path. Near the size limit the
 * file is compacted first, so the visible entries stay the same while the file stays writable (ADR 0025).
 */
export async function appendWorkspaceTimeline(root: string, line: string, identity?: string): Promise<void> {
  if (line.includes('\n') || Buffer.byteLength(line) > 4096) throw new ResourceError('timeline_line_invalid', 400);
  await withWorkspaceDirectory(root, [], async directory => {
    try { await mkdir(join(directory, '.zhongshu'), { mode: 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }, identity);
  await withTimelineWrite(root, () => withWorkspaceDirectory(root, ['.zhongshu'], async directory => {
    const file = join(directory, 'timeline.jsonl');
    let existing = await lstat(file).catch(() => undefined);
    if (existing && !existing.isFile()) throw new ResourceError('file_reference_forbidden', 403);
    if (existing && existing.size >= TIMELINE_NEAR_LIMIT_BYTES) {
      const document = await readDocument(directory, 'timeline.jsonl', 'text', TIMELINE_COMPACT_LIMIT_BYTES);
      const compacted = compactTimeline(document.text);
      if (compacted !== document.text) {
        await replaceFile(directory, file, compacted, document);
        existing = await lstat(file);
      }
    }
    if (existing && existing.size > TIMELINE_LIMIT_BYTES) throw new ResourceError('file_too_large', 413);
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      // A file that does not end with a newline gets one first, so the new line never joins the last one.
      const size = (await handle.stat()).size;
      let prefix = '';
      if (size > 0) { const reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const last = Buffer.alloc(1); await reader.read(last, 0, 1, size - 1); if (last[0] !== 10) prefix = '\n'; } finally { await reader.close(); } }
      await handle.write(prefix + line + '\n');
    } finally { await handle.close(); }
  }, identity));
}

export function saveWorkspaceDocument(root: string, path: string, version: string, text: string, assertWritable: () => void, identity?: string) {
  const parts = documentParts(path);
  const kind = format(path);
  if (kind === 'html' || kind === 'source') throw new ResourceError('file_read_only', 403);
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
      const { mode: _mode, uid: _uid, gid: _gid, identity: _identity, ...document } = await readDocument(directory, name, kind);
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
      if (!workspaceDocumentPath.safeParse(relative).success) continue;
      entries.push({ name: entry.name, path: relative, directory: entry.isDirectory(),
        supported: entry.isDirectory() || formats.has(extname(entry.name).toLowerCase()) });
    }
    return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }, identity);
}

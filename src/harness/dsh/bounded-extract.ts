import { open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { BoundedJsonEnvelope } from './bounded-json.ts';

export type ExtractedField = { version: string; bytes: number; preview: string; lease?: string };
export type ExtractedRecord = { metadata: Record<string, unknown>; fields: Partial<Record<'text' | 'input', ExtractedField>> };
type Action = { type: 'string'; path: string; text: string; final: boolean } | { type: 'value'; path: string; value: unknown } | { type: 'end'; path: string } | { type: 'span'; path: string; start: number; end: number };
async function write(handle: FileHandle, data: Buffer, offset: number) {
  for (let written = 0; written < data.length;) { const result = await handle.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw new Error('dsh_bounded_cache_write_failed'); written += result.bytesWritten; }
}
type RangeSource = { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> };
async function read(handle: RangeSource, offset: number, length: number) {
  const buffer = Buffer.alloc(length); let read = 0;
  while (read < length) { const result = await handle.read(buffer, read, length - read, offset + read); if (!result.bytesRead) throw new Error('dsh_bounded_source_changed'); read += result.bytesRead; }
  return buffer;
}

/** Decode selected JSON strings incrementally; text-before-type blocks remain on disk until their type is known. */
export async function extractRecord(source: RangeSource, offset: number, length: number, target: (field: string) => string, budget: number): Promise<ExtractedRecord> {
  const token = randomUUID(), staging = target(`stage-${token}`), candidatePath = target(`candidate-${token}`);
  const candidate = await open(candidatePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const text = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600).catch(async error => { await candidate.close(); await rm(candidatePath, { force: true }); throw error; });
  let textBytes = 0, candidateBytes = 0; const textHash = createHash('sha256'); const previews: Buffer[] = []; let previewBytes = 0;
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const fields: ExtractedRecord['fields'] = {}; let actions: Action[] = [];
  const blocks = new Map<string, { type?: unknown; start?: number; end?: number }>();
  const inputs = new Map<string, { start: number; end: number; string?: boolean }>();
  const inputStrings = new Map<string, { start: number; end: number }>();
  const parser = new BoundedJsonEnvelope({
    string(path, value, final) { actions.push({ type: 'string', path, text: value, final }); },
    value(path, value) { actions.push({ type: 'value', path, value }); },
    end(path) { actions.push({ type: 'end', path }); },
    span(path, start, end) { if (/^\/data\/(input|arguments)$/.test(path)) actions.push({ type: 'span', path, start, end }); if (path === '/data/meta/diffs/0') actions.push({ type: 'value', path: '/data/meta/hasDiffs', value: true }); },
  });
  const preview = (value: Buffer) => { if (previewBytes < 8192) { const piece = Buffer.from(value.subarray(0, 8192 - previewBytes)); previews.push(piece); previewBytes += piece.length; } };
  const copyText = async (start: number, end: number) => {
    for (let cursor = start; cursor < end; cursor += 64 * 1024) {
      const bytes = await read(candidate, cursor, Math.min(64 * 1024, end - cursor));
      if (textBytes + bytes.length > budget) throw new Error('dsh_bounded_cache_capacity');
      await write(text, bytes, textBytes); textHash.update(bytes); preview(bytes); textBytes += bytes.length;
    }
  };
  const consume = async () => {
    for (const action of actions) {
      const blockPath = /^\/data\/(?:message\/)?content\/\d+/.exec(action.path)?.[0];
      if (action.type === 'string') {
        const bytes = Buffer.from(action.text, 'utf8');
        if (candidateBytes + bytes.length > budget) throw new Error('dsh_bounded_cache_capacity');
        if (blockPath) { const block = blocks.get(blockPath) ?? {}; block.start ??= candidateBytes; await write(candidate, bytes, candidateBytes); candidateBytes += bytes.length; block.end = candidateBytes; blocks.set(blockPath, block); }
        else { const range = inputStrings.get(action.path) ?? { start: candidateBytes, end: candidateBytes }; await write(candidate, bytes, candidateBytes); candidateBytes += bytes.length; range.end = candidateBytes; inputStrings.set(action.path, range); }
      } else if (action.type === 'value') {
        if (blockPath && action.path.endsWith('/type')) { const block = blocks.get(blockPath) ?? {}; block.type = action.value; blocks.set(blockPath, block); }
        else metadata[action.path] = action.value;
      } else if (action.type === 'end' && action.path === blockPath) {
        const block = blocks.get(blockPath);
        if (block?.type === 'text' && block.start !== undefined && block.end !== undefined) await copyText(block.start, block.end);
        blocks.delete(blockPath);
      } else if (action.type === 'span') inputs.set(action.path, { start: action.start, end: action.end, string: inputStrings.has(action.path) });
    }
    actions = [];
  };
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let cursor = 0; cursor < length; cursor += 64 * 1024) { parser.write(decoder.decode(await read(source, offset + cursor, Math.min(64 * 1024, length - cursor)), { stream: true })); await consume(); }
    parser.write(decoder.decode()); const envelope = parser.finish(); await consume();
    metadata['/type'] = envelope.type; metadata['/seq'] = envelope.seq; metadata['/time'] = envelope.time;
    if (envelope.turn !== undefined) metadata['/data/turn'] = envelope.turn;
    const previewText = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    await text.sync();
    if (textBytes) { fields.text = { version: textHash.digest('hex'), bytes: textBytes, preview: previewBytes === textBytes ? Buffer.concat(previews).toString('utf8') : previewText(Buffer.concat(previews)) }; await text.close(); await rename(staging, target('text')); }
    else await text.close();
    const inputPath = inputs.has('/data/input') && metadata['/data/input'] !== null ? '/data/input' : '/data/arguments';
    const range = inputs.get(inputPath);
    if (range) {
      const from = range.string ? candidate : source, span = range.string ? inputStrings.get(inputPath)! : { start: offset + range.start, end: offset + range.end };
      const file = await open(target(`input-stage-${token}`), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const hash = createHash('sha256'); const head: Buffer[] = []; let headBytes = 0, written = 0;
        for (let cursor = span.start; cursor < span.end; cursor += 64 * 1024) { const chunk = await read(from, cursor, Math.min(64 * 1024, span.end - cursor)); if (written + chunk.length > budget) throw new Error('dsh_bounded_cache_capacity'); await write(file, chunk, written); written += chunk.length; hash.update(chunk); if (headBytes < 8192) { const prefix = Buffer.from(chunk.subarray(0, 8192 - headBytes)); head.push(prefix); headBytes += prefix.length; } }
        await file.sync(); fields.input = { version: hash.digest('hex'), bytes: written, preview: written === headBytes ? Buffer.concat(head).toString('utf8') : previewText(Buffer.concat(head)) };
      } finally { await file.close(); }
      await rename(target(`input-stage-${token}`), target('input'));
    }
    return { metadata, fields };
  } finally { await text.close().catch(() => {}); await candidate.close(); await rm(staging, { force: true }); await rm(candidatePath, { force: true }); await rm(target(`input-stage-${token}`), { force: true }); }
}

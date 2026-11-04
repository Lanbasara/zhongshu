import { lstatSync, opendirSync, statfsSync, statSync, type Dir } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { StoreError } from './workbench-store.ts';

export type CapacityOptions = { quotaBytes?: number; reserveBytes?: number; minimumFreeBytes?: number; transientBytes?: number; sample?: () => { usedBytes: number; freeBytes: number } };
export type StorageCapacity = { status: 'ok' | 'warning' | 'full' | 'unknown'; usedBytes: number; freeBytes: number; quotaBytes: number; reserveBytes: number; stagedBytes?: number; stagedReservedBytes?: number; stagedLimitBytes?: number };

/** Count product caches in finite slices without following links or loading an
 * entire directory. The database and WAL are sampled live separately below. */
function directoryUsage(root: string, databaseFile: string) {
  let stack: { path: string; directory: Dir }[] = [];
  let total = 0; let previous: number | undefined; let completedAt = 0;
  let deadline: NodeJS.Timeout | undefined;
  function close() { for (const frame of stack) { try { frame.directory.closeSync(); } catch { /* already closed */ } } stack = []; if (deadline) clearTimeout(deadline); deadline = undefined; }
  function sample() {
    if (!stack.length && Date.now() - completedAt < 1000 && previous !== undefined) return previous;
    try {
      if (!stack.length) { total = 0; stack.push({ path: root, directory: opendirSync(root) }); }
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => { close(); completedAt = 0; }, 30_000); deadline.unref();
      for (let budget = 128; budget > 0 && stack.length; budget--) {
        const frame = stack.at(-1)!; const entry = frame.directory.readSync();
        if (!entry) { frame.directory.closeSync(); stack.pop(); continue; }
        const path = join(frame.path, entry.name);
        if (path === databaseFile || path === databaseFile + '-wal' || path === databaseFile + '-shm') continue;
        let info;
        try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        // A link is an entry owned by this directory, not permission to count
        // or traverse its target. Sockets/devices likewise have no file body.
        if (info.isSymbolicLink()) { total += info.size; continue; }
        if (info.isDirectory()) {
          if (stack.length >= 32) throw new Error('capacity_depth_exceeded');
          try { stack.push({ path, directory: opendirSync(path) }); }
          catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        } else if (info.isFile()) total += info.size;
        else total += info.size;
      }
      if (stack.length) {
        if (previous === undefined) throw new Error('capacity_scan_initializing');
        return Math.max(previous, total);
      }
      previous = total; completedAt = Date.now(); close(); return total;
    } catch (error) {
      if ((error as Error).message !== 'capacity_scan_initializing') { close(); previous = undefined; completedAt = 0; }
      throw error;
    }
  }
  return { sample, pending: () => stack.length > 0, close };
}
const scans = new WeakMap<DatabaseSync, ReturnType<typeof directoryUsage>>();

/** A capacity failure pauses admission/backfill. It never deletes old records,
 * retries a native mutation, or cancels work already admitted to the Harness.
 * WAL is counted separately: a long reader must not hide its physical cost.
 */
export function createCapacityGuard(db: DatabaseSync, options: CapacityOptions = {}) {
  const quotaBytes = options.quotaBytes ?? 32 * 1024 ** 3;
  const reserveBytes = options.reserveBytes ?? Math.min(256 * 1024 ** 2, Math.floor(quotaBytes / 4));
  const minimumFreeBytes = options.minimumFreeBytes ?? 512 * 1024 ** 2;
  const stagedLimitBytes = options.transientBytes ?? 512 * 1024 ** 2;
  const reserved = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_body_stage_revisions'").get());
  const stagedUsage = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='workbench_body_usage'").get()
    ? db.prepare(`SELECT transient_bytes,${reserved ? 'reserved_bytes' : 'transient_bytes AS reserved_bytes'} FROM workbench_body_usage WHERE id=1`) : undefined;
  if (![quotaBytes, reserveBytes, minimumFreeBytes].every(value => Number.isSafeInteger(value) && value >= 0) || quotaBytes < 1024 ** 2 || reserveBytes >= quotaBytes)
    throw new StoreError('invalid_storage_capacity', 500);
  const file = String(db.prepare('PRAGMA database_list').get()?.file ?? '');
  let scan = scans.get(db);
  if (!options.sample && !scan && file) { scan = directoryUsage(dirname(file), file); scans.set(db, scan); }
  const sample = options.sample ?? (() => {
    if (!file) throw new Error('storage_location_unavailable');
    const disk = statfsSync(dirname(file), { bigint: true });
    const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0) * Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
    let usedBytes = Math.max(pages, statSync(file).size) + scan!.sample();
    for (const suffix of ['-wal', '-shm']) {
      try { usedBytes += statSync(file + suffix).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const free = disk.bavail * disk.bsize;
    return { usedBytes, freeBytes: Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free) };
  });
  let admissionFull = false;
  function status(): StorageCapacity {
    try {
      const { usedBytes, freeBytes } = sample();
      if (![usedBytes, freeBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid_storage_sample');
      const recoveryBytes = Math.min(16 * 1024 ** 2, Math.max(65536, Math.floor(quotaBytes / 100)));
      const staged = stagedUsage?.get(); const stagedBytes = Number(staged?.transient_bytes ?? 0); const stagedReservedBytes = Number(staged?.reserved_bytes ?? 0);
      const full = usedBytes + reserveBytes >= quotaBytes || freeBytes <= minimumFreeBytes || stagedReservedBytes >= stagedLimitBytes;
      admissionFull = full || (admissionFull && (usedBytes + reserveBytes + recoveryBytes >= quotaBytes || freeBytes < minimumFreeBytes + recoveryBytes || stagedReservedBytes > stagedLimitBytes - Math.min(65536, stagedLimitBytes / 4)));
      return { usedBytes, freeBytes, quotaBytes, reserveBytes, ...(stagedUsage ? { stagedBytes, stagedReservedBytes, stagedLimitBytes } : {}),
        status: admissionFull ? 'full'
          : usedBytes >= quotaBytes * 0.8 || freeBytes <= minimumFreeBytes * 2 || stagedReservedBytes >= stagedLimitBytes * 0.8 ? 'warning' : 'ok' };
    } catch { return { status: 'unknown', usedBytes: 0, freeBytes: 0, quotaBytes, reserveBytes }; }
  }
  function assertWritable(kind: 'admission' | 'archive', additionalBytes = 0) {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new StoreError('invalid_storage_size', 400);
    const current = status();
    const reserve = kind === 'admission' ? reserveBytes : 0;
    const freeReserve = kind === 'admission' ? minimumFreeBytes : Math.min(minimumFreeBytes, 16 * 1024 ** 2);
    // Two copies budget the database page and WAL publication. Filesystem full
    // can still race this sample; SQLite rollback remains the final authority.
    if (current.status === 'unknown' || (kind === 'admission' && current.status === 'full') || current.usedBytes + additionalBytes * 2 + reserve >= quotaBytes ||
      current.freeBytes < additionalBytes * 2 + freeReserve) throw new StoreError('storage_capacity_reached', 507);
  }
  return { status, assertWritable, pending: () => scan?.pending() ?? false, close: () => scan?.close() };
}

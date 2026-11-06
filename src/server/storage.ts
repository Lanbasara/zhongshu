import type { DatabaseSync } from 'node:sqlite';

/** Default instance budget for the application database (ADR 0014). */
export const DEFAULT_STORAGE_BUDGET = 16 * 1024 ** 3;
export const STORAGE_WARNING_RATIO = 0.8;
/** Native image copies are regenerable from the Harness; every other resource is application-owned. */
export const NATIVE_IMAGE_OWNER = 'native:';
const LEGACY_REFRESH_MS = 60_000;

export type StorageUsage = {
  used: number; budget: number; warning: boolean; full: boolean;
  images: { owned: number; cache: number };
  /** Retired history projection tables (pages via dbstat), excluded from `used` until a later migration removes them. */
  legacy: number;
};

const cacheResources = `SELECT r.id, length(r.data) AS bytes FROM workbench_resources r
  WHERE EXISTS (SELECT 1 FROM workbench_resource_refs f WHERE f.resource_id = r.id AND f.owner_id LIKE 'native:%')
    AND NOT EXISTS (SELECT 1 FROM workbench_resource_refs f WHERE f.resource_id = r.id AND f.owner_id NOT LIKE 'native:%')`;

/** Counts live database pages, so deleted rows count as free immediately, without waiting for a vacuum. */
export function createStorageAccounting(db: DatabaseSync, budget = DEFAULT_STORAGE_BUDGET) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('invalid_storage_budget');
  let legacy = 0; let legacyAt = -Infinity;
  const legacyTables = ['workbench_items', 'workbench_live_items'];
  const legacyBytes = (): number => {
    if (Date.now() - legacyAt < LEGACY_REFRESH_MS) return legacy;
    let total = 0;
    const present = legacyTables.filter(table => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
    // Empty retired tables hold no history copy; their few structural pages are not reported.
    if (!present.some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) { legacy = 0; legacyAt = Date.now(); return 0; }
    try {
      // Exact pages of the retired tables and their indexes, when SQLite provides dbstat.
      total = Number(db.prepare(`SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name IN
        (SELECT name FROM sqlite_schema WHERE tbl_name IN (${legacyTables.map(() => '?').join(',')}))`).get(...legacyTables)!.n);
    } catch {
      for (const table of legacyTables) {
        if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue;
        total += Number(db.prepare(`SELECT COALESCE(SUM(length(text) + COALESCE(length(metadata_json), 0) + 96), 0) AS n FROM ${table}`).get()!.n);
      }
    }
    legacy = total; legacyAt = Date.now();
    return legacy;
  };
  const pages = (): number => {
    const count = Number(db.prepare('PRAGMA page_count').get()!.page_count);
    const free = Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count);
    const size = Number(db.prepare('PRAGMA page_size').get()!.page_size);
    return Math.max(0, (count - free) * size);
  };
  const used = (): number => Math.max(0, pages() - legacyBytes());
  function evictCache(bytes: number): number {
    let freed = 0;
    const rows = db.prepare(`${cacheResources} ORDER BY r.created_at LIMIT 256`).all();
    const dropRefs = db.prepare('DELETE FROM workbench_resource_refs WHERE resource_id = ?');
    const drop = db.prepare('DELETE FROM workbench_resources WHERE id = ?');
    for (const row of rows) {
      if (freed >= bytes) break;
      dropRefs.run(String(row.id)); drop.run(String(row.id)); freed += Number(row.bytes);
    }
    return freed;
  }
  return {
    budget,
    used,
    usage(): StorageUsage {
      const value = used();
      const owned = Number(db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM workbench_resources').get()!.n);
      const cache = Number(db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM (${cacheResources})`).get()!.n);
      return { used: value, budget, warning: value >= budget * STORAGE_WARNING_RATIO, full: value >= budget,
        images: { owned: owned - cache, cache }, legacy: legacyBytes() };
    },
    /** Uploads and new conversations stop at the budget; everything else keeps working. */
    assertRoom(bytes = 0): void {
      if (used() + bytes > budget) throw new StorageBudgetError();
    },
    /** Make room for a regenerable native image copy by dropping the oldest copies first. */
    makeRoom(bytes: number): void {
      const over = used() + bytes - budget;
      if (over > 0) evictCache(over);
    },
    clearCache(): number {
      let freed = 0;
      for (;;) { const step = evictCache(Number.MAX_SAFE_INTEGER); freed += step; if (!step) break; }
      return freed;
    },
  };
}
export type StorageAccounting = ReturnType<typeof createStorageAccounting>;

export class StorageBudgetError extends Error {
  readonly code = 'storage_budget_reached';
  readonly statusCode = 507;
  constructor() { super('storage_budget_reached'); this.name = 'StorageBudgetError'; }
}

/** Accepts a byte count or a binary unit such as `16GiB`, `512MiB`. */
export function parseStorageBudget(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_STORAGE_BUDGET;
  const match = /^\s*(\d{1,15})\s*(B|KiB|MiB|GiB|TiB)?\s*$/i.exec(value);
  if (!match) throw new Error('invalid_storage_budget');
  const units: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  const bytes = Number(match[1]) * units[(match[2] ?? 'B').toLowerCase()]!;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 ** 2) throw new Error('invalid_storage_budget');
  return bytes;
}

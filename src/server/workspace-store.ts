import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { workspaceIdSchema, workspaceLabelSchema } from '../shared/workbench.ts';
import { StoreError } from './workbench-store.ts';
import { createCapacityGuard, type CapacityOptions } from './storage-capacity.ts';

const registrationSchema = z.object({ id: workspaceIdSchema, label: workspaceLabelSchema,
  directory: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0')),
  identity: z.string().min(1).max(200), root_id: workspaceIdSchema.nullable(), pinned: z.union([z.literal(0), z.literal(1)]), removed: z.union([z.literal(0), z.literal(1)]),
}).strict();
export type Registration = z.infer<typeof registrationSchema>;
const querySchema = z.object({ cursor: z.string().max(4096).optional(), query: z.string().max(200).default(''), removed: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(50) }).strict();
const cursorSchema = z.object({ generation: z.number().int().nonnegative().safe(), query: z.string().max(200), removed: z.boolean(),
  key: z.object({ id: workspaceIdSchema, label: workspaceLabelSchema, pinned: z.union([z.literal(0), z.literal(1)]) }).strict(),
}).strict();
export type WorkspacePageQuery = z.input<typeof querySchema>;

/** Metadata commands own their entire SQL transaction. Directory verification
 * and native process checks are separate prerequisites, never callbacks in SQL.
 */
export function createWorkspaceStore(db: DatabaseSync, capacity?: CapacityOptions) {
  const guard = createCapacityGuard(db, capacity);
  function transaction<T>(action: () => T, read = false): T {
    db.exec(read ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve the original uncertainty */ } throw error; }
  }
  function get(id: string): Registration | undefined {
    workspaceIdSchema.parse(id);
    const row = db.prepare('SELECT * FROM workbench_workspaces WHERE id=?').get(id);
    return row ? registrationSchema.parse(row) : undefined;
  }
  return {
    get,
    checkCapacity() { guard.assertWritable('admission', 4096); },
    registerLegacy(input: Registration[]): void {
      const rows = z.array(registrationSchema).max(16).parse(input);
      transaction(() => {
        for (const row of rows) {
          if (row.root_id !== null) throw new StoreError('invalid_workspace_registration', 400);
          if (get(row.id)) continue;
          guard.assertWritable('admission', 4096);
          db.prepare('INSERT INTO workbench_workspaces(id,label,directory,identity) VALUES(?,?,?,?)').run(row.id, row.label, row.directory, row.identity);
        }
      });
    },
    page(input: WorkspacePageQuery = {}) {
      const query = querySchema.parse(input);
      return transaction(() => {
        const generation = Number(db.prepare('SELECT generation FROM workbench_workspace_generation WHERE id=1').get()!.generation);
        let key: z.infer<typeof cursorSchema>['key'] | undefined;
        if (query.cursor) {
          let cursor: z.infer<typeof cursorSchema>;
          try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
          catch { throw new StoreError('workspace_cursor_invalid', 400); }
          if (cursor.generation !== generation || cursor.query !== query.query || cursor.removed !== query.removed)
            throw new StoreError('workspace_cursor_expired', 409);
          key = cursor.key;
        }
        const pattern = '%' + query.query.replace(/[\\%_]/g, character => '\\' + character) + '%';
        // First bound the indexed raw scan; applying LIKE before LIMIT would
        // visit the whole registry for a sparse/no-match substring. Keep SQLite
        // LIKE semantics (ASCII case folding and literal wildcard escaping).
        const scanLimit = query.query ? 256 : query.limit;
        const rows: (Registration & { matches: boolean })[] = [];
        const collect = (sql: string, parameters: (string | number)[]) => {
          const remaining = scanLimit + 1 - rows.length;
          if (remaining > 0) rows.push(...db.prepare(sql).all(pattern, ...parameters, remaining).map(value => {
            const { search_match, ...registration } = value;
            return { ...registrationSchema.parse(registration), matches: Boolean(search_match) };
          }));
        };
        if (!key) collect(`SELECT raw.*,label LIKE ? ESCAPE '\\' AS search_match FROM (
          SELECT * FROM workbench_workspaces WHERE removed=?
          ORDER BY pinned DESC,label COLLATE NOCASE,id LIMIT ?) raw`, [Number(query.removed)]);
        else {
          collect(`SELECT raw.*,label LIKE ? ESCAPE '\\' AS search_match FROM (
            SELECT * FROM workbench_workspaces WHERE removed=? AND pinned=? AND label COLLATE NOCASE=? AND id>?
            ORDER BY id LIMIT ?) raw`, [Number(query.removed), key.pinned, key.label, key.id]);
          collect(`SELECT raw.*,label LIKE ? ESCAPE '\\' AS search_match FROM (
            SELECT * FROM workbench_workspaces WHERE removed=? AND pinned=? AND label COLLATE NOCASE>?
            ORDER BY label COLLATE NOCASE,id LIMIT ?) raw`, [Number(query.removed), key.pinned, key.label]);
          collect(`SELECT raw.*,label LIKE ? ESCAPE '\\' AS search_match FROM (
            SELECT * FROM workbench_workspaces WHERE removed=? AND pinned<?
            ORDER BY pinned DESC,label COLLATE NOCASE,id LIMIT ?) raw`, [Number(query.removed), key.pinned]);
        }
        const entries: Registration[] = []; let scanned = 0;
        for (const row of rows.slice(0, scanLimit)) {
          scanned++;
          if (row.matches) { const { matches: _matches, ...entry } = row; entries.push(entry); }
          if (entries.length === query.limit) break;
        }
        const last = rows[scanned - 1];
        const nextCursor = rows.length > scanned && last ? Buffer.from(JSON.stringify({ generation, query: query.query, removed: query.removed,
          key: { id: last.id, label: last.label, pinned: last.pinned } })).toString('base64url') : null;
        return { entries, nextCursor, scanned, scanLimited: !!nextCursor && entries.length < query.limit };
      }, true);
    },
    matches(directory: string, identity: string): Registration[] {
      z.string().min(1).max(4096).parse(directory); z.string().min(1).max(200).parse(identity);
      return db.prepare('SELECT * FROM workbench_workspaces WHERE directory=? AND identity=? ORDER BY removed,id LIMIT 32').all(directory, identity).map(value => registrationSchema.parse(value));
    },
    register(input: Registration): string {
      const row = registrationSchema.parse(input);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM workbench_workspaces WHERE directory=? AND identity=? AND root_id IS ? LIMIT 1').get(row.directory, row.identity, row.root_id);
        if (existing) {
          if (existing.removed === 1) throw new StoreError('workspace_removed', 409);
          return String(existing.id);
        }
        guard.assertWritable('admission', 4096);
        db.prepare('INSERT INTO workbench_workspaces(id,label,directory,identity,root_id,pinned,removed) VALUES(?,?,?,?,?,?,?)')
          .run(row.id, row.label, row.directory, row.identity, row.root_id, row.pinned, row.removed);
        return row.id;
      });
    },
    rename(id: string, label: string): void {
      workspaceIdSchema.parse(id); workspaceLabelSchema.parse(label);
      db.prepare('UPDATE workbench_workspaces SET label=? WHERE id=? AND label<>?').run(label, id, label);
    },
    pin(id: string, pinned: boolean): void {
      workspaceIdSchema.parse(id); z.boolean().parse(pinned);
      db.prepare('UPDATE workbench_workspaces SET pinned=? WHERE id=? AND pinned<>?').run(Number(pinned), id, Number(pinned));
    },
    remove(id: string): void {
      workspaceIdSchema.parse(id);
      const result = db.prepare(`UPDATE workbench_workspaces SET removed=1 WHERE id=? AND NOT EXISTS (
        SELECT 1 FROM workbench_conversations c JOIN workbench_operations o ON o.conversation_id=c.id
        WHERE c.workspace_id=? AND o.status IN ('queued','dispatching','unknown'))`).run(id, id);
      if (!result.changes) throw new StoreError('workspace_remove_busy', 409);
    },
    restore(id: string, identity: string): void {
      workspaceIdSchema.parse(id); z.string().min(1).max(200).parse(identity);
      transaction(() => {
        const row = get(id);
        if (!row || row.identity !== identity) throw new StoreError('workspace_directory_changed', 409);
        db.prepare(`UPDATE workbench_conversations SET readiness='blocked',error='workspace_restore_pending',
          state_json=json_set(state_json,'$.configurationVerified',json('false')) WHERE workspace_id=? AND binding_json IS NOT NULL`).run(id);
        db.prepare('UPDATE workbench_workspaces SET removed=0 WHERE id=?').run(id);
      });
    },
  };
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
export type AsyncWorkspaceStore = { [K in keyof WorkspaceStore]: (...args: Parameters<WorkspaceStore[K]>) => Promise<ReturnType<WorkspaceStore[K]>> };

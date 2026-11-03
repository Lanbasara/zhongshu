import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, opendirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { folderName, workspaceBrowseSchema, workspaceLimit, type workspaceAddSchema } from '../shared/workbench.ts';
import type { z } from 'zod';
import { contains, type Workspace, type WorkspaceRoot } from './harness-config.ts';
import { StoreError } from './workbench-store.ts';
import { directoryIdentity } from './workspace-documents.ts';

type Registration = {
  id: string; label: string; directory: string; identity: string; root_id: string | null; pinned: number; removed: number;
};
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Resolve below an operator root without following symlinks. Linux anchors each
// lookup to its open parent. Other hosts require stable, operator-owned ancestors.
function inDirectory<T>(root: string, parts: string[], action: (directory: string, identity: string, path: string) => T): T {
  function walk(path: string, index: number): T {
    const fd = openSync(path, directoryFlags);
    try {
      const anchored = process.platform === 'linux' ? '/proc/self/fd/' + fd : path;
      const expected = join(root, ...parts.slice(0, index));
      if (realpathSync(anchored) !== expected) throw new StoreError('workspace_directory_changed', 409);
      if (index < parts.length) return walk(join(anchored, parts[index]!), index + 1);
      const identity = directoryIdentity(fstatSync(fd, { bigint: true }));
      if (!identity) throw new StoreError('workspace_identity_unavailable', 409);
      const result = action(anchored, identity, expected);
      if (realpathSync(anchored) !== expected) throw new StoreError('workspace_directory_changed', 409);
      return result;
    } finally { closeSync(fd); }
  }
  try { return walk(root, 0); }
  catch (error) {
    if (error instanceof StoreError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError('workspace_folder_exists', 409);
    throw new StoreError('workspace_directory_unavailable', 409);
  }
}

export class WorkspaceRegistry {
  private readonly legacy: Map<string, Workspace>;
  private readonly db: DatabaseSync;
  private readonly roots: WorkspaceRoot[];

  constructor(db: DatabaseSync, legacy: Workspace[], roots: WorkspaceRoot[]) {
    this.db = db; this.roots = roots;
    this.legacy = new Map(legacy.map(workspace => [workspace.id, workspace]));
    const insert = db.prepare('INSERT OR IGNORE INTO workbench_workspaces(id,label,directory,identity) VALUES (?,?,?,?)');
    for (const workspace of legacy) {
      if (this.get(workspace.id)) continue;
      let identity: string;
      try { identity = inDirectory(workspace.directory, [], (_, value) => value); }
      catch (error) {
        if (!workspace.maintenance && error instanceof StoreError && error.code === 'workspace_directory_unavailable') continue;
        throw error;
      }
      this.checkCapacity();
      insert.run(workspace.id, workspace.label, workspace.directory, identity);
    }
  }

  private root(id: string): WorkspaceRoot {
    const root = this.roots.find(entry => entry.id === id);
    if (!root) throw new StoreError('workspace_root_not_found', 404);
    return root;
  }

  private rows(): Registration[] {
    return this.db.prepare('SELECT * FROM workbench_workspaces ORDER BY pinned DESC, label COLLATE NOCASE, id').all() as Registration[];
  }

  get(id: string): Registration | undefined {
    return this.db.prepare('SELECT * FROM workbench_workspaces WHERE id=?').get(id) as Registration | undefined;
  }

  private scope(row: Registration): { root: string; parts: string[] } | undefined {
    if (row.root_id === null) {
      return this.legacy.get(row.id)?.directory === row.directory ? { root: row.directory, parts: [] } : undefined;
    }
    const root = this.roots.find(entry => entry.id === row.root_id);
    if (!root || !contains(root.directory, row.directory)) return undefined;
    const path = relative(root.directory, row.directory);
    const selected = workspaceBrowseSchema.safeParse({ rootId: root.id, path: path ? path.split(sep) : [] });
    return selected.success ? { root: root.directory, parts: selected.data.path } : undefined;
  }

  active(): Workspace[] {
    return this.rows().filter(row => !row.removed && this.scope(row)).map(row => ({
      ...(row.root_id === null ? this.legacy.get(row.id) : undefined), id: row.id, label: row.label, directory: row.directory,
    }));
  }

  view() {
    const rows = this.rows();
    return {
      workspaces: rows.filter(row => !row.removed && this.scope(row)).map(row => ({
        id: row.id, label: row.label, directoryName: basename(row.directory) || row.label, pinned: Boolean(row.pinned),
      })),
      removedWorkspaces: rows.filter(row => row.removed).map(({ id, label }) => ({ id, label })),
      workspaceRoots: this.roots.map(({ id, label }) => ({ id, label })),
    };
  }

  verify(row: Registration): void {
    const scope = this.scope(row);
    if (!scope) throw new StoreError('workspace_directory_unavailable', 409);
    inDirectory(scope.root, scope.parts, (_, identity) => {
      if (row.identity !== identity) throw new StoreError('workspace_directory_changed', 409);
    });
  }

  browse(rootId: string, path: string[]) {
    return inDirectory(this.root(rootId).directory, path, (directory, _, currentDirectory) => {
      const names: string[] = [];
      let scanned = 0;
      let limited = false;
      const entries = opendirSync(directory);
      try {
        for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
          if (++scanned > 2000 || names.length >= 200) { limited = true; break; }
          if (entry.isDirectory() && folderName.safeParse(entry.name).success) names.push(entry.name);
        }
      } finally { entries.closeSync(); }
      return { currentDirectory, names: names.sort((a, b) => a.localeCompare(b)), limited };
    });
  }

  add({ rootId, path, name }: z.infer<typeof workspaceAddSchema>): string {
    const root = this.root(rootId);
    const parts = name === undefined ? path : [...path, name];
    if (parts.length > 12) throw new StoreError('workspace_path_too_deep', 400);
    const directory = join(root.directory, ...parts);
    if (Buffer.byteLength(directory) > 4096) throw new StoreError('workspace_path_too_deep', 400);
    if (name !== undefined) {
      this.checkCapacity(true);
      inDirectory(root.directory, path, parent => { mkdirSync(join(parent, name), { mode: 0o700 }); });
    }
    const identity = inDirectory(root.directory, parts, (_, value) => value);
    const matches = this.db.prepare('SELECT * FROM workbench_workspaces WHERE directory=? AND identity=? ORDER BY removed').all(directory, identity) as Registration[];
    const existing = matches.find(row => this.scope(row));
    if (existing?.removed) throw new StoreError('workspace_removed', 409);
    if (existing) return existing.id;
    this.checkCapacity(true);
    const id = randomUUID();
    const label = (parts.at(-1) ?? root.label).slice(0, 100);
    this.db.prepare('INSERT INTO workbench_workspaces(id,label,directory,identity,root_id) VALUES (?,?,?,?,?)').run(id, label, directory, identity, root.id);
    return id;
  }

  private checkCapacity(dynamic = false): void {
    const count = this.db.prepare('SELECT count(*) AS total, count(root_id) AS dynamic FROM workbench_workspaces').get()!;
    if (Number(count.total) >= workspaceLimit || (dynamic && Number(count.dynamic) >= workspaceLimit - 16))
      throw new StoreError('workspace_limit', 409);
  }

  rename(id: string, label: string): void {
    this.db.prepare('UPDATE workbench_workspaces SET label=? WHERE id=?').run(label, id);
  }

  pin(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE workbench_workspaces SET pinned=? WHERE id=?').run(Number(pinned), id);
  }

  remove(id: string): void {
    const result = this.db.prepare(`UPDATE workbench_workspaces SET removed=1 WHERE id=? AND NOT EXISTS (
      SELECT 1 FROM workbench_conversations c JOIN workbench_operations o ON o.conversation_id=c.id
      WHERE c.workspace_id=? AND o.status IN ('queued','dispatching','unknown')
    )`).run(id, id);
    if (!result.changes) throw new StoreError('workspace_remove_busy', 409);
  }

  restore(row: Registration): void {
    this.verify(row);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Each original binding must be verified again before its next submission.
      this.db.prepare(`UPDATE workbench_conversations SET readiness='blocked', error='workspace_restore_pending',
        state_json=json_set(state_json,'$.configurationVerified',json('false'))
        WHERE workspace_id=? AND binding_json IS NOT NULL`).run(row.id);
      this.db.prepare('UPDATE workbench_workspaces SET removed=0 WHERE id=?').run(row.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

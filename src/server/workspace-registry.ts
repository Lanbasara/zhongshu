import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, opendirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { folderName, workspaceBrowseSchema, type workspaceAddSchema } from '../shared/workbench.ts';
import type { z } from 'zod';
import { contains, type Workspace, type WorkspaceRoot } from './harness-config.ts';
import { StoreError } from './workbench-store.ts';
import { directoryIdentity } from './workspace-documents.ts';

import { createWorkspaceStore, type WorkspaceStore, type AsyncWorkspaceStore, type Registration, type WorkspacePageQuery } from './workspace-store.ts';
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
  private readonly store: WorkspaceStore | AsyncWorkspaceStore;
  private readonly roots: WorkspaceRoot[];
  readonly ready: Promise<void>;

  constructor(input: DatabaseSync | AsyncWorkspaceStore, legacy: Workspace[], roots: WorkspaceRoot[]) {
    const store = 'prepare' in input ? createWorkspaceStore(input) : input;
    this.store = store;
    this.roots = roots;
    this.legacy = new Map(legacy.map(workspace => [workspace.id, workspace]));
    this.ready = (async () => {
      const rows: Registration[] = [];
      for (const workspace of legacy) {
        if (await store.get(workspace.id)) continue;
        let identity: string;
        try { identity = inDirectory(workspace.directory, [], (_, value) => value); }
        catch (error) {
          if (!workspace.maintenance && error instanceof StoreError && error.code === 'workspace_directory_unavailable') continue;
          throw error;
        }
        rows.push({ id: workspace.id, label: workspace.label, directory: workspace.directory, identity, root_id: null, pinned: 0, removed: 0 });
      }
      if (rows.length) await store.registerLegacy(rows);
    })();
    void this.ready.catch(() => {});
  }

  private root(id: string): WorkspaceRoot {
    const root = this.roots.find(entry => entry.id === id);
    if (!root) throw new StoreError('workspace_root_not_found', 404);
    return root;
  }
  async get(id: string): Promise<Registration | undefined> { await this.ready; return await this.store.get(id); }
  private scope(row: Registration): { root: string; parts: string[] } | undefined {
    if (row.root_id === null) return this.legacy.get(row.id)?.directory === row.directory ? { root: row.directory, parts: [] } : undefined;
    const root = this.roots.find(entry => entry.id === row.root_id);
    if (!root || !contains(root.directory, row.directory)) return undefined;
    const path = relative(root.directory, row.directory);
    const selected = workspaceBrowseSchema.safeParse({ rootId: root.id, path: path ? path.split(sep) : [] });
    return selected.success ? { root: root.directory, parts: selected.data.path } : undefined;
  }
  async configured(id: string, includeRemoved = false): Promise<Workspace | undefined> {
    const row = await this.get(id);
    if (!row || (!includeRemoved && row.removed) || !this.scope(row)) return;
    return { ...(row.root_id === null ? this.legacy.get(row.id) : undefined), id: row.id, label: row.label, directory: row.directory };
  }
  private present(row: Registration) {
    return { id: row.id, label: row.label, directoryName: basename(row.directory) || row.label, pinned: Boolean(row.pinned) };
  }
  async page(options: WorkspacePageQuery = {}) {
    await this.ready;
    const page = await this.store.page(options);
    return { workspaces: page.entries.filter(row => this.scope(row)).map(row => this.present(row)), nextCursor: page.nextCursor, scanned: page.scanned, scanLimited: page.scanLimited };
  }
  async active(options: Omit<WorkspacePageQuery, 'removed'> = {}) {
    await this.ready;
    const page = await this.store.page({ ...options, removed: false });
    return { workspaces: page.entries.filter(row => this.scope(row)).map(row => ({
      ...(row.root_id === null ? this.legacy.get(row.id) : undefined), id: row.id, label: row.label, directory: row.directory,
    })), nextCursor: page.nextCursor };
  }
  async view() {
    const [active, removed] = await Promise.all([this.page(), this.page({ removed: true })]);
    return { workspaces: active.workspaces, workspaceCursor: active.nextCursor, removedWorkspaces: removed.workspaces,
      removedWorkspaceCursor: removed.nextCursor, workspaceRoots: this.roots.map(({ id, label }) => ({ id, label })) };
  }
  async metadata(id: string) {
    const row = await this.get(id);
    if (!row || !this.scope(row)) throw new StoreError('workspace_not_found', 404);
    return { ...this.present(row), removed: Boolean(row.removed) };
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
      const names: string[] = []; let scanned = 0; let limited = false;
      const entries = opendirSync(directory);
      try { for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++scanned > 2000 || names.length >= 200) { limited = true; break; }
        if (entry.isDirectory() && folderName.safeParse(entry.name).success) names.push(entry.name);
      } } finally { entries.closeSync(); }
      return { currentDirectory, names: names.sort((a, b) => a.localeCompare(b)), limited };
    });
  }
  browseTarget(rootId: string, path: string[]) {
    const parsed = workspaceBrowseSchema.safeParse({ rootId, path });
    if (!parsed.success) throw new StoreError('invalid_workspace_path', 400);
    return inDirectory(this.root(parsed.data.rootId).directory, parsed.data.path, (_directory, identity, currentDirectory) => ({ root: currentDirectory, path: '', identity, currentDirectory }));
  }
  async add({ rootId, path, name }: z.infer<typeof workspaceAddSchema>): Promise<string> {
    await this.ready;
    const root = this.root(rootId); const parts = name === undefined ? path : [...path, name];
    if (parts.length > 12) throw new StoreError('workspace_path_too_deep', 400);
    const directory = join(root.directory, ...parts);
    if (Buffer.byteLength(directory) > 4096) throw new StoreError('workspace_path_too_deep', 400);
    if (name !== undefined) {
      await this.store.checkCapacity();
      inDirectory(root.directory, path, parent => { mkdirSync(join(parent, name), { mode: 0o700 }); });
    }
    const identity = inDirectory(root.directory, parts, (_, value) => value);
    const matches = await this.store.matches(directory, identity);
    const existing = matches.find(row => this.scope(row));
    if (existing?.removed) throw new StoreError('workspace_removed', 409);
    if (existing) return existing.id;
    return await this.store.register({ id: randomUUID(), label: (parts.at(-1) ?? root.label).slice(0, 100), directory, identity, root_id: root.id, pinned: 0, removed: 0 });
  }
  async rename(id: string, label: string): Promise<void> { await this.ready; await this.store.rename(id, label); }
  async pin(id: string, pinned: boolean): Promise<void> { await this.ready; await this.store.pin(id, pinned); }
  async remove(id: string): Promise<void> { await this.ready; await this.store.remove(id); }
  async restore(row: Registration): Promise<void> { this.verify(row); await this.ready; await this.store.restore(row.id, row.identity); }
}

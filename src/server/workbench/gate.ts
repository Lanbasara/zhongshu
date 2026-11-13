// Layer 2 (ADR 0024): who currently occupies a conversation or workspace, and what is fenced from new work.
// The gate only holds these facts; the procedures that change them live with their writers:
// - workspaces: removing, saving, maintenance phases
// - lifecycle: deletion fence and guard
// - creation: preparing conversations, drafting workspaces
// - execution and queue: dispatches in flight (busy)
import type { SkillOption } from '../../shared/content.ts';
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import type { HostPhase } from '../workspace-maintenance.ts';
import { overlaps, type Bindings } from './bindings.ts';

export type DraftPreparation = Promise<{ preparationId: string; skills: SkillOption[] }>;

export class Gate {
  private readonly bindings: Bindings;
  private readonly removingWorkspaces = new Set<string>();
  private readonly savingDirectories = new Set<string>();
  private readonly maintenancePhases = new Map<string, HostPhase | 'transition'>();
  private readonly deleting = new Set<string>();
  private readonly store: WorkbenchStore;
  private deletionGuard: (id: string) => boolean;
  private readonly busyConversations = new Map<string, number>();
  private readonly preparingConversations = new Set<string>();
  private readonly draftPreparations = new Map<string, DraftPreparation>();

  constructor(store: WorkbenchStore, bindings: Bindings) {
    this.store = store;
    this.bindings = bindings;
    this.deletionGuard = id => store.deletions.get(id) !== null;
  }

  // Workspaces (written by workspaces).
  removing(workspaceId: string): boolean { return this.removingWorkspaces.has(workspaceId); }
  beginRemoving(workspaceId: string): void { this.removingWorkspaces.add(workspaceId); }
  endRemoving(workspaceId: string): void { this.removingWorkspaces.delete(workspaceId); }
  saving(directory: string): boolean { return [...this.savingDirectories].some(root => overlaps(root, directory)); }
  beginSaving(directory: string): void { this.savingDirectories.add(directory); }
  endSaving(directory: string): void { this.savingDirectories.delete(directory); }
  phase(workspaceId: string): HostPhase | 'transition' | undefined { return this.maintenancePhases.get(workspaceId); }
  setPhase(workspaceId: string, phase: HostPhase | 'transition'): void { this.maintenancePhases.set(workspaceId, phase); }
  /** A save or a paused, changing or unknown maintained Host fences native work in overlapping directories. */
  executionBlocked(directory: string): boolean {
    return this.saving(directory) || this.bindings.workspaces.some(workspace => workspace.maintenance &&
      overlaps(directory, workspace.directory) && this.maintenancePhases.get(workspace.id) !== 'online');
  }

  // Deletion (written by lifecycle).
  setDeletionGuard(guard: (id: string) => boolean): void { this.deletionGuard = guard; }
  isDeleting(id: string): boolean { return this.deleting.has(id) || this.deletionGuard(id); }
  assertNotDeleting(id: string, action?: 'create'): void {
    if (this.isDeleting(id)) throw new StoreError(action === 'create' && this.store.deletions.get(id)?.status === 'completed'
      ? 'conversation_deleted' : 'conversation_deleting', 409);
  }
  fenceDeletion(id: string): void { this.deleting.add(id); }
  releaseDeletion(id: string): void { this.deleting.delete(id); }

  // Dispatches in flight (written by execution and queue).
  busy(id: string): boolean { return this.busyConversations.has(id); }
  occupy(id: string): void { this.busyConversations.set(id, (this.busyConversations.get(id) ?? 0) + 1); }
  vacate(id: string): void {
    const count = (this.busyConversations.get(id) ?? 1) - 1;
    if (count) this.busyConversations.set(id, count); else this.busyConversations.delete(id);
  }

  // Creation (written by creation).
  preparing(id: string): boolean { return this.preparingConversations.has(id); }
  beginPreparing(id: string): void { this.preparingConversations.add(id); }
  endPreparing(id: string): void { this.preparingConversations.delete(id); }
  drafting(workspaceId: string): DraftPreparation | undefined { return this.draftPreparations.get(workspaceId); }
  beginDrafting(workspaceId: string, preparation: DraftPreparation): void { this.draftPreparations.set(workspaceId, preparation); }
  endDrafting(workspaceId: string): void { this.draftPreparations.delete(workspaceId); }

  /** New native input may enter this conversation now. */
  assertDispatchable(conversation: Conversation): void {
    this.assertNotDeleting(conversation.id);
    this.bindings.assertWorkspaceAvailable(conversation.workspaceId);
    if (!conversation.binding || conversation.readiness !== 'ready') throw new StoreError('conversation_not_ready', 409);
    if (conversation.archived) throw new StoreError('conversation_archived', 409);
    if (this.removingWorkspaces.has(conversation.workspaceId)) throw new StoreError('workspace_remove_busy', 409);
    if (this.executionBlocked(conversation.cwd)) throw new StoreError('workspace_execution_blocked', 409);
  }
}

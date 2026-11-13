// Layer 1 (ADR 0024): whether a conversation's workspace and Harness still hold. Owns no mutable state.
import { isAbsolute, relative } from 'node:path';
import type { HarnessAdapter, HarnessId } from '../../harness/types.ts';
import type { Workspace } from '../harness-config.ts';
import { StoreError, type Conversation, type WorkbenchStore } from '../workbench-store.ts';
import type { WorkspaceRegistry } from '../workspace-registry.ts';
import type { Tasks } from './tasks.ts';

/** Either directory contains the other. */
export function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
  };
  return contains(left, right) || contains(right, left);
}

export class Bindings {
  readonly store: WorkbenchStore;
  readonly adapters: Map<HarnessId, HarnessAdapter>;
  readonly registry?: WorkspaceRegistry;
  private readonly initialWorkspaces: Workspace[];
  private readonly tasks: Tasks;

  constructor(store: WorkbenchStore, initialWorkspaces: Workspace[], adapters: Map<HarnessId, HarnessAdapter>, tasks: Tasks, registry?: WorkspaceRegistry) {
    this.store = store; this.adapters = adapters; this.tasks = tasks;
    this.initialWorkspaces = initialWorkspaces; this.registry = registry;
  }

  get workspaces(): Workspace[] { return this.registry?.active() ?? this.initialWorkspaces; }
  conversation(id: string): Conversation {
    const conversation = this.store.getConversation(id);
    if (!conversation) throw new StoreError(this.store.deletions.get(id)?.status === 'completed' ? 'conversation_deleted' : 'conversation_not_found', 404);
    return conversation;
  }
  workspace(id: string): Workspace {
    this.tasks.assertOpen();
    this.assertWorkspaceAvailable(id);
    const workspace = this.workspaces.find(item => item.id === id);
    if (!workspace) throw new StoreError('workspace_not_found', 404);
    return workspace;
  }
  workspaceUnavailable(id: string): string | undefined {
    const entry = this.registry?.get(id);
    if (!entry) return;
    if (entry.removed) return 'workspace_removed';
    try { this.registry!.verify(entry); }
    catch (error) { return error instanceof StoreError ? error.code : 'workspace_directory_unavailable'; }
  }
  assertWorkspaceAvailable(id: string): void {
    const reason = this.workspaceUnavailable(id);
    if (reason) throw new StoreError(reason, 409);
  }
  /** The conversation's workspace and Harness are still the ones it was created with. */
  configured(conversation: Conversation): boolean {
    const workspace = this.workspaces.find(item => item.id === conversation.workspaceId);
    const adapter = this.adapters.get(conversation.harnessId);
    return workspace?.directory === conversation.cwd && adapter?.id === conversation.harnessId &&
      !this.workspaceUnavailable(conversation.workspaceId);
  }
  /** The adapter for new native work. A changed configuration is saved as blocked and refused. */
  adapter(conversation: Conversation): HarnessAdapter {
    this.assertWorkspaceAvailable(conversation.workspaceId);
    if (!this.configured(conversation)) {
      this.store.setConversationState(conversation.id, { readiness: 'blocked', error: 'conversation_configuration_changed',
        state: { status: 'unknown', pendingInputs: conversation.state.pendingInputs, configurationVerified: false, reason: 'conversation_configuration_changed' } });
      throw new StoreError('conversation_configuration_changed', 409);
    }
    return this.adapters.get(conversation.harnessId)!;
  }
  /** The adapter for reading history; it does not need the workspace, so history stays readable after removal. */
  historyAdapter(conversation: Conversation): HarnessAdapter | undefined {
    const adapter = this.adapters.get(conversation.harnessId);
    return conversation.binding && adapter?.id === conversation.harnessId ? adapter : undefined;
  }
}

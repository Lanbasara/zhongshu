import type { ChangeEvent } from '../shared/workbench.ts';

/** Display invalidation only: these bounded hints never grant execution access. */
export class NavigationUpdates {
  private seen = new Map<string, string>();
  private scopes = new Map<string, number>();
  private serial = 0;
  private reset = 0;
  changed(event: ChangeEvent): string | boolean {
    if (!event.navigation) return !event.item; // Older stream protocol.
    const { workspaceId, version } = event.navigation;
    const previous = this.seen.get(event.conversationId);
    this.seen.delete(event.conversationId); this.seen.set(event.conversationId, version);
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value!);
    return previous === version ? false : workspaceId;
  }
  invalidate(workspace?: string) {
    this.serial++;
    if (!workspace) { this.reset = this.serial; this.scopes.clear(); return; }
    this.scopes.delete(workspace); this.scopes.set(workspace, this.serial);
    if (this.scopes.size > 256) this.scopes.delete(this.scopes.keys().next().value!);
  }
  version(workspace?: string) { return `${this.reset}:${workspace ? this.scopes.get(workspace) ?? 0 : this.serial}`; }
}

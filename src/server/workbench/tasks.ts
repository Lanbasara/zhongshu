// Layer 0 (ADR 0024): background work the workbench started, and whether it still admits new work.
import { StoreError } from '../workbench-store.ts';

export class Tasks {
  private readonly running = new Set<Promise<unknown>>();
  private shut = false;

  get closed(): boolean { return this.shut; }
  /** Stop admitting work. Tracked tasks still run to completion; `settle` waits for them. */
  close(): void { this.shut = true; }
  assertOpen(): void { if (this.shut) throw new StoreError('workbench_closed', 503); }

  /** Run and track a task until it settles. */
  task<T>(action: () => Promise<T>): Promise<T> {
    const promise = action(); this.running.add(promise);
    void promise.then(() => this.running.delete(promise), () => this.running.delete(promise));
    return promise;
  }
  /** Start without waiting; the work records its own failures. */
  launch(promise: Promise<unknown>): void { void promise.catch(() => {}); }
  /** Wait until every tracked task, including ones started meanwhile, has settled. */
  async settle(): Promise<void> { while (this.running.size) await Promise.allSettled([...this.running]); }
}

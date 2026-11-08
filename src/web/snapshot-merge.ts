import type { ConversationState, WorkbenchSnapshot } from '../shared/workbench.ts';

type StateFields = Pick<WorkbenchSnapshot, 'conversation' | 'operations' | 'queue' | 'usage' | 'requests' | 'planReady'>;

function withState(target: WorkbenchSnapshot, state: StateFields): WorkbenchSnapshot {
  const { queue: _queue, usage: _usage, requests: _requests, planReady: _plan, ...rest } = target;
  return { ...rest, conversation: state.conversation, operations: state.operations,
    ...(state.queue ? { queue: state.queue } : {}), ...(state.usage ? { usage: state.usage } : {}),
    ...(state.requests ? { requests: state.requests } : {}), ...(state.planReady ? { planReady: state.planReady } : {}) };
}

/**
 * A state read replaces only the conversation's state (ADR 0020). History, turn files, live items, the live
 * position and the history revision stay as the last full read left them.
 */
export function applyState(current: WorkbenchSnapshot, state: ConversationState): WorkbenchSnapshot {
  return withState(current, state);
}

/**
 * A full read replaces history. Its state replaces the current one only when it is not older than the last state
 * read (`stateRevision`), so a slow full read never undoes a newer state.
 */
export function adoptFull(current: WorkbenchSnapshot | undefined, result: WorkbenchSnapshot, stateRevision: number): WorkbenchSnapshot {
  if (!current || current.conversation.id !== result.conversation.id || result.revision >= stateRevision) return result;
  return withState(result, current);
}

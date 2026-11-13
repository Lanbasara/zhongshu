import type { Conversation, WorkbenchOperation } from '../shared/workbench.ts';

/** One conversation-level state hint: cannot verify, needs a person, or is still being confirmed. */
export type AttentionTone = 'unknown' | 'blocked' | 'pending';
export type Attention = {
  tone: AttentionTone;
  /** One sentence about what is happening now. Machine codes never appear here. */
  title: string;
  /** The known cause in words, what is kept, and whether it retries; a cause code stays here, as a last resort. */
  detail?: string;
  action?: 'reconcile';
};
export type AttentionInput = {
  conversation: Conversation;
  operations: readonly WorkbenchOperation[];
  /** An accepted message that still has no native run after the workbench's delay (8 s). */
  stuckMessage?: boolean;
  /** The current unknown state has outlasted the workbench's grace period (about 2 s). */
  unknownLingered?: boolean;
};

/** What is kept whenever the workbench cannot confirm what the native side did. */
const kept = '已收到的内容都会保留，消息不会自动重发';
/** Native state reads are retried by the server while the page is open (observation retry). */
const retried = '页面打开期间会自动重试';

/**
 * The state and error reason codes in words. These are the causes the workbench can name precisely;
 * a code without an entry is still shown, as a neutral sentence with the code kept in the detail.
 */
export const stateReasonText: Record<string, string> = {
  native_state_unavailable: '原生服务没有返回可以确认的运行状态。',
  native_observation_unavailable: '与原生服务的连接中断，暂时读不到运行状态。',
  database_restored_requires_reconciliation: '应用数据库已从备份恢复，之前的执行记录需要重新核对。',
  conversation_configuration_changed: '这段对话的工作区或原生服务配置发生了变化。',
  conversation_preparation_incomplete: '原生对话还没有准备完成。',
  native_creation_result_unknown: '上一次创建对话的过程被中断，结果还没有核实。',
  native_configuration_unverified: '原生服务还没有确认这段对话的模型与权限配置。',
  codex_configuration_mismatch: 'Codex 返回的配置与这段对话保存的配置不一致。',
  native_receipt_unknown: '上一次操作的原生接收结果还没有确认。',
  native_run_changed: '这段对话对应的原生运行已经变化，需要重新核对。',
  workspace_restore_pending: '恢复后的工作区正在重新核实。',
  workspace_directory_changed: '工作区目录已被替换。',
  workspace_directory_unavailable: '工作区目录暂时无法访问。',
  workspace_identity_unavailable: '当前文件系统无法核实工作区目录。',
  harness_unavailable: '暂时连不上这个 Harness。',
};
const reasonCode = /^[a-z][a-z0-9_]{0,99}$/;
/** A reason code or a sentence, in words; an unknown code is never mistaken for a known outcome. */
export function reasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  const known = stateReasonText[reason];
  if (known) return known;
  return reasonCode.test(reason) ? `原生服务返回了无法识别的状态（原因码：${reason}）。` : reason;
}

/**
 * Reasons that block the conversation before or outside an execution. The title says what the
 * conversation can and cannot do now; the detail gives the cause and what happens to existing content.
 */
const blockedReasons: Record<string, Omit<Attention, 'tone'>> = {
  // The native state could not be read; the cause is known, so this does not wait for the grace period.
  native_state_unavailable: {
    title: '运行状态暂时无法核实',
    detail: '原生服务没有返回可以确认的运行状态。已收到的内容都会保留，消息不会自动重发；页面打开期间会自动重试。',
    action: 'reconcile',
  },
  native_observation_unavailable: {
    title: '与原生服务的连接中断',
    detail: '暂时读不到运行状态。已收到的内容都会保留，消息不会自动重发；页面打开期间会自动重试。',
    action: 'reconcile',
  },
  database_restored_requires_reconciliation: {
    title: '运行状态暂时无法核实',
    detail: '应用数据库已从备份恢复，之前的执行记录需要重新核对。已收到的内容都会保留，消息不会自动重发；页面打开期间会自动重试。',
    action: 'reconcile',
  },
  conversation_configuration_changed: {
    title: '这段对话暂时不能继续',
    detail: '工作区或原生服务的配置发生了变化，需要核对后才能继续。已有内容都会保留，消息不会自动重发。',
  },
  conversation_preparation_incomplete: {
    title: '原生对话还没有准备完成',
    detail: '已有绑定和内容都会保留；准备完成后才能继续发送。',
  },
  native_creation_result_unknown: {
    title: '上次创建的结果还没有核实',
    detail: '创建过程被中断，结果仍待核实；已经产生的对话和内容都会保留。',
  },
  native_configuration_unverified: {
    title: '配置还没有核实完成',
    detail: '原生服务还没有确认这段对话的模型与权限配置；核实前不能继续发送，已有内容都会保留。页面打开期间会继续核对。',
    action: 'reconcile',
  },
  codex_configuration_mismatch: {
    title: 'Codex 配置核验失败',
    detail: 'Codex 返回的配置与这段对话保存的配置不一致。核实前暂停发送，已有内容会保留。',
    action: 'reconcile',
  },
  workspace_restore_pending: {
    title: '正在重新核实恢复的工作区',
    detail: '恢复后的工作区需要重新核对原生会话；核实完成前不能继续发送，已有内容都会保留。页面打开期间会继续核对。',
    action: 'reconcile',
  },
  workspace_directory_changed: {
    title: '工作区目录已被替换',
    detail: '中书不能在这个新目录里继续这段对话；已有内容都会保留，消息不会自动重发。恢复原来的目录后才能继续。',
  },
  workspace_directory_unavailable: {
    title: '工作区目录暂时无法访问',
    detail: '中书暂时读不到这个工作区；已有内容都会保留，消息不会自动重发。目录恢复访问后才能继续。',
  },
  workspace_identity_unavailable: {
    title: '暂时无法核实工作区目录',
    detail: '当前文件系统给不出可以核实的目录信息；已有内容都会保留，消息不会自动重发。',
  },
  native_receipt_unknown: {
    title: '上次操作的结果还没有确认',
    detail: '原生服务没有返回接收确认；已有内容都会保留，消息不会自动重发。',
    action: 'reconcile',
  },
  native_run_changed: {
    title: '原生运行已经变化',
    detail: '这段对话对应的原生运行已经不同，需要重新核对；已有内容都会保留，消息不会自动重发。',
    action: 'reconcile',
  },
  harness_unavailable: {
    title: '暂时连不上这个 Harness',
    detail: '这段对话使用的 Agent 服务暂时不可用；已有内容都会保留，消息不会自动重发。恢复后才能继续发送。',
  },
};

function unknownState(conversation: Conversation): Attention {
  const cause = reasonText(conversation.state.reason ?? conversation.error) || '原生服务没有返回可以确认的运行状态。';
  return { tone: 'unknown', title: '运行状态暂时无法核实', detail: `${cause}${kept}；${retried}。`, action: 'reconcile' };
}
function blocked(error: string): Attention {
  const known = blockedReasons[error];
  if (known) return { tone: 'blocked', ...known };
  return { tone: 'blocked', title: '这段对话暂时不能继续', detail: `${reasonText(error)}${kept}。` };
}
function unknownOperation(operation: WorkbenchOperation): Attention {
  if (operation.type === 'stop') return {
    tone: 'pending', title: '有一次停止的结果还没有核实',
    detail: '停止请求已经提交，但原生服务还没有确认它是否生效；已收到的内容都会保留。',
    action: 'reconcile',
  };
  return {
    tone: 'pending', title: '有一条消息的结果还没有核实',
    detail: '消息已经提交，但原生服务还没有确认是否收到；消息不会自动重发，已收到的内容都会保留。',
    action: 'reconcile',
  };
}
const stuck: Attention = {
  tone: 'pending', title: '已发送，正在确认是否开始执行',
  detail: '消息已经交给原生服务，但还没有确认它对应哪一轮执行；确认之前不会重复发送，已收到的内容都会保留。',
  action: 'reconcile',
};

/**
 * One hint at a time, and only when the state genuinely cannot be verified or needs a person:
 * an unverifiable native state, a blocked conversation, an operation with an unknown result, or a
 * message that still has no native run after the delay. Ordinary waiting (queued, dispatching,
 * an accepted message that has just been associated with a run) shows nothing.
 */
export function conversationAttention({ conversation, operations, stuckMessage = false, unknownLingered = false }: AttentionInput): Attention | null {
  // A removed workspace keeps its own explanation and restore entry where they are; it is not an execution hint.
  if (conversation.error === 'workspace_removed') return null;
  // A conversation that was just created or opened starts as unknown until the first observation; during the grace
  // period that is a normal first read, so stay quiet and do not fall through to operation or stuck hints either.
  if (conversation.state.status === 'unknown' && !conversation.error && !unknownLingered) return null;
  // An explicit error is a known cause: show it as blocked at once, without waiting for the grace period.
  if (conversation.state.status === 'unknown' && !conversation.error) return unknownState(conversation);
  if (conversation.error) return blocked(conversation.error);
  const unknownValue = operations.find(operation => operation.status === 'unknown');
  if (unknownValue) return unknownOperation(unknownValue);
  if (stuckMessage) return stuck;
  return null;
}

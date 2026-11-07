import { z } from 'zod';
import type { NativeItem } from '../types.ts';
import { editPath } from '../edit-paths.ts';
import { subagentIdSchema } from '../../shared/workbench.ts';

export const nativeId = z.string().min(1).max(512);
export const nativeText = z.string().max(2 * 1024 * 1024);
export const cursor = z.string().min(1).max(4096);
export const record = z.record(z.string(), z.unknown());
export const threadStatus = z.object({ type: z.string().max(64), activeFlags: z.array(z.string().max(64)).max(32).optional() });
export const turn = z.object({ id: nativeId, status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']) });
export const configuredThread = z.object({
  thread: z.object({ id: nativeId, status: threadStatus.optional() }), model: nativeId, cwd: z.string().max(4096),
  reasoningEffort: z.string().max(240).nullable().optional(),
  approvalPolicy: z.string().max(64), activePermissionProfile: z.object({ id: nativeId }).nullable(),
});
const webTextResult = z.object({
  type: z.literal('text_result'), title: z.string().max(16000).nullish(),
  url: z.string().max(16000).nullish(), snippet: z.string().max(128000).nullish(),
});
const webResult = z.union([webTextResult, z.object({ type: z.string().max(100).refine(type => type !== 'text_result') })]);
export const nativeItem = z.object({
  id: nativeId, type: z.string().max(100), text: nativeText.optional(), clientId: nativeId.nullable().optional(),
  status: z.string().max(64).optional(), command: nativeText.optional(), aggregatedOutput: nativeText.nullable().optional(),
  content: z.unknown().optional(), summary: z.array(nativeText).max(200).optional(), name: z.string().max(200).optional(),
  tool: z.string().max(200).optional(), success: z.boolean().nullable().optional(),
  query: nativeText.optional(),
  action: z.object({ type: z.string().max(100), query: nativeText.nullish(), queries: z.array(nativeText).max(200).nullish(), url: nativeText.nullish(), pattern: nativeText.nullish() }).nullish(),
  results: z.array(webResult).max(200).nullish(),
  result: z.string().max(8 * 1024 * 1024).optional(), savedPath: z.string().max(4096).optional(),
  changes: z.array(z.object({ path: z.string().max(4096), diff: nativeText.optional(),
    kind: z.object({ type: z.string(), move_path: z.string().max(4096).nullish() }).optional() })).max(200).optional(),
  // Native collaboration records: collabAgentToolCall (v1 tools, v2 wait) and subAgentActivity (v2).
  senderThreadId: nativeId.nullish(), receiverThreadIds: z.array(nativeId).max(64).nullish(), prompt: nativeText.nullish(),
  kind: z.string().max(64).optional(), agentThreadId: nativeId.optional(), agentPath: z.string().max(4096).optional(),
});
export const itemEntry = z.object({ turnId: nativeId, item: nativeItem, completedAtMs: z.number().nullable().optional() });
export const itemsPage = z.object({ data: z.array(itemEntry).max(200), nextCursor: cursor.nullable() });

type CollaborationAction = NonNullable<NativeItem['collaboration']>['action'];
const subagentId = subagentIdSchema;
const collabActions: Record<string, CollaborationAction> = { spawnAgent: 'started', sendInput: 'messaged', sendMessage: 'messaged', followupTask: 'messaged',
  resumeAgent: 'messaged', wait: 'waiting', closeAgent: 'closed', interruptAgent: 'interrupted' };
const collabText: Record<string, string> = { spawnAgent: '派出子 Agent', sendInput: '向子 Agent 发送输入', sendMessage: '向子 Agent 发送消息',
  followupTask: '给子 Agent 新任务', resumeAgent: '恢复子 Agent', wait: '等待子 Agent', closeAgent: '关闭子 Agent', interruptAgent: '停止子 Agent', listAgents: '查看子 Agent 列表' };
const activityActions: Record<string, CollaborationAction> = { started: 'started', interacted: 'messaged', interrupted: 'interrupted', completed: 'completed' };
const activityText: Record<string, string> = { started: '派出子 Agent', interacted: '与子 Agent 交互', interrupted: '停止子 Agent', completed: '子 Agent 已完成' };

/** Keep stable native identities; unsupported native items remain explicit notices, never fake text. */
export function mapItem(input: z.infer<typeof nativeItem>, runId: string, cwd: string, running = false, completed = false): NativeItem {
  const base = { id: input.id, runId };
  const status = input.status === 'inProgress' || running ? 'running'
    : input.success === false || (input.status && input.status !== 'completed') ? 'failed' : 'completed';
  // An item without a status needs explicit notification/history completion evidence.
  const observedStatus: NativeItem['status'] = input.success === false || ['failed', 'interrupted', 'cancelled'].includes(input.status ?? '') ? 'failed'
    : completed || input.status === 'completed' ? 'completed'
    : running || input.status === 'inProgress' ? 'running' : 'unknown';
  switch (input.type) {
    case 'userMessage': {
      const content = z.array(z.object({ type: z.string().max(100), text: nativeText.optional() })).max(100).parse(input.content ?? []);
      return { ...base, kind: 'user', text: content.map(part => part.type === 'text' ? part.text ?? '' : '[非文本输入]').join('\n'), status: 'completed', ...(input.clientId ? { operationId: input.clientId } : {}) };
    }
    case 'agentMessage': return { ...base, kind: 'assistant', text: input.text ?? '', status: running ? 'running' : 'completed' };
    case 'commandExecution': return { ...base, kind: 'tool', text: [input.command ?? '执行命令', input.aggregatedOutput].filter(Boolean).join('\n'), tool: { name: '运行命令', input: input.command?.slice(0,32000), output: input.aggregatedOutput?.slice(0,128000) }, status };
    case 'fileChange': {
      const changes = input.changes ?? [];
      const paths = new Set<string>();
      if (status === 'completed' && input.status === 'completed') {
        for (const change of changes) {
          const path = editPath(cwd, change.path);
          const destination = change.kind?.type === 'update' ? editPath(cwd, change.kind.move_path) : undefined;
          if (path) paths.add(path);
          if (destination) paths.add(destination);
        }
      }
      return { ...base, kind: 'tool', text: '修改工作区文件', tool: { name: '修改文件',
        output: changes.map(c => c.path + '\n' + (c.diff ?? '')).join('\n').slice(0,128000) }, status,
        ...(paths.size ? { fileEdits: [...paths] } : {}) };
    }
    case 'mcpToolCall': case 'dynamicToolCall': return { ...base, kind: 'tool', text: input.tool ?? input.name ?? '调用工具', tool: { name: input.tool ?? input.name ?? '调用工具' }, status };
    case 'webSearch': {
      const action = input.action;
      const name = action?.type === 'openPage' ? '打开网页' : action?.type === 'findInPage' ? '页内查找' : !action || action.type === 'search' ? '网页搜索' : '网页操作';
      const details = action?.type === 'openPage' ? [action.url ?? input.query]
        : action?.type === 'findInPage' ? [action.url, action.pattern]
        : action?.type === 'search' ? [...(action.queries ?? []), action.query ?? input.query]
        : [input.query];
      const inputText = [...new Set(details.filter((value): value is string => !!value))].join('\n').slice(0, 32000);
      const resultTexts = (input.results ?? []).map(result => {
        const parsed = webTextResult.safeParse(result);
        return parsed.success ? [parsed.data.title, parsed.data.url, parsed.data.snippet].filter(Boolean).join('\n')
          : `此结果类型尚未适配展示：${result.type}`;
      }).filter(Boolean);
      const resultsText = resultTexts.join('\n\n');
      const output = resultsText.length > 128000 ? resultsText.slice(0, 127950) + '\n\n[结果过长，仅显示前部内容]' : resultsText;
      return { ...base, kind: 'tool', text: output ? name : '原生记录未提供可展示的结果内容。', tool: { name, ...(inputText ? { input: inputText } : {}), ...(output ? { output } : {}) }, status: observedStatus };
    }
    case 'imageGeneration': return { ...base, kind: 'assistant', text: status === 'failed' ? '图片生成未完成。' : status === 'completed' && !input.result && !input.savedPath ? '原生图片资源暂不可读取。' : '', status, ...((input.result || input.savedPath) ? { imageSources: [{ ...(input.result ? { data: input.result } : { path: input.savedPath }) }] } : {}) };
    case 'collabAgentToolCall': {
      const action = collabActions[input.tool ?? ''];
      const agentIds = (input.receiverThreadIds ?? []).filter(id => subagentId.safeParse(id).success).slice(0, 32);
      const text = collabText[input.tool ?? ''] ?? '子 Agent 协作';
      return { ...base, kind: 'notice', text, status: observedStatus === 'unknown' ? 'completed' : observedStatus,
        ...(action && agentIds.length ? { collaboration: { action, agentIds } } : {}) };
    }
    case 'subAgentActivity': {
      const action = activityActions[input.kind ?? ''];
      const valid = subagentId.safeParse(input.agentThreadId).success;
      return { ...base, kind: 'notice', text: activityText[input.kind ?? ''] ?? '子 Agent 活动', status: 'completed',
        ...(action && valid ? { collaboration: { action, agentIds: [input.agentThreadId!] } } : {}) };
    }
    // Reasoning without a readable summary arrives as an empty list; it still reads as thinking, never as a blank row.
    case 'reasoning': return { ...base, kind: 'notice', text: input.summary?.filter(Boolean).join('\n') || '思考', status: running ? 'running' : 'completed' };
    // A plan proposed in Plan mode (`<turnId>-plan`); the completed text is authoritative.
    case 'plan': return { ...base, kind: 'assistant', plan: true, text: input.text ?? '', status: running ? 'running' : 'completed' };
    default: return { ...base, kind: 'notice', text: `此原生条目的详情尚未适配展示：${input.type}。这不表示原生能力不可用。`, status: observedStatus };
  }
}

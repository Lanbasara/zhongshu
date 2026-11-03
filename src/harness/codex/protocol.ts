import { z } from 'zod';
import type { NativeItem } from '../types.ts';

export const nativeId = z.string().min(1).max(512);
export const nativeText = z.string().max(2 * 1024 * 1024);
export const cursor = z.string().min(1).max(4096);
export const record = z.record(z.string(), z.unknown());
export const threadStatus = z.object({ type: z.string().max(64), activeFlags: z.array(z.string().max(64)).max(32).optional() });
export const turn = z.object({ id: nativeId, status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']) });
export const configuredThread = z.object({
  thread: z.object({ id: nativeId, status: threadStatus.optional() }), model: nativeId, cwd: z.string().max(4096),
  approvalPolicy: z.string().max(64), activePermissionProfile: z.object({ id: nativeId }).nullable(),
});
export const nativeItem = z.object({
  id: nativeId, type: z.string().max(100), text: nativeText.optional(), clientId: nativeId.nullable().optional(),
  status: z.string().max(64).optional(), command: nativeText.optional(), aggregatedOutput: nativeText.nullable().optional(),
  content: z.unknown().optional(), summary: z.array(nativeText).max(200).optional(), name: z.string().max(200).optional(),
  tool: z.string().max(200).optional(), success: z.boolean().nullable().optional(),
  result: z.string().max(8 * 1024 * 1024).optional(), savedPath: z.string().max(4096).optional(),
  changes: z.array(z.object({ path: z.string().max(4096), diff: nativeText.optional() })).max(200).optional(),
});
export const itemEntry = z.object({ turnId: nativeId, item: nativeItem, completedAtMs: z.number().nullable().optional() });
export const itemsPage = z.object({ data: z.array(itemEntry).max(200), nextCursor: cursor.nullable() });

/** Keep stable native identities; unsupported native items remain explicit notices, never fake text. */
export function mapItem(input: z.infer<typeof nativeItem>, runId: string, running = false): NativeItem {
  const base = { id: input.id, runId };
  const status = input.status === 'inProgress' || running ? 'running'
    : input.success === false || (input.status && input.status !== 'completed') ? 'failed' : 'completed';
  switch (input.type) {
    case 'userMessage': {
      const content = z.array(z.object({ type: z.string().max(100), text: nativeText.optional() })).max(100).parse(input.content ?? []);
      return { ...base, kind: 'user', text: content.map(part => part.type === 'text' ? part.text ?? '' : '[非文本输入]').join('\n'), status: 'completed', ...(input.clientId ? { operationId: input.clientId } : {}) };
    }
    case 'agentMessage': return { ...base, kind: 'assistant', text: input.text ?? '', status: running ? 'running' : 'completed' };
    case 'commandExecution': return { ...base, kind: 'tool', text: [input.command ?? '执行命令', input.aggregatedOutput].filter(Boolean).join('\n'), tool: { name: '运行命令', input: input.command?.slice(0,32000), output: input.aggregatedOutput?.slice(0,128000) }, status };
    case 'fileChange': return { ...base, kind: 'tool', text: '修改工作区文件', tool: { name: '修改文件', output: input.changes?.map(c => c.path + '\n' + (c.diff ?? '')).join('\n').slice(0,128000) }, status };
    case 'mcpToolCall': case 'dynamicToolCall': return { ...base, kind: 'tool', text: input.tool ?? input.name ?? '调用工具', tool: { name: input.tool ?? input.name ?? '调用工具' }, status };
    case 'imageGeneration': return { ...base, kind: 'assistant', text: status === 'failed' ? '图片生成未完成。' : status === 'completed' && !input.result && !input.savedPath ? '原生图片资源暂不可读取。' : '', status, ...((input.result || input.savedPath) ? { imageSources: [{ ...(input.result ? { data: input.result } : { path: input.savedPath }) }] } : {}) };
    case 'reasoning': return { ...base, kind: 'notice', text: input.summary?.join('\n') ?? '思考', status: running ? 'running' : 'completed' };
    case 'plan': return { ...base, kind: 'notice', text: input.text ?? '更新计划', status: running ? 'running' : 'completed' };
    default: return { ...base, kind: 'notice', text: `暂不支持的原生条目：${input.type}`, status: 'completed' };
  }
}

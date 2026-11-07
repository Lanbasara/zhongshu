import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeRequest } from '../types.ts';
import type { ApprovalDecision, RequestAnswer, RequestField } from '../../shared/workbench.ts';
import { approvalDecisionSchema } from '../../shared/workbench.ts';
import { nativeId } from './protocol.ts';

/** Server requests this client can present and answer. Everything else is refused without granting anything. */
export const answerableMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput']);
/** The label the official client uses for a typed answer instead of an option. */
export const otherLabel = 'None of the above';

const encoder = new TextEncoder();
/** Truncate to a UTF-8 byte budget without splitting a character. */
export function clip(value: string, bytes: number): string {
  if (encoder.encode(value).byteLength <= bytes) return value;
  let out = ''; let used = 0;
  for (const char of value) { const size = encoder.encode(char).byteLength; if (used + size > bytes - 3) break; out += char; used += size; }
  return `${out}…`;
}
const optionalText = (bytes: number) => z.string().nullish().transform(value => value ? clip(value, bytes) : undefined);
const pathList = z.array(z.string().max(4096)).max(64).nullish();

const base = z.object({ threadId: nativeId, turnId: nativeId, itemId: nativeId, startedAtMs: z.number().int().min(0).nullish(), reason: optionalText(8000) }).passthrough();
const commandParams = base.extend({ command: optionalText(32_000), cwd: optionalText(4096), networkApprovalContext: z.unknown().nullish(), availableDecisions: z.array(z.unknown()).max(16).nullish() });
const fileParams = base.extend({ grantRoot: z.string().max(4096).nullish() });
const fileSystem = z.object({ read: pathList, write: pathList }).passthrough().nullish();
const permissionParams = base.extend({ cwd: optionalText(4096), permissions: z.object({ network: z.object({ enabled: z.boolean().nullish() }).passthrough().nullish(), fileSystem }).passthrough() });
const elicitationParams = z.object({ threadId: nativeId, turnId: nativeId.nullish(), serverName: z.string().min(1).max(400), mode: z.string().max(100) }).passthrough();
const formParams = elicitationParams.extend({ message: z.string().max(64 * 1024), requestedSchema: z.object({ type: z.literal('object'), properties: z.record(z.string().max(200), z.unknown()), required: z.array(z.string().max(200)).max(64).nullish() }).passthrough() });
const userInputParams = z.object({ threadId: nativeId, turnId: nativeId, itemId: nativeId, questions: z.array(z.object({
  id: z.string().min(1).max(240), header: z.string().max(400), question: z.string().max(64 * 1024), isOther: z.boolean().optional(), isSecret: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1).max(400), description: z.string().max(4000) }).passthrough()).max(16).nullish(),
}).passthrough()).min(1).max(8) }).passthrough();
const urlParams = elicitationParams.extend({ message: z.string().max(64 * 1024), url: z.url({ protocol: /^https$/ }).max(4096), elicitationId: z.string().min(1).max(400) });

const allDecisions: ApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
/** Keep the plain decisions the native request offers, in its order; policy amendments are outside this product. */
function decisions(offered: unknown[] | null | undefined): ApprovalDecision[] {
  if (!offered) return allDecisions;
  const plain = offered.flatMap(value => { const parsed = approvalDecisionSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  return plain.length ? [...new Set(plain)] : ['cancel'];
}

/** Stable across replays (same connection id and item) and unique across App Server restarts (item ids are unique). */
export const requestKey = (threadId: string, rpcId: string | number, item: string) =>
  `cx_${createHash('sha256').update(JSON.stringify([threadId, String(rpcId), item])).digest('base64url').slice(0, 40)}`;

export type Parsed = {
  threadId: string; request: NativeRequest;
  /** Native result for a valid answer, or undefined when the answer does not fit this request. */
  result(answer: RequestAnswer): unknown;
};
type Unsupported = { threadId: string; unsupported: true; notice: string };

function field(name: string, raw: unknown, required: boolean): RequestField | undefined {
  const schema = z.object({ type: z.string().max(40), title: z.string().max(400).nullish(), description: z.string().max(4000).nullish(),
    enum: z.array(z.string().max(400)).max(32).nullish(), oneOf: z.array(z.object({ const: z.string().max(400), title: z.string().max(400).nullish() }).passthrough()).max(32).nullish() }).passthrough().safeParse(raw);
  if (!schema.success) return;
  const value = schema.data; const label = clip(value.title?.trim() || name, 400);
  const description = value.description ? { description: clip(value.description, 4000) } : {};
  if (value.type === 'string' && (value.enum?.length || value.oneOf?.length))
    return { name, label, ...description, type: 'enum', required, options: value.enum?.length ? value.enum : value.oneOf!.map(option => option.const) };
  if (value.type === 'string' || value.type === 'number' || value.type === 'integer' || value.type === 'boolean') return { name, label, ...description, type: value.type, required };
  return undefined;
}

/**
 * Translate one App Server request into the product shape. Returns undefined for methods this client does
 * not answer, and an `unsupported` marker for answerable methods whose content cannot be presented faithfully.
 */
export function parseServerRequest(method: string, rpcId: string | number, raw: unknown, fileEdits: (itemId: string) => string[] | undefined, now = Date.now()): Parsed | Unsupported | undefined {
  if (method === 'item/commandExecution/requestApproval') {
    const params = commandParams.safeParse(raw); if (!params.success) return;
    const value = params.data; const offered = decisions(value.availableDecisions);
    return {
      threadId: value.threadId,
      request: { id: requestKey(value.threadId, rpcId, value.itemId), kind: 'approval', createdAt: value.startedAtMs ?? now,
        approval: { action: 'command', decisions: offered, ...(value.reason ? { reason: value.reason } : {}), ...(value.command ? { command: value.command } : {}),
          ...(value.cwd ? { cwd: value.cwd } : {}), ...(value.networkApprovalContext ? { network: true } : {}) } },
      result: answer => answer.kind === 'approval' && offered.includes(answer.decision) ? { decision: answer.decision } : undefined,
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const params = fileParams.safeParse(raw); if (!params.success) return;
    const value = params.data; const paths = (value.grantRoot ? [value.grantRoot] : fileEdits(value.itemId) ?? []).slice(0, 64).map(path => clip(path, 4096));
    return {
      threadId: value.threadId,
      request: { id: requestKey(value.threadId, rpcId, value.itemId), kind: 'approval', createdAt: value.startedAtMs ?? now,
        approval: { action: 'fileChange', decisions: allDecisions, ...(value.reason ? { reason: value.reason } : {}), ...(paths.length ? { paths } : {}) } },
      result: answer => answer.kind === 'approval' ? { decision: answer.decision } : undefined,
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const params = permissionParams.safeParse(raw); if (!params.success) return;
    const value = params.data; const requested = value.permissions;
    const paths = [...(requested.fileSystem?.write ?? []), ...(requested.fileSystem?.read ?? [])].slice(0, 64).map(path => clip(path, 4096));
    const offered: ApprovalDecision[] = ['accept', 'acceptForSession', 'decline'];
    // Granting returns exactly what was requested; declining grants nothing for this turn.
    const granted = { ...(requested.network ? { network: requested.network } : {}), ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}) };
    return {
      threadId: value.threadId,
      request: { id: requestKey(value.threadId, rpcId, value.itemId), kind: 'approval', createdAt: value.startedAtMs ?? now,
        approval: { action: 'permissions', decisions: offered, ...(value.reason ? { reason: value.reason } : {}), ...(paths.length ? { paths } : {}),
          ...(requested.network?.enabled ? { network: true } : {}), ...(value.cwd ? { cwd: value.cwd } : {}) } },
      result: answer => answer.kind !== 'approval' || !offered.includes(answer.decision) ? undefined
        : answer.decision === 'decline' ? { permissions: {}, scope: 'turn' } : { permissions: granted, scope: answer.decision === 'acceptForSession' ? 'session' : 'turn' },
    };
  }
  if (method === 'item/tool/requestUserInput') {
    const params = userInputParams.safeParse(raw); if (!params.success) return;
    const value = params.data; const questions = value.questions;
    if (new Set(questions.map(question => question.id)).size !== questions.length) return;
    return {
      threadId: value.threadId,
      request: { id: requestKey(value.threadId, rpcId, value.itemId), kind: 'question', createdAt: now, questions: questions.map(question => ({
        id: question.id, ...(question.header.trim() ? { header: clip(question.header, 400) } : {}), text: clip(question.question, 16_000), multiple: false,
        custom: question.isOther !== false, options: (question.options ?? []).map(option => ({ label: option.label, ...(option.description ? { description: clip(option.description, 4000) } : {}) })),
      })) },
      // As the official client answers: at most one option label, or the "other" label, plus an optional note.
      result: answer => {
        if (answer.kind !== 'question' || answer.answers.length > questions.length) return;
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of questions) {
          const given = answer.answers.find(item => item.id === question.id);
          if (!given) return;
          const labels = new Set((question.options ?? []).map(option => option.label));
          if (given.selected.length > 1 || given.selected.some(label => !labels.has(label))) return;
          const note = given.custom?.trim();
          if (note && question.isOther === false) return;
          const chosen = given.selected[0] ?? (note ? otherLabel : undefined);
          answers[question.id] = { answers: [...(chosen ? [chosen] : []), ...(note ? [`user_note: ${note}`] : [])] };
        }
        return { answers };
      },
    };
  }
  if (method === 'mcpServer/elicitation/request') {
    const envelope = elicitationParams.safeParse(raw); if (!envelope.success) return;
    const source = clip(envelope.data.serverName, 400); const threadId = envelope.data.threadId;
    const key = requestKey(threadId, rpcId, `elicitation:${envelope.data.turnId ?? ''}`);
    const formResult = (answer: RequestAnswer, fields?: RequestField[]) => {
      if (answer.kind !== 'form') return;
      if (answer.action !== 'accept') return { action: answer.action, content: null, _meta: null };
      const values = answer.values ?? {};
      if (!fields) return { action: 'accept', content: null, _meta: null };
      const content: Record<string, string | number | boolean> = {};
      for (const item of fields) {
        const value = values[item.name];
        if (value === undefined) { if (item.required && item.type !== 'boolean') return; continue; }
        if (item.type === 'boolean' ? typeof value !== 'boolean' : item.type === 'number' || item.type === 'integer' ? typeof value !== 'number' || (item.type === 'integer' && !Number.isInteger(value)) : typeof value !== 'string') return;
        if (item.type === 'enum' && !item.options?.includes(value as string)) return;
        content[item.name] = value;
      }
      if (Object.keys(values).some(name => !fields.some(item => item.name === name))) return;
      return { action: 'accept', content, _meta: null };
    };
    if (envelope.data.mode === 'url') {
      const params = urlParams.safeParse(raw);
      if (!params.success) return { threadId, unsupported: true, notice: `「${source}」请求打开的链接不是 HTTPS 地址，中书已拒绝。` };
      return { threadId, request: { id: key, kind: 'form', createdAt: now, form: { source, message: clip(params.data.message, 16_000), url: params.data.url, fields: [] } },
        result: answer => formResult(answer) };
    }
    if (envelope.data.mode === 'form') {
      const params = formParams.safeParse(raw);
      if (!params.success) return { threadId, unsupported: true, notice: `中书无法呈现「${source}」的这份表单，已拒绝。` };
      const required = new Set(params.data.requestedSchema.required ?? []);
      const entries = Object.entries(params.data.requestedSchema.properties);
      const fields = entries.slice(0, 24).map(([name, value]) => field(name, value, required.has(name)));
      if (entries.length > 24 || fields.some(item => !item)) return { threadId, unsupported: true, notice: `中书无法呈现「${source}」表单中的部分字段，已拒绝。` };
      return { threadId, request: { id: key, kind: 'form', createdAt: now, form: { source, message: clip(params.data.message, 16_000), fields: fields as RequestField[] } },
        result: answer => formResult(answer, fields as RequestField[]) };
    }
    return { threadId, unsupported: true, notice: `中书暂不支持「${source}」的这类信息请求，已拒绝。` };
  }
  return undefined;
}

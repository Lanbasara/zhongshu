import { z } from 'zod';

/** Shown in the device list; the browser describes itself (for example "Android · Chrome"). */
export const deviceLabelSchema = z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ·()._/-]+$/u);
export const pushSubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(128), auth: z.string().min(1).max(64) }).strict(),
  label: deviceLabelSchema,
}).strict();
/** SHA-256 of the endpoint, truncated; lets a page recognise its own subscription without the server echoing endpoints. */
export const pushFingerprintSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const pushDeviceSchema = z.object({
  id: z.uuid(), label: deviceLabelSchema, fingerprint: pushFingerprintSchema, createdAt: time,
  deliveredAt: time.nullable(), failedAt: time.nullable(), failure: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable(),
  /** False when the subscription was made for an earlier instance key; the device must turn notifications on again. */
  current: z.boolean(),
}).strict();
export const pushDeviceLimit = 20;
export const pushStateSchema = z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/), devices: z.array(pushDeviceSchema).max(pushDeviceLimit) }).strict();
export const pushSubscribeResponseSchema = z.object({ id: z.uuid() }).strict();
export const pushTestResponseSchema = z.object({ delivered: z.boolean(), failure: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable() }).strict();
export type PushDevice = z.infer<typeof pushDeviceSchema>;
export type PushState = z.infer<typeof pushStateSchema>;

/** Events that reach a device. Notifications name the event and the conversation title, never message, question or file content (ADR 0018). */
export type PushKind = 'completed' | 'failed' | 'interrupted' | 'waiting' | 'account' | 'test';
export type PushHarness = 'codex' | 'dsh';
const harnessNames: Record<PushHarness, string> = { codex: 'Codex', dsh: 'DSH' };

/** The decrypted push message the service worker renders as is. */
export type PushMessage = { v: 1; kind: PushKind; title: string; body: string; url: string; tag: string; badge?: number };

/** A conversation title as a notification heading: one line, at most 80 characters. */
export function notificationTitle(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = [...line];
  return characters.length > 80 ? `${characters.slice(0, 79).join('')}…` : line;
}

/**
 * The message for one event. With a conversation title (ADR 0018, 2026-11-07) the title heads the notification
 * and the body names the event; message, question and file content never appear.
 */
export function pushMessage(event: { kind: PushKind; conversationId?: string; harnessId?: PushHarness; title?: string }, badge?: number): PushMessage {
  const name = event.harnessId ? harnessNames[event.harnessId] : 'Agent';
  const conversation = event.conversationId ? `/#${event.conversationId}` : '/';
  const tag = event.conversationId ? `conversation:${event.conversationId}` : `zhongshu:${event.kind}`;
  const heading = event.title === undefined ? '' : notificationTitle(event.title);
  const words: Record<PushKind, [string, string, string]> = {
    completed: heading ? [heading, `${name} 已完成，点开查看结果。`, conversation] : [`${name} 对话已完成`, '点开查看结果。', conversation],
    failed: heading ? [heading, `${name} 失败了，点开查看原因。`, conversation] : [`${name} 对话失败了`, '点开查看原因。', conversation],
    interrupted: heading ? [heading, `${name} 中断了，点开查看。`, conversation] : [`${name} 对话中断了`, '点开查看。', conversation],
    waiting: heading ? [heading, `${name} 在等你回答或批准。`, conversation] : [`${name} 在等你回答或批准`, '点开处理。', conversation],
    account: [`${name} 账号需要处理`, '点开设置查看。', '/'],
    test: ['中书测试通知', '这台设备能收到中书的通知。', '/'],
  };
  const [title, body, url] = words[event.kind];
  return { v: 1, kind: event.kind, title, body, url, tag, ...(badge === undefined ? {} : { badge }) };
}

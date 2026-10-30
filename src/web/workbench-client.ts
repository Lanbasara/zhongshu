import { z } from 'zod';
import { errorSchema } from '../shared/http.ts';

export class RequestError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 0) { super(code); this.code = code; this.status = status; }
}
const root = '/api/private/workbench';
/** A bounded, same-origin read. An uncertain write is retried only with its original ID. */
export async function request<T>(path: string, schema: z.ZodType<T>, options: { signal?: AbortSignal; body?: unknown; csrf?: string } = {}): Promise<T> {
  const response = await fetch(root + path, {
    method: options.body === undefined ? 'GET' : 'POST', cache: 'no-store',
    signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]),
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrf ?? '' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const reader = response.body?.getReader(); if (!reader) throw new RequestError('empty_response');
  const parts: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 12 * 1024 * 1024) { await reader.cancel(); throw new RequestError('response_too_large'); } parts.push(part.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok) throw new RequestError(errorSchema.safeParse(value).data?.error ?? 'request_failed', response.status);
  return schema.parse(value);
}

const prefix = 'zhongshu:draft:v1:';
const draftSchema = z.object({ text: z.string().max(16_000), pending: z.object({ id: z.uuid(), text: z.string().max(16_000) }).optional() });
export type Draft = z.infer<typeof draftSchema>;
export function readDraft(id: string): Draft {
  try { return draftSchema.parse(JSON.parse(sessionStorage.getItem(prefix + id) ?? '{}')); } catch { return { text: '' }; }
}
export function saveDraft(id: string, draft: Draft): boolean {
  try { if (!draft.text && !draft.pending) sessionStorage.removeItem(prefix + id); else sessionStorage.setItem(prefix + id, JSON.stringify(draft)); return true; } catch { return false; }
}
export function clearDrafts(): void {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch { /* Storage may be disabled; in-memory drafts disappear with the authenticated view. */ }
}

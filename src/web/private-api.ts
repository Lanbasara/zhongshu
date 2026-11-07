import { z } from 'zod';
import { errorSchema } from '../shared/http.ts';
import { RequestError } from './workbench-client.ts';

/** A bounded same-origin call to a private route outside the workbench prefix (push, accounts). */
export async function privateRequest<T>(path: string, schema: z.ZodType<T>, options: { csrf?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const response = await fetch(`/api/private${path}`, {
    method: options.body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrf ?? '' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (text.length > 256 * 1024) throw new RequestError('response_too_large');
  const value: unknown = JSON.parse(text);
  if (!response.ok) throw new RequestError(errorSchema.safeParse(value).data?.error ?? 'request_failed', response.status);
  return schema.parse(value);
}

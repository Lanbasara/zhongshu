/** Create the empty corpus conversation through the real authenticated API.
 * Credentials stay in the disposable fixture's private directory and memory. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
const args = parseArgs({ options: { root: { type: 'string' }, port: { type: 'string' } }, strict: true });
const options = z.object({ root: z.string().refine(isAbsolute), port: z.coerce.number().int().min(1024).max(65535) }).parse(args.values);
const origin = `http://127.0.0.1:${options.port}`;
const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ password: readFileSync(join(options.root, 'private/password'), 'utf8') }), signal: AbortSignal.timeout(10000) });
if (!login.ok) throw new Error('fixture_login_failed');
const { csrfToken } = await login.json() as { csrfToken: string };
const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
const headers = { cookie, origin, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
const configResponse = await fetch(origin + '/api/private/workbench/configuration', { headers });
if (!configResponse.ok) throw new Error('fixture_configuration_failed');
const config = await configResponse.json() as { workspaces: { id: string }[]; harnesses: { id: string; models: { id: string }[]; permissions: { id: string }[] }[] };
const harness = config.harnesses.find(value => value.id === 'codex')!;
const id = randomUUID();
const created = await fetch(origin + '/api/private/workbench/conversations', { method: 'POST', headers,
  body: JSON.stringify({ id, title: 'Performance 60000', harnessId: harness.id, workspaceId: config.workspaces[0]!.id,
    configuration: { modelId: harness.models[0]!.id, permissionId: harness.permissions[0]!.id } }), signal: AbortSignal.timeout(10000) });
if (created.status !== 202) throw new Error('fixture_create_failed');
let ready = false;
for (let n = 0; n < 100; n++) {
  const response = await fetch(origin + '/api/private/workbench/conversations/' + id, { headers });
  if (response.ok && (await response.json() as { conversation: { readiness: string } }).conversation.readiness === 'ready') { ready = true; break; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) throw new Error('fixture_create_not_ready');
console.log(JSON.stringify({ conversationId: id, ready: true }));

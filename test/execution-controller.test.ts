import assert from 'node:assert/strict';
import { chmod, chown, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createExecutionController, executionControllerProtocol, type ExecutionEpoch } from '../src/server/execution-controller.ts';

const initial: ExecutionEpoch = { generation: 'persistent-group-identity', epoch: 4 };
const frozenSetId = 'a'.repeat(64);

// A synthetic operator executable, never a real Host or workspace. Its durable
// state/receipts make lost replies and a new application client reproducible.
const fixtureSource = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
writeFileSync('request.json', JSON.stringify({ request, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
const mode = JSON.parse(readFileSync('mode.json', 'utf8'));
if (mode.stdoutBytes) { process.stdout.write('x'.repeat(mode.stdoutBytes)); process.exit(0); }
if (mode.stderrBytes) { process.stderr.write('private controller diagnostics'.repeat(mode.stderrBytes)); process.exit(0); }
if (mode.exit) process.exit(mode.exit);
if (mode.legacy) { process.stdout.write(JSON.stringify({ state: 'paused' })); process.exit(0); }
let state = JSON.parse(readFileSync('state.json', 'utf8'));
const receipts = JSON.parse(readFileSync('receipts.json', 'utf8'));
let response = { protocol: request.protocol, action: request.action, groupId: request.groupId, requestId: request.requestId,
  ...(request.expected ? { expected: request.expected } : {}),
  ...(request.frozenSetId ? { frozenSetId: request.frozenSetId } : {}), status: 'known', state };
if (request.action !== 'inspect') {
  const receipt = receipts.find(item => item.request.requestId === request.requestId);
  if (receipt) {
    response = JSON.stringify(receipt.request) === JSON.stringify(request) ? receipt.response : { ...response, status: 'rejected', state: undefined };
  } else if (request.expected.generation !== state.generation || request.expected.epoch !== state.epoch) {
    response = { ...response, status: 'rejected', state: undefined };
  } else {
    state = { ...state, epoch: state.epoch + 1,
      admission: request.action === 'fence' ? 'drain' : request.action === 'quiesce' ? 'closed' : 'open',
      writers: request.action === 'quiesce' ? 'quiescent' : 'running',
      ...(request.frozenSetId ? { frozenSetId: request.frozenSetId } : {}) };
    if (request.action === 'resume') delete state.frozenSetId;
    response.state = state;
    receipts.push({ request, response });
    writeFileSync('state.json', JSON.stringify(state));
    writeFileSync('receipts.json', JSON.stringify(receipts));
  }
}
if (mode.state) response.state = { ...response.state, ...mode.state };
if (mode.response) response = { ...response, ...mode.response };
writeFileSync('ready.json', JSON.stringify({ requestId: request.requestId }));
while (mode.waitForRelease && !existsSync('release')) await new Promise(resolve => setTimeout(resolve, 10));
if (mode.delayMs) await new Promise(resolve => setTimeout(resolve, mode.delayMs));
process.stdout.write(JSON.stringify(response));
`;

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'zhongshu-controller-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Shell metacharacters in the operator file name remain a literal executable.
  const executable = join(directory, 'controller $(touch injected)');
  await writeFile(executable, fixtureSource, { mode: 0o700 });
  await writeFile(join(directory, 'state.json'), JSON.stringify({ groupId: 'example-group', ...initial, admission: 'open', writers: 'running', durable: true }));
  await writeFile(join(directory, 'receipts.json'), '[]');
  const mode = (value: object) => writeFile(join(directory, 'mode.json'), JSON.stringify(value));
  await mode({});
  const client = (timeouts: { inspectTimeoutMs?: number; mutationTimeoutMs?: number } = {}) =>
    createExecutionController({ executable, groupId: 'example-group', ...timeouts });
  return { directory, executable, mode, client };
}

test('execution controller exchanges bounded JSON through a fixed command and durable identities', async t => {
  const f = await fixture(t);
  const controller = f.client();
  assert.deepEqual(await controller.inspect('inspect-initial', initial), {
    status: 'known', state: { groupId: 'example-group', ...initial, admission: 'open', writers: 'running', durable: true },
  });
  const request = { requestId: 'fence-stable-request', expected: initial, frozenSetId };
  const fenced = await controller.fence(request);
  assert.equal(fenced.status, 'known');
  if (fenced.status !== 'known') return;
  assert.equal(fenced.state.admission, 'drain');
  assert.equal(fenced.state.epoch, 5);
  assert.equal(fenced.state.frozenSetId, frozenSetId);
  assert.deepEqual(await controller.fence(request), fenced, 'retry preserves requestId and returns the same epoch');
  assert.deepEqual(await f.client().fence(request), fenced, 'a new application client can replay the durable receipt');
  const wire = JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8'));
  assert.deepEqual(wire.request, { protocol: executionControllerProtocol, action: 'fence', groupId: 'example-group', ...request });
  assert.deepEqual(wire.argv, ['zhongshu-execution-controller-v1']);
  assert.equal(wire.cwd, f.directory);
  assert.deepEqual(Object.keys(wire.env).filter(key => key !== '__CF_USER_TEXT_ENCODING'), ['PATH'],
    'only the explicit PATH and a possible macOS runtime encoding variable are present');
  assert.equal(wire.env.PATH, '/usr/bin:/bin:/usr/local/bin');
  await assert.rejects(readFile(join(f.directory, 'injected')));
  const quiesced = await controller.quiesce({ requestId: 'quiesce', expected: { ...initial, epoch: 5 }, frozenSetId });
  assert.equal(quiesced.status, 'known');
  if (quiesced.status !== 'known') return;
  assert.equal(quiesced.state.admission, 'closed');
  assert.equal(quiesced.state.writers, 'quiescent');
  assert.equal(quiesced.state.epoch, 6);
  const resumed = await controller.resume({ requestId: 'resume', expected: { ...initial, epoch: 6 } });
  assert.deepEqual(resumed, { status: 'known', state: { groupId: 'example-group', ...initial, epoch: 7, admission: 'open', writers: 'running', durable: true } });
});

test('unsafe executable ownership, mode, type, and writable ancestors fail closed', async t => {
  const f = await fixture(t);
  for (const mode of [0o600, 0o720, 0o702]) {
    await chmod(f.executable, mode);
    assert.deepEqual(await f.client().inspect('unsafe-mode'), { status: 'unknown', reason: 'unsafe_executable' });
  }
  await chmod(f.executable, 0o700);
  const link = join(f.directory, 'alias');
  await symlink(f.executable, link);
  assert.deepEqual(await createExecutionController({ executable: link, groupId: 'example-group' }).inspect('symlink'), { status: 'unknown', reason: 'unsafe_executable' });
  const directory = join(f.directory, 'directory');
  await mkdir(directory);
  assert.deepEqual(await createExecutionController({ executable: directory, groupId: 'example-group' }).inspect('directory'), { status: 'unknown', reason: 'unsafe_executable' });
  await chmod(f.directory, 0o770);
  assert.deepEqual(await f.client().inspect('unsafe-directory'), { status: 'unknown', reason: 'unsafe_executable' });
  await chmod(f.directory, 0o700);
  assert.equal((await f.client().inspect('restored-permissions')).status, 'known');
  if (process.getuid?.() === 0) {
    await chown(f.executable, 1, 1);
    assert.deepEqual(await f.client().inspect('foreign-owner'), { status: 'unknown', reason: 'unsafe_executable' });
  } else {
    assert.deepEqual(await createExecutionController({ executable: '/bin/sh', groupId: 'example-group' }).inspect('foreign-owner'), { status: 'unknown', reason: 'unsafe_executable' });
  }
});

test('platform directory aliases resolve, while executable symlinks remain forbidden', async t => {
  const f = await fixture(t);
  const directoryAlias = join(f.directory, 'directory-alias');
  const executableDirectory = join(f.directory, 'controller-home');
  await mkdir(executableDirectory, { mode: 0o700 });
  await writeFile(join(executableDirectory, 'controller'), fixtureSource, { mode: 0o700 });
  for (const name of ['state.json', 'mode.json', 'receipts.json'])
    await writeFile(join(executableDirectory, name), await readFile(join(f.directory, name)));
  await symlink(executableDirectory, directoryAlias);
  const controller = createExecutionController({ executable: join(directoryAlias, 'controller'), groupId: 'example-group' });
  assert.equal((await controller.inspect('canonical-directory')).status, 'known');
});

test('untrusted request fields are rejected before spawning a controller', async t => {
  const f = await fixture(t);
  const controller = f.client();
  for (const request of [
    { requestId: '$(touch injected)', expected: initial },
    { requestId: 'valid', expected: { ...initial, epoch: -1 } },
    { requestId: 'valid', expected: { ...initial, epoch: Number.MAX_SAFE_INTEGER } },
    { requestId: 'valid', expected: initial, frozenSetId: 'unbounded-or-non-digest' },
    { requestId: 'valid', expected: initial, command: 'resume' },
  ]) assert.deepEqual(await controller.fence(request as Parameters<typeof controller.fence>[0]), { status: 'unknown', reason: 'invalid_request' });
  assert.deepEqual(await controller.resume({ requestId: 'valid', expected: initial, frozenSetId } as Parameters<typeof controller.resume>[0]), { status: 'unknown', reason: 'invalid_request' });
  await assert.rejects(readFile(join(f.directory, 'request.json')), 'no invalid request reaches the executable');
  assert.throws(() => createExecutionController({ executable: 'relative-path', groupId: 'example-group' }));
});

test('legacy receipts, unknowns, malformed states and mismatched response identities cannot authorize editing', async t => {
  const f = await fixture(t);
  const cases = [
    { mode: { legacy: true }, reason: 'invalid_response' },
    { mode: { response: { status: 'unknown' } }, reason: 'controller_unknown' },
    { mode: { response: { status: 'rejected' } }, reason: 'controller_unknown' },
    { mode: { response: { protocol: 'legacy-v0' } }, reason: 'invalid_response' },
    { mode: { response: { action: 'resume' } }, reason: 'identity_mismatch' },
    { mode: { response: { requestId: 'another-request' } }, reason: 'identity_mismatch' },
    { mode: { response: { groupId: 'another-group' } }, reason: 'identity_mismatch' },
    { mode: { state: { groupId: 'another-group' } }, reason: 'identity_mismatch' },
    { mode: { state: { admission: 'closed', writers: 'running' } }, reason: 'invalid_response' },
    { mode: { state: { durable: false } }, reason: 'invalid_response' },
    { mode: { state: { epoch: -1 } }, reason: 'invalid_response' },
    { mode: { state: { generation: 'replacement-group' } }, reason: 'epoch_mismatch' },
    { mode: { state: { epoch: 3 } }, reason: 'epoch_mismatch' },
    { mode: { response: { expected: { ...initial, epoch: 3 } } }, reason: 'identity_mismatch' },
  ];
  for (const [index, value] of cases.entries()) {
    await f.mode(value.mode);
    assert.deepEqual(await f.client().inspect(`case-${index}`, initial), { status: 'unknown', reason: value.reason });
  }
});

test('fence and quiesce bind their frozen set and mutations must advance exactly one epoch', async t => {
  const f = await fixture(t);
  await f.mode({ response: { frozenSetId: 'b'.repeat(64) } });
  assert.deepEqual(await f.client().fence({ requestId: 'fence', expected: initial, frozenSetId }), { status: 'unknown', reason: 'identity_mismatch' });
  await f.mode({ state: { frozenSetId: 'b'.repeat(64) } });
  assert.deepEqual(await f.client().quiesce({ requestId: 'quiesce', expected: { ...initial, epoch: 5 }, frozenSetId }), { status: 'unknown', reason: 'invalid_response' });
  await f.mode({ state: { epoch: 6 } });
  assert.deepEqual(await f.client().resume({ requestId: 'resume', expected: { ...initial, epoch: 6 } }), { status: 'unknown', reason: 'epoch_mismatch' });
});

test('old epochs, a changed generation, and conflicting same-epoch receipts never roll back observed state', async t => {
  const f = await fixture(t);
  const controller = f.client();
  assert.equal((await controller.inspect('initial')).status, 'known');
  await f.mode({ state: { epoch: 3 } });
  assert.deepEqual(await controller.inspect('old'), { status: 'unknown', reason: 'stale_response' });
  await f.mode({ state: { generation: 'new-group' } });
  assert.deepEqual(await controller.inspect('new-identity'), { status: 'unknown', reason: 'stale_response' });
  await f.mode({ state: { admission: 'closed', writers: 'quiescent' } });
  assert.deepEqual(await controller.inspect('conflicting-state'), { status: 'unknown', reason: 'stale_response' });
  await f.mode({});
  assert.equal((await controller.fence({ requestId: 'fence', expected: initial })).status, 'known');
  assert.deepEqual(await controller.resume({ requestId: 'old-resume', expected: initial }), { status: 'unknown', reason: 'controller_unknown' });
  assert.deepEqual(await controller.quiesce({ requestId: 'fence', expected: { ...initial, epoch: 5 } }), { status: 'unknown', reason: 'controller_unknown' });
});

test('controller response and diagnostic output are bounded and nonzero exits remain unknown', async t => {
  const f = await fixture(t);
  for (const mode of [{ stdoutBytes: 20_000 }, { stderrBytes: 20_000 }]) {
    await f.mode(mode);
    assert.deepEqual(await f.client().inspect('oversize'), { status: 'unknown', reason: 'response_too_large' });
  }
  await f.mode({ exit: 2 });
  assert.deepEqual(await f.client().inspect('failed'), { status: 'unknown', reason: 'controller_failure' });
});

test('timeout after a durable mutation preserves uncertainty and the stable request can reconcile', async t => {
  const f = await fixture(t);
  await f.mode({ delayMs: 5000 });
  const controller = f.client({ mutationTimeoutMs: 1500 });
  const request = { requestId: 'lost-fence-receipt', expected: initial, frozenSetId };
  const started = performance.now();
  assert.deepEqual(await controller.fence(request), { status: 'unknown', reason: 'timeout' });
  assert.ok(performance.now() - started < 3500, 'a timed-out invocation must not wait for its delayed output');
  assert.equal(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).epoch, 5, 'process timeout is not proof that the mutation did not happen');
  await f.mode({});
  const recovered = await f.client().fence(request);
  assert.equal(recovered.status, 'known');
  if (recovered.status === 'known') assert.equal(recovered.state.epoch, 5);
  const receipts = JSON.parse(await readFile(join(f.directory, 'receipts.json'), 'utf8'));
  assert.equal(receipts.length, 1, 'reconciliation does not repeat the mutation');
});

test('a late inspect cannot overwrite a newer response in the same application client', async t => {
  const f = await fixture(t);
  const controller = f.client();
  await f.mode({ waitForRelease: true });
  const old = controller.inspect('slow-inspection');
  // Wait for the synthetic controller to capture its epoch, not a timing guess.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (JSON.parse(await readFile(join(f.directory, 'ready.json'), 'utf8')).requestId === 'slow-inspection') break;
    } catch { /* the synthetic child has not opened stdin yet */ }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(JSON.parse(await readFile(join(f.directory, 'ready.json'), 'utf8')).requestId, 'slow-inspection');
  await f.mode({});
  assert.equal((await controller.fence({ requestId: 'fence-newer', expected: initial })).status, 'known');
  await writeFile(join(f.directory, 'release'), '');
  assert.deepEqual(await old, { status: 'unknown', reason: 'stale_response' });
});

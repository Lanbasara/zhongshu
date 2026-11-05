import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';

export const executionControllerProtocol = 'zhongshu.execution-control.v1' as const;
const command = 'zhongshu-execution-controller-v1';
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.object({ generation: identifier, epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const mutation = z.object({ requestId: identifier, expected: epoch, frozenSetId: digest.optional() }).strict();
const inspect = z.object({ requestId: identifier, expected: epoch.optional() }).strict();
const stateSchema = z.object({
  groupId: identifier,
  generation: identifier,
  epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  admission: z.enum(['open', 'drain', 'closed']),
  writers: z.enum(['running', 'quiescent']),
  durable: z.literal(true),
  frozenSetId: digest.optional(),
}).strict();
const responseSchema = z.object({
  protocol: z.literal(executionControllerProtocol),
  action: z.enum(['inspect', 'fence', 'quiesce', 'resume']),
  groupId: identifier,
  requestId: identifier,
  expected: epoch.optional(),
  frozenSetId: digest.optional(),
  status: z.enum(['known', 'unknown', 'rejected']),
  state: stateSchema.optional(),
}).strict();
const optionsSchema = z.object({
  executable: z.string().min(1).max(4096).refine(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0')),
  groupId: identifier,
  inspectTimeoutMs: z.number().int().min(10).max(120_000).default(15_000),
  mutationTimeoutMs: z.number().int().min(10).max(120_000).default(90_000),
}).strict();

export type ExecutionEpoch = z.infer<typeof epoch>;
export type ExecutionGroupState = z.infer<typeof stateSchema>;
export type ExecutionControllerMutation = z.infer<typeof mutation>;
export type ExecutionControllerFailure = 'invalid_request' | 'unsafe_executable' | 'controller_failure' | 'timeout' |
  'response_too_large' | 'invalid_response' | 'identity_mismatch' | 'epoch_mismatch' | 'stale_response' | 'controller_unknown' |
  'execution_host_recovery_backoff' | 'execution_host_recovery_exhausted' | 'execution_host_recovery_blocked';
export type ExecutionControllerResult = { status: 'known'; state: ExecutionGroupState } |
  { status: 'unknown'; reason: ExecutionControllerFailure };
export type ExecutionController = {
  inspect(requestId: string, expected?: ExecutionEpoch): Promise<ExecutionControllerResult>;
  fence(request: ExecutionControllerMutation): Promise<ExecutionControllerResult>;
  quiesce(request: ExecutionControllerMutation): Promise<ExecutionControllerResult>;
  resume(request: Omit<ExecutionControllerMutation, 'frozenSetId'>): Promise<ExecutionControllerResult>;
  /** Trusted in-process managed controller only; not part of executable v1. */
  recover?(request: { requestId: string; explicit: boolean }): Promise<ExecutionControllerResult>;
};
type Action = 'inspect' | 'fence' | 'quiesce' | 'resume';
type Request = { protocol: typeof executionControllerProtocol; action: Action; groupId: string; requestId: string;
  expected?: ExecutionEpoch; frozenSetId?: string };
type InvocationResult = { status: 'received'; response: string } | Extract<ExecutionControllerResult, { status: 'unknown' }>;
const unknown = (reason: ExecutionControllerFailure): Extract<ExecutionControllerResult, { status: 'unknown' }> => ({ status: 'unknown', reason });
const sameEpoch = (left: ExecutionEpoch | undefined, right: ExecutionEpoch | undefined) =>
  left?.generation === right?.generation && left?.epoch === right?.epoch;

// The operator-owned executable is a trust boundary, not a browser command API.
// Its durable gate must cover every writer and dispatch entrance. In drain mode,
// only the frozen, durably registered operations may be dispatched with the group,
// generation and epoch token. An idle Harness or a legacy paused receipt is not
// this proof. The controller, not this client, proves actual process quiescence.
// Each successful mutation advances epoch exactly once; retries with the same
// requestId and identical content replay that receipt without repeating effects.
// generation is a durable group identity, not a process boot ID. Lost controller
// storage requires reconciliation, never resetting epoch under the same identity.
export function createExecutionController(input: z.input<typeof optionsSchema>): ExecutionController {
  const options = optionsSchema.parse(input);
  let observed: ExecutionGroupState | undefined;

  async function call(action: Action, input: unknown): Promise<ExecutionControllerResult> {
    const parsed = (action === 'inspect' ? inspect : mutation).safeParse(input);
    if (!parsed.success || (action === 'resume' && 'frozenSetId' in parsed.data) ||
      (action !== 'inspect' && parsed.data.expected?.epoch === Number.MAX_SAFE_INTEGER)) return unknown('invalid_request');
    const request: Request = { protocol: executionControllerProtocol, action, groupId: options.groupId, ...parsed.data };
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 4096) return unknown('invalid_request');
    let executable: string;
    try { executable = await trustedExecutable(options.executable); }
    catch { return unknown('unsafe_executable'); }
    let result: InvocationResult;
    try { result = await invoke(executable, payload, action === 'inspect' ? options.inspectTimeoutMs : options.mutationTimeoutMs); }
    catch { return unknown('controller_failure'); }
    if (result.status !== 'received') return result;
    let response: z.infer<typeof responseSchema>;
    try { response = responseSchema.parse(JSON.parse(result.response)); }
    catch { return unknown('invalid_response'); }
    if (response.action !== action || response.groupId !== options.groupId || response.requestId !== request.requestId ||
      response.frozenSetId !== request.frozenSetId || !sameEpoch(response.expected, request.expected)) return unknown('identity_mismatch');
    if (response.status !== 'known') return unknown('controller_unknown');
    const state = response.state;
    if (!state || state.groupId !== options.groupId) return unknown('identity_mismatch');
    const validState = state.admission === 'closed' ? state.writers === 'quiescent' : state.writers === 'running';
    if (!validState || (state.admission === 'open' && state.frozenSetId !== undefined) ||
      (action === 'fence' && state.admission !== 'drain') || (action === 'quiesce' && state.admission !== 'closed') ||
      (action === 'resume' && state.admission !== 'open') ||
      (request.frozenSetId !== undefined && state.frozenSetId !== request.frozenSetId)) return unknown('invalid_response');
    if (request.expected && (state.generation !== request.expected.generation ||
      state.epoch !== request.expected.epoch + (action === 'inspect' ? 0 : 1))) return unknown('epoch_mismatch');
    if (observed && (state.generation !== observed.generation || state.epoch < observed.epoch)) return unknown('stale_response');
    // A durable epoch identifies one state. Conflicting receipts at the same epoch
    // cannot restore admission even if their envelopes individually look valid.
    if (observed && state.epoch === observed.epoch && (state.admission !== observed.admission ||
      state.writers !== observed.writers || state.frozenSetId !== observed.frozenSetId)) return unknown('stale_response');
    observed = state;
    return { status: 'known', state: { ...state } };
  }

  return {
    inspect: (requestId, expected) => call('inspect', { requestId, ...(expected ? { expected } : {}) }),
    fence: request => call('fence', request),
    quiesce: request => call('quiesce', request),
    resume: request => call('resume', request),
  };
}

async function trustedExecutable(file: string): Promise<string> {
  const info = await lstat(file);
  const uid = process.getuid?.();
  if (uid === undefined || !info.isFile() || !(info.mode & 0o100) || (info.mode & 0o022) || info.uid !== uid)
    throw new Error('unsafe_executable');
  // realpath resolves platform aliases such as macOS /var -> /private/var. The
  // executable itself may not be a symlink; operator scripts are regular files.
  const executable = await realpath(file);
  for (let directory = dirname(executable);;) {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || (parent.uid !== uid && parent.uid !== 0) ||
      ((parent.mode & 0o022) && !(parent.mode & 0o1000))) throw new Error('unsafe_executable');
    const next = dirname(directory);
    if (next === directory) break;
    directory = next;
  }
  return executable;
}

function invoke(executable: string, payload: string, timeoutMs: number): Promise<InvocationResult> {
  return new Promise(resolve => {
    const child = spawn(executable, [command], {
      shell: false, cwd: dirname(executable), env: { PATH: '/usr/bin:/bin:/usr/local/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (result: InvocationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      // Kill only this invocation on a failed/late reply. This says nothing about
      // the running group; any partially applied mutation stays unknown.
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve(result);
    };
    const timer = setTimeout(() => finish(unknown('timeout')), timeoutMs);
    child.once('error', () => finish(unknown('controller_failure')));
    child.stdin.once('error', () => finish(unknown('controller_failure')));
    child.stdout.once('error', () => finish(unknown('controller_failure')));
    child.stderr.once('error', () => finish(unknown('controller_failure')));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 16_384) finish(unknown('response_too_large'));
      else if (!settled) output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16_384) finish(unknown('response_too_large'));
    });
    child.once('close', code => {
      if (!settled) finish(code === 0
        ? { status: 'received', response: Buffer.concat(output, stdoutBytes).toString('utf8') }
        : unknown('controller_failure'));
    });
    child.stdin.end(payload);
  });
}

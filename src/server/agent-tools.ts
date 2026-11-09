/**
 * The tools Zhongshu offers agents (ADR 0021): `notify_user` and `record_result`, served as a minimal MCP Streamable
 * HTTP endpoint. It listens on loopback only, beside the native Hosts, and accepts one operator-provisioned bearer
 * token. The token grants nothing but these tools; it is never the administrator credential.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

export const NOTIFY_TOOL = 'notify_user';
export const RESULT_TOOL = 'record_result';
/** Kept short on purpose: every model request carries tool schemas. */
const notifyTool = {
  name: NOTIFY_TOOL,
  description: 'Send the user a one-line phone notification that opens this turn. Use only when they should look now: an alert they asked for, a met condition, a result needing their decision, or a brief they asked to receive. Your full result stays in your reply and files.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['summary'],
    properties: {
      summary: { type: 'string', maxLength: 120, description: 'The one line shown on the lock screen.' },
      file: { type: 'string', maxLength: 512, description: 'Optional workspace-relative path of the full result.' },
    },
  },
};
/** The conclusion goes back onto the task card that started the run (ADR 0021, 2026-11-09); it never notifies. */
const resultTool = {
  name: RESULT_TOOL,
  description: 'Required when a scheduled task started this run: call once as the last step, with a one-line conclusion. It is shown on that task\'s card; it does not notify the user.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['summary'],
    properties: { summary: { type: 'string', maxLength: 120, description: 'The conclusion, in the user\'s language.' } },
  },
};
const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
/**
 * Shown to the agent by the Host as this server's instructions. A tool description alone was not enough: on 2026-11-09
 * three scheduled runs on a long review finished without `record_result`, so the rule is stated here as well.
 */
export const RESULT_INSTRUCTIONS = 'When a scheduled task started this run (the Host marks the message as scheduled), the last step of the run is '
  + '`record_result` with a one-line conclusion; it goes on that task\'s card. Call it once, after the work and any `notify_user`.';
/** Where scheduling and calendar entries go (ADR 0022). */
export const SICHEN_INSTRUCTIONS = 'Scheduled tasks and calendar entries: use the shell command `sichen` (run `sichen --help` first). '
  + 'Write times as dates and clock times, e.g. `sichen schedule add "收盘复核" --at "2026-11-10 15:10" --to here --prompt "…"` or '
  + '`--every 工作日 --time 14:45 --until 2027-01-31`. `--to here` returns results to this conversation. '
  + 'It checks the rule and prints the next runs; do not write RRULE text or timeline JSON by hand.';
const message = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number()]).optional(), method: z.string().max(100), params: z.unknown().optional() }).passthrough();
const callParams = z.object({ name: z.string().max(100), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough();
const notifyArgs = z.object({ summary: z.string(), file: z.string().optional() }).strict();
const resultArgs = z.object({ summary: z.string() }).strict();

/** One line of at most 120 characters; control characters become spaces. */
export function oneLine(value: string, limit = 120): string {
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = [...line];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : line;
}
/** A workspace-relative path the page may later open through the workspace reader; never absolute or escaping. */
export function relativeFile(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = value.trim().replace(/^\.\/+/, '');
  if (!path || path.length > 512 || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path)) throw new Error('invalid_file');
  if (path.split('/').some(part => part === '..' || part === '')) throw new Error('invalid_file');
  return path;
}

export type NotifyOutcome = { id: string } | { refused: string };
type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export function createAgentTools(options: { token: string; port: number; version: string; notify(summary: string, file: string | undefined): NotifyOutcome; record(summary: string): NotifyOutcome;
  /** 司辰's HTTP endpoints on the same loopback server and token (ADR 0022); also turns on the instructions. */
  routes?(app: FastifyInstance, guard: Guard): Promise<void>; }) {
  const expected = createHash('sha256').update(options.token).digest();
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const authorized = (header: string | undefined) => {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{24,512})$/.exec(header ?? '');
    return !!match && timingSafeEqual(createHash('sha256').update(match[1]!).digest(), expected);
  };
  const result = (id: unknown, value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  const failure = (id: unknown, code: number, text: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
  const toolText = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

  function handle(raw: unknown): unknown | undefined {
    const parsed = message.safeParse(raw);
    if (!parsed.success) return failure(null, -32600, 'Invalid request');
    const { id, method, params } = parsed.data;
    if (id === undefined) return undefined; // notifications such as notifications/initialized need no answer
    if (method === 'initialize') {
      const requested = z.object({ protocolVersion: z.string().max(40) }).passthrough().safeParse(params).data?.protocolVersion;
      return result(id, { protocolVersion: requested && PROTOCOLS.includes(requested) ? requested : PROTOCOLS[2], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'zhongshu', version: options.version },
        instructions: options.routes ? `${RESULT_INSTRUCTIONS}\n\n${SICHEN_INSTRUCTIONS}` : RESULT_INSTRUCTIONS });
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools: [notifyTool, resultTool] });
    if (method === 'tools/call') {
      const call = callParams.safeParse(params);
      if (call.success && call.data.name === RESULT_TOOL) {
        const args = resultArgs.safeParse(call.data.arguments ?? {});
        if (!args.success) return result(id, toolText('参数无效：需要 summary（一句话结论）。', true));
        const summary = oneLine(args.data.summary);
        if (!summary) return result(id, toolText('summary 不能为空。', true));
        const outcome = options.record(summary);
        if ('refused' in outcome) return result(id, toolText(outcome.refused, true));
        // The number lets Zhongshu tie this tool record in the transcript to the run it concludes.
        return result(id, toolText(`已写到任务卡上。结论编号 ${outcome.id}`));
      }
      if (!call.success || call.data.name !== NOTIFY_TOOL) return failure(id, -32602, 'Unknown tool');
      const args = notifyArgs.safeParse(call.data.arguments ?? {});
      if (!args.success) return result(id, toolText('参数无效：需要 summary（一句话），可选 file（工作区相对路径）。', true));
      const summary = oneLine(args.data.summary);
      if (!summary) return result(id, toolText('summary 不能为空。', true));
      let file: string | undefined;
      try { file = relativeFile(args.data.file); } catch { return result(id, toolText('file 必须是工作区内的相对路径。', true)); }
      const outcome = options.notify(summary, file);
      if ('refused' in outcome) return result(id, toolText(outcome.refused, true));
      // The number lets Zhongshu tie this tool record in the transcript to the notification it sent.
      return result(id, toolText(`已通知用户。通知编号 ${outcome.id}`));
    }
    return failure(id, -32601, 'Method not found');
  }

  // Agents are not browsers; a page on this machine must not reach the tools, and only the token opens them.
  const guard: Guard = async (request, reply) => {
    if (request.headers.origin !== undefined) return reply.code(403).send();
    if (!authorized(request.headers.authorization)) return reply.code(401).send();
  };
  if (options.routes) app.register(async scoped => { await options.routes!(scoped, guard); });
  app.post('/mcp', async (request, reply) => {
    // Agents are not browsers; a page on this machine must not reach the tool.
    if (request.headers.origin !== undefined) return reply.code(403).send();
    if (!authorized(request.headers.authorization)) return reply.code(401).send();
    const body = request.body;
    if (Array.isArray(body)) {
      if (body.length > 16) return reply.code(400).send();
      const answers = body.map(handle).filter(value => value !== undefined);
      return answers.length ? reply.type('application/json').send(answers) : reply.code(202).send();
    }
    const answer = handle(body);
    return answer === undefined ? reply.code(202).send() : reply.type('application/json').send(answer);
  });
  // No server-initiated stream and no sessions: the client falls back to plain request and response.
  app.get('/mcp', async (_request, reply) => reply.code(405).header('Allow', 'POST').send());
  app.delete('/mcp', async (_request, reply) => reply.code(405).header('Allow', 'POST').send());

  return {
    async listen() { await app.listen({ host: '127.0.0.1', port: options.port }); },
    /** The bound port, for tests that listen on port 0. */
    port() { const value = app.server.address(); return typeof value === 'object' && value ? value.port : options.port; },
    async close() { await app.close(); },
    /** For tests: the Fastify instance without listening. */
    inject: app.inject.bind(app),
  };
}

import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createAuth } from './auth.ts';

export type Metadata = { name: string; version: string; revision: string };
export type PrivateContext = {
  auth: ReturnType<typeof createAuth>;
  token(request: FastifyRequest): string;
};
export type AppOptions = {
  db: DatabaseSync;
  origin: string;
  assetsDirectory?: string;
  metadata?: Metadata;
  logger?: boolean;
  privateRoutes?: (app: FastifyInstance, context: PrivateContext) => Promise<void>;
  onLogout?: (sessionId: string) => void;
};

const passwordBody = z.object({ password: z.string().min(1).max(1024) }).strict();
const cookieToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const csrfFor = (token: string) => createHmac('sha256', token).update('zhongshu:csrf:v1').digest('base64url');

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const secure = options.origin.startsWith('https:');
  const cookieName = secure ? '__Host-zhongshu' : 'zhongshu-development';
  const app = Fastify({
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 20_000,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'body'] } : false,
  });
  const auth = createAuth(options.db, { audit: event => app.log.info(event) });
  const token = (request: FastifyRequest) => {
    const parsed = cookieToken.safeParse(request.cookies[cookieName]);
    return parsed.success ? parsed.data : '';
  };
  const cookieSettings = { path: '/', httpOnly: true, secure, sameSite: 'strict' as const };
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers.origin !== options.origin || request.headers['sec-fetch-site'] === 'cross-site') {
        return reply.code(403).send({ error: 'invalid_origin' });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    if (status === 500) app.log.error({ event: 'request_failed' });
    return reply.code(status).send({ error: status === 500 ? 'service_unavailable' : 'invalid_request' });
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/version', async () => options.metadata ?? { name: 'zhongshu', version: '0.1.0', revision: 'development' });
  app.get('/api/session', async (request) => {
    const raw = token(request);
    const session = raw ? auth.authenticate(raw) : null;
    return session
      ? { authenticated: true, csrfToken: csrfFor(raw), expiresAt: session.expiresAt }
      : { authenticated: false, initialized: auth.initialized() };
  });
  app.post('/api/login', async (request, reply) => {
    const input = passwordBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await auth.login(input.data.password, { clientKey: request.ip, previousToken: token(request) || undefined });
    if (!result.ok) {
      app.log.info({ event: 'login_denied', reason: result.reason });
      if (result.retryAfterSeconds) reply.header('Retry-After', result.retryAfterSeconds);
      const status = result.reason === 'rate_limited' || result.reason === 'busy' ? 429 : result.reason === 'not_initialized' ? 503 : 401;
      return reply.code(status).send({ error: result.reason });
    }
    app.log.info({ event: 'session_created' });
    reply.setCookie(cookieName, result.token, { ...cookieSettings, expires: new Date(result.session.expiresAt) });
    return { authenticated: true, csrfToken: csrfFor(result.token), expiresAt: result.session.expiresAt };
  });
  await app.register(async (privateApp) => {
    privateApp.addHook('onRequest', async (request, reply) => {
      const raw = token(request);
      if (!raw || !auth.authenticate(raw)) return reply.code(401).send({ error: 'unauthenticated' });
      if (!['GET', 'HEAD'].includes(request.method)) {
        const supplied = request.headers['x-csrf-token'];
        const expected = csrfFor(raw);
        if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
          return reply.code(403).send({ error: 'invalid_csrf' });
        }
      }
    });
    privateApp.get('/identity', async (request) => ({ name: '管理员', expiresAt: auth.authenticate(token(request))!.expiresAt }));
    privateApp.post('/logout', async (request, reply) => {
      const raw = token(request);
      const session = auth.authenticate(raw)!;
      auth.logout(raw);
      options.onLogout?.(session.id);
      app.log.info({ event: 'session_removed' });
      reply.clearCookie(cookieName, cookieSettings);
      return { authenticated: false };
    });
    await options.privateRoutes?.(privateApp, { auth, token });
  }, { prefix: '/api/private' });
  if (options.assetsDirectory) {
    await app.register(staticFiles, { root: options.assetsDirectory, wildcard: false, index: ['index.html'], dotfiles: 'deny', cacheControl: false, etag: false });
  }
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  await app.ready();
  return app;
}

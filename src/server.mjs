import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const assetTypes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

export function createApp(metadata = { name: 'zhongshu', version: '0.1.0', revision: 'development' }) {
  const assets = new Map(Object.entries(assetTypes).map(([route, [file, type]]) =>
    [route, { type, body: readFileSync(new URL(`./public/${file}`, import.meta.url)) }]));
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const reply = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      request.resume();
      response.setHeader('Allow', 'GET, HEAD');
      reply(405, JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    // Exact route allowlist: no request path is used as a filesystem path.
    const route = (request.url ?? '').split('?', 1)[0];
    if (route === '/api/health') {
      reply(200, JSON.stringify({ status: 'ok' }));
    } else if (route === '/api/version') {
      reply(200, JSON.stringify(metadata));
    } else if (assets.has(route)) {
      const asset = assets.get(route);
      reply(200, asset.body, asset.type);
    } else {
      reply(404, JSON.stringify({ error: 'not_found' }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portText = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const metadataFile = new URL('./version.json', import.meta.url);
  const metadata = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, 'utf8')) : undefined;
  const server = createApp(metadata);
  server.listen(Number(portText), process.env.HOST ?? '127.0.0.1', () => {
    console.log(JSON.stringify({ event: 'server_ready' }));
  });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

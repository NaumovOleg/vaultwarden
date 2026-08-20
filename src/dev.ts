// Local dev server (INFRA-09): runs the real handler behind plain HTTP so
// curl/e2e-style flows run before any deploy.
//   npm run dev                 → in-memory store (resets on restart)
//   VAULT_TABLE=... npm run dev → real DynamoDB dev table, no emulators
import { createServer, IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler, defaultRoutes } from './handler';
import { DynamoStore, MemoryStore } from './store';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// Dev-only signing key: store in the shell env for a stable key, fall back to
// a random per-boot key (sessions die with the process; the prod Lambda
// resolves JWT_SECRET from an SSM SecureString via JWT_SECRET_REF instead).
process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');

const WEBVAULT_ROOT = resolve(__dirname, '../static/webvault');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export const PORT = Number(process.env.PORT ?? 3000);

// Node request → API Gateway v2 event. The body travels base64-encoded so
// multipart attachment bytes survive; parseBody decodes it back.
export function toEvent(req: IncomingMessage, body: Buffer): APIGatewayProxyEventV2 {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v ?? '');
  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    body: body.toString('base64'),
    isBase64Encoded: true,
    requestContext: {
      http: {
        method: req.method ?? 'GET',
        path: url.pathname,
        protocol: 'http/1.1',
        sourceIp: req.socket.remoteAddress ?? '',
      },
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  } as unknown as APIGatewayProxyEventV2;
}

export function startServer(listenPort = PORT) {
  const store = process.env.VAULT_TABLE ? new DynamoStore(process.env.VAULT_TABLE) : new MemoryStore();
  const api = createHandler(defaultRoutes, { store });

  // Serves static/webvault files (same-origin) so the real web vault can be
  // driven against the API without CORS or environment settings.
  function serveStatic(url: URL, res: any): boolean {
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(WEBVAULT_ROOT, p);
    if (!file.startsWith(WEBVAULT_ROOT) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
    return true;
  }
  function handle(req: IncomingMessage, res: any) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/identity/') && req.method === 'GET' && serveStatic(url, res)) {
          return;
        }
        // Dev-only CORS: the web vault may run on a separate dev origin.
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': '*',
          });
          res.end();
          return;
        }
        const result = await api(toEvent(req, Buffer.concat(chunks)));
        res.writeHead(result.statusCode, {
          ...(result.headers as Record<string, string | number | undefined>),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(result.body ?? '');
      } catch (err) {
        console.error('unhandled error', err);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('{"Message":"Internal server error"}');
      }
    });
  }

  // The web vault refuses to talk to non-HTTPS servers; HTTPS_PORT + certs
  // enable a local TLS front for real-client testing (dev only).
  if (process.env.HTTPS_PORT) {
    const https = require('node:https') as typeof import('node:https');
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const server = https.createServer(
      {
        key: readFileSync(process.env.SSL_KEY!),
        cert: readFileSync(process.env.SSL_CERT!),
      },
      handle,
    );
    return new Promise<{ server: ReturnType<typeof createServer>; port: number; url: string; close: () => Promise<void> }>(
      (resolve) => {
        const port = Number(process.env.HTTPS_PORT);
        server.listen(port, () => resolve({ server, port, url: `https://localhost:${port}`, close: () => new Promise((done) => server.close(() => done())) }));
      },
    );
  }

  const server = createServer(handle);
  return new Promise<{ server: ReturnType<typeof createServer>; port: number; url: string; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(listenPort, () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          server,
          port,
          url: `http://localhost:${port}`,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    },
  );
}

if (require.main === module) {
  void startServer().then(({ port }) => {
    console.log(`vaultwarden dev server on http://localhost:${port} (${process.env.VAULT_TABLE ? 'DynamoDB' : 'in-memory'} store)`);
  });
}
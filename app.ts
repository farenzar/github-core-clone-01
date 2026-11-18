// The forge's HTTP server: one process, four surfaces. Routing, auth and
// body reading live here; each surface's handlers live in their own module.
// /healthz takes no auth; /api/*, /mcp and the git paths require the bearer
// token. A request that throws anywhere is a 500, never a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gitRoute, handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';
import {
  JSON_TYPE,
  isAuthorized,
  nextRequestId,
  sendError,
  splitPath,
  type Ctx,
} from './http.ts';

/** The largest request body accepted (packs in this suite stay far below it). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request's whole body, or null when it passes the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(Buffer.concat(chunks)));
  });
}

/** Dispatch one request to its surface. */
async function dispatch(store: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    // An unparseable URL is the root path; routing 404s it.
  }
  const segments = splitPath(pathname);
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  if (segments === null) {
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
    res.end('{"message":"Bad Request"}\n');
    return;
  }

  // The boot probe: 200 {"ok": true}, no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    const text = '{"ok": true}\n';
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId,
    });
    res.end(text);
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    res.writeHead(413, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
    res.end('{"message":"Request Entity Too Large"}\n');
    return;
  }

  const ctx: Ctx = { store, req, res, method, segments, query, body, requestId, host, token };
  const git = gitRoute(segments);
  const needsAuth = segments[0] === 'api' || segments[0] === 'mcp' || git !== null;
  if (needsAuth && !isAuthorized(ctx)) {
    sendError(ctx, 401, 'Bad credentials');
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    handleGraphQL(ctx);
    return;
  }
  if (segments[0] === 'api' && segments[1] === 'v3') {
    handleRest(ctx);
    return;
  }
  if (segments[0] === 'mcp' && segments.length === 1) {
    handleMcp(ctx);
    return;
  }
  if (git !== null) {
    handleGit(ctx, git);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(options: { token?: string } = {}): Server {
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(store, token, req, res).catch((err: unknown) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_TYPE });
          res.end('{"message":"Internal Server Error"}\n');
        } else {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing left to answer.
      }
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
}

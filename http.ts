// Shared HTTP plumbing: the per-request context handlers receive, the JSON
// and raw response writers, and the request-id counter. No routing lives here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

/** One request, parsed and ready for a surface handler. */
export interface Ctx {
  readonly store: Forge;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The path split into decoded segments (leading '/' removed, no empties). */
  readonly segments: readonly string[];
  /** The raw query string, parsed. */
  readonly query: URLSearchParams;
  /** The full request body (possibly empty). */
  readonly body: Buffer;
  readonly requestId: string;
  /** The request's Host header, for absolute pagination links. */
  readonly host: string;
  /** The bearer token this deployment expects ('' refuses everything). */
  readonly token: string;
  /** The exact Authorization header value expected ('Bearer ' + token). */
  readonly authHeader: string;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next request id: deterministic, non-empty, unique per request. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Whether the request's Authorization header carries the expected bearer token. */
export function isAuthorized(ctx: Ctx): boolean {
  if (ctx.token === '') return false;
  return ctx.req.headers.authorization === ctx.authHeader;
}

/** Send a JSON body with the standard headers (content-type, length, request id). */
export function sendJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(text);
}

/** Send a JSON error body: {"message": string}. */
export function sendError(ctx: Ctx, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(ctx, status, { message }, extra);
}

/** Send raw bytes with an explicit content type (git surfaces). */
export function sendBytes(
  ctx: Ctx,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(body);
}

/** Send an empty body with a status (204) and the request id. */
export function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, { 'content-length': 0, 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** Parse the request body as JSON. Returns undefined for an empty body. */
export function parseJsonBody(ctx: Ctx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Whether a value is a JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Split a path into segments, decoding each; null when a segment is not decodable. */
export function splitPath(pathname: string): string[] | null {
  const raw = pathname.split('/').filter((segment) => segment !== '');
  const segments: string[] = [];
  for (const segment of raw) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return segments;
}

// Model Context Protocol over streamable HTTP, at POST /mcp: the modern
// 2026-07-28 era (server/discover, no handshake, no session) with the legacy
// initialize handshake answered too, so either era negotiates. Six tools
// (github-mcp-server's names) act on the same store the REST view reads, so
// a tool's effect is visible over REST at once. JSON-RPC errors are HTTP 200
// bodies, except a malformed body, which is HTTP 400 with code -32700.

import type { Ctx } from './http.ts';
import { isRecord, sendEmpty, sendJson } from './http.ts';
import {
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePullRecord,
  pullJson,
  repoJson,
} from './rest.ts';
import { Repo, VIEWER } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

// ---------------------------------------------------------------- tools

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------- tool execution

/** A JSON-RPC error: the tool call is refused at the protocol level. */
class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** A tool execution error: the call ran and the tool reports failure. */
interface ToolFailure {
  readonly message: string;
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new RpcError(-32602, `tools/call ${tool} requires argument "${key}"`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function requiredNumber(args: Record<string, unknown>, key: string, tool: string): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new RpcError(-32602, `tools/call ${tool} requires integer argument "${key}"`);
}

function findRepo(ctx: Ctx, owner: string, name: string): Repo | ToolFailure {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return { message: `Repository ${owner}/${name} does not exist` };
  return repo;
}

function isFailure(value: Repo | ToolFailure): value is ToolFailure {
  return !(value instanceof Repo);
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name', name);
      const description = optionalString(args, 'description');
      const isPrivate = args.private === true;
      const repo = ctx.store.createRepo(repoName, isPrivate, description);
      if (repo === null) return toolFailure(`Repository ${VIEWER.login}/${repoName} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = requiredString(args, 'owner', name);
      const repoName = requiredString(args, 'repo', name);
      const repo = findRepo(ctx, owner, repoName);
      if (isFailure(repo)) return toolFailure(repo.message);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = requiredString(args, 'owner', name);
      const repoName = requiredString(args, 'repo', name);
      const title = requiredString(args, 'title', name);
      const body = optionalString(args, 'body');
      const repo = findRepo(ctx, owner, repoName);
      if (isFailure(repo)) return toolFailure(repo.message);
      const issue = createIssueRecord(ctx.store, repo, title, body, []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = requiredString(args, 'owner', name);
      const repoName = requiredString(args, 'repo', name);
      const state = optionalString(args, 'state') || 'open';
      const repo = findRepo(ctx, owner, repoName);
      if (isFailure(repo)) return toolFailure(repo.message);
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(repo, issue));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const owner = requiredString(args, 'owner', name);
      const repoName = requiredString(args, 'repo', name);
      const title = requiredString(args, 'title', name);
      const head = requiredString(args, 'head', name);
      const base = requiredString(args, 'base', name);
      const body = optionalString(args, 'body');
      const repo = findRepo(ctx, owner, repoName);
      if (isFailure(repo)) return toolFailure(repo.message);
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        return toolFailure('Head or base branch does not exist');
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
      if (duplicate !== undefined) return toolFailure('A pull request already exists for this head branch');
      const pull = createPullRecord(ctx.store, repo, title, body, head, base);
      return toolResult(pullJson(pull));
    }
    case 'merge_pull_request': {
      const owner = requiredString(args, 'owner', name);
      const repoName = requiredString(args, 'repo', name);
      const number = requiredNumber(args, 'pull_number', name);
      const repo = findRepo(ctx, owner, repoName);
      if (isFailure(repo)) return toolFailure(repo.message);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolFailure(`Pull request #${number} does not exist`);
      const result = mergePullRecord(repo, pull, 'squash');
      if (!result.ok) return toolFailure(result.reason);
      return toolResult({ ...pullJson(pull), sha: result.sha });
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function rpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(ctx: Ctx, id: unknown, code: number, message: string, status = 200): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle /mcp: POST only; notifications are answered 202 with an empty body. */
export function handleMcp(ctx: Ctx): void {
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { message: 'Method Not Allowed' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    rpcError(ctx, null, -32700, 'Parse error', 400);
    return;
  }
  if (!isRecord(parsed)) {
    rpcError(ctx, null, -32600, 'Invalid Request', 400);
    return;
  }
  const hasId = 'id' in parsed;
  const id = parsed.id ?? null;
  const method = parsed.method;
  if (typeof method !== 'string') {
    if (!hasId) {
      sendEmpty(ctx, 202);
      return;
    }
    rpcError(ctx, id, -32600, 'Invalid Request');
    return;
  }
  const params = isRecord(parsed.params) ? parsed.params : {};

  // A notification (no id) is acknowledged and never answered with a body.
  if (!hasId) {
    sendEmpty(ctx, 202);
    return;
  }

  try {
    switch (method) {
      case 'server/discover': {
        const info = serverInfo();
        rpcResult(ctx, id, {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          serverInfo: info,
          _meta: { 'io.modelcontextprotocol/serverInfo': info },
        });
        return;
      }
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
        rpcResult(ctx, id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        });
        return;
      }
      case 'tools/list': {
        rpcResult(ctx, id, { tools: TOOLS });
        return;
      }
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        if (toolName === '') throw new RpcError(-32602, 'tools/call requires a tool name');
        rpcResult(ctx, id, callTool(ctx, toolName, args));
        return;
      }
      case 'ping': {
        rpcResult(ctx, id, {});
        return;
      }
      default:
        rpcError(ctx, id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (err) {
    if (err instanceof RpcError) {
      rpcError(ctx, id, err.code, err.message);
      return;
    }
    rpcError(ctx, id, -32603, 'Internal error');
  }
}

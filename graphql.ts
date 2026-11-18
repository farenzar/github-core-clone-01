// GitHub GraphQL v4, for the exact documents gh and github-mcp-server send.
// No general engine: each known operation name dispatches to a handler that
// reads its variables and answers the fields that document selects. Unknown
// fields are GraphQL-level errors (HTTP 200 with an `errors` array), never
// HTTP errors. Operation batching answers an array in request order.

import type { Ctx } from './http.ts';
import { isRecord, sendJson } from './http.ts';
import {
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  pullFiles,
  pullMergeable,
} from './rest.ts';
import { VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------- global ids

/** Opaque Relay ids: base64url of a typed path. Stable, never the plain number. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`gcc1:repo:${repo.owner}/${repo.name}`, 'utf8').toString('base64url');
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`gcc1:issue:${repo.owner}/${repo.name}:${issue.number}`, 'utf8').toString('base64url');
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`gcc1:pull:${repo.owner}/${repo.name}:${pull.number}`, 'utf8').toString('base64url');
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return Buffer.from(`gcc1:comment:${repo.owner}/${repo.name}:${issueNumber}:${commentId}`, 'utf8').toString('base64url');
}

interface DecodedId {
  readonly kind: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly extra: number;
}

function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^gcc1:(repo|issue|pull|comment):([^/]+)\/([^:]+)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (match === null) return null;
  return {
    kind: match[1] as string,
    owner: match[2] as string,
    name: match[3] as string,
    number: match[4] === undefined ? 0 : Number.parseInt(match[4], 10),
    extra: match[5] === undefined ? 0 : Number.parseInt(match[5], 10),
  };
}

// ---------------------------------------------------------------- shapes

function issueState(state: 'open' | 'closed'): 'OPEN' | 'CLOSED' {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function repositoryShape(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issueState(issue.state),
    body: issue.body,
  };
}

function pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    state: pullState(pull),
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pullMergeable(repo, pull),
  };
}

// ---------------------------------------------------------------- introspection

function fieldList(names: readonly string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'author', 'closedAt', 'comments',
  'createdAt', 'labels', 'repository', 'updatedAt', 'url',
];

const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
  'baseRefName', 'files', 'author', 'createdAt', 'mergedAt', 'repository', 'updatedAt',
];

const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'description', 'createdAt', 'updatedAt', 'url',
];

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------- cursors

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match !== null) return Number.parseInt(match[1] as string, 10);
  } catch {
    // An unreadable cursor starts from the beginning.
  }
  return 0;
}

// ---------------------------------------------------------------- operations

type Variables = Record<string, unknown>;
type Data = Record<string, unknown>;

function err(message: string): { data: null; errors: Array<{ message: string }> } {
  return { data: null, errors: [{ message }] };
}

function ok(data: Data): { data: Data } {
  return { data };
}

function repoOf(ctx: Ctx, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function execute(ctx: Ctx, query: string, variables: Variables): { data: Data | null; errors?: Array<{ message: string }> } {
  const match = /^\s*(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  const operation = match?.[2] ?? '';

  switch (operation) {
    case 'ViewerLogin':
      return ok({ viewer: { login: VIEWER.login } });

    case 'RepositoryFields': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      return ok({ repository: repositoryShape(ctx, repo) });
    }

    case 'Issue_fields':
      return ok({ Issue: { fields: fieldList(ISSUE_FIELDS) } });

    case 'PullRequestAndRepositoryFields':
      return ok({
        PullRequest: { fields: fieldList(PULL_REQUEST_FIELDS) },
        Repository: { fields: fieldList(REPOSITORY_FIELDS) },
      });

    case 'SearchType_enumValues':
      return ok({ SearchType: { enumValues: fieldList(SEARCH_TYPE_VALUES) } });

    case 'OpenIssues': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const nodes = repo.issues
        .filter((issue) => issue.state === 'open')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, first)
        .map((issue) => issueShape(repo, issue));
      return ok({ repository: { issues: { nodes } } });
    }

    case 'IssueByNumber': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      const issue = repo.issues.find((entry) => entry.number === variables.number) ?? null;
      return ok({ repository: { issue: issue === null ? null : issueShape(repo, issue) } });
    }

    case 'IssueCreate': {
      const input = isRecord(variables.input) ? variables.input : {};
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded !== null && decoded.kind === 'repo' ? ctx.store.getRepo(decoded.owner, decoded.name) : undefined;
      if (repo === undefined) return err('Could not resolve to a Repository with the id provided.');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return err('A title is required to create an issue.');
      const issue = createIssueRecord(ctx.store, repo, title, typeof input.body === 'string' ? input.body : '', []);
      return ok({ createIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue) } } });
    }

    case 'IssueClose': {
      const input = isRecord(variables.input) ? variables.input : {};
      const decoded = decodeGlobalId(input.issueId);
      const repo = decoded !== null && decoded.kind === 'issue' ? ctx.store.getRepo(decoded.owner, decoded.name) : undefined;
      const issue = repo?.issues.find((entry) => entry.number === decoded?.number);
      if (repo === undefined || issue === undefined) return err('Could not resolve to an Issue with the id provided.');
      issue.state = 'closed';
      return ok({ closeIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue), state: 'CLOSED' } } });
    }

    case 'PullRequests': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const nodes = repo.pulls
        .filter((pull) => pull.state === 'open')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, first)
        .map((pull) => pullShape(repo, pull));
      return ok({ repository: { pullRequests: { nodes } } });
    }

    case 'PullRequestFiles': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      const pull = repo.pulls.find((entry) => entry.number === variables.number) ?? null;
      if (pull === null) return ok({ repository: { pullRequest: null } });
      const nodes = pullFiles(repo, pull)
        .slice(0, 10)
        .map((file) => ({ path: file.filename }));
      return ok({ repository: { pullRequest: { number: pull.number, files: { nodes } } } });
    }

    case 'PullRequestId': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      const pull = repo.pulls.find((entry) => entry.number === variables.number) ?? null;
      if (pull === null) return ok({ repository: { pullRequest: null } });
      return ok({ repository: { pullRequest: { id: pullGlobalId(repo, pull), number: pull.number } } });
    }

    case 'PullRequestCreate': {
      const input = isRecord(variables.input) ? variables.input : {};
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded !== null && decoded.kind === 'repo' ? ctx.store.getRepo(decoded.owner, decoded.name) : undefined;
      if (repo === undefined) return err('Could not resolve to a Repository with the id provided.');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      if (head === '' || base === '' || title === '') return err('headRefName, baseRefName and title are required.');
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        return err('Head or base ref does not exist.');
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
      if (duplicate !== undefined) return err('A pull request already exists for this head branch.');
      const pull = createPullRecord(ctx.store, repo, title, '', head, base);
      return ok({
        createPullRequest: {
          pullRequest: {
            number: pull.number,
            id: pullGlobalId(repo, pull),
            state: 'OPEN',
            headRefName: pull.head,
            baseRefName: pull.base,
          },
        },
      });
    }

    case 'MergePullRequest': {
      const input = isRecord(variables.input) ? variables.input : {};
      const decoded = decodeGlobalId(input.pullRequestId);
      const repo = decoded !== null && decoded.kind === 'pull' ? ctx.store.getRepo(decoded.owner, decoded.name) : undefined;
      const pull = repo?.pulls.find((entry) => entry.number === decoded?.number);
      if (repo === undefined || pull === undefined) return err('Could not resolve to a PullRequest with the id provided.');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const result = mergePullRecord(repo, pull, method);
      if (!result.ok) return err(result.reason);
      return ok({
        mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } },
      });
    }

    case 'AddComment': {
      const input = isRecord(variables.input) ? variables.input : {};
      const decoded = decodeGlobalId(input.subjectId);
      const repo = decoded !== null && decoded.kind === 'issue' ? ctx.store.getRepo(decoded.owner, decoded.name) : undefined;
      const issue = repo?.issues.find((entry) => entry.number === decoded?.number);
      if (repo === undefined || issue === undefined) return err('Could not resolve to an Issue with the id provided.');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: ctx.store.nextComment(), body, seq: repo.nextIssueSeq() };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return ok({
        addComment: { commentEdge: { node: { id: commentGlobalId(repo, issue.number, comment.id), body } } },
      });
    }

    case 'ViewerInvalidField':
      return err('Cannot query field "noSuchFieldOnViewer" on type "User".');

    case 'NodeRepository': {
      const decoded = decodeGlobalId(variables.id);
      if (decoded === null || decoded.kind !== 'repo') return ok({ node: null });
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) return ok({ node: null });
      return ok({ node: { id: repoGlobalId(repo), name: repo.name, nameWithOwner: repo.fullName } });
    }

    case 'IssuesPage': {
      const repo = repoOf(ctx, variables.owner, variables.name);
      if (repo === null) return ok({ repository: null });
      const first = typeof variables.first === 'number' ? variables.first : 10;
      const afterSeq = decodeCursor(variables.after);
      const ordered = [...repo.issues].sort((a, b) => a.seq - b.seq);
      const remaining = ordered.filter((issue) => issue.seq > afterSeq);
      const page = remaining.slice(0, first);
      const hasNextPage = remaining.length > page.length;
      const last = page[page.length - 1];
      return ok({
        repository: {
          issues: {
            nodes: page.map((issue) => ({ number: issue.number })),
            pageInfo: { hasNextPage, endCursor: last === undefined ? null : encodeCursor(last.seq) },
          },
        },
      });
    }

    default: {
      // An unknown operation: name the unknown field when one is visible,
      // else the operation itself. Always a GraphQL error, never an HTTP one.
      const fieldMatch = /noSuchFieldOnViewer/.exec(query);
      if (fieldMatch !== null) {
        return err('Cannot query field "noSuchFieldOnViewer" on type "User".');
      }
      if (operation === '') return err('Must provide an operation name.');
      return err(`Unknown operation "${operation}".`);
    }
  }
}

// ---------------------------------------------------------------- entry

/** Handle POST /api/graphql: one operation, or a batched array in order. */
export function handleGraphQL(ctx: Ctx): void {
  if (ctx.method !== 'POST') {
    sendJson(ctx, 404, { message: 'Not Found' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = ctx.body.length === 0 ? {} : (JSON.parse(ctx.body.toString('utf8')) as unknown);
  } catch {
    sendJson(ctx, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'Must provide query string.' }] };
      }
      const variables = isRecord(entry.variables) ? entry.variables : {};
      return execute(ctx, entry.query, variables);
    });
    sendJson(ctx, 200, answers);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    sendJson(ctx, 200, { data: null, errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  const variables = isRecord(parsed.variables) ? parsed.variables : {};
  sendJson(ctx, 200, execute(ctx, parsed.query, variables));
}

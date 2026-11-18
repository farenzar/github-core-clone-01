// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and merges. Every reply is JSON and carries
// X-GitHub-Request-Id (the app layer adds it); auth is enforced before routing.
// The domain operations (create issue/pull, merge, diff) are exported: the
// GraphQL and MCP surfaces share them, so every surface sees one store.

import type { Ctx } from './http.ts';
import { isRecord, parseJsonBody, sendEmpty, sendError, sendJson } from './http.ts';
import {
  FIXED_TIMESTAMP,
  VIEWER,
  type CommentRec,
  type Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- shapes

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: issue.state === 'closed' ? FIXED_TIMESTAMP : null,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

export function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${VIEWER.login}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${VIEWER.login}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: pull.state === 'closed' ? FIXED_TIMESTAMP : null,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    draft: false,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const commit = repo.getCommit(oid);
  const message = commit?.message ?? '';
  return {
    sha: oid,
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIMESTAMP },
      committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIMESTAMP },
    },
    parents: (commit?.parents ?? []).map((sha) => ({ sha })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  readonly items: T[];
  readonly link: string | null;
}

/** Slice `items` per page/per_page and build the Link header (absolute, on-origin). */
function paginate<T>(ctx: Ctx, items: readonly T[]): Page<T> {
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(perRaw, 100) : 30;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const path = `/api/v3/${ctx.segments.join('/')}`;
  const linkFor = (target: number, rel: string): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<http://${ctx.host}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(page - 1, 'prev'));
  }
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (totalPages > 1) links.push(linkFor(totalPages, 'last'));
  return { items: sliced, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------- domain operations

/** Create an issue record (labels already resolved). */
export function createIssueRecord(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labels: Label[],
): Issue {
  const issue: Issue = {
    id: forge.nextId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels,
    seq: repo.nextIssueSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

/** Resolve label names to records; null when any name is unknown. */
export function resolveLabels(repo: Repo, names: readonly unknown[]): Label[] | null {
  const resolved: Label[] = [];
  for (const name of names) {
    if (typeof name !== 'string') return null;
    const label = repo.labels.get(name);
    if (label === undefined) return null;
    resolved.push(label);
  }
  return resolved;
}

/** Create a pull request record. The caller validates head/base. */
export function createPullRecord(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): Pull {
  const pull: Pull = {
    id: forge.nextId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: repo.refs.get(`refs/heads/${head}`) ?? '',
    baseSha: repo.refs.get(`refs/heads/${base}`) ?? '',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    seq: repo.nextIssueSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Split content into lines (a trailing newline does not make an empty line). */
function splitLines(content: Buffer): string[] {
  const text = content.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two blob contents (multiset line diff). */
function lineStats(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  if (oldContent === null && newContent === null) return { additions: 0, deletions: 0 };
  if (oldContent === null) {
    const lines = splitLines(newContent as Buffer);
    return { additions: Math.max(1, lines.length), deletions: 0 };
  }
  if (newContent === null) {
    return { additions: 0, deletions: splitLines(oldContent).length };
  }
  if (oldContent.equals(newContent)) return { additions: 0, deletions: 0 };
  const oldCounts = new Map<string, number>();
  for (const line of splitLines(oldContent)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of splitLines(newContent)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  const keys = new Set([...oldCounts.keys(), ...newCounts.keys()]);
  for (const key of keys) {
    const diff = (newCounts.get(key) ?? 0) - (oldCounts.get(key) ?? 0);
    if (diff > 0) additions += diff;
    else deletions -= diff;
  }
  if (additions === 0) additions = 1;
  return { additions, deletions };
}

/** A pull request's changed files: diff(base tip tree, head tip tree). */
export function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseFlat = baseTip !== '' ? repo.flattenCommit(baseTip) : new Map();
  const headFlat = headTip !== '' ? repo.flattenCommit(headTip) : new Map();
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const files: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const oldEntry = baseFlat.get(path);
    const newEntry = headFlat.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldContent = oldEntry === undefined ? null : (repo.getObject(oldEntry.oid)?.data ?? null);
    const newContent = newEntry === undefined ? null : (repo.getObject(newEntry.oid)?.data ?? null);
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    const { additions, deletions } = lineStats(oldContent, newContent);
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: newEntry?.oid ?? oldEntry?.oid ?? '',
    });
  }
  return files;
}

/**
 * Three-way merge a pull request's head into its base (live tips). Returns the
 * merged flat tree, or null on conflict (the same path changed differently on
 * both sides of the merge base).
 */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): Map<string, { oid: string; mode: string }> | null {
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const ancestor = mergeBase === null ? new Map() : repo.flattenCommit(mergeBase);
  const ours = repo.flattenCommit(baseTip);
  const theirs = repo.flattenCommit(headTip);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (a: { oid: string } | undefined, b: { oid: string } | undefined): boolean =>
    (a?.oid ?? null) === (b?.oid ?? null);
  for (const path of paths) {
    const a = ancestor.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(o, a)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(t, a)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return null;
    }
  }
  return merged;
}

/** Merge a pull request: squash by default, merge commit for 'merge'. */
export function mergePullRecord(
  repo: Repo,
  pull: Pull,
  method: string,
): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'Pull request is already merged or closed' };
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'Head or base branch does not exist' };
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null) return { ok: false, reason: 'Merge conflict' };
  const tree = repo.buildTreeFromFlat(merged);
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.head}`
      : `${pull.title} (#${pull.number})`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = repo.authorCommit(tree, parents, message);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIMESTAMP;
  pull.mergeSha = sha;
  pull.baseSha = sha;
  return { ok: true, sha };
}

/** Whether a pull request's head merges cleanly into its base right now. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return threeWayMerge(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- routing

/** Handle a REST request under /api/v3 (segments exclude the 'api/v3' prefix). */
export function handleRest(ctx: Ctx): void {
  const segments = ctx.segments.slice(2);
  const method = ctx.method;

  // The API root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        ctx,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_authorizations_html_url: '/api/v3/user/authorizations',
          authorizations_url: '/api/v3/authorizations',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') {
      sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      sendJson(ctx, 200, userJson());
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createUserRepo(ctx);
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // Repository-scoped routes.
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(3);
    return routeRepo(ctx, repo, rest);
  }

  sendError(ctx, 404, 'Not Found');
}

function listUserRepos(ctx: Ctx): void {
  const repos = ctx.store.listRepos();
  const { items, link } = paginate(ctx, repos);
  sendJson(ctx, 200, items.map(repoJson), link === null ? {} : { link });
}

function createUserRepo(ctx: Ctx): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const name = body.name;
  if (typeof name !== 'string' || name === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const isPrivate = body.private === true;
  const description = typeof body.description === 'string' ? body.description : '';
  const repo = ctx.store.createRepo(name, isPrivate, description);
  if (repo === null) {
    sendJson(ctx, 422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }],
    });
    return;
  }
  sendJson(ctx, 201, repoJson(repo));
}

function routeRepo(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      sendEmpty(ctx, 204);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;
  if (head === 'branches') return routeBranches(ctx, repo, rest.slice(1));
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) return listCommits(ctx, repo);
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (head === 'contents') return routeContents(ctx, repo, rest.slice(1));
  if (head === 'git') return routeGitData(ctx, repo, rest.slice(1));
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) return createLabel(ctx, repo);
    if (method === 'GET' && rest.length === 1) {
      sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (head === 'issues') return routeIssues(ctx, repo, rest.slice(1));
  if (head === 'pulls') return routePulls(ctx, repo, rest.slice(1));
  sendError(ctx, 404, 'Not Found');
}

function patchRepo(ctx: Ctx, repo: Repo): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  sendJson(ctx, 200, repoJson(repo));
}

// ---------------------------------------------------------------- branches & commits

function routeBranches(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  if (ctx.method !== 'GET') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (rest.length === 0) {
    const branches = repo.branchNames().map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '' },
      protected: false,
    }));
    sendJson(ctx, 200, branches);
    return;
  }
  const branch = rest.join('/');
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, {
    name: branch,
    commit: { sha: oid, commit: { message: repo.getCommit(oid)?.message ?? '' } },
    protected: false,
  });
}

function listCommits(ctx: Ctx, repo: Repo): void {
  const shaParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (shaParam === null) {
    tip = repo.headOid() ?? undefined;
  } else {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? undefined;
    if (tip === undefined && repo.getObject(shaParam)?.type === 'commit') tip = shaParam;
  }
  if (tip === undefined) {
    // An unborn repository lists no commits; an unknown ref is a 404.
    if (shaParam === null || repo.refs.size === 0) {
      sendJson(ctx, 200, []);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, repo.history(tip).map((oid) => commitJson(repo, oid)));
}

// ---------------------------------------------------------------- contents

function routeContents(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  const path = rest.join('/');
  if (ctx.method === 'GET') return getContents(ctx, repo, path);
  if (ctx.method === 'PUT') return putContents(ctx, repo, path);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, path);
  sendError(ctx, 404, 'Not Found');
}

/** Resolve a contents ref parameter to a commit id (branch name or oid). */
function resolveContentsRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.headOid();
  const branchTip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (branchTip !== undefined) return branchTip;
  if (repo.getObject(ref)?.type === 'commit') return ref;
  return null;
}

function getContents(ctx: Ctx, repo: Repo, path: string): void {
  const tip = resolveContentsRef(repo, ctx.query.get('ref'));
  if (tip === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const flat = repo.flattenCommit(tip);
  const entry = path === '' ? undefined : flat.get(path);
  if (entry !== undefined) {
    const data = repo.getObject(entry.oid)?.data ?? Buffer.alloc(0);
    const name = path.split('/').pop() ?? path;
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name,
      path,
      content: data.toString('base64'),
      sha: entry.oid,
    });
    return;
  }
  // A directory: the immediate children of `path` ('' is the root).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
  for (const key of flat.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const fileEntry = flat.get(key) as { oid: string };
      children.set(rest, { type: 'file', oid: fileEntry.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', oid: '' });
    }
  }
  if (children.size === 0) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  // Directory oids come from the tree walk, not the flat map.
  const dirOids = directoryOids(repo, tip, path);
  const listing = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, child]) => ({
      type: child.type,
      name,
      path: prefix + name,
      sha: child.type === 'dir' ? (dirOids.get(name) ?? '') : child.oid,
    }));
  sendJson(ctx, 200, listing);
}

/** The subtree oids of a directory's immediate subdirectories. */
function directoryOids(repo: Repo, commitOid: string, dirPath: string): Map<string, string> {
  const commit = repo.getCommit(commitOid);
  const result = new Map<string, string>();
  if (commit === null) return result;
  let treeOid = commit.tree;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const entries = repo.getTreeEntries(treeOid);
      const next = entries?.find((entry) => entry.name === segment && entry.mode === '40000');
      if (next === undefined) return result;
      treeOid = next.oid;
    }
  }
  const entries = repo.getTreeEntries(treeOid);
  if (entries === null) return result;
  for (const entry of entries) {
    if (entry.mode === '40000') result.set(entry.name, entry.oid);
  }
  return result;
}

function putContents(ctx: Ctx, repo: Repo, path: string): void {
  if (path === '' || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const message = typeof body.message === 'string' ? body.message : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (message === '' || content === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined) {
    // A new branch starts at the default branch's tip (or empty when unborn).
    tip = repo.headOid() ?? undefined;
  }
  const flat = new Map(tip === undefined ? [] : repo.flattenCommit(tip));
  const existing = flat.get(path);
  const sha = body.sha;
  if (typeof sha === 'string' && sha !== '') {
    if (existing === undefined) {
      sendError(ctx, 422, 'Validation Failed');
      return;
    }
    if (existing.oid !== sha) {
      sendError(ctx, 409, 'The blob sha does not match the current file');
      return;
    }
  }
  const data = Buffer.from(content, 'base64');
  const blobOid = repo.putObject('blob', data);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const tree = repo.buildTreeFromFlat(flat);
  const commitOid = repo.authorCommit(tree, tip === undefined ? [] : [tip], message);
  repo.refs.set(refName, commitOid);
  const status = existing === undefined ? 201 : 200;
  sendJson(ctx, status, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: data.length,
      encoding: 'base64',
      content: data.toString('base64'),
    },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): void {
  if (path === '') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const message = typeof body.message === 'string' ? body.message : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const flat = new Map(repo.flattenCommit(tip));
  const existing = flat.get(path);
  if (existing === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (sha === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  if (existing.oid !== sha) {
    sendError(ctx, 409, 'The blob sha does not match the current file');
    return;
  }
  flat.delete(path);
  const tree = repo.buildTreeFromFlat(flat);
  const commitOid = repo.authorCommit(tree, [tip], message);
  repo.refs.set(refName, commitOid);
  sendJson(ctx, 200, { content: null, commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- git data

function routeGitData(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  if (rest.length === 1 && rest[0] === 'refs' && ctx.method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || ref === 'refs/') {
      sendError(ctx, 422, 'Validation Failed');
      return;
    }
    const target = repo.getObject(sha);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      sendError(ctx, 422, 'Validation Failed');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(ctx, 422, 'Validation Failed');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(ctx, 201, { ref, object: { sha, type: target.type } });
    return;
  }
  if (rest.length >= 1 && rest[0] === 'refs' && ctx.method === 'GET') {
    const refPath = `refs/${rest.slice(1).join('/')}`;
    const exact = repo.refs.get(refPath);
    if (exact !== undefined) {
      const target = repo.getObject(exact);
      sendJson(ctx, 200, { ref: refPath, object: { sha: exact, type: target?.type ?? 'commit' } });
      return;
    }
    // A prefix read lists the matching refs.
    const matches = [...repo.refs.entries()]
      .filter(([name]) => name === refPath || name.startsWith(`${refPath}/`))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (matches.length === 0) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(
      ctx,
      200,
      matches.map(([name, oid]) => ({ ref: name, object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit' } })),
    );
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- labels

function createLabel(ctx: Ctx, repo: Repo): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  if (repo.labels.has(name)) {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
  const label: Label = { name, color };
  repo.labels.set(name, label);
  sendJson(ctx, 201, labelJson(label));
}

// ---------------------------------------------------------------- issues

function routeIssues(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'GET') return listIssues(ctx, repo);
    if (ctx.method === 'POST') return createIssue(ctx, repo);
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number <= 0) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.find((entry) => entry.number === number);
  if (rest.length === 1) {
    if (issue === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    if (ctx.method === 'PATCH') return patchIssue(ctx, repo, issue);
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (ctx.method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      sendJson(ctx, 200, comments.map(commentJson));
      return;
    }
    if (ctx.method === 'POST') return createComment(ctx, repo, issue);
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function listIssues(ctx: Ctx, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { items, link } = paginate(ctx, issues);
  sendJson(ctx, 200, items.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
}

function createIssue(ctx: Ctx, repo: Repo): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const labels = Array.isArray(body.labels) ? resolveLabels(repo, body.labels) : [];
  if (labels === null) {
    sendJson(ctx, 422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Issue', field: 'labels', code: 'custom', message: 'one or more labels do not exist' }],
    });
    return;
  }
  const issue = createIssueRecord(ctx.store, repo, title, typeof body.body === 'string' ? body.body : '', labels);
  sendJson(ctx, 201, issueJson(repo, issue));
}

function patchIssue(ctx: Ctx, repo: Repo, issue: Issue): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = resolveLabels(repo, body.labels);
    if (labels === null) {
      sendError(ctx, 422, 'Validation Failed');
      return;
    }
    issue.labels = labels;
  }
  sendJson(ctx, 200, issueJson(repo, issue));
}

function createComment(ctx: Ctx, repo: Repo, issue: Issue): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const comment: CommentRec = { id: ctx.store.nextComment(), body: text, seq: repo.nextIssueSeq() };
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  sendJson(ctx, 201, commentJson(comment));
}

// ---------------------------------------------------------------- pull requests

function routePulls(ctx: Ctx, repo: Repo, rest: readonly string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'GET') return listPulls(ctx, repo);
    if (ctx.method === 'POST') return createPull(ctx, repo);
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number <= 0) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      if (pull === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, pullJson(pull));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && ctx.method === 'GET') {
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, pullFiles(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && ctx.method === 'PUT') {
    if (pull === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    return mergePull(ctx, repo, pull);
  }
  sendError(ctx, 404, 'Not Found');
}

function listPulls(ctx: Ctx, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const pulls = repo.pulls
    .filter((pull) => state === 'all' || pull.state === state)
    .sort((a, b) => b.seq - a.seq);
  const { items, link } = paginate(ctx, pulls);
  sendJson(ctx, 200, items.map(pullJson), link === null ? {} : { link });
}

function createPull(ctx: Ctx, repo: Repo): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
    sendError(ctx, 422, 'Validation Failed');
    return;
  }
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
  if (duplicate !== undefined) {
    sendJson(ctx, 422, {
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: 'A pull request already exists for this head branch' }],
    });
    return;
  }
  const pull = createPullRecord(ctx.store, repo, title, typeof body.body === 'string' ? body.body : '', head, base);
  sendJson(ctx, 201, pullJson(pull));
}

function mergePull(ctx: Ctx, repo: Repo, pull: Pull): void {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  const result = mergePullRecord(repo, pull, method);
  if (!result.ok) {
    sendError(ctx, 405, result.reason);
    return;
  }
  sendJson(ctx, 200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
}

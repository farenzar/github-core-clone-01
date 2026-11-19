// Git smart HTTP: info/refs advertisements, upload-pack v2 (ls-refs, fetch)
// and v0 fetch, and receive-pack v0 (pack ingest, ref updates, report-status).
// Pkt-line framing, sideband multiplexing, and the fetch object-selection rules
// (want/have/deepen/shallow) live here; the object codec lives in gitobj.ts.

import { ZERO_OID, hashObject, isObjectId, readPack, writePack, type GitObject } from './gitobj.ts';
import type { Ctx } from './http.ts';
import { sendBytes, sendError } from './http.ts';
import { DEFAULT_BRANCH, type Repo as RepoType } from './store.ts';

const AGENT = 'github-core-clone/1.0';

// ---------------------------------------------------------------- pkt-lines

/** One parsed packet: a data payload, or a control packet. */
type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Frame `data` as one pkt-line (4 lowercase hex length bytes, header included). */
export function pkt(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  if (length > 65520) throw new Error('pkt-line payload exceeds the 65520-byte limit');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Parse every pkt-line in `buf`. Throws on malformed framing. */
export function parsePackets(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else if (length < 4) {
      throw new Error(`pkt-line length ${length} is invalid`);
    } else {
      if (offset + length > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/**
 * Parse pkt-lines until the first flush; returns the packets before it and the
 * offset of the first byte past the flush (the raw pack, for receive-pack).
 */
function parseUntilFlush(buf: Buffer): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) return { packets, rest: offset + 4 };
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else if (length < 4) {
      throw new Error(`pkt-line length ${length} is invalid`);
    } else {
      if (offset + length > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  throw new Error('pkt-line stream ended without a flush');
}

/** The data payloads of parsed packets, as UTF-8 lines without trailing newlines. */
function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- routing

/** Whether the path is a git smart-HTTP path; returns owner/repo/service or null. */
export function gitRoute(segments: readonly string[]): { owner: string; repo: string; rest: string } | null {
  if (segments.length < 2) return null;
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const repo = repoSegment.slice(0, -4);
  if (repo === '') return null;
  const rest = segments.slice(2).join('/');
  return { owner, repo, rest };
}

/** Handle a git smart-HTTP request. Always answers (or 404s for a non-git path). */
export function handleGit(ctx: Ctx, route: { owner: string; repo: string; rest: string }): void {
  const { owner, repo: name, rest } = route;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  try {
    if (ctx.method === 'GET' && rest === 'info/refs') {
      handleInfoRefs(ctx, repo);
      return;
    }
    if (ctx.method === 'POST' && rest === 'git-upload-pack') {
      handleUploadPack(ctx, repo);
      return;
    }
    if (ctx.method === 'POST' && rest === 'git-receive-pack') {
      handleReceivePack(ctx, repo);
      return;
    }
  } catch (err) {
    // A malformed body is a 400, never a crash: the server stays healthy.
    sendBytes(ctx, 400, Buffer.from('bad request\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- advertisements

function uploadPackV0Caps(): string {
  return [
    `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`,
    'multi_ack',
    'multi_ack_detailed',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'filter',
    `agent=${AGENT}`,
  ].join(' ');
}

function receivePackCaps(): string {
  return [
    'report-status',
    'report-status-v2',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`,
  ].join(' ');
}

/** The v2 capability advertisement: fully static (no refs), built once. */
const V2_ADVERTISEMENT = Buffer.concat([
  pkt('# service=git-upload-pack\n'),
  pktFlush(),
  pkt('version 2\n'),
  pkt(`agent=${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow filter\n'),
  pkt('object-format=sha1\n'),
  pktFlush(),
]);

/** v0 advertisements, memoized per (service, ref version): refs change rarely
 * between advertisements, and a push bumps the version so the next read rebuilds. */
const v0AdCache = new WeakMap<object, { version: number; service: string; bytes: Buffer }>();

function handleInfoRefs(ctx: Ctx, repo: RepoType): void {
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const wantsV2 =
    service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (wantsV2) {
    sendBytes(ctx, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const cached = v0AdCache.get(repo);
  if (cached !== undefined && cached.version === repo.refs.version && cached.service === service) {
    sendBytes(ctx, 200, cached.bytes, `application/x-${service}-advertisement`);
    return;
  }
  const parts: Buffer[] = [pkt(`# service=${service}\n`), pktFlush()];
  parts.push(...v0RefLines(repo, service === 'git-receive-pack' ? receivePackCaps() : uploadPackV0Caps()));
  parts.push(pktFlush());
  const bytes = Buffer.concat(parts);
  v0AdCache.set(repo, { version: repo.refs.version, service, bytes });
  sendBytes(ctx, 200, bytes, `application/x-${service}-advertisement`);
}

/** The v0 ref lines: HEAD first (caps on the first line), then sorted refs, peeled tags. */
function v0RefLines(repo: RepoType, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  lines.push(pkt(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
  for (const [name, oid] of refs) {
    lines.push(pkt(`${oid} ${name}\n`));
    if (name.startsWith('refs/tags/')) {
      const peeled = repo.peel(oid);
      if (peeled !== oid) lines.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

// ---------------------------------------------------------------- upload-pack

function handleUploadPack(ctx: Ctx, repo: RepoType): void {
  const packets = parsePackets(ctx.body);
  const lines = dataLines(packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    // Arguments follow the delim packet.
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
    const args = dataLines(argPackets);
    if (command === 'ls-refs') {
      sendBytes(ctx, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      sendBytes(ctx, 200, fetchV2Response(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
  }
  if (first.startsWith('want ')) {
    // Protocol v0 fetch: wants section, flush, negotiation section, flush.
    sendBytes(ctx, 200, fetchV0Response(repo, packets), 'application/x-git-upload-pack-result');
    return;
  }
  throw new Error('upload-pack body names no command');
}

// ---------------------------------------------------------------- ls-refs

function lsRefsResponse(repo: RepoType, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pkt(`${line}\n`));
    } else if (unborn) {
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pkt(`${line}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = repo.peel(oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch core

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  /** True when the request carries `done`: the client wants the pack now. */
  done: boolean;
  /** True when the request carries `deepen-relative`: deepen counts from the shallow boundary. */
  relative: boolean;
}

/**
 * Resolve a deepen request to an absolute depth. With `deepen-relative`,
 * `deepen N` extends N levels beyond the client's current shallow boundary,
 * which sits at (edge distance from the want) + 1 commits deep — so the
 * equivalent absolute depth is that distance + 1 + N. Without it, the
 * depth is already absolute.
 */
function resolveDepth(repo: RepoType, args: FetchArgs): number | null {
  const { wants, shallows, depth, relative } = args;
  if (!relative || depth === null || shallows.length === 0 || wants.length === 0) return depth;
  const boundary = new Set(shallows);
  let minDistance: number | null = null;
  const seen = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; distance: number };
    if (seen.has(current.oid)) continue;
    seen.add(current.oid);
    if (boundary.has(current.oid)) {
      minDistance = minDistance === null ? current.distance : Math.min(minDistance, current.distance);
      continue;
    }
    const commit = repo.getCommit(repo.peel(current.oid));
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, distance: current.distance + 1 });
  }
  return minDistance === null ? depth : minDistance + 1 + depth;
}

/** Plan a fetch: which commits to send, and the shallow-info lines. */
function planFetch(repo: RepoType, args: FetchArgs): { commits: string[]; shallow: string[]; unshallow: string[] } {
  const { wants, haves, shallows, depth } = args;
  const shallowSet = new Set(shallows);
  // Peel tag wants to their commits for traversal, remembering the tags.
  const wantCommits: string[] = [];
  for (const want of wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') wantCommits.push(repo.peel(want));
    else if (object.type === 'commit') wantCommits.push(want);
  }
  // The haves' closure, cut at the client's shallow boundary: never traverse
  // the parents of a commit the client names as shallow.
  const havesSet = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (havesSet.has(oid)) continue;
      havesSet.add(oid);
      if (shallowSet.has(oid)) continue;
      const commit = repo.getCommit(repo.peel(oid));
      if (commit !== null) for (const parent of commit.parents) stack.push(parent);
    }
  }
  // The wants' closure, depth-limited, traversing through haves (the set
  // difference below is what excludes them; traversing through a shallow-cut
  // have is what reaches the parents the client lacks).
  const wantClosure = new Map<string, number>();
  {
    const queue: Array<{ oid: string; depth: number }> = wantCommits.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0) {
      const { oid, depth: at } = queue.shift() as { oid: string; depth: number };
      if (wantClosure.has(oid)) continue;
      wantClosure.set(oid, at);
      if (depth !== null && at + 1 >= depth) continue;
      const commit = repo.getCommit(oid);
      if (commit !== null) for (const parent of commit.parents) queue.push({ oid: parent, depth: at + 1 });
    }
  }
  const sendSet = new Set<string>();
  for (const oid of wantClosure.keys()) {
    if (!havesSet.has(oid)) sendSet.add(oid);
  }
  // Shallow-info: the new boundary, and the old boundary now fully included.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, at] of wantClosure) {
      if (at !== depth - 1 || !sendSet.has(oid)) continue;
      const commit = repo.getCommit(oid);
      if (commit === null) continue;
      const boundary = commit.parents.some((parent) => !sendSet.has(parent) && !havesSet.has(parent));
      if (boundary && commit.parents.length > 0) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of shallows) {
    if (!wantClosure.has(oid)) continue;
    const commit = repo.getCommit(oid);
    if (commit === null) continue;
    if (commit.parents.every((parent) => sendSet.has(parent) || havesSet.has(parent))) unshallow.push(oid);
  }
  // Send order: BFS order from the wants (wantClosure insertion order), minus haves.
  const commits: string[] = [];
  for (const oid of wantClosure.keys()) if (sendSet.has(oid)) commits.push(oid);
  return { commits, shallow, unshallow };
}

/** Collect a fetch's pack objects: commits, their trees and blobs, tag wants. */
function collectFetchObjects(repo: RepoType, commits: readonly string[], tagWants: readonly string[]): GitObject[] {
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  const addObject = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = repo.getObject(oid);
    if (object === undefined) return;
    seen.add(oid);
    objects.push(object);
  };
  const addTree = (treeOid: string): void => {
    if (seen.has(treeOid)) return;
    const entries = repo.getTreeEntries(treeOid);
    if (entries === null) return;
    addObject(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') addTree(entry.oid);
      else addObject(entry.oid);
    }
  };
  for (const oid of tagWants) addObject(oid);
  for (const oid of commits) {
    addObject(oid);
    const commit = repo.getCommit(oid);
    if (commit !== null) addTree(commit.tree);
  }
  return objects;
}

/**
 * Every object the client already holds through its haves: the have commits
 * themselves, their trees and blobs, and the have ids as sent (tag objects).
 * An incremental fetch must not re-send any of these. The walk cuts at the
 * request's shallow boundary, exactly like the haves' closure: the parents
 * of a shallow commit are precisely what the client lacks.
 */
function heldObjects(repo: RepoType, haves: readonly string[], shallows: readonly string[]): Set<string> {
  const shallowSet = new Set(shallows);
  const held = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const entries = repo.getTreeEntries(treeOid);
    if (entries === null) return;
    held.add(treeOid);
    for (const entry of entries) {
      if (entry.mode === '40000') addTree(entry.oid);
      else held.add(entry.oid);
    }
  };
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    held.add(oid);
    const commit = repo.getCommit(repo.peel(oid));
    if (commit === null) continue;
    addTree(commit.tree);
    if (shallowSet.has(oid)) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return held;
}

/** A fetch's pack: the new objects, minus everything the client already holds. */
function fetchPack(repo: RepoType, plan: { commits: string[] }, tagWants: readonly string[], haves: readonly string[], shallows: readonly string[]): Buffer {
  const objects = collectFetchObjects(repo, plan.commits, tagWants);
  if (haves.length === 0) return writePack(objects);
  const held = heldObjects(repo, haves, shallows);
  const fresh = objects.filter((object) => !held.has(hashObject(object.type, object.data)));
  return writePack(fresh);
}

/** Wrap pack bytes in sideband band-1 packets, chunked under the pkt-line limit. */
function sideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let done = false;
  let relative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallows.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') relative = true;
    else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, no effect.
  }
  return { wants, haves, shallows, depth, done, relative };
}

function fetchV2Response(repo: RepoType, args: readonly string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const cacheKey = JSON.stringify({
    w: [...parsed.wants].sort(),
    h: [...parsed.haves].sort(),
    s: [...parsed.shallows].sort(),
    d: parsed.depth,
    done: parsed.done,
    relative: parsed.relative,
  });
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  // A request without `done` is a have-negotiation round: the client expects
  // an acknowledgments section only, then sends the next round. A request
  // with `done` expects the pack: shallow-info (when non-empty) then the
  // packfile section, with no acknowledgments section first.
  if (!parsed.done) {
    const response = Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), pktFlush()]);
    if (repo.fetchCache.size >= 128) repo.fetchCache.clear();
    repo.fetchCache.set(cacheKey, response);
    return response;
  }
  const plan = planFetch(repo, { ...parsed, depth: resolveDepth(repo, parsed) });
  const tagWants = parsed.wants.filter((want) => {
    const object = repo.getObject(want);
    return object !== undefined && object.type === 'tag';
  });
  const pack = fetchPack(repo, plan, tagWants, parsed.haves, parsed.shallows);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sideband(pack));
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  if (repo.fetchCache.size >= 128) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, response);
  return response;
}

function fetchV0Response(repo: RepoType, packets: readonly Packet[]): Buffer {
  // Two sections: wants/shallow/deepen, flush, haves/done, flush.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') sections.push([]);
    else if (packet.kind === 'data') {
      sections[sections.length - 1]?.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const wants: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let relative = false;
  for (const line of sections[0] ?? []) {
    if (line.startsWith('want ')) {
      // The first want line may carry capability words after the oid.
      const tokens = line.slice(5).split(' ');
      const token = tokens[0] as string;
      wants.push(token);
      if (tokens.includes('deepen-relative')) relative = true;
    } else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  const haves: string[] = [];
  let done = false;
  for (const line of sections[1] ?? []) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') done = true;
  }
  const fetchArgs: FetchArgs = { wants, haves, shallows, depth, done, relative };
  const plan = planFetch(repo, { ...fetchArgs, depth: resolveDepth(repo, fetchArgs) });
  // A shallow request without `done` is round one of the v0 negotiation:
  // the client reads only the shallow list, then re-sends the request with
  // `done`. Answering with the full response here would leave the NAK and
  // the pack unread, and the client would read them as round two.
  if (!done && depth !== null) {
    const shallowOnly: Buffer[] = [];
    for (const oid of plan.shallow) shallowOnly.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) shallowOnly.push(pkt(`unshallow ${oid}\n`));
    shallowOnly.push(pktFlush());
    return Buffer.concat(shallowOnly);
  }
  const tagWants = wants.filter((want) => {
    const object = repo.getObject(want);
    return object !== undefined && object.type === 'tag';
  });
  const pack = fetchPack(repo, plan, tagWants, haves, shallows);
  // v0 order: shallow/unshallow lines, flush, NAK, then the sideband pack.
  // The flush terminates the shallow section: git's reader stays in its
  // shallow loop until it sees one, and dies on the NAK otherwise.
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) parts.push(pktFlush());
  parts.push(pkt('NAK\n'));
  parts.push(...sideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(ctx: Ctx, repo: RepoType): void {
  const { packets, rest } = parseUntilFlush(ctx.body);
  const lines = dataLines(packets);
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  lines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        for (const token of text.slice(nul + 1).split(' ')) if (token !== '') caps.add(token);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error('receive-pack command has a bad ref');
    commands.push({ oldOid, newOid, ref });
  });
  const sidebandCap = caps.has('side-band-64k');

  // Ingest the pack (the bytes past the flush), if any. Delete-only lists carry none.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = ctx.body.subarray(rest);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.getObject(oid));
      repo.putPackedObjects(objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\s+/g, ' ').trim() : 'unpack failed';
    }
  }

  // Apply the commands in order; only the ok ones move refs.
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      reports.push({ ref: command.ref, ok: false, reason: unpackDetail });
      continue;
    }
    reports.push(applyCommand(repo, command));
  }

  // The report-status stream, pkt-framed, inside sideband band 1 when negotiated.
  const stream: Buffer[] = [pkt(`unpack ${unpackDetail}\n`)];
  for (const report of reports) {
    stream.push(report.ok ? pkt(`ok ${report.ref}\n`) : pkt(`ng ${report.ref} ${report.reason}\n`));
  }
  stream.push(pktFlush());
  const streamBytes = Buffer.concat(stream);
  const parts: Buffer[] = [];
  if (sidebandCap) {
    const CHUNK = 32768;
    for (let offset = 0; offset < streamBytes.length; offset += CHUNK) {
      const slice = streamBytes.subarray(offset, Math.min(streamBytes.length, offset + CHUNK));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    parts.push(streamBytes);
  }
  parts.push(pktFlush());
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** Apply one ref update; the pack's objects are already stored. */
function applyCommand(repo: RepoType, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): { ref: string; ok: boolean; reason: string } => ({ ref, ok: false, reason });
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // A delete.
    if (current === undefined) return fail('remote ref does not exist');
    if (oldOid !== ZERO_OID && oldOid !== current) return fail('old oid does not match the current ref');
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }

  const target = repo.getObject(newOid);
  if (target === undefined) return fail('object does not exist');
  if (target.type !== 'commit' && target.type !== 'tag') return fail('object is not a commit or tag');

  if (oldOid === ZERO_OID) {
    // A create.
    if (current !== undefined) return fail('ref already exists');
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }

  if (current === undefined) return fail('remote ref does not exist');
  if (current !== oldOid) return fail('old oid does not match the current ref');
  if (newOid === oldOid) return { ref, ok: true, reason: '' };

  if (ref.startsWith('refs/tags/')) {
    return fail('tag updates are not allowed');
  }
  // A fast-forward: the old tip must be an ancestor of the new one.
  const newCommit = target.type === 'tag' ? repo.peel(newOid) : newOid;
  const oldCommit = repo.peel(oldOid);
  if (!repo.isAncestor(oldCommit, newCommit)) {
    return fail('non-fast-forward');
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

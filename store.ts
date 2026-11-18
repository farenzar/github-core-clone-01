// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments. One process, no persistence; every
// response the store shapes is deterministic (fixed timestamps, stable order).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type CommitInfo,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitobj.ts';

/** The token owner's identity: the fixed viewer of the suite's seeded scenario. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The one timestamp every response carries: the scenario epoch, 2025-01-01. */
export const FIXED_TIMESTAMP = '2025-01-01T00:00:00Z';
/** The same epoch in seconds, for commit identity lines. */
export const FIXED_EPOCH_SEC = 1735689600;
/** The identity line every commit this forge authors carries. */
export const FORGE_IDENTITY = `ada iversen <adaiversen@example.invalid> ${FIXED_EPOCH_SEC} +0000`;

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------- records

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Creation order within the repo: what created-order sorts read. */
  readonly seq: number;
}

export interface CommentRec {
  readonly id: number;
  readonly body: string;
  readonly seq: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  readonly seq: number;
}

/** One flattened tree entry: a file's blob id and mode. */
export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

// ---------------------------------------------------------------- repository

export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string = DEFAULT_BRANCH;
  readonly createdSeq: number;

  /** Objects by id. Immutable once stored. */
  readonly objects = new Map<string, GitObject>();
  /** Full ref names ('refs/heads/main') to object ids. */
  readonly refs = new Map<string, string>();
  /** Parsed commits, memoized: objects never change. */
  private readonly commitCache = new Map<string, CommitInfo>();
  /** Parsed trees, memoized. */
  private readonly treeCache = new Map<string, TreeEntry[]>();
  /** Flattened trees by commit id, memoized. */
  private readonly flatCache = new Map<string, Map<string, FlatEntry>>();

  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels = new Map<string, Label>();
  readonly comments = new Map<number, CommentRec[]>();
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber = 1;
  private issueSeq = 0;

  /** Fetch responses memoized by want/have/shallow/depth: objects are immutable. */
  readonly fetchCache = new Map<string, Buffer>();

  constructor(id: number, name: string, owner: string, isPrivate: boolean, description: string, createdSeq: number) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.private = isPrivate;
    this.description = description;
    this.createdSeq = createdSeq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  // ------------------------------------------------------------ objects

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: readonly GitObject[]): void {
    for (const object of objects) this.putObject(object.type, object.data);
  }

  getCommit(oid: string): CommitInfo | null {
    const cached = this.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  getTreeEntries(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  /** Peel a tag (recursively) to the object it ultimately names. */
  peel(oid: string): string {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag' || seen.has(current)) return current;
      seen.add(current);
      current = parseTag(object.data).object;
    }
  }

  // ------------------------------------------------------------ refs

  /** The default branch's tip, or null when the repository is unborn. */
  headOid(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }

  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    names.sort();
    return names;
  }

  // ------------------------------------------------------------ history

  /** Whether `ancestor` is reachable from `descendant` (or equal to it). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(oid);
      if (commit !== null) for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** The nearest common ancestor of two commits, or null when histories are disjoint. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const commit = this.getCommit(oid);
      if (commit !== null) for (const parent of commit.parents) stackA.push(parent);
    }
    const seenB = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const commit = this.getCommit(oid);
      if (commit !== null) for (const parent of commit.parents) queue.push(parent);
    }
    return null;
  }

  /** A tip's history, newest first: depth-first, first parent first. */
  history(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(oid);
      if (commit === null) continue;
      order.push(oid);
      for (let index = commit.parents.length - 1; index >= 0; index -= 1) {
        stack.push(commit.parents[index] as string);
      }
    }
    return order;
  }

  // ------------------------------------------------------------ trees

  /** Flatten a commit's tree to path -> file entry. */
  flattenCommit(commitOid: string): Map<string, FlatEntry> {
    const cached = this.flatCache.get(commitOid);
    if (cached !== undefined) return cached;
    const flat = new Map<string, FlatEntry>();
    const commit = this.getCommit(commitOid);
    if (commit !== null) this.flattenTreeInto(commit.tree, '', flat);
    this.flatCache.set(commitOid, flat);
    return flat;
  }

  private flattenTreeInto(treeOid: string, prefix: string, out: Map<string, FlatEntry>): void {
    const entries = this.getTreeEntries(treeOid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTreeInto(entry.oid, path, out);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  }

  /** Build (and store) the tree objects for a flat path map; returns the root tree id. */
  buildTreeFromFlat(flat: ReadonlyMap<string, FlatEntry>): string {
    return this.buildLevelFromMap(new Map(flat));
  }

  /** Recursive tree builder over a map of relative paths. */
  private buildLevelFromMap(flat: ReadonlyMap<string, FlatEntry>): string {
    const files: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, FlatEntry>>();
    for (const [path, entry] of flat) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        files.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        const dir = path.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map<string, FlatEntry>();
          dirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), entry);
      }
    }
    const entries: TreeEntry[] = [...files];
    for (const [dir, sub] of dirs) {
      entries.push({ mode: '40000', name: dir, oid: this.buildLevelFromMap(sub) });
    }
    return this.putObject('tree', buildTree(entries));
  }

  /** Author a commit on top of `parents` with `tree`; returns its id. */
  authorCommit(tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      message,
    });
    return this.putObject('commit', data);
  }

  // ------------------------------------------------------------ issues & pulls

  nextIssueSeq(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }
}

// ---------------------------------------------------------------- the forge

/** The whole forge: every repository, keyed by "owner/name". */
export class Forge {
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRecordId = 1;
  private nextCommentId = 1;
  private repoSeq = 0;

  /** Create a repository under the token owner. Null when the name is taken. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo = new Repo(this.nextRepoId, name, VIEWER.login, isPrivate, description, this.repoSeq);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** A fresh stable record id (issues and pull requests share the counter). */
  nextId(): number {
    const id = this.nextRecordId;
    this.nextRecordId += 1;
    return id;
  }

  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

export { ZERO_OID };

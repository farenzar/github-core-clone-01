// Git object model and packfile codec: SHA-1 objects, commit/tree/tag parsing,
// delta application, and packfile read/write. Pure functions over Buffers;
// no I/O, no store access. Written for the git smart-HTTP surface.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The four git object types. */
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored object: its type and its raw (uncompressed) bytes. */
export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** A resolved pack object: its id plus its type and bytes. */
export interface PackedObject extends GitObject {
  readonly oid: string;
}

/** The all-zero object id: an unborn ref's value. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Whether `value` is a 40-hex object id. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of an object: sha1("<type> <size>\0" + bytes), hex. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------- commits

/** A parsed commit: its tree, parents, identity lines and message (verbatim). */
export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit's raw bytes. Header continuation lines fold into their header. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  // Fold continuation lines (a line starting with a space belongs to the previous header).
  const lines: string[] = [];
  for (const raw of headerText.split('\n')) {
    if (raw.startsWith(' ') && lines.length > 0) {
      lines[lines.length - 1] += `\n${raw}`;
    } else {
      lines.push(raw);
    }
  }
  for (const line of lines) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value.trim();
    else if (key === 'parent') parents.push(value.trim());
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit's raw bytes from its fields. The message is stored verbatim. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let text = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) text += `parent ${parent}\n`;
  text += `author ${fields.author}\n`;
  text += `committer ${fields.committer}\n`;
  text += `\n${fields.message}`;
  return Buffer.from(text, 'utf8');
}

// ---------------------------------------------------------------- trees

/** One tree entry: mode as stored ('100644', '40000', ...), name, and object id. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree's raw bytes: "<mode> <name>\0<20-byte oid>" entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: a directory name compares as if it ended in '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

/** Build a tree's raw bytes; entries are sorted git-style. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

/** A parsed annotated tag: what it points at and its own name. */
export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tag object's raw bytes. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value.trim();
    else if (key === 'type') type = value.trim();
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- deltas

/** Read a git delta's size varint: 7 bits per byte, little-endian groups. */
function readDeltaVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= data.length) throw new Error('delta varint is truncated');
    const byte = data[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/**
 * Apply a git delta to its base bytes. Verifies the declared source size
 * against the base and the declared target size against the result.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaVarint(delta, 0);
  if (source.value !== base.length) {
    throw new Error(`delta source size ${source.value} does not match base length ${base.length}`);
  }
  const target = readDeltaVarint(delta, source.next);
  const parts: Buffer[] = [];
  let produced = 0;
  let pos = target.next;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      // Copy from the base: offset/size follow as flagged bytes.
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy offset is truncated');
          offset |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy size is truncated');
          size |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      // Insert the next `op` literal bytes.
      if (pos + op > delta.length) throw new Error('delta insert is truncated');
      parts.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== target.value) {
    throw new Error(`delta produced ${produced} bytes, expected ${target.value}`);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pack reading

const PACK_TYPE_NAMES: Readonly<Record<number, ObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** Inflate one zlib stream starting at `offset`; `next` is the byte past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read a pack entry's type/size header varint. */
function readPackHeader(data: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  if (offset >= data.length) throw new Error('pack entry header is truncated');
  const first = data[offset];
  const typeCode = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    if (pos >= data.length) throw new Error('pack entry header is truncated');
    byte = data[pos];
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, next: pos };
}

/** Read an OFS_DELTA's negative-offset encoding; the value is relative to the entry's header start. */
function readOfsDeltaOffset(data: Buffer, offset: number): { value: number; next: number } {
  if (offset >= data.length) throw new Error('ofs-delta offset is truncated');
  let byte = data[offset];
  let pos = offset + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (pos >= data.length) throw new Error('ofs-delta offset is truncated');
    byte = data[pos];
    pos += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: pos };
}

interface RawPackEntry {
  /** Offset of the entry's header: what OFS_DELTA bases address. */
  readonly start: number;
  readonly typeCode: number;
  readonly size: number;
  readonly dataOffset: number;
  /** For REF_DELTA: the base object's id. */
  readonly baseOid?: string;
  /** For OFS_DELTA: the base entry's start offset. */
  readonly baseOffset?: number;
}

/**
 * Read a version-2 packfile and resolve every object, including OFS_DELTA and
 * REF_DELTA chains. Thin-pack bases the pack does not carry are resolved through
 * `getBase` (the store's objects); a base found nowhere is an error. The trailer
 * checksum is not verified: the entries' own sizes and the delta checks are what
 * a corrupt pack fails on, and a good pack is never refused for its trailer.
 */
export function readPack(pack: Buffer, getBase: (oid: string) => GitObject | undefined): PackedObject[] {
  if (pack.length < 12) throw new Error('pack is shorter than its header');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  // First pass: locate every entry and inflate its payload (deltas stay deltas).
  const entries: RawPackEntry[] = [];
  const payloads = new Map<number, Buffer>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    const header = readPackHeader(pack, offset);
    offset = header.next;
    let entry: RawPackEntry;
    if (header.typeCode === 6) {
      const ofs = readOfsDeltaOffset(pack, offset);
      entry = { start, typeCode: 6, size: header.size, dataOffset: ofs.next, baseOffset: start - ofs.value };
      offset = ofs.next;
    } else if (header.typeCode === 7) {
      if (offset + 20 > pack.length) throw new Error('ref-delta base id is truncated');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      entry = { start, typeCode: 7, size: header.size, dataOffset: offset + 20, baseOid };
      offset += 20;
    } else {
      entry = { start, typeCode: header.typeCode, size: header.size, dataOffset: offset };
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack object at ${start} inflated to ${inflated.data.length} bytes, header says ${header.size}`);
    }
    payloads.set(start, inflated.data);
    entries.push(entry);
    offset = inflated.next;
  }
  // Second pass: resolve deltas recursively, memoizing by entry start.
  const resolved = new Map<number, PackedObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): PackedObject => {
    const cached = resolved.get(entry.start);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.start)) throw new Error('pack delta chain is cyclic');
    resolving.add(entry.start);
    try {
      const payload = payloads.get(entry.start);
      if (payload === undefined) throw new Error('pack entry payload is missing');
      let object: PackedObject;
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: PackedObject | GitObject | undefined;
        if (entry.typeCode === 6) {
          const baseEntry = entries.find((candidate) => candidate.start === entry.baseOffset);
          if (baseEntry === undefined) throw new Error('ofs-delta base offset names no pack entry');
          base = resolve(baseEntry);
        } else {
          const baseOid = entry.baseOid ?? '';
          const inPack = entries.find((candidate) => {
            // A ref-delta base in the pack resolves by its computed id; resolve lazily.
            if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
            const probe = payloads.get(candidate.start);
            if (probe === undefined) return false;
            const type = PACK_TYPE_NAMES[candidate.typeCode];
            return type !== undefined && hashObject(type, probe) === baseOid;
          });
          if (inPack !== undefined) base = resolve(inPack);
          else {
            // The base may itself be a delta in the pack: resolve every entry and match by id.
            for (const candidate of entries) {
              if (candidate === entry) continue;
              const candidateObject = resolve(candidate);
              if (candidateObject.oid === baseOid) {
                base = candidateObject;
                break;
              }
            }
            base ??= getBase(baseOid);
          }
          if (base === undefined) throw new Error(`ref-delta base ${baseOid} is not in the pack or the store`);
        }
        const data = applyDelta(base.data, payload);
        const oid = hashObject(base.type, data);
        object = { oid, type: base.type, data };
      } else {
        const type = PACK_TYPE_NAMES[entry.typeCode];
        if (type === undefined) throw new Error(`pack object type ${entry.typeCode} is not supported`);
        const oid = hashObject(type, payload);
        object = { oid, type, data: payload };
      }
      resolved.set(entry.start, object);
      return object;
    } finally {
      resolving.delete(entry.start);
    }
  };
  return entries.map((entry) => resolve(entry));
}

// ---------------------------------------------------------------- pack writing

/** Encode a pack entry's type/size header varint. */
function packHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

const TYPE_CODES: Readonly<Record<ObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/**
 * Build a version-2 packfile from plain objects (no deltas): the caller's order,
 * deduplicated by id, with a SHA-1 trailer over every preceding byte.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const seen = new Set<string>();
  const unique: GitObject[] = [];
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (seen.has(oid)) continue;
    seen.add(oid);
    unique.push(object);
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(unique.length, 8);
  const parts: Buffer[] = [header];
  for (const object of unique) {
    parts.push(packHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

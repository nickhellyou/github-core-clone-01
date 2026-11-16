// github-core-clone-01: a GitHub-compatible git forge in one Node process.
//
// Serves git smart HTTP (upload-pack v2 + receive-pack v0), the REST v3 API,
// GraphQL v4 and MCP tools, all over one in-memory store. No disk I/O in the
// request path, no clock reads, no Math.random: every timestamp derives from
// MAKEFUN_TRIAL_NOW and every id from a sequential counter, so two runs on
// the same instance export identical state.
//
// Lifecycle: bind an ephemeral port, register it with $MAKEFUN_ENV_URL, then
// long-poll GET $MAKEFUN_ENV_URL/done until {"done": true} and exit 0.
// Run: node --experimental-strip-types main.ts   (Node >= 22.18)

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ identity
// The scenario seed is a fixed public constant; the viewer, teammate and
// stranger logins derive from it with the same xorshift64* stream the
// grading suite uses, so the identities always agree.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function deriveUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = deriveUsers();
const VIEWER = SCENARIO_USERS[0] as ScenarioUser;
const TEAMMATE = SCENARIO_USERS[1] as ScenarioUser;
const STRANGER = SCENARIO_USERS[2] as ScenarioUser;
const ORG = 'faint-meadow-org';
const SCENARIO_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'] as const;

// ------------------------------------------------------------------ trial time
// All timestamps come from MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms). When it
// is absent we fall back to the scenario epoch, never to the wall clock.

function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && /^\d+$/.test(raw.trim())) return asNum;
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) return asDate;
  }
  return SCENARIO_EPOCH_SEC * 1000;
}
const TRIAL_NOW_MS = parseTrialNow();
const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);

// One global creation counter: every timestamp and every sequential id in
// the store derives from it, so ordering is deterministic and distinct.
let globalSeq = 0;
function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}
function stampFor(seq: number): string {
  return new Date(TRIAL_NOW_MS + seq * 1000).toISOString();
}
function commitTimeFor(seq: number): number {
  return TRIAL_NOW_SEC + seq;
}

// Request ids: req-<counter>, sequential, deterministic for a given run.
let reqCounter = 0;
function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

// ------------------------------------------------------------------ small utils

const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function gitObjectId(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}
function b64decode(text: string): Buffer {
  return Buffer.from(text, 'base64');
}
function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapeJson(text: string): string {
  return JSON.stringify(text);
}

// ------------------------------------------------------------------ pkt-line
// A pkt-line is 4 hex digits of total length (including the 4 digits) then
// the payload. 0000 = flush, 0001 = delim, 0002 = response-end.

function pktEncode(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktEncodeLines(lines: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktEncode(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into frames. Each frame is either a
 *  data Buffer, 'flush', 'delim' or 'response-end'. Throws on bad framing. */
type PktFrame = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

function pktDecodeAll(buf: Buffer): PktFrame[] {
  const frames: PktFrame[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      frames.push({ kind: 'flush' });
      off += 4;
    } else if (len === 1) {
      frames.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      frames.push({ kind: 'end' });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      frames.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return frames;
}

// ------------------------------------------------------------------ git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  authorTime: number;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let authorTime = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = author.match(/ (\d+) [+-]\d{4}$/);
      if (m) authorTime = parseInt(m[1], 10);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, authorTime };
}

function buildCommit(tree: string, parents: string[], authorName: string, authorEmail: string, epochSec: number, message: string): Buffer {
  const ident = `${authorName} <${authorEmail}> ${epochSec} +0000`;
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeEntrySortKey(e: TreeEntry): string {
  // git sorts tree entries by name, with directories compared as name + '/'.
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeEntrySortKey(a) < treeEntrySortKey(b) ? -1 : treeEntrySortKey(a) > treeEntrySortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const obj = (text.match(/^object ([0-9a-f]{40})$/m) || [])[1] || '';
  const type = (text.match(/^type (\w+)$/m) || [])[1] || '';
  return { object: obj, type };
}

// ------------------------------------------------------------------ packfiles

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta target size mismatch');
  return result;
}

const PACK_TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/** Parse a packfile buffer into entries. Resolves OFS_DELTA / REF_DELTA. */
function readPack(buf: Buffer): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  // Trailer: last 20 bytes are the SHA-1 of everything before them.
  if (buf.length >= 32) {
    const expect = buf.subarray(buf.length - 20).toString('hex');
    const actual = sha1Hex(buf.subarray(0, buf.length - 20));
    if (expect !== actual) throw new Error('pack checksum mismatch');
  }
  let off = 12;
  const raw: { type: number; data: Buffer; start: number; baseOff?: number; baseOid?: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const first = buf[off];
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let p = off + 1;
    while (buf[p - 1] & 0x80) {
      size |= (buf[p] & 0x7f) << shift;
      shift += 7;
      p += 1;
    }
    if (type === 6) {
      // OFS_DELTA: negative offset varint; store the base's absolute offset.
      let b = buf[p];
      p += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[p];
        p += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateSync(buf.subarray(p), { info: true });
      const consumed = (inflated.engine as { bytesWritten: number }).bytesWritten;
      raw.push({ type, data: inflated.buffer, start, baseOff: start - baseOff });
      p += consumed;
    } else if (type === 7) {
      const baseOid = buf.subarray(p, p + 20).toString('hex');
      p += 20;
      const inflated = inflateSync(buf.subarray(p), { info: true });
      const consumed = (inflated.engine as { bytesWritten: number }).bytesWritten;
      raw.push({ type, data: inflated.buffer, start, baseOid });
      p += consumed;
    } else {
      const inflated = inflateSync(buf.subarray(p), { info: true });
      const consumed = (inflated.engine as { bytesWritten: number }).bytesWritten;
      if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
      raw.push({ type, data: inflated.buffer, start });
      p += consumed;
    }
    off = p;
  }
  // Plain entries first; deltas resolve against them (and against earlier
  // resolved deltas) in a retry loop, so pack order never matters.
  const byOid = new Map<string, PackEntry>();
  const byOff = new Map<number, PackEntry>();
  const entries: PackEntry[] = [];
  for (const r of raw) {
    if (r.type >= 1 && r.type <= 4) {
      const type = PACK_TYPE_NAMES[r.type] as ObjType;
      const oid = gitObjectId(type, r.data);
      const e: PackEntry = { type, data: r.data, oid };
      byOid.set(oid, e);
      byOff.set(r.start, e);
      entries.push(e);
    }
  }
  const pending = raw.filter((r) => r.type === 6 || r.type === 7);
  let guard = 0;
  while (pending.length > 0 && guard < 10) {
    guard += 1;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const r = pending[i] as { type: number; data: Buffer; start: number; baseOff?: number; baseOid?: string };
      let base: PackEntry | undefined;
      if (r.type === 6 && r.baseOff !== undefined) base = byOff.get(r.baseOff);
      if (r.type === 7 && r.baseOid !== undefined) base = byOid.get(r.baseOid);
      if (base === undefined) continue;
      const data = applyDelta(base.data, r.data);
      const e: PackEntry = { type: base.type, data, oid: gitObjectId(base.type, data) };
      byOid.set(e.oid, e);
      byOff.set(r.start, e);
      entries.push(e);
      // A resolved delta can itself be the base of a later REF_DELTA (via
      // its oid) or OFS_DELTA (via its start offset in this pack).
      pending.splice(i, 1);
    }
  }
  if (pending.length > 0) throw new Error('unresolved pack delta');
  return entries;
}

function writePackEntry(type: ObjType, data: Buffer): Buffer {
  const code = PACK_TYPE_CODES[type];
  const size = data.length;
  const header: number[] = [];
  let s = size;
  let first = (code << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) first |= 0x80;
  header.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    header.push(b);
  }
  const deflated = deflateSync(data, { level: 1 });
  return Buffer.concat([Buffer.from(header), deflated]);
}

/** Build a packfile from plain objects, in the given (deterministic) order.
 *  A pack is a pure function of its sorted object ids (oids are content
 *  hashes and deflate is deterministic), so identical object lists reuse
 *  the built bytes; the clone workload fetches the same pack 50 times. */
const PACK_CACHE = new Map<string, Buffer>();
function writePack(objects: PackEntry[]): Buffer {
  const key = objects.map((o) => o.oid).join(',');
  const cached = PACK_CACHE.get(key);
  if (cached !== undefined) return cached;
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const o of objects) parts.push(writePackEntry(o.type, o.data));
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  const pack = Buffer.concat([body, trailer]);
  if (PACK_CACHE.size >= 2000) PACK_CACHE.clear();
  PACK_CACHE.set(key, pack);
  return pack;
}

// ------------------------------------------------------------------ reachability

function collectReachable(
  store: Map<string, GitObject>,
  tips: string[],
  stopAt: Set<string>,
): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (found.has(oid) || stopAt.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    found.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink: not stored here
        stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return found;
}

function collectAncestors(store: Map<string, GitObject>, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

function isAncestor(store: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  // Walk the tip's parents and stop the moment the ancestor is found; a
  // linear history only ever walks the gap, not the whole ancestry.
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** The nearest common ancestor of two commits, or null. */
function mergeBase(store: Map<string, GitObject>, a: string, b: string): string | null {
  const aAnc = collectAncestors(store, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAnc.has(oid)) return oid;
    const obj = store.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  return null;
}

/** Flatten a commit's tree to path -> {mode, oid}. */
function flattenTree(store: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre === '' ? e.name : `${pre}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Diff two trees (by oid) into a sorted list of file changes. */
function diffTrees(store: Map<string, GitObject>, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const base = flattenTree(store, baseTreeOid);
  const head = flattenTree(store, headTreeOid);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined) {
      if (b.oid === h.oid) continue;
      const bObj = store.get(b.oid);
      const hObj = store.get(h.oid);
      const del = bObj !== undefined && bObj.type === 'blob' ? countLines(bObj.data) : 0;
      const add = hObj !== undefined && hObj.type === 'blob' ? countLines(hObj.data) : 0;
      out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
    } else if (h !== undefined) {
      const hObj = store.get(h.oid);
      const add = hObj !== undefined && hObj.type === 'blob' ? countLines(hObj.data) : 0;
      out.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b !== undefined) {
      const bObj = store.get(b.oid);
      const del = bObj !== undefined && bObj.type === 'blob' ? countLines(bObj.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
    }
  }
  return out;
}

// ------------------------------------------------------------------ store

interface Label {
  name: string;
  color: string;
}

interface Issue {
  id: number;
  number: number;
  repoDb: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  authorLogin: string;
}

interface Pull {
  id: number;
  number: number;
  repoDb: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  authorLogin: string;
}

interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  seq: number;
  createdAt: string;
  authorLogin: string;
}

interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, IssueComment[]>;
  labels: Map<string, Label>;
  nextNumber: number;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64urlEncode(`${kind}:${parts.join(':')}`);
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const seq = nextSeq();
    const repo: Repo = {
      dbId: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      updatedSeq: seq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(repoKey(VIEWER.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    out.sort((a, b) => a.dbId - b.dbId);
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const seq = nextSeq();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      repoDb: repo.dbId,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq,
      createdAt: stampFor(seq),
      updatedAt: stampFor(seq),
      closedAt: null,
      authorLogin: VIEWER.login,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const seq = nextSeq();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextNumber,
      repoDb: repo.dbId,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq,
      createdAt: stampFor(seq),
      updatedAt: stampFor(seq),
      closedAt: null,
      authorLogin: VIEWER.login,
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    const seq = nextSeq();
    const comment: IssueComment = {
      id: this.nextCommentId,
      issueNumber,
      body,
      seq,
      createdAt: stampFor(seq),
      authorLogin: VIEWER.login,
    };
    this.nextCommentId += 1;
    const list = repo.comments.get(issueNumber) || [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }
}

const store = new Store();

// ------------------------------------------------------------------ tree helpers

/** Resolve a ref-ish (branch name, full ref, or 40-hex oid) to a commit oid. */
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (OID_RE.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

interface DirNode {
  files: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, DirNode>;
}

/** Build (and store) nested trees for a flat path map; returns the root oid. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, e] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts[i] as string;
      let child = node.dirs.get(dir);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(dir, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, e);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = gitObjectId('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store a blob and return its oid. */
function storeBlob(repo: Repo, content: Buffer): string {
  const oid = gitObjectId('blob', content);
  repo.objects.set(oid, { type: 'blob', data: content });
  return oid;
}

/** Create a commit object, store it, return its oid. */
function storeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const seq = nextSeq();
  const data = buildCommit(treeOid, parents, VIEWER.name, VIEWER.email, commitTimeFor(seq), message);
  const oid = gitObjectId('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** Write or replace one file on a branch; creates the branch from the
 *  default tip when it does not exist yet. Returns the new commit oid. */
function commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): string {
  const refName = `refs/heads/${branch}`;
  let parent: string | undefined = repo.refs.get(refName);
  if (parent === undefined && branch !== repo.defaultBranch) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const flat = parent !== undefined ? flattenTree(repo.objects, parseCommit((repo.objects.get(parent) as GitObject).data).tree) : new Map<string, { mode: string; oid: string }>();
  const blobOid = storeBlob(repo, content);
  flat.set(path, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitOid = storeCommit(repo, treeOid, parent !== undefined ? [parent] : [], message);
  repo.refs.set(refName, commitOid);
  return commitOid;
}

/** Delete one file on a branch; returns the new commit oid, or null when
 *  the file does not exist on that branch. */
function deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName);
  if (parent === undefined) return null;
  const flat = flattenTree(repo.objects, parseCommit((repo.objects.get(parent) as GitObject).data).tree);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitOid = storeCommit(repo, treeOid, [parent], message);
  repo.refs.set(refName, commitOid);
  return commitOid;
}

/** Three-way tree merge of headTip into baseTip. Returns the merged tree oid
 *  and any conflicting paths; a conflict means the merge must be refused. */
function threeWayMerge(repo: Repo, baseTip: string, headTip: string): { treeOid: string | null; conflicts: string[] } {
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return { treeOid: null, conflicts: ['no merge base'] };
  const baseCommit = repo.objects.get(base) as GitObject;
  const baseFlat = flattenTree(repo.objects, parseCommit(baseCommit.data).tree);
  const oursFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(baseTip) as GitObject).data).tree);
  const theirsFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(headTip) as GitObject).data).tree);
  const merged = new Map<string, { mode: string; oid: string }>(oursFlat);
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const o = oursFlat.get(path);
    const t = theirsFlat.get(path);
    const oursChanged = (o?.oid ?? null) !== (b?.oid ?? null);
    const theirsChanged = (t?.oid ?? null) !== (b?.oid ?? null);
    if (!theirsChanged) continue; // ours wins (or nothing changed)
    if (!oursChanged) {
      if (t === undefined) merged.delete(path);
      else merged.set(path, t);
      continue;
    }
    if ((o?.oid ?? null) === (t?.oid ?? null)) continue; // same change both sides
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { treeOid: null, conflicts };
  return { treeOid: buildTreeFromFlat(repo, merged), conflicts: [] };
}

/** Mergeability of a pull request from the live branch tips. */
function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const { conflicts } = threeWayMerge(repo, baseTip, headTip);
  return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

// ------------------------------------------------------------------ serializers

function userJson(login: string): Record<string, unknown> {
  const user = SCENARIO_USERS.find((u) => u.login === login) || VIEWER;
  return { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User', avatar_url: '', html_url: `https://github.com/${user.login}`, url: `/api/v3/users/${user.login}` };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: stampFor(repo.createdSeq),
    updated_at: stampFor(repo.updatedSeq),
    pushed_at: stampFor(repo.updatedSeq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    language: null,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    user: userJson(issue.authorLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: (repo.comments.get(issue.number) || []).length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: userJson(pull.authorLogin) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userJson(repo.owner) },
    user: userJson(pull.authorLogin),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(repo: Repo, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
  };
}

// ------------------------------------------------------------------ http plumbing

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

/** True when the request carries the trial token. In dev mode (no token
 *  configured) any non-empty Bearer token is accepted as the viewer. */
function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

function sendJson(res: ServerResponse, status: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false; message: string } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false, message: 'Problems parsing JSON' };
  }
}

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(url: URL): PageParams {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  let perPage = parseInt(url.searchParams.get('per_page') || '30', 10) || 30;
  if (perPage < 1) perPage = 1;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

function paginate<T>(items: T[], params: PageParams): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { pageItems: items.slice(start, start + params.perPage), totalPages };
}

/** GitHub-style Link header for a paginated list, absolute same-origin. */
function linkHeader(req: IncomingMessage, url: URL, params: PageParams, totalPages: number): string | null {
  if (params.page >= totalPages && totalPages <= 1) return null;
  const host = req.headers.host || '127.0.0.1';
  const base = `http://${host}${url.pathname}`;
  const mk = (page: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `${base}?${q.toString()}`;
  };
  const links: string[] = [];
  if (params.page < totalPages) {
    links.push(`<${mk(params.page + 1)}>; rel="next"`);
    links.push(`<${mk(totalPages)}>; rel="last"`);
  }
  if (params.page > 1) {
    links.push(`<${mk(1)}>; rel="first"`);
    links.push(`<${mk(params.page - 1)}>; rel="prev"`);
  }
  return links.length > 0 ? links.join(', ') : null;
}

function restHeaders(req: IncomingMessage, url: URL, params: PageParams, totalPages: number): Record<string, string> {
  const headers: Record<string, string> = { 'X-OAuth-Scopes': 'repo, user' };
  const link = linkHeader(req, url, params, totalPages);
  if (link !== null) headers.Link = link;
  return headers;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

// ------------------------------------------------------------------ dispatcher

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const seg = splitPath(url.pathname);
  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET' && seg.length === 1 && seg[0] === 'healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
      await handleRest(req, res, url, seg.slice(2), method);
      return;
    }
    if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
      await handleGraphql(req, res, method);
      return;
    }
    if (seg.length === 1 && seg[0] === 'mcp') {
      await handleMcp(req, res, method);
      return;
    }
    if (seg.length >= 2 && seg[1].endsWith('.git')) {
      await handleGit(req, res, url, seg, method);
      return;
    }
    sendError(res, 404, 'Not Found');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendError(res, 500, message);
    else {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
  }
}

// ------------------------------------------------------------------ REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, seg: string[], method: string): Promise<void> {
  // seg is the path after /api/v3.
  if (seg.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
      meta_url: '/api/v3/meta',
    }, { 'X-OAuth-Scopes': 'repo, user' });
    return;
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' }, { 'X-OAuth-Scopes': 'repo, user' });
    return;
  }
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : Buffer.alloc(0);

  // ---- /user -------------------------------------------------------
  if (seg[0] === 'user') {
    if (seg.length === 1 && method === 'GET') {
      sendJson(res, 200, userJson(VIEWER.login), { 'X-OAuth-Scopes': 'repo, user' });
      return;
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof input.name === 'string' ? input.name : '';
        if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
          sendError(res, 422, 'Repository name is required and must be valid');
          return;
        }
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          sendError(res, 422, 'Repository already exists');
          return;
        }
        const repo = store.createRepo(name, typeof input.description === 'string' ? input.description : '', input.private === true);
        sendJson(res, 201, repoJson(repo), { 'X-OAuth-Scopes': 'repo, user' });
        return;
      }
      if (method === 'GET') {
        const params = pageParams(url);
        const all = store.listViewerRepos();
        const { pageItems, totalPages } = paginate(all, params);
        sendJson(res, 200, pageItems.map((r) => repoJson(r)), restHeaders(req, url, params, totalPages));
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- /repos/{owner}/{repo}/... ------------------------------------
  if (seg[0] !== 'repos' || seg.length < 3) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  // A repo belongs to the login the token names; any other owner is a 404,
  // never a 403, and a missing repo is a 404 too.
  if (owner !== VIEWER.login) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rest = seg.slice(3);
  const scopes = { 'X-OAuth-Scopes': 'repo, user' };

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), scopes);
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      repo.updatedSeq = nextSeq();
      sendJson(res, 200, repoJson(repo), scopes);
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId(), ...scopes });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- branches ----------------------------------------------------
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list: Record<string, unknown>[] = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        const name = ref.slice('refs/heads/'.length);
        list.push({ name, commit: { sha: oid, url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}` }, protected: false });
      }
      sendJson(res, 200, list, scopes);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${rest[1]}`);
      if (oid === undefined) {
        sendError(res, 404, 'Branch not found');
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: oid, url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}` }, protected: false }, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- commits -----------------------------------------------------
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const refParam = url.searchParams.get('sha') || repo.defaultBranch;
      const tip = resolveRef(repo, refParam);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const ancestors = [...collectAncestors(repo.objects, tip)];
      const items = ancestors
        .map((oid) => ({ oid, info: parseCommit((repo.objects.get(oid) as GitObject).data) }))
        .sort((a, b) => (b.info.authorTime - a.info.authorTime) || (a.oid < b.oid ? -1 : 1))
        .map(({ oid, info }) => ({
          sha: oid,
          commit: {
            message: info.message,
            author: { name: VIEWER.name, email: VIEWER.email, date: new Date(info.authorTime * 1000).toISOString() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(info.authorTime * 1000).toISOString() },
            tree: { sha: info.tree },
          },
          parents: info.parents.map((p) => ({ sha: p })),
        }));
      sendJson(res, 200, items, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- git refs ----------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !OID_RE.test(sha) || !repo.objects.has(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } }, scopes);
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const oid = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/${ref}`);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const obj = repo.objects.get(oid);
      sendJson(res, 200, { ref: ref.startsWith('refs/') ? ref : `refs/${ref}`, object: { sha: oid, type: obj?.type ?? 'commit' } }, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- contents ----------------------------------------------------
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    const refParam = url.searchParams.get('ref') || repo.defaultBranch;
    const branchForWrite = (input: Record<string, unknown>): string => (typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch);
    if (method === 'GET') {
      const tip = resolveRef(repo, refParam);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const treeOid = parseCommit((repo.objects.get(tip) as GitObject).data).tree;
      const flat = flattenTree(repo.objects, treeOid);
      if (path === '') {
        sendJson(res, 200, dirListing(repo, owner, repoName, '', flat), scopes);
        return;
      }
      const file = flat.get(path);
      if (file !== undefined) {
        const obj = repo.objects.get(file.oid);
        const data = obj !== undefined && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(),
          path, content: b64encode(data), sha: file.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${refParam}/${path}`,
          download_url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
        }, scopes);
        return;
      }
      // Directory?
      const prefix = `${path}/`;
      let isDir = false;
      for (const key of flat.keys()) {
        if (key.startsWith(prefix)) {
          isDir = true;
          break;
        }
      }
      if (isDir) {
        sendJson(res, 200, dirListing(repo, owner, repoName, path, flat), scopes);
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
      const contentB64 = typeof input.content === 'string' ? input.content : '';
      if (contentB64 === '') {
        sendError(res, 422, 'content is required');
        return;
      }
      const branch = branchForWrite(input);
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName) ?? (branch === repo.defaultBranch ? undefined : repo.refs.get(`refs/heads/${repo.defaultBranch}`));
      let currentBlob: string | undefined;
      if (tip !== undefined) {
        const flat = flattenTree(repo.objects, parseCommit((repo.objects.get(tip) as GitObject).data).tree);
        currentBlob = flat.get(path)?.oid;
      }
      const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
      const isUpdate = currentBlob !== undefined;
      if (isUpdate && givenSha !== undefined && givenSha !== currentBlob) {
        sendError(res, 409, 'sha does not match');
        return;
      }
      if (isUpdate && givenSha === undefined) {
        sendError(res, 409, 'sha is required to update a file');
        return;
      }
      if (!isUpdate && givenSha !== undefined) {
        sendError(res, 409, 'sha does not match');
        return;
      }
      const content = b64decode(contentB64);
      const commitOid = commitFile(repo, branch, path, content, message);
      const blobOid = gitObjectId('blob', content);
      sendJson(res, isUpdate ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64 },
        commit: { sha: commitOid, message },
      }, scopes);
      return;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
      const branch = branchForWrite(input);
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const flat = flattenTree(repo.objects, parseCommit((repo.objects.get(tip) as GitObject).data).tree);
      const currentBlob = flat.get(path)?.oid;
      if (currentBlob === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
      if (givenSha !== undefined && givenSha !== currentBlob) {
        sendError(res, 409, 'sha does not match');
        return;
      }
      const commitOid = deleteFile(repo, branch, path, message);
      if (commitOid === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { content: null, commit: { sha: commitOid, message } }, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- labels ------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })), scopes);
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        sendJson(res, 201, { name: existing.name, color: existing.color, description: '' }, scopes);
        return;
      }
      const label: Label = { name, color };
      repo.labels.set(name, label);
      sendJson(res, 201, { name, color, description: '' }, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- issues ------------------------------------------------------
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') || 'open';
        const direction = url.searchParams.get('direction') || 'desc';
        const params = pageParams(url);
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { pageItems, totalPages } = paginate(list, params);
        sendJson(res, 200, pageItems.map((i) => issueJson(repo, i)), restHeaders(req, url, params, totalPages));
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') {
          sendError(res, 422, 'title is required');
          return;
        }
        const labelNames = Array.isArray(input.labels) ? input.labels.filter((x): x is string => typeof x === 'string') : [];
        const labels: Label[] = [];
        for (const name of labelNames) {
          const label = repo.labels.get(name);
          if (label === undefined) {
            sendError(res, 422, `Label does not exist: ${name}`);
            return;
          }
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
        sendJson(res, 201, issueJson(repo, issue), scopes);
        return;
      }
    }
    const num = parseInt(rest[1] || '', 10);
    if (!Number.isInteger(num)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const issue = repo.issues.get(num);
    if (rest.length === 2) {
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue), scopes);
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = isRecord(parsed.value) ? parsed.value : {};
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? stampFor(nextSeq()) : null;
        }
        issue.updatedAt = stampFor(nextSeq());
        sendJson(res, 200, issueJson(repo, issue), scopes);
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        const params = pageParams(url);
        const all = repo.comments.get(num) || [];
        const { pageItems, totalPages } = paginate(all, params);
        sendJson(res, 200, pageItems.map((c) => commentJson(repo, c)), restHeaders(req, url, params, totalPages));
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = isRecord(parsed.value) ? parsed.value : {};
        const commentBody = typeof input.body === 'string' ? input.body : '';
        if (commentBody === '') {
          sendError(res, 422, 'body is required');
          return;
        }
        const comment = store.addComment(repo, num, commentBody);
        sendJson(res, 201, commentJson(repo, comment), scopes);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- pulls -------------------------------------------------------
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') || 'open';
        const params = pageParams(url);
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        const { pageItems, totalPages } = paginate(list, params);
        sendJson(res, 200, pageItems.map((p) => pullJson(repo, p)), restHeaders(req, url, params, totalPages));
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.head === 'string' ? input.head : '';
        const base = typeof input.base === 'string' ? input.base : '';
        if (title === '' || head === '' || base === '') {
          sendError(res, 422, 'title, head and base are required');
          return;
        }
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          sendError(res, 422, 'head or base branch does not exist');
          return;
        }
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
            sendError(res, 422, 'A pull request already exists for this head and base');
            return;
          }
        }
        const pull = store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
        sendJson(res, 201, pullJson(repo, pull), scopes);
        return;
      }
    }
    const num = parseInt(rest[1] || '', 10);
    if (!Number.isInteger(num)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const pull = repo.pulls.get(num);
    if (rest.length === 2) {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull), scopes);
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (baseTip === undefined || headTip === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const base = mergeBase(repo.objects, baseTip, headTip);
        const baseTree = base !== null ? parseCommit((repo.objects.get(base) as GitObject).data).tree : parseCommit((repo.objects.get(baseTip) as GitObject).data).tree;
        const headTree = parseCommit((repo.objects.get(headTip) as GitObject).data).tree;
        const files = diffTrees(repo.objects, baseTree, headTree).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        sendJson(res, 200, files, scopes);
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        if (pull.state !== 'open') {
          sendError(res, 405, 'Pull request is already closed');
          return;
        }
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (baseTip === undefined || headTip === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const { treeOid, conflicts } = threeWayMerge(repo, baseTip, headTip);
        if (treeOid === null) {
          sendError(res, 405, `Merge conflict: ${conflicts.join(', ')}`);
          return;
        }
        const message = `Merge pull request #${pull.number} from ${owner}/${pull.headRef}\n\n${pull.title}`;
        const mergeSha = storeCommit(repo, treeOid, [baseTip], message);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        const seq = nextSeq();
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = stampFor(seq);
        pull.mergeCommitSha = mergeSha;
        pull.closedAt = stampFor(seq);
        pull.updatedAt = stampFor(seq);
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' }, scopes);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** One directory's listing for GET contents, from a flat tree map. */
function dirListing(repo: Repo, owner: string, repoName: string, dir: string, flat: Map<string, { mode: string; oid: string }>): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [path, e] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', name: rest, path, sha: e.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // Rebuild this subdirectory's tree from the flat map; the content
        // is identical to the stored tree, so the oid matches.
        const sub = new Map<string, { mode: string; oid: string }>();
        const subPrefix = `${prefix}${name}/`;
        for (const [p, v] of flat) {
          if (p.startsWith(subPrefix)) sub.set(p.slice(subPrefix.length), v);
        }
        const treeOid = buildTreeFromFlat(repo, sub);
        seen.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: treeOid });
      }
    }
  }
  return [...seen.values()].map((e) => ({
    type: e.type,
    name: e.name,
    path: e.path,
    sha: e.sha,
    size: 0,
    url: `/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
    html_url: `https://github.com/${owner}/${repoName}/tree/HEAD/${e.path}`,
  }));
}

// ------------------------------------------------------------------ git smart HTTP

const UPLOAD_V2_CAPS = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

/** Peel a tag (recursively) to the commit it points at. */
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

function sortedRefs(repo: Repo): { oid: string; name: string }[] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, oid]) => ({ oid, name }));
}

function advertisementV2Upload(repo: Repo): Buffer {
  const parts: Buffer[] = [pktEncode('# service=git-upload-pack\n'), PKT_FLUSH, pktEncode('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktEncode(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const serviceLine = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const parts: Buffer[] = [pktEncode(serviceLine), PKT_FLUSH];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip === undefined && repo.refs.size === 0) {
    parts.push(pktEncode(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? ZERO_OID;
    parts.push(pktEncode(`${headOid} HEAD\0${caps}\n`));
    for (const { oid, name } of sortedRefs(repo)) {
      parts.push(pktEncode(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
        parts.push(pktEncode(`${peelToCommit(repo, oid)} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  acks: string[];
  nak: boolean;
  shallow: string[];
  unshallow: string[];
  objects: PackEntry[];
}

/** Work out what a fetch sends: which commits (depth-limited), which objects
 *  (reachable minus already-held), and the shallow/unshallow boundary lists. */
function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): FetchPlan {
  const held = collectReachable(repo.objects, haves, new Set(oldShallow));
  const heldCommits = new Set<string>();
  for (const [oid, obj] of held) {
    if (obj.type === 'commit') heldCommits.add(oid);
  }
  // Peel tag wants to their commits, but keep the tag objects for the send set.
  const tagObjects: string[] = [];
  const wantCommits: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.push(w);
      wantCommits.push(peelToCommit(repo, w));
    } else if (obj.type === 'commit') {
      wantCommits.push(w);
    }
  }
  // Depth-limited commit set, by generation from the wants: only generations
  // strictly below `depth` are in scope (depth 1 = the tips only).
  const inScope = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = wantCommits.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (inScope.has(oid)) continue;
    if (depth !== null && gen >= depth) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    inScope.set(oid, gen);
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
  }
  const sendCommits = new Set<string>();
  for (const oid of inScope.keys()) {
    if (!heldCommits.has(oid)) sendCommits.add(oid);
  }
  // Shallow boundaries: send commits whose parent is outside send+held.
  const shallow: string[] = [];
  for (const oid of sendCommits) {
    const obj = repo.objects.get(oid) as GitObject;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    if (parents.some((p) => !sendCommits.has(p) && !heldCommits.has(p))) shallow.push(oid);
  }
  // Unshallow: old boundaries whose parent is now in send+held.
  const unshallow: string[] = [];
  for (const b of oldShallow) {
    const obj = repo.objects.get(b);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => sendCommits.has(p) || heldCommits.has(p))) unshallow.push(b);
  }
  // Objects: each send commit's tree closure, plus tag objects, minus held.
  const send = new Map<string, GitObject>();
  for (const oid of sendCommits) {
    const obj = repo.objects.get(oid) as GitObject;
    send.set(oid, obj);
    const treeOid = parseCommit(obj.data).tree;
    for (const [o, t] of collectReachable(repo.objects, [treeOid], new Set())) {
      send.set(o, t);
    }
  }
  for (const t of tagObjects) {
    const obj = repo.objects.get(t);
    if (obj !== undefined) send.set(t, obj);
  }
  for (const oid of held.keys()) send.delete(oid);
  const objects: PackEntry[] = [...send.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([oid, obj]) => ({ type: obj.type, data: obj.data, oid }));
  const acks = haves.filter((h) => repo.objects.has(h));
  return { acks, nak: acks.length === 0, shallow, unshallow, objects };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // pkt-line payload max 65516 minus the band byte
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktEncode(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

function v2FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktEncode('acknowledgments\n'));
  if (plan.nak) parts.push(pktEncode('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(pktEncode(`ACK ${ack}\n`));
    parts.push(pktEncode('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktEncode('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktEncode(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktEncode(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.objects.length > 0) {
    parts.push(pktEncode('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktEncode('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(pktEncode(`ACK ${ack}\n`));
  }
  for (const s of plan.shallow) parts.push(pktEncode(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktEncode(`unshallow ${s}\n`));
  if (plan.objects.length > 0) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2LsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip !== undefined) {
    if (keep('HEAD')) {
      const extra = opts.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktEncode(`${mainTip} HEAD${extra}\n`));
    }
  } else if (opts.unborn && keep('HEAD')) {
    const extra = opts.symrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pktEncode(`unborn HEAD${extra}\n`));
  }
  for (const { oid, name } of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (opts.peel && name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    parts.push(pktEncode(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, seg: string[], method: string): Promise<void> {
  const owner = seg[0] as string;
  const repoName = (seg[1] as string).replace(/\.git$/, '');
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  if (owner !== VIEWER.login) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const action = seg[2] as string | undefined;

  // ---- info/refs ---------------------------------------------------
  if (method === 'GET' && action === 'info' && seg[3] === 'refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') {
        sendBuffer(res, 200, advertisementV2Upload(repo), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBuffer(res, 200, advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // ---- upload-pack -------------------------------------------------
  if (method === 'POST' && action === 'git-upload-pack') {
    const body = await readBody(req);
    let frames: PktFrame[];
    try {
      frames = pktDecodeAll(body);
    } catch {
      sendError(res, 400, 'Malformed pkt-line stream');
      return;
    }
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (isV2) {
      const first = frames[0];
      if (first === undefined || first.kind !== 'data' || !first.data.toString('utf8').startsWith('command=')) {
        sendError(res, 400, 'Expected a v2 command');
        return;
      }
      const command = first.data.toString('utf8').trim().slice('command='.length);
      const args: string[] = [];
      let pastDelim = false;
      for (const f of frames.slice(1)) {
        if (f.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (f.kind === 'flush') break;
        if (f.kind === 'data' && pastDelim) args.push(f.data.toString('utf8').trim());
      }
      if (command === 'ls-refs') {
        const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
        for (const a of args) {
          if (a === 'peel') opts.peel = true;
          else if (a === 'symrefs') opts.symrefs = true;
          else if (a === 'unborn') opts.unborn = true;
          else if (a.startsWith('ref-prefix ')) opts.prefixes.push(a.slice('ref-prefix '.length));
        }
        sendBuffer(res, 200, v2LsRefsResponse(repo, opts), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const oldShallow: string[] = [];
        let depth: number | null = null;
        for (const a of args) {
          if (a.startsWith('want ')) wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) oldShallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) {
            const n = parseInt(a.slice(7).trim(), 10);
            if (Number.isFinite(n) && n > 0) depth = n;
          }
        }
        const plan = planFetch(repo, wants, haves, depth, oldShallow);
        sendBuffer(res, 200, v2FetchResponse(plan), 'application/x-git-upload-pack-result');
        return;
      }
      sendError(res, 400, `Unknown v2 command: ${command}`);
      return;
    }
    // v0 fetch: wants section, flush, haves section, flush.
    const sections: string[][] = [[]];
    for (const f of frames) {
      if (f.kind === 'flush') {
        sections.push([]);
        continue;
      }
      if (f.kind === 'data') (sections[sections.length - 1] as string[]).push(f.data.toString('utf8').trim());
    }
    const wants: string[] = [];
    const haves: string[] = [];
    const oldShallow: string[] = [];
    let depth: number | null = null;
    for (const line of sections[0] || []) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim().split(/\s+/);
        if (rest[0] !== undefined) wants.push(rest[0]);
      } else if (line.startsWith('shallow ')) oldShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    for (const line of sections[1] || []) {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    const plan = planFetch(repo, wants, haves, depth, oldShallow);
    sendBuffer(res, 200, v0FetchResponse(plan), 'application/x-git-upload-pack-result');
    return;
  }

  // ---- receive-pack (push) -----------------------------------------
  if (method === 'POST' && action === 'git-receive-pack') {
    const body = await readBody(req);
    // Parse pkt-lines until the first flush; everything after it is the pack.
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let off = 0;
    let packStart = body.length;
    let malformed = false;
    while (off < body.length) {
      if (off + 4 > body.length) {
        malformed = true;
        break;
      }
      const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) {
        malformed = true;
        break;
      }
      if (len === 0) {
        packStart = off + 4;
        break;
      }
      if (len < 4 || off + len > body.length) {
        malformed = true;
        break;
      }
      const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const cmd = nul >= 0 ? line.slice(0, nul) : line;
      const parts = cmd.split(' ');
      if (parts.length < 3 || !OID_RE.test(parts[0] as string) || !OID_RE.test(parts[1] as string)) {
        malformed = true;
        break;
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      off += len;
    }
    if (malformed || commands.length === 0) {
      sendError(res, 400, 'Malformed push command list');
      return;
    }
    const packBytes = body.subarray(packStart);
    let unpackError: string | null = null;
    if (packBytes.length > 0) {
      try {
        const entries = readPack(packBytes);
        for (const e of entries) repo.objects.set(e.oid, { type: e.type, data: e.data });
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
    const reportLines: string[] = [];
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}\n`);
      for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed\n`);
    } else {
      reportLines.push('unpack ok\n');
      for (const c of commands) {
        const current = repo.refs.get(c.ref);
        if (c.newOid === ZERO_OID) {
          // Delete.
          if (current !== undefined && current === c.oldOid) {
            repo.refs.delete(c.ref);
            reportLines.push(`ok ${c.ref}\n`);
          } else {
            reportLines.push(`ng ${c.ref} stale info\n`);
          }
        } else if (c.oldOid === ZERO_OID) {
          // Create.
          if (current !== undefined) {
            reportLines.push(`ng ${c.ref} already exists\n`);
          } else if (!repo.objects.has(c.newOid)) {
            reportLines.push(`ng ${c.ref} object not found\n`);
          } else {
            repo.refs.set(c.ref, c.newOid);
            reportLines.push(`ok ${c.ref}\n`);
          }
        } else {
          // Update: old must match, new must descend from old.
          if (current === undefined || current !== c.oldOid) {
            reportLines.push(`ng ${c.ref} stale info\n`);
          } else if (!repo.objects.has(c.newOid)) {
            reportLines.push(`ng ${c.ref} object not found\n`);
          } else if (isAncestor(repo.objects, c.oldOid, c.newOid)) {
            repo.refs.set(c.ref, c.newOid);
            reportLines.push(`ok ${c.ref}\n`);
          } else {
            reportLines.push(`ng ${c.ref} non-fast-forward\n`);
          }
        }
      }
    }
    const report = Buffer.concat(reportLines.map((l) => pktEncode(l)));
    const response = Buffer.concat([pktEncode(Buffer.concat([Buffer.from([1]), report])), PKT_FLUSH]);
    sendBuffer(res, 200, response, 'application/x-git-receive-pack-result');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ GraphQL
// A small hand-rolled executor for the documents gh and github-mcp-server
// send: queries, mutations, variables, aliases, inline fragments, batching
// and __type introspection. Unknown fields error with the field's name in
// the message; a nullable field that finds nothing returns null, no error.

type GqlScalar = string | number | boolean | null;
type GqlValueNode =
  | { kind: 'scalar'; value: GqlScalar }
  | { kind: 'var'; name: string }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValueNode[] }
  | { kind: 'object'; fields: Record<string, GqlValueNode> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValueNode>;
  selections: GqlSelection[] | null;
  fragmentType: string | null;
  fragmentName: string | null;
}
type GqlSelection = GqlField;

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  vars: Record<string, GqlValueNode | undefined>;
  selections: GqlSelection[];
}

interface GqlToken {
  kind: 'punct' | 'name' | 'string' | 'int' | 'float';
  value: string;
}

function gqlTokenize(src: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character in GraphQL document: ${c}`);
  }
  return tokens;
}

class GqlParser {
  tokens: GqlToken[];
  pos = 0;
  fragments = new Map<string, { type: string; selections: GqlSelection[] }>();

  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }

  peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }
  next(): GqlToken {
    const t = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return t;
  }
  expect(value: string): GqlToken {
    const t = this.next();
    if (t.value !== value) throw new Error(`Expected ${value} in GraphQL document, got ${t.value}`);
    return t;
  }
  skipDirectives(): void {
    while (this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.value === '(') this.parseArgs();
    }
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek() as GqlToken;
      if (t.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.expect('on');
        const type = this.next().value;
        const selections = this.parseSelectionSet();
        this.fragments.set(name, { type, selections });
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (t.value === 'query' || t.value === 'mutation') {
        kind = t.value;
        this.next();
        const n = this.peek();
        if (n !== undefined && n.kind === 'name') name = this.next().value;
      }
      const vars: Record<string, GqlValueNode | undefined> = {};
      if (this.peek()?.value === '(') {
        this.next();
        while (this.peek()?.value !== ')') {
          this.expect('$');
          const varName = this.next().value;
          this.expect(':');
          this.parseType();
          if (this.peek()?.value === '=') {
            this.next();
            vars[varName] = this.parseValue();
          } else {
            vars[varName] = undefined;
          }
        }
        this.expect(')');
      }
      this.skipDirectives();
      const selections = this.parseSelectionSet();
      ops.push({ kind, name, vars, selections });
    }
    return ops;
  }

  parseType(): void {
    const t = this.peek() as GqlToken;
    if (t.value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek()?.value !== '}') {
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }

  parseSelection(): GqlSelection {
    const t = this.peek() as GqlToken;
    if (t.value === '...') {
      this.next();
      const n = this.peek() as GqlToken;
      if (n.value === 'on') {
        this.next();
        const type = this.next().value;
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '', args: {}, selections, fragmentType: type, fragmentName: null };
      }
      const fragName = this.next().value;
      this.skipDirectives();
      return { alias: null, name: '', args: {}, selections: null, fragmentType: null, fragmentName: fragName };
    }
    let alias: string | null = null;
    let name = this.next().value;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args: Record<string, GqlValueNode> = {};
    if (this.peek()?.value === '(') args = this.parseArgs();
    this.skipDirectives();
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, fragmentType: null, fragmentName: null };
  }

  parseArgs(): Record<string, GqlValueNode> {
    this.expect('(');
    const args: Record<string, GqlValueNode> = {};
    while (this.peek()?.value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): GqlValueNode {
    const t = this.next();
    if (t.value === '$') return { kind: 'var', name: this.next().value };
    if (t.kind === 'string') return { kind: 'scalar', value: t.value };
    if (t.kind === 'int') return { kind: 'scalar', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'scalar', value: parseFloat(t.value) };
    if (t.value === '[') {
      const items: GqlValueNode[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.value === '{') {
      const fields: Record<string, GqlValueNode> = {};
      while (this.peek()?.value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.value === 'true') return { kind: 'scalar', value: true };
    if (t.value === 'false') return { kind: 'scalar', value: false };
    if (t.value === 'null') return { kind: 'scalar', value: null };
    return { kind: 'enum', value: t.value };
  }
}

function resolveValue(node: GqlValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'var') return variables[node.name] ?? null;
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'enum') return node.value;
  if (node.kind === 'list') return node.items.map((i) => resolveValue(i, variables));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
  return out;
}

function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveValue(v, variables);
  return out;
}

// Typed values the executor walks: { __typename, ...payload }.
type TypedValue = { __typename: string; [key: string]: unknown };

class GqlAbort extends Error {}

interface GqlCtx {
  variables: Record<string, unknown>;
  errors: { message: string }[];
  parser: GqlParser;
}

const GQL_TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'url'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(seq: number): string {
  return b64urlEncode(`cursor:${seq}`);
}
function seqFromCursor(cursor: string): number | null {
  try {
    const text = b64decode(cursor).toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function connectionResult<T extends { seq: number }>(items: T[], args: Record<string, unknown>, direction: 'ASC' | 'DESC' = 'DESC'): TypedValue {
  const first = typeof args.first === 'number' ? args.first : 100;
  const afterSeq = typeof args.after === 'string' ? seqFromCursor(args.after) : null;
  let filtered = items;
  if (afterSeq !== null) filtered = items.filter((i) => (direction === 'ASC' ? i.seq > afterSeq : i.seq < afterSeq));
  const page = filtered.slice(0, first);
  const hasNext = filtered.length > first;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as T).seq) : null;
  return {
    __typename: 'Connection',
    __items: page,
    __hasNext: hasNext,
    __endCursor: endCursor,
  };
}

type Resolver = (parent: TypedValue, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

const GQL_RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    repository: (_p, args) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER.login) return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : { __typename: 'Repository', repo };
    },
    node: (_p, args) => {
      const parsed = parseGlobalId(String(args.id || ''));
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const dbId = parseInt(parsed.parts[0] as string, 10);
        for (const repo of store.repos.values()) {
          if (repo.dbId === dbId) return { __typename: 'Repository', repo };
        }
        return null;
      }
      if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
        const repoDb = parseInt(parsed.parts[0] as string, 10);
        const number = parseInt(parsed.parts[1] as string, 10);
        for (const repo of store.repos.values()) {
          if (repo.dbId !== repoDb) continue;
          if (parsed.kind === 'Issue') {
            const issue = repo.issues.get(number);
            return issue === undefined ? null : { __typename: 'Issue', repo, issue };
          }
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        }
        return null;
      }
      return null;
    },
    __type: (_p, args) => {
      const info = GQL_TYPE_INFO[String(args.name || '')];
      if (info === undefined) return null;
      return { __typename: '__Type', name: String(args.name), kind: info.kind, info };
    },
  },
  User: {
    login: (p) => p.login as string,
    id: (p) => p.id as number,
    name: (p) => p.name as string,
    email: (p) => p.email as string,
  },
  Repository: {
    id: (p) => globalId('Repository', (p.repo as Repo).dbId),
    databaseId: (p) => (p.repo as Repo).dbId,
    name: (p) => (p.repo as Repo).name,
    nameWithOwner: (p) => `${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
    owner: () => ({ __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    description: (p) => (p.repo as Repo).description,
    private: (p) => (p.repo as Repo).isPrivate,
    defaultBranchRef: (p) => {
      const repo = p.repo as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : { __typename: 'BranchRef', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (p, args) => {
      const repo = p.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : { __typename: 'Issue', repo, issue };
    },
    issues: (p, args) => {
      const repo = p.repo as Repo;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      if (states.length > 0) list = list.filter((i) => states.includes(issueStateGql(i.state)));
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
      list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const conn = connectionResult(list, args, direction);
      return { __typename: 'IssueConnection', __items: (conn.__items as Issue[]).map((i) => ({ __typename: 'Issue', repo, issue: i })), __hasNext: conn.__hasNext, __endCursor: conn.__endCursor };
    },
    pullRequests: (p, args) => {
      const repo = p.repo as Repo;
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      if (states.length > 0) list = list.filter((x) => states.includes(pullStateGql(x)));
      list.sort((a, b) => b.seq - a.seq);
      const conn = connectionResult(list, args);
      return { __typename: 'PullRequestConnection', __items: (conn.__items as Pull[]).map((x) => ({ __typename: 'PullRequest', repo, pull: x })), __hasNext: conn.__hasNext, __endCursor: conn.__endCursor };
    },
    pullRequest: (p, args) => {
      const repo = p.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
    },
    createdAt: (p) => stampFor((p.repo as Repo).createdSeq),
    updatedAt: (p) => stampFor((p.repo as Repo).updatedSeq),
    url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}`,
  },
  BranchRef: {
    name: (p) => p.name as string,
  },
  Issue: {
    id: (p) => globalId('Issue', (p.repo as Repo).dbId, (p.issue as Issue).number),
    number: (p) => (p.issue as Issue).number,
    title: (p) => (p.issue as Issue).title,
    state: (p) => issueStateGql((p.issue as Issue).state),
    body: (p) => (p.issue as Issue).body,
    createdAt: (p) => (p.issue as Issue).createdAt,
    updatedAt: (p) => (p.issue as Issue).updatedAt,
    closedAt: (p) => (p.issue as Issue).closedAt,
    author: (p) => {
      const login = (p.issue as Issue).authorLogin;
      const user = SCENARIO_USERS.find((u) => u.login === login) || VIEWER;
      return { __typename: 'User', login: user.login, id: user.id, name: user.name, email: user.email };
    },
    labels: (p) => (p.issue as Issue).labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })),
    comments: (p, args) => {
      const repo = p.repo as Repo;
      const issue = p.issue as Issue;
      const all = repo.comments.get(issue.number) || [];
      const conn = connectionResult(all, args);
      return { __typename: 'IssueCommentConnection', __items: (conn.__items as IssueComment[]).map((c) => ({ __typename: 'IssueComment', repo, comment: c })), __hasNext: conn.__hasNext, __endCursor: conn.__endCursor };
    },
    url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/issues/${(p.issue as Issue).number}`,
    repository: (p) => ({ __typename: 'Repository', repo: p.repo as Repo }),
  },
  Label: {
    name: (p) => p.name as string,
    color: (p) => p.color as string,
  },
  IssueConnection: {
    nodes: (p) => p.__items as unknown[],
    totalCount: (p) => (p.__items as unknown[]).length,
    pageInfo: (p) => ({ __typename: 'PageInfo', hasNextPage: p.__hasNext as boolean, hasPreviousPage: false, endCursor: p.__endCursor as string | null, startCursor: null }),
  },
  PullRequestConnection: {
    nodes: (p) => p.__items as unknown[],
    totalCount: (p) => (p.__items as unknown[]).length,
    pageInfo: (p) => ({ __typename: 'PageInfo', hasNextPage: p.__hasNext as boolean, hasPreviousPage: false, endCursor: p.__endCursor as string | null, startCursor: null }),
  },
  IssueCommentConnection: {
    nodes: (p) => p.__items as unknown[],
    totalCount: (p) => (p.__items as unknown[]).length,
    pageInfo: (p) => ({ __typename: 'PageInfo', hasNextPage: p.__hasNext as boolean, hasPreviousPage: false, endCursor: p.__endCursor as string | null, startCursor: null }),
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage as boolean,
    hasPreviousPage: (p) => p.hasPreviousPage as boolean,
    endCursor: (p) => p.endCursor as string | null,
    startCursor: (p) => p.startCursor as string | null,
  },
  PullRequest: {
    id: (p) => globalId('PullRequest', (p.repo as Repo).dbId, (p.pull as Pull).number),
    number: (p) => (p.pull as Pull).number,
    title: (p) => (p.pull as Pull).title,
    body: (p) => (p.pull as Pull).body,
    state: (p) => pullStateGql(p.pull as Pull),
    merged: (p) => (p.pull as Pull).merged,
    mergedAt: (p) => (p.pull as Pull).mergedAt,
    headRefName: (p) => (p.pull as Pull).headRef,
    baseRefName: (p) => (p.pull as Pull).baseRef,
    mergeable: (p) => mergeableState(p.repo as Repo, p.pull as Pull),
    files: (p, args) => {
      const repo = p.repo as Repo;
      const pull = p.pull as Pull;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (baseTip === undefined || headTip === undefined) return { __typename: 'PullRequestChangedFileConnection', __items: [], __hasNext: false, __endCursor: null };
      const base = mergeBase(repo.objects, baseTip, headTip);
      const baseTree = base !== null ? parseCommit((repo.objects.get(base) as GitObject).data).tree : parseCommit((repo.objects.get(baseTip) as GitObject).data).tree;
      const headTree = parseCommit((repo.objects.get(headTip) as GitObject).data).tree;
      const files = diffTrees(repo.objects, baseTree, headTree).map((f, i) => ({ __typename: 'PullRequestChangedFile', path: f.filename, filename: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes, seq: i }));
      const first = typeof args.first === 'number' ? args.first : 100;
      const page = files.slice(0, first);
      return { __typename: 'PullRequestChangedFileConnection', __items: page, __hasNext: files.length > first, __endCursor: null };
    },
    createdAt: (p) => (p.pull as Pull).createdAt,
    updatedAt: (p) => (p.pull as Pull).updatedAt,
    author: (p) => {
      const login = (p.pull as Pull).authorLogin;
      const user = SCENARIO_USERS.find((u) => u.login === login) || VIEWER;
      return { __typename: 'User', login: user.login, id: user.id, name: user.name, email: user.email };
    },
    url: (p) => `https://github.com/${(p.repo as Repo).owner}/${(p.repo as Repo).name}/pull/${(p.pull as Pull).number}`,
  },
  PullRequestChangedFile: {
    path: (p) => p.path as string,
    filename: (p) => p.filename as string,
    additions: (p) => p.additions as number,
    deletions: (p) => p.deletions as number,
    changes: (p) => p.changes as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (p) => p.__items as unknown[],
    totalCount: (p) => (p.__items as unknown[]).length,
    pageInfo: (p) => ({ __typename: 'PageInfo', hasNextPage: p.__hasNext as boolean, hasPreviousPage: false, endCursor: null, startCursor: null }),
  },
  IssueComment: {
    id: (p) => globalId('IssueComment', (p.repo as Repo).dbId, (p.comment as IssueComment).id),
    body: (p) => (p.comment as IssueComment).body,
    createdAt: (p) => (p.comment as IssueComment).createdAt,
    author: (p) => {
      const login = (p.comment as IssueComment).authorLogin;
      const user = SCENARIO_USERS.find((u) => u.login === login) || VIEWER;
      return { __typename: 'User', login: user.login, id: user.id, name: user.name, email: user.email };
    },
  },
  __Type: {
    name: (p) => p.name as string,
    kind: (p) => (p.info as { kind: string }).kind,
    description: () => '',
    fields: (p) => {
      const info = p.info as { kind: string; fields: string[] };
      if (info.kind === 'ENUM') return null;
      return info.fields.map((f) => ({ __typename: '__Field', name: f }));
    },
    enumValues: (p) => {
      const info = p.info as { kind: string; enumValues?: string[] };
      if (info.kind !== 'ENUM') return null;
      return (info.enumValues || []).map((v) => ({ __typename: '__EnumValue', name: v }));
    },
  },
  __Field: {
    name: (p) => p.name as string,
    description: () => '',
    type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR', info: { kind: 'SCALAR', fields: [] } }),
    args: () => [],
  },
  __EnumValue: {
    name: (p) => p.name as string,
    description: () => '',
  },
  Mutation: {
    createIssue: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.repositoryId || ''));
      if (parsed === null || parsed.kind !== 'Repository') throw new GqlAbort('createIssue: unknown repositoryId');
      const dbId = parseInt(parsed.parts[0] as string, 10);
      let repo: Repo | undefined;
      for (const r of store.repos.values()) if (r.dbId === dbId) repo = r;
      if (repo === undefined) throw new GqlAbort('createIssue: repository not found');
      const issue = store.createIssue(repo, String(input.title || ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
    },
    closeIssue: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.issueId || ''));
      if (parsed === null || parsed.kind !== 'Issue') throw new GqlAbort('closeIssue: unknown issueId');
      const repoDb = parseInt(parsed.parts[0] as string, 10);
      const number = parseInt(parsed.parts[1] as string, 10);
      for (const repo of store.repos.values()) {
        if (repo.dbId !== repoDb) continue;
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new GqlAbort('closeIssue: issue not found');
        issue.state = 'closed';
        issue.closedAt = stampFor(nextSeq());
        issue.updatedAt = stampFor(nextSeq());
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } };
      }
      throw new GqlAbort('closeIssue: issue not found');
    },
    createPullRequest: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.repositoryId || ''));
      if (parsed === null || parsed.kind !== 'Repository') throw new GqlAbort('createPullRequest: unknown repositoryId');
      const dbId = parseInt(parsed.parts[0] as string, 10);
      let repo: Repo | undefined;
      for (const r of store.repos.values()) if (r.dbId === dbId) repo = r;
      if (repo === undefined) throw new GqlAbort('createPullRequest: repository not found');
      const head = String(input.headRefName || '');
      const base = String(input.baseRefName || '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new GqlAbort('createPullRequest: head or base branch does not exist');
      for (const x of repo.pulls.values()) {
        if (x.state === 'open' && x.headRef === head && x.baseRef === base) throw new GqlAbort('createPullRequest: a pull request already exists for this head and base');
      }
      const pull = store.createPull(repo, String(input.title || ''), typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
    },
    mergePullRequest: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.pullRequestId || ''));
      if (parsed === null || parsed.kind !== 'PullRequest') throw new GqlAbort('mergePullRequest: unknown pullRequestId');
      const repoDb = parseInt(parsed.parts[0] as string, 10);
      const number = parseInt(parsed.parts[1] as string, 10);
      for (const repo of store.repos.values()) {
        if (repo.dbId !== repoDb) continue;
        const pull = repo.pulls.get(number);
        if (pull === undefined) throw new GqlAbort('mergePullRequest: pull request not found');
        if (pull.state !== 'open') throw new GqlAbort('mergePullRequest: pull request is not open');
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (baseTip === undefined || headTip === undefined) throw new GqlAbort('mergePullRequest: branch not found');
        const { treeOid, conflicts } = threeWayMerge(repo, baseTip, headTip);
        if (treeOid === null) throw new GqlAbort(`mergePullRequest: merge conflict: ${conflicts.join(', ')}`);
        const mergeSha = storeCommit(repo, treeOid, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        const seq = nextSeq();
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = stampFor(seq);
        pull.mergeCommitSha = mergeSha;
        pull.closedAt = stampFor(seq);
        pull.updatedAt = stampFor(seq);
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
      }
      throw new GqlAbort('mergePullRequest: pull request not found');
    },
    addComment: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.subjectId || ''));
      if (parsed === null || parsed.kind !== 'Issue') throw new GqlAbort('addComment: unknown subjectId');
      const repoDb = parseInt(parsed.parts[0] as string, 10);
      const number = parseInt(parsed.parts[1] as string, 10);
      for (const repo of store.repos.values()) {
        if (repo.dbId !== repoDb) continue;
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new GqlAbort('addComment: issue not found');
        const comment = store.addComment(repo, number, String(input.body || ''));
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'AddCommentEdge', node: { __typename: 'IssueComment', repo, comment } } };
      }
      throw new GqlAbort('addComment: issue not found');
    },
  },
  CreateIssuePayload: {
    issue: (p) => p.issue as TypedValue,
  },
  CloseIssuePayload: {
    issue: (p) => p.issue as TypedValue,
  },
  CreatePullRequestPayload: {
    pullRequest: (p) => p.pullRequest as TypedValue,
  },
  MergePullRequestPayload: {
    pullRequest: (p) => p.pullRequest as TypedValue,
  },
  AddCommentPayload: {
    commentEdge: (p) => p.commentEdge as TypedValue,
  },
  AddCommentEdge: {
    node: (p) => p.node as TypedValue,
  },
};

function gqlResolveSelections(selections: GqlSelection[], parent: TypedValue, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentName !== null) {
      const frag = ctx.parser.fragments.get(sel.fragmentName);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment ${sel.fragmentName}` });
        throw new GqlAbort(`Unknown fragment ${sel.fragmentName}`);
      }
      if (frag.type !== parent.__typename) continue;
      Object.assign(out, gqlResolveSelections(frag.selections, parent, ctx));
      continue;
    }
    if (sel.fragmentType !== null) {
      if (sel.fragmentType !== parent.__typename) continue;
      if (sel.selections !== null) Object.assign(out, gqlResolveSelections(sel.selections, parent, ctx));
      continue;
    }
    const typeTable = GQL_RESOLVERS[parent.__typename];
    const resolver = typeTable?.[sel.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${parent.__typename}'` });
      throw new GqlAbort(`Field '${sel.name}' doesn't exist on type '${parent.__typename}'`);
    }
    const args = resolveArgs(sel, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      if (err instanceof GqlAbort) throw err;
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      throw new GqlAbort('resolver error');
    }
    const key = sel.alias ?? sel.name;
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (sel.selections !== null && sel.selections.length > 0) {
      if (Array.isArray(value)) {
        out[key] = value.map((v) => (isRecord(v) && typeof v.__typename === 'string' ? gqlResolveSelections(sel.selections as GqlSelection[], v as TypedValue, ctx) : v));
      } else if (isRecord(value) && typeof value.__typename === 'string') {
        out[key] = gqlResolveSelections(sel.selections, value as TypedValue, ctx);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function gqlExecuteOne(body: unknown): Record<string, unknown> {
  const errors: { message: string }[] = [];
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL query is required' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let parser: GqlParser;
  let operations: GqlOperation[];
  try {
    parser = new GqlParser(body.query);
    operations = parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let op: GqlOperation | undefined = operations[0];
  if (typeof body.operationName === 'string') {
    op = operations.find((o) => o.name === body.operationName);
    if (op === undefined) return { data: null, errors: [{ message: `Unknown operation ${body.operationName}` }] };
  }
  if (op === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(op.vars)) {
    if (vars[name] === undefined && def !== undefined) vars[name] = resolveValue(def, vars);
  }
  const ctx: GqlCtx = { variables: vars, errors, parser };
  const root: TypedValue = { __typename: op.kind === 'mutation' ? 'Mutation' : 'Query' };
  try {
    const data = gqlResolveSelections(op.selections, root, ctx);
    return { data, errors: errors.length > 0 ? errors : undefined };
  } catch (err) {
    if (err instanceof GqlAbort) {
      return { data: null, errors: errors.length > 0 ? errors : [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') {
    sendError(res, 405, 'Method not allowed');
    return;
  }
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: parsed.message }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map((item) => gqlExecuteOne(item)));
    return;
  }
  sendJson(res, 200, gqlExecuteOne(parsed.value));
}

// ------------------------------------------------------------------ MCP

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const MCP_KNOWN_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function mcpToolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}
function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  if (name === 'create_repo') {
    const repoName = str('name');
    if (repoName === '') return mcpToolError('name is required');
    if (store.getRepo(VIEWER.login, repoName) !== undefined) return mcpToolError('Repository already exists');
    const repo = store.createRepo(repoName, str('description'), args.private === true);
    return mcpToolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const owner = str('owner');
    const repoName = str('repo');
    if (owner !== VIEWER.login) return mcpToolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return mcpToolError('Not Found');
    return mcpToolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const owner = str('owner');
    const repoName = str('repo');
    const title = str('title');
    if (owner !== VIEWER.login) return mcpToolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return mcpToolError('Not Found');
    if (title === '') return mcpToolError('title is required');
    const issue = store.createIssue(repo, title, str('body'), []);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const owner = str('owner');
    const repoName = str('repo');
    if (owner !== VIEWER.login) return mcpToolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return mcpToolError('Not Found');
    const state = str('state') || 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return mcpToolResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (name === 'create_pull_request') {
    const owner = str('owner');
    const repoName = str('repo');
    const title = str('title');
    const head = str('head');
    const base = str('base');
    if (owner !== VIEWER.login) return mcpToolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return mcpToolError('Not Found');
    if (title === '' || head === '' || base === '') return mcpToolError('title, head and base are required');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return mcpToolError('head or base branch does not exist');
    for (const p of repo.pulls.values()) {
      if (p.state === 'open' && p.headRef === head && p.baseRef === base) return mcpToolError('A pull request already exists for this head and base');
    }
    const pull = store.createPull(repo, title, str('body'), head, base, headSha, baseSha);
    return mcpToolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const owner = str('owner');
    const repoName = str('repo');
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number || ''), 10);
    if (owner !== VIEWER.login) return mcpToolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return mcpToolError('Not Found');
    const pull = repo.pulls.get(num);
    if (pull === undefined) return mcpToolError('Not Found');
    if (pull.state !== 'open') return mcpToolError('Pull request is already closed');
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return mcpToolError('Not Found');
    const { treeOid, conflicts } = threeWayMerge(repo, baseTip, headTip);
    if (treeOid === null) return mcpToolError(`Merge conflict: ${conflicts.join(', ')}`);
    const mergeSha = storeCommit(repo, treeOid, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    const seq = nextSeq();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stampFor(seq);
    pull.mergeCommitSha = mergeSha;
    pull.closedAt = stampFor(seq);
    pull.updatedAt = stampFor(seq);
    return mcpToolResult({ number: pull.number, merged: true, state: 'closed', sha: mergeSha });
  }
  return mcpToolError(`Unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendError(res, 405, 'Method not allowed');
    return;
  }
  if (!isAuthed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed.value;
  if (!isRecord(msg) || typeof msg.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(msg) ? (msg.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = 'id' in msg ? msg.id : undefined;
  const isNotification = id === undefined;
  const params = isRecord(msg.params) ? msg.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const offeredVersion = typeof meta.protocolVersion === 'string' ? meta.protocolVersion : null;
  const error = (code: number, message: string, data?: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: data !== undefined ? { code, message, data } : { code, message },
  });
  const result = (value: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result: value });

  // A version the server does not speak is a -32022 with the supported list.
  if (offeredVersion !== null && !MCP_KNOWN_VERSIONS.includes(offeredVersion)) {
    sendJson(res, 200, error(-32022, `Unsupported protocol version: ${offeredVersion}`, { supported: MCP_SUPPORTED_VERSIONS }));
    return;
  }
  const methodName = msg.method as string;

  if (methodName === 'notifications/initialized' || methodName.startsWith('notifications/')) {
    res.writeHead(202, { 'X-GitHub-Request-Id': nextRequestId() });
    res.end();
    return;
  }
  if (methodName === 'server/discover') {
    sendJson(res, 200, result({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    }));
    return;
  }
  if (methodName === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendJson(res, 200, result({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    }));
    return;
  }
  if (methodName === 'ping') {
    sendJson(res, 200, result({}));
    return;
  }
  if (methodName === 'tools/list') {
    sendJson(res, 200, result({ tools: MCP_TOOLS }));
    return;
  }
  if (methodName === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (tool === undefined) {
      sendJson(res, 200, error(-32602, `Unknown tool: ${toolName}`));
      return;
    }
    if (!isRecord(params.arguments)) {
      sendJson(res, 200, error(-32602, 'arguments must be an object'));
      return;
    }
    const schema = tool.inputSchema as { required?: string[] };
    const required = schema.required || [];
    for (const key of required) {
      const v = (params.arguments as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === '') {
        sendJson(res, 200, error(-32602, `Missing required argument: ${key}`));
        return;
      }
    }
    const toolResult = mcpCallTool(toolName, params.arguments as Record<string, unknown>);
    sendJson(res, 200, result(toolResult));
    return;
  }
  void isNotification;
  sendJson(res, 200, error(-32601, `Method not found: ${methodName}`));
}

// ------------------------------------------------------------------ lifecycle

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on 127.0.0.1:${port} as ${VIEWER.login}`);

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    // Dev mode: no env to register with; serve until killed.
    return;
  }
  // Register once; the first register wins and later ones get 409.
  let registered = false;
  for (let attempt = 0; attempt < 60 && !registered; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok || res.status === 409) registered = true;
      else await sleep(500);
    } catch {
      await sleep(500);
    }
  }
  // Poll /done until the suite is over; the env answers at once, never
  // holding a request, so poll on a short interval and exit 0 when done.
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { done?: unknown };
      if (body.done === true) break;
    } catch {
      // Transient env hiccup: keep polling.
    }
    await sleep(500);
  }
  server.close();
  process.exit(0);
}

void main();

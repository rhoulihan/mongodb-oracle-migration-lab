// Shared pieces of the D4 stand-in replicator (a stand-in for Oracle
// GoldenGate, labeled as one on every log line): the label, the state files,
// the exact-type read options, and the type mapping between the two sides.
//
// State lives in LAB_STATE_DIR/d4: /state/d4 in the replicator and runner
// containers (the named volume `state`), .lab/state/d4 on the host.
//   fwd.token        forward resume token (or, before the first change, the
//                    operation time the initial load started at)
//   rev.seq          reverse: the mig_changelog seq applied up to
//   fwd.status.json  / rev.status.json: what `./lab.sh repl status` and the
//                    console show (applied, lagMs, state), rewritten every 250 ms
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSON, BSONRegExp, Decimal128, Int32, Long, ObjectId, Timestamp } from 'mongodb';

const { EJSON } = BSON;

export const LABEL = '[stand-in for Oracle GoldenGate]';

/** One labeled log line. */
export function log(msg, out = (l) => console.log(l)) {
  out(`${LABEL} ${msg}`);
}

/** Exact-type reads (Ruling K): Int32, Int64, Double and regex stay wrapped. */
export const READ = { promoteValues: false, promoteLongs: false, bsonRegExp: true };

export const stateDir = () => join(
  process.env.LAB_STATE_DIR ||
    (process.env.LAB_IN_CONTAINER === '1' ? '/state' : fileURLToPath(new URL('../.lab/state', import.meta.url))),
  'd4');
export const statePath = (name) => join(stateDir(), name);

/** Write a state file atomically (temp file, then rename), as canonical EJSON. */
export function saveState(name, value) {
  mkdirSync(stateDir(), { recursive: true });
  const file = statePath(name);
  writeFileSync(`${file}.tmp`, EJSON.stringify(value, { relaxed: false }));
  renameSync(`${file}.tmp`, file);
}

/** A state file's value, or null when it is missing or unreadable. */
export function loadState(name) {
  try {
    return EJSON.parse(readFileSync(statePath(name), 'utf8'), { relaxed: false });
  } catch {
    return null;
  }
}

export const clearState = () => rmSync(stateDir(), { recursive: true, force: true });

/** The status file of one direction ('fwd' or 'rev'), with plain numbers. */
export function readStatus(dir) {
  const s = loadState(`${dir}.status.json`);
  if (!s) return null;
  const num = (v) => (v === null || v === undefined ? v : Number(v));
  return { ...s, applied: num(s.applied), lagMs: num(s.lagMs), idleSince: num(s.idleSince), updatedAt: num(s.updatedAt), pid: num(s.pid) };
}

export const STALE_MS = 3000;

/** True while a replicator process keeps its status file fresh. */
export const isLive = (s, now = Date.now()) => Boolean(s && s.state === 'running' && now - s.updatedAt <= STALE_MS);

/**
 * Caught up past `since` (the last write, ms epoch): the replicator is live,
 * idle (lag 0), and its last idle check ran at least 750 ms after both the
 * write and the start of the idle spell, so the write had time to be seen.
 */
export function caughtUp(s, since, now = Date.now()) {
  if (!isLive(s, now) || s.lagMs !== 0 || s.idleSince === null || s.idleSince === undefined) return false;
  return s.updatedAt - Math.max(s.idleSince, since) >= 750;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (v.constructor === Object || !v.constructor);
const keysAre = (v, ...k) => Object.keys(v).length === k.length && k.every((x) => x in v);

function walk(v, leaf) {
  const out = leaf(v);
  if (out !== undefined) return out;
  if (Array.isArray(v)) return v.map((x) => walk(x, leaf));
  if (isPlain(v)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = walk(v[k], leaf);
    return o;
  }
  return v;
}

/**
 * Oracle API reads hand back a BSON Timestamp and a regex as tagged
 * sub-documents ({$timestamp:{t,i}}, {$regularExpression:{pattern,options}};
 * see D3's $type differential). Writing those back to MongoDB as-is would
 * store sub-documents, so the reverse direction turns them into the BSON
 * types again. Nothing else changes.
 */
export function restoreTypes(doc) {
  return walk(doc, (v) => {
    if (!isPlain(v)) return undefined;
    if (keysAre(v, '$timestamp') && isPlain(v.$timestamp) && keysAre(v.$timestamp, 't', 'i')) {
      return new Timestamp({ t: Number(v.$timestamp.t), i: Number(v.$timestamp.i) });
    }
    if (keysAre(v, '$regularExpression') && isPlain(v.$regularExpression) &&
        keysAre(v.$regularExpression, 'pattern', 'options')) {
      return new BSONRegExp(String(v.$regularExpression.pattern), String(v.$regularExpression.options));
    }
    return undefined;
  });
}

/** "19.00" -> "19", "20.10" -> "20.1": the scale the Oracle API stores (Ruling K). */
const decimalAsStored = (d) => {
  const s = d.toString();
  if (!/^-?\d+\.\d+$/.test(s)) return d;
  return Decimal128.fromString(s.replace(/0+$/, '').replace(/\.$/, ''));
};

/**
 * A document in the form the Oracle API for MongoDB stores it: Decimal128
 * without trailing zeros after the point, and Timestamp/regex as their BSON
 * types (restoreTypes). Both sides are hashed in this form, so the two known
 * mappings fold away and any other difference (a lost, duplicated or changed
 * write, or another type change) still changes the hash.
 */
export function asStored(doc) {
  return walk(restoreTypes(doc), (v) => (v instanceof Decimal128 ? decimalAsStored(v) : undefined));
}

/**
 * A document _id as mig_changelog records it (JSON_SERIALIZE ... EXTENDED of
 * the _id, Oracle's extended JSON) turned back into the BSON value the Oracle
 * API uses: {"$rawid":"<24 hex>"} is an ObjectId, {"$numberInt"} an Int32,
 * {"$numberLong"} an Int64, strings stay strings, sub-documents recurse.
 */
export function idFromOracle(text) {
  const map = (v) => {
    if (typeof v === 'string') return v;
    if (isPlain(v)) {
      if (keysAre(v, '$rawid') && /^[0-9a-f]{24}$/i.test(v.$rawid)) return new ObjectId(v.$rawid);
      if (keysAre(v, '$numberInt')) return new Int32(Number(v.$numberInt));
      if (keysAre(v, '$numberLong')) return Long.fromString(String(v.$numberLong));
      if (Object.keys(v).some((k) => k.startsWith('$'))) throw new Error(`cannot map _id ${text} to a BSON value`);
      const o = {};
      for (const k of Object.keys(v)) o[k] = map(v[k]);
      return o;
    }
    throw new Error(`cannot map _id ${text} to a BSON value`);
  };
  return map(JSON.parse(text));
}

/** True for errors that mean "the client or connection was closed under us". */
export const isClosedError = (err) =>
  /MongoTopologyClosedError|MongoClientClosedError|MongoNotConnectedError/.test(err?.name ?? '') ||
  /client (was|is) closed|Topology is closed|must be connected|NJS-003|NJS-500|connection was closed/i.test(err?.message ?? '');

/**
 * The status heartbeat of one direction. Rewrites the status file every
 * 250 ms (and on demand); the timer never keeps the process alive.
 */
export function statusWriter(dir, get) {
  const write = () => {
    try { saveState(`${dir}.status.json`, { direction: dir, pid: process.pid, ...get(), updatedAt: Date.now() }); } catch { /* best effort */ }
  };
  const timer = setInterval(write, 250);
  timer.unref();
  write();
  return { write, stop: () => { clearInterval(timer); write(); } };
}

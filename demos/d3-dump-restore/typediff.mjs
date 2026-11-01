// The $type differential: which fields come back from Oracle with a different
// BSON type than they had on MongoDB, which `$type` queries then stop working,
// and which values changed while keeping their type (Ruling K).
//
// The census walks documents on the client, with the same code on both sides
// (the Oracle API for MongoDB does not support every aggregation operator a
// server-side `$objectToArray` walk would need). Documents are read with
// promoteValues:false, so Int32, Int64, Double and Decimal128 keep their
// wrapper classes and the BSON type of every value is visible.
//
// Measured on 26ai Free after mongorestore: BSON regular expressions and
// Timestamps read back as embedded documents shaped like Extended JSON
// ({$regularExpression: ...}, {$timestamp: ...}), so they look identical when
// printed but are type "object", and `{$type: 'regex'}` or
// `{$type: 'timestamp'}` is rejected outright (Ruling P). Decimal128 keeps its
// type, with the scale normalized ("93.00" reads back as "93").
import { Long } from 'mongodb';

export const READ_OPTS = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true };

const BSONTYPE = {
  Double: 'double', Int32: 'int', Long: 'long', Decimal128: 'decimal', ObjectId: 'objectId',
  Timestamp: 'timestamp', BSONRegExp: 'regex', Binary: 'binData', Code: 'javascript',
  MinKey: 'minKey', MaxKey: 'maxKey', BSONSymbol: 'symbol', DBRef: 'dbPointer',
};

/** The `$type` alias of one deserialized value. */
export function bsonType(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (v instanceof Date) return 'date';
  if (v instanceof RegExp) return 'regex';
  if (Array.isArray(v)) return 'array';
  if (v._bsontype) return BSONTYPE[v._bsontype] ?? v._bsontype;
  return 'object';
}

/**
 * Call add(path, type, value) for every value in doc. Array elements share
 * their array's path (as `$type` and dotted paths see them). An object whose
 * keys start with "$" (an Extended-JSON-shaped wrapper) is reported as an
 * object and not walked into, so both sides keep the same path set.
 */
export function walk(doc, add, prefix = '') {
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k;
    visit(path, v, add);
  }
}

function visit(path, v, add) {
  const t = bsonType(v);
  add(path, t, v);
  if (t === 'array') {
    for (const e of v) if (!Array.isArray(e)) visit(path, e, add);
  } else if (t === 'object' && !Object.keys(v).some((k) => k.startsWith('$'))) {
    walk(v, add, path);
  }
}

function census(docs) {
  const m = new Map();
  for (const d of docs) {
    walk(d, (path, t) => {
      if (!m.has(path)) m.set(path, new Set());
      m.get(path).add(t);
    });
  }
  return m;
}

/** Every value at `path` in doc, in document order (array elements expanded). */
function valuesAt(doc, path) {
  const out = [];
  walk(doc, (p, _t, v) => { if (p === path && !Array.isArray(v)) out.push(v); });
  return out;
}

/**
 * Types seen per path over the first `sample` documents by _id (or the
 * documents with the given ids).
 * @param {import('mongodb').Db} db
 * @param {string} coll
 * @param {{sample?: number, ids?: any[], filter?: object}} [opts]
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function typeCensus(db, coll, { sample = 2000, ids, filter = {} } = {}) {
  return census(await sampleDocs(db, coll, { sample, ids, filter }));
}

function sampleDocs(db, coll, { sample, ids, filter }) {
  const c = db.collection(coll);
  if (ids) return c.find({ _id: { $in: ids } }, READ_OPTS).toArray();
  return c.find(filter, READ_OPTS).sort({ _id: 1 }).limit(sample).toArray();
}

// A collection with a TTL index: sample only documents that will not expire
// in the next 10 minutes, so no sampled document vanishes mid-comparison on
// either side (Oracle runs the restored TTL indexes too).
const TTL_MARGIN_MS = 600_000;
async function notExpiringSoon(db, coll) {
  const ix = (await db.collection(coll).indexes()).find((i) => i.expireAfterSeconds !== undefined);
  if (!ix) return null;
  const field = Object.keys(ix.key)[0];
  return { [field]: { $gt: new Date(Date.now() - ix.expireAfterSeconds * 1000 + TTL_MARGIN_MS) } };
}

// The Oracle API answers a $type it does not support with "Query filter is
// invalid or not supported $type value not supported". That is the landmine
// showing (Ruling P), so it is recorded as 'rejected'; any other error throws.
async function count(db, coll, filter) {
  try {
    return await db.collection(coll).countDocuments(filter);
  } catch (err) {
    if (/not supported/i.test(err.message)) return 'rejected';
    throw err;
  }
}

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const key = (id) => (id?.toHexString ? id.toHexString() : JSON.stringify(id));
const TWO_53 = Long.fromString('9007199254740992');

/**
 * @typedef {{kind:'type', coll:string, path:string, srcTypes:string[], dstTypes:string[],
 *   queryCheck:{filter:object, srcCount:number|'rejected', dstCount:number|'rejected'}}} TypeRow
 * @typedef {{kind:'value', coll:string, path:string, check:string, ok:boolean,
 *   changed?:number, of?:number, example?:{src:string,dst:string}, src?:string, dst?:string, exact?:boolean}} ValueRow
 * @param {import('mongodb').Db} srcDb
 * @param {import('mongodb').Db} dstDb
 * @param {string[]} colls
 * @param {{sample?: number}} [opts]
 * @returns {Promise<(TypeRow|ValueRow)[]>}
 */
export async function typeDiff(srcDb, dstDb, colls, { sample = 2000 } = {}) {
  const rows = [];
  for (const coll of colls) {
    // The sample is the first `sample` documents by _id (TTL-safe ones only);
    // its _id range bounds every query on both sides, which is far cheaper on
    // the Oracle API than a 2000-element $in.
    const ttl = await notExpiringSoon(srcDb, coll);
    const srcDocs = await sampleDocs(srcDb, coll, { sample, filter: ttl ?? {} });
    if (!srcDocs.length) continue;
    const scope = [{ _id: { $gte: srcDocs[0]._id, $lte: srcDocs.at(-1)._id } }, ...(ttl ? [ttl] : [])];
    const dstDocs = await sampleDocs(dstDb, coll, { sample: srcDocs.length + 1, filter: { $and: scope } });
    const dstById = new Map(dstDocs.map((d) => [key(d._id), d]));
    const pairs = srcDocs.filter((d) => dstById.has(key(d._id))).map((d) => [d, dstById.get(key(d._id))]);
    const srcC = census(pairs.map(([s]) => s));
    const dstC = census(pairs.map(([, d]) => d));

    for (const path of [...new Set([...srcC.keys(), ...dstC.keys()])].sort()) {
      const s = srcC.get(path) ?? new Set();
      const d = dstC.get(path) ?? new Set();
      // One $type query per source type, over the same documents on both sides.
      let check = null;
      for (const t of s) {
        const filter = { [path]: { $type: t } };
        const q = { $and: [...scope, filter] };
        const c = { filter, srcCount: await count(srcDb, coll, q), dstCount: await count(dstDb, coll, q) };
        if (!check || (c.srcCount !== c.dstCount && check.srcCount === check.dstCount)) check = c;
      }
      if (!setEq(s, d) || (check && check.srcCount !== check.dstCount)) {
        rows.push({ kind: 'type', coll, path, srcTypes: [...s].sort(), dstTypes: [...d].sort(), queryCheck: check });
      }

      // Decimal128 keeps its type; does it keep its scale?
      if (s.has('decimal')) {
        let changed = 0, of = 0, example;
        for (const [sd, dd] of pairs) {
          const a = valuesAt(sd, path), b = valuesAt(dd, path);
          a.forEach((v, i) => {
            if (bsonType(v) !== 'decimal') return;
            of++;
            const sv = v.toString(), dv = String(b[i]);
            if (sv !== dv) { changed++; example ??= { src: sv, dst: dv }; }
          });
        }
        rows.push({ kind: 'value', coll, path, check: 'decimal scale', ok: changed === 0, changed, of, example });
      }

      // Int64 above 2^53 (no double holds it exactly): every such value on the
      // source, looked up by _id on Oracle. Not sampled: the planted one counts.
      if (s.has('long')) {
        const big = await srcDb.collection(coll)
          .find({ $or: [{ [path]: { $gt: TWO_53 } }, { [path]: { $lt: TWO_53.negate() } }] }, READ_OPTS)
          .limit(5).toArray();
        for (const b of big) {
          const o = await dstDb.collection(coll).findOne({ _id: b._id }, READ_OPTS);
          const src = valuesAt(b, path)[0].toString();
          const dstV = o ? valuesAt(o, path)[0] : undefined;
          const dst = dstV === undefined ? 'missing' : `${dstV} (${bsonType(dstV)})`.replace(/ \(long\)$/, '');
          rows.push({ kind: 'value', coll, path, check: 'Int64 above 2^53', ok: dst === src, src, dst, exact: dst === src });
        }
      }
    }
  }
  return rows;
}

const fmtCount = (c) => (c === 'rejected' ? 'rejected' : String(c));
const fmtFilter = (f) => JSON.stringify(f).replace(/"([$\w.]+)":/g, '$1:');

/** The rows as two plain-text tables (type differences, then value checks). */
export function formatTypeDiff(rows) {
  const table = (head, body) => {
    const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
    const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
    return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
  };
  const types = rows.filter((r) => r.kind === 'type').map((r) => [
    r.coll, r.path, r.srcTypes.join(',') || '-', r.dstTypes.join(',') || '-',
    r.queryCheck ? fmtFilter(r.queryCheck.filter) : '-',
    r.queryCheck ? fmtCount(r.queryCheck.srcCount) : '-', r.queryCheck ? fmtCount(r.queryCheck.dstCount) : '-',
  ]);
  const values = rows.filter((r) => r.kind === 'value').map((r) => [
    r.coll, r.path, r.check,
    r.check === 'decimal scale'
      ? `${r.changed} of ${r.of} values changed${r.example ? ` (${r.example.src} reads back as ${r.example.dst})` : ''}`
      : `source ${r.src}, Oracle ${r.dst}: ${r.exact ? 'exact' : 'NOT exact'}`,
  ]);
  return [
    'Type differences (sampled documents, same _ids on both sides)',
    types.length ? table(['collection', 'path', 'MongoDB', 'Oracle', '$type query', 'MongoDB', 'Oracle'], types) : '(none)',
    '',
    'Value checks',
    values.length ? table(['collection', 'path', 'check', 'result'], values) : '(none)',
  ].join('\n');
}

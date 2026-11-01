// D4's "no lost or duplicated writes" check: per collection, the documents on
// the MongoDB source and on Oracle (read with exact types), counted and
// hashed in the form the Oracle API stores (asStored: Decimal128 scale and
// the Timestamp/regex tagging fold away, nothing else does).
//
// TTL collections (carts, orderEvents) expire on both sides on their own
// clocks (Oracle runs the restored TTL index too), so at any moment one side
// may still hold a document the other has already removed. Ruling J allows
// comparing them only at one snapshot, never across time; here both sides
// are compared on the same window instead: only documents whose TTL deadline
// is at least MARGIN_MS away, which neither side can remove during the check.
import { hashDocs } from '../lib/compare.mjs';
import { COLLECTIONS } from '../oracle/prep.mjs';
import { asStored, READ } from './apply.mjs';

const MARGIN_MS = 60_000;

/** {field, seconds} of the collection's TTL index on the source, or null. */
async function ttlOf(src, coll) {
  const idx = (await src.collection(coll).indexes()).find((i) => i.expireAfterSeconds !== undefined);
  return idx ? { field: Object.keys(idx.key)[0], seconds: Number(idx.expireAfterSeconds) } : null;
}

/**
 * @returns {Promise<Array<{coll, mongo, oracle, mongoHash, oracleHash, equal, ttl, mongoTotal, oracleTotal}>>}
 *   mongo/oracle: documents compared on each side; *Total: every document
 */
export async function compareSides(src, ora, { colls = COLLECTIONS } = {}) {
  const now = Date.now();
  const rows = [];
  for (const coll of colls) {
    const ttl = await ttlOf(src, coll);
    const filter = ttl ? { [ttl.field]: { $gt: new Date(now - ttl.seconds * 1000 + MARGIN_MS) } } : {};
    const read = (db) => db.collection(coll).find(filter, READ).toArray();
    const [m, o] = await Promise.all([read(src), read(ora)]);
    const [mongoHash, oracleHash] = [m, o].map((docs) => hashDocs(docs.map(asStored)));
    const row = { coll, mongo: m.length, oracle: o.length, mongoHash, oracleHash, equal: mongoHash === oracleHash, ttl: null };
    if (ttl) {
      row.ttl = `${ttl.field} + ${ttl.seconds}s`;
      [row.mongoTotal, row.oracleTotal] = await Promise.all([src, ora].map((db) => db.collection(coll).countDocuments()));
    } else {
      row.mongoTotal = m.length;
      row.oracleTotal = o.length;
    }
    rows.push(row);
  }
  return rows;
}

/** The comparison as a monospace table. */
export function formatComparison(rows) {
  const head = ['collection', 'MongoDB', 'Oracle', 'sha-256 (MongoDB)', 'sha-256 (Oracle)', 'match', 'note'];
  const body = rows.map((r) => [
    r.coll, String(r.mongo), String(r.oracle), r.mongoHash.slice(0, 12), r.oracleHash.slice(0, 12), r.equal ? 'yes' : 'NO',
    r.ttl ? `TTL ${r.ttl}: compared ${r.mongo} not near expiry (all: MongoDB ${r.mongoTotal}, Oracle ${r.oracleTotal})` : '',
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

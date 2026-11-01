// Read a mongodump archive (--archive, optionally --gzip) without restoring
// it: per namespace, the document count and, for a collection with a TTL
// index, each document's expiry deadline. This is the dump snapshot D3
// compares the restored collections against (Ruling J: carts and orderEvents
// expire on the source, and on Oracle too, so only this one snapshot counts).
//
// Archive layout (mongo-tools common/archive):
//   magic   int32 0x8199e26d
//   prelude BSON header doc, one BSON metadata doc per collection (its
//           `metadata` is Extended JSON with the indexes), terminator
//   body    blocks: a BSON namespace header {db, collection, EOF, CRC}, then
//           that namespace's BSON documents, then a terminator
// Every BSON document starts with its int32 length; a terminator is int32 -1.
import { createGunzip } from 'node:zlib';
import { BSON } from 'mongodb';

const MAGIC = 0x8199e26d;
const TERMINATOR = -1;

/** The TTL index of a collection's dump metadata, as {field, seconds}, or null. */
function ttlOf(metadataJson) {
  if (!metadataJson) return null;
  const meta = BSON.EJSON.parse(metadataJson, { relaxed: true });
  const ix = (meta.indexes ?? []).find((i) => i.expireAfterSeconds !== undefined);
  if (!ix) return null;
  return { field: Object.keys(ix.key)[0], seconds: Number(ix.expireAfterSeconds) };
}

/**
 * @typedef {{count:number, ttl:{field:string,seconds:number}|null, deadlines:number[]|null}} NsInfo
 * deadlines: per document, the epoch ms after which its TTL index may delete it.
 * @param {import('node:stream').Readable} stream the archive bytes
 * @param {{gzip?: boolean}} [opts]
 * @returns {Promise<Map<string, NsInfo>>} keyed "db.collection"
 */
export async function readArchive(stream, { gzip = true } = {}) {
  const src = gzip ? stream.pipe(createGunzip()) : stream;
  stream.on('error', (e) => src.destroy(e));
  const out = new Map();
  const info = (ns) => {
    if (!out.has(ns)) out.set(ns, { count: 0, ttl: null, deadlines: null });
    return out.get(ns);
  };
  let buf = Buffer.alloc(0);
  let state = 'magic'; // magic | prelude | header | docs
  let first = true; // the first prelude document is the archive header
  let cur = null;

  for await (const chunk of src) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (state === 'magic') {
        if (buf.length - off < 4) break;
        if (buf.readUInt32LE(off) !== MAGIC) throw new Error('not a mongodump archive (bad magic number)');
        off += 4; state = 'prelude';
        continue;
      }
      if (buf.length - off < 4) break;
      const len = buf.readInt32LE(off);
      if (len === TERMINATOR) {
        off += 4; state = 'header'; cur = null;
        continue;
      }
      if (len < 5) throw new Error(`corrupt archive: BSON length ${len}`);
      if (buf.length - off < len) break;
      const bytes = buf.subarray(off, off + len);
      off += len;
      if (state === 'prelude') {
        if (first) { first = false; continue; }
        const m = BSON.deserialize(bytes);
        const ns = info(`${m.db}.${m.collection}`);
        ns.ttl = ttlOf(m.metadata);
        if (ns.ttl) ns.deadlines = [];
      } else if (state === 'header') {
        const h = BSON.deserialize(bytes);
        cur = info(`${h.db}.${h.collection}`);
        state = 'docs';
      } else {
        cur.count++;
        if (cur.ttl) {
          const v = BSON.deserialize(bytes)[cur.ttl.field];
          // A document without a Date in the TTL field never expires.
          cur.deadlines.push(v instanceof Date ? v.getTime() + cur.ttl.seconds * 1000 : Infinity);
        }
      }
    }
    buf = buf.subarray(off);
  }
  if (state === 'magic') throw new Error('empty archive');
  return out;
}

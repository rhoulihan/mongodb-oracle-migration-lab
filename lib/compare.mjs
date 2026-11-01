// Result comparison helpers. Every demo asserts equal results before it shows
// any timing, and these are the functions it uses to decide "equal".
//
// The canonical form is canonical Extended JSON (relaxed=false), so BSON types
// count: Long(5) and 5 are different values, as are Int32 and Double. Object
// keys are sorted at every level; array order is kept.
import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';

const { EJSON } = BSON;

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function canonical(doc) {
  return JSON.stringify(sortKeys(EJSON.serialize(doc, { relaxed: false })));
}

const idKey = (doc) => canonical(doc._id);

// Pairs of [idKey, canonical], sorted by idKey.
function canonicalSorted(docs) {
  return docs
    .map((d) => [idKey(d), canonical(d)])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

// Order-independent comparison of two result sets keyed by _id. On a mismatch
// `diff` names the first differing _id (in _id order) and shows both sides.
export function sameDocs(a, b) {
  const ca = canonicalSorted(a), cb = canonicalSorted(b);
  let i = 0, j = 0;
  while (i < ca.length || j < cb.length) {
    const [ka, va] = ca[i] ?? [], [kb, vb] = cb[j] ?? [];
    if (kb === undefined || (ka !== undefined && ka < kb)) {
      return { equal: false, diff: `_id ${ka}: only in a` };
    }
    if (ka === undefined || kb < ka) {
      return { equal: false, diff: `_id ${kb}: only in b` };
    }
    if (va !== vb) return { equal: false, diff: `_id ${ka}: a=${va} b=${vb}` };
    i++; j++;
  }
  return { equal: true };
}

// sha256 over the canonical form of every document, sorted by _id.
export function hashDocs(docs) {
  const h = createHash('sha256');
  for (const [, v] of canonicalSorted(docs)) h.update(v).update('\n');
  return h.digest('hex');
}

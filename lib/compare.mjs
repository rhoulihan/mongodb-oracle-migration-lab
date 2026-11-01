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

const MAX_LABEL = 200;
const short = (str) => (str.length > MAX_LABEL ? `${str.slice(0, MAX_LABEL)}...` : str);

// [sortKey, canonical, label] per document, sorted by sortKey. Documents with
// an _id sort by it. Documents without one (SQL rowsets, `$project {_id: 0}`)
// sort by their whole canonical form, which makes the comparison a multiset
// comparison, and are labeled by that form.
function canonicalSorted(docs) {
  return docs
    .map((d) => {
      const c = canonical(d);
      if (d._id === undefined) return ['doc:' + c, c, `doc ${short(c)}`];
      const k = canonical(d._id);
      return ['id:' + k, c, `_id ${k}`];
    })
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

// Order-independent comparison of two result sets. On a mismatch `diff` names
// the first differing document (its _id, or its canonical form when it has no
// _id) in sort order and shows both sides.
export function sameDocs(a, b) {
  const ca = canonicalSorted(a), cb = canonicalSorted(b);
  let i = 0, j = 0;
  while (i < ca.length || j < cb.length) {
    const [ka, va, la] = ca[i] ?? [], [kb, vb, lb] = cb[j] ?? [];
    if (kb === undefined || (ka !== undefined && ka < kb)) {
      return { equal: false, diff: `${la}: only in a` };
    }
    if (ka === undefined || kb < ka) {
      return { equal: false, diff: `${lb}: only in b` };
    }
    if (va !== vb) return { equal: false, diff: `${la}: a=${short(va)} b=${short(vb)}` };
    i++; j++;
  }
  return { equal: true };
}

// sha256 over the canonical form of every document, in the same sort order.
export function hashDocs(docs) {
  const h = createHash('sha256');
  for (const [, v] of canonicalSorted(docs)) h.update(v).update('\n');
  return h.digest('hex');
}

// D1 Compatibility check and type census: before anything moves, find the
// landmines before they find you.
//
//   scan    Scripted operator scan (built for this lab): every $-operator the
//           order service's source uses, sorted into supported, caveat and
//           unsupported on the Oracle API for MongoDB (compat-matrix.json:
//           the reference matrix plus this lab's own measured findings). A
//           second table covers the pipelines the audience meets later in D5
//           and D6.
//   census  The BSON types per field on the MongoDB source, with the types
//           that change meaning on Oracle flagged as landmines: regex,
//           Timestamp, Int64 above 2^53, Decimal128, and arrays (where $type
//           does not match the elements).
//
// No advisor step: Oracle's MongoDB Compatibility Advisor does not run
// offline inside this stack (docs/spikes/d1-advisor.md).
//
// D1 reads only. Its starting state is a generated MongoDB source; setup
// checks for it and reset has nothing to undo.
import { Long } from 'mongodb';
import { COLLECTIONS } from '../../oracle/prep.mjs';
import { typeCensus } from '../d3-dump-restore/typediff.mjs';
import { classify, formatOperators, loadMatrix, rowsOf, scanOperators } from './opscan.mjs';

export const APP_GLOBS = ['app/**/*.mjs'];
export const DEMO_GLOBS = ['demos/d5-topn/variants.mjs', 'demos/d6-sql/queries.mjs'];
const SAMPLE = 2000;
const TWO_53 = Long.fromString('9007199254740992');
const EMPTY_HINT = 'the MongoDB source is empty: run ./lab.sh generate';

async function sourceReady(ctx) {
  const src = await ctx.mongoSrc();
  const [catalog, orders] = await Promise.all([
    src.collection('catalog').estimatedDocumentCount(), src.collection('orders').estimatedDocumentCount(),
  ]);
  return catalog > 0 && orders > 0;
}

async function startingState(ctx) {
  if (!(await sourceReady(ctx))) throw new Error(EMPTY_HINT);
}

const counts = (c) => `${c.unsupported.length} unsupported, ${c.caveat.length} caveat, ${c.supported.length} supported`;

/** Landmine notes for one path, from the matrix's measured type findings. */
function landminesFor(types, above2p53, notes) {
  const out = [];
  for (const t of ['regex', 'timestamp', 'decimal', 'array']) if (types.includes(t)) out.push(notes[t]);
  if (above2p53 > 0) out.push(`${notes.long} (${above2p53} value${above2p53 === 1 ? '' : 's'} here)`);
  return out;
}

/** Census rows for every path in every collection of the source, and the empty collections. */
async function census(src, notes) {
  const rows = [], empty = [];
  for (const coll of COLLECTIONS) {
    const m = await typeCensus(src, coll, { sample: SAMPLE });
    if (!m.size) empty.push(coll);
    for (const path of [...m.keys()].sort()) {
      const types = [...m.get(path)].sort();
      let above2p53 = 0;
      if (types.includes('long')) {
        // The whole collection, not the sample: the planted value counts.
        above2p53 = await src.collection(coll).countDocuments(
          { $or: [{ [path]: { $gt: TWO_53 } }, { [path]: { $lt: TWO_53.negate() } }] });
      }
      rows.push({ coll, path, types, ...(types.includes('long') ? { above2p53 } : {}), landmines: landminesFor(types, above2p53, notes) });
    }
  }
  return { rows, empty };
}

function censusTable(rows) {
  const head = ['', 'collection', 'path', 'BSON types', 'landmine on Oracle'];
  const body = rows.map((r) => [r.landmines.length ? '!!' : '', r.coll, r.path, r.types.join(','), r.landmines.join('; ')]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ').trimEnd();
  return [line(head), line(w.map((n, i) => '-'.repeat(i === w.length - 1 ? 4 : Math.max(n, 2)))), ...body.map(line)].join('\n');
}

/** @type {import('../contract.mjs').Demo} */
export default {
  id: 'd1',
  title: 'Compatibility check and type census',
  setup: startingState,
  async reset() {},
  steps: [
    {
      id: 'scan',
      title: 'Scripted operator scan (built for this lab)',
      lane: 'console',
      async run() {
        const matrix = loadMatrix();
        const app = classify(await scanOperators(APP_GLOBS), matrix);
        const demo = classify(await scanOperators(DEMO_GLOBS), matrix);
        const n = rowsOf(app).length;
        return {
          ok: n > 0,
          summary: n
            ? `order service: ${n} operators (${counts(app)}); demo pipelines: ${rowsOf(demo).length} operators (${counts(demo)})`
            : `no operators found in ${APP_GLOBS.join(', ')}`,
          panes: { left: rowsOf(app), right: rowsOf(demo) },
          metrics: {
            app: { unsupported: app.unsupported.length, caveat: app.caveat.length, supported: app.supported.length },
            demo: { unsupported: demo.unsupported.length, caveat: demo.caveat.length, supported: demo.supported.length },
          },
          detail: [
            `Scripted operator scan (built for this lab): the order service (${APP_GLOBS.join(', ')})`,
            `Matrix: ${matrix.source.file}, copied ${matrix.source.copied}, plus findings measured in this lab`,
            formatOperators(app),
            '',
            `The demo pipelines you will see in D5 and D6 (${DEMO_GLOBS.join(', ')})`,
            formatOperators(demo),
          ].join('\n'),
        };
      },
    },
    {
      id: 'census',
      title: 'BSON type census on the MongoDB source',
      lane: 'console',
      async run(ctx) {
        if (!(await sourceReady(ctx))) return { ok: false, summary: EMPTY_HINT };
        const notes = Object.fromEntries(loadMatrix().types.map((t) => [t.type, t.note]));
        const { rows, empty } = await census(await ctx.mongoSrc(), notes);
        const mined = rows.filter((r) => r.landmines.length);
        // carts and orderEvents expire by TTL; an empty one has nothing to census.
        const emptyNote = empty.length ? ` (no documents in ${empty.join(', ')}: run ./lab.sh generate to see them)` : '';
        return {
          ok: rows.length > 0,
          summary: `${rows.length} fields in ${COLLECTIONS.length} collections, ${mined.length} landmines: ` +
            mined.map((r) => `${r.coll}.${r.path}`).join(', ') + emptyNote,
          panes: { left: rows },
          metrics: { fields: rows.length, landmines: mined.length, empty },
          detail: [`BSON types per field (first ${SAMPLE} documents by _id per collection; !! marks a landmine)`, censusTable(rows)].join('\n'),
        };
      },
    },
  ],
};

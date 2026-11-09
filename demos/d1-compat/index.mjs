// D1 Compatibility check and type census: before anything moves, find the
// landmines before they find you.
//
//   scan    Scripted operator scan (built for this lab): every $-operator the
//           order service's source uses, sorted into supported, caveat and
//           unsupported on the Oracle API for MongoDB (compat-matrix.json:
//           the reference matrix plus this lab's own measured findings). A
//           second table covers the pipelines the audience meets later in D5
//           and D6.
//   profile-on  (terminal) Profiling level 2 on the source database, the way
//           mongotools' mongoProfileExport.sh does it.
//   capture The operators the server actually ran: real order-service traffic
//           and a stand-in reporting script, read back from system.profile,
//           classified with the same matrix, and compared with the code scan
//           (profile.mjs). Profiling goes off and the traffic is undone.
//   census  The BSON types per field on the MongoDB source, with the types
//           that change meaning on Oracle flagged as landmines: regex,
//           Timestamp, Decimal128, and arrays (where $type
//           does not match the elements).
//
// No advisor step: Oracle's MongoDB Compatibility Advisor does not run
// offline inside this stack (docs/spikes/d1-advisor.md).
//
// D1 leaves the source as it found it. Its starting state is a generated
// MongoDB source with profiling off; setup checks for it, and reset turns
// profiling off and drops system.profile.
import { COLLECTIONS } from '../../oracle/prep.mjs';
import { typeCensus } from '../d3-dump-restore/typediff.mjs';
import { classify, formatOperators, loadMatrix, rowsOf, scanOperators } from './opscan.mjs';
import { APP_NAME, capture, extractOperators, PROFILE_ON_CMD, profilerLevel, profilerOff, REPORT_LABEL, REPORT_NAME } from './profile.mjs';

export const APP_GLOBS = ['app/**/*.mjs'];
export const DEMO_GLOBS = ['demos/d5-topn/variants.mjs', 'demos/d6-sql/queries.mjs'];
const SAMPLE = 2000;
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
  await profilerOff(await ctx.mongoSrc());
}

const RESET = 'run ./lab.sh reset d1';

/** The capture's operators, classified, with the clients that sent each and whether the code scan has it. */
function captureRows(ops, codeOps, matrix) {
  const c = classify(ops.map((o) => ({ op: o.op, files: o.clients })), matrix);
  return rowsOf(c).map((r) => ({
    operator: r.op,
    'on Oracle': r.status,
    client: r.files.map((f) => (f === REPORT_NAME ? 'report (stand-in)' : f)).join(', '),
    'in code scan': codeOps.has(r.op) ? 'yes' : 'no',
    note: r.note,
  }));
}

const counts = (c) => `${c.unsupported.length} unsupported, ${c.caveat.length} caveat, ${c.supported.length} supported`;

/** Landmine notes for one path, from the matrix's measured type findings. */
function landminesFor(types, notes) {
  const out = [];
  for (const t of ['regex', 'timestamp', 'decimal', 'array']) if (types.includes(t)) out.push(notes[t]);
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
      rows.push({ coll, path, types, landmines: landminesFor(types, notes) });
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
  async reset(ctx) { await profilerOff(await ctx.mongoSrc()); },
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
          labels: { left: 'Order service', right: 'Demo pipelines (D5, D6)' },
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
      id: 'profile-on',
      title: 'Turn on the profiler (level 2) on the MongoDB source',
      lane: 'terminal',
      command: PROFILE_ON_CMD,
      async run(ctx) {
        await (await ctx.mongoSrc()).command({ profile: 2 });
        return { ok: true, summary: 'profiling level 2 on telco: every operation is recorded in system.profile' };
      },
      async verify(ctx) {
        const was = await profilerLevel(await ctx.mongoSrc());
        return was === 2
          ? { ok: true, summary: 'profiling level 2 on telco: every operation is recorded in system.profile' }
          : { ok: false, summary: `profiling level is ${was}, not 2: run ${PROFILE_ON_CMD}` };
      },
    },
    {
      id: 'capture',
      title: 'Capture live traffic: what the server actually runs',
      lane: 'console',
      async run(ctx) {
        let r;
        try {
          r = await capture(ctx);
        } catch (err) {
          return { ok: false, summary: `${err.message}` };
        }
        if (r.failed.length) return { ok: false, summary: `${r.failed.length} app calls failed (${r.failed[0]}): ${RESET}` };
        const matrix = loadMatrix();
        const code = await scanOperators(APP_GLOBS);
        const codeOps = new Set(code.map((o) => o.op));
        const ops = extractOperators(r.docs);
        const seen = new Set(ops.map((o) => o.op));
        const rows = captureRows(ops, codeOps, matrix);
        const unused = code.filter((o) => !seen.has(o.op)).map((o) => ({ operator: o.op, 'used in': o.files.join(', ') }));
        const clients = new Set(ops.flatMap((o) => o.clients));
        const by = (name) => ops.filter((o) => o.clients.includes(name)).map((o) => o.op);
        const appOps = by(APP_NAME), reportOps = by(REPORT_NAME);
        // Operators the order service sent that the static scan did not find:
        // query documents built at run time (store.mjs: placedAt.$gte = from).
        const missed = appOps.filter((op) => !codeOps.has(op));
        const reportOnly = reportOps.filter((op) => !codeOps.has(op) && !appOps.includes(op));
        return {
          ok: clients.has(APP_NAME) && clients.has(REPORT_NAME) && appOps.length > 0,
          summary: `profiler: ${r.docs.length} operations. Order service: ${appOps.length} operators, ` +
            (missed.length ? `${missed.length} the code scan missed (${missed.join(', ')}: built at run time)` : 'all in the code scan') +
            `. Reporting script (stand-in): ${reportOps.length} operators, ${reportOnly.length} that no app code uses` +
            (reportOnly.length ? ` (${reportOnly.join(', ')})` : '') + '. Profiling off, traffic undone',
          panes: { left: rows, right: unused.length ? unused : 'every operator in the code ran' },
          labels: { left: 'Seen by the profiler', right: 'In the code, not seen in this run' },
          metrics: {
            operations: r.docs.length, operators: ops.length, missedByScan: missed.length, reportOnly: reportOnly.length,
            ordersPlaced: r.placed, statusUpdates: r.updated, reportRows: r.reportRows,
          },
          detail: [
            `Profiler capture (the mongoProfileExport.sh method): ${r.placed} orders and ${r.updated} status updates`,
            `through the order service (appName ${APP_NAME}), reads back, one device swap, and one aggregate from`,
            `${REPORT_NAME} (${REPORT_LABEL}). Profiling is off again; the orders, their events and`,
            'regionTopDevices are back as they were.',
            '',
            formatOperators(classify(ops.map((o) => ({ op: o.op, files: o.clients })), matrix)),
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

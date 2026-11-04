// D6 Pipeline vs $sql (spec section 5.2, D6; section 6a): once the data is on
// Oracle, a hard aggregation can be handed to the cost-based optimizer as SQL
// without leaving the MongoDB driver. One question (queries.mjs), three runs:
//   (1) the pipeline on the MongoDB source: its explain (plan shape), timed
//   (2) the same pipeline on Oracle through the Oracle API for MongoDB, timed
//   (3) the question as one $sql stage through the same API, timed
// All three runs are timed: the pipeline on MongoDB, the same pipeline on
// Oracle through the MongoDB API, and $sql. Times stay hidden until equal.
// Equal results come first: (2) shows its time beside (1)'s only after its
// rows match MongoDB's, and $sql's time waits for `equal` (all three).
//
// Starting state (setup and reset): MIG holds D3's restore, with the same
// number of orders in the 90-day window as the source (setup runs D3's dump
// and restore when it does not), and fresh optimizer statistics on the four
// collections the question reads (a bulk load leaves none; without them the
// optimizer guesses row counts). Results of earlier runs are forgotten.
import { mongoExplainDetail, timeMedian } from '../../lib/measure.mjs';
import { sameDocs } from '../../lib/compare.mjs';
import d3 from '../d3-dump-restore/index.mjs';
import { atCents, pipeline, scaleChanged, sqlStage, sqlText, WINDOW } from './queries.mjs';

const RESET = 'run ./lab.sh reset d6';
const SQL_CMD = './lab.sh mongosh ora demos/d6-sql/sql-stage.js';
const TABLES = ['orders', 'subscribers', 'accounts', 'catalog'];
const GROUPS = 32; // 8 regions x 4 tiers
const ROWS = GROUPS * 5;

// The pipeline through the API takes over a minute per run on a laptop, so
// live it is timed once (Ruling T: the presenter narrates the plan while it
// runs); headless runs and the tests set D6_PIPELINE_RUNS=3 (compose passes 3
// to the runner). $sql is fast, so it keeps a median of 7. Ruling Z: setup
// (and so reset) runs each side once, untimed, after the restore and the
// statistics, so the timed runs compare warm with warm. The first run after
// a restore is cold (about 135 s for the pipeline on the Linux lab, against
// 82 to 89 s warm), and live there is only one timed run, which would
// otherwise always be the cold one. Laptop timings are relative only.
export const PIPELINE_RUNS = Object.freeze({ runs: Number(process.env.D6_PIPELINE_RUNS || 1), warmup: 0 });
export const SQL_RUNS = Object.freeze({ runs: 7, warmup: 0 });
// The pipeline on MongoDB takes about 4.4 s on the Mac: a median of 3 keeps
// the step under 15 s. Warmed in setup like the other two.
export const SOURCE_RUNS = Object.freeze({ runs: Number(process.env.D6_SOURCE_RUNS || 3), warmup: 0 });

// Results and medians of this process's runs. The console may run steps one
// at a time, in any order; a step that needs a missing one computes it.
const last = new Map();
const fail = (summary) => ({ ok: false, summary });
const windowFilter = { placedAt: { $gte: WINDOW.fromTs, $lt: WINDOW.toTs } };
const day = (d) => d.toISOString().slice(0, 10);
const runs = (n) => `${n} run${n === 1 ? '' : 's'}`;
const timed = (n) => (n === 1 ? '1 run' : `median of ${n} runs`);
// The timing table's last column: "(1 run)", or the median's runs in ms.
export const measured = (runsMs) => (runsMs.length === 1 ? '(1 run)' : `median of ${runsMs.length}: ${runsMs.map(Math.round).join(', ')} ms`);

async function windowCounts(ctx) {
  const src = await (await ctx.mongoSrc()).collection('orders').countDocuments(windowFilter);
  const ora = await (await ctx.oraMongo()).collection('orders').countDocuments(windowFilter);
  return { src, ora };
}

/**
 * MIG holds D3's restore with the source's window of orders; otherwise (or
 * always, with force: the reset path, which must repair any drift inside
 * the window, not just a count mismatch) run D3's dump and restore.
 */
async function ensureRestored(ctx, { force = false } = {}) {
  const total = await (await ctx.mongoSrc()).collection('orders').estimatedDocumentCount();
  if (total === 0) throw new Error('the MongoDB source has no orders: run ./lab.sh generate, then ./lab.sh reset d6');
  let n = await windowCounts(ctx);
  if (!force && n.ora === n.src) return n;
  for (const id of ['dump', 'restore']) {
    const r = await d3.steps.find((s) => s.id === id).run(ctx);
    if (!r.ok) throw new Error(`D6 needs D3's restore, and D3 ${id} failed: ${r.summary}`);
  }
  n = await windowCounts(ctx);
  if (n.ora !== n.src) throw new Error(`after the restore MIG has ${n.ora} orders in the window, the source ${n.src}`);
  return n;
}

/** What a DBA does after a bulk load: gather optimizer statistics. */
async function gatherStats(conn) {
  for (const t of TABLES) {
    await conn.execute('begin dbms_stats.gather_table_stats(user, :t); end;', { t: `"${t}"` });
  }
}

async function startingState(ctx, { force = false } = {}) {
  last.clear();
  const n = await ensureRestored(ctx, { force });
  await gatherStats(await ctx.oraSql());
  return { ...n, warmed: await warmUp(ctx) };
}

/**
 * Ruling Z: one untimed run of each side, so the timed runs are warm vs warm.
 * Returns the rows each side gave (no times: nothing is timed before equal).
 */
async function warmUp(ctx) {
  const sourceRows = (await (await ctx.mongoSrc()).collection('orders').aggregate(pipeline).toArray()).length;
  const ora = await ctx.oraMongo();
  const pipelineRows = (await ora.collection('orders').aggregate(pipeline).toArray()).length;
  const sqlRows = (await runSqlOnce(ctx)).length;
  return { sourceRows, pipelineRows, sqlRows };
}

// --- the three runs ---------------------------------------------------------
async function runSource(ctx) {
  if (!last.has('source')) {
    const db = await ctx.mongoSrc();
    const c = db.collection('orders');
    let docs;
    const t = await timeMedian(async () => { docs = await c.aggregate(pipeline).toArray(); }, SOURCE_RUNS);
    const { plan, ...query } = await mongoExplainDetail(db, 'orders', pipeline);
    last.set('source', { docs, plan, query, ...t });
  }
  return last.get('source');
}

async function runPipelineOracle(ctx) {
  if (!last.has('pipeline')) {
    const c = (await ctx.oraMongo()).collection('orders');
    let docs;
    const t = await timeMedian(async () => { docs = await c.aggregate(pipeline).toArray(); }, PIPELINE_RUNS);
    last.set('pipeline', { docs, ...t });
  }
  return last.get('pipeline');
}

const runSqlOnce = async (ctx) => (await ctx.oraMongo()).aggregate([sqlStage()]).toArray();

async function runSql(ctx) {
  if (!last.has('sql')) {
    let docs;
    const t = await timeMedian(async () => { docs = await runSqlOnce(ctx); }, SQL_RUNS);
    last.set('sql', { docs, ...t });
  }
  return last.get('sql');
}

/** Equality of (1), (2), (3) after the explicit scale step; remembered for `timing`. */
async function proveEqual(ctx) {
  const all = { source: await runSource(ctx), pipeline: await runPipelineOracle(ctx), sql: await runSql(ctx) };
  const sorted = (docs) => docs.every((d, i) => i === 0 || key(docs[i - 1]) <= key(d));
  for (const [name, r] of Object.entries(all)) {
    if (r.docs.length !== ROWS) return { equal: false, why: `${name} returned ${r.docs.length} rows, expected ${ROWS}` };
    if (!sorted(r.docs)) return { equal: false, why: `${name} is not sorted by region, tier, rank` };
  }
  let cents;
  try {
    cents = Object.fromEntries(Object.entries(all).map(([k, r]) => [k, r.docs.map(atCents)]));
  } catch (err) {
    return { equal: false, why: err.message };
  }
  const a = sameDocs(cents.source, cents.pipeline), b = sameDocs(cents.source, cents.sql);
  const rescaled = Object.fromEntries(Object.entries(all).map(([k, r]) => [k, r.docs.filter(scaleChanged).length]));
  const why = !a.equal ? `source vs pipeline on Oracle: ${a.diff}` : !b.equal ? `source vs $sql: ${b.diff}` : undefined;
  const res = { equal: !why, why, rescaled };
  if (res.equal) last.set('equal', res);
  return res;
}
const key = (d) => `${d.region}\u0000${d.tier}\u0000${String(d.rank).padStart(3, '0')}`;

// --- plans ------------------------------------------------------------------
/** Plan text checks, shared by the steps and the tests. */
export const planChecks = {
  sql: (p) => /HASH JOIN|NESTED LOOPS/.test(p) && /WINDOW SORT PUSHED RANK|WINDOW NOSORT/.test(p),
};

/** The plan steps that carry the story, from a DBMS_XPLAN table or mongoExplain's indented lines. */
const KEY = /TABLE ACCESS|INDEX|JOIN|NESTED LOOPS|GROUP BY|WINDOW|JSON|lookup|LOOKUP|GROUP|SORT/;
function planLines(plan) {
  if (/\|\s*Id\s*\|/.test(plan)) {
    return plan.split('\n').map((l) => l.match(/^\|\s*\*?\s*\d+\s*\|( *)(.*?)\s*\|\s*(.*?)\s*\|/))
      .filter(Boolean).map((m) => `${m[1].slice(1)}${m[2]} ${m[3]}`.trimEnd());
  }
  return plan.split('\n');
}

function sideBySide(leftTitle, left, rightTitle, right) {
  const L = [leftTitle, ...planLines(left)], R = [rightTitle, ...planLines(right)];
  const w = Math.min(80, Math.max(...L.map((l) => l.length)));
  return Array.from({ length: Math.max(L.length, R.length) }, (_, i) =>
    `${(L[i] ?? '').slice(0, w).padEnd(w)}  |  ${R[i] ?? ''}`.trimEnd()).join('\n');
}

const showRows = (docs, n = 10) => [
  'region  tier      rank  subscriber  name              plan              spend',
  ...docs.slice(0, n).map((r) => [r.region.padEnd(6), r.tier.padEnd(8), String(r.rank).padStart(4),
    r.subscriberId.padEnd(10), r.name.padEnd(16), String(r.plan ?? '-').padEnd(16), r.spend.toString().padStart(9)].join('  ')),
].join('\n');

/** One step's run: a thrown error becomes a failed result that says how to recover. */
const guarded = (fn) => async (ctx) => {
  try {
    return await fn(ctx);
  } catch (err) {
    return fail(`${err.message}${/\.\/lab\.sh/.test(err.message) ? '' : `: ${RESET}`}`);
  }
};

/** @type {import('../contract.mjs').Demo} */
export default {
  id: 'd6',
  title: 'Pipeline vs $sql: hand the hard query to the optimizer',
  // Ruling T: the console keeps these times off screen until `equal` passes.
  revealAfter: { step: 'equal', steps: ['sql-stage'], metrics: ['medianMs', 'runsMs'] },
  setup: startingState,
  reset: (ctx) => startingState(ctx, { force: true }),
  steps: [
    {
      id: 'setup',
      title: 'Same data on both sides, statistics gathered',
      lane: 'console',
      // The console runs this step on its own (no demo.setup), so it builds
      // the full starting state itself, D3's restore included.
      run: guarded(async (ctx) => {
        const n = await startingState(ctx);
        return {
          ok: n.ora > 0 && n.warmed.sourceRows === ROWS && n.warmed.pipelineRows === ROWS && n.warmed.sqlRows === ROWS,
          summary: `${n.ora} orders in the 90-day window (${day(WINDOW.fromTs)} to ${day(WINDOW.toTs)}) on both MongoDB and Oracle; ` +
            `optimizer statistics gathered on ${TABLES.join(', ')}; the pipeline (on both sides) and $sql each run once, untimed, ` +
            'so all three are warm before anything is timed',
          metrics: { windowOrders: n.ora, warmUpRows: n.warmed.pipelineRows },
        };
      }),
    },
    {
      id: 'pipeline-mongo-explain',
      title: '(1) The pipeline on MongoDB: the stage tree, timed',
      lane: 'console',
      run: guarded(async (ctx) => {
        const r = await runSource(ctx);
        const lookups = (r.plan.match(/\$lookup|EQ_LOOKUP/g) ?? []).length;
        return {
          ok: lookups >= 3 && r.docs.length === ROWS,
          summary: `MongoDB runs it as ${r.plan.split('\n').length} stages, ${lookups} of them lookups (joins); ` +
            `${r.docs.length} rows (timed over ${runs(r.runsMs.length)})`,
          metrics: { rows: r.docs.length, stages: r.plan.split('\n').length, medianMs: r.medianMs, runsMs: r.runsMs },
          plan: { left: r.plan },
          query: { left: r.query },
          detail: `pipeline stages:\n${pipeline.map((s) => Object.keys(s)[0]).join(' > ')}\n\nMongoDB explain:\n${r.plan}`,
        };
      }),
    },
    {
      id: 'pipeline-oracle',
      title: '(2) The same pipeline on Oracle through the MongoDB API',
      lane: 'console',
      run: guarded(async (ctx) => {
        const r = await runPipelineOracle(ctx);
        const m = await runSource(ctx);
        // Equal before timed, for this pair: the same rows as MongoDB's (1),
        // spend at 2 decimals, before the two times go side by side.
        let same;
        try { same = sameDocs(m.docs.map(atCents), r.docs.map(atCents)); } catch (err) { same = { equal: false, diff: err.message }; }
        if (!same.equal) return fail(`the pipeline on Oracle differs from MongoDB: ${same.diff}; ${RESET}`);
        const slower = Math.round((r.medianMs / m.medianMs) * 10) / 10;
        return {
          ok: r.docs.length === ROWS,
          summary: `the unchanged pipeline returns the same ${r.docs.length} rows as MongoDB: ` +
            `${(r.medianMs / 1000).toFixed(1)} s here (${timed(r.runsMs.length)}) against ${(m.medianMs / 1000).toFixed(1)} s on MongoDB ` +
            `(${timed(m.runsMs.length)}), ${slower}x slower. The API translates the pipeline stage by stage, so each $lookup ` +
            'becomes a lookup per document and the optimizer never sees the whole question. $sql hands it the whole question',
          metrics: { rows: r.docs.length, medianMs: r.medianMs, runsMs: r.runsMs, vsMongo: slower },
          detail: showRows(r.docs, 5),
        };
      }),
    },
    {
      id: 'sql-stage',
      title: '(3) The same question as SQL, in one $sql stage from mongosh',
      lane: 'terminal',
      command: SQL_CMD,
      run: guarded(async (ctx) => {
        const r = await runSql(ctx);
        return {
          ok: r.docs.length === ROWS,
          // Neutral copy: the console marks the times hidden while they are (Ruling T).
          summary: `$sql returns ${r.docs.length} rows through the MongoDB API (timed over ${runs(r.runsMs.length)})`,
          metrics: { rows: r.docs.length, medianMs: r.medianMs, runsMs: r.runsMs },
          detail: `${showRows(r.docs)}\n\nthe statement (demos/d6-sql/top-spenders.sql):\n${sqlText}`,
        };
      }),
      verify: guarded(async (ctx) => {
        const docs = await runSqlOnce(ctx);
        const groups = new Set(docs.map((d) => `${d.region} ${d.tier}`));
        const ranksOk = docs.every((d) => d.rank >= 1 && d.rank <= 5);
        return docs.length === ROWS && groups.size === GROUPS && ranksOk
          ? { ok: true, summary: `$sql through the MongoDB API returns ${ROWS} rows: ranks 1 to 5 for each of the ${GROUPS} region and tier pairs` }
          : fail(`$sql returned ${docs.length} rows over ${groups.size} region and tier pairs, expected ${ROWS} over ${GROUPS}: ${RESET}`);
      }),
    },
    {
      id: 'equal',
      title: 'Equal results, proven before any timing',
      lane: 'console',
      run: guarded(async (ctx) => {
        const e = await proveEqual(ctx);
        if (!e.equal) return fail(`the results differ: ${e.why}; ${RESET}`);
        const n = e.rescaled;
        return {
          ok: true,
          summary: `${ROWS} rows are identical in all three runs: same subscribers, ranks, names, plans and spend. ` +
            `Only the decimal scale needed lining up: Oracle keeps the value but drops trailing zeros ` +
            `(9718.80 reads back as 9718.8), on ${n.pipeline} rows of (2) and ${n.sql} of (3); spend is compared at 2 decimals`,
          metrics: { rows: ROWS, rescaled: n },
          detail: showRows(last.get('sql').docs, 5),
        };
      }),
    },
    {
      id: 'plans',
      title: 'Both Oracle plans, side by side',
      lane: 'console',
      run: guarded(async (ctx) => {
        // Both plans from explain() through the MongoDB API, so both tiles
        // show the server's DBMS_XPLAN table in the same format.
        const db = await ctx.oraMongo();
        const l = await mongoExplainDetail(db, 'orders', pipeline);
        const sx = (await db.aggregate([sqlStage()]).explain('queryPlanner')).queryPlanner ?? {};
        const left = l.table ?? l.plan;
        const right = String(sx.winningPlan ?? '').trimEnd();
        const ok = planChecks.sql(right);
        const loops = (left.match(/NESTED LOOPS/g) ?? []).length;
        return {
          ok,
          summary: `(2) the pipeline becomes ${loops} nested loops that look up and rebuild each document one at a time; ` +
            '(3) the optimizer plans hash joins over whole tables and a rank that stops at 5 per group (WINDOW SORT PUSHED RANK)' +
            (ok ? '' : '; the $sql plan does not show a join and a pushed rank'),
          plan: { left, right },
          query: {
            left: l,
            right: {
              query: `db.aggregate([{ $sql: { statement: <the SQL below>, binds: ${JSON.stringify(sqlStage().$sql.binds)} } }])`,
              sql: sx.generatedSql ?? sqlText,
            },
          },
          labels: { left: '(2) pipeline through the MongoDB API', right: '(3) $sql' },
          detail: sideBySide('(2) pipeline through the MongoDB API', left, '(3) $sql', right),
        };
      }),
    },
    {
      id: 'timing',
      title: 'Relative timing: MongoDB, the pipeline on Oracle, and $sql',
      lane: 'console',
      run: guarded(async (ctx) => {
        if (!last.has('equal')) {
          const e = await proveEqual(ctx);
          if (!e.equal) return fail(`no timing without equal results: ${e.why}; ${RESET}`);
        }
        const m = await runSource(ctx), p = last.get('pipeline'), s = last.get('sql');
        const mongoMs = Math.round(m.medianMs), pipelineMs = Math.round(p.medianMs), sqlMs = Math.round(s.medianMs);
        const x = (a, b) => Math.round((a / b) * 10) / 10;
        const ratio = x(p.medianMs, s.medianMs), vsMongo = x(m.medianMs, s.medianMs);
        const sec = (ms, d) => (ms / 1000).toFixed(d);
        return {
          ok: ratio > 0,
          summary: `same data, same answer: the pipeline takes ${sec(mongoMs, 1)} s on MongoDB (${timed(m.runsMs.length)}) and ` +
            `${sec(pipelineMs, 1)} s on Oracle through the MongoDB API (${timed(p.runsMs.length)}); ` +
            `$sql takes ${sec(sqlMs, 2)} s (${timed(s.runsMs.length)}): ${ratio}x faster than the same pipeline on Oracle, ` +
            `${vsMongo}x faster than the pipeline on MongoDB. Laptop numbers, relative only`,
          metrics: { mongoMs, pipelineMs, sqlMs, ratio, vsMongo },
          detail: [
            'run                                          ms   how measured',
            `(1) pipeline on MongoDB               ${String(mongoMs).padStart(9)}   ${measured(m.runsMs)}`,
            `(2) pipeline through the MongoDB API  ${String(pipelineMs).padStart(9)}   ${measured(p.runsMs)}`,
            `(3) $sql through the MongoDB API      ${String(sqlMs).padStart(9)}   ${measured(s.runsMs)}`,
            `$sql vs (2): ${ratio}x; $sql vs (1): ${vsMongo}x (laptop, relative only)`,
          ].join('\n'),
        };
      }),
    },
  ],
};


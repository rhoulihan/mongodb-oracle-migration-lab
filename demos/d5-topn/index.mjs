// D5 Top-N real-time counter: "top 10 devices selling right now, per region",
// three ways, on Oracle after D3's restore (spec section 5.2, D5 detail).
//   (a) embedded   one document per region with every device's count: each
//                  order is one $inc; the client sorts it and keeps the top 10
//   (b) lookup     counter documents kept with $inc; the read is the app's own
//                  aggregation pipeline over them ($sort, $limit, $lookup)
//   (c) converged  counter rows, a pre-sorted index, and a duality view that
//                  hands the app the dashboard as one document: the query is
//                  SQL the database owns, not code in the app tier
//
// Each write step starts from the same truth (restoreBaseline), places the
// same 200 seeded orders through its variant, and measures redo per order
// with the instance-wide v$sysstat delta (Ruling S): 20 warmup orders, then
// 9 batches of 20, median of the batches. Laptop numbers, relative only.
//
// Starting state (setup): MIG holds D3's restore (setup runs D3's dump and
// restore when MIG.orders is empty), the converged tables and views are
// rebuilt from it, regionTopDevices matches them, and no D5 order is present.
import { sameDocs } from '../../lib/compare.mjs';
import { mongoExplainDetail, sysRedoBytes, timeMedian } from '../../lib/measure.mjs';
import d3 from '../d3-dump-restore/index.mjs';
import { BSON } from 'mongodb';
import { dropCapture } from '../../replicator/capture.mjs';
import { buildConverged, buildCounters, buildEmbedded, converged, D5_ID_RANGE, dashboard, embedded, EMBEDDED, lookup, recountDashboard, seededOrders, VARIANTS } from './variants.mjs';

const ORDERS = 200, WARMUP = 20, BATCH = 20;
const SHOW_REGION = 'R03';
const MONGOSH_CMD = `./lab.sh mongosh ora --eval 'db.region_top_devices_v.findOne({_id:"${SHOW_REGION}"})'`;

// Results of the write steps, kept for same-shape (the console may run steps
// one at a time, in any order).
const last = new Map();

async function handles(ctx) {
  return { db: await ctx.oraMongo(), conn: await ctx.oraSql() };
}
async function startingState(ctx) {
  last.clear();
  const { conn } = await handles(ctx);
  // D4's capture triggers, if D4 was not reset, would add their own redo to
  // every write D5 measures.
  await dropCapture(conn);
  await ensureRestored(ctx, conn);
  await restoreBaseline(ctx);
}

const target = (v, h) => (v.surface === 'sql' ? h.conn : h.db);

/** MIG holds D3's restore; if it is empty, run D3's own dump and restore steps. */
async function ensureRestored(ctx, conn) {
  const exists = Number((await conn.execute("select count(*) from user_tables where table_name = 'orders'")).rows[0][0]);
  const n = exists ? Number((await conn.execute('select count(*) from "orders"')).rows[0][0]) : 0;
  if (n > 0) return;
  for (const id of ['dump', 'restore']) {
    const step = d3.steps.find((s) => s.id === id);
    const r = await step.run(ctx);
    if (!r.ok) throw new Error(`D5 setup needs D3's restore, and D3 ${id} failed: ${r.summary}`);
  }
}

/**
 * The shared starting truth: no D5 orders in MIG.orders, the converged tables
 * rebuilt from the orders, and regionTopDevices set to the same Top 10.
 */
async function restoreBaseline(ctx) {
  const { db, conn } = await handles(ctx);
  await db.collection('orders').deleteMany({ _id: D5_ID_RANGE });
  await buildConverged(conn);
  await buildCounters(db, conn);
  await buildEmbedded(db, conn);
  const r = await conn.execute('select json_serialize(data) from region_top_devices_v');
  const docs = r.rows.map(([t]) => JSON.parse(t)).map((d) => dashboard(d._id, d.top));
  const top = db.collection('regionTopDevices');
  for (const d of docs) await top.replaceOne({ _id: d._id }, { top: d.top }, { upsert: true });
  return docs.map((d) => d._id).sort();
}

async function regionIds(conn) {
  return (await conn.execute('select region_id from region order by region_id')).rows.map((x) => x[0]);
}

/** Place the seeded orders through one variant; redo per order, median of batches. */
async function placeAll(ctx, v) {
  const h = await handles(ctx);
  const orders = await seededOrders(h.db, { n: ORDERS, seed: ctx.config.seed });
  const t = target(v, h);
  for (const o of orders.slice(0, WARMUP)) await v.placeOrder(t, o);
  const perOrder = [];
  for (let i = WARMUP; i < orders.length; i += BATCH) {
    const batch = orders.slice(i, i + BATCH);
    const { redo } = await sysRedoBytes(h.conn, async () => {
      for (const o of batch) await v.placeOrder(t, o);
    });
    perOrder.push(redo / batch.length);
  }
  const s = [...perOrder].sort((a, b) => a - b);
  return { redoPerOrder: Math.round(s[Math.floor(s.length / 2)]), batches: perOrder.map(Math.round) };
}

/**
 * The counter write's share of each order's redo: the same counter write
 * placeOrder makes (its own commit included), +1 on the counters of the
 * timed orders, in batches; each batch is undone (-1) untimed, so the counts
 * end where they started. The order's share is the rest.
 */
async function counterSplit(ctx, v, total) {
  const h = await handles(ctx);
  const t = target(v, h);
  const orders = (await seededOrders(h.db, { n: ORDERS, seed: ctx.config.seed })).slice(WARMUP, WARMUP + BATCH);
  const lines = orders.flatMap((o) => o.lines.filter((l) => l.kind === 'device').map((l) => [o.region, l.sku]));
  const bump = async (qty) => { for (const [r, sku] of lines) await v.bumpCounter(t, r, sku, qty); };
  await bump(1); await bump(-1); // warmup
  const per = [];
  for (let i = 0; i < 5; i++) {
    const { redo } = await sysRedoBytes(h.conn, () => bump(1));
    await bump(-1);
    per.push(redo / orders.length);
  }
  per.sort((a, b) => a - b);
  const counter = Math.round(per[2]);
  return { counterRedo: counter, orderRedo: total - counter };
}

/** Average stored size of one counter: (b)'s JSON document, (c)'s row. */
async function counterBytes(conn) {
  const q = async (sql) => Math.round(Number((await conn.execute(sql)).rows[0][0]));
  return {
    doc: await q('select avg(vsize(data)) from "deviceSales"'),
    row: await q('select avg(vsize(region_id) + vsize(sku) + vsize(units)) from device_sales'),
  };
}

const split = (r) => `the order ${r.orderRedo} + the counter ${r.counterRedo}`;

async function readAll(ctx, v) {
  const h = await handles(ctx);
  const t = target(v, h);
  const docs = [];
  for (const r of await regionIds(h.conn)) docs.push(await v.readDashboard(t, r));
  const { medianMs } = await timeMedian(() => v.readDashboard(t, SHOW_REGION), { runs: 7, warmup: 2 });
  return { docs, readMs: Math.round(medianMs * 10) / 10 };
}

async function readPlan(ctx, v) {
  const h = await handles(ctx);
  const [coll, x] = v.readTarget(SHOW_REGION);
  return mongoExplainDetail(h.db, coll, x);
}

/** One variant from the shared starting truth: write, read, plan. */
async function runVariant(ctx, v) {
  await restoreBaseline(ctx);
  const write = await placeAll(ctx, v);
  const read = await readAll(ctx, v);
  Object.assign(write, await counterSplit(ctx, v, write.redoPerOrder));
  const { plan, ...query } = await readPlan(ctx, v);
  const res = { ...write, ...read, plan, query };
  last.set(v.id, res);
  return res;
}

const showDoc = (d) => BSON.EJSON.stringify(d, { relaxed: true }, 2);

// The plan steps that carry the story (scans, joins, groups, stop keys), from
// either plan format: DBMS_XPLAN rows or mongoExplain's indented lines.
const KEY = /INDEX|TABLE ACCESS|GROUP BY|STOPKEY|JOIN|EXPAND/;
export function keySteps(plan) {
  const lines = plan.split('\n');
  const rows = /\|\s*Id\s*\|/.test(plan)
    ? lines.map((l) => l.match(/^\|\s*\*?\s*\d+\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`.trim())
    : lines.map((l) => l.trim());
  return rows.filter((r) => KEY.test(r)).join(' > ');
}

/** Plan text checks, shared by the steps and the tests. */
export const planChecks = {
  // The pipeline reads the region's counter documents, top first, and stops at 10.
  lookup: (p) => /deviceSales/.test(p) && /STOPKEY/.test(p) && !/TABLE ACCESS[^\n]*\borders\b/.test(p),
  converged: (p) => /INDEX RANGE SCAN[^\n]*DEVICE_SALES_TOPN/.test(p) && /STOPKEY/.test(p),
};

/** @type {import('../contract.mjs').Demo} */
export default {
  id: 'd5',
  title: 'Top-N real-time counter: duality over a SQL join',
  // Equal before timing (Ruling W): the console keeps read times off screen
  // until same-shape proves the three dashboards identical.
  revealAfter: { step: 'same-shape', steps: ['embedded-write', 'lookup-read', 'converged'], metrics: ['readMs'] },
  setup: startingState,
  reset: startingState,
  steps: [
    {
      id: 'setup',
      title: 'Start all three from the same truth',
      lane: 'console',
      async run(ctx) {
        // The console runs this step on its own (no demo.setup), so it
        // establishes the full starting state itself, D3's restore included.
        let regions;
        try {
          await startingState(ctx);
          regions = await regionIds((await handles(ctx)).conn);
        } catch (err) {
          return { ok: false, summary: `could not build the starting state (${err.message}): run ./lab.sh reset d5` };
        }
        if (regions.length === 0) {
          return { ok: false, summary: 'no regions in MIG after the restore: run ./lab.sh reset d5' };
        }
        const { db, conn } = await handles(ctx);
        // The counters were built in SQL; the pipeline re-counts the orders
        // independently, so this checks the starting truth, not a copy of it.
        const convergedDocs = [], lookupDocs = [];
        for (const r of regions) {
          convergedDocs.push(await converged.readDashboard(conn, r));
          lookupDocs.push(await recountDashboard(db, r));
        }
        const same = sameDocs(convergedDocs, lookupDocs);
        const rows = Number((await conn.execute('select count(*) from device_sales')).rows[0][0]);
        return {
          ok: same.equal,
          summary: same.equal
            ? `${regions.length} regions; ${rows} counter rows built from the restored orders; their Top 10 matches a fresh count of the orders`
            : `the starting Top 10 differs from a fresh count of the orders: ${same.diff}; run ./lab.sh reset d5`,
          metrics: { regions: regions.length, counterRows: rows },
        };
      },
    },
    {
      id: 'embedded-write',
      title: '(a) Embedded counters: one document per region, sorted by the client',
      lane: 'console',
      async run(ctx) {
        const r = await runVariant(ctx, embedded);
        const { db } = await handles(ctx);
        const doc = await db.collection(EMBEDDED).findOne({ _id: SHOW_REGION });
        const size = BSON.calculateObjectSize(doc);
        return {
          ok: r.redoPerOrder > 0,
          summary: `${ORDERS} orders placed. Each order writes ${r.redoPerOrder} bytes of redo (${split(r)}): ` +
            `one $inc rewrites its region's whole document (${SHOW_REGION}: ${doc.devices.length} devices, ${size} bytes). ` +
            'The read fetches the whole document; the client sorts it and keeps the top 10',
          metrics: { redoPerOrder: r.redoPerOrder, orderRedo: r.orderRedo, counterRedo: r.counterRedo, batches: r.batches, docBytes: size, readMs: r.readMs },
          panes: { left: r.docs.find((d) => d._id === SHOW_REGION) },
          plan: { left: r.plan },
          query: { left: r.query },
          detail: `redo per order, by batch of ${BATCH}: ${r.batches.join(', ')}\nread plan:\n${r.plan}`,
        };
      },
    },
    {
      id: 'lookup-read',
      title: '(b) Counter documents and a $lookup pipeline the app owns',
      lane: 'console',
      async run(ctx) {
        const r = await runVariant(ctx, lookup);
        const ok = planChecks.lookup(r.plan);
        const { doc } = await counterBytes((await handles(ctx)).conn);
        return {
          ok,
          // No word about hiding: the console marks the read time hidden while
          // it is, and after same-shape reveals it this summary must still read true.
          summary: `Each order writes ${r.redoPerOrder} bytes of redo (${split(r)}, each with its own commit): ` +
            `the $inc rewrites a whole counter document (${doc} bytes of JSON) and its etag, and moves its index entry. ` +
            'The read is an aggregation pipeline the app owns ($match, $sort, $limit, $lookup the name): ' +
            'change the model, and the app code changes with it' +
            (ok ? '' : '; the plan does not show a read of the deviceSales counters'),
          metrics: { redoPerOrder: r.redoPerOrder, orderRedo: r.orderRedo, counterRedo: r.counterRedo, batches: r.batches, docBytes: doc, readMs: r.readMs },
          panes: { left: r.docs.find((d) => d._id === SHOW_REGION) },
          plan: { left: r.plan },
          query: { left: r.query },
          detail: `redo per order, by batch of ${BATCH}: ${r.batches.join(', ')}\nread plan:\n${r.plan}`,
        };
      },
    },
    {
      id: 'converged',
      title: '(c) Converged: counter rows, read as one document through a JSON view',
      lane: 'console',
      async run(ctx) {
        const r = await runVariant(ctx, converged);
        const ok = planChecks.converged(r.plan);
        // (b) keeps the same counts in documents: its redo is the comparison.
        const b = last.get('lookup');
        const bytes = await counterBytes((await handles(ctx)).conn);
        const doc = r.docs.find((d) => d._id === SHOW_REGION);
        return {
          ok,
          summary: `Each order writes ${r.redoPerOrder} bytes of redo (${split(r)})` +
            (b ? `, (b) ${b.redoPerOrder} (${split(b)}). ` : '. ') +
            `Less redo, because the counter is a row: a write changes one number in a ${bytes.row}-byte row, where (b) ` +
            `rewrites a ${bytes.doc}-byte JSON document and its etag; both move one index entry. And the order and its counter ` +
            'commit once, together. The app reads one document from a JSON view. The join, the pre-sorted index and the stop at 10 rows ' +
            'are SQL the database owns, with the optimizer and parallel execution behind it as the query grows' +
            (ok ? '' : '; the plan does not show INDEX RANGE SCAN DEVICE_SALES_TOPN with STOPKEY'),
          metrics: { redoPerOrder: r.redoPerOrder, orderRedo: r.orderRedo, counterRedo: r.counterRedo, batches: r.batches, rowBytes: bytes.row, readMs: r.readMs },
          panes: { left: doc },
          plan: { left: r.plan },
          query: { left: r.query },
          detail: `redo per order, by batch of ${BATCH}: ${r.batches.join(', ')}\n` +
            `the view builds all ${r.docs.length} regions, then keeps ${SHOW_REGION} by _id\n\n` +
            `read plan:\n${r.plan}\n\ndashboard document:\n${showDoc(doc)}`,
        };
      },
    },
    {
      id: 'same-shape',
      title: 'Same document, three ways',
      lane: 'console',
      async run(ctx) {
        for (const v of Object.values(VARIANTS)) if (!last.has(v.id)) await runVariant(ctx, v);
        const [a, b, c] = ['embedded', 'lookup', 'converged'].map((id) => last.get(id));
        const ab = sameDocs(a.docs, b.docs), ac = sameDocs(a.docs, c.docs);
        const ok = ab.equal && ac.equal;
        const metrics = {
          redoPerOrder: { embedded: a.redoPerOrder, lookup: b.redoPerOrder, converged: c.redoPerOrder },
          counterRedo: { embedded: a.counterRedo, lookup: b.counterRedo, converged: c.counterRedo },
          readMs: { embedded: a.readMs, lookup: b.readMs, converged: c.readMs },
        };
        const pick = (x) => x.docs.find((d) => d._id === SHOW_REGION);
        return {
          ok,
          summary: ok
            ? `all ${a.docs.length} region dashboards are identical in the three variants; ` +
              `redo per order ${a.redoPerOrder} / ${b.redoPerOrder} / ${c.redoPerOrder} bytes, ` +
              `read ${a.readMs} / ${b.readMs} / ${c.readMs} ms (embedded / lookup / converged). ` +
              '(b) and (c) read the same counts; (b) keeps the query in the app, (c) keeps it in the database behind a document'
            : `dashboards differ: ${ab.equal ? '' : `embedded vs lookup ${ab.diff}`} ${ac.equal ? '' : `embedded vs converged ${ac.diff}`}`.trim(),
          metrics,
          panes: {
            left: { embedded: pick(a), lookup: pick(b), converged: pick(c) },
            right: [['(a) embedded', a, 'the region document, rewritten'], ['(b) counter docs', b, 'a JSON document + etag, own commit'],
              ['(c) converged', c, 'one number in a row, one commit']].map(([variant, x, counter]) => ({
              variant, 'redo/order': x.redoPerOrder, order: x.orderRedo, counter: x.counterRedo, 'the counter write': counter,
            })),
          },
          labels: { left: `${SHOW_REGION}, three ways`, right: 'Redo per order, in bytes: the order + its counter' },
          detail: [
            'variant     redo/order   order  counter  read ms  plan',
            ...[['embedded', a], ['lookup', b], ['converged', c]].map(([n, x]) =>
              `${n.padEnd(10)}  ${String(x.redoPerOrder).padStart(10)}  ${String(x.orderRedo).padStart(6)}  ${String(x.counterRedo).padStart(7)}  ` +
              `${String(x.readMs).padStart(7)}  ${keySteps(x.plan)}`),
            '',
            `${SHOW_REGION} top 3: ${pick(c).top.slice(0, 3).map((t) => `${t.sku} ${t.units}`).join(', ')}`,
          ].join('\n'),
        };
      },
    },
    {
      id: 'mongosh-read',
      title: 'The app reads the dashboard document through the MongoDB API',
      lane: 'terminal',
      command: MONGOSH_CMD,
      async run(ctx) {
        const { db, conn } = await handles(ctx);
        const viaApi = await db.collection('region_top_devices_v').findOne({ _id: SHOW_REGION });
        const viaSql = await converged.readDashboard(conn, SHOW_REGION);
        const same = viaApi ? sameDocs([dashboard(viaApi._id, viaApi.top)], [viaSql]) : { equal: false, diff: 'no document' };
        return {
          ok: same.equal,
          summary: same.equal
            ? `MongoDB API read of region_top_devices_v returns the ${SHOW_REGION} dashboard document (${viaApi.top.length} devices)`
            : `MongoDB API read differs from the SQL read: ${same.diff}`,
          panes: { left: viaApi },
        };
      },
      async verify(ctx) {
        const { db } = await handles(ctx);
        const d = await db.collection('region_top_devices_v').findOne({ _id: SHOW_REGION });
        const sorted = d?.top?.every((t, i, a) => i === 0 || a[i - 1].units > t.units || (a[i - 1].units === t.units && a[i - 1].sku < t.sku));
        return d?.top?.length === 10 && sorted
          ? { ok: true, summary: `region_top_devices_v is readable through the MongoDB API: ${SHOW_REGION} has 10 devices, sorted` }
          : { ok: false, summary: `region_top_devices_v did not return a sorted Top 10 for ${SHOW_REGION}: run ./lab.sh reset d5` };
      },
    },
  ],
};

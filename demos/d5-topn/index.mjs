// D5 Top-N real-time counter: "top 10 devices selling right now, per region",
// three ways, on Oracle after D3's restore (spec section 5.2, D5 detail).
//   (a) embedded   every order rewrites the region's Top-N document
//   (b) lookup     every dashboard read re-aggregates the region's orders
//   (c) converged  one narrow counter row per order, a pre-sorted index, and a
//                  JSON view that hands the dashboard the same document
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
import { mongoExplain, sqlPlan, sysRedoBytes, timeMedian } from '../../lib/measure.mjs';
import d3 from '../d3-dump-restore/index.mjs';
import { BSON } from 'mongodb';
import { dropCapture } from '../../replicator/capture.mjs';
import { buildConverged, converged, D5_ID_RANGE, dashboard, embedded, lookup, seededOrders, VARIANTS } from './variants.mjs';

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
  const [a, b] = v.readTarget(SHOW_REGION);
  return v.surface === 'sql' ? sqlPlan(h.conn, a, b) : mongoExplain(h.db, a, b);
}

/** One variant from the shared starting truth: write, read, plan. */
async function runVariant(ctx, v) {
  await restoreBaseline(ctx);
  const write = await placeAll(ctx, v);
  const read = await readAll(ctx, v);
  const plan = await readPlan(ctx, v);
  const res = { ...write, ...read, plan };
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
  // Every refresh reads the region's orders (a full scan, or every row of
  // the region's index range) and groups their lines.
  lookup: (p) => /TABLE ACCESS[^\n]*orders/.test(p) && /(HASH|SORT) GROUP BY/.test(p),
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
          lookupDocs.push(await lookup.readDashboard(db, r));
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
      title: '(a) Embedded Top-N document: every order rewrites it',
      lane: 'console',
      async run(ctx) {
        const r = await runVariant(ctx, embedded);
        const { db } = await handles(ctx);
        const doc = await db.collection('regionTopDevices').findOne({ _id: SHOW_REGION });
        const size = BSON.calculateObjectSize(doc);
        return {
          ok: r.redoPerOrder > 0,
          summary: `${ORDERS} orders placed: ${r.redoPerOrder} bytes of redo per order; each order rewrites its region's Top-N document (${SHOW_REGION}: ${size} bytes), usually twice ($inc, then a re-sort)`,
          metrics: { redoPerOrder: r.redoPerOrder, batches: r.batches, docBytes: size, readMs: r.readMs },
          panes: { left: r.docs.find((d) => d._id === SHOW_REGION) },
          plan: { left: r.plan },
          detail: `redo per order, by batch of ${BATCH}: ${r.batches.join(', ')}\nread plan:\n${r.plan}`,
        };
      },
    },
    {
      id: 'lookup-read',
      title: '(b) $lookup pipeline: every read re-aggregates the orders',
      lane: 'console',
      async run(ctx) {
        const r = await runVariant(ctx, lookup);
        const ok = planChecks.lookup(r.plan);
        return {
          ok,
          summary: `${r.redoPerOrder} bytes of redo per order; every dashboard read groups each ${SHOW_REGION} order line again ` +
            '(the read time stays hidden until the three dashboards are proven equal)' +
            (ok ? '' : '; the plan does not show a read of the orders table followed by a GROUP BY'),
          metrics: { redoPerOrder: r.redoPerOrder, batches: r.batches, readMs: r.readMs },
          panes: { left: r.docs.find((d) => d._id === SHOW_REGION) },
          plan: { left: r.plan },
          detail: `read plan:\n${r.plan}`,
        };
      },
    },
    {
      id: 'converged',
      title: '(c) Converged: one counter row per order, a pre-sorted index',
      lane: 'console',
      async run(ctx) {
        const r = await runVariant(ctx, converged);
        const ok = planChecks.converged(r.plan);
        const doc = r.docs.find((d) => d._id === SHOW_REGION);
        return {
          ok,
          summary: `${r.redoPerOrder} bytes of redo per order; the dashboard read is an index range scan that stops after 10 rows per region ` +
            `(the view builds all ${r.docs.length} regions, then keeps ${SHOW_REGION} by _id; the read time stays hidden until the three dashboards are proven equal)` +
            (ok ? '' : '; the plan does not show INDEX RANGE SCAN DEVICE_SALES_TOPN with STOPKEY'),
          metrics: { redoPerOrder: r.redoPerOrder, batches: r.batches, readMs: r.readMs },
          panes: { left: doc },
          plan: { left: r.plan },
          detail: `read plan:\n${r.plan}\n\ndashboard document:\n${showDoc(doc)}`,
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
          readMs: { embedded: a.readMs, lookup: b.readMs, converged: c.readMs },
        };
        const pick = (x) => x.docs.find((d) => d._id === SHOW_REGION);
        return {
          ok,
          summary: ok
            ? `all ${a.docs.length} region dashboards are identical in the three variants; ` +
              `redo per order ${a.redoPerOrder} / ${b.redoPerOrder} / ${c.redoPerOrder} bytes, ` +
              `read ${a.readMs} / ${b.readMs} / ${c.readMs} ms (embedded / lookup / converged)`
            : `dashboards differ: ${ab.equal ? '' : `embedded vs lookup ${ab.diff}`} ${ac.equal ? '' : `embedded vs converged ${ac.diff}`}`.trim(),
          metrics,
          panes: { left: { embedded: pick(a), lookup: pick(b), converged: pick(c) } },
          detail: [
            'variant     redo/order  read ms  plan',
            ...[['embedded', a], ['lookup', b], ['converged', c]].map(([n, x]) =>
              `${n.padEnd(10)}  ${String(x.redoPerOrder).padStart(10)}  ${String(x.readMs).padStart(7)}  ${keySteps(x.plan)}`),
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

// D1's profiler capture: what the server actually runs, next to what the code
// says. The same method as mongotools' mongoProfileExport.sh
// (github.com/oramatt/mongotools): profiling level 2 on the source database,
// real traffic, then read system.profile and turn profiling off.
//
// The traffic is the real order service over HTTP (tagged appName
// "order-service" by app/server.mjs) plus one read-only aggregate from a
// stand-in reporting script (appName "nightly-report"): the kind of client a
// code scan of the app never sees. D1 promises to change nothing, so the
// capture undoes its own writes afterwards, with profiling already off: its
// orders and their events are deleted and regionTopDevices is put back from a
// snapshot taken first.
import { MongoClient } from 'mongodb';
import { config } from '../../lib/config.mjs';
import { app } from '../d3-dump-restore/index.mjs';
import { placeOrders } from '../d4-bluegreen/traffic.mjs';

export const SRC_DB = 'telco';
export const APP_NAME = 'order-service';
export const REPORT_NAME = 'nightly-report';
export const REPORT_LABEL = 'Stand-in for a reporting script';
export const PROFILE_ON_CMD = "./lab.sh mongosh src --quiet --eval 'db.setProfilingLevel(2)'";

// Steady, small: 20 orders and 8 status updates at 4 writes/s, plus reads.
const PLAN = { orders: 20, updates: 8, concurrency: 2, seedOffset: 303, ratePerSec: 4 };

// The reporting script: device units per region over the last 90 days, with
// the product name from the catalog.
export const REPORT_PIPELINE = [
  { $match: { placedAt: { $gte: new Date(Date.now() - 90 * 864e5) } } },
  { $unwind: '$lines' },
  { $match: { 'lines.kind': 'device' } },
  { $group: { _id: { region: '$region', sku: '$lines.sku' }, units: { $sum: '$lines.qty' } } },
  { $lookup: { from: 'catalog', localField: '_id.sku', foreignField: '_id', as: 'product' } },
  { $sort: { units: -1 } },
  { $limit: 20 },
];

// Command fields that carry query language; everything else (documents to
// insert, lsid, $db, $clusterTime, cursor options) is not an operator use.
const QUERY_FIELDS = ['filter', 'q', 'u', 'update', 'pipeline', 'sort', 'projection', 'query', 'updates', 'deletes'];
const isOp = (k) => /^\$[A-Za-z]/.test(k);

function walk(v, add) {
  if (Array.isArray(v)) { v.forEach((x) => walk(x, add)); return; }
  if (!v || typeof v !== 'object' || v._bsontype) return;
  for (const [k, x] of Object.entries(v)) {
    if (isOp(k)) add(k);
    walk(x, add);
  }
}

/**
 * Operators per client from system.profile entries, the code scan's rule
 * (a "$name" object key). Only the query-language fields of each command are
 * read; getMore and the profiler's own entries are skipped.
 * @param {object[]} docs system.profile documents
 * @returns {{op:string, clients:string[]}[]} sorted by operator
 */
export function extractOperators(docs) {
  const byOp = new Map();
  for (const d of docs) {
    const client = d.appName || 'unknown';
    const cmd = d.command ?? {};
    if (d.op === 'getmore' || 'getMore' in cmd) continue;
    const add = (op) => {
      if (!byOp.has(op)) byOp.set(op, new Set());
      byOp.get(op).add(client);
    };
    for (const f of QUERY_FIELDS) if (f in cmd) walk(cmd[f], add);
  }
  return [...byOp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([op, c]) => ({ op, clients: [...c].sort() }));
}

/** Profiling level 0 and an empty system.profile. */
export async function profilerOff(db) {
  await db.command({ profile: 0 });
  await db.collection('system.profile').drop().catch(() => {});
}

export async function profilerLevel(db) {
  return (await db.command({ profile: -1 })).was;
}

async function runReport() {
  const c = await new MongoClient(config.mongoSrcUri, { appName: REPORT_NAME }).connect();
  try {
    return await c.db().collection('orders').aggregate(REPORT_PIPELINE).toArray();
  } finally {
    await c.close();
  }
}

/** Reads through the order service, on the orders just placed. */
async function readBack(ids, failed) {
  const get = async (path) => {
    const r = await app('GET', path);
    if (r.status !== 200) failed.push(`GET ${path.split('?')[0]} ${r.status}`);
    return r.body;
  };
  for (const id of ids.slice(0, 5)) {
    const o = await get(`/orders/${id.toHexString()}`);
    const sub = o?.subscriber?.id;
    if (sub) await get(`/subscribers/${sub}/orders?from=${new Date(Date.now() - 365 * 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`);
    if (o?.region) await get(`/dashboard/top-devices/${encodeURIComponent(o.region)}`);
  }
}

/** One device swap on the first order: the Top-N recompute path. */
async function swapDevice(src, id, failed) {
  const o = await src.collection('orders').findOne({ _id: id });
  const from = o?.lines.find((l) => l.kind === 'device')?.sku;
  const to = (await src.collection('catalog').find({ kind: 'device', _id: { $nin: o?.lines.map((l) => l.sku) ?? [] } })
    .sort({ _id: 1 }).limit(1).toArray())[0]?._id;
  if (!from || !to) return;
  const r = await app('PATCH', `/orders/${id.toHexString()}`, { deviceSwap: { from, to } });
  if (r.status !== 200) failed.push(`PATCH deviceSwap ${r.status}`);
}

/**
 * Drive the traffic with profiling on, then turn it off, read the entries of
 * the two clients, and undo the writes.
 */
export async function capture(ctx) {
  const src = await ctx.mongoSrc();
  if ((await profilerLevel(src)) !== 2) throw new Error(`profiling is off: run ${PROFILE_ON_CMD}`);
  const h = await app('GET', '/health');
  if (h.body?.backend !== 'mongodb') {
    await src.command({ profile: 0 });
    throw new Error(`the order service writes to ${h.body?.backend ?? 'nothing'}, not the MongoDB source: run ./lab.sh app-uri mongo, then step 2 again`);
  }
  const top = await src.collection('regionTopDevices').find().toArray();
  const t0 = Date.now();
  let w = { ids: [], failed: [] };
  const failed = [];
  let reportRows = 0;
  try {
    w = await placeOrders(ctx, PLAN);
    failed.push(...w.failed);
    if (w.ids.length) await swapDevice(src, w.ids[0], failed);
    await readBack(w.ids, failed);
    reportRows = (await runReport()).length;
  } finally {
    await src.command({ profile: 0 });
    const docs = await src.collection('system.profile')
      .find({ appName: { $in: [APP_NAME, REPORT_NAME] }, ts: { $gte: new Date(t0 - 1000) } }).toArray();
    // Undo, with profiling off: D1 leaves the source as it found it.
    if (w.ids.length) {
      await src.collection('orders').deleteMany({ _id: { $in: w.ids } });
      await src.collection('orderEvents').deleteMany({ orderId: { $in: w.ids } });
    }
    for (const d of top) await src.collection('regionTopDevices').replaceOne({ _id: d._id }, d, { upsert: true });
    await src.collection('system.profile').drop().catch(() => {});
    capture.last = { docs, placed: w.ids.length, updated: w.updated ?? 0, failed, reportRows, ms: Date.now() - t0 };
  }
  return capture.last;
}

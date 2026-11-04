// D5: three ways to serve "top 10 devices selling right now, per region".
//
//   embedded   one counter document per region (regionDeviceCounts) holding
//              every device it sold: each order is one $inc on its device's
//              entry ($push for a first sale), no re-sort. The read fetches the
//              whole document and the client sorts it and keeps the top 10.
//              Writes go through the Oracle API for MongoDB.
//   lookup     the order insert plus $inc on one counter document per device
//              (deviceSales, {_id: "R03:SKU-...", region, sku, units}); the
//              dashboard read is the app's own pipeline over those counters
//              ($match, $sort, $limit, $lookup the catalog for the name).
//   converged  the order insert plus a MERGE into one narrow device_sales row,
//              in one SQL transaction; the dashboard document is read from
//              region_top_devices_v over the pre-sorted device_sales_topn index.
//
// Every variant writes the same order documents into MIG.orders. readDashboard
// returns the dashboard's projected shape, {_id, top:[{sku, name, units}]},
// with units as Int32 in all three (a SQL NUMBER reads back as a Double), so
// the three documents compare equal with sameDocs.
// Ties: units descending, then sku ascending (gen/model.mjs topDevices()).
import { readFileSync } from 'node:fs';
import { BSON, Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { mulberry32 } from '../../gen/model.mjs';

const { EJSON } = BSON;
export const TOP_N = 10;

/** The dashboard's projected shape: {_id, top:[{sku, name, units: Int32}]}. */
export const dashboard = (_id, top) => ({
  _id,
  top: (top ?? []).map((t) => ({ sku: String(t.sku), name: String(t.name), units: new Int32(Number(t.units)) })),
});

// ---------------------------------------------------------------- the orders

// Every D5 order _id starts with one timestamp no generated or live order
// uses (2026-10-02T00:00:00Z) and the marker d5d5d5d5, so reset can remove
// exactly the orders D5 placed with one range delete.
const D5_TS = Math.floor(Date.UTC(2026, 9, 2) / 1000).toString(16);
export const D5_ID_RANGE = {
  $gte: new ObjectId(`${D5_TS}d5d5d5d500000000`),
  $lte: new ObjectId(`${D5_TS}d5d5d5d5ffffffff`),
};
const d5Id = (i) => new ObjectId(`${D5_TS}d5d5d5d5${i.toString(16).padStart(8, '0')}`);

const cents = (d) => Math.round(Number(d.toString()) * 100);

/**
 * `n` order documents, the same for a given seed, shaped exactly like the
 * order service builds them (app/store.mjs placeOrder). Every order has one
 * device line, drawn with the generator's popularity skew per region, so most
 * orders bump a device already in the Top 10 and some push a new one in.
 * @param {import('mongodb').Db} db the Oracle API for MongoDB (MIG)
 */
export async function seededOrders(db, { n = 200, seed }) {
  const rand = mulberry32(seed + 5);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const catalog = await db.collection('catalog').find({}, { sort: { _id: 1 } }).toArray();
  const devices = catalog.filter((c) => c.kind === 'device');
  const plans = catalog.filter((c) => c.kind === 'plan');
  const weights = devices.map((_, j) => 1 / (j + 1) ** 0.9);
  const total = weights.reduce((s, w) => s + w, 0);
  const rank = () => {
    let x = rand() * total, j = 0;
    while (x >= weights[j] && j < weights.length - 1) x -= weights[j++];
    return j;
  };
  const picks = Array.from({ length: n }, () => {
    const subId = `S${String(int(1, 30_000)).padStart(6, '0')}`;
    return { subId, rank: rank(), qty: rand() < 0.85 ? 1 : int(2, 3), plan: rand() < 0.5 ? plans[int(0, plans.length - 1)] : null };
  });
  const subs = new Map((await db.collection('subscribers')
    .find({ _id: { $in: [...new Set(picks.map((p) => p.subId))] } }).toArray()).map((s) => [s._id, s]));
  return picks.map((p, i) => {
    const sub = subs.get(p.subId);
    if (!sub) throw new Error(`subscriber ${p.subId} is missing from MIG: run ./lab.sh reset d5`);
    const dev = devices[(p.rank + 7 * (Number(sub.region.slice(1)) - 1)) % devices.length];
    const lines = [{ sku: dev._id, kind: 'device', qty: new Int32(p.qty), price: dev.price }];
    if (p.plan) lines.push({ sku: p.plan._id, kind: 'plan', qty: new Int32(1), price: p.plan.price });
    const sum = lines.reduce((s, l) => s + Number(l.qty) * cents(l.price), 0);
    return {
      _id: d5Id(i),
      subscriber: { id: sub._id, name: sub.name, tier: sub.tier, address: sub.address },
      region: sub.region,
      status: 'placed',
      lines,
      total: Decimal128.fromString((sum / 100).toFixed(2)),
      placedAt: new Date(Date.UTC(2026, 9, 2) + i * 1000),
      version: Long.fromNumber(1),
    };
  });
}

// ---------------------------------------------------------------- (a) embedded

/** (a)'s documents: one per region, every device it sold, unsorted. */
export const EMBEDDED = 'regionDeviceCounts';
const bySales = (a, b) => Number(b.units) - Number(a.units) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

export const embedded = {
  id: 'embedded',
  surface: 'mongo',
  /** Order insert, then one $inc on the device's entry (a $push, with its name, for a first sale). */
  async placeOrder(db, order) {
    await db.collection('orders').insertOne(order);
    const c = db.collection(EMBEDDED);
    for (const l of order.lines) {
      if (l.kind !== 'device') continue;
      const qty = new Int32(Number(l.qty));
      const r = await c.updateOne({ _id: order.region, 'devices.sku': l.sku }, { $inc: { 'devices.$.units': qty } });
      if (r.matchedCount) continue;
      const dev = await db.collection('catalog').findOne({ _id: l.sku }, { projection: { name: 1 } });
      await c.updateOne({ _id: order.region, 'devices.sku': { $ne: l.sku } },
        { $push: { devices: { sku: l.sku, name: dev?.name ?? l.sku, units: qty } } });
    }
  },
  /** The whole document, sorted and cut to 10 here, in the client. */
  async readDashboard(db, region) {
    const d = await db.collection(EMBEDDED).findOne({ _id: region });
    if (!d) throw new Error(`no ${EMBEDDED} document for ${region}`);
    return dashboard(d._id, [...d.devices].sort(bySales).slice(0, TOP_N));
  },
  readTarget: (region) => [EMBEDDED, { _id: region }],
};

/** (a)'s documents rebuilt to match device_sales (the converged counters, built from the orders). */
export async function buildEmbedded(db, conn) {
  const rows = (await conn.execute(
    'select ds.region_id, ds.sku, d.name, ds.units from device_sales ds join device d on d.sku = ds.sku order by ds.region_id, ds.sku')).rows;
  const per = new Map();
  for (const [region, sku, name, units] of rows) {
    if (!per.has(region)) per.set(region, []);
    per.get(region).push({ sku, name, units: new Int32(Number(units)) });
  }
  const c = db.collection(EMBEDDED);
  if (!(await db.listCollections({ name: EMBEDDED }).toArray()).length) await db.createCollection(EMBEDDED);
  await c.deleteMany({});
  await c.insertMany([...per].map(([region, devices]) => ({ _id: region, devices })));
  return per.size;
}

// ---------------------------------------------------------------- (b) lookup

/** (b)'s counters: one document per region and device, kept with $inc. */
export const COUNTERS = 'deviceSales';
export const counterId = (region, sku) => `${region}:${sku}`;

export const lookupPipeline = (region) => [
  { $match: { region } },
  { $sort: { units: -1, sku: 1 } },
  { $limit: TOP_N },
  { $lookup: { from: 'catalog', localField: 'sku', foreignField: '_id', as: 'device' } },
  { $project: { _id: 0, sku: 1, name: { $arrayElemAt: ['$device.name', 0] }, units: 1 } },
];

/** The same Top 10 counted from the orders themselves: setup's independent check of the starting truth. */
export const recountPipeline = (region) => [
  { $match: { region } },
  { $unwind: '$lines' },
  { $match: { 'lines.kind': 'device' } },
  { $group: { _id: '$lines.sku', units: { $sum: '$lines.qty' } } },
  { $sort: { units: -1, _id: 1 } },
  { $limit: TOP_N },
  { $lookup: { from: 'catalog', localField: '_id', foreignField: '_id', as: 'device' } },
  { $project: { _id: 0, sku: '$_id', name: { $arrayElemAt: ['$device.name', 0] }, units: 1 } },
];

export const lookup = {
  id: 'lookup',
  surface: 'mongo',
  /** The order insert, then $inc on the region's counter document for each device line. */
  async placeOrder(db, order) {
    await db.collection('orders').insertOne(order);
    for (const l of order.lines) {
      if (l.kind !== 'device') continue;
      await db.collection(COUNTERS).updateOne({ _id: counterId(order.region, l.sku) },
        { $inc: { units: Number(l.qty) }, $setOnInsert: { region: order.region, sku: l.sku } }, { upsert: true });
    }
  },
  async readDashboard(db, region) {
    const rows = await db.collection(COUNTERS).aggregate(lookupPipeline(region)).toArray();
    // $sort carries the tie rule; the $lookup stage keeps the order.
    return dashboard(region, rows);
  },
  readTarget: (region) => [COUNTERS, lookupPipeline(region)],
};

/** Setup's check: the region's Top 10 recounted from its orders. */
export async function recountDashboard(db, region) {
  return dashboard(region, await db.collection('orders').aggregate(recountPipeline(region)).toArray());
}

/** (b)'s counters rebuilt to match device_sales (the converged counters, built from the orders). */
export async function buildCounters(db, conn) {
  const rows = (await conn.execute('select region_id, sku, units from device_sales')).rows;
  const c = db.collection(COUNTERS);
  if (!(await db.listCollections({ name: COUNTERS }).toArray()).length) await db.createCollection(COUNTERS);
  await c.deleteMany({});
  await c.insertMany(rows.map(([region, sku, units]) => ({ _id: counterId(region, sku), region, sku, units: new Int32(Number(units)) })));
  await c.createIndex({ region: 1, units: -1, sku: 1 });
  return rows.length;
}

// ---------------------------------------------------------------- (c) converged

const MERGE_SQL = `MERGE INTO device_sales ds
  USING (SELECT :region region_id, :sku sku, :qty qty FROM dual) x
     ON (ds.region_id = x.region_id AND ds.sku = x.sku)
   WHEN MATCHED THEN UPDATE SET ds.units = ds.units + x.qty
   WHEN NOT MATCHED THEN INSERT (region_id, sku, units) VALUES (x.region_id, x.sku, x.qty)`;

// The order goes in as Oracle extended JSON (canonical EJSON, JSON(... EXTENDED)),
// so it is stored with the same types the MongoDB API stores: ObjectId,
// Int32, Int64, Decimal128, Date.
const INSERT_ORDER_SQL = 'INSERT INTO "orders" (data) VALUES (JSON(:doc EXTENDED))';

export const DASHBOARD_SQL =
  'SELECT JSON_SERIALIZE(v.data) FROM region_top_devices_v v WHERE v.data."_id".string() = :region';

export const converged = {
  id: 'converged',
  surface: 'sql',
  /** Order insert plus one counter-row MERGE per device line, one transaction. */
  async placeOrder(conn, order) {
    try {
      await conn.execute(INSERT_ORDER_SQL, { doc: EJSON.stringify(order, { relaxed: false }) });
      for (const l of order.lines) {
        if (l.kind === 'device') await conn.execute(MERGE_SQL, { region: order.region, sku: l.sku, qty: Number(l.qty) });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  },
  async readDashboard(conn, region) {
    const r = await conn.execute(DASHBOARD_SQL, { region });
    const text = r.rows[0]?.[0];
    if (!text) throw new Error(`no dashboard row for ${region} in region_top_devices_v`);
    const d = JSON.parse(text);
    return dashboard(d._id, d.top);
  },
  // The plan step explains the read the app makes: findOne on the JSON view
  // through the MongoDB API, and the SQL the API generates for it.
  readTarget: (region) => ['region_top_devices_v', { _id: region }],
};

export const VARIANTS = { embedded, lookup, converged };

// ---------------------------------------------------------------- the schema

const SQL_FILE = new URL('../../oracle/sql/d5-converged.sql', import.meta.url);

/** Statements of d5-converged.sql: each ends with a line holding only "/". */
export const CONVERGED_STATEMENTS = readFileSync(SQL_FILE, 'utf8')
  .split(/^\/\s*$/m)
  .map((s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
  .filter(Boolean);

/** Drop and rebuild region, device, device_sales and both views from MIG's collections. */
export async function buildConverged(conn) {
  for (const s of CONVERGED_STATEMENTS) await conn.execute(s);
  await conn.commit();
}

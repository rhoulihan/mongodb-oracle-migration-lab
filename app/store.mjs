// Data access for the order service. Written the way a typical MongoDB app is
// written: find, insertOne, updateOne with $set/$inc/$push/$sort/$slice, and
// nothing exotic, so the same code runs on MongoDB and on the Oracle API for
// MongoDB once the URI is flipped.
//
// regionTopDevices (the embedded Top-N, D5(a)) is kept exact on every write,
// with the ordering topDevices() in gen/model.mjs uses: units descending, then
// sku ascending, first 10.
//   A device already in the Top 10 gets $inc, then the array is re-sorted with
//   $push {$each: [], $sort, $slice}.
//   A device outside the Top 10 can only have entered it now, so its exact
//   region total is counted from orders and it is pushed in if it beats the
//   10th entry. Devices outside the Top 10 are never stored, and none of them
//   can pass a member without a write that names it.
//   A device swap takes units away from a device, which can let an outsider
//   in, so it recomputes that region's Top 10 from orders.
// Writes for one region run one at a time (a lock per region), so a count
// never sees an order whose Top-N update has not run yet. This holds for one
// app process, which is how the lab runs it.
import { Decimal128, Int32, Long, ObjectId, Timestamp } from 'mongodb';

export const ORDER_STATUSES = ['placed', 'provisioned', 'shipped', 'activated'];
const TOP_N = 10;
const TOP_SORT = { units: -1, sku: 1 };

export class InputError extends Error {}
export class NotFound extends Error {}

const cents = (d) => Math.round(Number(d.toString()) * 100);
const money = (c) => Decimal128.fromString((c / 100).toFixed(2));
const totalOf = (lines) => money(lines.reduce((s, l) => s + Number(l.qty) * cents(l.price), 0));
const ranksAbove = (a, b) => a.units > b.units || (a.units === b.units && a.sku < b.sku);

export function createStore(db) {
  const orders = db.collection('orders');
  const events = db.collection('orderEvents');
  const catalog = db.collection('catalog');
  const subscribers = db.collection('subscribers');
  const top = db.collection('regionTopDevices');

  const locks = new Map();
  function withRegion(region, fn) {
    const prev = locks.get(region) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(region, tail);
    tail.then(() => { if (locks.get(region) === tail) locks.delete(region); });
    return run;
  }

  const event = (orderId, type) => {
    const now = new Date();
    return events.insertOne({
      orderId, type, ts: new Timestamp({ t: Math.floor(now.getTime() / 1000), i: 1 }), createdAt: now,
    });
  };

  // Exact units of one device in one region, summed from the order lines.
  async function unitsOf(region, sku) {
    let units = 0;
    const cur = orders.find({ region, 'lines.sku': sku }, { projection: { lines: 1 } });
    for await (const o of cur) {
      for (const l of o.lines) if (l.sku === sku && l.kind === 'device') units += Number(l.qty);
    }
    return units;
  }

  async function bumpTop(region, sku, name, qty) {
    const doc = await top.findOne({ _id: region });
    if (!doc) return recomputeTop(region);
    if (doc.top.some((t) => t.sku === sku)) {
      await top.updateOne({ _id: region, 'top.sku': sku }, { $inc: { 'top.$.units': new Int32(qty) } });
      await top.updateOne({ _id: region }, { $push: { top: { $each: [], $sort: TOP_SORT, $slice: TOP_N } } });
      return;
    }
    const entry = { sku, units: await unitsOf(region, sku) };
    const last = doc.top[doc.top.length - 1];
    if (doc.top.length < TOP_N || ranksAbove(entry, { sku: last.sku, units: Number(last.units) })) {
      await top.updateOne({ _id: region, 'top.sku': { $ne: sku } }, {
        $push: { top: { $each: [{ sku, name, units: new Int32(entry.units) }], $sort: TOP_SORT, $slice: TOP_N } },
      });
    }
  }

  async function recomputeTop(region) {
    const units = new Map();
    for await (const o of orders.find({ region }, { projection: { lines: 1 } })) {
      for (const l of o.lines) if (l.kind === 'device') units.set(l.sku, (units.get(l.sku) ?? 0) + Number(l.qty));
    }
    const best = [...units].map(([sku, u]) => ({ sku, units: u }))
      .sort((a, b) => (ranksAbove(a, b) ? -1 : ranksAbove(b, a) ? 1 : 0))
      .slice(0, TOP_N);
    const names = new Map((await catalog.find({ _id: { $in: best.map((b) => b.sku) } })
      .project({ name: 1 }).toArray()).map((c) => [c._id, c.name]));
    await top.updateOne({ _id: region }, {
      $set: { top: best.map((b) => ({ sku: b.sku, name: names.get(b.sku), units: new Int32(b.units) })) },
    }, { upsert: true });
  }

  function parseId(id) {
    if (!ObjectId.isValid(id) || String(id).length !== 24) throw new InputError(`bad order id ${id}`);
    return new ObjectId(id);
  }

  return {
    async getOrder(id) {
      const o = await orders.findOne({ _id: parseId(id) });
      if (!o) throw new NotFound(`order ${id} not found`);
      return o;
    },

    async placeOrder(body) {
      const { subscriberId, lines } = body ?? {};
      if (typeof subscriberId !== 'string') throw new InputError('subscriberId is required');
      if (!Array.isArray(lines) || lines.length === 0) throw new InputError('lines must be a non-empty array');
      for (const l of lines) {
        if (typeof l?.sku !== 'string') throw new InputError('every line needs a sku');
        if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 100) throw new InputError(`qty for ${l.sku} must be 1 to 100`);
      }
      const skus = lines.map((l) => l.sku);
      if (new Set(skus).size !== skus.length) throw new InputError('each sku may appear once');

      const sub = await subscribers.findOne({ _id: subscriberId });
      if (!sub) throw new InputError(`unknown subscriber ${subscriberId}`);
      const items = new Map((await catalog.find({ _id: { $in: skus } }).toArray()).map((c) => [c._id, c]));
      const missing = skus.filter((s) => !items.has(s));
      if (missing.length) throw new InputError(`unknown sku ${missing.join(', ')}`);

      const orderLines = lines.map((l) => {
        const c = items.get(l.sku);
        return { sku: c._id, kind: c.kind, qty: new Int32(l.qty), price: c.price };
      });
      const order = {
        _id: new ObjectId(),
        subscriber: { id: sub._id, name: sub.name, tier: sub.tier, address: sub.address },
        region: sub.region,
        status: 'placed',
        lines: orderLines,
        total: totalOf(orderLines),
        placedAt: new Date(),
        version: Long.fromNumber(1),
      };
      await withRegion(order.region, async () => {
        await orders.insertOne(order);
        for (const l of orderLines) {
          if (l.kind === 'device') await bumpTop(order.region, l.sku, items.get(l.sku).name, Number(l.qty));
        }
      });
      await event(order._id, 'placed');
      return { _id: order._id };
    },

    async patchOrder(id, body) {
      const _id = parseId(id);
      const { status, deviceSwap } = body ?? {};
      if (status === undefined && deviceSwap === undefined) throw new InputError('send status or deviceSwap');
      if (status !== undefined && !ORDER_STATUSES.includes(status)) {
        throw new InputError(`status must be one of ${ORDER_STATUSES.join(', ')}`);
      }
      if (deviceSwap !== undefined && (typeof deviceSwap?.from !== 'string' || typeof deviceSwap?.to !== 'string')) {
        throw new InputError('deviceSwap needs from and to skus');
      }
      const first = await orders.findOne({ _id }, { projection: { region: 1 } });
      if (!first) throw new NotFound(`order ${id} not found`);

      await withRegion(first.region, async () => {
        const set = {};
        if (status !== undefined) set.status = status;
        if (deviceSwap) {
          const o = await orders.findOne({ _id });
          const { from, to } = deviceSwap;
          if (!o.lines.some((l) => l.sku === from && l.kind === 'device')) {
            throw new InputError(`order has no device line ${from}`);
          }
          if (o.lines.some((l) => l.sku === to)) throw new InputError(`order already has ${to}`);
          const dev = await catalog.findOne({ _id: to, kind: 'device' });
          if (!dev) throw new InputError(`${to} is not a device`);
          const lines = o.lines.map((l) => (l.sku === from ? { ...l, sku: to, price: dev.price } : l));
          Object.assign(set, { 'lines.$.sku': to, 'lines.$.price': dev.price, total: totalOf(lines) });
        }
        const filter = deviceSwap ? { _id, 'lines.sku': deviceSwap.from } : { _id };
        await orders.updateOne(filter, { $set: set, $inc: { version: Long.fromNumber(1) } });
        if (deviceSwap) await recomputeTop(first.region);
      });
      if (status !== undefined) await event(_id, status);
      return orders.findOne({ _id });
    },

    async topDevices(region) {
      const doc = await top.findOne({ _id: region });
      if (!doc) throw new NotFound(`no Top-N for region ${region}`);
      return doc;
    },

    // buildInfo from a real mongod carries gitVersion; the Oracle API for
    // MongoDB answers with only {version, versionArray} (7.0.22 on 26ai Free)
    // and names itself through serverStatus.ordsVersion.
    async health() {
      const bi = await db.command({ buildInfo: 1 });
      if (bi.gitVersion) return { backend: 'mongodb', ok: true, version: bi.version };
      const ss = await db.command({ serverStatus: 1 });
      if (ss.ordsVersion) return { backend: 'oracle', ok: true, version: bi.version, ordsVersion: ss.ordsVersion };
      return { backend: 'unknown', ok: false, version: bi.version };
    },
  };
}

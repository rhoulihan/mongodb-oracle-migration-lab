// D2 age-out against the live stack: entity-only migration, the order service
// in age-out mode (new writes to Oracle, old orders read from MongoDB), the
// merged cross-cutoff read, and carts expiring in MongoDB on their own. Then
// every demo step in order. Leaves the lab at the D2 starting state (reset).
import { afterAll, beforeAll, describe, expect, test } from './live.mjs';
import { createContext, runDemo } from '../../demos/contract.mjs';
import d2, { ENTITIES, D2_TAG } from '../../demos/d2-ageout/index.mjs';
import { migrateEntities } from '../../demos/d2-ageout/migrate-entities.mjs';
import { app, switchApp } from '../../demos/d3-dump-restore/index.mjs';
import { createStore } from '../../app/store.mjs';
import { makeRouter } from '../../app/router.mjs';
import { topDevices } from '../../gen/model.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (id) => id.toHexString();

let ctx, src, ora, migrated, cutoff, sub;

beforeAll(async () => {
  ctx = createContext();
  src = await ctx.mongoSrc();
  ora = await ctx.oraMongo();
  await d2.setup(ctx);
  migrated = await migrateEntities();
  const h = await switchApp('ageout');
  cutoff = new Date(h.cutoff);
  // A subscriber with a few orders before the cutoff.
  for await (const s of src.collection('subscribers').find({}, { projection: { _id: 1 } }).sort({ _id: 1 })) {
    if (await src.collection('orders').countDocuments({ 'subscriber.id': s._id, placedAt: { $lt: cutoff } }) >= 3) { sub = s._id; break; }
  }
}, 300_000);

afterAll(async () => {
  try { await d2.reset(ctx); } finally { await ctx.close(); }
}, 120_000);

describe('D2 entity-only migration', () => {
  test('Oracle gets regions, catalog, accounts and subscribers, as many as the source; no orders, carts or events', async () => {
    expect(migrated.map((m) => m.coll).sort()).toEqual([...ENTITIES].sort());
    for (const { coll, count } of migrated) {
      expect(count, coll).toBeGreaterThan(0); // Ruling Q: never the silent zero
      expect(await ora.collection(coll).countDocuments(), coll).toBe(await src.collection(coll).countDocuments());
    }
    for (const coll of ['orders', 'carts', 'orderEvents']) {
      expect(await ora.collection(coll).countDocuments(), coll).toBe(0);
    }
  });
});

describe('D2 age-out mode', () => {
  test('the cutoff comes from the data: just after the newest order on the source', async () => {
    const newest = await src.collection('orders').find().sort({ placedAt: -1 }).limit(1).next();
    expect(cutoff.getTime()).toBe(newest.placedAt.getTime() + 1);
    const h = await app('GET', '/health');
    expect(h.body).toMatchObject({ backend: 'ageout', ok: true, cutoff: cutoff.toISOString() });
    expect(h.body.legacy.backend).toBe('mongodb');
    expect(h.body.current.backend).toBe('oracle');
    // Asking again picks the same cutoff (no clock involved).
    expect((await switchApp('ageout')).cutoff).toBe(cutoff.toISOString());
  });

  test('a new order placed through the app lands in Oracle, not MongoDB', async () => {
    expect(sub).toBeDefined();
    const dev = await ora.collection('catalog').findOne({ kind: 'device' });
    const r = await app('POST', '/orders', { subscriberId: sub, lines: [{ sku: dev._id, qty: 1 }] });
    expect(r.status).toBe(201);
    const id = r.body._id;
    await ora.collection('orders').updateOne({ _id: id }, { $set: { [D2_TAG]: true } });
    expect(await ora.collection('orders').countDocuments({ _id: id })).toBe(1);
    expect(await src.collection('orders').countDocuments({ _id: id })).toBe(0);
    // The router reads it back from Oracle, and an old order from MongoDB.
    expect((await app('GET', `/orders/${hex(id)}`)).status).toBe(200);
    const old = await src.collection('orders').findOne({ 'subscriber.id': sub });
    expect((await app('GET', `/orders/${hex(old._id)}`)).body._id.equals(old._id)).toBe(true);
    // Old orders are a read-only archive.
    expect((await app('PATCH', `/orders/${hex(old._id)}`, { status: 'shipped' })).status).toBe(400);
  });

  test("Oracle's Top-N stays exact for the orders Oracle holds", async () => {
    const orders = await ora.collection('orders').find().toArray();
    const regions = [...new Set(orders.map((o) => o.region))].map((_id) => ({ _id }));
    const catalog = await ora.collection('catalog').find().toArray();
    const want = topDevices(orders, catalog, regions);
    for (const w of want) {
      const got = await ora.collection('regionTopDevices').findOne({ _id: w._id });
      expect(got.top.map((t) => [t.sku, Number(t.units)]), w._id).toEqual(w.top.map((t) => [t.sku, Number(t.units)]));
    }
  });

  test('listOrders across the cutoff returns the union of both sides by _id, newest first', async () => {
    const from = new Date(cutoff.getTime() - 200 * 86_400_000), to = new Date(Date.now() + 3_600_000);
    const r = await app('GET', `/subscribers/${sub}/orders?from=${from.toISOString()}&to=${to.toISOString()}`);
    expect(r.status).toBe(200);
    const legacy = await src.collection('orders').find({ 'subscriber.id': sub, placedAt: { $gte: from, $lt: cutoff } }).toArray();
    const current = await ora.collection('orders').find({ 'subscriber.id': sub, placedAt: { $gte: cutoff, $lt: to } }).toArray();
    expect(legacy.length).toBeGreaterThanOrEqual(3);
    expect(current.length).toBeGreaterThanOrEqual(1);
    const union = [...new Set([...legacy, ...current].map((o) => hex(o._id)))].sort();
    expect(r.body.map((o) => hex(o._id)).sort()).toEqual(union);
    const times = r.body.map((o) => o.placedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test('the router in-process gives the same merged read', async () => {
    const router = makeRouter({ legacy: src, current: ora, cutoff });
    const merged = await router.listOrders({ subscriberId: sub });
    const viaApp = await app('GET', `/subscribers/${sub}/orders`);
    expect(merged.map((o) => hex(o._id))).toEqual(viaApp.body.map((o) => hex(o._id)));
    expect(Object.keys(router).sort()).toEqual(Object.keys(createStore(src)).sort());
  });
});

describe('D2 carts expire in MongoDB', () => {
  test('a cart with updatedAt = now - 125 s is gone within 15 s (TTL 120 s, monitor every 5 s)', async () => {
    const carts = src.collection('carts');
    const _id = 'CART-D2-TEST';
    await carts.replaceOne({ _id }, { _id, subscriberId: sub, items: [], updatedAt: new Date(Date.now() - 125_000) }, { upsert: true });
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000 && (await carts.countDocuments({ _id })) > 0) await sleep(500);
    expect(await carts.countDocuments({ _id })).toBe(0);
  }, 20_000);
});

describe('D2 demo steps', () => {
  test('the steps are migrate-entities, set-cutoff, new-order, cross-cutoff-read, ttl-expiry', () => {
    expect(d2.steps.map((s) => [s.id, s.lane])).toEqual([
      ['migrate-entities', 'terminal'], ['set-cutoff', 'terminal'], ['new-order', 'console'],
      ['cross-cutoff-read', 'console'], ['ttl-expiry', 'console'],
    ]);
    expect(d2.steps.find((s) => s.id === 'set-cutoff').command).toBe('./lab.sh app-mode ageout');
    for (const s of d2.steps.filter((x) => x.lane === 'terminal')) expect(s.command).toMatch(/^\.\/lab\.sh /);
  });

  test('setup, then every step passes', async () => {
    await d2.setup(ctx);
    expect((await app('GET', '/health')).body.backend).toBe('mongodb');
    const results = await runDemo(d2, { ctx });
    expect(results.map((r) => [r.ok, r.summary])).toEqual(d2.steps.map(() => [true, expect.any(String)]));
    const byId = Object.fromEntries(d2.steps.map((s, i) => [s.id, results[i]]));
    expect(byId['cross-cutoff-read'].panes.left.length).toBeGreaterThan(0);
    expect(byId['cross-cutoff-read'].panes.right.length).toBeGreaterThan(0);
    const ttl = byId['ttl-expiry'].metrics;
    expect(ttl.after).toBeLessThan(ttl.before);
    expect(ttl.oracleCarts).toBe(0);
  }, 300_000);

  test('reset: the app back on MongoDB, Oracle empty, no D2 orders on the source', async () => {
    await d2.reset(ctx);
    expect((await app('GET', '/health')).body.backend).toBe('mongodb');
    for (const coll of [...ENTITIES, 'orders']) expect(await ora.collection(coll).countDocuments(), coll).toBe(0);
    expect(await src.collection('orders').countDocuments({ [D2_TAG]: true })).toBe(0);
  }, 120_000);
});

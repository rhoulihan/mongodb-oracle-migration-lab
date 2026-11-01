// Order service app against the live stack. The app runs in-process on an
// ephemeral port, pointed (through its URI, the same knob D3 and D4 flip) at a
// scratch database `telco_apptest` on the MongoDB source, loaded with the tiny
// dataset. The real `telco` database is never written.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BSON, Decimal128, Int32, Long, MongoClient } from 'mongodb';
import { config } from '../../lib/config.mjs';
import { load } from '../../gen/generate.mjs';
import { buildDataset, mulberry32, topDevices } from '../../gen/model.mjs';
import { sameDocs } from '../../lib/compare.mjs';
import { startServer } from '../../app/server.mjs';

const { EJSON } = BSON;
const TEST_DB = 'telco_apptest';
const testUri = config.mongoSrcUri.replace('/telco?', `/${TEST_DB}?`);

let server, client, db, data;

async function call(method, path, body) {
  const res = await fetch(server.url + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? EJSON.parse(text, { relaxed: false }) : null };
}

const devices = () => data.catalog.filter((c) => c.kind === 'device');
const subIn = (region) => data.subscribers.find((s) => s.region === region);
const dashboard = async (region) => (await call('GET', `/dashboard/top-devices/${region}`)).body;
const cents = (d) => Math.round(Number(d.toString()) * 100);

beforeAll(async () => {
  expect(testUri).toContain(`/${TEST_DB}?`);
  client = await new MongoClient(testUri, { promoteLongs: false }).connect();
  db = client.db();
  data = buildDataset({ seed: config.seed, scale: 'tiny' });
  await load(db, data);
  server = await startServer({ uri: testUri, port: 0 });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await db?.dropDatabase();
  await client?.close();
});

describe('orders', () => {
  test('POST then GET round-trips an order, total is Decimal128', async () => {
    const sub = data.subscribers[0];
    const [dev] = devices();
    const plan = data.catalog.find((c) => c.kind === 'plan');
    const post = await call('POST', '/orders',
      { subscriberId: sub._id, lines: [{ sku: dev._id, qty: 2 }, { sku: plan._id, qty: 1 }] });
    expect(post.status).toBe(201);
    const id = post.body._id;
    expect(id).toBeInstanceOf(BSON.ObjectId);

    const got = await call('GET', `/orders/${id.toHexString()}`);
    expect(got.status).toBe(200);
    const o = got.body;
    expect(o._id.equals(id)).toBe(true);
    expect(o.total).toBeInstanceOf(Decimal128);
    expect(cents(o.total)).toBe(2 * cents(dev.price) + cents(plan.price));
    expect(o.version).toBeInstanceOf(Long);
    expect(o.status).toBe('placed');
    expect(o.region).toBe(sub.region);
    expect(o.subscriber).toEqual({ id: sub._id, name: sub.name, tier: sub.tier, address: sub.address });
    expect(o.lines.map((l) => [l.sku, l.kind, Number(l.qty)]))
      .toEqual([[dev._id, 'device', 2], [plan._id, 'plan', 1]]);
    expect(o.lines[0].qty).toBeInstanceOf(Int32);

    const ev = await db.collection('orderEvents').find({ orderId: id }).toArray();
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('placed');
    expect(ev[0].ts).toBeInstanceOf(BSON.Timestamp);
    expect(ev[0].createdAt).toBeInstanceOf(Date);
  });

  test('POST increments the region Top-N entry for the device sku', async () => {
    const region = 'R03';
    const before = await dashboard(region);
    const entry = before.top[0];
    const res = await call('POST', '/orders',
      { subscriberId: subIn(region)._id, lines: [{ sku: entry.sku, qty: 3 }] });
    expect(res.status).toBe(201);
    const after = await dashboard(region);
    const now = after.top.find((t) => t.sku === entry.sku);
    expect(Number(now.units)).toBe(Number(entry.units) + 3);
    expect(now.units).toBeInstanceOf(Int32);
  });

  test('two sequential PATCHes both apply', async () => {
    const region = 'R05';
    const sub = subIn(region);
    const [a, b] = devices().slice(10, 12);
    const { body: { _id } } = await call('POST', '/orders',
      { subscriberId: sub._id, lines: [{ sku: a._id, qty: 1 }] });
    const id = _id.toHexString();

    const p1 = await call('PATCH', `/orders/${id}`, { status: 'provisioned' });
    expect(p1.status).toBe(200);
    const p2 = await call('PATCH', `/orders/${id}`, { deviceSwap: { from: a._id, to: b._id } });
    expect(p2.status).toBe(200);

    const o = (await call('GET', `/orders/${id}`)).body;
    expect(o.status).toBe('provisioned');
    expect(o.lines.map((l) => l.sku)).toEqual([b._id]);
    expect(o.lines[0].price.toString()).toBe(b.price.toString());
    expect(cents(o.total)).toBe(cents(b.price));
    expect(o.version.toString()).toBe('3');
    const types = (await db.collection('orderEvents').find({ orderId: _id }).toArray()).map((e) => e.type);
    expect(types.sort()).toEqual(['placed', 'provisioned']);
  });

  test('bad input gets 400, a missing order gets 404', async () => {
    const sub = data.subscribers[0];
    expect((await call('POST', '/orders', { subscriberId: sub._id, lines: [{ sku: 'NOPE', qty: 1 }] })).status).toBe(400);
    expect((await call('POST', '/orders', { subscriberId: 'S999999', lines: [{ sku: devices()[0]._id, qty: 1 }] })).status).toBe(400);
    expect((await call('POST', '/orders', { subscriberId: sub._id, lines: [] })).status).toBe(400);
    expect((await call('POST', '/orders', { subscriberId: sub._id, lines: [{ sku: devices()[0]._id, qty: 0 }] })).status).toBe(400);
    expect((await call('GET', '/orders/000000000000000000000000')).status).toBe(404);
    expect((await call('GET', '/orders/not-an-id')).status).toBe(400);
    expect((await call('PATCH', '/orders/000000000000000000000000', { status: 'shipped' })).status).toBe(404);
    expect((await call('GET', '/dashboard/top-devices/R99')).status).toBe(404);
  });
});

describe('dashboard stays exact over many orders', () => {
  test('sequential, concurrent and swap writes match topDevices() recomputed from orders', async () => {
    const rand = mulberry32(7);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const regions = data.regions.map((r) => r._id);
    const devs = devices();
    const placed = [];

    const expectExact = async (when) => {
      const orders = await db.collection('orders').find().toArray();
      const expected = topDevices(orders, data.catalog, data.regions);
      const actual = await Promise.all(regions.map(dashboard));
      const cmp = sameDocs(actual, expected);
      expect(cmp.diff, when).toBeUndefined();
      expect(cmp.equal, when).toBe(true);
      for (const r of actual) expect(r.top, when).toHaveLength(10);
    };

    // Mostly devices outside the current Top 10, so new entrants and ties
    // (units equal, sku decides) are exercised, not just $inc on members.
    const order = async (region) => {
      const top = (await dashboard(region)).top.map((t) => t.sku);
      const outside = devs.filter((d) => !top.includes(d._id));
      const member = pick(top);
      const dev = rand() < 0.7 ? pick(outside) : devs.find((d) => d._id === member);
      const res = await call('POST', '/orders',
        { subscriberId: subIn(region)._id, lines: [{ sku: dev._id, qty: 1 + Math.floor(rand() * 4) }] });
      expect(res.status).toBe(201);
      placed.push({ id: res.body._id.toHexString(), sku: dev._id, region });
    };

    for (let i = 0; i < 120; i++) await order(pick(regions));
    // Concurrent writes to the same regions: the per-region lock must hold.
    await Promise.all(Array.from({ length: 40 }, (_, i) => order(regions[i % 2])));
    // A burst of the same outside device in one region: without the lock two
    // writers count each other's orders and the entry comes out too high.
    for (const region of regions.slice(2, 4)) {
      const inTop = (await dashboard(region)).top.map((t) => t.sku);
      const dev = devs.find((d) => !inTop.includes(d._id));
      // Staggered starts spread the interleavings across the write path.
      const res = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        new Promise((ok) => setTimeout(ok, i * 2)).then(() => call('POST', '/orders',
          { subscriberId: subIn(region)._id, lines: [{ sku: dev._id, qty: 4 }] }))));
      for (const r of res) {
        expect(r.status).toBe(201);
        placed.push({ id: r.body._id.toHexString(), sku: dev._id, region });
      }
    }
    // Checked before the swaps too: a swap recomputes its region and would
    // hide an error left by the inserts.
    await expectExact('after the inserts');
    // Swaps move units away from a device, which can push it out of the Top 10.
    for (let i = 0; i < 20; i++) {
      const p = placed[Math.floor(rand() * placed.length)];
      const to = pick(devs.filter((d) => d._id !== p.sku));
      const res = await call('PATCH', `/orders/${p.id}`, { deviceSwap: { from: p.sku, to: to._id } });
      expect(res.status).toBe(200);
      p.sku = to._id;
    }

    await expectExact('after the swaps');
  }, 120_000);
});

describe('/health', () => {
  test('reports mongodb against the MongoDB source', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ backend: 'mongodb', ok: true });
  });

  test('reports oracle against the Oracle API for MongoDB (buildInfo pinned)', async () => {
    // Measured on 26ai Free (gvenzl/oracle-free:23.26.3-faststart, ORDS 26.3):
    // buildInfo answers with only a MongoDB-compatible version and no
    // gitVersion; serverStatus carries ordsVersion.
    const ora = await new MongoClient(config.oraMongoUri).connect();
    try {
      const bi = await ora.db().command({ buildInfo: 1 });
      expect(bi).toEqual({ version: '7.0.22', versionArray: [7, 0, 22], ok: 1 });
      const ss = await ora.db().command({ serverStatus: 1 });
      expect(ss.ordsVersion).toMatch(/^26\./);
    } finally { await ora.close(); }

    const s = await startServer({ uri: config.oraMongoUri, port: 0 });
    try {
      const res = await fetch(s.url + '/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ backend: 'oracle', ok: true, version: '7.0.22' });
    } finally { await s.close(); }
  });
});

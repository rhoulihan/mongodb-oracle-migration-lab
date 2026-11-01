// D5 Top-N counter against the live stack: setup (which restores D3's data
// when MIG is empty), then every step. Each write step starts from the same
// truth and places the same 200 seeded orders through its variant, so the
// three dashboards must be identical; then redo per order and the read plans
// are checked. Leaves the lab at the D5 starting state (reset).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createContext, runDemo } from '../../demos/contract.mjs';
import d5, { planChecks } from '../../demos/d5-topn/index.mjs';
import { D5_ID_RANGE, seededOrders } from '../../demos/d5-topn/variants.mjs';
import { canonical } from '../../lib/compare.mjs';

let ctx, results;
const result = (id) => results[d5.steps.findIndex((s) => s.id === id)];

beforeAll(async () => {
  ctx = createContext();
  await d5.setup(ctx);
  results = await runDemo(d5, { ctx });
}, 900_000);

afterAll(async () => {
  try { await d5.reset(ctx); } finally { await ctx.close(); }
}, 300_000);

describe('D5 Top-N counter: embedded vs $lookup vs converged', () => {
  test('the steps are setup, embedded-write, lookup-read, converged, same-shape, mongosh-read', () => {
    expect(d5.steps.map((s) => [s.id, s.lane])).toEqual([
      ['setup', 'console'], ['embedded-write', 'console'], ['lookup-read', 'console'],
      ['converged', 'console'], ['same-shape', 'console'], ['mongosh-read', 'terminal'],
    ]);
    expect(d5.steps.at(-1).command).toBe(
      `./lab.sh mongosh ora --eval 'db.region_top_devices_v.findOne({_id:"R03"})'`);
  });

  test('every step passes', () => {
    expect(results.map((r) => [r.ok, r.summary])).toEqual(d5.steps.map(() => [true, expect.any(String)]));
  });

  test('the seeded orders are the same every time and all carry the D5 _id marker', async () => {
    const db = await ctx.oraMongo();
    const a = await seededOrders(db, { n: 200, seed: ctx.config.seed });
    const b = await seededOrders(db, { n: 200, seed: ctx.config.seed });
    expect(a).toHaveLength(200);
    expect(a.map(canonical)).toEqual(b.map(canonical));
    for (const o of a) {
      expect(o._id.toHexString() >= D5_ID_RANGE.$gte.toHexString()).toBe(true);
      expect(o._id.toHexString() <= D5_ID_RANGE.$lte.toHexString()).toBe(true);
      expect(o.lines.filter((l) => l.kind === 'device')).toHaveLength(1);
    }
  });

  test('readDashboard returns the same document in all three variants for all 8 regions', () => {
    const r = result('same-shape');
    expect(r.ok).toBe(true);
    const left = r.panes.left;
    expect(canonical(left.embedded)).toBe(canonical(left.converged));
    expect(canonical(left.lookup)).toBe(canonical(left.converged));
    expect(left.converged.top).toHaveLength(10);
    expect(r.summary).toMatch(/all 8 region dashboards are identical/);
  });

  test('embedded redo per order is greater than converged redo per order', () => {
    const { redoPerOrder } = result('same-shape').metrics;
    expect(redoPerOrder.converged).toBeGreaterThan(0);
    expect(redoPerOrder.embedded).toBeGreaterThan(redoPerOrder.converged);
  });

  test('the lookup read plan re-aggregates the orders (scans orders, then a GROUP BY)', () => {
    const plan = result('lookup-read').plan.left;
    expect(planChecks.lookup(plan)).toBe(true);
    expect(plan).toMatch(/TABLE ACCESS[^\n]*orders/);
    expect(plan).toMatch(/(HASH|SORT) GROUP BY/);
  });

  test('the converged read plan is an INDEX RANGE SCAN on DEVICE_SALES_TOPN under a STOPKEY', () => {
    const plan = result('converged').plan.left;
    expect(plan).toMatch(/INDEX RANGE SCAN\s*\|\s*DEVICE_SALES_TOPN/);
    expect(plan).toMatch(/(COUNT|WINDOW NOSORT) STOPKEY/);
    expect(planChecks.converged(plan)).toBe(true);
  });

  test('metrics carry redo per order and read time for the deck', () => {
    const m = result('same-shape').metrics;
    expect(m).toEqual({
      redoPerOrder: { embedded: expect.any(Number), lookup: expect.any(Number), converged: expect.any(Number) },
      readMs: { embedded: expect.any(Number), lookup: expect.any(Number), converged: expect.any(Number) },
    });
  });

  test('the dashboard document is readable through the MongoDB API (mongosh-read, verified)', () => {
    const r = result('mongosh-read');
    expect(r.verified).toMatch(/readable through the MongoDB API/);
    expect(r.panes.left.top).toHaveLength(10);
  });

  // Spec: "the duality view covers the write path". A MongoDB API $inc on the
  // region document lands in the one device_sales row (afterAll resets).
  test('a MongoDB API $inc through region_top_devices_dv updates the device_sales row', async () => {
    const db = await ctx.oraMongo(), conn = await ctx.oraSql();
    const doc = await db.collection('region_top_devices_dv').findOne({ _id: 'R01' });
    const { sku } = doc.top[0];
    const units = async () => Number((await conn.execute(
      'select units from device_sales where region_id = :r and sku = :s', { r: 'R01', s: sku })).rows[0][0]);
    const before = await units();
    const r = await db.collection('region_top_devices_dv').updateOne({ _id: 'R01', 'top.sku': sku }, { $inc: { 'top.$.units': 1 } });
    expect(r.modifiedCount).toBe(1);
    expect(await units()).toBe(before + 1);
  });
});

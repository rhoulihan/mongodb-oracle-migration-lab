// D3 dump/restore against the live stack: setup, then every step in order
// (terminal steps run in-process and are verified), then the assertions the
// session promises. Leaves the lab at the D3 starting state (reset).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createContext, runDemo } from '../../demos/contract.mjs';
import d3 from '../../demos/d3-dump-restore/index.mjs';
import { COLLECTIONS } from '../../oracle/prep.mjs';

let ctx, results;
const result = (id) => results[d3.steps.findIndex((s) => s.id === id)];

beforeAll(async () => {
  ctx = createContext();
  await d3.setup(ctx);
  results = await runDemo(d3, { ctx });
}, 600_000);

afterAll(async () => {
  try { await d3.reset(ctx); } finally { await ctx.close(); }
}, 120_000);

describe('D3 dump, restore, flip', () => {
  test('the steps are dump, restore, counts, typediff, flip, smoke, explain', () => {
    expect(d3.steps.map((s) => [s.id, s.lane])).toEqual([
      ['dump', 'terminal'], ['restore', 'terminal'], ['counts', 'console'], ['typediff', 'console'],
      ['flip', 'terminal'], ['smoke', 'console'], ['explain', 'terminal'],
    ]);
    for (const s of d3.steps.filter((x) => x.lane === 'terminal')) expect(s.command).toMatch(/^\.\/lab\.sh /);
  });

  test('every step passes', () => {
    expect(results.map((r) => [r.ok, r.summary])).toEqual(d3.steps.map(() => [true, expect.any(String)]));
  });

  test('restore is timed and restores documents as MIG (never the silent zero)', () => {
    const r = result('restore');
    expect(r.metrics.restoreMs).toBeGreaterThan(0);
    expect(r.metrics.restored).toBeGreaterThan(0);
    expect(r.metrics.failed).toBe(0);
  });

  test('counts match for all 8 collections at the dump snapshot (Ruling J)', () => {
    const rows = result('counts').panes.left;
    expect(rows.map((x) => x.coll).sort()).toEqual([...COLLECTIONS].sort());
    for (const x of rows) {
      // Dump vs restore: one snapshot, exact for every collection.
      expect(x.restored, x.coll).toBe(x.archive);
      if (x.ttl) {
        // carts and orderEvents keep expiring on Oracle (the TTL index came
        // across), so "now" is bounded by the snapshot, never compared to it.
        expect(x.oracle, x.coll).toBeLessThanOrEqual(x.archive);
        expect(x.oracle, x.coll).toBeGreaterThanOrEqual(x.unexpired);
      } else {
        expect(x.archive, x.coll).toBeGreaterThan(0);
        expect(x.oracle, x.coll).toBe(x.archive);
      }
    }
    expect(rows.filter((x) => x.ttl).map((x) => x.coll).sort()).toEqual(['carts', 'orderEvents']);
  });

  describe('the $type differential', () => {
    const rows = () => result('typediff').panes.left;
    const typeRow = (coll, path) => rows().find((x) => x.kind === 'type' && x.coll === coll && x.path === path);
    const valueRow = (coll, path, check) =>
      rows().find((x) => x.kind === 'value' && x.coll === coll && x.path === path && x.check === check);

    test('catalog.skuPattern: regex on the source, the $type query is rejected on Oracle (Ruling P)', () => {
      const r = typeRow('catalog', 'skuPattern');
      expect(r.srcTypes).toContain('regex');
      expect(r.queryCheck.filter).toEqual({ skuPattern: { $type: 'regex' } });
      expect(r.queryCheck.srcCount).toBeGreaterThan(0);
      expect(r.queryCheck.dstCount).toBe('rejected');
    });

    test('orderEvents.ts: a BSON Timestamp on the source reads back as something else', () => {
      const r = typeRow('orderEvents', 'ts');
      expect(r.srcTypes).toEqual(['timestamp']);
      expect(r.dstTypes).not.toContain('timestamp');
      expect(r.queryCheck.srcCount).toBeGreaterThan(0);
      expect(r.queryCheck.dstCount).not.toBe(r.queryCheck.srcCount);
    });

    test('orders.total: no type difference, Decimal128 survives as a type', () => {
      expect(typeRow('orders', 'total')).toBeUndefined();
    });

    test('Decimal128 scale is reported at the value level (Ruling K)', () => {
      const r = valueRow('catalog', 'price', 'decimal scale');
      expect(r).toBeDefined();
      expect(r.changed).toBeGreaterThan(0);
      expect(r.example.src).toMatch(/\.\d*0$/);
      expect(Number(r.example.dst)).toBe(Number(r.example.src));
      expect(valueRow('orders', 'total', 'decimal scale')).toBeDefined();
    });

    test('the planted Int64 2^53+1 version is checked for exactness after restore (Ruling K)', () => {
      const r = valueRow('orders', 'version', 'Int64 above 2^53');
      expect(r.src).toBe('9007199254740993');
      // Measured: mongorestore carries it exactly (the Ruling K loss is on $inc,
      // not on restore). If this fails, record the real behavior in the deck
      // notes and invert the assertion with a comment; do not hide it.
      expect(r.dst).toBe('9007199254740993');
      expect(r.exact).toBe(true);
    });

    test('the table is printed for the CLI and the console', () => {
      expect(result('typediff').detail).toMatch(/skuPattern/);
      expect(result('typediff').detail).toMatch(/rejected/);
    });
  });

  test('the app passes its smoke test on Oracle after the flip', () => {
    expect(result('flip').verified).toMatch(/oracle/);
    const s = result('smoke');
    expect(s.metrics.backend).toBe('oracle');
    expect(s.panes.left.map((c) => [c.call, c.ok])).toEqual([
      ['GET /health', true], ['GET /orders/:id', true], ['POST /orders', true],
      ['PATCH /orders/:id', true], ['GET /orders/:id (after PATCH)', true], ['GET /dashboard/top-devices/:region', true],
    ]);
  });

  test('counts after smoke still match the dump: smoke writes are left out and named', async () => {
    const counts = d3.steps.find((s) => s.id === 'counts');
    const r = await counts.run(ctx);
    expect(r.ok, r.summary).toBe(true);
    expect(r.summary).toMatch(/3 smoke-test documents left out/);
    const byColl = Object.fromEntries(r.panes.left.map((x) => [x.coll, x.smokeExcluded]));
    expect(byColl).toMatchObject({ orders: 1, orderEvents: 2 });
  });

  test('restore verify catches Oracle orders that do not match the dump', async () => {
    const restore = d3.steps.find((s) => s.id === 'restore');
    expect((await restore.verify(ctx)).ok).toBe(true);
    const ora = await ctx.oraMongo();
    const { insertedId } = await ora.collection('orders').insertOne({ region: 'R99', status: 'placed' });
    try {
      const v = await restore.verify(ctx);
      expect(v.ok).toBe(false);
      expect(v.summary).toMatch(/run \.\/lab\.sh reset d3 first/);
    } finally {
      await ora.collection('orders').deleteOne({ _id: insertedId });
    }
  });

  test('explain shows the Oracle plan for the restored index', () => {
    const r = result('explain');
    expect(r.plan.right).toMatch(/SELECT STATEMENT/);
    expect(r.plan.right).toMatch(/INDEX/);
  });
});

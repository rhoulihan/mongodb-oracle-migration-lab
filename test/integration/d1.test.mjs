// D1 against the live MongoDB source: setup, every step, then the findings
// the session promises. D1 reads only; it changes nothing.
import { afterAll, beforeAll, describe, expect, test } from './live.mjs';
import { createContext, runDemo } from '../../demos/contract.mjs';
import d1 from '../../demos/d1-compat/index.mjs';

let ctx, results, ms;
const result = (id) => results[d1.steps.findIndex((s) => s.id === id)];

beforeAll(async () => {
  ctx = createContext();
  const t = Date.now();
  await d1.setup(ctx);
  results = await runDemo(d1, { ctx });
  ms = Date.now() - t;
}, 120_000);

afterAll(async () => { await ctx.close(); });

describe('D1 compatibility check and type census', () => {
  test('the steps are scan and census, both console steps (no offline advisor)', () => {
    expect(d1.steps.map((s) => [s.id, s.lane])).toEqual([['scan', 'console'], ['census', 'console']]);
    expect(d1.steps[0].title).toMatch(/Scripted operator scan \(built for this lab\)/);
  });

  test('every step passes, in under 30 s', () => {
    expect(results.map((r) => [r.ok, r.summary])).toEqual(d1.steps.map(() => [true, expect.any(String)]));
    expect(ms).toBeLessThan(30_000);
  });

  test('scan: the app operators are classified; $inc is supported', () => {
    const r = result('scan');
    const app = r.panes.left;
    expect(app.map((x) => x.op)).toEqual(expect.arrayContaining(['$inc', '$push', '$slice']));
    expect(app.find((x) => x.op === '$inc').status).toBe('supported');
    expect(r.panes.right.find((x) => x.op === '$setWindowFields').status).toBe('unsupported');
    expect(r.panes.right.find((x) => x.op === '$lookup').status).toBe('caveat');
    expect(r.detail).toMatch(/Scripted operator scan/);
    expect(r.detail).toMatch(/demo pipelines/i);
  });

  describe('census', () => {
    const row = (coll, path) => result('census').panes.left.find((x) => x.coll === coll && x.path === path);

    test('catalog.skuPattern: regex, a landmine', () => {
      expect(row('catalog', 'skuPattern').types).toContain('regex');
      expect(row('catalog', 'skuPattern').landmines.join()).toMatch(/regex/);
    });

    test('orderEvents.ts: timestamp, a landmine', () => {
      expect(row('orderEvents', 'ts').types).toEqual(['timestamp']);
      expect(row('orderEvents', 'ts').landmines.join()).toMatch(/timestamp/i);
    });

    test('orders.version: Int64, no landmine; Decimal128 totals; array lines', () => {
      expect(row('orders', 'version').types).toEqual(['long']);
      expect(row('orders', 'version').landmines).toEqual([]);
      expect(row('orders', 'total').landmines.join()).toMatch(/Decimal128/);
      expect(row('orders', 'lines').landmines.join()).toMatch(/\$type/);
    });

    test('plain fields carry no landmine; the table highlights the landmines', () => {
      expect(row('orders', 'status').landmines).toEqual([]);
      const r = result('census');
      expect(r.detail).toMatch(/skuPattern/);
      expect(r.detail).toMatch(/!!/);
      expect(r.metrics.landmines).toBeGreaterThanOrEqual(5);
    });
  });
});

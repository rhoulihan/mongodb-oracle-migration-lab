// D6 pipeline vs $sql against the live stack: setup (which restores D3's data
// when MIG is empty and gathers optimizer statistics), then every step. The
// same question runs three ways: (1) the pipeline on the MongoDB source, for
// its explain (no timing, spec section 6a); (2) the same pipeline on Oracle
// through the MongoDB API, timed; (3) $sql through the MongoDB API, timed.
// Results must be equal before any timing is shown.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContext, runDemo } from '../../demos/contract.mjs';
import d6, { planChecks } from '../../demos/d6-sql/index.mjs';
import { atCents, nativeRankPipeline, pipeline, sqlStage } from '../../demos/d6-sql/queries.mjs';
import { sameDocs } from '../../lib/compare.mjs';
import { prepareTarget } from '../../oracle/prep.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
let ctx, results;
const result = (id) => results[d6.steps.findIndex((s) => s.id === id)];

beforeAll(async () => {
  ctx = createContext();
  await d6.setup(ctx);
  results = await runDemo(d6, { ctx });
}, 1_800_000);

afterAll(async () => {
  try { await d6.reset(ctx); } finally { await ctx.close(); }
}, 600_000);

describe('D6 pipeline vs $sql', () => {
  test('the steps are setup, pipeline-mongo-explain, pipeline-oracle, sql-stage, equal, plans, timing', () => {
    expect(d6.steps.map((s) => [s.id, s.lane])).toEqual([
      ['setup', 'console'], ['pipeline-mongo-explain', 'console'], ['pipeline-oracle', 'console'],
      ['sql-stage', 'terminal'], ['equal', 'console'], ['plans', 'console'], ['timing', 'console'],
    ]);
    expect(d6.steps.find((s) => s.id === 'sql-stage').command).toBe('./lab.sh mongosh ora demos/d6-sql/sql-stage.js');
  });

  test('every step passes', () => {
    expect(results.map((r) => [r.ok, r.summary])).toEqual(d6.steps.map(() => [true, expect.any(String)]));
  });

  test('(1), (2) and (3) return the same 160 rows (5 per region and tier), proven by the equal step', () => {
    const r = result('equal');
    expect(r.ok).toBe(true);
    expect(r.metrics.rows).toBe(160);
    expect(r.summary).toMatch(/^160 rows are identical/);
  });

  test('(1) and (3) are sameDocs-equal here too, sorted by region, tier, rank, after the explicit scale step', async () => {
    const src = await (await ctx.mongoSrc()).collection('orders').aggregate(pipeline).toArray();
    const sql = await (await ctx.oraMongo()).aggregate([sqlStage()]).toArray();
    expect(src).toHaveLength(160);
    const key = (d) => `${d.region} ${d.tier} ${String(d.rank).padStart(2, '0')}`;
    expect(src.map(key)).toEqual([...src.map(key)].sort());
    expect(sql.map(key)).toEqual(src.map(key));
    expect(sameDocs(src.map(atCents), sql.map(atCents))).toEqual({ equal: true });
    // Every spend is Decimal128 on both sides before the scale step.
    for (const d of [...src, ...sql]) expect(d.spend?._bsontype).toBe('Decimal128');
  }, 120_000);

  test('metrics.medianMs exists for (2) and (3) only: no MongoDB timing is collected', () => {
    expect(result('pipeline-oracle').metrics.medianMs).toBeGreaterThan(0);
    expect(result('sql-stage').metrics.medianMs).toBeGreaterThan(0);
    for (const id of ['setup', 'pipeline-mongo-explain', 'equal', 'plans']) {
      expect(result(id).metrics?.medianMs, id).toBeUndefined();
    }
    expect(JSON.stringify(result('pipeline-mongo-explain').metrics ?? {})).not.toMatch(/ms/i);
  });

  test('no timing appears in a summary before the equal step', () => {
    const before = d6.steps.findIndex((s) => s.id === 'equal');
    for (const r of results.slice(0, before)) expect(r.summary).not.toMatch(/\d\s*(ms|s)\b(?! of)/);
  });

  test('the MongoDB explain shows the stage tree with the three $lookup stages', () => {
    const plan = result('pipeline-mongo-explain').plan.left;
    expect(plan.match(/\$lookup|EQ_LOOKUP/g).length).toBeGreaterThanOrEqual(3);
  });

  test('the $sql plan joins (HASH JOIN or NESTED LOOPS) and ranks (WINDOW SORT PUSHED RANK or WINDOW NOSORT)', () => {
    const plan = result('plans').plan.right;
    expect(plan).toMatch(/HASH JOIN|NESTED LOOPS/);
    expect(plan).toMatch(/WINDOW SORT PUSHED RANK|WINDOW NOSORT/);
    expect(planChecks.sql(plan)).toBe(true);
    expect(result('plans').plan.left).toMatch(/orders/);
  });

  test('timing shows both medians and their ratio, after equality', () => {
    const m = result('timing').metrics;
    expect(m).toEqual({ pipelineMs: expect.any(Number), sqlMs: expect.any(Number), ratio: expect.any(Number) });
    expect(m.ratio).toBeCloseTo(m.pipelineMs / m.sqlMs, 0);
    expect(result('timing').summary).toMatch(/laptop/i);
  });

  test('the sql-stage command prints the first 10 rows (verified)', () => {
    expect(result('sql-stage').verified).toMatch(/160 rows/);
    const r = spawnSync('./lab.sh', ['mongosh', 'ora', '--quiet', 'demos/d6-sql/sql-stage.js'], { cwd: root, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/160 rows/);
    const ranked = r.stdout.split('\n').filter((l) => /^\s*R0\d\s/.test(l));
    expect(ranked).toHaveLength(10);
    expect(ranked[0]).toMatch(/^\s*R01\s+basic\s+1\s/);
  }, 120_000);

  // Spike finding (docs/spikes/d6-ratio.md): the Oracle API for MongoDB does
  // not run $setWindowFields, so the portable pipeline ranks with $topN.
  test('the $setWindowFields form of the rank is rejected by the Oracle API', async () => {
    const db = await ctx.oraMongo();
    await expect(db.collection('orders').aggregate(nativeRankPipeline).toArray()).rejects.toThrow(/setWindowFields/);
  });
});

// The console runs steps one at a time (no demo.setup). On an empty MIG the
// setup step must restore D3's data itself.
describe('D6 setup step on an empty MIG (console / --step path)', () => {
  test('the setup step alone restores D3 data and passes', async () => {
    await prepareTarget({ drop: true });
    const [r] = await runDemo(d6, { only: ['setup'], ctx });
    expect(r.ok, r.summary).toBe(true);
    expect(r.summary).toMatch(/orders in the 90-day window/);
  }, 900_000);
});

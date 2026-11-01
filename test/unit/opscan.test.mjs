// D1 operator scan: acorn walk over the app source and the classification
// against compat-matrix.json. No lab needed.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { classify, loadMatrix, scanOperators, formatOperators } from '../../demos/d1-compat/opscan.mjs';

const FIXTURE = 'test/fixtures/opscan/legacy-app.mjs';
const ops = (rows) => rows.map((r) => r.op);

describe('scanOperators', () => {
  test('finds the update and query operators the order service uses', async () => {
    const rows = await scanOperators(['app/**/*.mjs']);
    expect(ops(rows)).toEqual(expect.arrayContaining(['$inc', '$push', '$slice', '$each', '$sort', '$set', '$in']));
    expect(rows.find((r) => r.op === '$inc').files).toEqual(['app/store.mjs']);
  });

  test('the demo pipelines (D5 lookup variant, D6) use $lookup and $group', async () => {
    // The order service itself runs no aggregation (Task 3: find + update
    // only), so $lookup and $group come from the pipelines shown in D5 and D6.
    const app = ops(await scanOperators(['app/**/*.mjs']));
    expect(app).not.toContain('$lookup');
    const demo = await scanOperators(['demos/d5-topn/variants.mjs', 'demos/d6-sql/queries.mjs']);
    expect(ops(demo)).toEqual(expect.arrayContaining(['$lookup', '$group', '$unwind', '$match', '$setWindowFields']));
    expect(demo.find((r) => r.op === '$lookup').files).toEqual(['demos/d5-topn/variants.mjs', 'demos/d6-sql/queries.mjs']);
  });

  test('sees quoted and computed keys, skips field-path strings, sorts by operator', async () => {
    const rows = await scanOperators([FIXTURE]);
    expect(ops(rows)).toEqual(['$geometry', '$near', '$set', '$unset', '$unwind', '$where']);
    expect(ops(rows)).not.toContain('$lines');
  });
});

describe('compat-matrix.json', () => {
  const m = loadMatrix();

  test('names its source file and the date it was copied', () => {
    expect(m.source.file).toMatch(/skills\/mongodb-api-dev\/references\/compat-matrix\.md$/);
    expect(m.source.copied).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('carries the lab\'s own measured findings, dated, with evidence', () => {
    const measured = m.operators.filter((o) => o.source === 'measured in this lab');
    for (const o of measured) {
      expect(o.date, o.op).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.evidence, o.op).toMatch(/\S/);
    }
    const byOp = (op) => measured.find((o) => o.op === op);
    expect(byOp('$setWindowFields').status).toBe('unsupported');
    expect(byOp('$type').status).toBe('caveat');
    expect(byOp('$type').note).toMatch(/regex/);
    expect(byOp('$type').note).toMatch(/array/);
    expect(byOp('$inc').status).toBe('caveat');
    expect(byOp('$inc').note).toMatch(/2\^53/);
    const types = Object.fromEntries(m.types.map((t) => [t.type, t]));
    expect(types.decimal.note).toMatch(/1\.10/);
    expect(types.regex.source).toBe('measured in this lab');
  });

  test('is valid JSON with known statuses only', () => {
    const raw = JSON.parse(readFileSync(new URL('../../demos/d1-compat/compat-matrix.json', import.meta.url), 'utf8'));
    for (const o of raw.operators) expect(['supported', 'caveat', 'unsupported'], o.op).toContain(o.status);
  });
});

describe('classify', () => {
  const m = loadMatrix();

  test('$where and $near from the fixture are unsupported or caveat', async () => {
    const c = classify(await scanOperators([FIXTURE]), m);
    const bad = [...c.unsupported, ...c.caveat].map((r) => r.op);
    expect(bad).toEqual(expect.arrayContaining(['$where', '$near']));
    expect(ops(c.supported)).not.toContain('$where');
  });

  test('a measured entry wins over the reference entry for the same operator', () => {
    const matrix = { default: { status: 'supported', note: 'd' }, operators: [
      { op: '$x', status: 'unsupported', note: 'ref', source: 'compat-matrix.md' },
      { op: '$x', status: 'supported', note: 'seen', source: 'measured in this lab', date: '2026-11-01', evidence: 'e' },
    ] };
    const c = classify([{ op: '$x', files: ['a.mjs'] }], matrix);
    expect(c.supported).toEqual([expect.objectContaining({ op: '$x', files: ['a.mjs'], note: 'seen', source: 'measured in this lab' })]);
  });

  test('an operator the matrix does not name falls back to the default, marked as not listed', () => {
    const c = classify([{ op: '$nobody', files: ['a.mjs'] }], m);
    const all = [...c.supported, ...c.caveat, ...c.unsupported];
    expect(all).toEqual([expect.objectContaining({ op: '$nobody', status: m.default.status, source: 'not listed' })]);
  });

  test('accepts plain operator strings too', () => {
    expect(ops(classify(['$setWindowFields'], m).unsupported)).toEqual(['$setWindowFields']);
  });

  test('formatOperators prints one row per operator with its status', async () => {
    const text = formatOperators(classify(await scanOperators([FIXTURE]), m));
    expect(text).toMatch(/\$where\s+unsupported/);
    expect(text.split('\n').filter((l) => l.startsWith('$'))).toHaveLength(6);
  });
});

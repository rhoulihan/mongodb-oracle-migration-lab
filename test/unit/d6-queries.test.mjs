// D6 query definitions, no stack needed: the window is fixed by the data
// (the generator's ANCHOR), the mongosh script carries the same window and
// reads the same SQL file, and the scale step (Ruling K) is exact.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { Decimal128 } from 'mongodb';
import { ANCHOR } from '../../gen/model.mjs';
import { atCents, pipeline, sqlStage, sqlText, WINDOW } from '../../demos/d6-sql/queries.mjs';

const script = readFileSync(new URL('../../demos/d6-sql/sql-stage.js', import.meta.url), 'utf8');

describe('D6 queries', () => {
  test('the window is the last 90 days of the data, never the wall clock', () => {
    expect(WINDOW.toTs).toEqual(ANCHOR);
    expect(ANCHOR.getTime() - WINDOW.fromTs.getTime()).toBe(90 * 86_400_000);
    expect(pipeline[0]).toEqual({ $match: { placedAt: { $gte: WINDOW.fromTs, $lt: WINDOW.toTs } } });
    expect(sqlStage()).toEqual({ $sql: { statement: sqlText, binds: { fromTs: WINDOW.fromTs, toTs: WINDOW.toTs } } });
  });

  test('the pipeline has the stages the brief names, in order', () => {
    const names = pipeline.map((s) => Object.keys(s)[0]);
    expect(names.filter((n) => ['$match', '$lookup', '$unwind', '$group'].includes(n)).slice(0, 8))
      .toEqual(['$match', '$lookup', '$unwind', '$lookup', '$unwind', '$unwind', '$lookup', '$unwind']);
    expect(pipeline.filter((s) => s.$lookup).map((s) => s.$lookup.from)).toEqual(['subscribers', 'accounts', 'catalog']);
  });

  test('the SQL is a CTE with JSON_TABLE for the lines, joins, RANK and json{...}', () => {
    expect(sqlText).toMatch(/^with /i);
    expect(sqlText).toMatch(/json_table\(o\.data, '\$\.lines\[\*\]'/i);
    expect(sqlText).toMatch(/rank\(\) over \(partition by [^;]*?region[^;]*?tier[^;]*?order by sp\.spend desc/i);
    expect(sqlText).toMatch(/select json \{/i);
    expect(sqlText).not.toMatch(/--|\/\*/); // no comments in the statement sent to the API
  });

  test('sql-stage.js reads top-spenders.sql and binds the same window', () => {
    expect(script).toMatch(/top-spenders\.sql/);
    expect(script).toContain(`new Date('${WINDOW.fromTs.toISOString()}')`);
    expect(script).toContain(`new Date('${WINDOW.toTs.toISOString()}')`);
  });

  test('atCents makes the scale explicit and exact (Ruling K), and refuses anything else', () => {
    const d = (s) => ({ region: 'R01', spend: Decimal128.fromString(s) });
    expect(atCents(d('9718.8')).spend.toString()).toBe('9718.80');
    expect(atCents(d('9718.80')).spend.toString()).toBe('9718.80');
    expect(atCents(d('12')).spend.toString()).toBe('12.00');
    expect(() => atCents(d('1.005'))).toThrow(/more than 2 decimals/);
    expect(() => atCents({ spend: 9718.8 })).toThrow(/Decimal128/);
  });
});

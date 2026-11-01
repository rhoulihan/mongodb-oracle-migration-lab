// condenseExplain on captured explain shapes, no stack needed: the Oracle API
// for MongoDB plan table, a classic plan, an SBE queryPlan, and a pipeline
// that is not fully pushed down ($cursor plus later stages).
import { expect, test } from 'vitest';
import { condenseExplain } from '../../lib/measure.mjs';

// Captured from the Oracle API for MongoDB (26ai Free + ORDS): its operation
// column starts at one space and indents children by two, then one.
const ORA_TABLE = [
  ' Plan Hash Value  : 3396907195 ',
  '',
  '-------------------------------------------------------------------------',
  '| Id  | Operation                             | Name                      | Rows |',
  '-------------------------------------------------------------------------',
  '|   0 | SELECT STATEMENT                      |                           |    1 |',
  '|   1 |   TABLE ACCESS BY INDEX ROWID BATCHED | probeX                    |    1 |',
  '| * 2 |    INDEX RANGE SCAN (MULTI VALUE)     | $ora:probeX.probex_sku_ix |    1 |',
  '-------------------------------------------------------------------------',
].join('\n');

test('Oracle API plan table: one level of indent per tree level, names inline', () => {
  expect(condenseExplain({ queryPlanner: { winningPlan: ORA_TABLE } })).toBe(
    [
      'SELECT STATEMENT',
      '  TABLE ACCESS BY INDEX ROWID BATCHED probeX',
      '    INDEX RANGE SCAN (MULTI VALUE) $ora:probeX.probex_sku_ix',
    ].join('\n'),
  );
});

test('classic plan: stage tree with the index name', () => {
  const wp = { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'sku_1' } };
  expect(condenseExplain({ queryPlanner: { winningPlan: wp } })).toBe('FETCH\n  IXSCAN sku_1');
});

test('SBE plan: reads winningPlan.queryPlan, OR branches as siblings', () => {
  const wp = {
    queryPlan: {
      stage: 'GROUP',
      inputStage: {
        stage: 'OR',
        inputStages: [
          { stage: 'IXSCAN', indexName: 'a_1' },
          { stage: 'IXSCAN', indexName: 'b_1' },
        ],
      },
    },
    slotBasedPlan: { stages: 'ignored' },
  };
  expect(condenseExplain({ queryPlanner: { winningPlan: wp } })).toBe(
    'GROUP\n  OR\n    IXSCAN a_1\n    IXSCAN b_1',
  );
});

test('pipeline not pushed down: $cursor plan, then each later stage', () => {
  const explain = {
    stages: [
      { $cursor: { queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } } },
      { $unwind: { path: '$a' } },
      { $facet: {} },
    ],
  };
  expect(condenseExplain(explain)).toBe('$cursor\n  COLLSCAN\n$unwind\n$facet');
});

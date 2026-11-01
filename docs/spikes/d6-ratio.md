# Spike: pipeline vs `$sql` on Oracle, equal results, plans, relative timing (D6)

Date: 2026-11-01. Database: Oracle AI Database 26ai Free, Release 23.26.3.0.0
(the lab image), ORDS with the Oracle API for MongoDB (reports wire version
7.0.22). Source: MongoDB 8.2. Data: `./lab.sh generate` at `--scale demo`,
seed 20261114, restored by D3.

**Laptop-measured (the Linux lab host, Docker). Relative only.** Do not put
the absolute seconds on a slide. The comparison stays inside one engine:
MongoDB was explained, never timed (spec section 6a).

## The question

Top 5 subscribers by spend per region and plan tier, over the last 90 days,
with plan name. Shared definitions (`demos/d6-sql/queries.mjs`):

- window `placedAt` in [2026-07-03, 2026-10-01): the last 90 days of the
  generated data (`ANCHOR` in `gen/model.mjs`), never the wall clock, so
  orders other demos place live never move it. Bound as two dates on both
  sides. 100,079 orders, about 238,000 order lines.
- region and tier from the subscriber's account; spend = sum of qty * price
  (Decimal128); plan = the plan on the subscriber's latest order in the window
  that has one (latest by `placedAt`, then `_id`); rank 1..5 by spend
  descending, ties broken by subscriber id ascending. 32 groups, 160 rows.

## Findings

1. **`$setWindowFields` is not supported through the Oracle API for MongoDB**
   on this build: `Aggregate stage $setWindowFields not supported`. MongoDB's
   own `$rank` also takes only one sort key (`$rank must be specified with a
   top level sortBy expression with exactly one element`), so it cannot break
   ties by subscriber id anyway. The portable pipeline ranks with `$group` +
   `$topN` (spend desc, subscriber id asc) and `$unwind` with
   `includeArrayIndex`. `$top`, `$topN`, `$firstN`, `$first` after `$sort`,
   `$unwind includeArrayIndex` and Decimal128 `$multiply`/`$sum` all run on
   the API. The rejection is pinned by `test/integration/d6.test.mjs`
   (`nativeRankPipeline`), so a later ORDS release that adds the stage shows up.
2. **Equal results, with one explicit step.** All three runs return the same
   160 rows (subscribers, ranks, names, plans, spend). Oracle keeps a
   Decimal128's value but not its trailing zeros (Ruling K): `9718.80` reads
   back as `9718.8` on 18 of the 160 rows, through the pipeline and through
   `$sql` alike. The demo puts every spend at exactly 2 decimals with exact
   string arithmetic (`atCents`, which refuses anything that is not a
   Decimal128 with at most 2 decimals) before `sameDocs`; `sameDocs` itself is
   unchanged.
3. **`$sql` output typing.** A plain `NUMBER` in `json{...}` comes back
   through the API as a BSON Double; `json_scalar(spend as decimal)` makes it
   Decimal128, matching the pipeline. `RANK()` comes back as Int32, matching
   the pipeline's `$add` of the array index. Named binds work in the object
   form (`{statement, binds: {fromTs, toTs}}`) because `$sql` is the only stage.
4. **Statistics matter, and so does column width.** A `mongorestore` bulk load
   leaves no optimizer statistics. Without them the first draft of the SQL got
   a `MERGE JOIN CARTESIAN` with `accounts` and ran for minutes; D6 setup
   gathers table statistics on the four collections (what a DBA does after a
   load). Then the `GROUP BY` spilled 737 MB to temp (10.8 s) because dot
   notation `.string()` returns `VARCHAR2(4000)`; projecting the grouped and
   sorted values with `json_value(... returning varchar2(n) error on error)`
   (an over-long value fails loudly instead of becoming NULL) took it to
   0.7 s in memory. `JSON_TABLE` over the root (`'$'`) of each collection
   gave row estimates in the billions, so the lines are the only `JSON_TABLE`.
5. **Why the pipeline is slow on Oracle.** The API translates each `$lookup`
   into a per-document `json_transform` that embeds the looked-up document
   (an index unique scan per order, per line), then `json_expand_array` for
   each `$unwind`: nested loops that rebuild documents one at a time. The SQL
   version reads each table once, joins with hash joins, groups once and
   stops each rank at 5 (`WINDOW SORT PUSHED RANK`). Same engine, same data:
   the difference is the shape of the request, not the wire. This is the
   field PoC's point ("the API tax is pipeline-shaped"); the ratio here is
   larger than the field's 3 to 15x because this pipeline has three
   per-document lookups over 100,000 orders.

## Medians and ratio (laptop, relative only)

Ruling T: live (the console, no `D6_PIPELINE_RUNS`) the pipeline is timed
once, about 80 s, while the presenter talks through its plan; headless runs
and the tests time it over 3 runs (compose passes `D6_PIPELINE_RUNS=3` to the
runner). `$sql` is timed over 7 runs. Neither side gets a warmup run (the
median of 7 absorbs `$sql`'s cold first run), so nothing is pre-warmed in
either side's favour. Results proven equal first in every run.

Re-measured 2026-11-01 after the fix round (no warmups), `./lab.sh demo d6`
from the runner container:

| run | (2) pipeline via MongoDB API | (3) `$sql` via MongoDB API, median of 7 | ratio | demo wall time |
|---|---|---|---|---|
| headless, 3 runs | 77.8 s median (77.7, 85.2, 77.8) | 0.65 s (0.64 to 0.67) | 120x | 4m15s |
| live default, `D6_PIPELINE_RUNS=1` | 86.1 s (1 run) | 0.65 s (0.64 to 0.66) | 133x | 1m40s |

Earlier runs (with a 2-run `$sql` warmup, before the fix round) gave 141x
and 128x; the warmup made no material difference (0.60 vs 0.65 s).

Say on stage: "the same question, handed to the optimizer as SQL, ran more
than 100 times faster on this laptop, with identical results." Cite the
field PoC (pipelines about 3 to 15x slower) for anything absolute.

## Plans

(2) is the plan the Oracle API returns for the pipeline (`explain`, condensed
by `mongoExplain`); (3) is `DBMS_XPLAN.DISPLAY_CURSOR` of the cursor the
MongoDB API itself ran for the `$sql` stage (found in `v$sql`; the demo falls
back to the same statement in a direct SQL session only if that cursor has
aged out, and says so).

```text
(2) pipeline through the MongoDB API                                     |  (3) $sql
SELECT STATEMENT                                                         |  SELECT STATEMENT
  SORT ORDER BY                                                          |   SORT ORDER BY
    NESTED LOOPS                                                         |    VIEW
      VIEW                                                               |     WINDOW SORT PUSHED RANK
        SORT GROUP BY                                                    |      HASH JOIN
          VIEW                                                           |       HASH JOIN
            WINDOW SORT                                                  |        VIEW
              VIEW                                                       |         SORT GROUP BY
                SORT GROUP BY                                            |          FILTER
                  NESTED LOOPS                                           |           HASH JOIN
                    SORT GROUP BY                                        |            TABLE ACCESS FULL catalog
                      TABLE ACCESS BY INDEX ROWID catalog                |            NESTED LOOPS
                        INDEX UNIQUE SCAN SYS_C0012961                   |             TABLE ACCESS FULL orders
                    VIEW                                                 |             JSONTABLE EVALUATION
                      NESTED LOOPS                                       |        TABLE ACCESS FULL subscribers
                        NESTED LOOPS                                     |       TABLE ACCESS FULL accounts
                          SORT GROUP BY                                  |
                            TABLE ACCESS BY INDEX ROWID accounts         |
                              INDEX UNIQUE SCAN SYS_C0012962             |
                          VIEW                                           |
                            NESTED LOOPS                                 |
                              SORT GROUP BY                              |
                                TABLE ACCESS BY INDEX ROWID subscribers  |
                                  INDEX UNIQUE SCAN SYS_C0012963         |
                              VIEW                                       |
                                TABLE ACCESS FULL orders                 |
                              JSON EXPAND ARRAY EVALUATION               |
                          JSON EXPAND ARRAY EVALUATION                   |
                        JSON EXPAND ARRAY EVALUATION                     |
                    JSON EXPAND ARRAY EVALUATION                         |
      JSON EXPAND ARRAY EVALUATION                                       |
```

MongoDB source explain of the same pipeline (plan shape only):
`$cursor` (`PROJECTION_DEFAULT` over `COLLSCAN`) then `$lookup`, `$lookup`,
`$unwind`, `$lookup`, `$set`, `$group`, `$group`, `$unwind`, `$project`,
`$sort`.

## The SQL

`demos/d6-sql/top-spenders.sql` (read by `queries.mjs` and by the mongosh
script `sql-stage.js`, which the oracle image carries under `/opt/lab`).

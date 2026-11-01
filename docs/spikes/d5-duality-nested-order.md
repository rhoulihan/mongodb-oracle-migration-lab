# Spike: can a duality view order and limit a nested array? (D5)

Date: 2026-10-31. Database: Oracle AI Database 26ai Free, Release 23.26.3.0.0 (the lab image).
Question (spec section 5.2, D5 detail): can the Top 10 live inside the JSON
Relational Duality view, with `ORDER BY` / `FETCH FIRST 10` (or a GraphQL
equivalent) on the nested `top` array?

## Verdict

**No, not on this build.** Every way to order or limit a nested array in a
duality view is rejected, either at `CREATE` time or at query time. D5 uses the
fallback the spec allows:

- `region_top_devices_v` is a read-only **JSON collection view** that builds the
  dashboard document: per region, `FETCH FIRST 10` over `device_sales`, then
  `JSON_ARRAYAGG ... ORDER BY units DESC, sku`. The MongoDB API lists it as a
  collection (type `view`), so the app reads it with an ordinary `find`.
- `region_top_devices_dv` is the duality view. It carries the region with
  **every** device sold there, unordered, and it covers the write path: a
  MongoDB API `$inc` or `replaceOne` on a `top` entry, or a SQL update of the
  view (`JSON_TRANSFORM ... SET`), lands in that one `device_sales` row. All
  three write paths are pinned by `test/integration/d5.test.mjs`.
- Deck note, said plainly: *"The duality view handles writes and the full
  device list. The Top 10 document comes from a read-only JSON view over the
  same pre-sorted index, because 26ai cannot yet sort or cut a nested array
  inside a duality view."*

## What was tried

Scratch tables `sp_region(region_id PK, name)`, `sp_device(sku PK, name)`,
`sp_device_sales(region_id FK, sku FK, units, PK(region_id, sku))`, 15 rows.
Each nested array below sits under
`SELECT JSON {'_id': r.region_id, 'name': r.name, 'top': [ ... ]} FROM sp_region r WITH INSERT UPDATE DELETE`
(SQL syntax) or `sp_region @insert @update @delete { _id: region_id, name: name, top: ... }` (GraphQL syntax).

### SQL duality syntax

| Nested subquery | Result |
|---|---|
| `SELECT JSON {'sku': ds.sku, 'units': ds.units, UNNEST (SELECT JSON {'name': d.name} FROM sp_device d WHERE d.sku = ds.sku)} FROM sp_device_sales ds WITH INSERT UPDATE DELETE WHERE ds.region_id = r.region_id` | created, reads fine (baseline, unordered) |
| same, plus `ORDER BY ds.units DESC, ds.sku` | `ORA-40895: invalid SQL expression in JSON relational duality view (unpermitted clause in query)` |
| same, plus `FETCH FIRST 10 ROWS ONLY` | `ORA-02000: missing ] keyword` |
| same, plus `ORDER BY ds.units DESC, ds.sku FETCH FIRST 10 ROWS ONLY` | `ORA-02000: missing ] keyword` |
| same, plus `OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY` | `ORA-02000: missing ] keyword` |
| `WHERE ds.region_id = r.region_id AND ROWNUM <= 10` | `ORA-42664: ... missing WITH CHECK OPTION in WHERE clause` (and ROWNUM would cut an arbitrary 10, not the top 10) |
| `FROM (SELECT * FROM sp_device_sales ORDER BY units DESC FETCH FIRST 10 ROWS ONLY) ds` | `ORA-40935: ... 'from$_subquery$_002' must be a table or editioning view` |

### GraphQL duality syntax

| Nested field | Result |
|---|---|
| `sp_device_sales @insert @update @delete [ { sku: sku, units: units, sp_device @unnest { dname: name } } ]` | created, reads fine (baseline) |
| `sp_device_sales @orderby(units: desc) [ ... ]` (also `units: DESC`, `units`, `UNITS: desc`, `sku`, `region_id`, `desc: units`, `asc: units`, `field: units`, `by: units`, `path: "units"`, `units: "desc"`, `[units: desc]`, `sp_device_sales.units: desc`) | `ORA-43437: '<ARG>': invalid argument for the @ORDERBY directive.` The directive exists; no argument form was accepted except `sql:` |
| `sp_device_sales @orderby(sql: "units desc, sku") [ ... ]` (with or without the `@unnest` device) | **created**, but every query fails: `ORA-40477: internal JSON error ''` |
| `sp_device_sales @orderby(sql: "units desc fetch first 10 rows only") [ ... ]` | `ORA-02000: missing ) keyword` |
| `sp_device_sales @limit(10) [ ... ]`, `@fetch(10)` | `ORA-24558: syntax error encountered in the input string` |
| `sp_device_sales @where(sql: "units > 3") [ ... with @unnest device ]` | works (filters, does not order) |
| `sp_device_sales @where(sql: "rownum <= 10") [ ... ]` | works and returns 10 entries, but an arbitrary 10 in access-path order, not the Top 10 |
| `@where(sql: "sku in (select x.sku from sp_device_sales x where x.region_id = sp_device_sales.region_id order by x.units desc, x.sku fetch first 10 rows only)")` | `ORA-00904: "SP_DEVICE_SALES"."REGION_ID": invalid identifier` (no correlation to the row being filtered) |

## Other findings on the way (worth a speaker note)

- **Nested entries must not map the join columns twice.** The first D5 duality
  view mapped `'sku': ds.sku` and also unnested `device` for the name. It
  created and read fine, but every write (MongoDB API `replaceOne` or `$inc`)
  failed with `ORA-00600: internal error code, arguments: [qjsnbzoUpdateRow:zero_pk_cols]`.
  The working shape maps only `'units': ds.units` from `device_sales` and takes
  `sku` and `name` from `device` through `UNNEST`, as in Oracle's own examples.
- **A nested `device_sales` array without the `device` unnest** (only `sku` and
  `units`) creates fine in both syntaxes but fails on every read with
  `ORA-40477: internal JSON error ''`.
- **Duality views push the `_id` filter down; the JSON collection view does not.**
  `region_top_devices_dv.findOne({_id:"R03"})` plans as `INDEX UNIQUE SCAN` on the
  region primary key. On `region_top_devices_v` the `_id` filter is applied
  after the view builds each region's document: all 8 regions are built (8 x 10
  index entries), then 7 are dropped. That is 65 buffer gets in total here;
  with many more regions it would want a direct SQL read or a pushed predicate.
- **`$first` in `$project` fails on the Oracle API for MongoDB:**
  `{ name: { $first: '$device.name' } }` after `$lookup` gives
  `ORA-40179: error in Path Engine execution JZN-00477`. `$arrayElemAt: ['$device.name', 0]`
  works and is what the D5 pipeline uses.
- **A SQL `NUMBER` reads back through the MongoDB API as a Double**, while the
  embedded Top-N document stores `units` as Int32. `readDashboard` projects
  `units` as Int32 in all three variants before the documents are compared.
- **SQL can write a document with BSON types intact:** `INSERT INTO "orders" (data) VALUES (JSON(:doc EXTENDED))`
  with canonical Extended JSON stores ObjectId, Int32, Int64, Decimal128 and
  Date exactly as the MongoDB API does (Decimal128 scale normalized, as in D3).
  The converged variant inserts its orders this way.

## What D5 ships (oracle/sql/d5-converged.sql)

```sql
CREATE INDEX device_sales_topn ON device_sales (region_id, units DESC, sku);

CREATE JSON RELATIONAL DUALITY VIEW region_top_devices_dv AS
SELECT JSON {
  '_id'  : r.region_id,
  'name' : r.name,
  'top'  : [ SELECT JSON {
               'units' : ds.units,
               UNNEST (SELECT JSON {'sku' : d.sku, 'name' : d.name} FROM device d WHERE d.sku = ds.sku) }
             FROM device_sales ds WITH INSERT UPDATE DELETE
             WHERE ds.region_id = r.region_id ] }
FROM region r WITH UPDATE;

CREATE JSON COLLECTION VIEW region_top_devices_v AS
SELECT JSON {
  '_id' : r.region_id,
  'top' : (SELECT JSON_ARRAYAGG(JSON {'sku' : t.sku, 'name' : d.name, 'units' : t.units}
                                ORDER BY t.units DESC, t.sku RETURNING JSON)
             FROM (SELECT ds.sku, ds.units
                     FROM device_sales ds
                    WHERE ds.region_id = r.region_id
                    ORDER BY ds.units DESC, ds.sku
                    FETCH FIRST 10 ROWS ONLY) t
             JOIN device d ON d.sku = t.sku) }
  FROM region r;
```

The brief named `LATERAL`; the first version used `FROM region r, LATERAL (...) t ... GROUP BY`
with the device join inside the lateral. The optimizer then hash-joined all
120 device rows before the cut and added `SORT ORDER BY STOPKEY`. Taking the
Top 10 from `device_sales` alone, in a correlated subquery, puts the stop
directly on the index scan with no sort, so that is what ships. No hints.

## The three read plans (R03, laptop)

(a) embedded, `regionTopDevices.findOne({_id:"R03"})` through the MongoDB API:
```
SELECT STATEMENT
  TABLE ACCESS BY INDEX ROWID regionTopDevices
    INDEX UNIQUE SCAN SYS_C009755
```

(b) lookup, the `$match / $unwind / $match / $group / $sort / $limit / $lookup / $project` pipeline:
```
SELECT STATEMENT
  SORT GROUP BY
    TABLE ACCESS BY INDEX ROWID catalog
      INDEX UNIQUE SCAN SYS_C009749
  VIEW
    COUNT STOPKEY
      VIEW
        SORT ORDER BY STOPKEY
          VIEW
            SORT GROUP BY
              NESTED LOOPS
                TABLE ACCESS BY INDEX ROWID BATCHED orders
                  HASH UNIQUE
                    INDEX RANGE SCAN (MULTI VALUE) $ora:orders.region_1_placedAt_-1
                JSON EXPAND ARRAY EVALUATION
```
Every refresh reads all of R03's orders (25,522 documents and 19,150 device
lines on the restored dataset: the row counts after the pipeline's first
`$match` and after its `$match` on `lines.kind`, run stage by stage through the
Oracle API during the spike) through the region index, expands the line arrays, groups, sorts, then
looks up 10 names. It is a `SORT GROUP BY`, not a hash group or a full scan: the
brief's prediction ("full scan or hash group") did not hold, so the test pins
what the plan really does (reads the orders table, then a GROUP BY).

(c) converged, `SELECT JSON_SERIALIZE(v.data) FROM region_top_devices_v v WHERE v.data."_id".string() = :region`
(the MongoDB API `find` on the view plans the same):
```
| Id  | Operation             | Name                 | Starts | E-Rows | A-Rows | Buffers |
|   0 | SELECT STATEMENT      |                      |      1 |        |      1 |      65 |
|   1 |  SORT GROUP BY        |                      |      8 |      1 |      8 |      64 |
|*  2 |   HASH JOIN           |                      |      8 |     10 |     80 |      64 |
|   3 |    VIEW               |                      |      8 |     10 |     80 |      16 |
|*  4 |     COUNT STOPKEY     |                      |      8 |        |     80 |      16 |
|   5 |      VIEW             |                      |      8 |    120 |     80 |      16 |
|*  6 |       INDEX RANGE SCAN| DEVICE_SALES_TOPN    |      8 |    120 |     80 |      16 |
|   7 |    TABLE ACCESS FULL  | DEVICE               |      8 |    120 |    960 |      48 |
|*  8 |  VIEW                 | REGION_TOP_DEVICES_V |      1 |      8 |      1 |      65 |
|   9 |   INDEX FULL SCAN     | SYS_C009997          |      1 |      8 |      8 |       1 |
   4 - filter(ROWNUM<=10)
   6 - access("DS"."REGION_ID"=:B1)
```
(`ALLSTATS LAST`, run with `gather_plan_statistics`.) The index range scan
returns exactly 10 rows per region (A-Rows 80 over 8 starts): it stops after
10, already in order, with no sort. The join to `device` is real: the
optimizer picked a hash join with a full scan of the 120-row device table.
That is the honest tradeoff: the read assembles the document at query time,
a join the optimizer plans, and the plan shows it is a cheap one (65 buffer
gets for the whole statement).

## Metrics (laptop-measured, relative only)

Measured on the Linux lab laptop with `./lab.sh demo d5` (runner container),
two runs in a row. Redo is the instance-wide `v$sysstat` 'redo size' delta
(Ruling S): 20 warmup orders, then 9 batches of 20, median of the batch
averages. Read time is the median of 7 reads of R03 after 2 warmups. All three
variants start from the same truth and place the same 200 seeded orders; the 8
dashboards were asserted identical before any number was shown.

| | (a) embedded | (b) lookup | (c) converged |
|---|---|---|---|
| redo per order, run 1 (bytes) | 5263 | 2591 | 3487 |
| redo per order, run 2 (bytes) | 5252 | 2588 | 3494 |
| dashboard read, run 1 (ms) | 0.3 | 235.9 | 0.7 |
| dashboard read, run 2 (ms) | 0.4 | 236.3 | 0.7 |
| what each order writes | the order, plus two updates of the 801-byte R03 Top-N document | the order only | the order, plus one MERGE of a counter row, 24 bytes on average (`user_tables.avg_row_len` after the setup stats), and its index entry |
| what each read does | one document by primary key | groups every order line in the region | 10 index entries per region, joined to device |

How to read it:

- The order insert alone costs about 2,600 bytes of redo either way (MongoDB
  API: the lookup column; SQL: 2,603 bytes median, measured separately with the
  same orders). So the counter itself costs about **2,600 bytes per order
  embedded** and about **900 to 1,000 bytes per order converged**: about 2.5
  to 3 times less write work for the same dashboard.
- The lookup pipeline writes the least, and pays on every read. From the two
  runs above: about 340x the converged read (236 / 0.7 ms) and about 600 to
  800x the embedded read (236 / 0.3 to 0.4 ms), and it grows with the
  region's order count. The sub-millisecond reads are close to timer noise, so
  the ratios are only an order of magnitude.
- Converged and embedded read in about the same time on this laptop. The
  converged read is a join, not free: it is cheap because the index hands it
  the 10 rows in order.
- Across 8 development runs the medians stayed within 5243 to 5263 (embedded),
  2588 to 2694 (lookup) and 3487 to 3637 (converged), apart from two embedded
  runs at 5897 and 5906: background redo lands in a batch now and then, which is why the
  number is a median of batches. The likely sources are the TTL monitor
  purging expired `orderEvents` (and `carts`) documents, which Oracle runs
  from the restored TTL indexes (D3), and routine instance work (ORDS pool,
  statistics). Not measured separately; an idle 2-second window showed about
  600 bytes of redo.
- `embedded-write` also showed the batch spread: 4722 to 6683 bytes per order.
  The Top-N document changes size as devices enter and move, and the redo
  follows it.

# Spike: does the Oracle API for MongoDB enforce duality view ETags? (D7)

Date: 2026-10-31. Database: Oracle AI Database 26ai Free, Release 23.26.3.0.0 (the lab image).
Driver: Node.js `mongodb` 7.8 through the Oracle API for MongoDB (ORDS), and `oracledb` 26 for SQL.
Question (spec section 5.2, D7 detail): when two agents read the same order
document from a JSON Relational Duality view and both write it back, does the
second, stale write get rejected through the MongoDB API, or only through SQL?

## Verdict

**Yes, the MongoDB API enforces it.** `find` on `orders_dv` returns
`_metadata.etag`, and a `replaceOne` that sends back a stale `_metadata.etag`
is rejected with ORA-42699. D7's agent defaults to `api: 'mongo'`; the SQL path
behaves the same and stays available as `--api sql`. ORDS REST was not needed.

The protection only applies when the etag is sent. A typical MongoDB app that
strips `_metadata` (or never kept it) and replaces the whole document gets
**last writer wins**: Oracle accepts the write and silently undoes the other
agent's change. Deck line, said plainly: *"Oracle checks the ETag on every
write that carries one. Send back the `_metadata` you read, and a stale write is
refused instead of erasing someone else's change."*

## Setup

`oracle/sql/d7-orders-dv.sql`: `order_hdr` (one row per order: status, region,
subscriber, placed time) and `order_line` (one row per line: sku, kind, qty,
price) built from the 25,522 region R03 orders in `MIG.orders` (60,846 lines),
then the duality view:

```sql
CREATE JSON RELATIONAL DUALITY VIEW orders_dv AS
SELECT JSON {
  '_id' : h.order_id, 'region' : h.region_id, 'subscriber' : h.subscriber_id,
  'status' : h.status, 'placedAt' : h.placed_at,
  'lines' : [ SELECT JSON {'lineId' : l.line_id, 'lineNo' : l.line_no, 'sku' : l.sku,
                           'kind' : l.kind, 'qty' : l.qty, 'price' : l.price}
              FROM order_line l WITH INSERT UPDATE DELETE
              WHERE l.order_id = h.order_id ] }
FROM order_hdr h WITH UPDATE;
```

Row triggers on both tables write one `order_change_log` row per changed table
row, so every write's effect can be counted from the database itself.

## Results

Order `69d0558abbd818e800004c01` (status `placed`, one device line). Agents A
and B each read it, then A sets `status: 'provisioned'` and B swaps the device
line's sku from the document it read before A's write.

| # | What | Result |
|---|---|---|
| 1 | MongoDB API `findOne({_id})` on `orders_dv` | Returns the document with `_metadata: { etag: Binary(16 bytes), asof: Binary(8 bytes) }`. The driver sees the etag as BSON Binary subtype 0 (`M6ez2oAu7WWT1CbObHjBFA==` in base64), not a string. Two reads of the same state return the same etag. |
| 2 | A: `replaceOne({_id}, docA)` with A's etag (current) | `matchedCount: 1, modifiedCount: 1`. Change log: 1 row, `order_hdr  status placed -> provisioned`. The unchanged `order_line` rows are not written. |
| 3 | B: `replaceOne({_id}, docB)` with B's etag (stale) | **Rejected.** `MongoServerError`, `code: -1`, `errmsg`: `ORA-42699: Cannot update JSON Relational Duality View 'ORDERS_DV': The ETAG of document with ID 'FB0436396430353538616262643831386538303030303463303100' in the database did not match the ETAG passed in.` Nothing written: the document still has A's status and the old sku; the change log still has 1 row. |
| 4 | B again, `_metadata` stripped (what a typical MongoDB app sends) | **Accepted, last writer wins.** `matchedCount: 1, modifiedCount: 1`. The document now has B's sku **and `status: 'placed'` again**: A's change is gone. The change log shows it: `order_hdr  status provisioned -> placed`, `order_line 1  sku SKU-DEV-0025 -> SKU-DEV-0001`. |
| 5 | `findOneAndReplace({_id}, staleDoc)` | Rejected, same ORA-42699. |
| 6 | `updateOne({_id}, {$set: {status: 'activated'}})`, no etag | Accepted. A partial `$set` changes only that field, so it cannot erase another agent's sku change; it is a whole-document replace without the etag that loses updates. |
| 7 | `updateOne({_id}, {$set: {status: 'placed', '_metadata.etag': staleEtag}})` | Rejected, same ORA-42699. An etag inside `$set` is checked too. |
| 8 | `updateOne({_id, '_metadata.etag': staleEtag}, {$set: {...}})` | No error, `matchedCount: 0`: the stale etag in the **filter** just matches nothing. The write is skipped silently, so an app using this form must check `matchedCount`. |
| 9 | SQL: read with `SELECT json_serialize(data) FROM orders_dv v WHERE v.data."_id" = :id` | `_metadata: { etag: 'C3EA58152B7D667D61ABD906FC81E30A', asof: '000000000048967B' }`: the same etag, as a hex string. |
| 10 | SQL: `UPDATE orders_dv v SET data = json(:doc) WHERE v.data."_id" = :id` with the current etag | 1 row updated. |
| 11 | SQL: the same `UPDATE` with a stale etag | **Rejected.** `errorNum: 42699`, `ORA-42699: Cannot update JSON Relational Duality View 'ORDERS_DV': The ETAG of document with ID '...' in the database did not match the ETAG passed in.` Rolled back, change log unchanged. |
| 12 | ORDS REST | Not tested: the MongoDB API path enforces, so the spike stopped there. |

`agent.mjs` maps both forms to `{ok: false, code: 'ETAG_MISMATCH'}`: a
`MongoServerError` whose message contains `ORA-42699` (its `code` is the
generic `-1`, so the code alone does not identify it), or an `oracledb` error
with `errorNum` 42699.

## Other findings on the way (worth a speaker note)

- **A nested table's whole primary key must be in the document.** The first
  `order_line` had `PRIMARY KEY (order_id, line_no)` and the nested object
  mapped only `line_no` (the join column `order_id` comes from the parent).
  The view created, but every read failed with `ORA-40477: internal JSON error ''`,
  through SQL and the MongoDB API alike (the same error D5 hit on a nested
  array without its key, docs/spikes/d5-duality-nested-order.md). Mapping
  `order_id` inside each line as well fixed the read, at the cost of repeating
  the order id in every line. What ships: a one-column key, `line_id`
  (identity), mapped as `lineId`, with `UNIQUE (order_id, line_no)`. This also
  sidesteps D5's ORA-00600 `[qjsnbzoUpdateRow:zero_pk_cols]`, which came from
  mapping a join column a second time: here each line maps its own key once.
- **Writes touch only the rows that changed.** A status change writes one
  `order_hdr` row; a device swap writes one `order_line` row. Counting
  `order_change_log` rows therefore counts the updates applied.
- **The etag is a content hash, not a version counter.** Re-reading the same
  state returns the same etag (after a rebuild the first read returns the same
  value again). A change that is made and then undone gives back the old etag.
- **No foreign keys from D7's tables to D5's `region` and `device`.** D5 drops
  and rebuilds those tables on every run; a foreign key from `order_line.sku`
  would make that `DROP TABLE` fail with ORA-02449.
- **A PL/SQL trigger predicate cannot sit inside SQL.** `CASE WHEN INSERTING ...`
  in the trigger's `INSERT ... VALUES` compiles the trigger as invalid, and
  the next duality write fails with `ORA-42692 ... ORA-04098: trigger ... is invalid`.
  The shipped trigger sets a PL/SQL variable with `IF INSERTING` first.

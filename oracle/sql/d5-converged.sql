-- D5(c), the converged model for "top 10 devices selling right now, per region".
-- Run as MIG after D3's restore: it reads the restored MIG collections
-- (regions, catalog, orders) and builds the counter tables from them, so all
-- three D5 variants start from the same truth. Idempotent: drops and rebuilds.
-- demos/d5-topn/variants.mjs runs it; it also runs as-is in SQLcl:
--   @oracle/sql/d5-converged.sql
-- Statements end with a line holding only "/", so the PL/SQL block can carry
-- its own semicolons.
--
-- Canonical form: region, device, and units sold per (region, device).
-- Projections: three narrow tables. Projected shapes: the dashboard document
-- (region_top_devices_v) and the full region document (region_top_devices_dv).

DROP VIEW IF EXISTS region_top_devices_v
/
DROP VIEW IF EXISTS region_top_devices_dv
/
DROP TABLE IF EXISTS device_sales PURGE
/
DROP TABLE IF EXISTS device PURGE
/
DROP TABLE IF EXISTS region PURGE
/
CREATE TABLE region (
  region_id VARCHAR2(8) PRIMARY KEY,
  name      VARCHAR2(40) NOT NULL
)
/
CREATE TABLE device (
  sku   VARCHAR2(16) PRIMARY KEY,
  name  VARCHAR2(80) NOT NULL,
  brand VARCHAR2(20),
  model VARCHAR2(60)
)
/
-- One narrow counter row per (region, device). An order adds its units here,
-- in the same transaction as the order insert.
CREATE TABLE device_sales (
  region_id VARCHAR2(8)  NOT NULL REFERENCES region,
  sku       VARCHAR2(16) NOT NULL REFERENCES device,
  units     NUMBER       NOT NULL,
  PRIMARY KEY (region_id, sku)
)
/
INSERT INTO region (region_id, name)
SELECT r.data."_id".string(), r.data.name.string() FROM "regions" r
/
INSERT INTO device (sku, name, brand, model)
SELECT c.data."_id".string(), c.data.name.string(), c.data.brand.string(), c.data.model.string()
  FROM "catalog" c
 WHERE c.data.kind.string() = 'device'
/
INSERT INTO device_sales (region_id, sku, units)
SELECT o.region, l.sku, SUM(l.qty)
  FROM (SELECT x.data.region.string() region, x.data FROM "orders" x) o,
       JSON_TABLE(o.data, '$.lines[*]' COLUMNS (
         sku  VARCHAR2(16) PATH '$.sku',
         kind VARCHAR2(10) PATH '$.kind',
         qty  NUMBER       PATH '$.qty')) l
 WHERE l.kind = 'device'
 GROUP BY o.region, l.sku
/
-- Pre-sorted for the dashboard: per region, highest units first, ties by sku.
-- Top 10 is the first 10 entries of one index range.
CREATE INDEX device_sales_topn ON device_sales (region_id, units DESC, sku)
/
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(USER, 'REGION');
  DBMS_STATS.GATHER_TABLE_STATS(USER, 'DEVICE');
  DBMS_STATS.GATHER_TABLE_STATS(USER, 'DEVICE_SALES', cascade => TRUE);
END;
/
-- The duality view: the region document with every device sold there, read
-- and written as one JSON document. A write to a "top" entry's units through
-- this view (MongoDB API $inc or replaceOne, or SQL) lands in that one
-- device_sales row. Each nested entry maps units from device_sales and takes
-- sku and name from device (UNNEST, read-only): the join columns are not
-- mapped a second time (mapping ds.sku as well makes writes fail with
-- ORA-00600 [qjsnbzoUpdateRow:zero_pk_cols] on 26ai Free).
-- 26ai Free cannot order or limit a nested array inside a duality view
-- (docs/spikes/d5-duality-nested-order.md), so this view carries the full,
-- unordered list and covers the write path; the Top 10 comes from the view below.
CREATE JSON RELATIONAL DUALITY VIEW region_top_devices_dv AS
SELECT JSON {
  '_id'  : r.region_id,
  'name' : r.name,
  'top'  : [ SELECT JSON {
               'units' : ds.units,
               UNNEST (SELECT JSON {'sku' : d.sku, 'name' : d.name} FROM device d WHERE d.sku = ds.sku) }
             FROM device_sales ds WITH INSERT UPDATE DELETE
             WHERE ds.region_id = r.region_id ] }
FROM region r WITH UPDATE
/
-- The dashboard document, read-only: per region, the first 10 entries of
-- device_sales_topn (an index range scan that stops after 10 rows, already in
-- order, so no sort), then joined to device for the name. The read assembles
-- the document at query time: a join the optimizer plans, not a free lunch.
-- The Top 10 is taken from device_sales alone, before the join, so the
-- stop-after-10 sits right on the index scan. Exposed to the MongoDB API as
-- the read-only collection region_top_devices_v.
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
  FROM region r
/

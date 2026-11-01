-- Oracle target prep, run as MIG before any data moves.
-- One JSON collection table per MongoDB collection, created explicitly in SQL.
-- The Oracle API for MongoDB maps the Mongo database MIG to this schema and
-- each quoted table name to the collection of the same (case-sensitive) name.
-- Nothing is ever created implicitly by a first write through the MongoDB API.
-- oracle/prep.mjs runs this file (and drops these tables first when asked);
-- it also runs as-is in SQLcl: @oracle/sql/00-target-prep.sql
CREATE JSON COLLECTION TABLE IF NOT EXISTS "regions";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "catalog";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "accounts";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "subscribers";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "orders";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "carts";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "orderEvents";
CREATE JSON COLLECTION TABLE IF NOT EXISTS "regionTopDevices";

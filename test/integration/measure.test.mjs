// Measurement helpers against the live stack: redo bytes from v$mystat, the
// median timer, DBMS_XPLAN plans found by a tag comment, and condensed explain
// output from both the MongoDB source and the Oracle API for MongoDB.
// Scratch objects only: MIG table measure_probe, MIG collection measureProbe
// (created in SQL, never implicitly), and source database telco_measuretest.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MongoClient } from 'mongodb';
import { config } from '../../lib/config.mjs';
import { closeAll, oraMongo, oraSql } from '../../lib/db.mjs';
import { mongoExplain, redoBytes, sqlPlan, sysRedoBytes, timeMedian } from '../../lib/measure.mjs';

const SRC_DB = 'telco_measuretest';
const ORA_COLL = 'measureProbe';
const ORA_INDEX = 'measureprobe_sku_ix';
let srcClient, srcDb, conn;

const DOCS = Array.from({ length: 200 }, (_, i) => ({ _id: i, sku: `SKU-${i}`, qty: i % 7 }));

beforeAll(async () => {
  conn = await oraSql();
  await conn.execute('DROP TABLE IF EXISTS measure_probe PURGE');
  await conn.execute('CREATE TABLE measure_probe (id NUMBER PRIMARY KEY, note VARCHAR2(40))');
  await conn.execute(`DROP TABLE IF EXISTS "${ORA_COLL}" PURGE`);
  await conn.execute(`CREATE JSON COLLECTION TABLE "${ORA_COLL}"`);

  const ora = await oraMongo();
  await ora.collection(ORA_COLL).insertMany(DOCS);
  await ora.collection(ORA_COLL).createIndex({ sku: 1 }, { name: ORA_INDEX });

  srcClient = await new MongoClient(config.mongoSrcUri).connect();
  srcDb = srcClient.db(SRC_DB);
  await srcDb.dropDatabase();
  await srcDb.collection('probe').insertMany(DOCS);
  await srcDb.collection('probe').createIndex({ sku: 1 });
}, 120_000);

afterAll(async () => {
  await conn?.execute('DROP TABLE IF EXISTS measure_probe PURGE');
  await conn?.execute(`DROP TABLE IF EXISTS "${ORA_COLL}" PURGE`);
  await srcDb?.dropDatabase();
  await srcClient?.close();
  await closeAll();
});

describe('redoBytes', () => {
  // The first insert into a new table also creates its segment (deferred segment
  // creation), about 10 KB of extra redo. Warm the table first so the number is
  // the steady-state cost of one row (about 830 bytes on the lab stack).
  test('a 1-row insert writes more than 0 and less than 10,000 redo bytes', async () => {
    await conn.execute("insert into measure_probe values (0, 'segment warmup')");
    await conn.commit();
    const { redo, result } = await redoBytes(conn, async (c) => {
      const r = await c.execute("insert into measure_probe values (1, 'one row')");
      await c.commit();
      return r.rowsAffected;
    });
    expect(result).toBe(1);
    expect(redo).toBeGreaterThan(0);
    expect(redo).toBeLessThan(10_000);
  });

  test('no work, no redo', async () => {
    const { redo } = await redoBytes(conn, async () => 'nothing');
    expect(redo).toBe(0);
  });
});

describe('sysRedoBytes', () => {
  // Ruling S: writes through the Oracle API for MongoDB run in ORDS sessions,
  // so this session's v$mystat never sees them; the instance-wide v$sysstat does.
  test('sees MongoDB API writes that redoBytes (one session) cannot', async () => {
    const coll = (await oraMongo()).collection(ORA_COLL);
    await coll.insertOne({ _id: 'sys-warmup', sku: 'W', qty: 0 });
    const docs = Array.from({ length: 20 }, (_, i) => ({ _id: `sys-${i}`, sku: `SYS-${i}`, qty: i, pad: 'x'.repeat(200) }));
    const session = await redoBytes(conn, async () => {
      for (const d of docs) await coll.insertOne(d);
    });
    const sys = await sysRedoBytes(conn, async () => {
      for (const d of docs) await coll.updateOne({ _id: d._id }, { $set: { pad: 'y'.repeat(200) } });
      return docs.length;
    });
    expect(session.redo).toBe(0);
    expect(sys.result).toBe(20);
    // 20 updates of a ~250-byte document: well over 20 x 200 bytes of redo.
    expect(sys.redo).toBeGreaterThan(20 * 200);
  });

  test('counts SQL work in this session too', async () => {
    await conn.execute("insert into measure_probe values (50, 'sys warmup')");
    await conn.commit();
    const { redo } = await sysRedoBytes(conn, async () => {
      await conn.execute("insert into measure_probe values (51, 'sys row')");
      await conn.commit();
    });
    expect(redo).toBeGreaterThan(0);
  });
});

describe('timeMedian', () => {
  test('runs warmup + runs times and returns the median of the timed runs', async () => {
    let calls = 0;
    const { medianMs, runsMs } = await timeMedian(async () => { calls++; }, { runs: 5, warmup: 2 });
    expect(calls).toBe(7);
    expect(runsMs).toHaveLength(5);
    const sorted = [...runsMs].sort((a, b) => a - b);
    expect(medianMs).toBe(sorted[2]);
  });

  test('defaults to 7 timed runs after 2 warmups', async () => {
    let calls = 0;
    const { runsMs } = await timeMedian(() => { calls++; });
    expect(calls).toBe(9);
    expect(runsMs).toHaveLength(7);
  });
});

describe('sqlPlan', () => {
  // The brief named `select * from dual`, but selecting the DUMMY column makes
  // Oracle read the DUAL table (TABLE ACCESS FULL). FAST DUAL is the plan for a
  // select that needs no column, such as `select 1 from dual`. Both are pinned.
  test('select 1 from dual shows FAST DUAL', async () => {
    const plan = await sqlPlan(conn, 'select 1 from dual');
    expect(plan).toContain('FAST DUAL');
  });

  test('select * from dual reads the DUAL table', async () => {
    const plan = await sqlPlan(conn, 'select * from dual');
    expect(plan).toMatch(/TABLE ACCESS FULL\s*\| DUAL/);
  });

  test('the plan is the tagged statement, run as written', async () => {
    const plan = await sqlPlan(conn, 'select 1 from dual');
    expect(plan).toMatch(/\/\* measure:[0-9a-f]+ \*\/ select 1 from dual/);
  });

  test('binds are passed and the predicate section is present', async () => {
    const plan = await sqlPlan(conn, 'select note from measure_probe where id = :id', { id: 1 });
    expect(plan).toMatch(/INDEX UNIQUE SCAN/);
    expect(plan).toMatch(/Predicate Information/);
  });
});

describe('mongoExplain', () => {
  test('source: an indexed find filter shows IXSCAN', async () => {
    const text = await mongoExplain(srcDb, 'probe', { sku: 'SKU-42' });
    expect(text).toContain('IXSCAN');
    expect(text).toContain('sku_1');
  });

  test('source: a pipeline is explained through aggregate', async () => {
    const text = await mongoExplain(srcDb, 'probe', [{ $match: { sku: 'SKU-42' } }, { $project: { qty: 1 } }]);
    expect(text).toContain('IXSCAN');
  });

  test('Oracle API: an indexed find filter shows the Oracle index name', async () => {
    const ora = await oraMongo();
    const text = await mongoExplain(ora, ORA_COLL, { sku: 'SKU-42' });
    expect(text.toUpperCase()).toContain(ORA_INDEX.toUpperCase());
  });

  test('Oracle API: a pipeline is explained too', async () => {
    const ora = await oraMongo();
    const text = await mongoExplain(ora, ORA_COLL, [{ $match: { sku: 'SKU-42' } }]);
    expect(text.toUpperCase()).toContain(ORA_INDEX.toUpperCase());
  });
});

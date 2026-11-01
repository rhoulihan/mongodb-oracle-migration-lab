// Oracle target prep against the live stack: the eight collections exist as
// JSON collection tables owned by MIG, they are empty, MIG is ORDS-enabled,
// and running the prep twice is safe.
import { afterAll, expect, test } from 'vitest';
import { closeAll, oraMongo, oraSql } from '../../lib/db.mjs';
import { COLLECTIONS, prepareTarget } from '../../oracle/prep.mjs';

const EXPECTED = ['regions', 'catalog', 'accounts', 'subscribers', 'orders', 'carts', 'orderEvents', 'regionTopDevices'];

afterAll(closeAll);

test('the prep covers exactly the eight source collections', () => {
  expect([...COLLECTIONS].sort()).toEqual([...EXPECTED].sort());
});

test('prepareTarget({drop:true}) leaves eight empty collections visible to the Oracle API for MongoDB', async () => {
  await prepareTarget({ drop: true });
  const db = await oraMongo();
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  for (const n of EXPECTED) expect(names).toContain(n);
  for (const n of EXPECTED) expect(await db.collection(n).countDocuments({})).toBe(0);
}, 120_000);

test('the collections are JSON collection tables in the MIG schema', async () => {
  const c = await oraSql();
  const r = await c.execute('select collection_name from user_json_collection_tables');
  const tables = r.rows.map((row) => row[0]);
  for (const n of EXPECTED) expect(tables).toContain(n);
});

test('drop:true empties a collection that has documents', async () => {
  const db = await oraMongo();
  await db.collection('regions').insertOne({ _id: 'probe' });
  await prepareTarget({ drop: true });
  expect(await db.collection('regions').countDocuments({})).toBe(0);
}, 120_000);

test('running it twice does not throw, with or without drop', async () => {
  await prepareTarget({ drop: true });
  await prepareTarget({ drop: true });
  await prepareTarget({ drop: false });
  await prepareTarget({ drop: false });
}, 120_000);

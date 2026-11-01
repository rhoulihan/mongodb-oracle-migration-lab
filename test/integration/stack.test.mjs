import { afterAll, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { mongoSrc, oraMongo, oraSql, closeAll } from '../../lib/db.mjs';

afterAll(closeAll);

test('mongo source is a replica set primary', async () => {
  const db = await mongoSrc(); const r = await db.admin().command({ hello: 1 });
  expect(r.isWritablePrimary).toBe(true); expect(r.setName).toBe('rs0');
});
test('oracle sql answers as MIG', async () => {
  const c = await oraSql(); const r = await c.execute('select user from dual');
  expect(r.rows[0][0]).toBe('MIG');
});
test('oracle mongo api answers ping', async () => {
  const db = await oraMongo(); expect((await db.command({ ping: 1 })).ok).toBe(1);
});
test('all published ports bind to 127.0.0.1', () => {
  const y = readFileSync('compose.yml', 'utf8');
  const ports = y.match(/^\s+- '.*:\d+:\d+'/gm);
  expect(ports?.length).toBeGreaterThan(0);
  for (const p of ports) expect(p).toMatch(/127\.0\.0\.1/);
});

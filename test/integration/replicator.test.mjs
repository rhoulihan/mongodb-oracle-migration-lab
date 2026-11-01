// D4 stand-in replicator against the live stack (Review Focus 3 included).
//   forward     MongoDB change stream -> Oracle API for MongoDB, 1,000 new and
//               300 updated orders through the app, then equal on both sides
//   restart     the CLI (a real child process) is SIGKILLed mid-burst and
//               restarted: it resumes from the saved token, no lost or
//               duplicated documents
//   no ping-pong forward-applied writes never reach mig_changelog
//   flip        forward stopped, reverse started, app on Oracle, 200 orders:
//               MongoDB has them and both sides are equal again
// The app at 127.0.0.1:3300 drives every write. Leaves the lab at the D4
// starting state's reset (app on MongoDB, capture objects dropped).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../../demos/contract.mjs';
import d4, { placeOrders, switchApp } from '../../demos/d4-bluegreen/index.mjs';
import { COLLECTIONS } from '../../oracle/prep.mjs';
import { caughtUp, readStatus } from '../../replicator/apply.mjs';
import { compareSides } from '../../replicator/verify.mjs';
import { startForward } from '../../replicator/forward.mjs';
import { startReverse } from '../../replicator/reverse.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
process.env.LAB_STATE_DIR = mkdtempSync(join(tmpdir(), 'd4-state-'));
let ctx;
const forwardApplied = [];   // order ids the forward direction carried to Oracle

/** Poll until the replicator in `dir` is caught up past `since` (ms epoch). */
async function waitCaughtUp(dir, since, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = readStatus(dir);
    if (s && caughtUp(s, since, Date.now())) return s;
    if (Date.now() > end) throw new Error(`${dir} not caught up after ${timeoutMs} ms: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function expectEqual(rows) {
  expect(rows.map((r) => r.coll).sort()).toEqual([...COLLECTIONS].sort());
  for (const r of rows) {
    expect(r.equal, `${r.coll}: MongoDB ${r.mongo} docs ${r.mongoHash}, Oracle ${r.oracle} docs ${r.oracleHash}`).toBe(true);
    expect(r.mongo, r.coll).toBe(r.oracle);
  }
}

const cli = (mode) => spawn('node', ['replicator/cli.mjs', mode], {
  cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
});

beforeAll(async () => {
  ctx = createContext();
  await d4.setup(ctx);
}, 600_000);

afterAll(async () => {
  try { await d4.reset(ctx); } finally { await ctx.close(); }
}, 300_000);

describe('D4 stand-in replicator', () => {
  test('forward: 1,000 new and 300 updated orders on MongoDB land in Oracle, lag drains to 0, hashes equal', async () => {
    const fwd = startForward({ colls: COLLECTIONS });
    await fwd.ready;
    try {
      const w = await placeOrders(ctx, { orders: 1000, updates: 300, concurrency: 8 });
      expect(w.placed).toBe(1000);
      expect(w.updated).toBe(300);
      forwardApplied.push(...w.ids);
      const s = await waitCaughtUp('fwd', w.lastWriteAt);
      expect(s.lagMs).toBe(0);
      expect(fwd.stats().lagMs).toBe(0);
      expect(fwd.stats().applied).toBeGreaterThanOrEqual(1300);
      const ora = await ctx.oraMongo();
      expect(await ora.collection('orders').countDocuments({ _id: { $in: w.ids } })).toBe(1000);
      expectEqual(await compareSides(await ctx.mongoSrc(), ora));
    } finally {
      await fwd.stop();
    }
    expect(readStatus('fwd').state).toBe('stopped');
  }, 600_000);

  test('restart mid-burst: SIGKILL after about 400 changes, restart, resume from the token, no loss, no duplicates', async () => {
    let child = cli('fwd');
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const burst = placeOrders(ctx, { orders: 600, updates: 150, concurrency: 4, seedOffset: 7 });

    // Kill it hard once it has applied about 400 changes.
    const t0 = Date.now();
    for (;;) {
      const s = readStatus('fwd');
      if (s?.pid === child.pid && s.applied >= 400) break;
      if (Date.now() - t0 > 120_000) throw new Error(`forward never reached 400 changes:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const killedAt = readStatus('fwd').applied;
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(killedAt).toBeGreaterThanOrEqual(400);

    child = cli('fwd');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const w = await burst;
    forwardApplied.push(...w.ids);
    try {
      await waitCaughtUp('fwd', w.lastWriteAt);
      const ora = await ctx.oraMongo();
      expect(await ora.collection('orders').countDocuments({ _id: { $in: w.ids } })).toBe(600);
      expectEqual(await compareSides(await ctx.mongoSrc(), ora));
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
    expect(out).toMatch(/resuming from the saved resume token/);
    for (const line of out.trim().split('\n')) expect(line).toMatch(/^\[stand-in for Oracle GoldenGate\] /);
    expect(readStatus('fwd').state).toBe('stopped');
  }, 600_000);

  test('no ping-pong: forward-applied writes never reach mig_changelog', async () => {
    expect(forwardApplied.length).toBe(1600);
    const conn = await ctx.oraSql();
    // Oracle's own TTL deletes are real Oracle changes and may be captured;
    // nothing else may be: every write in the forward phase came from the replicator.
    const r = await conn.execute(
      `select count(*) from mig_changelog where not (op = 'D' and coll in ('carts', 'orderEvents'))`);
    expect(Number(r.rows[0][0])).toBe(0);
    const hex = forwardApplied.map((id) => `{"$rawid":"${id.toHexString()}"}`);
    const hits = await conn.execute(
      `select count(*) from mig_changelog where coll = 'orders' and id in (select column_value from table(:ids))`,
      { ids: { type: 'SYS.ODCIVARCHAR2LIST', val: hex } });
    expect(Number(hits.rows[0][0])).toBe(0);
  }, 120_000);

  test('flip: reverse on, app on Oracle, 200 orders reach MongoDB, hashes equal again', async () => {
    const rev = startReverse({ colls: COLLECTIONS });
    await rev.ready;
    try {
      expect((await switchApp('oracle')).backend).toBe('oracle');
      const w = await placeOrders(ctx, { orders: 200, updates: 60, concurrency: 4, seedOffset: 13 });
      expect(w.placed).toBe(200);
      const s = await waitCaughtUp('rev', w.lastWriteAt);
      expect(s.lagMs).toBe(0);
      expect(rev.stats().applied).toBeGreaterThan(0);
      const src = await ctx.mongoSrc();
      expect(await src.collection('orders').countDocuments({ _id: { $in: w.ids } })).toBe(200);
      // The app's Oracle writes are captured (the trigger is live, the
      // replicator's own session is the only one it skips).
      const conn = await ctx.oraSql();
      const captured = await conn.execute(`select count(*) from mig_changelog where coll = 'orders' and op = 'I'`);
      expect(Number(captured.rows[0][0])).toBe(200);
      expectEqual(await compareSides(src, await ctx.oraMongo()));
    } finally {
      await rev.stop();
      await switchApp('mongo');
    }
  }, 600_000);
});

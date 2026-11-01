// lib/db.mjs lazy singletons: the console serves concurrent requests from one
// process, so the connect PROMISE is cached (not the resolved client): two
// callers that arrive before the first connect finishes share one client. A
// failed connect is forgotten, so the next call tries again.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const made = [];
let failNext = false;

vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(uri) { this.uri = uri; this.closed = false; made.push(this); }
    async connect() {
      await new Promise((r) => setTimeout(r, 20));
      if (failNext) { failNext = false; throw new Error('connect refused'); }
      return this;
    }
    db() { return { client: this }; }
    async close() { this.closed = true; }
  },
}));

const conns = [];
vi.mock('oracledb', () => ({
  default: {
    async getConnection() {
      await new Promise((r) => setTimeout(r, 20));
      const c = { closed: false, async close() { this.closed = true; } };
      conns.push(c);
      return c;
    },
  },
}));

const db = await import('../../lib/db.mjs');

beforeEach(async () => {
  await db.closeAll();
  made.length = 0;
  conns.length = 0;
});

describe('lib/db.mjs', () => {
  test('concurrent first calls share one MongoDB client per endpoint', async () => {
    const [a, b] = await Promise.all([db.mongoSrc(), db.mongoSrc()]);
    const [c, d] = await Promise.all([db.oraMongo(), db.oraMongo()]);
    expect(made).toHaveLength(2);
    expect(a.client).toBe(b.client);
    expect(c.client).toBe(d.client);
    expect(a.client).not.toBe(c.client);
  });

  test('concurrent first calls share one SQL connection', async () => {
    const [a, b] = await Promise.all([db.oraSql(), db.oraSql()]);
    expect(conns).toHaveLength(1);
    expect(a).toBe(b);
  });

  test('a failed connect is not cached: the next call connects again', async () => {
    failNext = true;
    await expect(db.mongoSrc()).rejects.toThrow(/connect refused/);
    const ok = await db.mongoSrc();
    expect(made).toHaveLength(2);
    expect(ok.client).toBe(made[1]);
  });

  test('closeAll closes what was opened, including a connect still in flight', async () => {
    const inflight = db.mongoSrc();
    await db.oraSql();
    await db.closeAll();
    await inflight;
    expect(made[0].closed).toBe(true);
    expect(conns[0].closed).toBe(true);
    await db.mongoSrc();
    expect(made).toHaveLength(2);
  });
});

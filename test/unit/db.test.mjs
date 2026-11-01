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
let nextExecuteError = null;
vi.mock('oracledb', () => ({
  default: {
    async getConnection() {
      await new Promise((r) => setTimeout(r, 20));
      const c = {
        closed: false,
        async close() { this.closed = true; },
        async execute(sql) {
          if (nextExecuteError) { const e = nextExecuteError; nextExecuteError = null; throw e; }
          return { rows: [[sql]] };
        },
      };
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
    expect((await a.execute('select 1 from dual')).rows[0][0]).toBe('select 1 from dual');
  });

  test('a broken SQL connection is dropped, so the next call reconnects', async () => {
    const a = await db.oraSql();
    nextExecuteError = Object.assign(new Error('ORA-03113: end-of-file on communication channel'), { errorNum: 3113 });
    await expect(a.execute('select 1 from dual')).rejects.toThrow(/ORA-03113/);
    expect(conns[0].closed).toBe(true);
    const b = await db.oraSql();
    expect(conns).toHaveLength(2);
    expect(b).not.toBe(a);
  });

  test('an ordinary SQL error keeps the connection', async () => {
    const a = await db.oraSql();
    nextExecuteError = Object.assign(new Error('ORA-00942: table or view does not exist'), { errorNum: 942 });
    await expect(a.execute('select * from nope')).rejects.toThrow(/ORA-00942/);
    expect(await db.oraSql()).toBe(a);
    expect(conns).toHaveLength(1);
  });

  test('evictOnError drops the MongoDB clients on a network-class error only', async () => {
    const src = await db.mongoSrc();
    expect(db.evictOnError(Object.assign(new Error('bad query'), { name: 'MongoServerError' }))).toBe(false);
    expect(await db.mongoSrc()).toEqual(src);
    expect(db.evictOnError(Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' }))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(made[0].closed).toBe(true);
    await db.mongoSrc();
    expect(made).toHaveLength(2);
    expect(db.isConnectionError(Object.assign(new Error('x'), { code: 'DPI-1080' }))).toBe(true);
    expect(db.isConnectionError(new Error('NJS-500: connection to the Oracle Database was broken'))).toBe(true);
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

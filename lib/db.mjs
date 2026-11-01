// Shared, lazily opened connections to the three lab endpoints.
// The connect PROMISE is cached, not the resolved client: callers that arrive
// while the first connect is still in flight (the console serves concurrent
// requests from one process) share it instead of opening, and leaking, a
// second client. A failed connect is forgotten, so the next call retries.
// A connection that breaks later (Oracle restarted, network dropped) is
// dropped too, so the next call reconnects instead of failing forever: the
// SQL connection evicts itself when one of its calls fails with a
// connection-class error, and evictOnError(err) does the same for any error
// a caller sees (the console calls it when a step throws). The MongoDB driver
// also reconnects on its own; evicting just starts from a fresh client.
import { MongoClient } from 'mongodb';
import oracledb from 'oracledb';
import { config } from './config.mjs';

const open = new Map(); // name -> Promise<client or connection>

const ORACLE_BROKEN = /ORA-0311[34]|ORA-03135|DPI-1010|DPI-1080|NJS-500|NJS-003|NJS-521/;
const MONGO_BROKEN = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoTopologyClosedError']);
const isOracleBroken = (err) => ORACLE_BROKEN.test(`${err?.code ?? ''} ${err?.message ?? ''}`) || [3113, 3114, 3135].includes(err?.errorNum);
const isMongoBroken = (err) => MONGO_BROKEN.has(err?.name);

/** True for errors that mean the connection itself is gone, not the statement. */
export const isConnectionError = (err) => isOracleBroken(err) || isMongoBroken(err);

/** Forget (and close) a cached connection so the next call opens a new one. */
function evict(name, p = open.get(name)) {
  if (!p || open.get(name) !== p) return;
  open.delete(name);
  p.then((c) => c.close()).catch(() => {});
}

/** Drop the cached connections a connection-class error points at; true if it was one. */
export function evictOnError(err) {
  if (isOracleBroken(err)) evict('sql');
  else if (isMongoBroken(err)) { evict('src'); evict('ora'); }
  else return false;
  return true;
}

/** The SQL connection, with every call watched for a broken connection. */
function watched(name, conn) {
  const p = open.get(name);
  return new Proxy(conn, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function' || prop === 'close') return typeof v === 'function' ? v.bind(target) : v;
      return (...args) => {
        const onErr = (err) => { if (isOracleBroken(err)) evict(name, p); throw err; };
        try {
          const r = v.apply(target, args);
          return r && typeof r.then === 'function' ? r.catch(onErr) : r;
        } catch (err) {
          return onErr(err);
        }
      };
    },
  });
}

function lazy(name, connect) {
  if (!open.has(name)) {
    const p = connect();
    open.set(name, p);
    p.catch(() => { if (open.get(name) === p) open.delete(name); });
  }
  return open.get(name);
}

export async function mongoSrc() {
  return (await lazy('src', () => new MongoClient(config.mongoSrcUri).connect())).db();
}

export async function oraMongo() {
  return (await lazy('ora', () => new MongoClient(config.oraMongoUri).connect())).db();
}

export async function oraSql() {
  // watched() runs after the connect resolves, when the cache already holds
  // this promise, so the proxy knows which entry to evict.
  return lazy('sql', async () => watched('sql', await oracledb.getConnection(config.oraSql)));
}

/** Close every connection opened so far, including one still connecting. */
export async function closeAll() {
  const pending = [...open.values()];
  open.clear();
  await Promise.allSettled(pending.map(async (p) => (await p).close()));
}

// Shared, lazily opened connections to the three lab endpoints.
// The connect PROMISE is cached, not the resolved client: callers that arrive
// while the first connect is still in flight (the console serves concurrent
// requests from one process) share it instead of opening, and leaking, a
// second client. A failed connect is forgotten, so the next call retries.
import { MongoClient } from 'mongodb';
import oracledb from 'oracledb';
import { config } from './config.mjs';

const open = new Map(); // name -> Promise<client or connection>

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
  return lazy('sql', () => oracledb.getConnection(config.oraSql));
}

/** Close every connection opened so far, including one still connecting. */
export async function closeAll() {
  const pending = [...open.values()];
  open.clear();
  await Promise.allSettled(pending.map(async (p) => (await p).close()));
}

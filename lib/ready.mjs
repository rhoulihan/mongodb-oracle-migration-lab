// Lab readiness, the `./lab.sh check` probes ported to Node so the console can
// ask from inside compose (over the compose network, no container engine):
//   mongo     the MongoDB source answers hello as a writable primary
//   oracle    a SQL session as MIG runs select 1 from dual
//   ords      GET <ords>/ords/ answers 200 (after redirects)
//   oraMongo  the Oracle API for MongoDB answers ping as MIG
// Each probe opens its own short-lived connection with a short timeout, so a
// cold Oracle never leaves a half-open client in lib/db.mjs. A probe that
// throws or times out is false.
import { MongoClient } from 'mongodb';
import oracledb from 'oracledb';
import { config } from './config.mjs';

const TIMEOUT_MS = 4000;
const short = { serverSelectionTimeoutMS: TIMEOUT_MS, connectTimeoutMS: TIMEOUT_MS };

async function mongoPing(uri, check) {
  const client = new MongoClient(uri, short);
  try {
    await client.connect();
    return await check(client.db());
  } finally {
    await client.close().catch(() => {});
  }
}

const probes = {
  mongo: () => mongoPing(config.mongoSrcUri, async (db) => (await db.command({ hello: 1 })).isWritablePrimary === true),
  oracle: async () => {
    const conn = await oracledb.getConnection({ ...config.oraSql, connectTimeout: TIMEOUT_MS / 1000 });
    try {
      return (await conn.execute('select 1 from dual')).rows[0][0] === 1;
    } finally {
      await conn.close().catch(() => {});
    }
  },
  ords: async () => {
    const res = await fetch(`${config.ordsUrl}/ords/`, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    return res.status === 200;
  },
  oraMongo: () => mongoPing(config.oraMongoUri, async (db) => (await db.command({ ping: 1 })).ok === 1),
};

/** @returns {Promise<{mongo:boolean, oracle:boolean, ords:boolean, oraMongo:boolean}>} */
export async function readiness() {
  const names = Object.keys(probes);
  const results = await Promise.all(names.map((n) => probes[n]().then((v) => v === true, () => false)));
  return Object.fromEntries(names.map((n, i) => [n, results[i]]));
}

/** True when the Oracle side (database, ORDS and the MongoDB API) is up. */
export const oracleReady = (r) => r.oracle && r.ords && r.oraMongo;

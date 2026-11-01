// Shared, lazily opened connections to the three lab endpoints.
import { MongoClient } from 'mongodb';
import oracledb from 'oracledb';
import { config } from './config.mjs';

let srcClient, oraClient, sqlConn;

export async function mongoSrc() {
  if (!srcClient) srcClient = await new MongoClient(config.mongoSrcUri).connect();
  return srcClient.db();
}

export async function oraMongo() {
  if (!oraClient) oraClient = await new MongoClient(config.oraMongoUri).connect();
  return oraClient.db();
}

export async function oraSql() {
  if (!sqlConn) sqlConn = await oracledb.getConnection(config.oraSql);
  return sqlConn;
}

export async function closeAll() {
  const open = [srcClient?.close(), oraClient?.close(), sqlConn?.close()];
  srcClient = oraClient = sqlConn = undefined;
  await Promise.allSettled(open);
}

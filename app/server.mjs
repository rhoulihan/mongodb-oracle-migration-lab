#!/usr/bin/env node
// Order service app for the demos. Its one knob is APP_MONGO_URI: D3 and D4
// point it at MongoDB or at the Oracle API for MongoDB and change nothing
// else (`./lab.sh app-uri mongo|oracle`). Port 3300 (APP_PORT overrides).
//
// Inside compose (LAB_IN_CONTAINER=1) it listens on all interfaces and compose
// publishes it on 127.0.0.1:3300; on the host it listens on 127.0.0.1 only.
import express from 'express';
import { MongoClient } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';
import { routes } from './routes.mjs';
import { createStore } from './store.mjs';

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(routes(createStore(db)));
  return app;
}

// Starts the service; resolves to {url, port, close}. The client is not
// connected up front, so the app starts even while the database is still
// coming up (/health answers 503 until it can reach it).
export async function startServer({ uri = process.env.APP_MONGO_URI || config.mongoSrcUri,
  port = Number(process.env.APP_PORT || 3300),
  host = process.env.LAB_IN_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1' } = {}) {
  // promoteLongs:false keeps Int64 fields (orders.version) as Long end to end.
  const client = new MongoClient(uri, { promoteLongs: false, serverSelectionTimeoutMS: 5000 });
  const app = createApp(client.db());
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s)).on('error', reject);
  });
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await client.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer();
  const shown = (process.env.APP_MONGO_URI || config.mongoSrcUri).replace(/\/\/[^@/]*@/, '//***@');
  console.log(`order service on :${s.port}, backend ${shown}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => s.close().then(() => process.exit(0)));
}

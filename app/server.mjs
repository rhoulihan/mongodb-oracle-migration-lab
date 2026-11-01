#!/usr/bin/env node
// Order service app for the demos. Its one knob is the backend URI: D3 and D4
// point it at MongoDB or at the Oracle API for MongoDB and change nothing
// else. It starts on APP_MONGO_URI (from .lab/app.env in compose) and switches
// live through POST /admin/backend {target: 'mongo'|'oracle'} (Ruling O):
// `./lab.sh app-uri mongo|oracle` and the demo runner use it, so the switch
// needs no restart. Port 3300 (APP_PORT overrides).
//
// Inside compose (LAB_IN_CONTAINER=1) it listens on all interfaces and compose
// publishes it on 127.0.0.1:3300 only; on the host it listens on 127.0.0.1.
import express from 'express';
import { MongoClient } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';
import { routes } from './routes.mjs';
import { createStore } from './store.mjs';

// promoteLongs:false keeps Int64 fields (orders.version) as Long end to end.
const newClient = (uri) => new MongoClient(uri, { promoteLongs: false, serverSelectionTimeoutMS: 5000 });

/**
 * The live backend: one client and its store, replaceable at runtime.
 * switchTo connects and pings the new backend first; on failure the old one
 * stays in place and the error is thrown.
 */
export function createBackend(uri) {
  let client = newClient(uri);
  let store = createStore(client.db());
  return {
    get store() { return store; },
    async switchTo(next) {
      const c = newClient(next);
      try {
        await c.connect();
        await c.db().command({ ping: 1 });
      } catch (err) {
        await c.close().catch(() => {});
        throw err;
      }
      const old = client;
      client = c;
      store = createStore(c.db());
      await old.close().catch(() => {});
    },
    close: () => client.close(),
  };
}

export function createApp(backend, uris) {
  const app = express();
  app.disable('x-powered-by');
  app.post('/admin/backend', express.json(), async (req, res) => {
    const target = req.body?.target;
    if (!Object.hasOwn(uris, target)) {
      return res.status(400).json({ error: `target must be one of ${Object.keys(uris).join(', ')}` });
    }
    try {
      await backend.switchTo(uris[target]);
      const h = await backend.store.health();
      res.json({ target, backend: h.backend });
    } catch (err) {
      res.status(503).json({ error: `cannot reach ${target}: ${err.message}` });
    }
  });
  app.use(routes(backend));
  return app;
}

// Starts the service; resolves to {url, port, close}. The client is not
// connected up front, so the app starts even while the database is still
// coming up (/health answers 503 until it can reach it). `uris` maps the
// /admin/backend targets to URIs (default: the lab's two backends).
export async function startServer({ uri = process.env.APP_MONGO_URI || config.mongoSrcUri,
  uris = { mongo: config.mongoSrcUri, oracle: config.oraMongoUri },
  port = Number(process.env.APP_PORT || 3300),
  host = process.env.LAB_IN_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1' } = {}) {
  const backend = createBackend(uri);
  const app = createApp(backend, uris);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s)).on('error', reject);
  });
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await backend.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer();
  const shown = (process.env.APP_MONGO_URI || config.mongoSrcUri).replace(/\/\/[^@/]*@/, '//***@');
  console.log(`order service on :${s.port}, backend ${shown}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => s.close().then(() => process.exit(0)));
}

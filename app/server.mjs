#!/usr/bin/env node
// Order service app for the demos. Its one knob is the backend URI: D3 and D4
// point it at MongoDB or at the Oracle API for MongoDB and change nothing
// else. It starts on APP_MONGO_URI (from .lab/app.env in compose) and switches
// live through POST /admin/backend {target: 'mongo'|'oracle'} (Ruling O):
// `./lab.sh app-uri mongo|oracle` and the demo runner use it, so the switch
// needs no restart. Port 3300 (APP_PORT overrides).
//
// D2 adds a third target, 'ageout' (`./lab.sh app-mode ageout`): both backends
// at once behind the age-out router (app/router.mjs), MongoDB as the legacy
// archive and Oracle as the current side, split at a cutoff. The body may name
// the cutoff ({target: 'ageout', cutoff: ISO}); otherwise the app takes it
// from the data (ageoutCutoff) and answers with it, so lab.sh can persist it.
// At start, APP_MODE=ageout with APP_CUTOFF (both in .lab/app.env) restores
// that mode. `./lab.sh app-mode normal` (or app-uri) leaves it.
//
// Inside compose (LAB_IN_CONTAINER=1) it listens on all interfaces and compose
// publishes it on 127.0.0.1:3300 only; on the host it listens on 127.0.0.1.
import express from 'express';
import { MongoClient } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';
import { routes } from './routes.mjs';
import { createStore } from './store.mjs';
import { ageoutCutoff, makeRouter } from './router.mjs';

// promoteLongs:false keeps Int64 fields (orders.version) as Long end to end.
const newClient = (uri) => new MongoClient(uri, { promoteLongs: false, serverSelectionTimeoutMS: 5000 });

/**
 * The live backend: its client(s) and store, replaceable at runtime. A spec
 * is a URI (one backend) or {legacy, current, cutoff?} (age-out: two URIs and
 * the cutoff Date). switchTo connects and pings the new backend(s) first; on
 * failure the old one stays in place and the error is thrown.
 */
export function createBackend(spec) {
  const open = (sp) => {
    if (typeof sp === 'string') {
      const c = newClient(sp);
      return { clients: [c], make: () => createStore(c.db()) };
    }
    const legacy = newClient(sp.legacy), current = newClient(sp.current);
    return {
      clients: [legacy, current],
      async cutoff() { return sp.cutoff ?? ageoutCutoff(legacy.db()); },
      make: (cutoff = sp.cutoff) => makeRouter({ legacy: legacy.db(), current: current.db(), cutoff }),
    };
  };
  let live = open(spec);
  let store = live.make();
  const closeAll = (clients) => Promise.allSettled(clients.map((c) => c.close()));
  return {
    get store() { return store; },
    async switchTo(next) {
      const n = open(next);
      let s;
      try {
        for (const c of n.clients) {
          await c.connect();
          await c.db().command({ ping: 1 });
        }
        s = n.cutoff ? n.make(await n.cutoff()) : n.make();
      } catch (err) {
        await closeAll(n.clients);
        throw err;
      }
      const old = live;
      live = n;
      store = s;
      await closeAll(old.clients);
    },
    close: () => closeAll(live.clients),
  };
}

export function createApp(backend, uris) {
  const app = express();
  app.disable('x-powered-by');
  app.post('/admin/backend', express.json(), async (req, res) => {
    const target = req.body?.target;
    if (!Object.hasOwn(uris, target) && target !== 'ageout') {
      return res.status(400).json({ error: `target must be one of ${[...Object.keys(uris), 'ageout'].join(', ')}` });
    }
    let spec = uris[target];
    if (target === 'ageout') {
      const cutoff = req.body.cutoff === undefined ? undefined : new Date(req.body.cutoff);
      if (cutoff && Number.isNaN(cutoff.getTime())) return res.status(400).json({ error: 'cutoff must be an ISO date' });
      spec = { legacy: uris.mongo, current: uris.oracle, cutoff };
    }
    try {
      await backend.switchTo(spec);
      const h = await backend.store.health();
      res.json({ target, backend: h.backend, ...(h.cutoff ? { cutoff: h.cutoff } : {}) });
    } catch (err) {
      res.status(503).json({ error: `cannot reach ${target}: ${err.message}` });
    }
  });
  app.use(routes(backend));
  return app;
}

// APP_MODE=ageout starts without touching a database, so it needs the
// persisted cutoff (lab.sh writes APP_CUTOFF with the mode).
function cutoffOf(v) {
  const d = new Date(v ?? NaN);
  if (Number.isNaN(d.getTime())) throw new Error('APP_MODE=ageout needs APP_CUTOFF (an ISO date): run ./lab.sh app-mode ageout');
  return d;
}

// Starts the service; resolves to {url, port, close}. The client is not
// connected up front, so the app starts even while the database is still
// coming up (/health answers 503 until it can reach it). `uris` maps the
// /admin/backend targets to URIs (default: the lab's two backends).
export async function startServer({ uri = process.env.APP_MONGO_URI || config.mongoSrcUri,
  uris = { mongo: config.mongoSrcUri, oracle: config.oraMongoUri },
  mode = process.env.APP_MODE || 'normal', cutoff = process.env.APP_CUTOFF,
  port = Number(process.env.APP_PORT || 3300),
  host = process.env.LAB_IN_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1' } = {}) {
  const backend = createBackend(mode === 'ageout' ? { legacy: uris.mongo, current: uris.oracle, cutoff: cutoffOf(cutoff) } : uri);
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
  console.log(process.env.APP_MODE === 'ageout'
    ? `order service on :${s.port}, age-out mode, cutoff ${process.env.APP_CUTOFF}`
    : `order service on :${s.port}, backend ${shown}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => s.close().then(() => process.exit(0)));
}

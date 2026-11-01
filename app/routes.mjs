// HTTP routes for the order service. Request bodies are plain JSON; responses
// are canonical Extended JSON, so BSON types (Decimal128 totals, Int64
// versions, Int32 quantities) survive the trip and can be compared exactly.
import express from 'express';
import { BSON } from 'mongodb';
import { InputError, NotFound } from './store.mjs';

const { EJSON } = BSON;

const send = (res, status, value) =>
  res.status(status).type('application/json').send(EJSON.stringify(value, { relaxed: false }));

const handle = (fn) => async (req, res) => {
  try {
    const [status, value] = await fn(req);
    send(res, status, value);
  } catch (err) {
    if (err instanceof InputError) send(res, 400, { error: err.message });
    else if (err instanceof NotFound) send(res, 404, { error: err.message });
    else send(res, 500, { error: err.message });
  }
};

// `backend.store` is read per request, so a live backend switch
// (POST /admin/backend, app/server.mjs) takes effect on the next request.
export function routes(backend) {
  const r = express.Router();
  r.use(express.json());
  r.get('/orders/:id', handle(async (q) => [200, await backend.store.getOrder(q.params.id)]));
  r.post('/orders', handle(async (q) => [201, await backend.store.placeOrder(q.body)]));
  r.patch('/orders/:id', handle(async (q) => [200, await backend.store.patchOrder(q.params.id, q.body)]));
  r.get('/dashboard/top-devices/:region', handle(async (q) => [200, await backend.store.topDevices(q.params.region)]));
  r.get('/health', async (_q, res) => {
    try {
      const h = await backend.store.health();
      send(res, h.ok ? 200 : 503, h);
    } catch (err) {
      send(res, 503, { backend: 'unknown', ok: false, error: err.message });
    }
  });
  // Malformed JSON bodies land here.
  r.use((err, _q, res, _next) => send(res, err.status ?? 500, { error: err.message }));
  return r;
}

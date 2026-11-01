// D2 Age out (Strategy A, spec section 5.2). Move only what lives long:
// regions, catalog, accounts and subscribers go to Oracle. Orders placed from
// the cutoff on go to Oracle; older orders stay in MongoDB as a read-only
// archive, and the order service (in age-out mode, app/router.mjs) routes
// each read by the cutoff and merges. Short-lived carts are never moved: they
// expire in MongoDB on their own, live, while the room watches.
//
// Terminal steps (Ruling O): `command` is what the presenter types, `run`
// does the same in-process from the runner, `verify` checks the effect.
// Console steps drive the order service over the compose network.
//
// Starting state (setup and reset): the source holds the generated data, the
// order service on MongoDB in normal mode, the eight MIG collections
// pre-created and empty, no D2 dump, and no order the demo placed left on the
// source.
import { ageoutCutoff } from '../../app/router.mjs';
import { removeDump } from '../../lib/tools.mjs';
import { prepareTarget } from '../../oracle/prep.mjs';
import { app, switchApp } from '../d3-dump-restore/index.mjs';
import { DUMP, ENTITIES, MIGRATE_CMD, migrateEntities, STAY } from './migrate-entities.mjs';

export { ENTITIES, STAY };

const RESET = 'run ./lab.sh reset d2';
const EMPTY = 'the MongoDB source is empty: run ./lab.sh generate, then ./lab.sh reset d2';
/** Set on every order this demo places (outside the app, no version bump), so reset can find them. */
export const D2_TAG = 'd2NewOrder';
/** The cart the ttl-expiry step leaves behind, already past its 120 s. */
const ABANDONED = 'CART-D2-ABANDONED';
const TTL_MS = 120_000;
const fail = (summary) => ({ ok: false, summary });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (id) => id.toHexString();
const day = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

async function startingState(ctx) {
  const src = await ctx.mongoSrc();
  if ((await src.collection('subscribers').estimatedDocumentCount()) === 0
    || (await src.collection('orders').estimatedDocumentCount()) === 0) throw new Error(EMPTY);
  await switchApp('mongo');
  // Orders the demo placed on the source (only if it ever wrote there).
  const ids = (await src.collection('orders').find({ [D2_TAG]: true }, { projection: { _id: 1 } }).toArray()).map((o) => o._id);
  if (ids.length) {
    await src.collection('orderEvents').deleteMany({ orderId: { $in: ids } });
    await src.collection('orders').deleteMany({ _id: { $in: ids } });
  }
  await src.collection('carts').deleteOne({ _id: ABANDONED });
  await removeDump(DUMP);
  await prepareTarget({ drop: true });
}

/** The order service's /health; fails unless it runs the age-out router. */
async function ageoutHealth() {
  const h = await app('GET', '/health');
  if (h.body?.backend !== 'ageout') {
    throw new Error(`the order service is not in age-out mode (backend ${h.body?.backend ?? h.status}): run ./lab.sh app-mode ageout`);
  }
  return { ...h.body, cutoff: new Date(h.body.cutoff) };
}

/**
 * The subscriber the demo follows: the first by _id with at least 3 orders
 * before the cutoff. Same seed, same subscriber.
 */
async function pickSubscriber(src, cutoff) {
  const orders = src.collection('orders');
  for await (const s of src.collection('subscribers').find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(200)) {
    if (await orders.countDocuments({ 'subscriber.id': s._id, placedAt: { $lt: cutoff } }) >= 3) return s._id;
  }
  throw new Error(`no subscriber with 3 orders before the cutoff: ${RESET}`);
}

const row = (o, from) => ({
  _id: hex(o._id), placedAt: o.placedAt.toISOString(), status: o.status, total: o.total.toString(), from,
});

function mergedTable(rows, cutoff) {
  const lines = ['placedAt (UTC)       read from  status       total    _id'];
  let marked = false;
  for (const r of rows) {
    if (!marked && new Date(r.placedAt) < cutoff) {
      lines.push(`---- cutoff ${day(cutoff)} ----`);
      marked = true;
    }
    lines.push(`${day(new Date(r.placedAt))}  ${r.from.padEnd(9)}  ${r.status.padEnd(11)}  ${r.total.padStart(7)}  ${r._id}`);
  }
  return lines.join('\n');
}

const hm = (ms) => `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`;

/** @type {import('../contract.mjs').Demo} */
export default {
  id: 'd2',
  title: 'Age out: move what lives long, let the rest expire',
  setup: startingState,
  reset: startingState,
  steps: [
    {
      id: 'migrate-entities',
      title: 'Copy only the long-lived collections to Oracle',
      lane: 'terminal',
      command: MIGRATE_CMD,
      async run(ctx) {
        // Builds its own starting state, so the step runs on its own too.
        try {
          await startingState(ctx);
        } catch (err) {
          return fail(err.message === EMPTY ? EMPTY : `could not build the starting state (${err.message}): ${RESET}`);
        }
        let rows;
        try {
          rows = await migrateEntities();
        } catch (err) {
          return fail(`${err.message}: ${RESET}`);
        }
        return {
          ok: true,
          summary: `copied ${rows.map((r) => `${r.coll} ${r.count}`).join(', ')} to Oracle; ` +
            `${STAY.join(', ')} stay in MongoDB`,
          panes: { left: rows },
          metrics: Object.fromEntries(rows.map((r) => [r.coll, r.count])),
        };
      },
      async verify(ctx) {
        const [src, ora] = [await ctx.mongoSrc(), await ctx.oraMongo()];
        const got = [];
        for (const coll of ENTITIES) {
          const [m, o] = [await src.collection(coll).countDocuments(), await ora.collection(coll).countDocuments()];
          if (o === 0) return fail(`MIG.${coll} is empty: run the migrate command`);
          if (m !== o) return fail(`MIG.${coll} has ${o} documents, the source ${m}: ${RESET}, then run the migrate command`);
          got.push(`${coll} ${o}`);
        }
        const stray = [];
        for (const coll of ['orders', 'carts', 'orderEvents']) {
          const n = await ora.collection(coll).countDocuments(coll === 'orders' ? { [D2_TAG]: { $ne: true } } : {});
          if (n) stray.push(`${coll} ${n}`);
        }
        return stray.length
          ? fail(`Oracle holds data that should have stayed in MongoDB (${stray.join(', ')}): ${RESET}`)
          : { ok: true, summary: `Oracle has ${got.join(', ')}, as on the source, and no old orders, carts or events` };
      },
    },
    {
      id: 'set-cutoff',
      title: 'Age-out mode: new orders to Oracle, old ones read from MongoDB',
      lane: 'terminal',
      command: './lab.sh app-mode ageout',
      async run(ctx) {
        const ora = await ctx.oraMongo();
        if ((await ora.collection('subscribers').countDocuments()) === 0) {
          return fail('Oracle has no subscribers yet: run the migrate-entities step first');
        }
        const r = await switchApp('ageout');
        return {
          ok: r.backend === 'ageout',
          summary: `order service in age-out mode, cutoff ${r.cutoff} (1 ms after the newest order on MongoDB)`,
          metrics: { cutoff: r.cutoff },
        };
      },
      async verify(ctx) {
        let h;
        try { h = await ageoutHealth(); } catch (err) { return fail(err.message); }
        if (h.legacy?.backend !== 'mongodb' || h.current?.backend !== 'oracle') {
          return fail(`age-out mode should read MongoDB and Oracle, reads ${h.legacy?.backend} and ${h.current?.backend}: ${RESET}`);
        }
        const want = await ageoutCutoff(await ctx.mongoSrc());
        if (want.getTime() !== h.cutoff.getTime()) {
          return fail(`the cutoff ${h.cutoff.toISOString()} does not match the source (${want.toISOString()}): run ./lab.sh app-mode ageout`);
        }
        return { ok: true, summary: `age-out mode: before ${h.cutoff.toISOString()} from MongoDB (archive), from then on Oracle` };
      },
    },
    {
      id: 'new-order',
      title: 'A new order lands in Oracle',
      lane: 'console',
      async run(ctx) {
        let h;
        try { h = await ageoutHealth(); } catch (err) { return fail(err.message); }
        const [src, ora] = [await ctx.mongoSrc(), await ctx.oraMongo()];
        const sub = await pickSubscriber(src, h.cutoff);
        const n = await ora.collection('orders').countDocuments({ [D2_TAG]: true });
        const [dev] = await ora.collection('catalog').find({ kind: 'device' }).sort({ _id: 1 }).skip(n % 50).limit(1).toArray();
        const [plan] = await ora.collection('catalog').find({ kind: 'plan' }).sort({ _id: 1 }).limit(1).toArray();
        if (!dev || !plan) return fail(`the catalog on Oracle is empty: ${RESET}`);
        const post = await app('POST', '/orders', { subscriberId: sub, lines: [{ sku: dev._id, qty: 1 }, { sku: plan._id, qty: 1 }] });
        if (post.status !== 201) return fail(`POST /orders answered ${post.status}: ${post.body?.error ?? ''} (${RESET})`);
        const id = post.body._id;
        await ora.collection('orders').updateOne({ _id: id }, { $set: { [D2_TAG]: true } });
        const onOra = await ora.collection('orders').findOne({ _id: id });
        const onSrc = await src.collection('orders').countDocuments({ _id: id });
        const back = await app('GET', `/orders/${hex(id)}`);
        const dash = await app('GET', `/dashboard/top-devices/${onOra?.region}`);
        const ok = Boolean(onOra) && onSrc === 0 && back.status === 200 && dash.status === 200;
        return {
          ok,
          summary: ok
            ? `order ${hex(id)} for ${sub} is on Oracle and not on MongoDB; placed ${onOra.placedAt.toISOString()}, after the cutoff; ` +
              `the subscriber and products it used came over with the entities`
            : `order ${hex(id)}: on Oracle ${Boolean(onOra)}, on MongoDB ${onSrc}, GET ${back.status}, dashboard ${dash.status}: ${RESET}`,
          panes: { left: { mongodb: onSrc ? 'found' : 'not found' }, right: onOra ? row(onOra, 'Oracle') : null },
          labels: { left: 'MongoDB', right: 'Oracle' },
          metrics: { orderId: hex(id), subscriberId: sub, onOracle: Boolean(onOra), onMongo: onSrc },
        };
      },
    },
    {
      id: 'cross-cutoff-read',
      title: 'One read across the cutoff: MongoDB rows, Oracle rows, merged',
      lane: 'console',
      async run(ctx) {
        let h;
        try { h = await ageoutHealth(); } catch (err) { return fail(err.message); }
        const { cutoff } = h;
        const [src, ora] = [await ctx.mongoSrc(), await ctx.oraMongo()];
        const sub = await pickSubscriber(src, cutoff);
        const byTime = { placedAt: -1, _id: -1 };
        const legacy = (await src.collection('orders').find({ 'subscriber.id': sub, placedAt: { $lt: cutoff } }).sort(byTime).toArray())
          .map((o) => row(o, 'MongoDB'));
        const current = (await ora.collection('orders').find({ 'subscriber.id': sub, placedAt: { $gte: cutoff } }).sort(byTime).toArray())
          .map((o) => row(o, 'Oracle'));
        if (current.length === 0) return fail(`${sub} has no orders on Oracle yet: run the new-order step first`);
        const got = await app('GET', `/subscribers/${sub}/orders`);
        if (got.status !== 200) return fail(`GET /subscribers/${sub}/orders answered ${got.status}: ${got.body?.error ?? ''}`);
        const side = new Map([...legacy, ...current].map((r) => [r._id, r.from]));
        const merged = got.body.map((o) => row(o, side.get(hex(o._id)) ?? '?'));
        const union = [...side.keys()].sort();
        const ids = merged.map((r) => r._id);
        const sameSet = JSON.stringify([...ids].sort()) === JSON.stringify(union);
        const sorted = merged.every((r, i) => i === 0 || merged[i - 1].placedAt >= r.placedAt);
        // A single old order by id: the router misses on Oracle, then finds it in the archive.
        const old = await app('GET', `/orders/${legacy[0]._id}`);
        const ok = sameSet && sorted && ids.length === union.length && legacy.length > 0 && old.status === 200;
        return {
          ok,
          summary: ok
            ? `${sub}: ${legacy.length} orders from MongoDB (before the cutoff) + ${current.length} from Oracle = ` +
              `${merged.length} in one merged read, newest first, same set as both sides by _id`
            : `merged read is wrong for ${sub}: ${merged.length} rows, union ${union.length}, sorted ${sorted}, ` +
              `old order by id ${old.status}: ${RESET}`,
          panes: { left: legacy, right: current },
          labels: { left: 'MongoDB (before the cutoff)', right: 'Oracle (from the cutoff)' },
          metrics: { subscriberId: sub, cutoff: cutoff.toISOString(), mongodb: legacy.length, oracle: current.length, merged: merged.length },
          detail: mergedTable(merged, cutoff),
        };
      },
    },
    {
      id: 'ttl-expiry',
      title: 'Carts expire in MongoDB: nothing to move',
      lane: 'console',
      async run(ctx) {
        const [src, ora] = [await ctx.mongoSrc(), await ctx.oraMongo()];
        const carts = src.collection('carts');
        // A cart abandoned 125 s ago: past its 120 s, so the next TTL pass
        // (every 5 s in the lab) deletes it, whatever the generated carts do.
        await carts.replaceOne({ _id: ABANDONED },
          { _id: ABANDONED, subscriberId: 'S000001', items: [], updatedAt: new Date(Date.now() - 125_000) }, { upsert: true });
        const t0 = Date.now();
        const before = await carts.countDocuments();
        const samples = [{ t: 0, carts: before }];
        let gone = false;
        while (!gone && Date.now() - t0 < 15_000) {
          await sleep(1000);
          gone = (await carts.countDocuments({ _id: ABANDONED })) === 0;
          samples.push({ t: Date.now() - t0, carts: await carts.countDocuments() });
        }
        const after = samples[samples.length - 1].carts;
        const oracleCarts = await ora.collection('carts').countDocuments();
        const last = await carts.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next();
        const lastIn = last ? last.updatedAt.getTime() + TTL_MS - Date.now() : 0;
        const ok = gone && after < before && oracleCarts === 0;
        const secs = (samples[samples.length - 1].t / 1000).toFixed(0);
        return {
          ok,
          summary: ok
            ? `MongoDB carts ${before} -> ${after} in ${secs} s, deleted by the TTL index (120 s after updatedAt), ` +
              `including a cart abandoned 125 s ago; ${after ? `the last one expires in ${hm(lastIn)}` : 'none left (run ./lab.sh generate for more)'}; ` +
              `Oracle has ${oracleCarts} carts: nothing short-lived was moved`
            : `carts did not expire as expected (before ${before}, after ${after}, abandoned cart gone ${gone}, Oracle ${oracleCarts}): ${RESET}`,
          panes: { left: samples },
          metrics: { before, after, oracleCarts, expired: before - after, lastExpiresInMs: Math.max(0, lastIn) },
          detail: `carts on MongoDB: ${samples.map((x) => `${(x.t / 1000).toFixed(0)}s ${x.carts}`).join(', ')}`,
        };
      },
    },
  ],
};

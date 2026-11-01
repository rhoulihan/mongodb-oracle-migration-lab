// D2 age-out router (Strategy A). The order service runs on two backends at
// once: `legacy` is the MongoDB source, kept as a read-only archive of the
// orders placed before the cutoff; `current` is Oracle, which holds the
// migrated long-lived entities (regions, catalog, accounts, subscribers) and
// every order placed from the cutoff on. Nothing old is copied: short-lived
// data (carts, the event log) simply expires in MongoDB.
//
// Routing rules:
//   placeOrder, topDevices        current
//   patchOrder                    current; an order only in the archive is
//                                 read-only (400)
//   getOrder                      current, then legacy
//   listOrders {subscriberId,     both sides, split at the cutoff
//     from, to}                   ([from, cutoff) legacy, [cutoff, to) current),
//                                 merged newest first
//
// Scope: the Top-N dashboard is the one on Oracle, kept exact for the orders
// Oracle holds (orders since the cutoff). An all-time Top 10 cannot be merged
// from two Top 10s, so the router does not try.
import { createStore, InputError, NotFound } from './store.mjs';

/**
 * Split a [from, to) range at the cutoff; null for a side the range misses.
 * Open ends stay undefined.
 */
export function splitRange({ from, to } = {}, cutoff) {
  const legacyTo = to && to < cutoff ? to : cutoff;
  const currentFrom = from && from > cutoff ? from : cutoff;
  return {
    legacy: from && from >= legacyTo ? null : { from, to: legacyTo },
    current: to && to <= currentFrom ? null : { from: currentFrom, to },
  };
}

const idKey = (id) => (typeof id?.toHexString === 'function' ? id.toHexString() : String(id));

/** One list: placedAt descending, then _id descending; one copy per _id, current's wins. */
export function mergeOrders(legacy, current) {
  const byId = new Map();
  for (const o of legacy) byId.set(idKey(o._id), o);
  for (const o of current) byId.set(idKey(o._id), o);
  return [...byId.values()].sort((a, b) => b.placedAt - a.placedAt
    || (idKey(a._id) < idKey(b._id) ? 1 : idKey(a._id) > idKey(b._id) ? -1 : 0));
}

/** The routing rules over two Stores (exported for tests). */
export function routeStores({ legacy, current, cutoff }) {
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new Error('the age-out router needs a cutoff Date');
  return {
    placeOrder: (body) => current.placeOrder(body),
    topDevices: (region) => current.topDevices(region),

    async getOrder(id) {
      try {
        return await current.getOrder(id);
      } catch (err) {
        if (!(err instanceof NotFound)) throw err;
        return legacy.getOrder(id);
      }
    },

    async patchOrder(id, body) {
      try {
        return await current.patchOrder(id, body);
      } catch (err) {
        if (!(err instanceof NotFound)) throw err;
        await legacy.getOrder(id); // NotFound when it is on neither side
        throw new InputError(`order ${id} was placed before the cutoff and is read-only in the MongoDB archive`);
      }
    },

    async listOrders({ subscriberId, from, to } = {}) {
      const r = splitRange({ from, to }, cutoff);
      const [a, b] = await Promise.all([
        r.legacy ? legacy.listOrders({ subscriberId, ...r.legacy }) : [],
        r.current ? current.listOrders({ subscriberId, ...r.current }) : [],
      ]);
      return mergeOrders(a, b);
    },

    async health() {
      const [l, c] = await Promise.all([legacy.health(), current.health()]);
      return { backend: 'ageout', ok: l.ok && c.ok, cutoff: cutoff.toISOString(), legacy: l, current: c };
    },
  };
}

/**
 * The age-out Store over two databases.
 * @param {{legacy: import('mongodb').Db, current: import('mongodb').Db, cutoff: Date}} opts
 */
export function makeRouter({ legacy, current, cutoff }) {
  return routeStores({ legacy: createStore(legacy), current: createStore(current), cutoff });
}

/**
 * The cutoff, taken from the data and never from the clock: 1 ms after the
 * newest order on the legacy side, so every order already there reads from
 * the archive and every order placed from now on is past it. On a freshly
 * generated source it depends only on the seed.
 */
export async function ageoutCutoff(legacyDb) {
  const newest = await legacyDb.collection('orders').find({}, { projection: { placedAt: 1 } })
    .sort({ placedAt: -1 }).limit(1).next();
  if (!newest?.placedAt) throw new Error('the MongoDB source has no orders: run ./lab.sh generate');
  return new Date(newest.placedAt.getTime() + 1);
}

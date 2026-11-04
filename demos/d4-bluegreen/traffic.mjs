// Order traffic for D4: new orders (POST /orders) and status updates
// (PATCH /orders/:id) through the order service, on whichever backend it uses
// right now. Subscribers and products come from the MongoDB source (the same
// on both sides) and are picked with a seeded generator, so a run is
// repeatable.
import { config } from '../../lib/config.mjs';
import { app } from '../d3-dump-restore/index.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `n` tasks with at most `k` in flight. */
async function pool(n, k, task) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, n) }, async () => {
    while (next < n) await task(next++);
  }));
}

/**
 * Place `orders` new orders, then set `updates` of them to provisioned.
 * With `ratePerSec`, the writes are paced to a steady rate (write n starts no
 * earlier than n / rate seconds in), so the replicator sees constant load
 * instead of one burst it catches up on.
 * @returns {Promise<{ids:import('mongodb').ObjectId[], placed:number, updated:number, failed:string[], lastWriteAt:number, ms:number}>}
 */
export async function placeOrders(ctx, { orders, updates = 0, concurrency = 4, seedOffset = 0, ratePerSec = 0, onProgress } = {}) {
  const src = await ctx.mongoSrc();
  const pick = rng(config.seed + seedOffset);
  const subs = (await src.collection('subscribers').find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(5000).toArray())
    .map((s) => s._id);
  const cat = await src.collection('catalog').find({ kind: { $in: ['device', 'plan'] } }, { projection: { kind: 1 } })
    .sort({ _id: 1 }).toArray();
  const devices = cat.filter((c) => c.kind === 'device').map((c) => c._id);
  const plans = cat.filter((c) => c.kind === 'plan').map((c) => c._id);
  const of = (list) => list[Math.floor(pick() * list.length)];
  const bodies = Array.from({ length: orders }, () => ({
    subscriberId: of(subs),
    lines: [{ sku: of(devices), qty: 1 + Math.floor(pick() * 2) }, { sku: of(plans), qty: 1 }],
  }));

  const t0 = Date.now();
  const ids = [], failed = [];
  let lastWriteAt = t0, updated = 0, n = 0;
  const pace = async () => {
    if (!ratePerSec) return;
    const due = t0 + (n++ * 1000) / ratePerSec - Date.now();
    if (due > 0) await new Promise((r) => setTimeout(r, due));
  };
  await pool(orders, concurrency, async (i) => {
    await pace();
    const r = await app('POST', '/orders', bodies[i]);
    lastWriteAt = Date.now();
    if (r.status === 201 && r.body?._id) ids.push(r.body._id);
    else failed.push(`POST /orders ${r.status} ${r.body?.error ?? ''}`.trim());
    onProgress?.({ placed: ids.length, updated });
  });
  await pool(Math.min(updates, ids.length), concurrency, async (i) => {
    await pace();
    const r = await app('PATCH', `/orders/${ids[i].toHexString()}`, { status: 'provisioned' });
    lastWriteAt = Date.now();
    if (r.status === 200) updated++;
    else failed.push(`PATCH /orders ${r.status} ${r.body?.error ?? ''}`.trim());
    onProgress?.({ placed: ids.length, updated });
  });
  return { ids, placed: ids.length, updated, failed, lastWriteAt, ms: Date.now() - t0 };
}

import { describe, expect, test } from 'vitest';
import { BSONRegExp } from 'mongodb';
import { buildDataset, SCALES } from '../../gen/model.mjs';
import { hashDocs } from '../../lib/compare.mjs';
import { INDEXES } from '../../gen/indexes.mjs';

const SEED = 20261114;
const tiny = buildDataset({ seed: SEED, scale: 'tiny' });

describe('buildDataset', () => {
  test('same seed, same data', () => {
    const a = buildDataset({ seed: SEED, scale: 'tiny' }), b = buildDataset({ seed: SEED, scale: 'tiny' });
    expect(hashDocs(a.orders)).toBe(hashDocs(b.orders));
    for (const k of Object.keys(a)) expect(hashDocs(a[k]), k).toBe(hashDocs(b[k]));
  });

  test('different seed, different data', () => {
    const c = buildDataset({ seed: SEED + 1, scale: 'tiny' });
    expect(hashDocs(c.orders)).not.toBe(hashDocs(tiny.orders));
  });

  test('tiny is 1/100 of demo for the volume collections', () => {
    const d = tiny;
    expect(d.regions).toHaveLength(8);
    expect(d.catalog).toHaveLength(SCALES.demo.catalog);
    expect(d.catalog.filter((c) => c.kind === 'device')).toHaveLength(SCALES.demo.devices);
    for (const k of ['accounts', 'subscribers', 'orders', 'carts', 'orderEvents']) {
      expect(d[k], k).toHaveLength(SCALES.demo[k] / 100);
    }
    expect(d.regionTopDevices).toHaveLength(8);
  });

  test('landmines planted', () => {
    const d = tiny;
    expect(d.catalog.some(c => c.skuPattern instanceof BSONRegExp || c.skuPattern instanceof RegExp)).toBe(true);
    expect(d.orderEvents.every(e => e.ts._bsontype === 'Timestamp')).toBe(true);
    expect(d.orders.some(o => o.version > 2n ** 53n || BigInt(o.version.toString()) > 2n ** 53n)).toBe(true);
    expect(d.orders.filter(o => BigInt(o.version.toString()) > 2n ** 53n)).toHaveLength(1);
    expect(d.orders[0].total._bsontype).toBe('Decimal128');
    expect(d.orders[0].version._bsontype).toBe('Long');
    expect(d.orders[0].lines[0].qty._bsontype).toBe('Int32');
  });

  test('order totals equal the sum of line qty * price', () => {
    for (const o of tiny.orders) {
      const cents = o.lines.reduce((s, l) => s + l.qty.value * Math.round(Number(l.price.toString()) * 100), 0);
      expect(Math.round(Number(o.total.toString()) * 100)).toBe(cents);
    }
  });

  test('references resolve', () => {
    const d = tiny;
    const acc = new Set(d.accounts.map((a) => a._id));
    const sub = new Map(d.subscribers.map((s) => [s._id, s]));
    const sku = new Set(d.catalog.map((c) => c._id));
    const ord = new Set(d.orders.map((o) => o._id.toHexString()));
    expect(d.subscribers.every((s) => acc.has(s.accountId))).toBe(true);
    expect(d.orders.every((o) => sub.has(o.subscriber.id) && o.region === sub.get(o.subscriber.id).region)).toBe(true);
    expect(d.orders.every((o) => o.lines.every((l) => sku.has(l.sku)))).toBe(true);
    expect(d.orderEvents.every((e) => ord.has(e.orderId.toHexString()))).toBe(true);
    expect(d.carts.every((c) => sub.has(c.subscriberId) && c.items.every((i) => sku.has(i.sku)))).toBe(true);
  });

  test('regionTopDevices agrees with orders', () => {
    const d = tiny;
    const name = new Map(d.catalog.map((c) => [c._id, c.name]));
    const units = new Map(); // region -> sku -> units
    for (const o of d.orders) {
      const r = units.get(o.region) ?? units.set(o.region, new Map()).get(o.region);
      for (const l of o.lines) if (l.kind === 'device') r.set(l.sku, (r.get(l.sku) ?? 0) + l.qty.value);
    }
    const expected = d.regions.map((reg) => ({
      _id: reg._id,
      top: [...(units.get(reg._id) ?? new Map())]
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .slice(0, 10)
        .map(([s, u]) => ({ sku: s, name: name.get(s), units: u })),
    }));
    const actual = d.regionTopDevices.map((t) => ({
      _id: t._id,
      top: t.top.map((e) => {
        expect(e.units._bsontype).toBe('Int32');
        return { sku: e.sku, name: e.name, units: e.units.value };
      }),
    }));
    expect(actual).toEqual(expected);
    expect(actual.every((t) => t.top.length === 10)).toBe(true);
  });

  test('account hierarchy depth <= 3 and acyclic', () => {
    const byId = new Map(tiny.accounts.map((a) => [a._id, a]));
    let maxDepth = 0;
    for (const a of tiny.accounts) {
      const seen = new Set();
      let cur = a, depth = 0;
      while (cur) {
        expect(seen.has(cur._id), `cycle at ${a._id}`).toBe(false);
        seen.add(cur._id);
        depth++;
        if (cur.parentAccountId === null) break;
        const parent = byId.get(cur.parentAccountId);
        expect(parent, `dangling parent of ${cur._id}`).toBeDefined();
        expect(parent.householdId).toBe(cur.householdId);
        cur = parent;
      }
      expect(depth).toBeLessThanOrEqual(3);
      maxDepth = Math.max(maxDepth, depth);
    }
    expect(maxDepth).toBe(3); // the family-plan hierarchy really goes 3 levels deep
  });

  test('load-clock fields follow `now`; everything else is seed-only', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const d = buildDataset({ seed: SEED, scale: 'tiny', now });
    expect(hashDocs(d.orders)).toBe(hashDocs(tiny.orders));
    const strip = (docs, f) => docs.map(({ [f]: _, ...rest }) => rest);
    expect(hashDocs(strip(d.carts, 'updatedAt'))).toBe(hashDocs(strip(tiny.carts, 'updatedAt')));
    expect(hashDocs(strip(d.orderEvents, 'createdAt'))).toBe(hashDocs(strip(tiny.orderEvents, 'createdAt')));
    expect(d.carts.every((c) => c.updatedAt >= new Date(now - 120_000))).toBe(true);
  });

  test('orderEvents.createdAt is a Date within the 7 days before `now`', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const d = buildDataset({ seed: SEED, scale: 'tiny', now });
    const week = 7 * 86_400_000;
    expect(d.orderEvents.every((e) => e.createdAt instanceof Date
      && e.createdAt <= now && now - e.createdAt < week)).toBe(true);
    const ages = d.orderEvents.map((e) => now - e.createdAt);
    expect(Math.max(...ages) - Math.min(...ages)).toBeGreaterThan(6 * 86_400_000); // spread, not one instant
  });

  test('TTL indexes: carts.updatedAt 120 s, orderEvents.createdAt 7 days, none on ts', () => {
    const ttl = INDEXES.filter(([, , o]) => o.expireAfterSeconds !== undefined)
      .map(([c, k, o]) => [c, Object.keys(k), o.expireAfterSeconds]);
    expect(ttl).toEqual([['carts', ['updatedAt'], 120], ['orderEvents', ['createdAt'], 604800]]);
  });
});

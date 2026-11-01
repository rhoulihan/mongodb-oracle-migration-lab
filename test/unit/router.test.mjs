// D2 age-out router routing rules, over fake stores (no stack needed). The
// live wiring (two real databases, the app's HTTP routes) is in
// test/integration/d2.test.mjs.
import { describe, expect, test } from 'vitest';
import { InputError, NotFound } from '../../app/store.mjs';
import { mergeOrders, routeStores, splitRange } from '../../app/router.mjs';

const CUTOFF = new Date('2026-10-01T00:00:00Z');
const at = (iso) => new Date(iso);

/** A fake Store over an in-memory order list; records calls. */
function fakeStore(name, orders = []) {
  const calls = [];
  const rec = (m, ...a) => calls.push([m, ...a]);
  return {
    calls,
    orders,
    async getOrder(id) {
      rec('getOrder', id);
      const o = orders.find((x) => x._id === id);
      if (!o) throw new NotFound(`order ${id} not found`);
      return o;
    },
    async placeOrder(body) { rec('placeOrder', body); return { _id: `${name}-new` }; },
    async patchOrder(id, body) {
      rec('patchOrder', id, body);
      if (!orders.some((x) => x._id === id)) throw new NotFound(`order ${id} not found`);
      return { _id: id, ...body };
    },
    async topDevices(region) { rec('topDevices', region); return { _id: region, from: name }; },
    async listOrders(q) {
      rec('listOrders', q);
      return orders.filter((o) => o.sub === q.subscriberId && (!q.from || o.placedAt >= q.from) && (!q.to || o.placedAt < q.to))
        .sort((a, b) => b.placedAt - a.placedAt);
    },
    async health() { return { backend: name === 'legacy' ? 'mongodb' : 'oracle', ok: true, version: '8.2' }; },
  };
}

describe('splitRange', () => {
  test('a range across the cutoff splits at it: [from, cutoff) and [cutoff, to)', () => {
    const from = at('2026-09-01T00:00:00Z'), to = at('2026-11-01T00:00:00Z');
    expect(splitRange({ from, to }, CUTOFF)).toEqual({ legacy: { from, to: CUTOFF }, current: { from: CUTOFF, to } });
  });

  test('open ends stay open on their side', () => {
    expect(splitRange({}, CUTOFF)).toEqual({ legacy: { from: undefined, to: CUTOFF }, current: { from: CUTOFF, to: undefined } });
  });

  test('a range wholly before or after the cutoff asks one side only', () => {
    expect(splitRange({ from: at('2026-01-01T00:00:00Z'), to: at('2026-02-01T00:00:00Z') }, CUTOFF).current).toBeNull();
    expect(splitRange({ from: at('2026-10-05T00:00:00Z') }, CUTOFF).legacy).toBeNull();
    // to is exclusive: a range ending at the cutoff never reaches the current side.
    expect(splitRange({ to: CUTOFF }, CUTOFF).current).toBeNull();
  });
});

describe('mergeOrders', () => {
  test('placedAt descending, then _id descending; one copy per _id (current wins)', () => {
    const a = [{ _id: 'a1', placedAt: at('2026-09-03T00:00:00Z') }, { _id: 'dup', placedAt: at('2026-09-01T00:00:00Z'), side: 'legacy' }];
    const b = [{ _id: 'b1', placedAt: at('2026-10-03T00:00:00Z') }, { _id: 'dup', placedAt: at('2026-09-01T00:00:00Z'), side: 'current' },
      { _id: 'b0', placedAt: at('2026-10-03T00:00:00Z') }];
    const m = mergeOrders(a, b);
    expect(m.map((o) => o._id)).toEqual(['b1', 'b0', 'a1', 'dup']);
    expect(m.find((o) => o._id === 'dup').side).toBe('current');
  });

  test('ObjectId-like _ids compare by their hex string', () => {
    const id = (h) => ({ toHexString: () => h, toString: () => h });
    const t = at('2026-09-01T00:00:00Z');
    expect(mergeOrders([{ _id: id('aa'), placedAt: t }], [{ _id: id('bb'), placedAt: t }]).map((o) => o._id.toHexString()))
      .toEqual(['bb', 'aa']);
  });
});

describe('routeStores', () => {
  const old = { _id: 'old', sub: 'S1', placedAt: at('2026-09-15T00:00:00Z') };
  const older = { _id: 'older', sub: 'S1', placedAt: at('2026-08-15T00:00:00Z') };
  const fresh = { _id: 'fresh', sub: 'S1', placedAt: at('2026-10-15T00:00:00Z') };
  const make = () => {
    const legacy = fakeStore('legacy', [old, older]);
    const current = fakeStore('current', [fresh]);
    return { legacy, current, r: routeStores({ legacy, current, cutoff: CUTOFF }) };
  };

  test('exposes exactly the Store methods the app uses', () => {
    expect(Object.keys(make().r).sort()).toEqual(['getOrder', 'health', 'listOrders', 'patchOrder', 'placeOrder', 'topDevices']);
  });

  test('writes and the dashboard go to current', async () => {
    const { legacy, current, r } = make();
    expect(await r.placeOrder({ subscriberId: 'S1' })).toEqual({ _id: 'current-new' });
    expect((await r.topDevices('R01')).from).toBe('current');
    expect(legacy.calls).toEqual([]);
    expect(current.calls.map((c) => c[0])).toEqual(['placeOrder', 'topDevices']);
  });

  test('getOrder tries current, then legacy; missing on both is NotFound', async () => {
    const { legacy, r } = make();
    expect((await r.getOrder('fresh'))._id).toBe('fresh');
    expect(legacy.calls).toEqual([]);
    expect((await r.getOrder('old'))._id).toBe('old');
    await expect(r.getOrder('nope')).rejects.toBeInstanceOf(NotFound);
  });

  test('patchOrder writes to current; an order only in the archive is read-only (InputError)', async () => {
    const { legacy, r } = make();
    expect(await r.patchOrder('fresh', { status: 'shipped' })).toMatchObject({ _id: 'fresh', status: 'shipped' });
    const e = await r.patchOrder('old', { status: 'shipped' }).catch((x) => x);
    expect(e).toBeInstanceOf(InputError);
    expect(e.message).toMatch(/before the cutoff.*read-only/);
    expect(legacy.calls.some((c) => c[0] === 'patchOrder')).toBe(false);
    await expect(r.patchOrder('nope', { status: 'shipped' })).rejects.toBeInstanceOf(NotFound);
  });

  test('listOrders fans out by the cutoff and merges, newest first', async () => {
    const { legacy, current, r } = make();
    const got = await r.listOrders({ subscriberId: 'S1', from: at('2026-09-01T00:00:00Z'), to: at('2026-11-01T00:00:00Z') });
    expect(got.map((o) => o._id)).toEqual(['fresh', 'old']);
    expect(legacy.calls).toEqual([['listOrders', { subscriberId: 'S1', from: at('2026-09-01T00:00:00Z'), to: CUTOFF }]]);
    expect(current.calls).toEqual([['listOrders', { subscriberId: 'S1', from: CUTOFF, to: at('2026-11-01T00:00:00Z') }]]);
  });

  test('listOrders inside one side asks only that side', async () => {
    const { current, r } = make();
    expect((await r.listOrders({ subscriberId: 'S1', to: at('2026-09-01T00:00:00Z') })).map((o) => o._id)).toEqual(['older']);
    expect(current.calls).toEqual([]);
  });

  test('health names both sides and the cutoff', async () => {
    expect(await make().r.health()).toMatchObject({
      backend: 'ageout', ok: true, cutoff: CUTOFF.toISOString(),
      legacy: { backend: 'mongodb' }, current: { backend: 'oracle' },
    });
  });
});

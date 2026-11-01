// Deterministic telecom dataset for the migration lab.
//
// One seeded PRNG (mulberry32) is threaded through every builder in a fixed
// order, so the same seed and scale always give byte-identical documents.
// The only input that is not derived from the seed is `now` (the load clock).
// It anchors the two TTL fields, which must be fresh at load time:
//   carts.updatedAt        TTL 120 s
//   orderEvents.createdAt  TTL 7 days; now minus a seeded offset in [0, 7 days)
// Seeded offsets do not depend on `now`, and orders never see it, so order
// hashes are seed-only.
//
// Planted BSON landmines (the types a migration has to carry across):
//   catalog.skuPattern   BSON regular expression
//   orders.version       Int64 (Long); exactly one order holds a value over 2^53
//   orderEvents.ts       BSON Timestamp (not a Date)
//   prices and totals    Decimal128; line qty and Top-N units are Int32
//
// regionTopDevices ordering (Task 3 and Task 7 must reproduce it exactly):
//   per region, sum line.qty over every order line with kind 'device';
//   sort by units descending, then by sku ascending (plain string compare);
//   keep the first 10.
import { Decimal128, Int32, Long, ObjectId, Timestamp } from 'mongodb';

// Fixed clock for everything except carts. All orders fall before it.
export const ANCHOR = new Date('2026-10-01T00:00:00Z');

export const SCALES = {
  demo: {
    regions: 8, catalog: 300, devices: 120, plans: 60,
    accounts: 20_000, subscribers: 30_000, orders: 200_000, carts: 5_000, orderEvents: 300_000,
  },
};
// tiny is 1/100 of demo for the volume collections. Regions and catalog are
// reference data and stay full size (a Top-10 needs more than one device).
SCALES.tiny = {
  ...SCALES.demo,
  ...Object.fromEntries(['accounts', 'subscribers', 'orders', 'carts', 'orderEvents']
    .map((k) => [k, SCALES.demo[k] / 100])),
};

export const ORDER_STATUSES = ['placed', 'provisioned', 'shipped', 'activated'];
export const TIERS = ['basic', 'plus', 'premium', 'business'];
const TOP_N = 10;
const BIG_VERSION = '9007199254740993'; // 2^53 + 1, not representable as a double

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small helpers over the shared PRNG.
function tools(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  // Weighted pick from a precomputed cumulative weight table.
  const pickCum = (items, cum) => {
    const x = rand() * cum[cum.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] > x) hi = m; else lo = m + 1; }
    return items[lo];
  };
  return { rand, int, pick, pickCum };
}

const pad = (n, w) => String(n).padStart(w, '0');
const money = (cents) => Decimal128.fromString((cents / 100).toFixed(2));
const cumulative = (weights) => { let s = 0; return weights.map((w) => (s += w)); };

const REGION_NAMES = ['Northeast', 'Southeast', 'Great Lakes', 'Central Plains',
  'South Central', 'Mountain West', 'Pacific Northwest', 'Pacific Southwest'];
const REGION_STATES = [['NY', 'MA', 'PA'], ['GA', 'FL', 'NC'], ['IL', 'OH', 'MI'], ['KS', 'NE', 'IA'],
  ['TX', 'OK', 'LA'], ['CO', 'UT', 'AZ'], ['WA', 'OR', 'ID'], ['CA', 'NV', 'HI']];
const BRANDS = { Apple: ['iPhone 17', 'iPhone 17 Pro', 'iPad Air'], Samsung: ['Galaxy S26', 'Galaxy Z Fold', 'Galaxy A56'],
  Google: ['Pixel 10', 'Pixel 10 Pro', 'Pixel Tablet'], Motorola: ['Edge', 'Razr', 'Moto G'],
  OnePlus: ['13', 'Nord'], Nokia: ['G42', 'XR21'] };
const PLAN_WORDS = ['Unlimited', 'Essentials', 'Starter', 'Family', 'Business', 'Prepaid', 'Data Only', 'Senior'];
const ADDON_WORDS = ['International Pass', 'Device Protection', 'Hotspot Boost', 'Streaming Bundle',
  'Cloud Storage', 'Roaming Day Pass', 'Number Lock', 'Smartwatch Line', 'Call Filter', 'Wi-Fi Calling Plus'];
const FIRST = ['Ava', 'Ben', 'Carla', 'Dev', 'Elena', 'Faisal', 'Grace', 'Hiro', 'Ines', 'Jamal', 'Kira', 'Liam',
  'Maya', 'Noah', 'Olu', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Uma', 'Victor', 'Wen', 'Yara', 'Zane'];
const LAST = ['Adams', 'Baker', 'Chen', 'Diaz', 'Evans', 'Fischer', 'Garcia', 'Huang', 'Ito', 'Johnson', 'Kim',
  'Lopez', 'Miller', 'Nguyen', 'Okafor', 'Patel', 'Reyes', 'Smith', 'Tanaka', 'Usman', 'Walker', 'Young'];
const STREETS = ['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Lake', 'Hill', 'River', 'Park', 'Main'];
const CITIES = ['Springfield', 'Riverton', 'Fairview', 'Lakeside', 'Georgetown', 'Franklin', 'Clinton', 'Ashland'];

function buildRegions(n) {
  return Array.from({ length: n }, (_, i) => ({ _id: `R${pad(i + 1, 2)}`, name: REGION_NAMES[i] }));
}

function buildCatalog(t, s) {
  const out = [];
  const brands = Object.keys(BRANDS);
  for (let i = 1; i <= s.devices; i++) {
    const brand = brands[(i - 1) % brands.length];
    const model = `${t.pick(BRANDS[brand])} ${t.pick(['64GB', '128GB', '256GB', '512GB'])} ${t.pick(['Black', 'Silver', 'Blue', 'Green'])}`;
    out.push({ _id: `SKU-DEV-${pad(i, 4)}`, kind: 'device', name: `${brand} ${model}`,
      price: money(t.int(199, 1499) * 100 - 1), skuPattern: /^SKU-DEV-[0-9]{4}$/, brand, model });
  }
  for (let i = 1; i <= s.plans; i++) {
    out.push({ _id: `SKU-PLN-${pad(i, 4)}`, kind: 'plan', name: `${t.pick(PLAN_WORDS)} ${i}`,
      price: money(t.int(15, 120) * 100), skuPattern: /^SKU-PLN-[0-9]{4}$/ });
  }
  for (let i = 1; i <= s.catalog - s.devices - s.plans; i++) {
    out.push({ _id: `SKU-ADD-${pad(i, 4)}`, kind: 'addon', name: `${t.pick(ADDON_WORDS)} ${i}`,
      price: money(t.int(3, 30) * 100 - 1), skuPattern: /^sku-add-[0-9]{4}$/i });
  }
  return out;
}

// Family-plan hierarchy: a root account, optional child lines, optional
// grandchild lines. Depth is at most 3 and parents always precede children.
function buildAccounts(t, n, regions) {
  const out = [], depth = [], eligible = []; // eligible = indexes with depth < 3
  for (let i = 0; i < n; i++) {
    const _id = `A${pad(i + 1, 6)}`;
    let acct;
    if (eligible.length === 0 || t.rand() < 0.55) {
      acct = { _id, householdId: `H${pad(i + 1, 6)}`, parentAccountId: null,
        region: t.pick(regions)._id, tier: t.pick(TIERS) };
      depth.push(1);
    } else {
      const p = eligible[t.int(Math.max(0, eligible.length - 50), eligible.length - 1)];
      const parent = out[p];
      acct = { _id, householdId: parent.householdId, parentAccountId: parent._id,
        region: parent.region, tier: parent.tier };
      depth.push(depth[p] + 1);
    }
    out.push(acct);
    if (depth[i] < 3) eligible.push(i);
  }
  return out;
}

function buildSubscribers(t, n, accounts) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // Every account gets at least one subscriber, the rest spread at random.
    const acct = i < accounts.length ? accounts[i] : t.pick(accounts);
    const state = t.pick(REGION_STATES[Number(acct.region.slice(1)) - 1]);
    out.push({
      _id: `S${pad(i + 1, 6)}`, accountId: acct._id, name: `${t.pick(FIRST)} ${t.pick(LAST)}`,
      address: { street: `${t.int(1, 9999)} ${t.pick(STREETS)} St`, city: t.pick(CITIES),
        state, zip: pad(t.int(10000, 99999), 5) },
      tier: acct.tier, region: acct.region,
    });
  }
  return out;
}

function buildOrders(t, n, subscribers, catalog) {
  const devices = catalog.filter((c) => c.kind === 'device');
  const plans = catalog.filter((c) => c.kind === 'plan');
  const addons = catalog.filter((c) => c.kind === 'addon');
  // Skewed popularity so each region has a clear Top-10. The ranking is
  // rotated per region so the regional dashboards differ.
  const devCum = cumulative(devices.map((_, j) => 1 / (j + 1) ** 0.9));
  const ranks = devices.map((_, j) => j);
  const devicePick = (region) =>
    devices[(t.pickCum(ranks, devCum) + 7 * (Number(region.slice(1)) - 1)) % devices.length];
  const cents = (c) => Math.round(Number(c.price.toString()) * 100);
  const window = 180 * 86_400_000;
  const bigAt = Math.floor(t.rand() * n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const sub = t.pick(subscribers);
    const chosen = new Map();
    const add = (item, qty) => { if (!chosen.has(item._id)) chosen.set(item._id, { item, qty }); };
    if (t.rand() < 0.75) add(devicePick(sub.region), t.rand() < 0.85 ? 1 : t.int(2, 3));
    if (t.rand() < 0.6) add(t.pick(plans), 1);
    for (let k = t.int(0, 2); k > 0; k--) add(t.pick(addons), t.int(1, 2));
    if (chosen.size === 0) add(t.pick(plans), 1);
    let total = 0;
    const lines = [...chosen.values()].map(({ item, qty }) => {
      total += qty * cents(item);
      return { sku: item._id, kind: item.kind, qty: new Int32(qty), price: item.price };
    });
    const placedAt = new Date(ANCHOR.getTime() - window + Math.floor(t.rand() * window));
    const tail = pad(Math.floor(t.rand() * 0xffffffff).toString(16), 8) + pad(i.toString(16), 8);
    out.push({
      _id: new ObjectId(pad(Math.floor(placedAt.getTime() / 1000).toString(16), 8) + tail),
      subscriber: { id: sub._id, name: sub.name, tier: sub.tier, address: sub.address },
      region: sub.region,
      status: 'placed', // set by buildOrderEvents
      lines, total: money(total), placedAt,
      version: i === bigAt ? Long.fromString(BIG_VERSION) : Long.fromNumber(t.int(1, 5)),
    });
  }
  return out;
}

// Each order gets one event per lifecycle stage it reached, so the event log
// agrees with orders.status. Stages are drawn at random, then nudged until the
// total hits the target count exactly.
function buildOrderEvents(t, target, orders, now) {
  const WEEK = 7 * 86_400_000;
  const max = ORDER_STATUSES.length - 1;
  if (target < orders.length || target > orders.length * (max + 1)) {
    throw new Error(`orderEvents ${target} not reachable for ${orders.length} orders`);
  }
  const stage = orders.map(() => Math.min(max, Math.floor(-Math.log(1 - t.rand()))));
  let extra = target - orders.length - stage.reduce((a, b) => a + b, 0);
  while (extra !== 0) {
    const k = Math.floor(t.rand() * orders.length);
    if (extra > 0 && stage[k] < max) { stage[k]++; extra--; }
    else if (extra < 0 && stage[k] > 0) { stage[k]--; extra++; }
  }
  const out = [];
  orders.forEach((o, i) => {
    o.status = ORDER_STATUSES[stage[i]];
    let at = Math.floor(o.placedAt.getTime() / 1000);
    for (let s = 0; s <= stage[i]; s++) {
      if (s > 0) at += t.int(600, 3 * 86_400);
      out.push({
        _id: new ObjectId(pad(at.toString(16), 8) + pad(out.length.toString(16), 16)),
        orderId: o._id, type: ORDER_STATUSES[s], ts: new Timestamp({ t: at, i: s + 1 }),
        createdAt: new Date(now.getTime() - Math.floor(t.rand() * WEEK)),
      });
    }
  });
  return out;
}

// Carts expire 120 s after updatedAt. updatedAt is spread so the carts expire
// steadily over the hour after `now` instead of all at once.
function buildCarts(t, n, subscribers, catalog, now) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const items = [];
    const seen = new Set();
    for (let k = t.int(1, 3); k > 0; k--) {
      const c = t.pick(catalog);
      if (!seen.has(c._id)) { seen.add(c._id); items.push({ sku: c._id, qty: new Int32(t.int(1, 2)) }); }
    }
    out.push({ _id: `CART-${pad(i + 1, 6)}`, subscriberId: t.pick(subscribers)._id, items,
      updatedAt: new Date(now.getTime() - 120_000 + Math.floor(t.rand() * 3_600_000)) });
  }
  return out;
}

// See the ordering rule in the header comment.
export function topDevices(orders, catalog, regions) {
  const name = new Map(catalog.map((c) => [c._id, c.name]));
  const units = new Map(regions.map((r) => [r._id, new Map()]));
  for (const o of orders) {
    const r = units.get(o.region);
    for (const l of o.lines) if (l.kind === 'device') r.set(l.sku, (r.get(l.sku) ?? 0) + Number(l.qty));
  }
  return regions.map((reg) => ({
    _id: reg._id,
    top: [...units.get(reg._id)]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .slice(0, TOP_N)
      .map(([sku, u]) => ({ sku, name: name.get(sku), units: new Int32(u) })),
  }));
}

export function buildDataset({ seed, scale = 'demo', now = ANCHOR } = {}) {
  const s = SCALES[scale];
  if (!s) throw new Error(`unknown scale ${scale} (use ${Object.keys(SCALES).join(', ')})`);
  if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
  const t = tools(mulberry32(seed));
  const regions = buildRegions(s.regions);
  const catalog = buildCatalog(t, s);
  const accounts = buildAccounts(t, s.accounts, regions);
  const subscribers = buildSubscribers(t, s.subscribers, accounts);
  const orders = buildOrders(t, s.orders, subscribers, catalog);
  const orderEvents = buildOrderEvents(t, s.orderEvents, orders, now);
  const carts = buildCarts(t, s.carts, subscribers, catalog, now);
  const regionTopDevices = topDevices(orders, catalog, regions);
  return { regions, catalog, accounts, subscribers, orders, carts, orderEvents, regionTopDevices };
}

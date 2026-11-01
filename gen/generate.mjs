#!/usr/bin/env node
// Loads the deterministic telecom dataset into the MongoDB source database.
//
//   node gen/generate.mjs --seed 20261114 --scale demo [--target src]
//
// Drops the `telco` database, inserts every collection in batches of 5,000
// (ordered: false), then creates the indexes, including the two TTL indexes.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';
import { closeAll, mongoSrc } from '../lib/db.mjs';
import { buildDataset, SCALES } from './model.mjs';

const BATCH = 5_000;

// [collection, index key, options]
export const INDEXES = [
  ['carts', { updatedAt: 1 }, { name: 'carts_ttl', expireAfterSeconds: 120 }],
  ['carts', { subscriberId: 1 }, {}],
  ['orderEvents', { ts: 1 }, { name: 'orderEvents_ttl', expireAfterSeconds: 604_800 }],
  ['orderEvents', { orderId: 1 }, {}],
  ['orders', { region: 1, placedAt: -1 }, {}],
  ['orders', { 'subscriber.id': 1 }, {}],
  ['subscribers', { accountId: 1 }, {}],
  ['accounts', { householdId: 1 }, {}],
  ['accounts', { parentAccountId: 1 }, {}],
  ['catalog', { kind: 1 }, {}],
];

const TARGETS = { src: mongoSrc };

export async function load(db, data) {
  await db.dropDatabase();
  const counts = {};
  for (const [name, docs] of Object.entries(data)) {
    const coll = db.collection(name);
    for (let i = 0; i < docs.length; i += BATCH) {
      await coll.insertMany(docs.slice(i, i + BATCH), { ordered: false });
    }
    counts[name] = docs.length;
  }
  for (const [name, key, opts] of INDEXES) await db.collection(name).createIndex(key, opts);
  return counts;
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string', default: String(config.seed) },
      scale: { type: 'string', default: 'demo' },
      target: { type: 'string', default: 'src' },
    },
  });
  const seed = Number(values.seed);
  if (!SCALES[values.scale]) throw new Error(`unknown --scale ${values.scale}`);
  if (!TARGETS[values.target]) throw new Error(`unknown --target ${values.target} (only: src)`);

  const t0 = performance.now();
  // Carts carry a 120 s TTL, so their clock is the load time.
  const data = buildDataset({ seed, scale: values.scale, now: new Date() });
  const t1 = performance.now();
  const db = await TARGETS[values.target]();
  const counts = await load(db, data);
  const t2 = performance.now();

  for (const [name, n] of Object.entries(counts)) console.log(`${name.padEnd(17)} ${n}`);
  console.log(`seed ${seed}, scale ${values.scale}: built in ${((t1 - t0) / 1000).toFixed(1)} s, ` +
    `loaded in ${((t2 - t1) / 1000).toFixed(1)} s, total ${((t2 - t0) / 1000).toFixed(1)} s`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(closeAll);
}

// D4 Blue/green with a fallback path (spec section 5.2, D4). Blue is the
// MongoDB source, green is Oracle. An initial load (D3's dump and restore),
// then live replication MongoDB to Oracle with the lag shown, the cutover
// (stop the replicator, flip the app), then reverse replication Oracle to
// MongoDB, so MongoDB stays a working fallback. The last step proves no write
// was lost or duplicated: counts and hashes match on both sides.
//
// The replicator is a stand-in for Oracle GoldenGate, labeled as one in the
// console and on every log line (replicator/). Presenter commands:
//   ./lab.sh repl fwd     forward, MongoDB change stream -> Oracle API for MongoDB
//   ./lab.sh repl stop    drain to lag 0, save the resume token, stop
//   ./lab.sh repl rev     reverse, mig_changelog (capture triggers) -> MongoDB
// They run the compose `replicator` service. Headless runs and tests start the
// same code in-process instead (each terminal step's run), and the last step
// stops it again.
//
// Starting state (setup and reset): no replicator running, the order service
// on MongoDB. Setup also does the initial load: MIG holds a fresh D3 restore
// of the source, the capture objects (oracle/sql/d4-changelog.sql) are
// installed after it, and fwd.token holds the source's operation time from
// just before the dump, so the forward stream picks up every write after the
// dump began. Reset drops the capture objects and clears LAB_STATE_DIR/d4.
import d3, { app, switchApp } from '../d3-dump-restore/index.mjs';
import { COLLECTIONS } from '../../oracle/prep.mjs';
import { caughtUp, clearState, isLive, LABEL, loadState, readStatus, saveState } from '../../replicator/apply.mjs';
import { captureInstalled, dropCapture, installCapture } from '../../replicator/capture.mjs';
import { startForward } from '../../replicator/forward.mjs';
import { startReverse } from '../../replicator/reverse.mjs';
import { compareSides, formatComparison } from '../../replicator/verify.mjs';
import { placeOrders } from './traffic.mjs';

export { placeOrders, switchApp };

const RESET = 'run ./lab.sh reset d4';
const STAND_IN = 'Stand-in for Oracle GoldenGate';
// Steady load, not a burst: 500 writes at 25/s (20 s) forward, 190 at 19/s (10 s)
// back, so the lag is measured while writes keep arriving.
const BLUE = { orders: 400, updates: 100, concurrency: 4, seedOffset: 101, ratePerSec: 25 };
const GREEN = { orders: 150, updates: 40, concurrency: 4, seedOffset: 202, ratePerSec: 19 };
const fail = (summary) => ({ ok: false, summary });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Replicators this process started (headless runs and tests).
const local = { fwd: null, rev: null };

async function stopLocal() {
  for (const k of ['fwd', 'rev']) {
    const h = local[k];
    local[k] = null;
    if (h) await h.stop();
  }
}

async function backend() {
  const h = await app('GET', '/health');
  return h.body?.backend;
}

/**
 * Wait until a replicator direction is caught up past `since`; null on
 * timeout, or when it has been gone for 30 s (a presenter who kills it and
 * runs `./lab.sh repl fwd` again in time keeps the step alive).
 */
async function waitCaughtUp(dir, since, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let goneSince = null;
  for (;;) {
    const s = readStatus(dir);
    if (caughtUp(s, since)) return s;
    goneSince = isLive(s) ? null : goneSince ?? Date.now();
    if (Date.now() > end || (goneSince && Date.now() - goneSince > 30_000)) return null;
    await sleep(200);
  }
}

async function startingState(ctx) {
  await stopLocal();
  if (isLive(readStatus('fwd')) || isLive(readStatus('rev'))) {
    throw new Error(`the replicator is still running: ${RESET}`);
  }
  await switchApp('mongo');
  const conn = await ctx.oraSql();
  await dropCapture(conn);
  clearState();
  // The source's operation time before the dump: the forward stream starts
  // here, so a write made while the dump and restore run is not lost (and one
  // already in the dump is applied again, which is idempotent).
  const startAt = (await (await ctx.mongoSrc()).command({ ping: 1 })).operationTime;
  for (const id of ['dump', 'restore']) {
    const r = await d3.steps.find((s) => s.id === id).run(ctx);
    if (!r.ok) throw new Error(`the initial load (D3 ${id}) failed: ${r.summary}`);
  }
  await installCapture(conn);
  saveState('fwd.token', { startAt });
  saveState('ready.json', { at: Date.now() });
}

/** The starting state is still unused: loaded, captured, nothing replicated yet. */
async function stillFresh(ctx) {
  const token = loadState('fwd.token');
  return Boolean(loadState('ready.json') && token?.startAt && !token.token && !loadState('rev.seq') &&
    !readStatus('fwd') && !readStatus('rev') && (await captureInstalled(await ctx.oraSql())) &&
    (await backend()) === 'mongodb');
}

/** Sample a direction's lag every 250 ms; ctx.log a line each second. */
function lagSampler(ctx, dir, label) {
  const samples = [];
  const t0 = Date.now();
  let lastLog = 0;
  const timer = setInterval(() => {
    const s = readStatus(dir);
    if (!s) return;
    samples.push({ t: Date.now() - t0, at: Date.now(), lagMs: s.lagMs, applied: s.applied });
    if (Date.now() - lastLog >= 1000) {
      ctx.log?.(`      ${LABEL} ${label}: ${s.applied} changes applied, lag ${s.lagMs} ms`);
      lastLog = Date.now();
    }
  }, 250);
  return { samples, stop: () => clearInterval(timer), peak: () => Math.max(0, ...samples.map((x) => x.lagMs)) };
}

// Lag while the writes were arriving: the samples inside the write window
// that measured a change in flight (0 means "nothing waiting" between batches).
function loadLag(samples, w, plan) {
  const from = w.lastWriteAt - w.ms;
  const inWindow = samples.filter((x) => x.at >= from && x.at <= w.lastWriteAt);
  const live = inWindow.filter((x) => x.lagMs > 0).map((x) => x.lagMs).sort((a, b) => a - b);
  const pct = (p) => (live.length ? live[Math.min(live.length - 1, Math.floor(p * live.length))] : 0);
  return { rate: plan.ratePerSec, seconds: Math.round(w.ms / 1000), p50: pct(0.5), p95: pct(0.95), max: live.at(-1) ?? 0,
    measured: live.length, samples: inWindow.length };
}
const loadLine = (l) => `${l.rate} writes/s for ${l.seconds} s, lag under load p50 ${l.p50} ms, p95 ${l.p95} ms, max ${l.max} ms`;

const lagLine = (samples) => samples.filter((_, i) => i % 4 === 0)
  .map((x) => `${(x.t / 1000).toFixed(1)}s ${x.lagMs}ms`).join(', ');

/** Drive traffic through the app while one direction runs, then wait for it to catch up. */
async function writeThrough(ctx, { dir, want, plan, label }) {
  if (!isLive(readStatus(dir))) {
    return fail(`the ${dir === 'fwd' ? 'forward' : 'reverse'} replicator is not running: run ./lab.sh repl ${dir}`);
  }
  const b = await backend();
  if (b !== want) return fail(`the order service writes to ${b ?? 'nothing'}, expected ${want}: ${RESET}`);
  const lag = lagSampler(ctx, dir, label);
  let w, s;
  try {
    w = await placeOrders(ctx, plan);
    s = await waitCaughtUp(dir, w.lastWriteAt, 120_000);
  } finally {
    lag.stop();
  }
  if (w.failed.length) return fail(`${w.failed.length} app calls failed (${w.failed[0]}): ${RESET}`);
  if (!s) return fail(`the replicator did not catch up within 120 s: ${RESET}`);
  return { w, s, peak: lag.peak(), samples: lag.samples, load: loadLag(lag.samples, w, plan) };
}

// What "same sha-256" means on screen (D4 step 7).
const HASH_NOTE = 'sha-256 is a fingerprint of a whole collection: every document, in _id order, '
  + 'every field and value with its exact BSON type (Int32, Int64 and Double differ), keys sorted. '
  + 'One changed, lost or duplicated document gives a different hash. Each side is hashed on its own '
  + 'and only the fingerprints are compared. MongoDB documents are hashed in the form Oracle stores them '
  + '(Decimal128 trailing zeros, the regex and Timestamp tags), and TTL collections only for documents '
  + 'not about to expire.';
/** @type {import('../contract.mjs').Demo} */

export default {
  id: 'd4',
  title: 'Blue/green with a fallback path',
  banner: STAND_IN,
  setup: startingState,
  async reset(ctx) {
    await stopLocal();
    await switchApp('mongo');
    await dropCapture(await ctx.oraSql());
    clearState();
  },
  steps: [
    {
      id: 'setup',
      title: 'Initial load: MongoDB copied to Oracle',
      lane: 'console',
      async run(ctx) {
        // The console runs this step on its own (no demo.setup), so it builds
        // the starting state itself unless it is still unused.
        let reused = false;
        try {
          if (await stillFresh(ctx)) reused = true;
          else await startingState(ctx);
        } catch (err) {
          return fail(`could not build the starting state (${err.message}): ${RESET}`);
        }
        const [src, ora] = [await ctx.mongoSrc(), await ctx.oraMongo()];
        const [m, o] = await Promise.all([src, ora].map((db) => db.collection('orders').countDocuments()));
        return m === o && m > 0
          ? { ok: true, summary: `initial load ${reused ? 'in place' : 'done'}: ${m} orders on MongoDB and on Oracle; Oracle captures its own changes for the way back`,
            metrics: { orders: m } }
          : fail(`after the initial load MongoDB has ${m} orders and Oracle ${o}: ${RESET}`);
      },
    },
    {
      id: 'start-forward',
      title: `Start replication MongoDB to Oracle (${STAND_IN})`,
      lane: 'terminal',
      command: './lab.sh repl fwd',
      async run() {
        if (!local.fwd && !isLive(readStatus('fwd'))) {
          local.fwd = startForward({ colls: COLLECTIONS, quiet: true });
          try { await local.fwd.ready; } catch (err) { local.fwd = null; return fail(`${err.message}`); }
        }
        return { ok: true, summary: `${STAND_IN}: forward replication running, MongoDB change stream to the Oracle API for MongoDB` };
      },
      async verify() {
        const s = readStatus('fwd');
        return isLive(s)
          ? { ok: true, summary: `forward replicator running: ${s.applied} changes applied, lag ${s.lagMs} ms` }
          : fail(`the forward replicator is not running${s?.error ? ` (${s.error})` : ''}: run ./lab.sh repl fwd`);
      },
    },
    {
      id: 'write-blue',
      title: 'Write to MongoDB through the app, watch the lag',
      lane: 'console',
      async run(ctx) {
        const r = await writeThrough(ctx, { dir: 'fwd', want: 'mongodb', plan: BLUE, label: 'forward' });
        if (!r.w) return r;
        const ora = await ctx.oraMongo();
        const landed = await ora.collection('orders').countDocuments({ _id: { $in: r.w.ids } });
        return {
          ok: landed === r.w.placed,
          summary: `${r.w.placed} new and ${r.w.updated} updated orders on MongoDB at ${loadLine(r.load)}; ` +
            `${landed} of the new orders are on Oracle, now caught up`,
          metrics: { placed: r.w.placed, updated: r.w.updated, landed, lagP50Ms: r.load.p50, lagP95Ms: r.load.p95, lagMaxMs: r.load.max, applied: r.s.applied, writeMs: r.w.ms },
          panes: { left: r.samples.map(({ at, ...x }) => x) },
          detail: `lag under load: ${r.load.measured} of ${r.load.samples} samples (every 250 ms) caught a change in flight\n` +
            `lag over time: ${lagLine(r.samples)}`,
        };
      },
    },
    {
      id: 'cutover',
      title: 'Cutover: stop the replicator, point the app at Oracle',
      lane: 'terminal',
      command: './lab.sh repl stop && ./lab.sh app-uri oracle',
      async run() {
        if (local.fwd) { await local.fwd.stop(); local.fwd = null; }
        const r = await switchApp('oracle');
        return { ok: r.backend === 'oracle', summary: `forward replication stopped, order service switched to ${r.backend}` };
      },
      async verify(ctx) {
        const s = readStatus('fwd');
        if (isLive(s)) return fail('the forward replicator is still running: run ./lab.sh repl stop');
        const b = await backend();
        if (b !== 'oracle') return fail(`the order service still writes to ${b}: run ./lab.sh app-uri oracle`);
        const [m, o] = await Promise.all([await ctx.mongoSrc(), await ctx.oraMongo()]
          .map((db) => db.collection('orders').countDocuments()));
        return m === o
          ? { ok: true, summary: `forward replicator stopped after ${s?.applied ?? 0} changes; the app writes to Oracle; ${o} orders on both sides` }
          : fail(`orders differ at the cutover (MongoDB ${m}, Oracle ${o}): ${RESET}`);
      },
    },
    {
      id: 'start-reverse',
      title: `Start replication Oracle to MongoDB, the fallback path (${STAND_IN})`,
      lane: 'terminal',
      command: './lab.sh repl rev',
      async run() {
        if (!local.rev && !isLive(readStatus('rev'))) {
          local.rev = startReverse({ colls: COLLECTIONS, quiet: true });
          try { await local.rev.ready; } catch (err) { local.rev = null; return fail(`${err.message}`); }
        }
        return { ok: true, summary: `${STAND_IN}: reverse replication running, mig_changelog to MongoDB` };
      },
      async verify() {
        const s = readStatus('rev');
        return isLive(s)
          ? { ok: true, summary: `reverse replicator running: ${s.applied} changes applied, lag ${s.lagMs} ms` }
          : fail(`the reverse replicator is not running${s?.error ? ` (${s.error})` : ''}: run ./lab.sh repl rev`);
      },
    },
    {
      id: 'write-green',
      title: 'Write to Oracle through the app, watch it land in MongoDB',
      lane: 'console',
      async run(ctx) {
        const r = await writeThrough(ctx, { dir: 'rev', want: 'oracle', plan: GREEN, label: 'reverse' });
        if (!r.w) return r;
        const src = await ctx.mongoSrc();
        const landed = await src.collection('orders').countDocuments({ _id: { $in: r.w.ids } });
        return {
          ok: landed === r.w.placed,
          summary: `${r.w.placed} new and ${r.w.updated} updated orders on Oracle at ${loadLine(r.load)}; ` +
            `${landed} of the new orders are back on MongoDB, now caught up`,
          metrics: { placed: r.w.placed, updated: r.w.updated, landed, lagP50Ms: r.load.p50, lagP95Ms: r.load.p95, lagMaxMs: r.load.max, applied: r.s.applied, writeMs: r.w.ms },
          panes: { left: r.samples.map(({ at, ...x }) => x) },
          detail: `lag under load: ${r.load.measured} of ${r.load.samples} samples (every 250 ms) caught a change in flight\n` +
            `lag over time: ${lagLine(r.samples)}`,
        };
      },
    },
    {
      id: 'verify',
      title: 'No lost or duplicated writes: counts and hashes on both sides',
      lane: 'console',
      async run(ctx) {
        try {
          // Let a running replicator drain first.
          for (const dir of ['fwd', 'rev']) {
            if (isLive(readStatus(dir)) && !(await waitCaughtUp(dir, Date.now(), 60_000))) {
              return fail(`the ${dir === 'fwd' ? 'forward' : 'reverse'} replicator did not catch up within 60 s: ${RESET}`);
            }
          }
          const rows = await compareSides(await ctx.mongoSrc(), await ctx.oraMongo());
          const bad = rows.filter((r) => !r.equal || r.mongo !== r.oracle).map((r) => r.coll);
          const docs = rows.reduce((n, r) => n + r.mongo, 0);
          return {
            ok: bad.length === 0,
            summary: bad.length
              ? `MongoDB and Oracle differ for ${bad.join(', ')}: ${RESET}`
              : `all ${rows.length} collections match: ${docs} documents, same counts, same sha-256 on both sides`,
            verified: HASH_NOTE,
            panes: { left: rows },
            metrics: { collections: rows.length, documents: docs },
            detail: `${formatComparison(rows)}\n\n${HASH_NOTE}`,
          };
        } finally {
          // A headless run ends here: stop what this process started.
          await stopLocal();
        }
      },
    },
  ],
};

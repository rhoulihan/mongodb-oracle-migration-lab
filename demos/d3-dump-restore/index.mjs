// D3 Dump/restore: "lift and shift". mongodump the source, mongorestore into
// the pre-created MIG collections on Oracle, compare counts at the dump
// snapshot, show the $type differential, flip the order service to Oracle,
// smoke-test it, and show the real Oracle plan behind a find().
//
// Terminal steps (Ruling O): `command` is what the presenter types on the
// host; `run` does the same thing in-process (the runner container has the
// MongoDB Database Tools; on the host, lib/tools.mjs runs them in lab-mongo);
// `verify` checks the effect only.
//
// Starting state (setup and reset): the order service on MongoDB, the eight
// MIG collections pre-created and empty, no dump in /dumps.
import { BSON } from 'mongodb';
import { config } from '../../lib/config.mjs';
import { mongoExplain } from '../../lib/measure.mjs';
import { dumpExists, readDump, removeDump, runTool } from '../../lib/tools.mjs';
import { COLLECTIONS, prepareTarget } from '../../oracle/prep.mjs';
import { readArchive } from './archive.mjs';
import { formatTypeDiff, typeDiff } from './typediff.mjs';

const { EJSON } = BSON;
const DUMP = '/dumps/telco.archive';
const SRC_DB = 'telco';
const EXPLAIN_FILTER = { region: 'R03', status: 'provisioned' };

// Shown on the slide and typed by the presenter. lab.sh adds the restore URI
// (MIG, password from MIG_PASSWORD, no database in the path: with `/MIG`
// mongorestore restores 0 documents and still exits 0, Ruling Q), so the
// command never shows the password.
const DUMP_CMD = `./lab.sh exec mongo mongodump --archive=${DUMP} --gzip --db ${SRC_DB}`;
const RESTORE_CMD = `./lab.sh mongorestore-ora --archive=${DUMP} --gzip --nsFrom '${SRC_DB}.*' --nsTo 'MIG.*' ` +
  '--numParallelCollections=4';
const EXPLAIN_CMD = `./lab.sh mongosh ora --eval 'db.orders.find(${JSON.stringify(EXPLAIN_FILTER).replace(/"(\w+)":/g, '$1:')}).explain()'`;

// What the last in-process restore reported, per collection (the restore
// half of the dump-vs-restore snapshot; null when the presenter restored in a
// terminal, in which case counts falls back to the TTL bounds alone).
let lastRestore = null;

const tail = (s, n = 3) => s.trim().split('\n').slice(-n).join(' | ');

export async function app(method, path, body) {
  const res = await fetch(config.appUrl + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let value = null;
  try { value = text ? EJSON.parse(text, { relaxed: false }) : null; } catch { value = text; }
  return { status: res.status, body: value };
}

export async function switchApp(target) {
  let r;
  try {
    r = await app('POST', '/admin/backend', { target });
  } catch (err) {
    throw new Error(`order service not reachable at ${config.appUrl} (${err.cause?.code ?? err.message}): run ./lab.sh up`);
  }
  if (r.status !== 200) throw new Error(`order service could not switch to ${target}: ${r.body?.error ?? r.status}`);
  return r.body;
}

async function startingState() {
  lastRestore = null;
  await removeDump(DUMP);
  await prepareTarget({ drop: true });
  await switchApp('mongo');
}

// The smoke step tags the order it places (SMOKE_TAG) right after the POST.
// Counts leave out those orders and their orderEvents, so counts still
// compares against the dump after a smoke run (headless, console or test).
const SMOKE_TAG = 'd3SmokeTest';

/** Documents the smoke step wrote, per collection: {orders, orderEvents, ids}. */
async function smokeWrites(ora) {
  const ids = (await ora.collection('orders').find({ [SMOKE_TAG]: true }, { projection: { _id: 1 } }).toArray())
    .map((d) => d._id);
  const events = ids.length ? await ora.collection('orderEvents').countDocuments({ orderId: { $in: ids } }) : 0;
  return { orders: ids.length, orderEvents: events };
}

/** Per collection: what the archive holds and what Oracle holds now (smoke writes excluded). */
async function compareCounts(ora, archive) {
  archive ??= await readArchive(readDump(DUMP));
  const smoke = await smokeWrites(ora);
  const oracle = new Map();
  for (const c of COLLECTIONS) oracle.set(c, (await ora.collection(c).countDocuments()) - (smoke[c] ?? 0));
  // Taken after the Oracle counts: every archived document still unexpired
  // now was unexpired while Oracle was counted, so Oracle must hold it.
  const now = Date.now();
  return COLLECTIONS.map((coll) => {
    const a = archive.get(`${SRC_DB}.${coll}`) ?? { count: 0, ttl: null, deadlines: null };
    const row = { coll, archive: a.count, restored: lastRestore?.get(coll) ?? null, oracle: oracle.get(coll),
      smokeExcluded: smoke[coll] ?? 0 };
    if (a.ttl) {
      // A TTL collection keeps expiring on both sides (Oracle runs the
      // restored TTL index too), so its live count is a range, not a number.
      row.ttl = `${a.ttl.field} + ${a.ttl.seconds}s`;
      row.unexpired = a.deadlines.filter((d) => d > now).length;
      row.ok = row.unexpired <= row.oracle && row.oracle <= row.archive;
    } else {
      row.ok = row.oracle === row.archive;
    }
    if (row.restored !== null) row.ok &&= row.restored === row.archive;
    return row;
  });
}

function countsTable(rows) {
  const head = ['collection', 'in the dump', 'restored', 'on Oracle now', 'note'];
  const body = rows.map((r) => [
    r.coll, String(r.archive), r.restored === null ? '-' : String(r.restored), String(r.oracle),
    [r.ttl ? `TTL ${r.ttl}: ${r.archive - r.oracle} expired since the dump (${r.unexpired} still unexpired)` : '',
      r.smokeExcluded ? `${r.smokeExcluded} smoke-test documents left out` : ''].filter(Boolean).join('; '),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

/** @type {import('../contract.mjs').Demo} */
export default {
  id: 'd3',
  title: 'Dump and restore: lift and shift',
  setup: startingState,
  reset: startingState,
  steps: [
    {
      id: 'dump',
      title: 'Dump the MongoDB source with mongodump',
      lane: 'terminal',
      command: DUMP_CMD,
      async run() {
        await removeDump(DUMP);
        const r = await runTool(['mongodump', '--uri', config.toolSrcUri, `--archive=${DUMP}`, '--gzip', '--db', SRC_DB]);
        if (r.code !== 0) return { ok: false, summary: `mongodump failed: ${tail(r.stderr)}` };
        const dumped = [...r.stderr.matchAll(/done dumping `[^`]+` \((\d+) documents?\)/g)].reduce((s, m) => s + Number(m[1]), 0);
        return {
          ok: dumped > 0,
          summary: `dumped ${dumped} documents from ${SRC_DB} in ${(r.ms / 1000).toFixed(1)} s`,
          metrics: { dumpMs: Math.round(r.ms), dumped },
        };
      },
      async verify() {
        if (!(await dumpExists(DUMP))) return { ok: false, summary: `no dump at ${DUMP}: run the dump command` };
        const a = await readArchive(readDump(DUMP));
        const missing = COLLECTIONS.filter((c) => !a.has(`${SRC_DB}.${c}`));
        const docs = [...a.values()].reduce((s, x) => s + x.count, 0);
        return missing.length
          ? { ok: false, summary: `the dump is missing ${missing.join(', ')}` }
          : { ok: true, summary: `${DUMP} holds ${COLLECTIONS.length} collections, ${docs} documents` };
      },
    },
    {
      id: 'restore',
      title: 'Restore into Oracle with mongorestore',
      lane: 'terminal',
      command: RESTORE_CMD,
      async run() {
        // The target is pre-created (never implicit creation): mongorestore
        // only inserts into the existing, empty MIG collections and builds
        // the indexes from the dump metadata.
        await prepareTarget({ drop: true });
        lastRestore = null;
        const r = await runTool(['mongorestore', `--archive=${DUMP}`, '--gzip', '--nsFrom', `${SRC_DB}.*`, '--nsTo', 'MIG.*',
          '--numParallelCollections=4', '--uri', config.toolOraUri]);
        const m = r.stderr.match(/(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore/);
        const restored = m ? Number(m[1]) : 0, failed = m ? Number(m[2]) : NaN;
        const created = /creating collection/i.test(r.stderr);
        lastRestore = new Map([...r.stderr.matchAll(/finished restoring `MIG\.(\w+)` \((\d+) documents?, (\d+) failures?\)/g)]
          .map((x) => [x[1], Number(x[2])]));
        const metrics = { restoreMs: Math.round(r.ms), restored, failed };
        if (r.code !== 0) return { ok: false, summary: `mongorestore failed: ${tail(r.stderr)}`, metrics };
        // Ruling Q: zero restored documents is a failure, never a success.
        if (restored === 0) return { ok: false, summary: `mongorestore restored 0 documents: ${tail(r.stderr)}`, metrics };
        if (created) return { ok: false, summary: 'mongorestore created a collection: the target was not pre-created', metrics };
        return {
          ok: failed === 0,
          summary: `restored ${restored} documents (${failed} failed) into MIG in ${(r.ms / 1000).toFixed(1)} s`,
          metrics,
        };
      },
      async verify(ctx) {
        const ora = await ctx.oraMongo();
        // Only collections count: views (D5's region_top_devices_v and _dv)
        // are listed too, with type 'view', and are not restore targets.
        const names = (await ora.listCollections({}).toArray())
          .filter((c) => c.type !== 'view').map((c) => c.name).sort();
        const extra = names.filter((n) => !COLLECTIONS.includes(n));
        if (extra.length) return { ok: false, summary: `unexpected collections on Oracle: ${extra.join(', ')}` };
        const orders = (await ora.collection('orders').countDocuments()) - (await smokeWrites(ora)).orders;
        if (orders === 0) return { ok: false, summary: 'MIG.orders is empty: run the restore command' };
        // With the dump present, Oracle must hold exactly the dumped orders:
        // anything else means a restore into collections that were not empty.
        if (await dumpExists(DUMP)) {
          const dumped = (await readArchive(readDump(DUMP))).get(`${SRC_DB}.orders`)?.count ?? 0;
          if (orders !== dumped) {
            return { ok: false, summary: `MIG.orders holds ${orders} documents but the dump has ${dumped}: run ./lab.sh reset d3 first` };
          }
        }
        return { ok: true, summary: `MIG holds the ${COLLECTIONS.length} pre-created collections; orders has ${orders} documents, as dumped` };
      },
    },
    {
      id: 'counts',
      title: 'Compare document counts at the dump snapshot',
      lane: 'console',
      async run(ctx) {
        const rows = await compareCounts(await ctx.oraMongo());
        const bad = rows.filter((r) => !r.ok).map((r) => r.coll);
        const smoke = rows.reduce((n, r) => n + r.smokeExcluded, 0);
        const note = smoke ? ` (${smoke} smoke-test documents left out)` : '';
        return {
          ok: bad.length === 0,
          summary: bad.length
            ? `counts differ for ${bad.join(', ')}${note}`
            : `all ${rows.length} collections match the dump${note}`,
          panes: { left: rows },
          detail: countsTable(rows),
        };
      },
    },
    {
      id: 'typediff',
      title: 'The $type differential',
      lane: 'console',
      async run(ctx) {
        const rows = await typeDiff(await ctx.mongoSrc(), await ctx.oraMongo(), COLLECTIONS);
        const types = rows.filter((r) => r.kind === 'type');
        const values = rows.filter((r) => r.kind === 'value' && !r.ok);
        return {
          ok: true,
          summary: `${types.length} fields with a type or $type difference, ${values.length} value checks that changed`,
          panes: { left: rows },
          detail: formatTypeDiff(rows),
        };
      },
    },
    {
      id: 'flip',
      title: 'Point the order service at Oracle',
      lane: 'terminal',
      command: './lab.sh app-uri oracle',
      async run() {
        const r = await switchApp('oracle');
        return { ok: r.backend === 'oracle', summary: `order service switched to ${r.backend}` };
      },
      async verify() {
        const h = await app('GET', '/health');
        return h.body?.backend === 'oracle'
          ? { ok: true, summary: `order service reports backend oracle (${h.body.ordsVersion ?? h.body.version})` }
          : { ok: false, summary: `order service reports backend ${h.body?.backend ?? h.status}: run ./lab.sh app-uri oracle` };
      },
    },
    {
      id: 'smoke',
      title: 'Smoke-test the unchanged app on Oracle',
      lane: 'console',
      async run(ctx) {
        const ora = await ctx.oraMongo();
        const calls = [];
        const check = (call, ok, note) => { calls.push({ call, ok: Boolean(ok), note }); return ok; };

        const h = await app('GET', '/health');
        check('GET /health', h.body?.backend === 'oracle', `backend ${h.body?.backend}`);

        // An existing order (never the planted Int64 one: Ruling K).
        const existing = await ora.collection('orders').findOne({ region: 'R03' }, { promoteLongs: false });
        const got = await app('GET', `/orders/${existing._id.toHexString()}`);
        check('GET /orders/:id', got.status === 200 && got.body?._id?.equals(existing._id), `status ${got.status}`);

        const sub = await ora.collection('subscribers').findOne({ region: 'R03' });
        const dev = await ora.collection('catalog').findOne({ kind: 'device' });
        const plan = await ora.collection('catalog').findOne({ kind: 'plan' });
        const post = await app('POST', '/orders', { subscriberId: sub._id, lines: [{ sku: dev._id, qty: 1 }, { sku: plan._id, qty: 1 }] });
        check('POST /orders', post.status === 201 && post.body?._id, `status ${post.status}`);
        const id = post.body?._id?.toHexString?.();
        // Tag it (outside the app, no version bump) so counts can leave it out.
        if (id) await ora.collection('orders').updateOne({ _id: post.body._id }, { $set: { [SMOKE_TAG]: true } });

        const patch = id ? await app('PATCH', `/orders/${id}`, { status: 'provisioned' }) : { status: 0 };
        check('PATCH /orders/:id', patch.status === 200, `status ${patch.status}`);
        const after = id ? await app('GET', `/orders/${id}`) : { status: 0 };
        check('GET /orders/:id (after PATCH)',
          after.status === 200 && after.body?.status === 'provisioned' && after.body?.version?.toString() === '2',
          `status ${after.body?.status}, version ${after.body?.version}`);

        const dash = await app('GET', `/dashboard/top-devices/${sub.region}`);
        check('GET /dashboard/top-devices/:region', dash.status === 200 && dash.body?.top?.length === 10,
          `${dash.body?.top?.length} devices`);

        const failed = calls.filter((c) => !c.ok);
        return {
          ok: failed.length === 0,
          summary: failed.length
            ? `smoke test failed: ${failed.map((c) => `${c.call} (${c.note})`).join('; ')}`
            : `${calls.length} app calls passed on Oracle, app code unchanged`,
          panes: { left: calls },
          metrics: { backend: h.body?.backend },
        };
      },
    },
    {
      id: 'explain',
      title: 'The real Oracle plan behind find()',
      lane: 'terminal',
      command: EXPLAIN_CMD,
      async run(ctx) {
        const left = await mongoExplain(await ctx.mongoSrc(), 'orders', EXPLAIN_FILTER);
        const right = await mongoExplain(await ctx.oraMongo(), 'orders', EXPLAIN_FILTER);
        return {
          ok: /SELECT STATEMENT/.test(right),
          summary: `Oracle plans the find with ${/INDEX/.test(right) ? 'an index from the dump' : 'no index'}`,
          plan: { left, right },
          labels: { left: 'MongoDB', right: 'Oracle' },
          detail: `MongoDB:\n${left}\n\nOracle:\n${right}`,
        };
      },
      async verify(ctx) {
        const plan = await mongoExplain(await ctx.oraMongo(), 'orders', EXPLAIN_FILTER);
        return /SELECT STATEMENT/.test(plan)
          ? { ok: true, summary: `Oracle plan: ${plan.split('\n').map((l) => l.trim()).join(' > ')}` }
          : { ok: false, summary: 'no Oracle plan for the find' };
      },
    },
  ],
};

// D4 reverse direction, Oracle to MongoDB: the fallback path after the
// cutover (a stand-in for Oracle GoldenGate). The capture triggers
// (oracle/sql/d4-changelog.sql) write one mig_changelog row per changed
// document; this polls `seq > :last order by seq fetch first 500 rows only`
// every 250 ms and replays the rows into the MongoDB source.
//
// Each row is applied as "make MongoDB match Oracle now": the document is
// read back through the Oracle API for MongoDB (the same mapping the app
// sees) and replaceOne(upsert) into MongoDB, or deleted when Oracle no longer
// has it. That is idempotent, so a restart from rev.seq re-applies at most
// one poll and loses nothing. Tagged sub-documents the Oracle API returns for
// a Timestamp or regex go back as BSON types (restoreTypes).
//
// seq is an identity, assigned at insert, so a row can commit after a higher
// one. The applied position only moves past a missing seq once it has been
// missing for 5 s (a rolled-back write leaves a permanent gap).
import oracledb from 'oracledb';
import { mongoSrc, oraMongo, oraSql } from '../lib/db.mjs';
import { canonical } from '../lib/compare.mjs';
import { COLLECTIONS } from '../oracle/prep.mjs';
import { idFromOracle, isClosedError, loadState, log as labeled, READ, restoreTypes, saveState, statusWriter } from './apply.mjs';
import { captureInstalled } from './capture.mjs';

const POLL_MS = 250;
const PAGE = 500;
const GAP_MS = 5000;

/** Make MongoDB match Oracle for the documents these changelog rows name. */
export async function applyRows(ora, src, rows) {
  const byColl = new Map();
  for (const r of rows) {
    const ids = byColl.get(r.coll) ?? new Map();
    const id = idFromOracle(r.id);
    ids.set(canonical({ id }), id);
    byColl.set(r.coll, ids);
  }
  for (const [coll, ids] of byColl) {
    const docs = await ora.collection(coll).find({ _id: { $in: [...ids.values()] } }, READ).toArray();
    const now = new Map(docs.map((d) => [canonical({ id: d._id }), d]));
    const ops = [...ids].map(([k, _id]) => (now.has(k)
      ? { replaceOne: { filter: { _id }, replacement: restoreTypes(now.get(k)), upsert: true } }
      : { deleteOne: { filter: { _id } } }));
    await src.collection(coll).bulkWrite(ops, { ordered: false });
  }
}

/**
 * Start reverse replication.
 * @param {{colls?:string[], fromSeqFile?:string, quiet?:boolean, out?:(line:string)=>void}} opts
 *   fromSeqFile: state file name under LAB_STATE_DIR/d4 (default rev.seq)
 * @returns {{ready:Promise<void>, done:Promise<void>, stop:()=>Promise<void>, stats:()=>{applied:number, lagMs:number}}}
 */
export function startReverse({ colls = COLLECTIONS, fromSeqFile = 'rev.seq', quiet = false, out } = {}) {
  const say = (m) => (quiet ? undefined : labeled(`reverse: ${m}`, out));
  let applied = 0, lagMs = 0, idleSince = null, state = 'starting', lastSourceAt = null, error = null;
  let stopping = false, killed = false;
  const status = statusWriter('rev', () => ({ state, applied, lagMs, idleSince, lastSourceAt, error }));
  const wanted = new Set(colls);

  let markReady, failReady;
  const ready = new Promise((res, rej) => { markReady = res; failReady = rej; });
  ready.catch(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const done = (async () => {
    const conn = await oraSql();
    const ora = await oraMongo();
    const src = await mongoSrc();
    if (!(await captureInstalled(conn))) {
      throw new Error('mig_changelog and its capture triggers are not installed: run ./lab.sh reset d4');
    }
    let low = Number(loadState(fromSeqFile)?.seq ?? 0);
    const above = new Set();   // applied seqs past a gap
    let gapSince = null, busy = false, lastLog = 0;
    say(`Oracle -> MongoDB, polling mig_changelog after seq ${low}`);
    state = 'running';
    status.write();
    markReady();

    while (!killed) {
      try {
        const r = await conn.execute(
          `select seq, coll, op, id, changed_at from mig_changelog where seq > :low order by seq fetch first ${PAGE} rows only`,
          { low }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const fresh = r.rows.map((x) => ({ seq: Number(x.SEQ), coll: x.COLL, op: x.OP, id: x.ID, at: x.CHANGED_AT }))
          .filter((x) => !above.has(x.seq));
        if (fresh.length) {
          await applyRows(ora, src, fresh.filter((x) => wanted.has(x.coll)));
          applied += fresh.length;
          for (const x of fresh) above.add(x.seq);
          lastSourceAt = fresh[fresh.length - 1].at.getTime();
          lagMs = Math.max(1, Date.now() - lastSourceAt);
          idleSince = null;
          busy = true;
          if (Date.now() - lastLog >= 2000) { say(`applied ${applied} changes, lag ${lagMs} ms`); lastLog = Date.now(); }
        }
        // Move the applied position over every contiguous applied seq; skip a
        // gap only once it has stayed open for GAP_MS.
        const before = low;
        while (above.has(low + 1)) above.delete(++low);
        if (above.size) {
          gapSince ??= Date.now();
          if (Date.now() - gapSince >= GAP_MS) {
            const next = Math.min(...above);
            say(`seq ${low + 1} to ${next - 1} never committed (rolled back), moving past it`);
            low = next - 1;
            while (above.has(low + 1)) above.delete(++low);
            gapSince = null;
          }
        } else {
          gapSince = null;
        }
        if (low !== before) saveState(fromSeqFile, { seq: low });
        if (fresh.length === PAGE) continue;
        if (!fresh.length && !above.size) {
          lagMs = 0;
          if (idleSince === null) idleSince = Date.now();
          if (busy) { say(`caught up: ${applied} changes applied, lag 0 ms`); busy = false; lastLog = 0; }
          if (stopping) break;
        }
        await sleep(POLL_MS);
      } catch (err) {
        if (killed || isClosedError(err)) break;
        error = err.message;
        say(`error, retrying in 1 s: ${err.message}`);
        await sleep(1000);
      }
    }
  })();

  done.then(
    () => { state = 'stopped'; lagMs = 0; status.stop(); say(`stopped after ${applied} changes`); },
    (err) => { state = 'failed'; error = err.message; status.stop(); failReady(err); say(`failed: ${err.message}`); },
  );

  return {
    ready,
    done,
    stats: () => ({ applied, lagMs, state, idleSince }),
    /** Drain to caught up (at most 20 s), save the position, stop. */
    async stop() {
      stopping = true;
      const timer = new Promise((r) => setTimeout(r, 20_000).unref());
      await Promise.race([done.catch(() => {}), timer]);
      killed = true;
      await done.catch(() => {});
    },
  };
}

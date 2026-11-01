// D4 forward direction, MongoDB to Oracle (a stand-in for Oracle GoldenGate).
// Watches the telco database's change stream with fullDocument:'updateLookup'
// and applies each change through the Oracle API for MongoDB: an insert,
// replace or update becomes replaceOne(upsert) of the full document by _id, a
// delete becomes deleteOne. Changes are applied in batches (100 changes or
// 250 ms, whichever comes first) and the resume token is saved after every
// batch, so a restart (even after SIGKILL) resumes where it left off. A
// replay after a crash re-applies at most one batch, and every apply is
// idempotent by _id: nothing is lost and nothing is duplicated.
//
// Type fidelity (Ruling K): the stream is read with promoteValues and
// promoteLongs off, so Int32, Int64, Double and Decimal128 reach Oracle with
// their BSON types.
//
// Loop prevention: every write goes through one explicit MongoDB session,
// registered in mig_repl_session, and the capture triggers skip that session
// (oracle/sql/d4-changelog.sql explains why client_info cannot be set directly).
import { mongoSrc, oraMongo, oraSql } from '../lib/db.mjs';
import { COLLECTIONS } from '../oracle/prep.mjs';
import { isClosedError, loadState, log as labeled, READ, saveState, statusWriter } from './apply.mjs';
import { captureInstalled, registerSession } from './capture.mjs';

const OPS = ['insert', 'update', 'replace', 'delete'];
const BATCH = 100;
const FLUSH_MS = 250;

const sourceTime = (ev) => (ev.wallTime ? ev.wallTime.getTime() : ev.clusterTime.getHighBitsUnsigned() * 1000);

/** Apply one batch of change events, in order, as bulk writes per run of one collection. */
export async function applyEvents(ora, session, events) {
  let i = 0;
  while (i < events.length) {
    const coll = events[i].ns.coll;
    const ops = [];
    for (; i < events.length && events[i].ns.coll === coll; i++) {
      const e = events[i];
      const filter = { _id: e.documentKey._id };
      if (e.operationType === 'delete') ops.push({ deleteOne: { filter } });
      else if (e.fullDocument) ops.push({ replaceOne: { filter, replacement: e.fullDocument, upsert: true } });
      // An update whose document was deleted before the lookup: its delete event follows.
    }
    if (ops.length) await ora.collection(coll).bulkWrite(ops, { ordered: true, session });
  }
}

/**
 * Start forward replication.
 * @param {{colls?:string[], resumeFile?:string, quiet?:boolean, out?:(line:string)=>void}} opts
 *   resumeFile: state file name under LAB_STATE_DIR/d4 (default fwd.token)
 * @returns {{ready:Promise<void>, done:Promise<void>, stop:()=>Promise<void>, stats:()=>{applied:number, lagMs:number}}}
 */
export function startForward({ colls = COLLECTIONS, resumeFile = 'fwd.token', quiet = false, out } = {}) {
  const say = (m) => (quiet ? undefined : labeled(`forward: ${m}`, out));
  let applied = 0, lagMs = 0, idleSince = null, state = 'starting', lastSourceAt = null, error = null;
  let stopping = false, killed = false, stream = null, session = null;
  const status = statusWriter('fwd', () => ({ state, applied, lagMs, idleSince, lastSourceAt, error }));

  let markReady, failReady;
  const ready = new Promise((res, rej) => { markReady = res; failReady = rej; });
  ready.catch(() => {});

  async function open(src, saved) {
    const opts = { fullDocument: 'updateLookup', maxAwaitTimeMS: 100, batchSize: 500, ...READ };
    if (saved?.token) opts.resumeAfter = saved.token;
    else if (saved?.startAt) opts.startAtOperationTime = saved.startAt;
    stream = src.watch([{ $match: { operationType: { $in: OPS }, 'ns.coll': { $in: colls } } }], opts);
  }

  const done = (async () => {
    const src = await mongoSrc();
    const ora = await oraMongo();
    const conn = await oraSql();
    if (!(await captureInstalled(conn))) {
      throw new Error('the reverse capture (mig_changelog and its triggers) is not installed: run ./lab.sh reset d4');
    }
    session = ora.client.startSession();
    await registerSession(conn, session.id.id.toString('base64'), 'fwd');

    let saved = loadState(resumeFile);
    say(saved?.token ? 'MongoDB -> Oracle, resuming from the saved resume token'
      : saved?.startAt ? 'MongoDB -> Oracle, starting at the initial load (no resume token yet)'
        : 'MongoDB -> Oracle, starting now (no resume token and no initial-load mark)');
    await open(src, saved);
    say(`watching telco (${colls.length} collections), applying through the Oracle API for MongoDB`);

    let batch = [], batchStart = 0, lastLog = 0, busy = false;
    const saveToken = () => {
      const token = stream.resumeToken;
      if (token && token._data !== saved?.token?._data) { saved = { token }; saveState(resumeFile, saved); }
    };

    while (!killed) {
      let ev;
      try {
        ev = await stream.tryNext();
        if (state === 'starting') { state = 'running'; status.write(); markReady(); }
        if (ev) {
          if (!batch.length) batchStart = Date.now();
          batch.push(ev);
          idleSince = null;
        }
        if (batch.length && (batch.length >= BATCH || ev === null || Date.now() - batchStart >= FLUSH_MS)) {
          await applyEvents(ora, session, batch);
          applied += batch.length;
          lastSourceAt = sourceTime(batch[batch.length - 1]);
          lagMs = Math.max(1, Date.now() - lastSourceAt);
          saveToken();
          batch = [];
          busy = true;
          if (Date.now() - lastLog >= 2000) { say(`applied ${applied} changes, lag ${lagMs} ms`); lastLog = Date.now(); }
          continue;
        }
        if (ev === null && !batch.length) {
          lagMs = 0;
          if (idleSince === null) idleSince = Date.now();
          if (busy) { say(`caught up: ${applied} changes applied, lag 0 ms`); busy = false; lastLog = 0; }
          saveToken();   // the post-batch token moves on while idle
          if (stopping) break;
        }
      } catch (err) {
        if (killed || isClosedError(err)) break;
        // 286 ChangeStreamHistoryLost, 280 ChangeStreamFatalError: the saved
        // position is gone from the oplog, so a retry can never succeed.
        if (err.code === 286 || err.code === 280) {
          throw new Error(`cannot resume the change stream (${err.message}): run ./lab.sh reset d4`);
        }
        error = err.message;
        say(`error, retrying from the saved token in 1 s: ${err.message}`);
        batch = [];
        try { await stream.close(); } catch { /* already closed */ }
        await new Promise((r) => setTimeout(r, 1000));
        if (killed) break;
        await open(src, saved);
      }
    }
    try { await stream?.close(); } catch { /* closed */ }
  })();

  done.then(
    () => { state = 'stopped'; lagMs = 0; status.stop(); say(`stopped after ${applied} changes`); },
    (err) => { state = 'failed'; error = err.message; status.stop(); failReady(err); say(`failed: ${err.message}`); },
  ).finally(() => session?.endSession().catch(() => {}));

  return {
    ready,
    done,
    stats: () => ({ applied, lagMs, state, idleSince }),
    /** Drain to caught up (at most 20 s), save the token, stop. */
    async stop() {
      stopping = true;
      const timer = new Promise((r) => setTimeout(r, 20_000).unref());
      await Promise.race([done.catch(() => {}), timer]);
      killed = true;
      await done.catch(() => {});
    },
  };
}

#!/usr/bin/env node
// The D4 stand-in replicator (a stand-in for Oracle GoldenGate), as the
// compose `replicator` service runs it (profile d4, app image):
//   node replicator/cli.mjs fwd      MongoDB -> Oracle until SIGTERM
//   node replicator/cli.mjs rev      Oracle -> MongoDB until SIGTERM
//   node replicator/cli.mjs status   both directions' last status
// Presenters use `./lab.sh repl fwd|rev|stop|status`. SIGTERM (`repl stop`)
// drains to lag 0, saves the position and exits 0. Every line of output
// starts with [stand-in for Oracle GoldenGate].
import { config } from '../lib/config.mjs';
import { closeAll } from '../lib/db.mjs';
import { COLLECTIONS } from '../oracle/prep.mjs';
import { isLive, log, readStatus, STALE_MS } from './apply.mjs';
import { startForward } from './forward.mjs';
import { startReverse } from './reverse.mjs';

const USAGE = 'usage: cli.mjs fwd|rev|status';
const err = (m) => log(m, (l) => console.error(l));

async function appBackend() {
  try {
    const r = await fetch(`${config.appUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return (await r.json()).backend;
  } catch {
    return null;
  }
}

async function run(mode) {
  if (mode === 'fwd' && (await appBackend()) === 'oracle') {
    // After the cutover Oracle is the source of truth; replaying MongoDB's
    // older copies forward would overwrite newer writes.
    err('the order service writes to Oracle (after the cutover), so forward replication would overwrite newer writes: run ./lab.sh reset d4 to start over');
    return 1;
  }
  const h = (mode === 'fwd' ? startForward : startReverse)({ colls: COLLECTIONS });
  let stopping = null;
  const stop = (sig) => {
    if (stopping) return;
    log(`${sig}: draining to lag 0, then stopping`);
    stopping = h.stop();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  try {
    await h.ready;
    log(`${mode === 'fwd' ? 'forward' : 'reverse'} ready`);
    await h.done;
    await stopping;
    return 0;
  } catch (e) {
    err(`${mode} failed: ${e.message}`);
    return 1;
  } finally {
    await closeAll();
  }
}

function status() {
  const now = Date.now();
  for (const [dir, name] of [['fwd', 'forward (MongoDB -> Oracle)'], ['rev', 'reverse (Oracle -> MongoDB)']]) {
    const s = readStatus(dir);
    if (!s) { log(`${name}: not started`); continue; }
    const state = isLive(s, now) ? 'running' : s.state === 'running' ? `not running (no heartbeat for over ${STALE_MS / 1000} s)` : s.state;
    const age = ((now - s.updatedAt) / 1000).toFixed(1);
    log(`${name}: ${state}, ${s.applied} changes applied, lag ${s.lagMs} ms, updated ${age} s ago${s.error ? `, last error: ${s.error}` : ''}`);
  }
  return 0;
}

const mode = process.argv[2];
const main = mode === 'fwd' || mode === 'rev' ? () => run(mode)
  : mode === 'status' ? async () => status()
    : async () => { err(USAGE); return 2; };

main().then((code) => { process.exitCode = code; }, (e) => {
  err(e.message);
  process.exitCode = 1;
});

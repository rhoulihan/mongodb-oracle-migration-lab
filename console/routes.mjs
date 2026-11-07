// Instructor console HTTP API (express). One process, one ctx, each demo
// imported once: demos keep state between steps (D5/D6 `last`), so every
// request goes through the same demo modules and the same connections.
//
//   GET  /api/demos                 [{id, title, banner?, steps:[{id, title, lane, command?}]}]
//   GET  /api/ready                 {mongo, oracle, ords, oraMongo, ready}
//   POST /api/demos/:id/steps/:step a StepResult; console steps run `run`,
//                                   terminal steps ("Mark done") run `verify`
//   POST /api/demos/:id/reset       the demo's reset; forgets its results
//   GET  /api/demos/:id/state       {revealed, results:{step:{at, result}}} of this process
//   GET  /api/demos/:id/recorded    {id, source, steps:{step:{at, result}}}: the last good run of
//                                   each step, from this lab (source 'live') or, after a full
//                                   reset, the copy saved in the repo (source 'baked', Ruling V)
//
// Remote control (./lab.sh drive; plain-text answers, for curl):
//   POST /api/remote/:id/:step/run|skip|show  queue it for the open page; the seq, or 504
//   GET  /api/remote/next           the page takes the pending command (204: none)
//   POST /api/remote/done/:seq      the page reports {ok, summary}
//   GET  /api/remote/result/:seq?wait=ms  "OK    ..." / "FAIL  ..." (202: still waiting)
//   GET  /api/remote/plan/:id       the steps, with each terminal command
//   GET  /api/remote/status         services, console page open, running
//
// The console never runs shell commands: the presenter types terminal
// commands, the console only checks their effect.
//
// Ruling T: a demo's revealAfter {step, steps, metrics} hides those metrics of
// those steps until `step` has passed in this process. Re-running a gated
// step, or a reset, hides them again. A gated step's own run time (`ms`) is
// hidden with them: for the D6 pipeline it IS the timing. Recorded results
// are always shown with the gated metrics hidden (the steps after the gate
// carry the timing).
import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';
import { oracleReady } from '../lib/ready.mjs';

export const NOT_READY = 'Oracle is still starting (ORDS not ready)';
export const MONGO_NOT_READY = 'MongoDB is still starting (run ./lab.sh check)';
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
export const BAKED_DIR = fileURLToPath(new URL('../fallback/recorded/', import.meta.url));

const isResult = (r) => r && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.summary === 'string';
const resetHint = (id) => `run ./lab.sh reset ${id}`;
const withHint = (msg, id) => (msg.trimEnd().endsWith(resetHint(id)) ? msg : `${msg}: ${resetHint(id)}`);

// BSON values as plain JSON: ObjectId, Decimal128 and Long become strings (a
// Long above 2^53 must never round, Ruling K), Int32 and Double numbers, Date
// an ISO string. JavaScript numbers stay numbers. Other BSON types become
// their canonical EJSON.
const BSON_PLAIN = {
  ObjectId: (v) => v.toHexString(),
  Decimal128: (v) => v.toString(),
  Long: (v) => v.toString(),
  Int32: (v) => v.valueOf(),
  Double: (v) => v.valueOf(),
  Timestamp: (v) => `Timestamp(${v.high >>> 0}, ${v.low >>> 0})`,
};
export function toPlain(v) {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toPlain);
  if (v._bsontype) {
    const f = BSON_PLAIN[v._bsontype];
    return f ? f(v) : BSON.EJSON.serialize(v, { relaxed: false });
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
}

/** Run one step for the console: `run` or `verify`; every failure becomes a StepResult. */
async function invoke(demo, step, ctx) {
  const fn = step.lane === 'terminal' ? 'verify' : 'run';
  try {
    const r = await step[fn](ctx);
    if (!isResult(r)) return { ok: false, summary: withHint(`step ${step.id} did not return a result`, demo.id) };
    return toPlain(r);
  } catch (err) {
    // A broken connection is dropped, so the next step reconnects.
    await Promise.resolve(ctx.evictOnError?.(err)).catch(() => {});
    return { ok: false, summary: withHint(String(err?.message ?? err), demo.id) };
  }
}

const isReady = (r) => oracleReady(r) && r.mongo;
const gated = (demo, stepId, revealed) => Boolean(demo.revealAfter && !revealed && demo.revealAfter.steps.includes(stepId));

/** The result as the console may show it now: gated metrics removed while hidden. */
function redact(demo, stepId, result, revealed) {
  const g = demo.revealAfter;
  if (!gated(demo, stepId, revealed) || !result) return result;
  const metrics = result.metrics && Object.fromEntries(Object.entries(result.metrics).filter(([k]) => !g.metrics.includes(k)));
  const untilTitle = demo.steps.find((s) => s.id === g.step)?.title;
  return { ...result, ...(metrics ? { metrics } : {}), hidden: { metrics: g.metrics, until: g.step, untilTitle } };
}

/** A stored {at, result} as shown now; never a run time (a step's run time is a timing too). */
function view(demo, stepId, { at, result }, revealed) {
  return { at, result: redact(demo, stepId, result, revealed) };
}

/**
 * A recording as the console may serve it: gated steps always redacted, and
 * the steps from the gate on only when the same recording holds the gate
 * step (saved only when it passed), so a recorded timing is never shown
 * without its proof of equal results.
 */
function recordedView(demo, rec) {
  const g = demo.revealAfter;
  const at = (id) => demo.steps.findIndex((s) => s.id === id);
  const keep = ([id]) => !g || at(id) < at(g.step) || rec.steps?.[g.step]?.result?.ok === true;
  return Object.fromEntries(Object.entries(rec.steps ?? {}).filter(keep).map(([id, e]) => [id, view(demo, id, e, false)]));
}

const READY_TTL_MS = 5000;
// How long a remote command waits for an open console page to take it.
const TAKE_MS = 5000;

/**
 * @param {{demos: import('../demos/contract.mjs').Demo[], ctx: any,
 *          readiness: () => Promise<{mongo:boolean, oracle:boolean, ords:boolean, oraMongo:boolean}>,
 *          recordedDir: string, bakedDir?: string, readyTtlMs?: number, takeMs?: number, log?: (...a:any[]) => void}} opts
 * recordedDir: this lab's recordings (written after each passing step);
 * bakedDir: the copies saved in the repo (fallback/recorded, Ruling V).
 */
export function createConsoleApp({ demos, ctx, readiness, recordedDir, bakedDir = BAKED_DIR, readyTtlMs = READY_TTL_MS, takeMs = TAKE_MS, log = () => {} }) {
  const byId = new Map([...demos].sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, d]));
  const live = new Map([...byId.keys()].map((id) => [id, { results: new Map(), revealed: false }]));
  let running = null; // "d5 setup" while a step or reset runs

  const recordedFile = (id, dir = recordedDir) => join(dir, `${id}.json`);
  async function readRecorded(id, dir = recordedDir) {
    try { return JSON.parse(await readFile(recordedFile(id, dir), 'utf8')); } catch { return null; }
  }

  // Readiness, cached: a ready answer is trusted for readyTtlMs (step POSTs
  // skip the probes), a not-ready one is probed again on the next request.
  let lastReady = null; // {at, value}
  async function readyNow({ cachedOk = true } = {}) {
    const fresh = lastReady && Date.now() - lastReady.at < readyTtlMs;
    if (fresh && (cachedOk || isReady(lastReady.value))) return lastReady.value;
    const value = await readiness();
    lastReady = { at: Date.now(), value };
    return value;
  }
  async function record(id, stepId, entry) {
    const cur = (await readRecorded(id)) ?? { id, steps: {} };
    cur.steps[stepId] = entry;
    await mkdir(recordedDir, { recursive: true });
    const tmp = `${recordedFile(id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cur, null, 2));
    await rename(tmp, recordedFile(id));
  }

  const app = express();
  app.disable('x-powered-by');

  // Resolve :id (and :step) or answer 404.
  app.param('id', (req, res, next, id) => {
    req.demo = byId.get(id);
    return req.demo ? next() : res.status(404).json({ error: `no demo ${id}` });
  });

  /** Readiness gate, then one thing at a time. */
  async function exclusive(req, res, label, fn) {
    const r = await readyNow({ cachedOk: false });
    if (!oracleReady(r)) return res.status(503).json({ error: NOT_READY });
    if (!r.mongo) return res.status(503).json({ error: MONGO_NOT_READY });
    if (running) return res.status(409).json({ error: `${running} is still running: wait for it to finish` });
    running = label;
    try {
      return res.json(await fn());
    } finally {
      running = null;
    }
  }

  app.get('/api/demos', (_req, res) => {
    res.json([...byId.values()].map((d) => ({
      id: d.id,
      title: d.title,
      ...(d.banner ? { banner: d.banner } : {}),
      steps: d.steps.map((s) => ({ id: s.id, title: s.title, lane: s.lane, ...(s.lane === 'terminal' ? { command: s.command } : {}) })),
    })));
  });

  app.get('/api/ready', async (_req, res) => {
    const r = await readyNow();
    res.json({ ...r, ready: isReady(r), running });
  });

  app.post('/api/demos/:id/steps/:step', (req, res) => {
    const demo = req.demo;
    const step = demo.steps.find((s) => s.id === req.params.step);
    if (!step) return res.status(404).json({ error: `no step ${req.params.step} in ${demo.id}` });
    return exclusive(req, res, `${demo.id} ${step.id}`, async () => {
      const st = live.get(demo.id);
      const g = demo.revealAfter;
      const at = (id) => demo.steps.findIndex((s) => s.id === id);
      // Anything before the gate may change the gated numbers: hide them again.
      if (g && at(step.id) < at(g.step)) st.revealed = false;
      const started = Date.now();
      const result = await invoke(demo, step, ctx);
      const entry = { at: new Date().toISOString(), result };
      st.results.set(step.id, entry);
      // A passing gate reveals; a failing re-run of the gate hides again.
      if (g && step.id === g.step) st.revealed = result.ok;
      log(`${demo.id} ${step.id} ${result.ok ? 'ok' : 'FAIL'} ${Date.now() - started} ms: ${result.summary}`);
      if (result.ok) {
        await record(demo.id, step.id, entry).catch((err) => log(`could not save the recorded result: ${err.message}`));
      }
      return redact(demo, step.id, result, st.revealed);
    });
  });

  app.post('/api/demos/:id/reset', (req, res) => {
    const demo = req.demo;
    return exclusive(req, res, `${demo.id} reset`, async () => {
      const st = live.get(demo.id);
      st.results.clear();
      st.revealed = false;
      try {
        await demo.reset(ctx);
        log(`${demo.id} reset`);
        return { ok: true, summary: `${demo.id} is back at its starting state` };
      } catch (err) {
        return { ok: false, summary: `reset failed: ${err?.message ?? err}; run ./lab.sh reset ${demo.id} in the terminal` };
      }
    });
  });

  app.get('/api/demos/:id/state', (req, res) => {
    const demo = req.demo;
    const st = live.get(demo.id);
    const results = Object.fromEntries([...st.results].map(([id, e]) => [id, view(demo, id, e, st.revealed)]));
    res.json({ revealed: st.revealed, results });
  });

  app.get('/api/demos/:id/recorded', async (req, res) => {
    const demo = req.demo;
    // This lab's recording first; after a full reset, the copy saved in the repo.
    const live = await readRecorded(demo.id);
    const rec = live ?? await readRecorded(demo.id, bakedDir);
    if (!rec) return res.status(404).json({ error: `nothing recorded for ${demo.id} yet: run its steps once at rehearsal` });
    return res.json({ ...rec, source: live ? 'live' : 'baked', steps: recordedView(demo, rec) });
  });

  // ---- remote control (./lab.sh drive) ------------------------------------
  // The driver queues one command; the open console page takes it, presses
  // its own button (so the audience sees the same timer and result as a
  // click) and posts the outcome back.
  const remote = { seq: 0, pending: null, done: new Map(), lastPoll: 0, waiting: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (res, code, body) => res.status(code).type('text/plain').send(`${body}\n`);

  app.get('/api/remote/plan/:id', (req, res) => {
    const d = req.demo;
    const lines = [`${d.id}  ${d.title}`];
    d.steps.forEach((s, i) => {
      lines.push(`${String(i + 1).padStart(2)}  ${s.id}  ${s.lane}  ${s.title}`);
      if (s.lane === 'terminal') lines.push(`      $ ${s.command}`);
    });
    text(res, 200, lines.join('\n'));
  });

  app.get('/api/remote/status', async (_req, res) => {
    const r = await readyNow({ cachedOk: false });
    const down = Object.entries(r).filter(([, up]) => !up).map(([k]) => k);
    const age = remote.lastPoll ? (Date.now() - remote.lastPoll) / 1000 : null;
    text(res, 200, [
      isReady(r) ? 'OK    services ready' : `FAIL  not ready: ${down.join(', ')} (run ./lab.sh check)`,
      remote.waiting > 0 ? 'OK    console page open (waiting for a command)'
        : age !== null && age < 3 ? `OK    console page open (polled ${age.toFixed(1)} s ago)`
        : 'FAIL  no console page open: open http://127.0.0.1:3200 in Chrome',
      running ? `INFO  running: ${running}` : 'INFO  idle',
    ].join('\n'));
  });

  app.post('/api/remote/:id/:step/:action', async (req, res) => {
    const demo = req.demo;
    const step = demo.steps.find((s) => s.id === req.params.step);
    if (!step) return text(res, 404, `FAIL  no step ${req.params.step} in ${demo.id}`);
    if (!['run', 'skip', 'show'].includes(req.params.action)) {
      return text(res, 400, `FAIL  action ${req.params.action} is not run, skip or show`);
    }
    const cmd = { seq: ++remote.seq, demo: demo.id, step: step.id, action: req.params.action, taken: false };
    remote.pending = cmd;
    for (let t = 0; t < takeMs && !cmd.taken; t += 50) await sleep(50);
    if (!cmd.taken) {
      if (remote.pending === cmd) remote.pending = null;
      return text(res, 504, 'FAIL  no console page took it: open http://127.0.0.1:3200 in Chrome');
    }
    return text(res, 200, String(cmd.seq));
  });

  // The page polls this; the first page to ask takes the command. With
  // ?wait= ms (at most 25 s) it is a long poll: the request waits for a
  // command, so the page needs no timer (Chrome throttles a hidden tab's
  // timers to once a minute, and the page would stop taking commands).
  app.get('/api/remote/next', async (req, res) => {
    remote.lastPoll = Date.now();
    const wait = Math.min(Number(req.query.wait) || 0, 25000);
    if (!remote.pending && wait > 0) {
      let gone = false;
      req.on('close', () => { gone = true; });
      remote.waiting++;
      try {
        for (let t = 0; !remote.pending && !gone && t < wait; t += 50) await sleep(50);
      } finally {
        remote.waiting--;
        remote.lastPoll = Date.now();
      }
      if (gone) return undefined;
    }
    const cmd = remote.pending;
    if (!cmd) return res.status(204).end();
    remote.pending = null;
    cmd.taken = true;
    return res.json({ seq: cmd.seq, demo: cmd.demo, step: cmd.step, action: cmd.action });
  });

  app.post('/api/remote/done/:seq', express.json(), (req, res) => {
    const r = req.body;
    if (!isResult(r)) return res.status(400).json({ error: 'need {ok, summary}' });
    remote.done.set(Number(req.params.seq), { ok: r.ok, summary: r.summary });
    if (remote.done.size > 100) remote.done.delete(remote.done.keys().next().value);
    return res.json({ ok: true });
  });

  // Long poll: 200 with the outcome, or 202 "waiting" after ?wait= ms (at most 30 s).
  app.get('/api/remote/result/:seq', async (req, res) => {
    const seq = Number(req.params.seq);
    const wait = Math.min(Number(req.query.wait) || 0, 30000);
    for (let t = 0; !remote.done.has(seq) && t < wait; t += 100) await sleep(100);
    const r = remote.done.get(seq);
    return r ? text(res, 200, `${r.ok ? 'OK  ' : 'FAIL'}  ${r.summary}`) : text(res, 202, 'waiting');
  });

  // ---- presenter keys (./lab.sh drive autopilot) ---------------------------
  // The clicker's "next" from whichever window has the focus: the deck on a
  // demo slide (?from=deck&demo=dN), the console page (?from=console) or the
  // tmux terminal (?from=term). The autopilot on the host long-polls them and
  // runs the demo, one step per press. A query-string POST with no body is a
  // simple request, so the deck (file://) needs no CORS preflight.
  const keys = { q: [], lastPoll: 0, waiting: 0, active: '' };
  const listening = () => keys.waiting > 0 || Date.now() - keys.lastPoll < 30000;
  // The demo the autopilot is running ('' between demos). The deck polls it:
  // while a demo runs, the speaker notes (which hold the keyboard focus) and
  // the deck send every next here instead of moving the slides.
  app.get('/api/remote/key/state', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    text(res, 200, keys.active);
  });
  app.post('/api/remote/key/state', (req, res) => {
    const demo = String(req.query.demo || '');
    if (demo && !/^d[1-7]$/.test(demo)) return res.status(400).json({ error: 'demo=d1..d7 or empty' });
    keys.active = demo;
    return res.status(204).end();
  });
  app.post('/api/remote/key', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const from = String(req.query.from || '');
    const demo = String(req.query.demo || '');
    if (!['deck', 'notes', 'console', 'term'].includes(from) || (demo && !/^d[1-7]$/.test(demo))) {
      return res.status(400).json({ error: 'from=deck|notes|console|term, demo=d1..d7' });
    }
    if (!listening()) return res.json({ ok: false, listening: false });
    keys.q.push({ from, demo });
    if (keys.q.length > 20) keys.q.shift();
    return res.json({ ok: true, listening: true });
  });
  // Long poll (?wait= ms, at most 25 s): "FROM [DEMO]" as text, or 204.
  app.get('/api/remote/key', async (req, res) => {
    keys.lastPoll = Date.now();
    const wait = Math.min(Number(req.query.wait) || 0, 25000);
    if (!keys.q.length && wait > 0) {
      let gone = false;
      req.on('close', () => { gone = true; });
      keys.waiting++;
      try {
        for (let t = 0; !keys.q.length && !gone && t < wait; t += 50) await sleep(50);
      } finally {
        keys.waiting--;
        keys.lastPoll = Date.now();
      }
      if (gone) return undefined;
    }
    const k = keys.q.shift();
    if (!k) return res.status(204).end();
    return text(res, 200, `${k.from} ${k.demo}`.trim());
  });
  // Presses that came in while a step ran: dropped, so they don't queue up.
  app.delete('/api/remote/key', (_req, res) => { keys.q.length = 0; res.status(204).end(); });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: 0 }));
  return app;
}

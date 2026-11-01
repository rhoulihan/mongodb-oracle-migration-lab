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

/**
 * @param {{demos: import('../demos/contract.mjs').Demo[], ctx: any,
 *          readiness: () => Promise<{mongo:boolean, oracle:boolean, ords:boolean, oraMongo:boolean}>,
 *          recordedDir: string, bakedDir?: string, readyTtlMs?: number, log?: (...a:any[]) => void}} opts
 * recordedDir: this lab's recordings (written after each passing step);
 * bakedDir: the copies saved in the repo (fallback/recorded, Ruling V).
 */
export function createConsoleApp({ demos, ctx, readiness, recordedDir, bakedDir = BAKED_DIR, readyTtlMs = READY_TTL_MS, log = () => {} }) {
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

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: 0 }));
  return app;
}

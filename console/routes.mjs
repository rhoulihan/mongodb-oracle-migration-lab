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
//   GET  /api/demos/:id/recorded    {id, steps:{step:{at, result}}}: the last good run of each step
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

const isResult = (r) => r && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.summary === 'string';
const resetHint = (id) => `run ./lab.sh reset ${id}`;
const withHint = (msg, id) => (msg.trimEnd().endsWith(resetHint(id)) ? msg : `${msg}: ${resetHint(id)}`);

// BSON values (ObjectId, Decimal128, Long, Date) as plain JSON strings and numbers.
const WRAPPERS = ['$oid', '$date', '$numberDecimal', '$numberLong', '$numberInt', '$numberDouble', '$symbol'];
function unwrap(v) {
  if (Array.isArray(v)) return v.map(unwrap);
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && WRAPPERS.includes(keys[0])) {
    const x = v[keys[0]];
    return typeof x === 'object' && x !== null ? unwrap(x.$numberLong ?? x) : x;
  }
  if (keys.length <= 2 && '$timestamp' in v) return `Timestamp(${v.$timestamp.t}, ${v.$timestamp.i})`;
  return Object.fromEntries(keys.map((k) => [k, unwrap(v[k])]));
}
export const toPlain = (v) => unwrap(BSON.EJSON.serialize(v, { relaxed: true }));

/** Run one step for the console: `run` or `verify`; every failure becomes a StepResult. */
async function invoke(demo, step, ctx) {
  const fn = step.lane === 'terminal' ? 'verify' : 'run';
  try {
    const r = await step[fn](ctx);
    if (!isResult(r)) return { ok: false, summary: withHint(`step ${step.id} did not return a result`, demo.id) };
    return toPlain(r);
  } catch (err) {
    return { ok: false, summary: withHint(String(err?.message ?? err), demo.id) };
  }
}

const gated = (demo, stepId, revealed) => Boolean(demo.revealAfter && !revealed && demo.revealAfter.steps.includes(stepId));

/** The result as the console may show it now: gated metrics removed while hidden. */
function redact(demo, stepId, result, revealed) {
  const g = demo.revealAfter;
  if (!gated(demo, stepId, revealed) || !result) return result;
  const metrics = result.metrics && Object.fromEntries(Object.entries(result.metrics).filter(([k]) => !g.metrics.includes(k)));
  const untilTitle = demo.steps.find((s) => s.id === g.step)?.title;
  return { ...result, ...(metrics ? { metrics } : {}), hidden: { metrics: g.metrics, until: g.step, untilTitle } };
}

/** A stored {at, ms, result} as shown now; the step's own run time is a timing too. */
function view(demo, stepId, entry, revealed) {
  if (!gated(demo, stepId, revealed)) return entry;
  const { ms: _hidden, ...rest } = entry;
  return { ...rest, result: redact(demo, stepId, entry.result, revealed) };
}

/**
 * @param {{demos: import('../demos/contract.mjs').Demo[], ctx: any,
 *          readiness: () => Promise<{mongo:boolean, oracle:boolean, ords:boolean, oraMongo:boolean}>,
 *          recordedDir: string, log?: (...a:any[]) => void}} opts
 */
export function createConsoleApp({ demos, ctx, readiness, recordedDir, log = () => {} }) {
  const byId = new Map([...demos].sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, d]));
  const live = new Map([...byId.keys()].map((id) => [id, { results: new Map(), revealed: false }]));
  let running = null; // "d5 setup" while a step or reset runs

  const recordedFile = (id) => join(recordedDir, `${id}.json`);
  async function readRecorded(id) {
    try { return JSON.parse(await readFile(recordedFile(id), 'utf8')); } catch { return null; }
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
    const r = await readiness();
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
    const r = await readiness();
    res.json({ ...r, ready: oracleReady(r) && r.mongo, running });
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
      const entry = { at: new Date().toISOString(), ms: Date.now() - started, result };
      st.results.set(step.id, entry);
      if (g && step.id === g.step && result.ok) st.revealed = true;
      log(`${demo.id} ${step.id} ${result.ok ? 'ok' : 'FAIL'} ${entry.ms} ms: ${result.summary}`);
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
    const rec = await readRecorded(demo.id);
    if (!rec) return res.status(404).json({ error: `nothing recorded for ${demo.id} yet: run its steps once at rehearsal` });
    const steps = Object.fromEntries(Object.entries(rec.steps ?? {}).map(([id, e]) => [id, view(demo, id, e, false)]));
    return res.json({ ...rec, steps });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: 0 }));
  return app;
}

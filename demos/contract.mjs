// The demo step contract. Every demo lives in demos/dN-<slug>/index.mjs and
// exports a Demo as `default`. The console, `./lab.sh demo` and the tests all
// drive demos through runDemo().
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';

/** @typedef {{ok:boolean, summary:string, panes?:{left?:any,right?:any}, labels?:{left?:string,right?:string}, metrics?:object, plan?:{left?:string,right?:string}, detail?:string, verified?:string}} StepResult */
/** @typedef {{id:string,title:string,lane:'console'|'terminal'|'compass',command?:string,run:(ctx)=>Promise<StepResult>,verify?:(ctx)=>Promise<StepResult>}} Step */
// Terminal steps (Ruling O) carry three things:
//   command  what the presenter types on the host
//   run      the same operation done in-process, for headless runs and tests
//   verify   checks the effect only; the console calls it after "Mark done",
//            and runDemo calls it after every successful terminal run
// `detail` is optional monospace text (a table, a plan) that the CLI prints
// under the summary line. `labels` optionally names the left and right panes
// and plans for the console (for example MongoDB and Oracle).
//
// Two optional Demo fields are for the console only:
//   banner       a label pinned in the demo's header (D4: the stand-in label)
//   revealAfter  {step, steps, metrics}: the console hides these metrics of
//                these steps until `step` (which comes after them) has passed
//                in this console process (Ruling T: no timing before equal)
/** @typedef {{step:string, steps:string[], metrics:string[]}} RevealAfter */
/** @typedef {{id:'d1'|'d2'|'d3'|'d4'|'d5'|'d6'|'d7', title:string, banner?:string, revealAfter?:RevealAfter, steps:Step[], setup:(ctx)=>Promise<void>, reset:(ctx)=>Promise<void>}} Demo */

export const DEMOS_DIR = fileURLToPath(new URL('.', import.meta.url));
const LANES = ['console', 'terminal', 'compass'];

/** Problems with a demo's shape, as strings; empty when it follows the contract. */
export function validateDemo(demo) {
  const p = [];
  if (!demo || typeof demo !== 'object') return ['demo is not an object'];
  if (!/^d[1-7]$/.test(demo.id ?? '')) p.push(`id ${demo.id} is not d1..d7`);
  if (typeof demo.title !== 'string' || !demo.title) p.push('title missing');
  for (const fn of ['setup', 'reset']) if (typeof demo[fn] !== 'function') p.push(`${fn} is not a function`);
  if (!Array.isArray(demo.steps) || demo.steps.length === 0) return [...p, 'steps missing'];
  const seen = new Set();
  for (const s of demo.steps) {
    if (seen.has(s.id)) p.push(`duplicate step id ${s.id}`);
    seen.add(s.id);
    if (typeof s.id !== 'string' || !s.id) p.push('step without an id');
    if (typeof s.title !== 'string' || !s.title) p.push(`step ${s.id}: title missing`);
    if (!LANES.includes(s.lane)) p.push(`step ${s.id}: lane ${s.lane} is not console, terminal or compass`);
    if (s.lane === 'terminal' && !(typeof s.command === 'string' && s.command.trim())) {
      p.push(`step ${s.id}: a terminal step needs a command`);
    }
    if (typeof s.run !== 'function') p.push(`step ${s.id}: run is not a function`);
    if (s.verify !== undefined && typeof s.verify !== 'function') p.push(`step ${s.id}: verify is not a function`);
    else if (s.lane === 'terminal' && s.verify === undefined) p.push(`step ${s.id}: a terminal step needs verify`);
  }
  if (demo.banner !== undefined && !(typeof demo.banner === 'string' && demo.banner.trim())) p.push('banner is not a string');
  if (demo.revealAfter !== undefined) p.push(...revealProblems(demo));
  return p;
}

function revealProblems({ revealAfter: r, steps }) {
  const at = (id) => steps.findIndex((s) => s.id === id);
  const gate = at(r?.step);
  if (gate < 0) return [`revealAfter.step ${r?.step} is not a step`];
  const p = [];
  if (!Array.isArray(r.steps) || r.steps.length === 0) p.push('revealAfter.steps is empty');
  else for (const id of r.steps) if (at(id) < 0 || at(id) >= gate) p.push(`revealAfter: step ${id} is not a step before ${r.step}`);
  if (!Array.isArray(r.metrics) || r.metrics.length === 0 || !r.metrics.every((m) => typeof m === 'string')) {
    p.push('revealAfter.metrics must name at least one metric');
  }
  return p;
}

/** A spelled-out time, as in "234.8 ms". */
export const TIMING_TEXT = /\d[\d.,]*\s*ms\b/;

/**
 * Text that spells out a time on a step the demo's revealAfter gates (Ruling
 * W): the console can hide metrics but not words, so gated steps must keep
 * times out of summary, detail and verified. Returns "step: field" strings.
 * @param {Demo} demo
 * @param {StepResult[]} results in step order (as runDemo returns them)
 */
export function gatedTimingLeaks(demo, results) {
  const gated = new Set(demo.revealAfter?.steps ?? []);
  const out = [];
  results.forEach((r, i) => {
    const id = demo.steps[i]?.id;
    if (!gated.has(id) || !r) return;
    for (const f of ['summary', 'detail', 'verified']) if (TIMING_TEXT.test(r[f] ?? '')) out.push(`${id}: ${f}`);
  });
  return out;
}

const isResult = (r) => r && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.summary === 'string';

/** step[fn](ctx) as a StepResult: a throw or a malformed return becomes ok:false. */
export async function call(step, fn, ctx) {
  try {
    const r = await step[fn](ctx);
    return isResult(r) ? r : { ok: false, summary: `step ${step.id} ${fn} did not return a StepResult` };
  } catch (err) {
    return { ok: false, summary: `step ${step.id} ${fn} threw: ${err?.message ?? err}` };
  }
}

/**
 * Run a demo's steps in order (all of them, or only the ids in `only`).
 * A terminal step's verify runs after its run succeeds; its summary lands in
 * `verified`, and a failed verify fails the step.
 * Stops after the first step that fails; a throw counts as ok:false.
 * Does not call setup: callers decide when the starting state is restored.
 * @param {Demo} demo
 * @param {{only?:string[], ctx:any}} opts
 * @returns {Promise<StepResult[]>}
 */
export async function runDemo(demo, { only, ctx } = {}) {
  let steps = demo.steps;
  if (only?.length) {
    for (const id of only) {
      if (!steps.some((s) => s.id === id)) throw new Error(`unknown step ${id} in ${demo.id}`);
    }
    steps = steps.filter((s) => only.includes(s.id));
  }
  const results = [];
  for (const step of steps) {
    let r = await call(step, 'run', ctx);
    if (r.ok && step.lane === 'terminal' && step.verify) {
      const v = await call(step, 'verify', ctx);
      r = v.ok ? { ...r, verified: v.summary } : { ...r, ok: false, summary: `verify failed: ${v.summary}` };
    }
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

/** Every demo folder under `dir` (dN-<slug>/index.mjs), sorted by folder name. */
export async function listDemos(dir = DEMOS_DIR) {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^d\d+-/.test(e.name) && existsSync(join(dir, e.name, 'index.mjs')))
    .map((e) => e.name)
    .sort();
  const out = [];
  for (const name of names) {
    const mod = await import(pathToFileURL(join(dir, name, 'index.mjs')).href);
    out.push({ dir: name, demo: mod.default });
  }
  return out;
}

export async function findDemo(id, dir = DEMOS_DIR) {
  return (await listDemos(dir)).find((d) => d.dir.startsWith(`${id}-`))?.demo;
}

/** The ctx handed to setup, reset and every step: config plus lazy lab connections. */
export function createContext() {
  // Imported eagerly, awaited lazily: the no-op catch keeps a failed import
  // from becoming an unhandled rejection; the error surfaces on first use.
  const db = import('../lib/db.mjs');
  db.catch(() => {});
  const lazy = (name) => async () => (await db)[name]();
  return {
    mongoSrc: lazy('mongoSrc'),
    oraMongo: lazy('oraMongo'),
    oraSql: lazy('oraSql'),
    config,
    log: (...a) => console.log(...a),
    close: lazy('closeAll'),
    // Drop a cached connection after an error that says it is broken (the console).
    evictOnError: async (err) => (await db).evictOnError(err),
  };
}

// The demo step contract. Every demo lives in demos/dN-<slug>/index.mjs and
// exports a Demo as `default`. The console, `./lab.sh demo` and the tests all
// drive demos through runDemo().
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../lib/config.mjs';

/** @typedef {{ok:boolean, summary:string, panes?:{left?:any,right?:any}, metrics?:object, plan?:{left?:string,right?:string}}} StepResult */
/** @typedef {{id:string,title:string,lane:'console'|'terminal',command?:string,run:(ctx)=>Promise<StepResult>}} Step */
/** @typedef {{id:'d1'|'d2'|'d3'|'d4'|'d5'|'d6'|'d7', title:string, steps:Step[], setup:(ctx)=>Promise<void>, reset:(ctx)=>Promise<void>}} Demo */

export const DEMOS_DIR = fileURLToPath(new URL('.', import.meta.url));
const LANES = ['console', 'terminal'];

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
    if (!LANES.includes(s.lane)) p.push(`step ${s.id}: lane ${s.lane} is not console or terminal`);
    if (s.lane === 'terminal' && !(typeof s.command === 'string' && s.command.trim())) {
      p.push(`step ${s.id}: a terminal step needs a command`);
    }
    if (typeof s.run !== 'function') p.push(`step ${s.id}: run is not a function`);
  }
  return p;
}

const isResult = (r) => r && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.summary === 'string';

/**
 * Run a demo's steps in order (all of them, or only the ids in `only`).
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
    let r;
    try {
      r = await step.run(ctx);
      if (!isResult(r)) r = { ok: false, summary: `step ${step.id} did not return a StepResult` };
    } catch (err) {
      r = { ok: false, summary: `step ${step.id} threw: ${err?.message ?? err}` };
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
  const db = import('../lib/db.mjs');
  const lazy = (name) => async () => (await db)[name]();
  return {
    mongoSrc: lazy('mongoSrc'),
    oraMongo: lazy('oraMongo'),
    oraSql: lazy('oraSql'),
    config,
    log: (...a) => console.log(...a),
    close: lazy('closeAll'),
  };
}

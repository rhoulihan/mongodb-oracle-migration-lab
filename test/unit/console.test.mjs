// Console routes without the stack: inline demos, a stub ctx and a stub
// readiness. Covers the step lanes (console runs `run`, terminal "Mark done"
// runs `verify`), error mapping to a reset hint, one step at a time, the
// recorded fallback, and Ruling T's reveal gate (metrics hidden until a named
// step has passed in this process).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleApp, NOT_READY } from '../../console/routes.mjs';
import { validateDemo } from '../../demos/contract.mjs';
import d4 from '../../demos/d4-bluegreen/index.mjs';
import d6 from '../../demos/d6-sql/index.mjs';

const READY = { mongo: true, oracle: true, ords: true, oraMongo: true };
const calls = [];
let gate = null; // a pending promise the `slow` step waits on

const timed = {
  id: 'd6',
  title: 'Timed fixture',
  revealAfter: { step: 'equal', steps: ['pipeline', 'sql'], metrics: ['medianMs', 'runsMs'] },
  async setup() {},
  async reset() { calls.push('reset'); },
  steps: [
    { id: 'pipeline', title: 'Pipeline', lane: 'console',
      async run() { return { ok: true, summary: 'rows 160', metrics: { rows: 160, medianMs: 80000, runsMs: [80000] } }; } },
    { id: 'sql', title: 'SQL', lane: 'terminal', command: './lab.sh mongosh ora x.js',
      async run() { calls.push('sql run'); return { ok: true, summary: 'ran' }; },
      async verify() { calls.push('sql verify'); return { ok: true, summary: '160 rows', metrics: { rows: 160, medianMs: 600 } }; } },
    { id: 'equal', title: 'Equal', lane: 'console', async run() { return { ok: true, summary: 'equal', metrics: { rows: 160 } }; } },
    { id: 'timing', title: 'Timing', lane: 'console', async run() { return { ok: true, summary: '130x', metrics: { ratio: 130 } }; } },
  ],
};

const broken = {
  id: 'd3',
  title: 'Broken fixture',
  banner: 'Stand-in label',
  async setup() {},
  async reset() {},
  steps: [
    { id: 'boom', title: 'Boom', lane: 'console', async run() { throw new Error('collection orders is empty'); } },
    { id: 'bad', title: 'Bad', lane: 'console', async run() { return { ok: false, summary: 'run the dump step first' }; } },
    { id: 'shape', title: 'Shape', lane: 'console', async run() { return 42; } },
    { id: 'slow', title: 'Slow', lane: 'console', async run() { await gate; return { ok: true, summary: 'slow done' }; } },
  ],
};

let server, base, recordedDir, readyState;

async function api(method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, body: await res.json() };
}
const post = (path) => api('POST', path);

beforeAll(async () => {
  recordedDir = mkdtempSync(join(tmpdir(), 'console-recorded-'));
  readyState = { ...READY };
  const app = createConsoleApp({ demos: [broken, timed], ctx: {}, readiness: async () => readyState, recordedDir });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('the step list', () => {
  test('GET /api/demos lists demos by id with steps, lanes, commands and the banner', async () => {
    const { body } = await api('GET', '/api/demos');
    expect(body.map((d) => d.id)).toEqual(['d3', 'd6']);
    expect(body[0].banner).toBe('Stand-in label');
    expect(body[1].steps[1]).toEqual({ id: 'sql', title: 'SQL', lane: 'terminal', command: './lab.sh mongosh ora x.js' });
    expect(body[1].steps[0]).toEqual({ id: 'pipeline', title: 'Pipeline', lane: 'console' });
  });

  test('unknown demos and steps are 404', async () => {
    expect((await post('/api/demos/d9/steps/x')).status).toBe(404);
    expect((await post('/api/demos/d6/steps/nope')).status).toBe(404);
  });
});

describe('running steps', () => {
  test('a terminal step\'s "Mark done" runs verify, never run', async () => {
    calls.length = 0;
    const r = await post('/api/demos/d6/steps/sql');
    expect(r.status).toBe(200);
    expect(r.body.summary).toBe('160 rows');
    expect(calls).toEqual(['sql verify']);
  });

  test('a thrown error becomes ok:false ending with the reset hint', async () => {
    const r = await post('/api/demos/d3/steps/boom');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.summary).toMatch(/collection orders is empty/);
    expect(r.body.summary).toMatch(/run \.\/lab\.sh reset d3$/);
  });

  test('a malformed result also ends with the reset hint; a demo\'s own ok:false keeps its words', async () => {
    expect((await post('/api/demos/d3/steps/shape')).body.summary).toMatch(/run \.\/lab\.sh reset d3$/);
    expect((await post('/api/demos/d3/steps/bad')).body).toMatchObject({ ok: false, summary: 'run the dump step first' });
  });

  test('one step at a time: a second POST while one runs is 409', async () => {
    let release;
    gate = new Promise((r) => { release = r; });
    const first = post('/api/demos/d3/steps/slow');
    await new Promise((r) => setTimeout(r, 50));
    const second = await post('/api/demos/d6/steps/equal');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/still running/);
    release();
    expect((await first).body.ok).toBe(true);
  });

  test('not ready: steps and reset answer 503 with the readiness message', async () => {
    readyState = { ...READY, ords: false };
    try {
      for (const path of ['/api/demos/d6/steps/equal', '/api/demos/d6/reset']) {
        const r = await post(path);
        expect(r.status).toBe(503);
        expect(r.body).toEqual({ error: 'Oracle is still starting (ORDS not ready)' });
      }
      expect(NOT_READY).toBe('Oracle is still starting (ORDS not ready)');
      expect((await api('GET', '/api/ready')).body).toMatchObject({ ready: false, ords: false });
    } finally {
      readyState = { ...READY };
    }
  });
});

describe('Ruling T: timings stay hidden until the equal step passes in this process', () => {
  const state = async () => (await api('GET', '/api/demos/d6/state')).body;

  test('hidden before equal, shown after, hidden again when a gated step re-runs', async () => {
    await post('/api/demos/d6/reset');
    const p = await post('/api/demos/d6/steps/pipeline');
    expect(p.body.metrics).toEqual({ rows: 160 });
    expect(p.body.hidden).toMatchObject({ metrics: ['medianMs', 'runsMs'], until: 'equal', untilTitle: 'Equal' });
    const s = await post('/api/demos/d6/steps/sql');
    expect(s.body.metrics).toEqual({ rows: 160 });
    expect((await state()).revealed).toBe(false);
    expect((await state()).results.pipeline.result.metrics).toEqual({ rows: 160 });
    // The step's own run time is a timing too.
    expect((await state()).results.pipeline.ms).toBeUndefined();
    expect((await state()).results.pipeline.at).toEqual(expect.any(String));

    await post('/api/demos/d6/steps/equal');
    const after = await state();
    expect(after.revealed).toBe(true);
    expect(after.results.pipeline.result.metrics).toEqual({ rows: 160, medianMs: 80000, runsMs: [80000] });
    expect(after.results.pipeline.result.hidden).toBeUndefined();
    expect(after.results.pipeline.ms).toEqual(expect.any(Number));

    const again = await post('/api/demos/d6/steps/pipeline');
    expect(again.body.metrics).toEqual({ rows: 160 });
    expect((await state()).revealed).toBe(false);
  });

  test('reset forgets results and the reveal', async () => {
    await post('/api/demos/d6/steps/equal');
    expect((await state()).revealed).toBe(true);
    calls.length = 0;
    const r = await post('/api/demos/d6/reset');
    expect(r.body).toMatchObject({ ok: true });
    expect(calls).toEqual(['reset']);
    expect(await state()).toEqual({ revealed: false, results: {} });
  });

  test('the recorded fallback never shows gated metrics', async () => {
    await post('/api/demos/d6/reset');
    await post('/api/demos/d6/steps/pipeline');
    await post('/api/demos/d6/steps/equal');
    const rec = (await api('GET', '/api/demos/d6/recorded')).body;
    expect(rec.steps.pipeline.result.metrics).toEqual({ rows: 160 });
    expect(rec.steps.pipeline.result.hidden).toMatchObject({ until: 'equal' });
    expect(rec.steps.pipeline.ms).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(recordedDir, 'd6.json'), 'utf8'));
    expect(onDisk.steps.pipeline.result.metrics.medianMs).toBe(80000);
  });

  test('the real D6 declares the gate on its pipeline and $sql steps', () => {
    expect(d6.revealAfter).toEqual({ step: 'equal', steps: ['pipeline-oracle', 'sql-stage'], metrics: ['medianMs', 'runsMs'] });
    expect(d6.steps.findIndex((s) => s.id === 'equal')).toBeGreaterThan(d6.steps.findIndex((s) => s.id === 'sql-stage'));
  });

  test('validateDemo checks revealAfter and banner', () => {
    const bad = (o) => validateDemo({ ...timed, ...o }).join();
    expect(validateDemo(timed)).toEqual([]);
    expect(bad({ revealAfter: { step: 'nope', steps: ['pipeline'], metrics: ['medianMs'] } })).toMatch(/revealAfter/);
    expect(bad({ revealAfter: { step: 'equal', steps: ['timing'], metrics: ['medianMs'] } })).toMatch(/revealAfter/);
    expect(bad({ revealAfter: { step: 'equal', steps: ['pipeline'], metrics: [] } })).toMatch(/revealAfter/);
    expect(bad({ banner: 5 })).toMatch(/banner/);
  });

  test('D4 pins the stand-in label as its banner', () => {
    expect(d4.banner).toBe('Stand-in for Oracle GoldenGate');
  });
});

describe('recorded fallback', () => {
  test('a successful run is saved with its time; a failed one is not', async () => {
    const before = Date.now();
    await post('/api/demos/d6/steps/timing');
    await post('/api/demos/d3/steps/bad');
    const rec = (await api('GET', '/api/demos/d6/recorded')).body;
    expect(rec.id).toBe('d6');
    expect(rec.steps.timing.result).toMatchObject({ ok: true, summary: '130x' });
    expect(Date.parse(rec.steps.timing.at)).toBeGreaterThanOrEqual(before - 1000);
    const d3rec = await api('GET', '/api/demos/d3/recorded');
    expect(d3rec.body.steps.bad).toBeUndefined();
  });

  test('no recording yet is 404 with a plain message', async () => {
    const fresh = createConsoleApp({ demos: [broken], ctx: {}, readiness: async () => READY, recordedDir: mkdtempSync(join(tmpdir(), 'rec-')) });
    const s = await new Promise((resolve) => { const x = fresh.listen(0, '127.0.0.1', () => resolve(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/demos/d3/recorded`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/nothing recorded for d3/);
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });
});

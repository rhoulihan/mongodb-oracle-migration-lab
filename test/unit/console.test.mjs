// Console routes without the stack: inline demos, a stub ctx and a stub
// readiness. Covers the step lanes (console runs `run`, terminal "Mark done"
// runs `verify`), error mapping to a reset hint, one step at a time, the
// recorded fallback, and Ruling T's reveal gate (metrics hidden until a named
// step has passed in this process).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BSON } from 'mongodb';
import { createConsoleApp, NOT_READY, toPlain } from '../../console/routes.mjs';
import { validateDemo } from '../../demos/contract.mjs';
import d4 from '../../demos/d4-bluegreen/index.mjs';
import d5 from '../../demos/d5-topn/index.mjs';
import d6 from '../../demos/d6-sql/index.mjs';

const READY = { mongo: true, oracle: true, ords: true, oraMongo: true };
const calls = [];
let gate = null; // a pending promise the `slow` step waits on
let equalOk = true;

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
    { id: 'equal', title: 'Equal', lane: 'console', async run() { return { ok: equalOk, summary: equalOk ? 'equal' : 'differ', metrics: { rows: 160 } }; } },
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

let server, base, recordedDir, bakedDir, readyState;

async function api(method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, body: await res.json() };
}
const post = (path) => api('POST', path);

beforeAll(async () => {
  recordedDir = mkdtempSync(join(tmpdir(), 'console-recorded-'));
  bakedDir = mkdtempSync(join(tmpdir(), 'console-baked-'));
  readyState = { ...READY };
  const app = createConsoleApp({
    demos: [broken, timed], ctx: {}, readiness: async () => readyState, recordedDir, bakedDir, readyTtlMs: 0,
  });
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
    // No run times in /state at all: a step's run time is a timing too.
    expect((await state()).results.pipeline.ms).toBeUndefined();
    expect((await state()).results.pipeline.at).toEqual(expect.any(String));

    await post('/api/demos/d6/steps/equal');
    const after = await state();
    expect(after.revealed).toBe(true);
    expect(after.results.pipeline.result.metrics).toEqual({ rows: 160, medianMs: 80000, runsMs: [80000] });
    expect(after.results.pipeline.result.hidden).toBeUndefined();
    expect(after.results.pipeline.ms).toBeUndefined();
    expect(after.results.equal.ms).toBeUndefined();

    const again = await post('/api/demos/d6/steps/pipeline');
    expect(again.body.metrics).toEqual({ rows: 160 });
    expect((await state()).revealed).toBe(false);
  });

  test('a failed re-run of the gate step hides the metrics again', async () => {
    await post('/api/demos/d6/steps/equal');
    expect((await state()).revealed).toBe(true);
    equalOk = false;
    try {
      await post('/api/demos/d6/steps/equal');
      expect((await state()).revealed).toBe(false);
      expect((await state()).results.pipeline.result.metrics).toEqual({ rows: 160 });
    } finally {
      equalOk = true;
    }
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
    expect(onDisk.steps.pipeline.ms).toBeUndefined();
  });

  test('a recording without its gate step never serves the steps after the gate', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rec-nogate-'));
    writeFileSync(join(d, 'd6.json'), JSON.stringify({ id: 'd6', steps: {
      pipeline: { at: '2026-11-01T07:00:00.000Z', result: { ok: true, summary: 'rows', metrics: { rows: 160, medianMs: 1 } } },
      timing: { at: '2026-11-01T07:01:00.000Z', result: { ok: true, summary: '130x', metrics: { ratio: 130 } } },
    } }));
    const app = createConsoleApp({ demos: [timed], ctx: {}, readiness: async () => READY, recordedDir: d, bakedDir: d });
    const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    try {
      const rec = await (await fetch(`http://127.0.0.1:${s.address().port}/api/demos/d6/recorded`)).json();
      expect(Object.keys(rec.steps)).toEqual(['pipeline']);
      expect(rec.steps.pipeline.result.metrics).toEqual({ rows: 160 });
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });

  test('the real D6 gates $sql on equal; (1) and (2) show after (2) matches (1)', () => {
    expect(d6.revealAfter).toEqual({ step: 'equal', steps: ['sql-stage'], metrics: ['medianMs', 'runsMs'] });
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

  test('the real D5 gates read ms on its three variants until same-shape (Ruling W)', () => {
    expect(d5.revealAfter).toEqual({ step: 'same-shape', steps: ['embedded-write', 'lookup-read', 'converged'], metrics: ['readMs'] });
  });

  test('D4 pins the stand-in label as its banner', () => {
    expect(d4.banner).toBe('Stand-in for Oracle GoldenGate');
  });
});

describe('readiness', () => {
  test('a ready result is reused for 5 s on step POSTs; a not-ready one is probed again', async () => {
    let probes = 0, now = { ...READY };
    const app = createConsoleApp({
      demos: [timed], ctx: {}, recordedDir: mkdtempSync(join(tmpdir(), 'rec-')), bakedDir: bakedDir,
      readiness: async () => { probes++; return now; },
    });
    const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    const u = `http://127.0.0.1:${s.address().port}`;
    try {
      for (let i = 0; i < 3; i++) await fetch(`${u}/api/demos/d6/steps/equal`, { method: 'POST' });
      await fetch(`${u}/api/ready`);
      expect(probes).toBe(1);
      now = { ...READY, ords: false };
      const fresh = createConsoleApp({
        demos: [timed], ctx: {}, recordedDir: mkdtempSync(join(tmpdir(), 'rec-')), bakedDir,
        readiness: async () => { probes++; return now; },
      });
      const s2 = await new Promise((resolve) => { const x = fresh.listen(0, '127.0.0.1', () => resolve(x)); });
      try {
        const u2 = `http://127.0.0.1:${s2.address().port}`;
        const before = probes;
        for (let i = 0; i < 2; i++) expect((await fetch(`${u2}/api/demos/d6/steps/equal`, { method: 'POST' })).status).toBe(503);
        expect(probes - before).toBe(2);
      } finally {
        await new Promise((resolve) => s2.close(resolve));
      }
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });
});

describe('toPlain (Ruling K)', () => {
  test('Longs stay exact strings; ints, doubles, dates and ObjectIds become plain values', () => {
    const { Long, Decimal128, ObjectId } = BSON;
    const id = new ObjectId('6ae6e4c53906ee57d3d2eae9');
    expect(toPlain({
      big: Long.fromString('9007199254740993'), n: 5, x: 0.5, huge: 2 ** 40,
      d: new Date(0), id, dec: Decimal128.fromString('1.10'), list: [Long.fromNumber(7)],
    })).toEqual({
      big: '9007199254740993', n: 5, x: 0.5, huge: 2 ** 40,
      d: '1970-01-01T00:00:00.000Z', id: '6ae6e4c53906ee57d3d2eae9', dec: '1.10', list: ['7'],
    });
  });
});

describe('recorded fallback', () => {
  test('live recording first, else the baked repo copy (Ruling V), with its source', async () => {
    const live = mkdtempSync(join(tmpdir(), 'rec-live-'));
    const baked = mkdtempSync(join(tmpdir(), 'rec-baked-'));
    const file = (summary) => JSON.stringify({ id: 'd3', steps: { bad: { at: '2026-11-01T07:00:00.000Z', result: { ok: true, summary } } } });
    writeFileSync(join(baked, 'd3.json'), file('from the repo'));
    const app = createConsoleApp({ demos: [broken], ctx: {}, readiness: async () => READY, recordedDir: live, bakedDir: baked });
    const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    const get = async () => (await fetch(`http://127.0.0.1:${s.address().port}/api/demos/d3/recorded`)).json();
    try {
      expect(await get()).toMatchObject({ source: 'baked', steps: { bad: { result: { summary: 'from the repo' } } } });
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'd3.json'), file('from this lab'));
      expect(await get()).toMatchObject({ source: 'live', steps: { bad: { result: { summary: 'from this lab' } } } });
    } finally {
      await new Promise((resolve) => s.close(resolve));
    }
  });

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
    const fresh = createConsoleApp({
      demos: [broken], ctx: {}, readiness: async () => READY,
      recordedDir: mkdtempSync(join(tmpdir(), 'rec-')), bakedDir: mkdtempSync(join(tmpdir(), 'baked-')),
    });
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

describe('remote control (./lab.sh drive)', () => {
  // A page that polls like console/public/app.js: takes the next command and
  // answers with the outcome the test hands it.
  let rs, rbase;
  const rget = (path) => fetch(rbase + path);
  async function pageTakes() {
    for (let i = 0; i < 100; i++) {
      const r = await rget('/api/remote/next');
      if (r.status === 200) return r.json();
      await new Promise((ok) => setTimeout(ok, 20));
    }
    throw new Error('nothing queued');
  }
  const done = (seq, body) => fetch(`${rbase}/api/remote/done/${seq}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    const app = createConsoleApp({
      demos: [broken, timed], ctx: {}, readiness: async () => READY,
      recordedDir: mkdtempSync(join(tmpdir(), 'rec-')), bakedDir: mkdtempSync(join(tmpdir(), 'baked-')), takeMs: 300,
    });
    await new Promise((resolve) => { rs = app.listen(0, '127.0.0.1', resolve); });
    rbase = `http://127.0.0.1:${rs.address().port}`;
  });
  afterAll(() => new Promise((resolve) => rs.close(resolve)));

  test('plan lists the steps in order, with each terminal command', async () => {
    const t = await (await rget('/api/remote/plan/d6')).text();
    expect(t.split('\n').slice(0, 4)).toEqual([
      'd6  Timed fixture', ' 1  pipeline  console  Pipeline', ' 2  sql  terminal  SQL', '      $ ./lab.sh mongosh ora x.js',
    ]);
  });

  test('with no page open, a command times out with a plain hint and is dropped', async () => {
    const r = await fetch(`${rbase}/api/remote/d3/bad/run`, { method: 'POST' });
    expect(r.status).toBe(504);
    expect(await r.text()).toMatch(/^FAIL  no console page took it/);
    expect((await rget('/api/remote/next')).status).toBe(204);
  });

  test('the page takes the command once, and its outcome comes back as text', async () => {
    const queued = fetch(`${rbase}/api/remote/d6/timing/run`, { method: 'POST' });
    const cmd = await pageTakes();
    expect(cmd).toMatchObject({ demo: 'd6', step: 'timing', action: 'run' });
    const q = await queued;
    expect(q.status).toBe(200);
    expect(Number(await q.text())).toBe(cmd.seq);
    expect((await rget('/api/remote/next')).status).toBe(204); // taken once
    expect((await rget(`/api/remote/result/${cmd.seq}?wait=0`)).status).toBe(202);
    const waiting = rget(`/api/remote/result/${cmd.seq}?wait=5000`);
    await done(cmd.seq, { ok: false, summary: 'step still running' });
    const r = await waiting;
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('FAIL  step still running\n');
  });

  test('bad step, bad action and a bad outcome body are refused', async () => {
    expect((await fetch(`${rbase}/api/remote/d6/nope/run`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${rbase}/api/remote/d6/timing/explode`, { method: 'POST' })).status).toBe(400);
    expect((await fetch(`${rbase}/api/remote/zz/timing/run`, { method: 'POST' })).status).toBe(404);
    expect((await done(1, { ok: 'yes' })).status).toBe(400);
  });

  test('presenter keys: dropped with no autopilot, queued and taken once while it polls', async () => {
    const key = (q) => fetch(`${rbase}/api/remote/key?${q}`, { method: 'POST' });
    expect((await key('from=nobody')).status).toBe(400);
    expect((await key('from=deck&demo=d9')).status).toBe(400);
    const r0 = await key('from=deck&demo=d1');
    expect(r0.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r0.json()).toEqual({ ok: false, listening: false }); // the deck moves on by itself
    const poll = rget('/api/remote/key?wait=5000'); // the autopilot's long poll
    await new Promise((r) => setTimeout(r, 100));
    expect(await (await key('from=deck&demo=d1')).json()).toEqual({ ok: true, listening: true });
    const got = await poll;
    expect(got.status).toBe(200);
    expect((await got.text()).trim()).toBe('deck d1');
    await key('from=term');
    await key('from=console');
    expect((await fetch(`${rbase}/api/remote/key`, { method: 'DELETE' })).status).toBe(204);
    expect((await rget('/api/remote/key?wait=0')).status).toBe(204); // presses during a step are gone
  });

  test('presenter keys: the running demo is published for the deck and the notes', async () => {
    const state = async () => (await (await rget('/api/remote/key/state')).text()).trim();
    expect(await state()).toBe('');
    expect((await fetch(`${rbase}/api/remote/key/state?demo=d2`, { method: 'POST' })).status).toBe(204);
    expect(await state()).toBe('d2');
    expect((await fetch(`${rbase}/api/remote/key/state?demo=x`, { method: 'POST' })).status).toBe(400);
    await fetch(`${rbase}/api/remote/key/state?demo=`, { method: 'POST' });
    expect(await state()).toBe('');
    expect((await fetch(`${rbase}/api/remote/key?from=notes`, { method: 'POST' })).status).toBe(200);
  });

  test('status reports readiness, whether a page is polling, and what runs', async () => {
    await rget('/api/remote/next');
    const t = await (await rget('/api/remote/status')).text();
    expect(t).toMatch(/^OK    services ready\nOK    console page open \(polled \d+\.\d s ago\)\nINFO  idle\n$/);
  });

  test('a long poll (?wait=) takes a command queued while it waits, and counts as an open page', async () => {
    const waiting = rget('/api/remote/next?wait=5000');
    await new Promise((r) => setTimeout(r, 150));
    expect(await (await rget('/api/remote/status')).text()).toMatch(/console page open \(waiting for a command\)/);
    const queued = fetch(`${rbase}/api/remote/d6/timing/show`, { method: 'POST' });
    const r = await waiting;
    expect(r.status).toBe(200);
    const cmd = await r.json();
    expect(cmd).toMatchObject({ demo: 'd6', step: 'timing', action: 'show' });
    expect((await queued).status).toBe(200);
    await done(cmd.seq, { ok: true, summary: 'shown' });
  });
});

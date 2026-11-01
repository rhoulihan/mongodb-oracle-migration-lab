// Demo step contract. Structural checks run on every demo under demos/ and on
// the fixtures. The run-twice check (Review Focus 1: re-running a demo without
// a reset) runs on the fixtures always and on the real demos when LAB_UP is set.
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listDemos, runDemo, validateDemo, createContext } from '../../demos/contract.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/demos', import.meta.url));

const real = await listDemos();
const fixtures = await listDemos(FIXTURES);
const all = [...real, ...fixtures];
const fixture = fixtures.find((d) => d.demo.id === 'd1').demo;
const failing = fixtures.find((d) => d.demo.id === 'd2').demo;

describe('every demo follows the contract', () => {
  test('fixtures are found', () => {
    expect(fixtures.map((d) => d.demo.id)).toEqual(['d1', 'd2']);
  });

  test.each(all.map((d) => [d.dir, d.demo]))('%s', (_dir, demo) => {
    const ids = demo.steps.map((s) => s.id);
    expect(new Set(ids).size, 'unique step ids').toBe(ids.length);
    for (const s of demo.steps.filter((x) => x.lane === 'terminal')) {
      expect(s.command, `terminal step ${s.id} has a command`).toMatch(/\S/);
    }
    expect(validateDemo(demo)).toEqual([]);
  });

  test('real demo ids are unique', () => {
    const ids = real.map((d) => d.demo.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('validateDemo', () => {
  const step = (o) => ({ id: 's', title: 'S', lane: 'console', run: async () => ({ ok: true, summary: '' }), ...o });
  const demo = (o) => ({ id: 'd3', title: 'T', setup: async () => {}, reset: async () => {}, steps: [step()], ...o });

  test('flags duplicate step ids, a terminal step without a command, a bad lane and a bad id', () => {
    expect(validateDemo(demo())).toEqual([]);
    expect(validateDemo(demo({ steps: [step(), step()] })).join()).toMatch(/duplicate step id s/);
    expect(validateDemo(demo({ steps: [step({ lane: 'terminal' })] })).join()).toMatch(/needs a command/);
    expect(validateDemo(demo({ steps: [step({ lane: 'side' })] })).join()).toMatch(/lane/);
    expect(validateDemo(demo({ id: 'd8' })).join()).toMatch(/id/);
    expect(validateDemo(demo({ setup: undefined })).join()).toMatch(/setup/);
  });
});

describe('runDemo', () => {
  test('runs every step in order and returns their results', async () => {
    await fixture.setup({});
    const r = await runDemo(fixture, { ctx: {} });
    expect(r.map((x) => [x.ok, x.summary])).toEqual([[true, 'count is 1'], [true, 'count is 2']]);
  });

  test('only runs the named steps and rejects unknown ones', async () => {
    const r = await runDemo(failing, { only: ['fine'], ctx: {} });
    expect(r.map((x) => x.summary)).toEqual(['fine']);
    await expect(runDemo(failing, { only: ['nope'], ctx: {} })).rejects.toThrow(/unknown step nope/);
  });

  test('stops at the first failing step; a throw becomes ok:false', async () => {
    const r = await runDemo(failing, { ctx: {} });
    expect(r.map((x) => x.ok)).toEqual([true, false]);
    const t = await runDemo(failing, { only: ['boom'], ctx: {} });
    expect(t[0]).toMatchObject({ ok: false, summary: expect.stringMatching(/kaboom/) });
  });

  test('a non-StepResult return is a failure', async () => {
    const bad = { ...fixture, steps: [{ id: 'x', title: 'X', lane: 'console', run: async () => 42 }] };
    const [r] = await runDemo(bad, { ctx: {} });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/StepResult/);
  });
});

async function setupRunTwice(demo, ctx) {
  for (let round = 1; round <= 2; round++) {
    await demo.setup(ctx);
    const results = await runDemo(demo, { ctx });
    expect(results, `round ${round}`).toHaveLength(demo.steps.length);
    for (const [i, r] of results.entries()) {
      expect(r.ok, `round ${round} step ${demo.steps[i].id}: ${r.summary}`).toBe(true);
    }
  }
}

describe('setup, all steps, setup, all steps', () => {
  test('fixture demo', async () => {
    await setupRunTwice(fixture, {});
    // Without setup the second run must not pass silently.
    const again = await runDemo(fixture, { ctx: {} });
    expect(again[0].ok).toBe(false);
  });

  describe.skipIf(!process.env.LAB_UP)('real demos (LAB_UP)', () => {
    for (const { dir, demo } of real) {
      test(dir, async () => {
        const ctx = createContext();
        try { await setupRunTwice(demo, ctx); } finally { await ctx.close(); }
      }, 600_000);
    }
  });
});

describe('demos/run.mjs CLI', () => {
  const run = (...args) => spawnSync('node', ['demos/run.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, LAB_DEMOS_DIR: FIXTURES },
  });

  test('runs setup and every step, prints summaries, exits 0', () => {
    const r = run('d1');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ok\s+start\s+count is 1/);
    expect(r.stdout).toMatch(/ok\s+type\s+count is 2/);
  });

  test('exits 1 when a step returns ok:false', () => {
    const r = run('d2');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+bad\s+results differ/);
  });

  test('--step runs only the named steps', () => {
    expect(run('d2', '--step', 'fine').status).toBe(0);
    const r = run('d2', '--step', 'bad');
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/fine/);
  });

  test('--reset calls the demo reset', () => {
    const r = run('d1', '--reset');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/d1 reset/);
  });

  test('an unknown demo exits non-zero with a message', () => {
    const r = run('d7');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no demo d7/);
  });

  test('lab.sh demo and lab.sh reset dN run the runner on the host', () => {
    const sh = (...args) => spawnSync('./lab.sh', args, {
      cwd: root, encoding: 'utf8', env: { ...process.env, LAB_DEMOS_DIR: FIXTURES },
    });
    const ok = sh('demo', 'd1');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/ok\s+type\s+count is 2/);
    const step = sh('demo', 'd2', '--step', 'bad');
    expect(step.status).toBe(1);
    expect(step.stdout).toMatch(/FAIL\s+bad\s+results differ/);
    const reset = sh('reset', 'd1');
    expect(reset.status).toBe(0);
    expect(reset.stdout).toMatch(/d1 reset/);
  });
});

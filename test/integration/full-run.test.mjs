// Full-run smoke test: the whole session, headless, exactly as the run sheet
// (scripts/run-sheet.mjs, docs/REHEARSAL.md) tells the presenter to run it.
// A full `./lab.sh reset`, `./lab.sh generate`, then D1 to D7 in session order
// through `./lab.sh demo dN` (demos/run.mjs, setup then every step), with the
// run sheet's resets between demos. Every step must print ok and every
// command exit 0. It must pass twice in a row with nothing done by hand
// between the runs: the first command is a full reset.
//
// Gated on LAB_UP (the stack must be up). It wipes the lab volumes, so the
// console's live recordings go too (fallback/recorded/ is the copy that stays).
// Takes about 9 minutes on the Linux lab (--reporter=verbose shows each
// command's time; .lab/full-run/ keeps each command's output). `./lab.sh` runs Node in the runner container unless
// LAB_HOST_NODE=1 is set, so by default it also proves the images.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { findDemo } from '../../demos/contract.mjs';
import { BEFORE, SESSION } from '../../scripts/run-sheet.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
let broken = null; // the first command that failed: later ones would only add noise

function lab(args) {
  const r = spawnSync('./lab.sh', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = `${r.stdout}\n${r.stderr}`;
  // Each command's output, for the rehearsal numbers (D3 restore, D6 ratio).
  mkdirSync(`${root}.lab/full-run`, { recursive: true });
  writeFileSync(`${root}.lab/full-run/${args.join('-')}.log`, out);
  return { ...r, out };
}

function step(args, check) {
  test(`./lab.sh ${args.join(' ')}`, async () => {
    if (broken) throw new Error(`skipped: ${broken} failed first`);
    const r = lab(args);
    try {
      expect(r.status, r.out.slice(-4000)).toBe(0);
      await check?.(r);
    } catch (err) {
      broken = `./lab.sh ${args.join(' ')}`;
      throw err;
    }
  }, 1_800_000);
}

describe.skipIf(!process.env.LAB_UP)('full session run (LAB_UP)', () => {
  for (const args of BEFORE) {
    step(args, args[0] === 'reset' ? (r) => expect(r.stdout.match(/^OK /gm)?.length, r.out).toBe(4) : undefined);
  }

  for (const { id, after } of SESSION) {
    step(['demo', id], async (r) => {
      const demo = await findDemo(id);
      const lines = r.stdout.split('\n').filter((l) => /^(ok  |FAIL)  /.test(l));
      expect(lines.filter((l) => l.startsWith('FAIL')), r.out.slice(-4000)).toEqual([]);
      // One ok line per step, in step order.
      expect(lines.map((l) => l.split(/\s+/)[1])).toEqual(demo.steps.map((s) => s.id));
    });
    for (const args of after) step(args, (r) => expect(r.stdout).toMatch(new RegExp(`${args[1]} reset`)));
  }
});

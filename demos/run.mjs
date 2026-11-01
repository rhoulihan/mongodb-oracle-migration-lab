#!/usr/bin/env node
// Headless demo runner, behind `./lab.sh demo dN [--step S]` and `./lab.sh reset dN`.
//
//   node demos/run.mjs dN               setup, then every step
//   node demos/run.mjs dN --step S ...  only the named steps (repeatable), no setup
//   node demos/run.mjs dN --reset       the demo's reset
//   node demos/run.mjs --help           usage
//
// Prints one line per StepResult and exits 1 if any step returns ok:false.
// LAB_DEMOS_DIR points it at another demos folder (the tests use fixtures).
import { parseArgs } from 'node:util';
import { createContext, DEMOS_DIR, findDemo, runDemo, validateDemo } from './contract.mjs';

const USAGE = 'usage: run.mjs dN [--step S]... | dN --reset';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      step: { type: 'string', multiple: true },
      reset: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const id = positionals[0];
  if (!id || positionals.length > 1) throw new Error(USAGE);
  const dir = process.env.LAB_DEMOS_DIR || DEMOS_DIR;
  const demo = await findDemo(id, dir);
  if (!demo) throw new Error(`no demo ${id} in ${dir}`);
  const problems = validateDemo(demo);
  if (problems.length) throw new Error(`${id} breaks the demo contract: ${problems.join('; ')}`);

  const ctx = createContext();
  try {
    if (values.reset) {
      await demo.reset(ctx);
      console.log(`${id} reset`);
      return 0;
    }
    if (!values.step) await demo.setup(ctx);
    const results = await runDemo(demo, { only: values.step, ctx });
    const steps = values.step ? demo.steps.filter((s) => values.step.includes(s.id)) : demo.steps;
    results.forEach((r, i) => console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${steps[i].id}  ${r.summary}`));
    return results.every((r) => r.ok) ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(err.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
// Console screenshots for the projector check (Review Focus 5): drives the
// running console at 127.0.0.1:3200 with the system Chrome (puppeteer-core,
// a dev dependency), clicks through a demo's steps in the UI, then saves
// 1280x720 shots in the light and dark themes to docs/shots/.
//
//   node scripts/shots.mjs [--run d5] [--only d6-timing,...] [--suffix=-before]
//                          [--chrome /usr/bin/google-chrome]
//
// --run dN clicks every step of dN first ("Run step", or "Mark done" for a
// terminal step, after the presenter has typed its command). Without it the
// shots show whatever this console process has already run.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    only: { type: 'string' },   // comma-separated file stems from SHOTS
    suffix: { type: 'string', default: '' },
    chrome: { type: 'string', default: process.env.CHROME || '/usr/bin/google-chrome' },
    url: { type: 'string', default: 'http://127.0.0.1:3200/' },
  },
});
const OUT = fileURLToPath(new URL('../docs/shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// What to capture: [file stem, hash, optional page action].
const SHOTS = [
  ['d5-setup', 'd5/setup'],
  ['d5-converged', 'd5/converged'],
  ['d5-same-shape', 'd5/same-shape'],
  ['d5-mongosh-read', 'd5/mongosh-read'],
  ['d4-header', 'd4/setup'],
  ['d6-pipeline-oracle', 'd6/pipeline-oracle'],
  ['d6-plans', 'd6/plans'],
  ['d6-timing', 'd6/timing'],
];
const wanted = values.only ? SHOTS.filter(([stem]) => values.only.split(',').includes(stem)) : SHOTS;

const browser = await puppeteer.launch({ executablePath: values.chrome, headless: true, args: ['--no-sandbox'] });
const offsite = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1[:/]|data:|blob:)/.test(r.url())) offsite.push(r.url()); });

  if (values.run) {
    await page.goto(`${values.url}#${values.run}`, { waitUntil: 'networkidle0' });
    const ids = await page.evaluate(async (id) => (await (await fetch('/api/demos')).json()).find((d) => d.id === id).steps.map((s) => s.id), values.run);
    for (const step of ids) {
      await page.goto(`${values.url}?n=${Date.now()}#${values.run}/${step}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.step-bar .btn.primary, .step-bar .btn.done');
      const t0 = Date.now();
      await page.click('.step-bar .btn.primary, .step-bar .btn.done');
      await page.waitForSelector('#timer', { timeout: 5000 }).catch(() => {});
      if (step === ids[1]) await page.screenshot({ path: `${OUT}${values.run}-running-light.png` });
      await page.waitForFunction(() => !document.getElementById('timer'), { timeout: 900_000, polling: 500 });
      const verdict = await page.$eval('.result .status', (e) => e.textContent).catch(() => 'no result');
      console.log(`${values.run} ${step}: ${verdict} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }

  for (const theme of ['light', 'dark']) {
    for (const [stem, hash] of wanted) {
      await page.goto(`${values.url}?theme=${theme}#${hash}`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      const file = `${stem}${values.suffix}-${theme}.png`;
      await page.screenshot({ path: OUT + file });
      // Anything wider than the window scrolls sideways on a projector.
      const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      console.log(`${file}${over ? '  OVERFLOWS horizontally' : ''}`);
    }
  }
} finally {
  await browser.close();
}
if (offsite.length) {
  console.error(`requests off 127.0.0.1: ${[...new Set(offsite)].join(', ')}`);
  process.exitCode = 1;
}

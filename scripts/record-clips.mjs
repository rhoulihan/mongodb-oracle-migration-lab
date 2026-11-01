#!/usr/bin/env node
// Rehearsal recordings (developers; needs Node, `npm install` and Chrome).
// Drives the instructor console at 127.0.0.1:3200 through the whole session,
// in run-sheet order (scripts/run-sheet.mjs), the way the presenter does:
// console steps get "Run step"; for a terminal step the script runs the
// step's own command (`./lab.sh ...`, from the repo root) and then presses
// "Mark done". Between demos it runs the run sheet's resets.
//
// It leaves two things:
//   clips/dN.webm            a 1280x720 video of the console for each demo,
//                            the presenter's local fallback (not committed)
//   /state/recorded/dN.json  the console's recording of every passing step
//                            (the state volume); `./lab.sh bake-recordings`
//                            copies them into fallback/recorded/ to commit
//
// By default it starts from a clean lab (`./lab.sh reset`, which also wipes
// older recordings, then `./lab.sh generate`), so every recording comes from
// one clean run. It exits 1 if any step fails: do not bake that run.
//
//   node scripts/record-clips.mjs [--demos d5,d6] [--no-fresh] [--no-video]
//                                 [--theme light|dark] [--chrome PATH]
//
// Video: Chrome's screencast (CDP Page.startScreencast) streams JPEG frames,
// and a second headless Chrome paints them on a canvas recorded with
// MediaRecorder (VP8 WebM). No ffmpeg needed. The files have no duration in
// their header (MediaRecorder's live WebM); Chrome and VLC play them fine.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { BEFORE, SESSION } from './run-sheet.mjs';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { values } = parseArgs({
  options: {
    demos: { type: 'string' },
    fresh: { type: 'boolean', default: true },
    'no-fresh': { type: 'boolean' },
    video: { type: 'boolean', default: true },
    'no-video': { type: 'boolean' },
    theme: { type: 'string', default: 'light' },
    chrome: { type: 'string', default: process.env.CHROME || (process.platform === 'darwin' ? MAC_CHROME : '/usr/bin/google-chrome') },
    url: { type: 'string', default: 'http://127.0.0.1:3200/' },
  },
});
const fresh = values.fresh && !values['no-fresh'];
const video = values.video && !values['no-video'];
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIPS = fileURLToPath(new URL('../clips/', import.meta.url));
const wanted = values.demos ? values.demos.split(',') : SESSION.map((d) => d.id);
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toISOString().slice(11, 19);

/** Run a shell command from the repo root; resolves {code, out}. Output is echoed indented. */
function sh(cmd) {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (b) => { out += b; process.stdout.write(String(b).replace(/^/gm, '      | ')); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function waitForConsole(page) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await page.evaluate(async () => (await fetch('/api/ready')).json());
      if (r.ready) return;
    } catch { /* console restarting */ }
    await sleep(2000);
    await page.goto(values.url, { waitUntil: 'load' }).catch(() => {});
  }
  throw new Error('the console never reported ready (./lab.sh check)');
}

// ---- video: screencast frames -> canvas -> MediaRecorder ------------------
const ENCODER_HTML = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
  const c = document.getElementById('c'), g = c.getContext('2d');
  let rec, chunks;
  window.startRec = () => {
    chunks = [];
    g.fillStyle = '#000'; g.fillRect(0, 0, ${W}, ${H});
    rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4e6 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(1000);
  };
  window.draw = (b64) => new Promise((ok) => {
    const im = new Image();
    im.onload = () => { g.drawImage(im, 0, 0, ${W}, ${H}); ok(); };
    im.onerror = () => ok();
    im.src = 'data:image/jpeg;base64,' + b64;
  });
  window.stopRec = () => new Promise((ok) => {
    rec.onstop = async () => {
      const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      ok(btoa(s));
    };
    rec.stop();
  });
</script></body></html>`;

async function makeRecorder(page) {
  if (!video) return { start: async () => {}, stop: async () => null };
  const enc = await puppeteer.launch({ executablePath: values.chrome, headless: true, args: ['--no-sandbox'] });
  const ep = await enc.newPage();
  await ep.setViewport({ width: W, height: H });
  await ep.setContent(ENCODER_HTML);
  const cdp = await page.createCDPSession();
  let busy = false, latest = null, frames = 0;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (latest) {
      const b64 = latest; latest = null;
      await ep.evaluate((d) => window.draw(d), b64).catch(() => {});
      frames++;
    }
    busy = false;
  };
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    latest = data; // keep only the newest frame if the encoder falls behind
    pump();
  });
  return {
    async start() {
      frames = 0;
      await ep.evaluate(() => window.startRec());
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    },
    async stop(file) {
      await cdp.send('Page.stopScreencast');
      while (busy) await sleep(50);
      const b64 = await ep.evaluate(() => window.stopRec());
      const buf = Buffer.from(b64, 'base64');
      writeFileSync(file, buf);
      return { frames, bytes: buf.length };
    },
    close: () => enc.close(),
  };
}

// ---- one demo through the console ----------------------------------------
async function runDemoInConsole(page, id) {
  const demo = (await page.evaluate(async () => (await fetch('/api/demos')).json())).find((d) => d.id === id);
  await page.goto(`${values.url}?theme=${values.theme}#${id}/${demo.steps[0].id}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(1500);
  const results = [];
  for (const [i, s] of demo.steps.entries()) {
    await page.click(`#steps li:nth-child(${i + 1}) button`);
    await page.waitForSelector('.step-bar .btn.primary, .step-bar .btn.done');
    await sleep(1200);
    const t0 = Date.now();
    if (s.lane === 'terminal') {
      console.log(`${t()}  ${id} ${s.id}: $ ${s.command}`);
      const r = await sh(s.command);
      if (r.code !== 0) {
        results.push({ step: s.id, ok: false, summary: `command exited ${r.code}` });
        break;
      }
    }
    await page.click('.step-bar .btn.primary, .step-bar .btn.done');
    await page.waitForSelector('#timer', { timeout: 3000 }).catch(() => {});
    await page.waitForFunction(() => !document.getElementById('timer'), { timeout: 900_000, polling: 250 });
    await page.waitForSelector('.result .status', { timeout: 10_000 }).catch(() => {});
    const status = await page.$eval('.result .status', (e) => e.textContent).catch(() => 'no result');
    const summary = await page.$eval('.result .summary', (e) => e.textContent).catch(() => '');
    const ok = status === 'Passed';
    console.log(`${t()}  ${id} ${s.id}: ${ok ? 'ok' : 'FAIL'} (${Math.round((Date.now() - t0) / 1000)} s) ${summary}`);
    results.push({ step: s.id, ok, summary });
    // Let the result sit on screen, and scroll it into view, for the clip.
    await page.evaluate(() => document.querySelector('.result')?.scrollIntoView({ block: 'start' }));
    await sleep(3000);
    await page.evaluate(() => scrollTo(0, 0));
    if (!ok) break;
  }
  return { demo, results };
}

// ---- main -------------------------------------------------------------------
mkdirSync(CLIPS, { recursive: true });
if (fresh) {
  for (const args of BEFORE) {
    console.log(`${t()}  $ ./lab.sh ${args.join(' ')}`);
    const r = await sh(`./lab.sh ${args.join(' ')}`);
    if (r.code !== 0) { console.error(`./lab.sh ${args.join(' ')} failed`); process.exit(1); }
  }
}

const browser = await puppeteer.launch({ executablePath: values.chrome, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const offsite = [];
page.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1[:/]|data:|blob:)/.test(r.url())) offsite.push(r.url()); });
await page.goto(values.url, { waitUntil: 'load' }).catch(() => {});
await waitForConsole(page);
const recorder = await makeRecorder(page);

const report = [];
let failed = false;
try {
  for (const { id, after } of SESSION) {
    if (!wanted.includes(id)) continue;
    await recorder.start();
    const { demo, results } = await runDemoInConsole(page, id);
    const v = await recorder.stop(`${CLIPS}${id}.webm`);
    const ok = results.length === demo.steps.length && results.every((r) => r.ok);
    // The console's recording must hold every step of this run.
    const rec = await page.evaluate(async (d) => (await fetch(`/api/demos/${d}/recorded`)).json(), id);
    const recOk = rec.source === 'live' && demo.steps.every((s) => rec.steps?.[s.id]?.result?.ok === true);
    report.push({ id, ok: ok && recOk, steps: `${results.filter((r) => r.ok).length}/${demo.steps.length}`, recorded: recOk, video: v });
    if (!ok || !recOk) { failed = true; break; }
    for (const args of after) {
      console.log(`${t()}  $ ./lab.sh ${args.join(' ')}`);
      const r = await sh(`./lab.sh ${args.join(' ')}`);
      if (r.code !== 0) { failed = true; break; }
    }
    if (failed) break;
  }
} finally {
  await recorder.close?.();
  await browser.close();
}

console.log('\ndemo  steps  recorded  clip');
for (const r of report) {
  console.log(`${r.id}    ${r.steps.padEnd(5)}  ${r.recorded ? 'yes' : 'NO '}       ${r.video ? `clips/${r.id}.webm (${(r.video.bytes / 1e6).toFixed(1)} MB, ${r.video.frames} frames)` : '-'}`);
}
if (offsite.length) {
  console.error(`requests off 127.0.0.1: ${[...new Set(offsite)].join(', ')}`);
  failed = true;
}
if (failed) {
  console.error('\nnot a clean run: do not bake these recordings');
  process.exitCode = 1;
} else {
  console.log('\nclean run: ./lab.sh bake-recordings, then commit fallback/recorded/ and ./lab.sh build');
}

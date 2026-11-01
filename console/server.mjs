#!/usr/bin/env node
// Instructor console: the compose `console` service (app image, port 3200,
// published on 127.0.0.1 only). One Node process for the whole session:
// every demo is imported once and every request shares one ctx, so the state
// demos keep between steps (D5 and D6 `last`) survives step by step.
//
// Recorded results (the "skip to result" fallback) go to LAB_RECORDED_DIR:
// /state/recorded on the `state` volume in the container, .lab/recorded on
// the host.
//
//   node console/server.mjs     listen on CONSOLE_PORT (3200), all interfaces
//                               in the container, 127.0.0.1 on the host
import { fileURLToPath } from 'node:url';
import { createContext, listDemos, validateDemo } from '../demos/contract.mjs';
import { config } from '../lib/config.mjs';
import { readiness as probe } from '../lib/ready.mjs';
import { createConsoleApp } from './routes.mjs';

const inContainer = process.env.LAB_IN_CONTAINER === '1';
export const RECORDED_DIR = process.env.LAB_RECORDED_DIR ||
  (inContainer ? '/state/recorded' : fileURLToPath(new URL('../.lab/recorded', import.meta.url)));

/**
 * Start the console. Options exist for the tests; the defaults are the real
 * demos, a fresh ctx and the live readiness probes.
 * @returns {Promise<{url:string, server:import('node:http').Server, close:() => Promise<void>}>}
 */
export async function startConsole({
  port = config.consolePort,
  host = inContainer ? '0.0.0.0' : '127.0.0.1',
  demos,
  ctx = createContext(),
  readiness = probe,
  recordedDir = RECORDED_DIR,
  log = () => {},
} = {}) {
  if (!demos) {
    demos = [];
    for (const { dir, demo } of await listDemos()) {
      const problems = validateDemo(demo);
      if (problems.length) throw new Error(`${dir} breaks the demo contract: ${problems.join('; ')}`);
      demos.push(demo);
    }
  }
  const app = createConsoleApp({ demos, ctx, readiness, recordedDir, log });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, (err) => (err ? reject(err) : resolve(s)));
  });
  const { port: bound } = server.address();
  let closing;
  const close = () => (closing ??= (async () => {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    await ctx.close?.();
  })());
  return { url: `http://127.0.0.1:${bound}`, server, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ts = () => new Date().toISOString().slice(11, 19);
  const c = await startConsole({ log: (...a) => console.log(ts(), ...a) });
  console.log(`${ts()} lab console on port ${config.consolePort} (open http://127.0.0.1:3200); recorded results in ${RECORDED_DIR}`);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      console.log(`${ts()} ${sig}: closing`);
      c.close().then(() => process.exit(0), (err) => { console.error(err.message); process.exit(1); });
    });
  }
}

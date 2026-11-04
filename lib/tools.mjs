// The MongoDB Database Tools (and anything else in the lab images), run from
// Node. Inside a lab container (the runner) the tool runs right there; on the
// host (developers, the vitest suite) it runs in lab-mongo through
// `./lab.sh exec mongo`, which carries the same tools and the same /dumps
// volume. Either way the tool sees the compose network, so callers pass the
// service-name URIs (config.toolSrcUri, config.toolOraUri).
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const LAB_SH = fileURLToPath(new URL('../lab.sh', import.meta.url));
const inContainer = () => process.env.LAB_IN_CONTAINER === '1';

function spawnTool(argv) {
  return inContainer()
    ? spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(LAB_SH, ['exec', 'mongo', ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Run one tool to completion.
 * @param {string[]} argv
 * @param {{onStderr?: (chunk: Buffer) => void}} [opts] onStderr sees the tool's log live (the terminal steps show it)
 * @returns {Promise<{code:number, stdout:string, stderr:string, ms:number}>}
 */
export function runTool(argv, { onStderr } = {}) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const p = spawnTool(argv);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; onStderr?.(d); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - t0 }));
  });
}

/** A readable stream of a file in the shared /dumps volume. */
export function readDump(path) {
  if (inContainer()) return createReadStream(path);
  const p = spawnTool(['cat', path]);
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { if (code) p.stdout.destroy(new Error(`cat ${path}: ${err.trim() || `exit ${code}`}`)); });
  return p.stdout;
}

/** Remove a file in the shared /dumps volume (no error when it is missing). */
export async function removeDump(path) {
  if (inContainer()) return rm(path, { force: true });
  const r = await runTool(['rm', '-f', path]);
  if (r.code) throw new Error(`rm ${path}: ${r.stderr.trim()}`);
}

/** True when the file exists in the shared /dumps volume. */
export async function dumpExists(path) {
  return (await runTool(['test', '-s', path])).code === 0;
}

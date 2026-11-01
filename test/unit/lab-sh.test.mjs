// lab.sh routing (Ruling N): the presenter's laptop has only Podman, so demos,
// resets, the generator and mongosh all run inside lab containers. A fake
// container engine on PATH records what lab.sh would run; no stack needed.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
let fakeBin;

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'lab-engine-'));
  const fake = [
    '#!/bin/sh',
    'echo "ENGINE $*"',
  ].join('\n');
  for (const name of ['podman', 'docker']) {
    writeFileSync(join(fakeBin, name), fake + '\n');
    chmodSync(join(fakeBin, name), 0o755);
  }
});

const sh = (args, env = {}) => {
  const e = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env };
  delete e.LAB_HOST_NODE;
  // A dead app URL keeps the app-env sync after demo/reset off the real stack.
  e.LAB_APP_URL = 'http://127.0.0.1:9';
  return spawnSync('./lab.sh', args, { cwd: root, encoding: 'utf8', env: e });
};

describe('lab.sh runs Node work in a one-off runner container (Ruling O)', () => {
  // compose run --rm --no-deps runner: a fresh container from the app image, so
  // a step that switches the order service never touches the runner itself.
  const RUN = 'ENGINE compose -f compose.yml --profile runner run --rm --no-deps -T -e MIG_PASSWORD=MigUser2026 runner node';

  test('demo dN --step S', () => {
    const r = sh(['demo', 'd3', '--step', 'flip']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${RUN} demos/run.mjs d3 --step flip\n`);
    expect(r.stdout).not.toMatch(/exec .*lab-app/);
  });

  test('reset dN', () => {
    const r = sh(['reset', 'd2']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${RUN} demos/run.mjs d2 --reset\n`);
  });

  test('generate --scale S', () => {
    const r = sh(['generate', '--scale', 'tiny']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${RUN} gen/generate.mjs --scale tiny\n`);
  });

  test('agent read|write|retry --agent A|B (D7 terminal steps)', () => {
    const r = sh(['agent', 'write', '--agent', 'B']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${RUN} demos/d7-etag/agent.mjs write --agent B\n`);
    expect(sh(['agent']).status).toBe(2);
  });

  test('passes MIG_PASSWORD into the container', () => {
    const r = sh(['demo', 'd1'], { MIG_PASSWORD: 'Other2026' });
    expect(r.stdout).toMatch(/ -e MIG_PASSWORD=Other2026 runner /);
  });
});

describe('lab.sh app-uri', () => {
  // A stub order service answers /admin/backend; lab.sh runs asynchronously so
  // the stub (same process) can reply. .lab/app.env is restored afterwards.
  const ENV = join(root, '.lab', 'app.env');
  let saved, stub, status;
  const shAsync = (args, env) => new Promise((resolve) => {
    const e = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env };
    execFile('./lab.sh', args, { cwd: root, env: e }, (err, stdout, stderr) =>
      resolve({ status: err ? err.code : 0, stdout, stderr }));
  });

  beforeAll(async () => {
    saved = existsSync(ENV) ? readFileSync(ENV, 'utf8') : null;
    writeFileSync(ENV, 'APP_MONGO_URI=before\n');
    stub = createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"target":"oracle","backend":"oracle"}' : '{"error":"cannot reach oracle: ORDS not ready"}');
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  });
  afterAll(() => {
    stub?.close();
    if (saved === null) writeFileSync(ENV, 'APP_MONGO_URI=mongodb://mongo:27017/telco?replicaSet=rs0&directConnection=true\n');
    else writeFileSync(ENV, saved);
  });
  const url = () => `http://127.0.0.1:${stub.address().port}`;

  test('an unknown backend prints usage and exits 2', () => {
    expect(sh(['app-uri', 'postgres']).status).toBe(2);
  });

  test('an HTTP error (503) prints it, exits 1, keeps app.env and never restarts the app', async () => {
    status = 503;
    writeFileSync(ENV, 'APP_MONGO_URI=before\n');
    const r = await shAsync(['app-uri', 'oracle'], { LAB_APP_URL: url() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did not switch to oracle: cannot reach oracle: ORDS not ready/);
    expect(r.stdout).not.toMatch(/ENGINE compose .* up/);
    expect(readFileSync(ENV, 'utf8')).toBe('APP_MONGO_URI=before\n');
  });

  test('a 200 switch writes app.env and restarts nothing', async () => {
    status = 200;
    const r = await shAsync(['app-uri', 'oracle'], { LAB_APP_URL: url() });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/order service now uses oracle/);
    expect(r.stdout).not.toMatch(/ENGINE/);
    expect(readFileSync(ENV, 'utf8')).toMatch(/@oracle:27017\/MIG/);
  });

  test('no connection writes app.env and starts the app', async () => {
    writeFileSync(ENV, 'APP_MONGO_URI=before\n');
    const r = await shAsync(['app-uri', 'mongo'], { LAB_APP_URL: 'http://127.0.0.1:9' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ENGINE compose -f compose.yml up -d --no-deps app$/m);
    expect(readFileSync(ENV, 'utf8')).toMatch(/mongo:27017\/telco/);
  });
});

describe('lab.sh mongosh src|ora', () => {
  test('src runs mongosh in the mongo container against the source replica set', () => {
    const r = sh(['mongosh', 'src', '--eval', 'db.orders.countDocuments()']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'lab-mongo mongosh mongodb://localhost:27017/telco?replicaSet=rs0&directConnection=true --eval db.orders.countDocuments()');
  });

  test('ora runs mongosh in the oracle container against the Oracle API for MongoDB as MIG', () => {
    const r = sh(['mongosh', 'ora', '--eval', 'db.getCollectionNames()']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'lab-oracle mongosh mongodb://MIG:MigUser2026@localhost:27017/MIG?authMechanism=PLAIN&authSource=$external' +
      '&tls=false&retryWrites=false&loadBalanced=true --eval db.getCollectionNames()');
  });

  test('an unknown target prints usage and exits 2', () => {
    expect(sh(['mongosh', 'prod']).status).toBe(2);
  });
});

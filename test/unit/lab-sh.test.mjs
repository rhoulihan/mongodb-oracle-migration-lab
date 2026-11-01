// lab.sh routing (Ruling N): the presenter's laptop has only Podman, so demos,
// resets, the generator and mongosh all run inside lab containers. A fake
// container engine on PATH records what lab.sh would run; no stack needed.
import { beforeAll, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  const RUN = 'ENGINE compose -f compose.yml run --rm --no-deps -T -e MIG_PASSWORD=MigUser2026 runner node';

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

  test('passes MIG_PASSWORD into the container', () => {
    const r = sh(['demo', 'd1'], { MIG_PASSWORD: 'Other2026' });
    expect(r.stdout).toMatch(/ -e MIG_PASSWORD=Other2026 runner /);
  });
});

describe('lab.sh app-uri', () => {
  test('an unknown backend prints usage and exits 2', () => {
    expect(sh(['app-uri', 'postgres']).status).toBe(2);
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

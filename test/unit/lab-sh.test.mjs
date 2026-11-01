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
    'if [ "$1" = container ] && [ "$2" = inspect ]; then echo "${FAKE_RUNNING:-true}"; exit 0; fi',
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
  return spawnSync('./lab.sh', args, { cwd: root, encoding: 'utf8', env: e });
};

describe('lab.sh runs Node work inside the app container', () => {
  test('demo dN --step S', () => {
    const r = sh(['demo', 'd3', '--step', 'flip']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ENGINE exec .*lab-app node demos\/run\.mjs d3 --step flip$/m);
  });

  test('reset dN', () => {
    const r = sh(['reset', 'd2']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ENGINE exec .*lab-app node demos\/run\.mjs d2 --reset$/m);
  });

  test('generate --scale S', () => {
    const r = sh(['generate', '--scale', 'tiny']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ENGINE exec .*lab-app node gen\/generate\.mjs --scale tiny$/m);
  });

  test('passes MIG_PASSWORD into the container', () => {
    const r = sh(['demo', 'd1'], { MIG_PASSWORD: 'Other2026' });
    expect(r.stdout).toMatch(/-e MIG_PASSWORD=Other2026 /);
  });

  test('says how to start the stack when the app container is not running', () => {
    const r = sh(['demo', 'd1'], { FAKE_RUNNING: 'false' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lab-app is not running.*\.\/lab\.sh up/);
    expect(r.stdout).not.toMatch(/ENGINE exec/);
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

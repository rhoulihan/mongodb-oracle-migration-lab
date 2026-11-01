import { afterAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const script = resolve('scripts/lint-copy.mjs');
// Banned tokens are assembled at runtime so this file passes the lint itself.
const V23 = '23' + 'ai';
const JOB = 'job' + 'App';
const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Fresh git repo per case, one tracked file at `rel`, then run the lint in it.
function lintWith(rel, text) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-copy-'));
  dirs.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
  spawnSync('git', ['add', '-A'], { cwd: dir });
  return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
}

test('clean file passes', () => {
  expect(lintWith('ok.md', 'Oracle AI Database 26ai, plain dashes - only.\n').status).toBe(0);
});
test('em dash fails', () => {
  const r = lintWith('a.md', `one ${String.fromCharCode(0x2014)} two\n`);
  expect(r.status).toBe(1); expect(r.stderr).toMatch(/em dash/);
});
test('old version name outside docs/ fails', () => {
  const r = lintWith('b.md', `Oracle ${V23} Free\n`);
  expect(r.status).toBe(1); expect(r.stderr).toContain(V23);
});
test('old version name inside docs/ is allowed', () => {
  expect(lintWith('docs/ref.md', `see the ${V23} docs\n`).status).toBe(0);
});
test('private folder name fails', () => {
  const r = lintWith('c.md', `see ${JOB}/notes\n`);
  expect(r.status).toBe(1); expect(r.stderr).toContain(JOB);
});

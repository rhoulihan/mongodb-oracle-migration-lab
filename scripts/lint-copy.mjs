#!/usr/bin/env node
// Copy lint: fails (exit 1) if any git-tracked text file contains an em dash,
// the old database version name outside docs/, or the private folder name.
// Banned tokens are built at runtime so this file passes its own check.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  { name: 'em dash (U+2014)', token: String.fromCharCode(0x2014), allow: () => false },
  { name: '23' + 'ai (say 26ai)', token: '23' + 'ai', allow: (f) => f.startsWith('docs/') },
  { name: 'job' + 'App reference', token: 'job' + 'App', allow: () => false },
  // The lab's default MIG password: commands build the URI from MIG_PASSWORD, so
  // the deck and the README never need it (lab.sh and lib/config.mjs hold it).
  { name: 'default MIG password (use a lab.sh wrapper)', token: 'MigUser' + '2026', allow: (f) => !(f.startsWith('deck/') || f === 'README.md') },
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);

let problems = 0;
for (const file of files) {
  let buf;
  try { buf = readFileSync(file); } catch { continue; }   // deleted but still tracked
  if (buf.includes(0)) continue;                           // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const r of RULES) {
      if (line.includes(r.token) && !r.allow(file)) {
        console.error(`${file}:${i + 1}: ${r.name}`);
        problems++;
      }
    }
  });
}

if (problems) {
  console.error(`lint:copy found ${problems} problem(s)`);
  process.exit(1);
}
console.log(`lint:copy OK (${files.length} files)`);

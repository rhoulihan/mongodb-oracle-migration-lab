// The console's Query and SQL reflow: the recorded D5 and D6 SQL, at a
// narrow (two panes) and a wide (one pane) frame width. No lab needed.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { wrapSql } from '../../console/public/sqlwrap.js';

const rec = (id) => JSON.parse(readFileSync(`fallback/recorded/${id}.json`, 'utf8')).steps;
const d5 = rec('d5'), d6 = rec('d6');
const TEXTS = {
  'd5 embedded-write sql': d5['embedded-write'].result.query.left.sql,
  'd5 converged sql': d5.converged.result.query.left.sql,
  'd5 lookup-read sql': d5['lookup-read'].result.query.left.sql,
  'd6 pipeline sql': d6.plans.result.query.left.sql,
  'd6 $sql statement': d6.plans.result.query.right.sql,
  'd6 $sql query': d6.plans.result.query.right.query,
};
const squash = (s) => s.replace(/\s+/g, '');
// A line may stay wide only when it starts with a quoted token (after at most
// one keyword, which never dangles alone) wider than the frame (CSS wraps those).
const quotedLead = (l) => /^\s*([a-z]+\s+)?'/i.test(l);

describe('wrapSql', () => {
  for (const [name, text] of Object.entries(TEXTS)) {
    for (const width of [45, 90]) {
      test(`${name} at ${width} columns`, () => {
        const out = wrapSql(text, width);
        expect(squash(out)).toBe(squash(text));
        expect(out.split('\n').filter((l) => l.length > width && !quotedLead(l))).toEqual([]);
      });
    }
  }

  test('a one-line select breaks at its clauses', () => {
    const out = wrapSql(TEXTS['d5 embedded-write sql'], 45).split('\n');
    expect(out[0]).toMatch(/^select /);
    expect(out[1]).toMatch(/^from "MIG"/);
    expect(out[2]).toMatch(/^where JSON_EXISTS/);
  });

  test('lines that fit are left alone', () => {
    const text = TEXTS['d6 $sql statement'];
    expect(wrapSql(text, 200)).toBe(text);
    const out = wrapSql(text, 90).split('\n');
    for (const l of text.split('\n').filter((x) => x.length <= 90)) expect(out).toContain(l);
  });

  test('"error on error" stays together; no line ends on a keyword', () => {
    const out = wrapSql(TEXTS['d6 $sql statement'], 45);
    expect(out).not.toMatch(/error on\n|error\n\s*on error/);
    expect(out).not.toMatch(/ (on|and|when|then|join)\n/i);
  });

  test('no width, no change', () => {
    expect(wrapSql('select 1 from dual', 0)).toBe('select 1 from dual');
    expect(wrapSql('', 40)).toBe('');
  });
});

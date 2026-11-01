// The D1 operator scan: which MongoDB operators does the code use, and what
// does the Oracle API for MongoDB do with each one?
//
// scanOperators parses each file with acorn and collects every object key
// that starts with "$" ($inc, '$set', ['$unset']). String values that start
// with "$" ('$lines', '$$ROOT') are field paths and variables, not operators,
// so they are left out. classify looks each operator up in compat-matrix.json:
// an entry measured in this lab wins over the reference entry for the same
// operator, and an operator the matrix does not name gets the matrix default,
// marked "not listed".
import { glob, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

/** The repo root: relative globs resolve here, whatever the working directory. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const MEASURED = 'measured in this lab';

const MATRIX_URL = new URL('./compat-matrix.json', import.meta.url);

/** compat-matrix.json, parsed. */
export function loadMatrix() {
  return JSON.parse(readFileSync(MATRIX_URL, 'utf8'));
}

function keyName(prop) {
  if (prop.type !== 'Property') return null;
  const k = prop.key;
  if (!prop.computed && k.type === 'Identifier') return k.name;
  if (k.type === 'Literal' && typeof k.value === 'string') return k.value;
  return null;
}

function collect(node, add) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'ObjectExpression') {
    for (const p of node.properties) {
      const name = keyName(p);
      if (name && /^\$[A-Za-z]/.test(name)) add(name);
    }
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((c) => collect(c, add));
    else if (v && typeof v === 'object' && typeof v.type === 'string') collect(v, add);
  }
}

/**
 * Every $-operator used as an object key in the files the globs match,
 * sorted by operator, with the files (repo-relative, sorted) that use it.
 * @param {string[]} globs relative to the repo root, or absolute
 * @returns {Promise<{op:string, files:string[]}[]>}
 */
export async function scanOperators(globs) {
  const files = new Set();
  for (const g of globs) {
    for await (const f of glob(g, { cwd: ROOT })) files.add(isAbsolute(f) ? relative(ROOT, f) : f);
  }
  const byOp = new Map();
  for (const file of [...files].sort()) {
    const ast = parse(await readFile(resolve(ROOT, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    collect(ast, (op) => {
      if (!byOp.has(op)) byOp.set(op, new Set());
      byOp.get(op).add(file);
    });
  }
  return [...byOp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([op, f]) => ({ op, files: [...f].sort() }));
}

/**
 * Sort operators into supported, caveat and unsupported per the matrix.
 * Each entry keeps the scan's files plus the matrix status, note and source.
 * @param {({op:string, files?:string[]}|string)[]} ops
 * @param {{default:{status:string,note:string}, operators:object[]}} matrix
 */
export function classify(ops, matrix) {
  const out = { supported: [], unsupported: [], caveat: [] };
  for (const o of ops) {
    const { op, files = [] } = typeof o === 'string' ? { op: o } : o;
    const entries = matrix.operators.filter((e) => e.op === op);
    const e = entries.find((x) => x.source === MEASURED) ?? entries[0];
    const row = e
      ? { op, files, status: e.status, note: e.note ?? '', source: e.source, ...(e.date ? { date: e.date } : {}) }
      : { op, files, status: matrix.default.status, note: matrix.default.note, source: 'not listed' };
    out[row.status].push(row);
  }
  return out;
}

const ORDER = ['unsupported', 'caveat', 'supported'];

/** All classified rows in one list: unsupported first, then caveat, then supported. */
export const rowsOf = (c) => ORDER.flatMap((s) => c[s]);

/** The classified operators as a plain-text table. */
export function formatOperators(c) {
  const rows = rowsOf(c).map((r) => [r.op, r.status, r.source, r.files.join(', '), r.note]);
  const head = ['operator', 'on Oracle', 'basis', 'used in', 'note'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  // The note column is last and never padded, so long notes do not widen the rest.
  const line = (r) => r.map((x, i) => (i === r.length - 1 ? x : x.padEnd(w[i]))).join('  ').trimEnd();
  return [line(head), line(w.map((n, i) => '-'.repeat(i === w.length - 1 ? 4 : n))), ...rows.map(line)].join('\n');
}

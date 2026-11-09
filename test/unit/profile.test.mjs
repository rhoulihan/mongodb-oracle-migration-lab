// D1 profiler capture: operators from system.profile entries. The fixture is
// a real capture from the lab (lsid, $clusterTime and inserted documents
// stripped). No lab needed.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { BSON } from 'mongodb';
import { extractOperators } from '../../demos/d1-compat/profile.mjs';
import { scanOperators } from '../../demos/d1-compat/opscan.mjs';

const docs = BSON.EJSON.parse(readFileSync('test/fixtures/profile/system-profile.json', 'utf8'));
const byOp = (rows) => Object.fromEntries(rows.map((r) => [r.op, r.clients]));

describe('extractOperators', () => {
  test('the order service and the reporting script, each with its own operators', () => {
    const ops = byOp(extractOperators(docs));
    expect(ops.$inc).toEqual(['order-service']);
    expect(ops.$push).toEqual(['order-service']);
    expect(ops.$lookup).toEqual(['nightly-report']);
    expect(ops.$sort).toEqual(['nightly-report', 'order-service']);
  });

  test('finds operators the static code scan misses (built at run time)', async () => {
    const code = new Set((await scanOperators(['app/**/*.mjs'])).map((r) => r.op));
    const app = extractOperators(docs).filter((r) => r.clients.includes('order-service')).map((r) => r.op);
    expect(app.filter((op) => !code.has(op)).sort()).toEqual(['$gte', '$lt']);
  });

  test('skips command metadata, field paths, getMore and inserted documents', () => {
    const rows = extractOperators([
      { op: 'command', appName: 'a', command: { aggregate: 'x', pipeline: [{ $project: { v: '$lines.qty' } }], $db: 'telco', $readPreference: { mode: 'primary' } } },
      { op: 'getmore', appName: 'a', command: { getMore: 1, collection: 'x' }, originatingCommand: { filter: { $nor: [] } } },
      { op: 'insert', appName: 'a', command: { insert: 'x', documents: [{ $weird: 1 }] } },
      { op: 'update', appName: 'a', command: { q: { 'top.sku': 's' }, u: { $inc: { 'top.$.units': 1 } } } },
    ]);
    expect(rows).toEqual([{ op: '$inc', clients: ['a'] }, { op: '$project', clients: ['a'] }]);
  });
});

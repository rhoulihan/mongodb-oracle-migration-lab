// Pure parts of the D4 stand-in replicator: type repair on the way back to
// MongoDB, the _id text the capture trigger records, the stored form both
// sides are hashed in, and the "caught up" test. No stack needed.
import { describe, expect, test } from 'vitest';
import { BSONRegExp, Decimal128, Int32, Long, ObjectId, Timestamp } from 'mongodb';
import { asStored, caughtUp, idFromOracle, LABEL, log, restoreTypes } from '../../replicator/apply.mjs';
import { canonical } from '../../lib/compare.mjs';

describe('restoreTypes: tagged sub-documents from the Oracle API become BSON types again', () => {
  test('a {$timestamp} sub-document becomes a Timestamp, nested in arrays too', () => {
    const doc = { _id: 1, ts: { $timestamp: { t: new Int32(1775260874), i: new Int32(1) } },
      list: [{ at: { $timestamp: { t: 5, i: 2 } } }] };
    const out = restoreTypes(doc);
    expect(out.ts).toBeInstanceOf(Timestamp);
    expect(out.ts.t).toBe(1775260874);
    expect(out.ts.i).toBe(1);
    expect(out.list[0].at).toBeInstanceOf(Timestamp);
  });

  test('a {$regularExpression} sub-document becomes a BSONRegExp', () => {
    const out = restoreTypes({ p: { $regularExpression: { pattern: '^sku-[0-9]+$', options: 'i' } } });
    expect(out.p).toBeInstanceOf(BSONRegExp);
    expect(out.p.pattern).toBe('^sku-[0-9]+$');
    expect(out.p.options).toBe('i');
  });

  test('everything else keeps its type', () => {
    const id = new ObjectId();
    const doc = { _id: id, v: Long.fromNumber(2), q: new Int32(3), d: new Date(0), total: Decimal128.fromString('19.5'),
      other: { $timestamp: 1, extra: true } };
    expect(canonical(restoreTypes(doc))).toBe(canonical(doc));
  });
});

describe('asStored: the form the Oracle API stores, used to hash both sides', () => {
  test('Decimal128 loses trailing zeros after the point, as the Oracle API stores it', () => {
    const out = asStored({ a: Decimal128.fromString('19.00'), b: Decimal128.fromString('20.10'),
      c: Decimal128.fromString('1200'), d: Decimal128.fromString('0.50'), e: Decimal128.fromString('-3.0') });
    expect([out.a, out.b, out.c, out.d, out.e].map(String)).toEqual(['19', '20.1', '1200', '0.5', '-3']);
    expect(out.a).toBeInstanceOf(Decimal128);
  });

  test('a source document and its Oracle read-back hash the same', () => {
    const src = { _id: new ObjectId('69d054ca0000000000037454'), total: Decimal128.fromString('19.00'),
      ts: new Timestamp({ t: 1775260874, i: 1 }), p: new BSONRegExp('^a$', 'i'), q: new Int32(2) };
    const ora = { _id: src._id, total: Decimal128.fromString('19'),
      ts: { $timestamp: { t: new Int32(1775260874), i: new Int32(1) } },
      p: { $regularExpression: { pattern: '^a$', options: 'i' } }, q: new Int32(2) };
    expect(canonical(asStored(src))).toBe(canonical(asStored(ora)));
  });

  test('a real difference still shows', () => {
    const a = { _id: 1, total: Decimal128.fromString('19.00'), q: new Int32(2) };
    expect(canonical(asStored(a))).not.toBe(canonical(asStored({ ...a, total: Decimal128.fromString('19.01') })));
    expect(canonical(asStored(a))).not.toBe(canonical(asStored({ ...a, q: Long.fromNumber(2) })));
  });
});

describe('idFromOracle: the _id text mig_changelog records (JSON_SERIALIZE ... EXTENDED)', () => {
  test('ObjectId, string, Int32, Int64 and sub-document ids', () => {
    expect(idFromOracle('{"$rawid":"6ae6d9c5e6fcc3aad046c540"}')).toEqual(new ObjectId('6ae6d9c5e6fcc3aad046c540'));
    expect(idFromOracle('"S008876"')).toBe('S008876');
    expect(idFromOracle('{"$numberInt":7}')).toEqual(new Int32(7));
    expect(idFromOracle('{"$numberLong":5}')).toEqual(Long.fromNumber(5));
    expect(idFromOracle('{"a":{"$numberInt":1}}')).toEqual({ a: new Int32(1) });
  });

  test('an id it cannot map is an error, never a guess', () => {
    expect(() => idFromOracle('{"$oracleTimestampTZ":"2026-11-01T06:13:55Z"}')).toThrow(/cannot map/);
  });
});

describe('caughtUp: idle for a while after the last write', () => {
  const now = 10_000;
  test('idle since before the write, status written well after it: caught up', () => {
    expect(caughtUp({ state: 'running', lagMs: 0, idleSince: 8_000, updatedAt: 9_900 }, 9_000, now)).toBe(true);
  });
  test('busy, or the last idle check too close to the write: not yet', () => {
    expect(caughtUp({ state: 'running', lagMs: 120, idleSince: null, updatedAt: 9_900 }, 9_000, now)).toBe(false);
    expect(caughtUp({ state: 'running', lagMs: 0, idleSince: 8_000, updatedAt: 9_300 }, 9_000, now)).toBe(false);
  });
  test('a stale status (replicator gone) is never caught up', () => {
    expect(caughtUp({ state: 'running', lagMs: 0, idleSince: 1_000, updatedAt: 2_000 }, 1_500, now)).toBe(false);
  });
});

describe('the label', () => {
  test('every log line starts with [stand-in for Oracle GoldenGate]', () => {
    expect(LABEL).toBe('[stand-in for Oracle GoldenGate]');
    const lines = [];
    log('forward: applied 3 changes', (l) => lines.push(l));
    expect(lines).toEqual(['[stand-in for Oracle GoldenGate] forward: applied 3 changes']);
  });
});

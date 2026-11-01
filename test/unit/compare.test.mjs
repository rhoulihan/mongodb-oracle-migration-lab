import { describe, expect, test } from 'vitest';
import { Decimal128, Long, ObjectId } from 'mongodb';
import { canonical, hashDocs, sameDocs } from '../../lib/compare.mjs';

describe('compare', () => {
  test('canonical is key-order independent', () => {
    const a = { _id: 1, b: { y: 2, x: [{ q: 1, p: 2 }] }, a: Decimal128.fromString('1.50') };
    const b = { a: Decimal128.fromString('1.50'), b: { x: [{ p: 2, q: 1 }], y: 2 }, _id: 1 };
    expect(canonical(a)).toBe(canonical(b));
  });

  test('canonical keeps BSON types and array order', () => {
    expect(canonical({ v: Long.fromNumber(5) })).not.toBe(canonical({ v: 5 }));
    expect(canonical({ v: [1, 2] })).not.toBe(canonical({ v: [2, 1] }));
    expect(canonical({ v: Long.fromNumber(5) })).toContain('$numberLong');
  });

  test('sameDocs reports the first differing _id', () => {
    const id1 = new ObjectId('000000000000000000000001');
    const id2 = new ObjectId('000000000000000000000002');
    const id3 = new ObjectId('000000000000000000000003');
    const a = [{ _id: id3, n: 3 }, { _id: id1, n: 1 }, { _id: id2, n: 2 }];
    const b = [{ _id: id1, n: 1 }, { _id: id2, n: 20 }, { _id: id3, n: 30 }];
    expect(sameDocs(a, [...a].reverse())).toEqual({ equal: true });
    const r = sameDocs(a, b);
    expect(r.equal).toBe(false);
    expect(r.diff).toContain(id2.toHexString());
    expect(r.diff).not.toContain(id3.toHexString());
  });

  test('sameDocs reports a missing document', () => {
    const r = sameDocs([{ _id: 'A' }, { _id: 'B' }], [{ _id: 'A' }]);
    expect(r.equal).toBe(false);
    expect(r.diff).toContain('B');
  });

  test('hashDocs ignores input order and sees content', () => {
    const a = [{ _id: 'A', n: 1 }, { _id: 'B', n: 2 }];
    expect(hashDocs(a)).toBe(hashDocs([...a].reverse()));
    expect(hashDocs(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDocs(a)).not.toBe(hashDocs([{ _id: 'A', n: 1 }, { _id: 'B', n: 3 }]));
  });
});

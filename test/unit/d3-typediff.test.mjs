// D3 helpers that need no stack: the BSON type census walker and the
// mongodump archive reader (on a hand-built archive).
import { describe, expect, test } from 'vitest';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { BSON, BSONRegExp, Decimal128, Int32, Long, Timestamp } from 'mongodb';
import { bsonType, formatTypeDiff, walk } from '../../demos/d3-dump-restore/typediff.mjs';
import { readArchive } from '../../demos/d3-dump-restore/archive.mjs';

describe('bsonType and walk', () => {
  test('wrapper classes map to $type aliases', () => {
    expect([new Int32(1), Long.fromNumber(1), Decimal128.fromString('1.10'), new Timestamp({ t: 1, i: 1 }),
      new BSONRegExp('^a', ''), new Date(0), 'x', true, null, [], {}].map(bsonType))
      .toEqual(['int', 'long', 'decimal', 'timestamp', 'regex', 'date', 'string', 'bool', 'null', 'array', 'object']);
  });

  test('array elements share the array path; $-keyed wrappers are not walked into', () => {
    const seen = [];
    walk({ a: [{ b: new Int32(1) }, { b: 'x' }], ts: { $timestamp: { t: 1, i: 1 } } }, (p, t) => seen.push(`${p}:${t}`));
    expect(seen).toEqual(['a:array', 'a:object', 'a.b:int', 'a:object', 'a.b:string', 'ts:object']);
  });

  test('formatTypeDiff prints rejected queries and value checks', () => {
    const text = formatTypeDiff([
      { kind: 'type', coll: 'catalog', path: 'skuPattern', srcTypes: ['regex'], dstTypes: ['object'],
        queryCheck: { filter: { skuPattern: { $type: 'regex' } }, srcCount: 3, dstCount: 'rejected' } },
      { kind: 'value', coll: 'catalog', path: 'price', check: 'decimal scale', ok: false, changed: 1, of: 3,
        example: { src: '93.00', dst: '93' } },
    ]);
    expect(text).toMatch(/catalog\s+skuPattern\s+regex\s+object\s+\{skuPattern:\{\$type:"regex"\}\}\s+3\s+rejected/);
    expect(text).toMatch(/1 of 3 values changed \(93\.00 reads back as 93\)/);
  });
});

describe('readArchive', () => {
  const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const doc = (d) => Buffer.from(BSON.serialize(d));
  const now = Date.now();
  const metadata = (indexes) => BSON.EJSON.stringify({ indexes }, { relaxed: false });
  const archive = Buffer.concat([
    int32(0x8199e26d | 0),
    doc({ concurrent_collections: 4, version: '0.1' }),
    doc({ db: 'telco', collection: 'carts', metadata: metadata([{ v: 2, key: { updatedAt: 1 }, name: 'ttl', expireAfterSeconds: 120 }]) }),
    doc({ db: 'telco', collection: 'regions', metadata: metadata([]) }),
    int32(-1),
    doc({ db: 'telco', collection: 'carts', EOF: false, CRC: Long.fromNumber(0) }),
    doc({ _id: 'c1', updatedAt: new Date(now - 200_000) }), // expired
    doc({ _id: 'c2', updatedAt: new Date(now) }), // live for 120 s
    int32(-1),
    doc({ db: 'telco', collection: 'regions', EOF: false, CRC: Long.fromNumber(0) }),
    doc({ _id: 'R01' }),
    int32(-1),
    doc({ db: 'telco', collection: 'carts', EOF: true, CRC: Long.fromNumber(0) }),
    int32(-1),
    doc({ db: 'telco', collection: 'regions', EOF: true, CRC: Long.fromNumber(0) }),
    int32(-1),
  ]);

  test('counts per namespace and reads TTL deadlines from the metadata', async () => {
    const m = await readArchive(Readable.from([gzipSync(archive)]));
    expect(m.get('telco.regions')).toEqual({ count: 1, ttl: null, deadlines: null });
    const carts = m.get('telco.carts');
    expect(carts.count).toBe(2);
    expect(carts.ttl).toEqual({ field: 'updatedAt', seconds: 120 });
    expect(carts.deadlines.filter((d) => d > now)).toHaveLength(1);
  });

  test('rejects a file that is not an archive', async () => {
    await expect(readArchive(Readable.from([Buffer.from('nope')]), { gzip: false })).rejects.toThrow(/magic/);
  });
});

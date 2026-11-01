// D6: one question, asked two ways.
//   "Top 5 subscribers by spend per region and plan tier, over the last 90
//    days, with plan name." It spans orders, subscribers, accounts and catalog.
//
// pipeline  the aggregation a MongoDB developer writes: three $lookup joins,
//           $unwind of the order lines, $group per subscriber, then a rank.
//           It runs unchanged on the MongoDB source and on Oracle through the
//           Oracle API for MongoDB.
// sqlText   the same question in SQL (top-spenders.sql, also read by the
//           mongosh script sql-stage.js): a CTE over the JSON collections,
//           JSON_TABLE for the lines, ordinary joins, RANK() and json{...} for
//           the output shape. It runs through the MongoDB API as a $sql stage.
//
// Definitions both sides share, so the answers can be equal:
//   window   placedAt in [ANCHOR - 90 days, ANCHOR): the last 90 days of the
//            generated data (gen/model.mjs), never the wall clock, so orders
//            placed live by other demos never move it. Bound, not inlined.
//   region   and tier come from the subscriber's account (not the copies
//            embedded in each order).
//   spend    sum of qty * price over the window's order lines (Decimal128).
//   plan     name of the plan on the subscriber's latest order in the window
//            that has a plan line (latest by placedAt, then order _id); null
//            when none of their orders in the window has one.
//   rank     1..5 by spend descending, ties broken by subscriber id
//            ascending, so RANK() and the pipeline's position agree exactly.
//
// The rank. $setWindowFields is the natural MongoDB stage, but the Oracle API
// for MongoDB rejects it ("Aggregate stage $setWindowFields not supported",
// 26ai Free, docs/spikes/d6-ratio.md), and MongoDB's $rank takes a single
// sort key, so it cannot break ties by subscriber id. The portable pipeline
// ranks with $topN (spend desc, subscriber id asc) and $unwind's array index.
import { readFileSync } from 'node:fs';
import { Decimal128 } from 'mongodb';
import { ANCHOR } from '../../gen/model.mjs';

const DAY = 86_400_000;
export const WINDOW = Object.freeze({ fromTs: new Date(ANCHOR.getTime() - 90 * DAY), toTs: ANCHOR });

export const sqlText = readFileSync(new URL('./top-spenders.sql', import.meta.url), 'utf8').trim();

/** The $sql stage (object form, named binds: it is the pipeline's only stage). */
export const sqlStage = () => ({ $sql: { statement: sqlText, binds: { fromTs: WINDOW.fromTs, toTs: WINDOW.toTs } } });

const joined = [
  { $match: { placedAt: { $gte: WINDOW.fromTs, $lt: WINDOW.toTs } } },
  { $lookup: { from: 'subscribers', localField: 'subscriber.id', foreignField: '_id', as: 'sub' } },
  { $unwind: '$sub' },
  { $lookup: { from: 'accounts', localField: 'sub.accountId', foreignField: '_id', as: 'acct' } },
  { $unwind: '$acct' },
  { $unwind: '$lines' },
  { $lookup: { from: 'catalog', localField: 'lines.sku', foreignField: '_id', as: 'item' } },
  { $unwind: '$item' },
  { $set: { isPlan: { $cond: [{ $eq: ['$item.kind', 'plan'] }, 1, 0] } } },
  {
    $group: {
      _id: { region: '$acct.region', tier: '$acct.tier', subscriberId: '$sub._id' },
      name: { $first: '$sub.name' },
      spend: { $sum: { $multiply: ['$lines.qty', '$lines.price'] } },
      // Plan lines sort first, then the latest order: the latest plan bought.
      plan: {
        $top: {
          sortBy: { isPlan: -1, placedAt: -1, _id: -1 },
          output: { $cond: [{ $eq: ['$isPlan', 1] }, '$item.name', null] },
        },
      },
    },
  },
];

export const pipeline = [
  ...joined,
  {
    $group: {
      _id: { region: '$_id.region', tier: '$_id.tier' },
      top: {
        $topN: {
          n: 5,
          sortBy: { spend: -1, '_id.subscriberId': 1 },
          output: { subscriberId: '$_id.subscriberId', name: '$name', plan: '$plan', spend: '$spend' },
        },
      },
    },
  },
  { $unwind: { path: '$top', includeArrayIndex: 'i' } },
  {
    $project: {
      _id: 0, region: '$_id.region', tier: '$_id.tier', rank: { $add: ['$i', 1] },
      subscriberId: '$top.subscriberId', name: '$top.name', plan: '$top.plan', spend: '$top.spend',
    },
  },
  { $sort: { region: 1, tier: 1, rank: 1 } },
];

/** The same question with the natural $setWindowFields rank (the API rejects it; kept as the pinned finding). */
export const nativeRankPipeline = [
  ...joined,
  { $setWindowFields: { partitionBy: { region: '$_id.region', tier: '$_id.tier' }, sortBy: { spend: -1 }, output: { rank: { $rank: {} } } } },
  { $match: { rank: { $lte: 5 } } },
];

/**
 * Ruling K, made explicit: the Oracle API stores Decimal128 as an Oracle
 * NUMBER, which keeps the value but not the trailing zeros ("9718.80" comes
 * back as "9718.8"). Before comparing, put every spend at exactly 2 decimals.
 * Exact string arithmetic, no floating point; anything that is not a
 * Decimal128 with at most 2 decimals is an error, not something to round.
 */
export function atCents(doc) {
  const s = doc.spend;
  if (s?._bsontype !== 'Decimal128') throw new Error(`spend is ${s?._bsontype ?? typeof s}, expected Decimal128`);
  const m = s.toString().match(/^(-?\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error(`spend ${s} is not a plain decimal`);
  const frac = m[2] ?? '';
  if (frac.length > 2) throw new Error(`spend ${s} has more than 2 decimals`);
  return { ...doc, spend: Decimal128.fromString(`${m[1]}.${frac.padEnd(2, '0')}`) };
}

/** True when a doc's spend scale changes under atCents (counted for the slide). */
export const scaleChanged = (doc) => doc.spend.toString() !== atCents(doc).spend.toString();

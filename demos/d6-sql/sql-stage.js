// D6 step 4, run with: ./lab.sh mongosh ora demos/d6-sql/sql-stage.js
// The question as SQL, sent from mongosh through the Oracle API for MongoDB
// in one $sql stage. The SQL text is top-spenders.sql, next to this file
// (the demo and the tests read the same file). The window is the last 90
// days of the generated data, bound as two dates.
const fs = require('fs');
const path = require('path');

const statement = fs.readFileSync(path.join(__dirname, 'top-spenders.sql'), 'utf8').trim();
const binds = {
  fromTs: new Date('2026-07-03T00:00:00.000Z'),
  toTs: new Date('2026-10-01T00:00:00.000Z'),
};

// Timed in this session: one run, then the median of 3 more (warm, like the
// console's own median of 7).
const run = () => db.aggregate([{ $sql: { statement, binds } }]).toArray();
let t0 = Date.now();
let rows = run();
const firstMs = Date.now() - t0;
const ms = [];
for (let i = 0; i < 3; i++) { t0 = Date.now(); rows = run(); ms.push(Date.now() - t0); }
const median = ms.slice().sort((a, b) => a - b)[1];

print(`$sql returned ${rows.length} rows (top 5 per region and tier) in ${(median / 1000).toFixed(2)} s`);
print(`  timed here: median of 3 runs (${ms.join(', ')} ms) after a first run of ${firstMs} ms`);
print('First 10:');
print('region  tier      rank  subscriber  name              plan              spend');
for (const r of rows.slice(0, 10)) {
  print([
    r.region.padEnd(6), r.tier.padEnd(8), String(r.rank).padStart(4), r.subscriberId.padEnd(10),
    r.name.padEnd(16), String(r.plan ?? '-').padEnd(16), r.spend.toString().padStart(9),
  ].join('  '));
}

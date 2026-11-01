// The session run sheet as data (docs/REHEARSAL.md is the presenter's copy).
// The full-run smoke test and scripts/record-clips.mjs both walk it, so the
// test proves exactly what the run sheet tells the presenter to do.
//
//   before   ./lab.sh commands run once, before D1 (a fresh lab and data
//            generated no more than 30 minutes before the session: carts
//            expire, Ruling R)
//   demos    session order; `after` holds the ./lab.sh commands the
//            presenter runs once the demo is over, before the next one
export const BEFORE = [['reset'], ['generate']];

export const SESSION = [
  { id: 'd1', after: [] },
  // D2 leaves the order service in age-out mode and the entities in MIG;
  // D3 starts from an empty MIG with the service on MongoDB.
  { id: 'd2', after: [['reset', 'd2']] },
  // No reset: D4's first step reloads Oracle from a fresh dump.
  { id: 'd3', after: [] },
  // Stops the replicator, drops the capture objects, app back on MongoDB.
  { id: 'd4', after: [['reset', 'd4']] },
  { id: 'd5', after: [] },
  { id: 'd6', after: [] },
  { id: 'd7', after: [] },
];

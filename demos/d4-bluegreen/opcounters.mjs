// serverStatus opcounters on the MongoDB source (blue): the method of
// mongotools' mongoserverStatus.sh (github.com/oramatt/mongotools). D4 reads
// them around the cutover: writes while the app is on blue, none after the
// flip, and only the reverse replicator's writes once the fallback runs.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** {insert, update, delete} from serverStatus, as numbers. */
export async function opcounters(db) {
  const { opcounters: o } = await db.admin().command({ serverStatus: 1 });
  return { insert: Number(o.insert), update: Number(o.update), delete: Number(o.delete) };
}

/** b - a, per counter. */
export const delta = (a, b) => ({ insert: b.insert - a.insert, update: b.update - a.update, delete: b.delete - a.delete });

/** The counters' change over `ms` of quiet. */
export async function sample(db, ms) {
  const a = await opcounters(db);
  await sleep(ms);
  return delta(a, await opcounters(db));
}

export const writesLine = (d) => `+${d.insert} inserts, +${d.update} updates, +${d.delete} deletes`;

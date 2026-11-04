// D2 entity-only migration (Strategy A): copy the long-lived collections
// (regions, catalog, accounts, subscribers) from the MongoDB source to Oracle
// with mongodump and mongorestore. Orders stay in MongoDB as the read-only
// archive; carts and the event log stay too and expire there on their own, so
// they never need moving.
//
// mongodump has no --nsInclude, so the dump leaves out the collections that
// stay put (--excludeCollection), and the restore names exactly what moves
// (--nsInclude per entity). The restore runs as MIG into the collections
// prepareTarget pre-created (never implicit creation), with no database in the
// URI path: `/MIG` restores 0 documents and still exits 0 (Ruling Q), so zero
// restored documents is an error here.
import { config } from '../../lib/config.mjs';
import { runTool } from '../../lib/tools.mjs';

export const ENTITIES = ['regions', 'catalog', 'accounts', 'subscribers'];
/** What stays in MongoDB: the order archive, short-lived data, the order-derived Top-N. */
export const STAY = ['orders', 'carts', 'orderEvents', 'regionTopDevices'];
export const DUMP = '/dumps/d2-entities.archive';
const SRC_DB = 'telco';

const dumpArgs = () => ['mongodump', '--uri', config.toolSrcUri, `--archive=${DUMP}`, '--gzip', '--db', SRC_DB,
  ...STAY.flatMap((c) => ['--excludeCollection', c])];
const restoreArgs = () => ['mongorestore', `--archive=${DUMP}`, '--gzip',
  ...ENTITIES.flatMap((c) => ['--nsInclude', `${SRC_DB}.${c}`]),
  '--nsFrom', `${SRC_DB}.*`, '--nsTo', 'MIG.*', '--uri', config.toolOraUri];

// What the presenter types: lab.sh runs migrateEntities() in the runner, so the
// password never appears in the command, the slide or the console.
export const MIGRATE_CMD = './lab.sh migrate-entities';

const tail = (s, n = 3) => s.trim().split('\n').slice(-n).join(' | ');

/**
 * Dump the four entity collections and restore them into the pre-created,
 * empty MIG collections. Throws on any failure, a zero count, or a restore
 * that had to create a collection.
 * @param {{verbose?: boolean, onStderr?: (chunk: Buffer) => void, onCommand?: (argv: string[]) => void, pauseMs?: number}} [opts]
 *   verbose adds the tools' --verbose; onStderr streams their log and onCommand
 *   sees each command before it runs (the CLI prints both); pauseMs waits between
 *   the dump and the restore
 * @returns {Promise<{coll:string, count:number}[]>} restored documents per entity, in ENTITIES order
 */
export async function migrateEntities({ verbose = false, onStderr, onCommand, pauseMs = 0 } = {}) {
  const v = verbose ? ['--verbose'] : [];
  const dump = [...dumpArgs(), ...v], restore = [...restoreArgs(), ...v];
  onCommand?.(dump);
  const d = await runTool(dump, { onStderr });
  if (d.code !== 0) throw new Error(`mongodump failed: ${tail(d.stderr)}`);
  if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
  onCommand?.(restore);
  const r = await runTool(restore, { onStderr });
  if (r.code !== 0) throw new Error(`mongorestore failed: ${tail(r.stderr)}`);
  if (/creating collection/i.test(r.stderr)) throw new Error('mongorestore created a collection: the target was not pre-created');
  const done = new Map([...r.stderr.matchAll(/finished restoring `MIG\.(\w+)` \((\d+) documents?, (\d+) failures?\)/g)]
    .map((x) => [x[1], { count: Number(x[2]), failures: Number(x[3]) }]));
  const extra = [...done.keys()].filter((c) => !ENTITIES.includes(c));
  if (extra.length) throw new Error(`mongorestore restored more than the entities: ${extra.join(', ')}`);
  return ENTITIES.map((coll) => {
    const x = done.get(coll);
    // Ruling Q: zero restored documents is a failure, never a success.
    if (!x || x.count === 0) throw new Error(`mongorestore restored 0 documents into MIG.${coll}: ${tail(r.stderr)}`);
    if (x.failures) throw new Error(`mongorestore: ${x.failures} documents failed for MIG.${coll}`);
    return { coll, count: x.count };
  });
}

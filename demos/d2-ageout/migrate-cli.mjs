// `./lab.sh migrate-entities` (D2 step 1, what the presenter types): the same
// entity-only dump and restore the step runs in-process (migrate-entities.mjs),
// in the runner container, with the MIG password from MIG_PASSWORD. It
// restores into the collections the D2 reset pre-created.
import { migrateEntities, STAY } from './migrate-entities.mjs';

try {
  for (const r of await migrateEntities()) console.log(`restored MIG.${r.coll}: ${r.count} documents`);
  console.log(`left in MongoDB: ${STAY.join(', ')}`);
} catch (err) {
  console.error(`migrate-entities: ${err.message} (run ./lab.sh reset d2, then try again)`);
  process.exit(1);
}

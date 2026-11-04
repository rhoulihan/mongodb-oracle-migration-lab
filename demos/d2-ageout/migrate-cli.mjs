// `./lab.sh migrate-entities` (D2 step 1, what the presenter types): the same
// entity-only dump and restore the step runs in-process (migrate-entities.mjs),
// in the runner container, with the MIG password from MIG_PASSWORD. It
// restores into the collections the D2 reset pre-created.
import { migrateEntities, STAY } from './migrate-entities.mjs';

// The audience watches mongodump and mongorestore work: each command, then its
// verbose log, live, without the tools' timestamps. The password in a URI shows
// as ****.
const TS = /^\d{4}-\d\d-\d\dT[\d:.]+[+-]\d{4}\s+/;
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a}'`);
const mask = (a) => a.replace(/(mongodb:\/\/[^:/@]+:)[^@]*@/, '$1****@');
let partial = '';
const onStderr = (d) => {
  const lines = (partial + d).split('\n');
  partial = lines.pop();
  for (const l of lines) process.stdout.write(l.replace(TS, '') + '\n');
};
const onCommand = (argv) => {
  if (partial) onStderr('\n');
  console.log(`\n$ ${argv.map((a) => quote(mask(a))).join(' ')}\n`);
};

try {
  const rows = await migrateEntities({ verbose: true, onStderr, onCommand, pauseMs: 3000 });
  if (partial) onStderr('\n');
  console.log('');
  for (const r of rows) console.log(`restored MIG.${r.coll}: ${r.count} documents`);
  console.log(`left in MongoDB: ${STAY.join(', ')}`);
} catch (err) {
  console.error(`migrate-entities: ${err.message} (run ./lab.sh reset d2, then try again)`);
  process.exit(1);
}

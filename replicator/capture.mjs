// The Oracle side of D4's reverse capture: install and drop the objects in
// oracle/sql/d4-changelog.sql, and register the forward applier's MongoDB
// session so the capture triggers skip its writes (loop prevention; the why
// is in the SQL file's header).
import { readFileSync } from 'node:fs';
import { COLLECTIONS } from '../oracle/prep.mjs';

const SQL_FILE = new URL('../oracle/sql/d4-changelog.sql', import.meta.url);
export const CAPTURE_STATEMENTS = readFileSync(SQL_FILE, 'utf8')
  .split(/^\/\s*$/m)
  .map((s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
  .filter(Boolean);

export const triggerName = (coll) => `MIG_CAP_${coll.toUpperCase()}`;

/** Create mig_repl_session, mig_changelog and one capture trigger per collection. */
export async function installCapture(conn) {
  for (const s of CAPTURE_STATEMENTS) await conn.execute(s);
  await conn.commit();
  const r = await conn.execute(
    "select trigger_name from user_triggers where trigger_name like 'MIG\\_CAP\\_%' escape '\\' and status = 'ENABLED'");
  const have = new Set(r.rows.map(([n]) => n));
  const missing = COLLECTIONS.filter((c) => !have.has(triggerName(c)));
  const errs = await conn.execute(
    "select name, line, text from user_errors where name like 'MIG\\_CAP\\_%' escape '\\' order by name, sequence");
  if (missing.length || errs.rows.length) {
    throw new Error(`capture triggers not installed: missing ${missing.join(', ') || 'none'}; ` +
      `errors ${errs.rows.map(([n, l, t]) => `${n}:${l} ${t}`).join('; ') || 'none'}`);
  }
}

/** Drop the triggers first (a trigger left on a dropped table breaks every write), then the tables. */
export async function dropCapture(conn) {
  for (const c of COLLECTIONS) await conn.execute(`DROP TRIGGER IF EXISTS ${triggerName(c)}`);
  await conn.execute('DROP TABLE IF EXISTS mig_changelog PURGE');
  await conn.execute('DROP TABLE IF EXISTS mig_repl_session PURGE');
}

/** True when mig_changelog exists and every collection has its enabled trigger. */
export async function captureInstalled(conn) {
  const r = await conn.execute(`select
      (select count(*) from user_tables where table_name in ('MIG_CHANGELOG', 'MIG_REPL_SESSION')),
      (select count(*) from user_triggers where trigger_name like 'MIG\\_CAP\\_%' escape '\\' and status = 'ENABLED')
    from dual`);
  const [tables, triggers] = r.rows[0].map(Number);
  return tables === 2 && triggers === COLLECTIONS.length;
}

/** The forward applier's session becomes the only registered one. */
export async function registerSession(conn, lsid, direction = 'fwd') {
  await conn.execute('DELETE FROM mig_repl_session');
  await conn.execute('INSERT INTO mig_repl_session (lsid, direction) VALUES (:lsid, :direction)', { lsid, direction });
  await conn.commit();
}

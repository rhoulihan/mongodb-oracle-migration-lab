// Oracle target prep, shared by demos 2, 3 and 4. Creates the MIG-owned JSON
// collection tables from oracle/sql/00-target-prep.sql (dropping them first
// when asked) and confirms MIG is ORDS-enabled. Idempotent.
//
// Every collection is created in SQL, never through the MongoDB API, so the
// target schema never depends on implicit creation by a first write.
// Indexes are not created here: mongorestore carries them over.
import { readFileSync } from 'node:fs';
import { oraSql } from '../lib/db.mjs';

const SQL_FILE = new URL('./sql/00-target-prep.sql', import.meta.url);

/** The CREATE statements in the prep file, comments and blank lines removed. */
export const CREATE_STATEMENTS = readFileSync(SQL_FILE, 'utf8')
  .split('\n')
  .map((line) => line.replace(/--.*$/, '').trim())
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

/** Collection names, exactly as the MongoDB API sees them (case-sensitive). */
export const COLLECTIONS = CREATE_STATEMENTS.map((s) => {
  const m = s.match(/^CREATE JSON COLLECTION TABLE IF NOT EXISTS "([A-Za-z]+)"$/);
  if (!m) throw new Error(`00-target-prep.sql: unexpected statement: ${s}`);
  return m[1];
});

/**
 * @param {{drop?: boolean}} opts drop: true drops and recreates every table (empty target)
 * @returns {Promise<void>}
 */
export async function prepareTarget({ drop = false } = {}) {
  const conn = await oraSql();
  if (drop) {
    for (const name of COLLECTIONS) await conn.execute(`DROP TABLE IF EXISTS "${name}" PURGE`);
  }
  for (const stmt of CREATE_STATEMENTS) await conn.execute(stmt);

  const ords = await conn.execute("select status from user_ords_schemas where parsing_schema = 'MIG'");
  if (ords.rows[0]?.[0] !== 'ENABLED') {
    throw new Error('MIG is not ORDS-enabled: restart the oracle container or run docker/oracle/init/02-ords-enable.sql');
  }
}

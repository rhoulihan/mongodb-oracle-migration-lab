// Measurement helpers behind the on-screen proof:
//   redoBytes     redo one SQL session generates while a unit of work runs
//   sysRedoBytes  redo the whole instance generates while a unit of work runs
//                 (D5: Mongo API writes run in ORDS sessions, Ruling S)
//   timeMedian    median of repeated runs, after warmups (D6, relative timing only)
//   sqlPlan       DBMS_XPLAN plan of the last execution of one SQL statement (D3, D6)
//   mongoExplain  condensed winning plan from the MongoDB source or the Oracle
//                 API for MongoDB, as indented text (D3, D6)
// MIG needs SELECT on v_$mystat, v_$sysstat, v_$statname, v_$session, v_$sql, v_$sql_plan and
// v_$sql_plan_statistics_all (docker/oracle/init/01-grants.sql).
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BSON } from 'mongodb';

const REDO_SQL =
  "select m.value from v$mystat m join v$statname n on n.statistic# = m.statistic# where n.name = 'redo size'";

async function sessionRedo(conn) {
  const r = await conn.execute(REDO_SQL);
  return Number(r.rows[0][0]);
}

/**
 * Redo bytes this session writes while fn runs (the v$mystat 'redo size' delta).
 * fn should commit its own work if the commit's redo is meant to count.
 * @param {import('oracledb').Connection} conn
 * @param {(conn) => Promise<any>} fn
 * @returns {Promise<{redo:number, result:any}>}
 */
export async function redoBytes(conn, fn) {
  const before = await sessionRedo(conn);
  const result = await fn(conn);
  const after = await sessionRedo(conn);
  return { redo: after - before, result };
}

const SYS_REDO_SQL = "select value from v$sysstat where name = 'redo size'";

async function systemRedo(conn) {
  const r = await conn.execute(SYS_REDO_SQL);
  return Number(r.rows[0][0]);
}

/**
 * Redo bytes the whole instance writes while fn runs (the v$sysstat 'redo
 * size' delta). Unlike redoBytes it sees writes made in other sessions, such
 * as the ORDS sessions behind the Oracle API for MongoDB. It also sees any
 * background redo, so measure on a quiet stack, in batches, and take a median.
 * @param {import('oracledb').Connection} conn any MIG session (used only to read the counter)
 * @param {() => Promise<any>} fn
 * @returns {Promise<{redo:number, result:any}>}
 */
export async function sysRedoBytes(conn, fn) {
  const before = await systemRedo(conn);
  const result = await fn();
  const after = await systemRedo(conn);
  return { redo: after - before, result };
}

/**
 * Run fn `warmup` times untimed, then `runs` times timed.
 * @param {() => any} fn
 * @param {{runs?:number, warmup?:number}} opts
 * @returns {Promise<{medianMs:number, runsMs:number[]}>}
 */
export async function timeMedian(fn, { runs = 7, warmup = 2 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const runsMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    runsMs.push(performance.now() - t0);
  }
  const s = [...runsMs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const medianMs = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { medianMs, runsMs };
}

/**
 * Execute sql once with a unique tag comment (fetching at most one row), find
 * that cursor in v$sql, and
 * return DBMS_XPLAN.DISPLAY_CURSOR('BASIC +ROWS +PREDICATE') for it.
 * @param {import('oracledb').Connection} conn
 * @param {string} sql
 * @param {object|any[]} [binds]
 * @returns {Promise<string>}
 */
export async function sqlPlan(conn, sql, binds = {}) {
  const tag = `measure:${randomBytes(6).toString('hex')}`;
  // One row is enough to execute the statement and get its plan.
  await conn.execute(`/* ${tag} */ ${sql}`, binds, { maxRows: 1 });
  // The tag goes in as a bind, so this lookup never matches its own text.
  const cur = await conn.execute(
    `select sql_id, child_number from v$sql where sql_text like :pat
      order by last_active_time desc fetch first 1 row only`,
    { pat: `/* ${tag} */%` },
  );
  if (!cur.rows.length) throw new Error(`sqlPlan: cursor for /* ${tag} */ not found in v$sql`);
  const [sqlId, child] = cur.rows[0];
  const plan = await conn.execute(
    "select plan_table_output from table(dbms_xplan.display_cursor(:id, :child, 'BASIC +ROWS +PREDICATE'))",
    { id: sqlId, child },
  );
  return plan.rows.map((r) => r[0] ?? '').join('\n').trimEnd();
}

/**
 * Explain a find (filter object) or an aggregate (pipeline array) and return
 * the winning plan as indented text, one stage per line, index names inline.
 * Works on the MongoDB source (classic and SBE plans) and on the Oracle API
 * for MongoDB (whose winningPlan is an Oracle execution plan table).
 * @param {import('mongodb').Db} db
 * @param {string} coll
 * @param {object|object[]} pipelineOrFilter
 * @returns {Promise<string>}
 */
export async function mongoExplain(db, coll, pipelineOrFilter) {
  return (await mongoExplainDetail(db, coll, pipelineOrFilter)).plan;
}

/**
 * mongoExplain plus what the console's "Query and SQL" view shows: the query
 * as mongosh would type it, and the SQL the Oracle API generated for it (null
 * on the MongoDB source, which runs it natively).
 * @returns {Promise<{plan:string, table:string|null, query:string, sql:string|null, explain:string|null}>}
 */
export async function mongoExplainDetail(db, coll, pipelineOrFilter) {
  const c = db.collection(coll);
  const explain = Array.isArray(pipelineOrFilter)
    ? await c.aggregate(pipelineOrFilter).explain('queryPlanner')
    : await c.find(pipelineOrFilter).explain('queryPlanner');
  const qp = explain.queryPlanner ?? explain.stages?.find((s) => s.$cursor)?.$cursor?.queryPlanner;
  // table: the Oracle API's plan as the server prints it (a DBMS_XPLAN table),
  // for views that show two Oracle plans in one format; null on MongoDB.
  const table = typeof qp?.winningPlan === 'string' ? qp.winningPlan.trimEnd() : null;
  // explain: on MongoDB (no generated SQL), the explain output itself, for
  // the console's second frame; the stages and their plans, not serverInfo.
  const sql = qp?.generatedSql ?? null;
  const { serverInfo, serverParameters, command, $clusterTime, operationTime, ok, ...shown } = explain;
  const explainText = sql ? null : BSON.EJSON.stringify(shown, { relaxed: true }, 2);
  return { plan: condenseExplain(explain), table, query: queryText(coll, pipelineOrFilter), sql, explain: explainText };
}

/** A find (filter object) or an aggregate (pipeline array) as mongosh would type it. */
export function queryText(coll, pipelineOrFilter) {
  const body = BSON.EJSON.stringify(pipelineOrFilter, { relaxed: true }, 2);
  return `db.${coll}.${Array.isArray(pipelineOrFilter) ? 'aggregate' : 'find'}(${body})`;
}

/** Condense a raw explain document (exported for unit use). */
export function condenseExplain(explain) {
  // A pipeline that is not fully pushed down: a $cursor stage, then the rest.
  if (Array.isArray(explain.stages)) {
    const lines = [];
    for (const stage of explain.stages) {
      const name = Object.keys(stage)[0];
      lines.push(name);
      if (name === '$cursor') {
        for (const l of winningPlanLines(stage.$cursor.queryPlanner)) lines.push('  ' + l);
      }
    }
    return lines.join('\n');
  }
  return winningPlanLines(explain.queryPlanner).join('\n');
}

function winningPlanLines(qp) {
  const wp = qp?.winningPlan;
  if (wp == null) throw new Error('mongoExplain: no queryPlanner.winningPlan in explain output');
  if (typeof wp === 'string') return oraclePlanLines(wp);
  return stageLines(wp.queryPlan ?? wp, 0);
}

// MongoDB stage tree: root first, children indented below it.
function stageLines(node, depth) {
  const label = [node.stage, node.indexName].filter(Boolean).join(' ');
  const lines = ['  '.repeat(depth) + label];
  const kids = [
    node.inputStage,
    ...(node.inputStages ?? []),
    node.outerStage,
    node.innerStage,
  ].filter(Boolean);
  for (const k of kids) lines.push(...stageLines(k, depth + 1));
  return lines;
}

// Oracle plan table: "| * 2 |    INDEX RANGE SCAN | name | ...". The operation
// column carries the tree depth as leading spaces, but the step is not always
// one space, so each distinct indent width becomes one level. Keep operation
// and object name.
function oraclePlanLines(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*\*?\s*\d+\s*\|( *)([^|]*?)\s*\|\s*([^|]*?)\s*\|/);
    if (m) rows.push({ indent: m[1].length, op: m[2], name: m[3] });
  }
  if (!rows.length) return [text.trim()];
  const widths = [...new Set(rows.map((r) => r.indent))].sort((a, b) => a - b);
  return rows.map(
    (r) => '  '.repeat(widths.indexOf(r.indent)) + [r.op, r.name].filter(Boolean).join(' '),
  );
}

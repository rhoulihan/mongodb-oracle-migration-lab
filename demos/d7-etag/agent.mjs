#!/usr/bin/env node
// D7 agent: a customer-care rep who reads an order, changes it and writes it
// back to orders_dv, the order's duality view. Every read carries the
// document's ETag in _metadata.etag; Oracle checks it on the write and
// rejects a stale one with ORA-42699 instead of silently overwriting the
// other agent's change (docs/spikes/d7-etag-mongo-api.md).
//
//   node demos/d7-etag/agent.mjs read  --agent A|B [--api mongo|sql]
//   node demos/d7-etag/agent.mjs write --agent A|B
//   node demos/d7-etag/agent.mjs retry --agent A|B
// The presenter types `./lab.sh agent read --agent A`, which runs this in a
// one-off runner container (Ruling N/O).
//
// Agent A changes the order's status to "provisioned"; agent B swaps the
// device on the order. Each agent remembers the document and ETag it last
// read in its own small JSON file, so separate commands (and two terminals)
// share it: LAB_STATE_DIR/d7/agent-A.json, where LAB_STATE_DIR is /state in
// the runner (the named volume `state`) and .lab/state on the host.
// setup writes LAB_STATE_DIR/d7/order.json: which order the agents work on
// and the device B swaps in.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BSON } from 'mongodb';
import { closeAll, oraMongo, oraSql } from '../../lib/db.mjs';

const { EJSON } = BSON;

/** The spike found the MongoDB API enforces ETags, so agents use it by default. */
export const DEFAULT_API = 'mongo';
export const VIEW = 'orders_dv';
const APIS = ['mongo', 'sql'];

// ------------------------------------------------------------ reads and writes

// Every call to the database, as mongosh would type it, and what came back:
// the CLI prints it so the audience sees the command behind each line.
let trace = [];
const binHex = (b) => (b?.buffer ? Buffer.from(b.buffer).toString('hex').toUpperCase() : String(b));
const scnOf = (b) => { let n = 0n; for (const x of b?.buffer ?? []) n = (n << 8n) | BigInt(x); return n.toString(); };
// A value in mongosh style, one line: Binary shown as hex, asof as its SCN.
function show(v, key) {
  if (v?._bsontype === 'Binary') return key === 'asof' ? `Binary(SCN ${scnOf(v)})` : `Binary('${binHex(v)}')`;
  if (v instanceof Date) return `ISODate('${v.toISOString()}')`;
  if (Array.isArray(v)) return `[ ${v.map((x) => show(x)).join(', ')} ]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${show(x, k)}`).join(', ')} }`;
  return typeof v === 'string' ? `'${v}'` : String(v);
}
// A document over several lines: top-level fields one per line, each array
// item (an order line) on its own line.
function showDoc(doc, pad = '') {
  const out = ['{'];
  for (const [k, v] of Object.entries(doc)) {
    if (Array.isArray(v) && v.length) {
      out.push(`${pad}  ${k}: [`);
      for (const x of v) out.push(`${pad}    ${show(x)},`);
      out.push(`${pad}  ],`);
    } else out.push(`${pad}  ${k}: ${show(v, k)},`);
  }
  out.push(`${pad}}`);
  return out.join('\n');
}
/** The calls made since the last takeTrace(), and clears them. */
export const takeTrace = () => { const t = trace; trace = []; return t; };

/**
 * Read one order document and its ETag.
 * @param {'mongo'|'sql'} api
 * @returns {Promise<{doc:object, etag:any}>} etag is BSON Binary (mongo) or a hex string (sql)
 */
export async function readOrder(api, id) {
  let doc;
  if (api === 'mongo') {
    doc = await (await oraMongo()).collection(VIEW).findOne({ _id: id });
    trace.push({ cmd: `db.${VIEW}.findOne({ _id: '${id}' })`, out: doc ? showDoc(doc) : 'null' });
  } else if (api === 'sql') {
    const r = await (await oraSql()).execute(
      `select json_serialize(data) from ${VIEW} v where v.data."_id" = :id`, { id });
    doc = r.rows[0] ? JSON.parse(r.rows[0][0]) : null;
  } else {
    throw new Error(`unknown api ${api}`);
  }
  if (!doc) throw new Error(`order ${id} is not in ${VIEW}: run ./lab.sh reset d7`);
  return { doc, etag: doc._metadata?.etag };
}

/** True for Oracle's "the ETag did not match" error, from either access surface. */
export const isEtagMismatch = (err) => err?.errorNum === 42699 || /ORA-42699/.test(err?.message ?? '');

/**
 * Write a whole order document back, with the _metadata.etag it carries.
 * @param {'mongo'|'sql'} api
 * @returns {Promise<{ok:true}|{ok:false, code:'ETAG_MISMATCH', detail:string}>}
 */
export async function writeOrder(api, doc) {
  try {
    if (api === 'mongo') {
      const t = { cmd: `db.${VIEW}.replaceOne({ _id: '${doc._id}' }, ${showDoc(doc)})` };
      trace.push(t);
      let r;
      try {
        r = await (await oraMongo()).collection(VIEW).replaceOne({ _id: doc._id }, doc);
      } catch (err) {
        t.out = `${err.name ?? 'Error'}: ${String(err.message).split('\n')[0]}`;
        throw err;
      }
      t.out = show({ acknowledged: r.acknowledged, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount });
      if (r.matchedCount !== 1) throw new Error(`order ${doc._id} is not in ${VIEW}: run ./lab.sh reset d7`);
    } else if (api === 'sql') {
      const conn = await oraSql();
      try {
        const r = await conn.execute(`update ${VIEW} v set data = json(:d) where v.data."_id" = :id`,
          { d: JSON.stringify(doc), id: doc._id }, { autoCommit: true });
        if (r.rowsAffected !== 1) throw new Error(`order ${doc._id} is not in ${VIEW}: run ./lab.sh reset d7`);
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
    } else {
      throw new Error(`unknown api ${api}`);
    }
    return { ok: true };
  } catch (err) {
    if (isEtagMismatch(err)) return { ok: false, code: 'ETAG_MISMATCH', detail: err.message.split('\n')[0] };
    throw err;
  }
}

/** A deep copy that keeps BSON types (a plain structuredClone would turn Binary into an object). */
const copy = (doc) => EJSON.deserialize(EJSON.serialize(doc));

/**
 * The change an agent makes, applied to a copy of the document it read.
 * {status: 'provisioned'} sets the status; {swapDevice: {to, price?}} puts
 * another device on the order's device line.
 */
export function applyChange(doc, change) {
  const d = copy(doc);
  if (change.status !== undefined) d.status = change.status;
  if (change.swapDevice) {
    const line = d.lines.find((l) => l.kind === 'device');
    if (!line) throw new Error(`order ${d._id} has no device line`);
    line.sku = change.swapDevice.to;
    if (change.swapDevice.price !== undefined) line.price = change.swapDevice.price;
  }
  return d;
}

/** Re-read, reapply the change and write; again if another write got in between. */
async function mergeLoop(api, id, change, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const { doc } = await readOrder(api, id);
    const r = await writeOrder(api, applyChange(doc, change));
    if (r.ok) return { doc: (await readOrder(api, id)).doc, attempts: i };
  }
  throw new Error(`order ${id}: still a stale ETag after ${attempts} attempts`);
}

/** @returns {Promise<object>} the order as stored after the merged write */
export async function retryMerge(api, id, change) {
  return (await mergeLoop(api, id, change)).doc;
}

// ------------------------------------------------------------ agent memory

export const stateDir = () => join(
  process.env.LAB_STATE_DIR ||
    (process.env.LAB_IN_CONTAINER === '1' ? '/state' : fileURLToPath(new URL('../../.lab/state', import.meta.url))),
  'd7');
const file = (name) => join(stateDir(), name);
const save = (name, value) => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(name), EJSON.stringify(value, null, 2) + '\n');
};
const load = (name) => {
  try {
    return EJSON.parse(readFileSync(file(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

export const AGENTS = ['A', 'B'];
export const saveOrderPick = (pick) => save('order.json', pick);
export const loadMemory = (agent) => load(`agent-${agent}.json`);
export const clearState = () => rmSync(stateDir(), { recursive: true, force: true });

/** {orderId, fromSku, toSku, toPrice}: written by setup. */
export function orderPick() {
  const pick = load('order.json');
  if (!pick) throw new Error('D7 has no demo order yet: run ./lab.sh reset d7');
  return pick;
}

/** The change each agent makes. */
export function roleChange(agent, pick = orderPick()) {
  if (agent === 'A') return { status: 'provisioned' };
  if (agent === 'B') return { swapDevice: { to: pick.toSku, price: pick.toPrice } };
  throw new Error(`unknown agent ${agent} (A or B)`);
}
const ROLE = { A: 'status change to provisioned', B: 'device swap' };

/** The ETag as hex, the same text for both access surfaces. */
export const etagHex = (etag) =>
  etag == null ? 'none' : typeof etag === 'string' ? etag.toUpperCase() : etag.toString('hex').toUpperCase();
const device = (doc) => doc.lines.find((l) => l.kind === 'device')?.sku;
const describe = (doc) => `status ${doc.status}, device ${device(doc)}`;

// ------------------------------------------------------------ the commands

/**
 * One agent command, as the CLI and the demo steps both run it.
 * ok is false only when the command could not do its job; a rejected stale
 * write is a normal outcome (ok:true, rejected:true).
 * @param {'read'|'write'|'retry'} cmd
 * @param {'A'|'B'} agent
 * @returns {Promise<{ok:boolean, rejected?:boolean, summary:string, lines:string[], doc?:object, memory?:object}>}
 */
export async function agentCommand(cmd, agent, { api } = {}) {
  if (!AGENTS.includes(agent)) throw new Error(`unknown agent ${agent} (A or B)`);
  const pick = orderPick();
  const id = pick.orderId;
  const name = `Agent ${agent}`;

  if (cmd === 'read') {
    const use = api ?? DEFAULT_API;
    const { doc, etag } = await readOrder(use, id);
    const memory = { agent, api: use, orderId: id, doc, etag, readAt: new Date() };
    save(`agent-${agent}.json`, memory);
    return {
      ok: true, doc, memory,
      summary: `${name} read order ${id}: ${describe(doc)}, ETag ${etagHex(etag)}`,
      lines: [
        `${name} read order ${id} through ${use === 'mongo' ? 'the MongoDB API' : 'SQL'}: ${describe(doc)}`,
        `  ETag ${etagHex(etag)} (kept in agent ${agent}'s memory)`,
      ],
    };
  }

  if (cmd === 'write') {
    const memory = loadMemory(agent);
    if (!memory || memory.orderId !== id) {
      throw new Error(`agent ${agent} has not read order ${id} yet: ./lab.sh agent read --agent ${agent}`);
    }
    const doc = applyChange(memory.doc, roleChange(agent, pick));
    const r = await writeOrder(memory.api, doc);
    save(`agent-${agent}.json`, { ...memory, lastWrite: { ok: r.ok, code: r.code ?? null, at: new Date() } });
    const head = `${name} writes the ${ROLE[agent]} (${describe(doc)}) with the ETag it read, ${etagHex(memory.etag)}`;
    if (r.ok) {
      return {
        ok: true, doc,
        summary: `${name}'s ${ROLE[agent]} was ACCEPTED: the ETag matched (${describe(doc)})`,
        lines: [head, '  ACCEPTED: the ETag matched, so nobody changed the order since the read'],
      };
    }
    return {
      ok: true, rejected: true, doc,
      summary: `${name}'s ${ROLE[agent]} was REJECTED: its ETag ${etagHex(memory.etag)} is stale (ORA-42699); nothing was overwritten`,
      lines: [
        head,
        `  REJECTED: ${r.detail}`,
        '  Someone changed the order after this agent read it. Nothing was overwritten.',
        `  Next: ./lab.sh agent retry --agent ${agent}`,
      ],
    };
  }

  if (cmd === 'retry') {
    const memory = loadMemory(agent);
    const use = api ?? memory?.api ?? DEFAULT_API;
    const { doc, attempts } = await mergeLoop(use, id, roleChange(agent, pick));
    save(`agent-${agent}.json`, {
      agent, api: use, orderId: id, doc, etag: doc._metadata?.etag, readAt: new Date(),
      lastWrite: { ok: true, code: null, at: new Date() },
    });
    return {
      ok: true, doc,
      summary: `${name} re-read, re-applied the ${ROLE[agent]} and wrote it: ACCEPTED; order now ${describe(doc)}`,
      lines: [
        `${name} re-read the order, re-applied the ${ROLE[agent]} and wrote it: ACCEPTED` +
          (attempts > 1 ? ` (after ${attempts} tries)` : ''),
        `  Order now: ${describe(doc)} (ETag ${etagHex(doc._metadata?.etag)})`,
      ],
    };
  }

  throw new Error(`unknown command ${cmd} (read, write or retry)`);
}

// ------------------------------------------------------------ CLI

const USAGE = 'usage: agent.mjs read|write|retry --agent A|B [--api mongo|sql]';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { agent: { type: 'string' }, api: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) { console.log(USAGE); return 0; }
  const [cmd] = positionals;
  const agent = values.agent?.toUpperCase();
  if (positionals.length !== 1 || !['read', 'write', 'retry'].includes(cmd) || !AGENTS.includes(agent) ||
      (values.api && !APIS.includes(values.api))) {
    console.error(USAGE);
    return 2;
  }
  try {
    takeTrace();
    const r = await agentCommand(cmd, agent, { api: values.api });
    // On a terminal: each database call and its reply, then the summary.
    if (process.stdout.isTTY || process.env.LAB_TTY === '1') {
      for (const t of takeTrace()) {
        console.log(`  > ${t.cmd.replace(/\n/g, '\n    ')}`);
        console.log(`  < ${(t.out ?? '').replace(/\n/g, '\n    ')}`);
      }
      console.log('');
    }
    for (const l of r.lines) console.log(l);
    return r.ok ? 0 : 1;
  } finally {
    await closeAll();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`FAIL  ${err.message}`);
    process.exitCode = 1;
  });
}

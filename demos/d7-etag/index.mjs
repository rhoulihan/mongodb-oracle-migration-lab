// D7 optimistic concurrency with ETags (spec section 5.2, D7 detail).
// Two customer-care agents read the same order from orders_dv, the order's
// duality view. Agent A changes the status; agent B swaps the device using
// the copy it read before A's write. Oracle compares B's ETag with the
// order's current one and rejects the write (ORA-42699) instead of silently
// erasing A's change. B re-reads, reapplies the swap and writes again; the
// order ends with both changes.
//
// Two terminals, one per agent: each step's command is a short
// `./lab.sh agent ...` (demos/d7-etag/agent.mjs in the runner). Each agent
// keeps what it last read in its own state file (agent.mjs, LAB_STATE_DIR).
//
// "Updates applied" are counted from the database itself: row triggers on
// order_hdr and order_line write one order_change_log row per changed row
// (oracle/sql/d7-orders-dv.sql). The status change is one row, the device
// swap one row, and the rejected write none: exactly 2.
//
// Starting state (setup): MIG holds D3's restore (setup runs D3's dump and
// restore when MIG.orders is empty); order_hdr, order_line, the change log
// and orders_dv are rebuilt from the R03 orders; the demo order is picked
// (the first placed R03 order with one device line) and the agents' memory
// is cleared.
import { readFileSync } from 'node:fs';
import d3 from '../d3-dump-restore/index.mjs';
import {
  agentCommand, clearState, DEFAULT_API, etagHex, loadMemory, orderPick, readOrder, saveOrderPick,
} from './agent.mjs';

const SQL_FILE = new URL('../../oracle/sql/d7-orders-dv.sql', import.meta.url);
export const D7_STATEMENTS = readFileSync(SQL_FILE, 'utf8')
  .split(/^\/\s*$/m)
  .map((s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
  .filter(Boolean);

const RESET = 'run ./lab.sh reset d7';
const cmd = (c, agent) => `./lab.sh agent ${c} --agent ${agent}`;

/** MIG holds D3's restore; if it is empty, run D3's own dump and restore steps. */
async function ensureRestored(ctx, conn) {
  const exists = Number((await conn.execute("select count(*) from user_tables where table_name = 'orders'")).rows[0][0]);
  const n = exists ? Number((await conn.execute('select count(*) from "orders"')).rows[0][0]) : 0;
  if (n > 0) return;
  for (const id of ['dump', 'restore']) {
    const r = await d3.steps.find((s) => s.id === id).run(ctx);
    if (!r.ok) throw new Error(`D7 setup needs D3's restore, and D3 ${id} failed: ${r.summary}`);
  }
}

/** Rebuild the D7 tables and view from the restored R03 orders. */
export async function buildOrders(conn) {
  for (const s of D7_STATEMENTS) await conn.execute(s);
  await conn.commit();
}

/** The demo order and the device B swaps in: the next device in the catalog. */
async function pickOrder(ctx, conn) {
  const r = await conn.execute(`
    select h.order_id, l.sku
      from order_hdr h join order_line l on l.order_id = h.order_id and l.kind = 'device'
     where h.status = 'placed'
       and (select count(*) from order_line x where x.order_id = h.order_id and x.kind = 'device') = 1
     order by h.order_id fetch first 1 rows only`);
  if (!r.rows.length) throw new Error(`no placed R03 order with one device line: ${RESET}`);
  const [orderId, fromSku] = r.rows[0];
  const devices = await (await ctx.oraMongo()).collection('catalog')
    .find({ kind: 'device' }, { sort: { _id: 1 }, projection: { price: 1 } }).toArray();
  const i = devices.findIndex((d) => d._id === fromSku);
  const to = devices[(i + 1) % devices.length];
  return { orderId, fromSku, toSku: to._id, toPrice: Number(to.price.toString()) };
}

async function startingState(ctx) {
  const conn = await ctx.oraSql();
  await ensureRestored(ctx, conn);
  await buildOrders(conn);
  clearState();
  const pick = await pickOrder(ctx, conn);
  saveOrderPick(pick);
  return pick;
}

/** {orderId, fromSku, toSku, toPrice} for the current run (written by setup). */
export async function demoOrder() {
  return orderPick();
}

/** The rows order writes changed, oldest first: the updates applied to the order. */
export async function appliedUpdates(ctx, orderId) {
  const r = await (await ctx.oraSql()).execute(
    'select table_name, line_no, change from order_change_log where order_id = :id order by seq', { id: orderId });
  return r.rows.map(([table, lineNo, change]) => ({ table, lineNo, change }));
}

/** The document as the console shows it: the ETag as hex, dates as ISO text. */
const showDoc = (doc) => JSON.stringify({ ...doc, _metadata: { etag: etagHex(doc._metadata?.etag) } }, null, 2);

const device = (doc) => doc.lines.find((l) => l.kind === 'device')?.sku;
const fail = (summary) => ({ ok: false, summary });

/** The order as it is now, plus its change log. */
async function live(ctx) {
  const pick = orderPick();
  const { doc, etag } = await readOrder(DEFAULT_API, pick.orderId);
  return { pick, doc, etag, log: await appliedUpdates(ctx, pick.orderId) };
}

/** A terminal step's run: the same agent command, in-process. */
const runAgent = (c, agent, check) => async () => {
  let r;
  try {
    r = await agentCommand(c, agent);
  } catch (err) {
    return fail(`${err.message}${/\.\/lab\.sh/.test(err.message) ? '' : `; ${RESET}`}`);
  }
  const problem = check?.(r);
  return problem ? fail(`${problem}: ${RESET}`) : { ok: true, summary: r.summary, detail: r.lines.slice(1).join('\n'), panes: { left: r.doc } };
};

/** verify for a read: the agent holds the order's current ETag. */
const verifyRead = (agent) => async (ctx) => {
  const m = loadMemory(agent);
  const now = await live(ctx);
  if (!m || m.orderId !== now.pick.orderId) return fail(`agent ${agent} has not read order ${now.pick.orderId}: ${cmd('read', agent)}`);
  const held = etagHex(m.etag);
  if (held !== etagHex(now.etag)) return fail(`agent ${agent}'s ETag ${held} is not the order's current one: ${RESET}`);
  const other = loadMemory(agent === 'A' ? 'B' : 'A');
  const both = other && etagHex(other.etag) === held ? '; both agents hold the same ETag' : '';
  return { ok: true, summary: `agent ${agent} holds order ${m.orderId} with its current ETag ${held}${both}` };
};

/** @type {import('../contract.mjs').Demo} */
export default {
  id: 'd7',
  title: 'ETags: two agents, one order, no lost update',
  setup: startingState,
  reset: startingState,
  steps: [
    {
      id: 'setup',
      title: 'One order, two agents, nothing read yet',
      lane: 'console',
      async run(ctx) {
        // The console runs this step on its own (no demo.setup), so it builds
        // the full starting state itself, D3's restore included.
        let pick, now;
        try {
          pick = await startingState(ctx);
          now = await live(ctx);
        } catch (err) {
          return fail(`could not build the starting state (${err.message}): ${RESET}`);
        }
        const conn = await ctx.oraSql();
        const [[orders, lines]] = (await conn.execute(
          'select (select count(*) from order_hdr), (select count(*) from order_line) from dual')).rows;
        const ok = now.doc.status === 'placed' && device(now.doc) === pick.fromSku && now.log.length === 0;
        return {
          ok,
          summary: ok
            ? `orders_dv holds ${orders} R03 orders (${lines} lines in order_line); the agents will work on order ${pick.orderId}: status placed, device ${pick.fromSku}`
            : `order ${pick.orderId} did not start as placed with device ${pick.fromSku} and an empty change log: ${RESET}`,
          metrics: { orders: Number(orders), lines: Number(lines) },
          panes: { left: now.doc },
          detail: `order document (MongoDB API, orders_dv):\n${showDoc(now.doc)}`,
        };
      },
    },
    {
      id: 'agent-a-read',
      title: 'Agent A reads the order (and its ETag)',
      lane: 'terminal',
      command: cmd('read', 'A'),
      run: runAgent('read', 'A'),
      verify: verifyRead('A'),
    },
    {
      id: 'agent-b-read',
      title: 'Agent B reads the same order',
      lane: 'terminal',
      command: cmd('read', 'B'),
      run: runAgent('read', 'B'),
      verify: verifyRead('B'),
    },
    {
      id: 'agent-a-write',
      title: 'Agent A sets the status to provisioned',
      lane: 'terminal',
      command: cmd('write', 'A'),
      run: runAgent('write', 'A', (r) => (r.rejected ? `agent A's write was rejected (${r.lines[1].trim()})` : null)),
      async verify(ctx) {
        const { pick, doc, log } = await live(ctx);
        return doc.status === 'provisioned' && device(doc) === pick.fromSku && log.length === 1
          ? { ok: true, summary: `order ${pick.orderId} is provisioned; 1 update applied (${log[0].change})` }
          : fail(`expected status provisioned, device ${pick.fromSku} and 1 update; found ${doc.status}, ${device(doc)}, ${log.length}: ${RESET}`);
      },
    },
    {
      id: 'agent-b-write-stale',
      title: 'Agent B writes the device swap with its stale ETag: rejected',
      lane: 'terminal',
      command: cmd('write', 'B'),
      run: runAgent('write', 'B', (r) => (r.rejected ? null : "agent B's stale write was accepted; the ETag check did not fire")),
      async verify(ctx) {
        const m = loadMemory('B');
        const { pick, doc, log } = await live(ctx);
        const rejected = m?.lastWrite && !m.lastWrite.ok && m.lastWrite.code === 'ETAG_MISMATCH';
        return rejected && doc.status === 'provisioned' && device(doc) === pick.fromSku && log.length === 1
          ? { ok: true, summary: `agent B's write was rejected (ORA-42699): order ${pick.orderId} still has A's status and device ${pick.fromSku}; still 1 update applied` }
          : fail(`expected B's write rejected and the order unchanged (provisioned, ${pick.fromSku}, 1 update); found ${rejected ? 'rejected' : 'not rejected'}, ${doc.status}, ${device(doc)}, ${log.length}: ${RESET}`);
      },
    },
    {
      id: 'agent-b-retry',
      title: 'Agent B re-reads, reapplies the swap and writes again',
      lane: 'terminal',
      command: cmd('retry', 'B'),
      run: runAgent('retry', 'B'),
      async verify(ctx) {
        const { pick, doc, log } = await live(ctx);
        return doc.status === 'provisioned' && device(doc) === pick.toSku && log.length === 2
          ? { ok: true, summary: `order ${pick.orderId} has both changes: provisioned, device ${pick.toSku}; 2 updates applied` }
          : fail(`expected provisioned, device ${pick.toSku} and 2 updates; found ${doc.status}, ${device(doc)}, ${log.length}: ${RESET}`);
      },
    },
    {
      id: 'final',
      title: 'The final order: both changes, 2 updates applied',
      lane: 'console',
      async run(ctx) {
        let now;
        try {
          now = await live(ctx);
        } catch (err) {
          return fail(`${err.message}`);
        }
        const { pick, doc, log } = now;
        const ok = doc.status === 'provisioned' && device(doc) === pick.toSku && log.length === 2;
        const table = [
          'updates applied (order_change_log, written by row triggers):',
          ...log.map((r, i) => `  ${i + 1}  ${r.table.padEnd(10)}  ${r.lineNo == null ? '' : `line ${r.lineNo}  `}${r.change}`),
        ].join('\n');
        return {
          ok,
          summary: ok
            ? `order ${pick.orderId}: status provisioned (agent A) and device ${pick.toSku} (agent B); exactly 2 updates applied, none lost, none from the rejected write`
            : `expected provisioned, device ${pick.toSku} and 2 updates; found ${doc.status}, ${device(doc)}, ${log.length}: run the agent steps in order, or ${RESET}`,
          metrics: { updatesApplied: log.length },
          panes: { left: doc },
          detail: `${table}\n\nfinal order document:\n${showDoc(doc)}`,
        };
      },
    },
  ],
};

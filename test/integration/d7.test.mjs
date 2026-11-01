// D7 ETags against the live stack. Two agents read the same order from
// orders_dv; A changes the status, B's device swap carries a stale etag and is
// rejected; B re-reads and retries; the order ends with both changes, and the
// database's change log shows exactly 2 updates applied. Then the demo itself
// runs end to end, twice (setup must restore its own starting state).
// Leaves the lab at the D7 starting state (reset).
import { afterAll, beforeAll, describe, expect, test } from './live.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runDemo } from '../../demos/contract.mjs';
import d7, { appliedUpdates, demoOrder } from '../../demos/d7-etag/index.mjs';
import { readOrder, writeOrder, retryMerge, applyChange, DEFAULT_API } from '../../demos/d7-etag/agent.mjs';

process.env.LAB_STATE_DIR = mkdtempSync(join(tmpdir(), 'd7-state-'));
let ctx;

beforeAll(async () => {
  ctx = createContext();
  await d7.setup(ctx);
}, 600_000);

afterAll(async () => {
  try { await d7.reset(ctx); } finally { await ctx.close(); }
}, 300_000);

const deviceSku = (doc) => doc.lines.find((l) => l.kind === 'device').sku;

describe.each(['mongo', 'sql'])('two agents through the %s API', (api) => {
  test('the stale write is rejected, the retry merges, 2 updates applied', async () => {
    await d7.setup(ctx);
    const { orderId, fromSku, toSku } = await demoOrder(ctx);
    expect(fromSku).not.toBe(toSku);

    const a = await readOrder(api, orderId);
    const b = await readOrder(api, orderId);
    expect(a.etag).toBeTruthy();
    expect(a.doc.status).toBe('placed');

    const statusChange = { status: 'provisioned' };
    const swap = { swapDevice: { to: toSku } };

    expect(await writeOrder(api, applyChange(a.doc, statusChange))).toEqual({ ok: true });
    const stale = await writeOrder(api, applyChange(b.doc, swap));
    expect(stale).toMatchObject({ ok: false, code: 'ETAG_MISMATCH' });
    expect(stale.detail).toMatch(/ORA-42699/);
    expect(await appliedUpdates(ctx, orderId)).toHaveLength(1);

    const final = await retryMerge(api, orderId, swap);
    expect(final.status).toBe('provisioned');
    expect(deviceSku(final)).toBe(toSku);

    const again = (await readOrder(api, orderId)).doc;
    expect(again.status).toBe('provisioned');
    expect(deviceSku(again)).toBe(toSku);

    const log = await appliedUpdates(ctx, orderId);
    expect(log.map((r) => r.table)).toEqual(['order_hdr', 'order_line']);
    expect(log[0].change).toBe('status placed -> provisioned');
    expect(log[1].change).toMatch(new RegExp(`^sku ${fromSku} -> ${toSku}`));
  }, 120_000);
});

describe('D7 demo', () => {
  test('the agent defaults to the MongoDB API (the spike found it enforces ETags)', () => {
    expect(DEFAULT_API).toBe('mongo');
  });

  test('the steps and their commands', () => {
    expect(d7.steps.map((s) => [s.id, s.lane, s.command ?? null])).toEqual([
      ['setup', 'console', null],
      ['agent-a-read', 'terminal', './lab.sh agent read --agent A'],
      ['agent-b-read', 'terminal', './lab.sh agent read --agent B'],
      ['agent-a-write', 'terminal', './lab.sh agent write --agent A'],
      ['agent-b-write-stale', 'terminal', './lab.sh agent write --agent B'],
      ['agent-b-retry', 'terminal', './lab.sh agent retry --agent B'],
      ['final', 'console', null],
    ]);
  });

  test('runs end to end twice in a row, each run from its own setup', async () => {
    for (let i = 0; i < 2; i++) {
      await d7.setup(ctx);
      const results = await runDemo(d7, { ctx });
      expect(results.map((r) => [r.ok, r.summary])).toEqual(d7.steps.map(() => [true, expect.any(String)]));
      const stale = results[d7.steps.findIndex((s) => s.id === 'agent-b-write-stale')];
      expect(stale.summary).toMatch(/rejected/i);
      const final = results.at(-1);
      expect(final.metrics.updatesApplied).toBe(2);
      expect(final.panes.left.status).toBe('provisioned');
    }
  }, 300_000);
});

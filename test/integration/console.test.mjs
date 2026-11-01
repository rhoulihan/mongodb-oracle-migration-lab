// Instructor console against the live stack. The console runs in-process on
// an ephemeral port with the real demos and one shared ctx, as in its
// container; recorded results go to a scratch folder, not .lab/recorded.
// A second console with readiness stubbed to ords:false checks the 503
// (Review Focus 2). Leaves D5 and D6 at their starting state.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConsole } from '../../console/server.mjs';
import { readiness } from '../../lib/ready.mjs';

let live, stubbed, recordedDir;

async function api(c, method, path) {
  const res = await fetch(c.url + path, { method });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
}

beforeAll(async () => {
  recordedDir = mkdtempSync(join(tmpdir(), 'console-it-'));
  live = await startConsole({ port: 0, host: '127.0.0.1', recordedDir });
  stubbed = await startConsole({
    port: 0, host: '127.0.0.1', recordedDir,
    readiness: async () => ({ mongo: true, oracle: true, ords: false, oraMongo: true }),
  });
});

afterAll(async () => {
  try {
    await api(live, 'POST', '/api/demos/d5/reset');
    await api(live, 'POST', '/api/demos/d6/reset');
  } finally {
    await stubbed?.close();
    await live?.close();
  }
}, 600_000);

describe('instructor console', () => {
  test('readiness() sees all four lab endpoints', async () => {
    expect(await readiness()).toEqual({ mongo: true, oracle: true, ords: true, oraMongo: true });
    expect((await api(live, 'GET', '/api/ready')).body).toMatchObject({ ready: true });
  });

  test('GET /api/demos lists d1 to d7, each with steps', async () => {
    const { body } = await api(live, 'GET', '/api/demos');
    expect(body.map((d) => d.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    for (const d of body) {
      expect(d.title).toMatch(/\S/);
      expect(d.steps.length).toBeGreaterThan(0);
      for (const s of d.steps) {
        if (s.lane === 'terminal') expect(s.command).toMatch(/\S/);
        else expect(s.command).toBeUndefined();
      }
    }
    expect(body.find((d) => d.id === 'd4').banner).toBe('Stand-in for Oracle GoldenGate');
  });

  test('running a D5 step returns ok:true; "Mark done" on its terminal step runs verify', async () => {
    const setup = await api(live, 'POST', '/api/demos/d5/steps/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.ok, setup.body.summary).toBe(true);
    const done = await api(live, 'POST', '/api/demos/d5/steps/mongosh-read');
    expect(done.body).toMatchObject({ ok: true, summary: expect.stringMatching(/readable through the MongoDB API/) });
  }, 900_000);

  test('when ORDS is not ready a step POST returns 503 with the readiness message', async () => {
    const r = await api(stubbed, 'POST', '/api/demos/d5/steps/setup');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'Oracle is still starting (ORDS not ready)' });
  });

  test('the served page, script and styles hold no URL other than 127.0.0.1', async () => {
    const page = await api(live, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<script[^>]+app\.js/);
    for (const path of ['/', '/app.js', '/style.css', '/fonts/fonts.css']) {
      const r = await api(live, 'GET', path);
      expect(r.status, path).toBe(200);
      const urls = r.body.match(/https?:\/\/[^\s'"`)<>]+/g) ?? [];
      expect(urls.filter((u) => !/^https?:\/\/127\.0\.0\.1[:/]/.test(u)), path).toEqual([]);
      expect(r.body, path).not.toMatch(/\/\/[a-z0-9.-]+\.(com|net|org|io|dev)\b/i);
    }
  });

  test('after a successful run, GET /api/demos/d6/recorded returns the saved results', async () => {
    const run = await api(live, 'POST', '/api/demos/d6/steps/setup');
    expect(run.body.ok, run.body.summary).toBe(true);
    expect(existsSync(join(recordedDir, 'd6.json'))).toBe(true);
    const rec = await api(live, 'GET', '/api/demos/d6/recorded');
    expect(rec.status).toBe(200);
    expect(rec.body.steps.setup).toMatchObject({ at: expect.any(String), result: { ok: true, summary: run.body.summary } });
  }, 900_000);
});

// Instructor console UI. Same-origin API calls only; nothing is fetched from
// anywhere else, so it works with no network in the room.
//   URL hash: #d5/same-shape selects a demo and a step.
//   ?theme=light|dark overrides the system theme (the button does too).

const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
};

const state = {
  demos: [],
  demo: null,       // the selected demo
  step: null,       // the selected step id
  live: {},         // step id -> {at, ms, result} from this console process
  recorded: null,   // {steps: {id: {at, result}}} from the last good rehearsal
  shown: {},        // step id -> 'live' | 'recorded'
  running: null,    // {demo, step, started}
};

// ---- theme --------------------------------------------------------------
function storedTheme() {
  try { return localStorage.getItem('lab-theme'); } catch { return null; }
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme').textContent = dark ? 'Light' : 'Dark';
}
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('lab-theme', next); } catch { /* private window */ }
  applyTheme(next);
});
applyTheme(new URLSearchParams(location.search).get('theme') || storedTheme());

// ---- API ----------------------------------------------------------------
async function api(method, path, json) {
  const res = await fetch(path, json === undefined ? { method }
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

// ---- readiness ----------------------------------------------------------
const SERVICES = [['mongo', 'MongoDB'], ['oracle', 'Oracle'], ['ords', 'ORDS'], ['oraMongo', 'MongoDB API']];
async function pollReady() {
  if (state.running) return; // no probing while a step runs
  let r;
  try { r = (await api('GET', '/api/ready')).body; } catch { r = null; }
  const box = $('ready');
  box.replaceChildren();
  for (const [k, label] of SERVICES) {
    const up = r ? r[k] : false;
    const p = h('span', `pill ${up ? 'up' : 'down'}`, label);
    p.title = up ? `${label} is ready` : `${label} is not ready yet`;
    box.append(p);
  }
}

// ---- formatting -----------------------------------------------------------
const words = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
const fmt = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length > 10 ? `${v.slice(0, 10).map(fmt).join(', ')}, ...` : v.map(fmt).join(', ');
  if (v == null) return '-';
  return String(v);
};
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB');
const stamp = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};
const elapsed = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function metricChips(metrics) {
  const out = [];
  for (const [k, v] of Object.entries(metrics ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out.push([`${words(k)}, ${words(k2)}`, fmt(v2)]);
    } else out.push([words(k), fmt(v)]);
  }
  return out;
}

const isFlat = (o) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.values(o).every((v) => v == null || typeof v !== 'object');

function table(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const wrap = h('div', 'table-wrap');
  const t = h('table', 'grid');
  const hr = h('tr');
  for (const c of cols) hr.append(h('th', null, words(c)));
  t.append(hr);
  const max = 60;
  for (const r of rows.slice(0, max)) {
    const tr = h('tr');
    for (const c of cols) tr.append(h('td', typeof r[c] === 'number' ? 'num' : String(r[c] ?? '').length > 32 ? 'wrap' : null, fmt(r[c])));
    t.append(tr);
  }
  wrap.append(t);
  const box = h('div');
  box.append(wrap);
  if (rows.length > max) box.append(h('p', 'more', `${rows.length - max} more rows not shown`));
  return box;
}

const isScalar = (v) => v == null || typeof v !== 'object';
const isRows = (v) => Array.isArray(v) && v.length > 0 && v.every(isFlat);

// A document as tables: its scalar fields as one key/value table, each array
// of flat rows as a table, nested documents one level down; anything else
// as indented JSON.
function paneBody(v, depth = 0) {
  if (v == null) return h('p', 'more', 'nothing');
  if (isRows(v)) return table(v);
  if (typeof v !== 'object' || Array.isArray(v) || depth > 1) {
    return h('pre', null, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  const box = h('div', 'doc');
  const scalars = Object.entries(v).filter(([, x]) => isScalar(x));
  if (scalars.length) {
    const kv = h('table', 'grid kv');
    for (const [k, x] of scalars) {
      const tr = h('tr');
      tr.append(h('th', null, k), h('td', typeof x === 'number' ? 'num' : null, fmt(x)));
      kv.append(tr);
    }
    box.append(kv);
  }
  for (const [k, x] of Object.entries(v).filter(([, y]) => !isScalar(y))) {
    box.append(h('h4', null, k), paneBody(x, depth + 1));
  }
  return box;
}

function pair(kind, left, right, labels, defaults, queries) {
  const hasL = left !== undefined, hasR = right !== undefined;
  if (!hasL && !hasR) return null;
  const box = h('div', `pair ${kind}${hasL && hasR ? '' : ' one'}`);
  for (const [side, v, has] of [['left', left, hasL], ['right', right, hasR]]) {
    if (!has) continue;
    const p = h('section', `pane ${side}`);
    const title = labels?.[side] ?? (hasL && hasR ? defaults[side] : defaults.one);
    const q = kind === 'plans' ? queries?.[side] : undefined;
    if (!q) {
      p.append(h('h3', null, title), kind === 'plans' ? h('pre', null, v) : paneBody(v));
      box.append(p);
      continue;
    }
    // A plan tile with its own switch: the plan, or the query as typed and
    // the SQL it runs, side by side, each frame scrolling on its own.
    const head = h('div', 'pane-head');
    const plan = h('pre', null, v);
    const grid = h('div', 'qsql');
    const second = q.sql ? ['The SQL it runs', q.sql]
      : q.explain ? ['MongoDB explain', q.explain] : ['The SQL it runs', 'none: MongoDB runs it natively'];
    for (const [t, text] of [['Query', q.query], second]) {
      const f = h('div', 'qsql-frame');
      f.append(h('h4', null, t), h('pre', null, text));
      grid.append(f);
    }
    grid.hidden = true;
    const seg = h('div', 'seg');
    const views = [['Plan', plan], [q.sql || !q.explain ? 'Query and SQL' : 'Query and explain', grid]];
    const btns = views.map(([name, el]) => {
      const b = h('button', name === 'Plan' ? 'on' : null, name);
      b.type = 'button';
      b.addEventListener('click', () => {
        for (const [, e] of views) e.hidden = e !== el;
        for (const x of btns) x.classList.toggle('on', x === b);
      });
      return b;
    });
    seg.append(...btns);
    head.append(h('h3', null, title), seg);
    p.append(head, plan, grid);
    box.append(p);
  }
  return box;
}

// ---- rendering ----------------------------------------------------------
function renderTabs() {
  const nav = $('demos');
  nav.replaceChildren();
  for (const d of state.demos) {
    const b = h('button', d.id === state.demo?.id ? 'on' : null, d.id.toUpperCase());
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(d.id === state.demo?.id));
    b.title = d.title;
    b.addEventListener('click', () => select(d.id));
    nav.append(b);
  }
}

function stepClass(id) {
  if (state.running?.demo === state.demo.id && state.running.step === id) return 'busy';
  const which = state.shown[id];
  if (which === 'recorded') return 'rec';
  const e = state.live[id];
  return e ? (e.result.ok ? 'ok' : 'fail') : '';
}

function renderSteps() {
  const ol = $('steps');
  ol.replaceChildren();
  state.demo.steps.forEach((s, i) => {
    const li = h('li');
    const b = h('button', [s.id === state.step ? 'on' : '', stepClass(s.id)].join(' ').trim());
    b.type = 'button';
    b.append(h('span', 'n', i + 1));
    const t = h('span', 't', s.title);
    const st = stepClass(s.id);
    const tag = { ok: 'passed', fail: 'failed', rec: 'recorded result', busy: 'running' }[st];
    t.append(h('span', 'lane', `${s.lane === 'terminal' ? 'terminal' : 'console'}${tag ? `, ${tag}` : ''}`));
    b.append(t);
    b.addEventListener('click', () => { state.step = s.id; location.hash = `${state.demo.id}/${s.id}`; render(); });
    li.append(b);
    ol.append(li);
  });
}

let ticker = null;
function renderStage() {
  const stage = $('stage');
  stage.replaceChildren();
  const s = state.demo.steps.find((x) => x.id === state.step);
  if (!s) { stage.append(h('p', 'empty', 'Pick a step on the left.')); return; }

  const bar = h('section', 'step-bar');
  bar.append(h('h2', null, s.title));
  const busy = Boolean(state.running);
  const mine = state.running?.demo === state.demo.id && state.running.step === s.id;
  if (s.lane === 'terminal') {
    const cmd = h('div', 'cmd');
    cmd.append(h('code', null, s.command));
    const copy = h('button', 'btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(s.command));
    cmd.append(copy);
    bar.append(cmd);
  }
  const row = h('div', 'row');
  const go = h('button', s.lane === 'terminal' ? 'btn done' : 'btn primary', s.lane === 'terminal' ? 'Mark done' : 'Run step');
  go.type = 'button';
  go.disabled = busy;
  go.addEventListener('click', () => runStep(s));
  row.append(go);
  if (mine) {
    const t = h('span', 'timer', `Running ${elapsed(Date.now() - state.running.started)}`);
    t.id = 'timer';
    row.append(t);
  }
  const rec = state.recorded?.steps?.[s.id];
  if (rec) {
    const skip = h('button', 'btn ghost', state.shown[s.id] === 'recorded' ? 'Show live result' : 'Skip to result');
    skip.type = 'button';
    skip.title = 'Show the result recorded at the last rehearsal';
    skip.addEventListener('click', () => {
      state.shown[s.id] = state.shown[s.id] === 'recorded' ? 'live' : 'recorded';
      render();
    });
    row.append(skip);
  }
  bar.append(row);
  if (s.lane === 'terminal' && !mine) {
    bar.append(h('p', 'hint', 'Type the command in the terminal, then press Mark done to check that it worked.'));
  }
  stage.append(bar);

  const showRec = state.shown[s.id] === 'recorded' && rec;
  const entry = showRec ? rec : state.live[s.id];
  if (!entry) {
    if (!mine) stage.append(h('p', 'empty', s.lane === 'terminal' ? 'Not checked yet.' : 'Not run yet.'));
    return;
  }
  stage.append(...renderResult(entry, showRec));
}

function renderResult({ at, result: r }, recorded) {
  const out = [];
  const card = h('section', `result ${r.ok ? 'ok' : 'fail'}`);
  if (recorded) {
    card.append(h('div', 'recorded-tag',
      `Recorded at rehearsal ${stamp(at)}${state.recorded?.source === 'baked' ? ' (saved in the repo)' : ''}`));
  }
  const head = h('div');
  head.append(h('span', 'status', r.ok ? 'Passed' : 'Failed'));
  // No run time here: a step's wall time is a timing (Ruling T, and D6 never
  // times MongoDB); the live timer shows only while a step runs.
  if (!recorded) head.append(h('span', 'when', `at ${clock(at)}`));
  card.append(head, h('p', 'summary', r.summary));
  if (r.verified) card.append(h('p', 'verified', `Checked: ${r.verified}`));
  out.push(card);

  const chips = metricChips(r.metrics);
  if (chips.length || r.hidden) {
    const strip = h('div', 'metrics');
    for (const [k, v] of chips) {
      const c = h('span', 'metric', k);
      c.append(h('b', null, v));
      strip.append(c);
    }
    if (r.hidden) strip.append(h('span', 'metric hidden', `Times hidden until "${r.hidden.untilTitle ?? r.hidden.until}" passes`));
    out.push(strip);
  }
  const panes = pair('panes', r.panes?.left, r.panes?.right, r.labels, { left: 'Left', right: 'Right', one: 'Result' });
  if (panes) out.push(panes);
  const plans = pair('plans', r.plan?.left, r.plan?.right, r.labels && r.plan ? { left: r.labels.left && `Plan: ${r.labels.left}`, right: r.labels.right && `Plan: ${r.labels.right}` } : null,
    { left: 'Plan, left', right: 'Plan, right', one: 'Plan' }, r.query);
  if (plans) out.push(plans);
  if (r.detail) {
    const d = h('details', 'text');
    d.open = !panes && !plans;
    d.append(h('summary', null, 'Text output'), h('pre', 'detail', r.detail));
    out.push(d);
  }
  return out;
}

function render() {
  if (!state.demo) return;
  renderTabs();
  $('demo-title').textContent = `${state.demo.id.toUpperCase()}  ${state.demo.title}`;
  const banner = $('banner');
  banner.hidden = !state.demo.banner;
  banner.textContent = state.demo.banner ?? '';
  $('reset').disabled = Boolean(state.running);
  renderSteps();
  renderStage();
}

// ---- actions ------------------------------------------------------------
function toast(msg) {
  const t = h('div', 'toast', msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Command copied');
}

async function loadDemoState(id) {
  const [live, rec] = await Promise.all([api('GET', `/api/demos/${id}/state`), api('GET', `/api/demos/${id}/recorded`)]);
  if (state.demo?.id !== id) return;
  state.live = live.body?.results ?? {};
  state.recorded = rec.status === 200 ? rec.body : null;
}

async function select(id, stepId) {
  state.demo = state.demos.find((d) => d.id === id) ?? state.demos[0];
  state.step = state.demo.steps.some((s) => s.id === stepId) ? stepId : state.demo.steps[0].id;
  state.shown = {};
  if (location.hash.slice(1) !== `${state.demo.id}/${state.step}`) history.replaceState(null, '', `#${state.demo.id}/${state.step}`);
  render();
  await loadDemoState(state.demo.id);
  render();
}

function startTimer() {
  clearInterval(ticker);
  ticker = setInterval(() => {
    const t = document.getElementById('timer');
    if (t && state.running) t.textContent = `Running ${elapsed(Date.now() - state.running.started)}`;
  }, 250);
}

async function runStep(s) {
  const demo = state.demo;
  state.running = { demo: demo.id, step: s.id, started: Date.now() };
  state.shown[s.id] = 'live';
  render();
  startTimer();
  let res;
  try {
    res = await api('POST', `/api/demos/${demo.id}/steps/${s.id}`);
  } catch (err) {
    res = { status: 0, body: { error: `the console did not answer (${err.message})` } };
  }
  clearInterval(ticker);
  state.running = null;
  if (res.status !== 200) toast(res.body?.error ?? `HTTP ${res.status}`);
  // Re-read everything: a gate step (Ruling T) may reveal or hide other steps' metrics.
  if (state.demo.id === demo.id) await loadDemoState(demo.id);
  if (res.status === 503 && state.demo.id === demo.id) {
    state.live[s.id] = { at: new Date().toISOString(), result: { ok: false, summary: res.body.error } };
  }
  render();
  pollReady();
  if (res.status !== 200) return { ok: false, summary: res.body?.error ?? `HTTP ${res.status}` };
  return { ok: res.body?.ok === true, summary: res.body?.summary ?? 'no summary' };
}

// ---- remote control (./lab.sh drive) ------------------------------------
// The driver queues a command on the server; this page takes it and presses
// its own buttons, so the shared screen shows exactly what a click shows.
async function doRemote({ demo, step, action }) {
  if (!state.demos.some((d) => d.id === demo)) return { ok: false, summary: `no demo ${demo}` };
  await select(demo, step);
  const s = state.demo.steps.find((x) => x.id === step);
  if (!s) return { ok: false, summary: `no step ${step} in ${demo}` };
  if (action === 'run') return runStep(s);
  if (action === 'skip') {
    const rec = state.recorded?.steps?.[s.id];
    if (!rec) return { ok: false, summary: `nothing recorded for ${demo} ${step}` };
    state.shown[s.id] = 'recorded';
    render();
    return { ok: true, summary: `showing the rehearsal recording: ${rec.result.summary}` };
  }
  return { ok: true, summary: `showing ${demo}: ${s.title}` };
}
// A long poll in a loop, not a timer: each request waits on the server for
// a command, so a hidden or throttled tab still takes commands at once.
async function remoteLoop() {
  for (;;) {
    let r;
    try { r = await api('GET', '/api/remote/next?wait=20000'); } catch { await new Promise((ok) => setTimeout(ok, 1000)); continue; }
    if (r.status !== 200 || !r.body) continue;
    let out;
    try { out = await doRemote(r.body); } catch (err) { out = { ok: false, summary: `the console page failed: ${err.message}` }; }
    try { await api('POST', `/api/remote/done/${r.body.seq}`, out); } catch { /* the driver times out */ }
  }
}

$('reset').addEventListener('click', async () => {
  const demo = state.demo;
  state.running = { demo: demo.id, step: null, started: Date.now() };
  render();
  const res = await api('POST', `/api/demos/${demo.id}/reset`);
  state.running = null;
  toast(res.body?.summary ?? res.body?.error ?? `HTTP ${res.status}`);
  await loadDemoState(demo.id);
  state.shown = {};
  render();
});

// The presenter's clicker during a demo: Right arrow or Page Down is "next"
// for the autopilot (./lab.sh drive autopilot), which runs the next step.
addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowRight' && ev.key !== 'PageDown') return;
  if (ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
  ev.preventDefault();
  api('POST', '/api/remote/key?from=console').catch(() => {});
});

addEventListener('hashchange', () => {
  const [id, step] = location.hash.slice(1).split('/');
  if (id && (id !== state.demo?.id || step !== state.step)) select(id, step);
});

// ---- start ----------------------------------------------------------------
(async function start() {
  pollReady();
  setInterval(pollReady, 10000);
  state.demos = (await api('GET', '/api/demos')).body ?? [];
  if (!state.demos.length) { $('demo-title').textContent = 'No demos found'; return; }
  const [id, step] = location.hash.slice(1).split('/');
  await select(id || state.demos[0].id, step);
  remoteLoop();
})();

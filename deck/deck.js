/* Reveal setup for the migration deep dive deck. Classic script (not a module) so the
   deck runs straight from file://. Shared by index.html and the QA fixtures.

   Keys: S opens the speaker view (notes plugin); ?notes=auto opens it on load.
   The theme is dark only.
   The speaker view gets a pinned timer, a notes font control and draggable panes
   (enhanceSpeakerView below). */
(function () {
  /* ---------- Speaker view extras ----------
     The notes plugin writes its speaker view into a popup (about:blank, same origin as the
     deck). We catch that window and add: a pinned, smaller timer; an A- / A+ notes font
     control; and two drag bars that resize the panes in every layout but notes-only.
     Settings persist in localStorage. The vendored plugin files stay untouched. */
  var NOTES_WINDOW = 'reveal.js - Notes';
  var SCALE_KEY = 'reveal-speaker-notes-scale';
  var SPLIT_KEY = 'reveal-speaker-split';
  var SPLIT_DEFAULT = {
    default: { x: 60, y: 40 },
    wide: { x: 50, y: 45 },
    tall: { x: 45, y: 50 }
  };

  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (err) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }

  var SPEAKER_CSS = [
    /* The time block stays on screen; only the notes scroll under it. */
    '#speaker-controls .speaker-controls-time { position: sticky; top: 0; z-index: 3; background: #fff;',
    '  margin-bottom: 6px; padding: 8px 16px 10px; }',
    '.speaker-controls-time .timer, .speaker-controls-time .clock,',
    '.speaker-controls-time .pacing .hours-value, .speaker-controls-time .pacing .minutes-value,',
    '.speaker-controls-time .pacing .seconds-value { font-size: 1.35em; }',
    '.speaker-controls-notes .value { font-size: calc(1.2em * var(--notes-scale, 1)); }',
    /* Notes font control, top right of the time block. */
    '.dk-font { position: absolute; top: 6px; right: 16px; display: inline-flex; align-items: center; gap: 6px;',
    '  font-size: 13px; text-transform: none; color: #444; cursor: default; }',
    /* Timer left, clock right, one row under the label and the font control. */
    '.speaker-controls-time .label { min-height: 26px; }',
    /* Tall and notes-only pad the panel top for the layout button; move that padding into the
       pinned block so no notes text shows above it, and keep the font control clear of the button. */
    'body[data-speaker-layout="tall"] #speaker-controls, body[data-speaker-layout="notes-only"] #speaker-controls {',
    '  padding-top: 0; }',
    'body[data-speaker-layout="tall"] #speaker-controls .speaker-controls-time,',
    'body[data-speaker-layout="notes-only"] #speaker-controls .speaker-controls-time { padding-top: 46px; }',
    'body[data-speaker-layout="tall"] .dk-font, body[data-speaker-layout="notes-only"] .dk-font { top: 12px; right: 170px; }',
    '.speaker-controls-time .timer, .speaker-controls-time .clock { line-height: 1.2; }',
    '.dk-font button { font: inherit; font-weight: 700; min-width: 30px; height: 24px; padding: 0 6px;',
    '  border: 1px solid #bbb; border-radius: 4px; background: #f4f4f4; color: #222; cursor: pointer; }',
    '.dk-font button:hover { background: #e6e6e6; }',
    '.dk-font output { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }',
    /* Pane sizes from two percentages. Default layout. */
    'body:not([data-speaker-layout]) #current-slide, body[data-speaker-layout="default"] #current-slide {',
    '  width: var(--split-x); }',
    'body:not([data-speaker-layout]) #upcoming-slide, body[data-speaker-layout="default"] #upcoming-slide {',
    '  width: calc(100% - var(--split-x)); height: var(--split-y); }',
    'body:not([data-speaker-layout]) #speaker-controls, body[data-speaker-layout="default"] #speaker-controls {',
    '  width: calc(100% - var(--split-x)); top: var(--split-y); height: calc(100% - var(--split-y)); }',
    /* Wide: slide row on top, notes below. */
    'body[data-speaker-layout="wide"] #current-slide { width: var(--split-x); height: var(--split-y); }',
    'body[data-speaker-layout="wide"] #upcoming-slide { left: var(--split-x); width: calc(100% - var(--split-x));',
    '  height: var(--split-y); }',
    'body[data-speaker-layout="wide"] #speaker-controls { top: var(--split-y); height: calc(100% - var(--split-y)); }',
    /* Tall: slide column on the left, notes on the right. */
    'body[data-speaker-layout="tall"] #current-slide { width: var(--split-x); height: var(--split-y); }',
    'body[data-speaker-layout="tall"] #upcoming-slide { top: var(--split-y); width: var(--split-x);',
    '  height: calc(100% - var(--split-y)); }',
    'body[data-speaker-layout="tall"] #speaker-controls { left: var(--split-x); width: calc(100% - var(--split-x)); }',
    /* Drag bars. */
    '.dk-bar { position: absolute; z-index: 8; background: transparent; touch-action: none; }',
    '.dk-bar::after { content: ""; position: absolute; background: #c9c9c9; border-radius: 2px; }',
    '.dk-bar:hover::after, .dk-bar.active::after { background: #C74634; }',
    '.dk-bar.v { width: 10px; margin-left: -5px; cursor: col-resize; }',
    '.dk-bar.v::after { left: 4px; width: 2px; top: 0; bottom: 0; }',
    '.dk-bar.h { height: 10px; margin-top: -5px; cursor: row-resize; }',
    '.dk-bar.h::after { top: 4px; height: 2px; left: 0; right: 0; }',
    'body:not([data-speaker-layout]) .dk-bar.v, body[data-speaker-layout="default"] .dk-bar.v,',
    'body[data-speaker-layout="tall"] .dk-bar.v { left: var(--split-x); top: 0; height: 100%; }',
    'body:not([data-speaker-layout]) .dk-bar.h, body[data-speaker-layout="default"] .dk-bar.h {',
    '  top: var(--split-y); left: var(--split-x); right: 0; }',
    'body[data-speaker-layout="wide"] .dk-bar.h { top: var(--split-y); left: 0; right: 0; }',
    'body[data-speaker-layout="wide"] .dk-bar.v { left: var(--split-x); top: 0; height: var(--split-y); }',
    'body[data-speaker-layout="tall"] .dk-bar.h { top: var(--split-y); left: 0; width: var(--split-x); }',
    'body[data-speaker-layout="notes-only"] .dk-bar { display: none; }',
    'body.dk-dragging iframe { pointer-events: none; }',
    'body.dk-dragging { user-select: none; }'
  ].join('\n');

  function enhanceSpeakerView(win) {
    var doc = win.document;
    if (doc.getElementById('dk-speaker-css')) return;
    var body = doc.body;
    var style = doc.createElement('style');
    style.id = 'dk-speaker-css';
    style.textContent = SPEAKER_CSS;
    doc.head.appendChild(style);

    // Notes font size.
    var scale = Number(load(SCALE_KEY, 1)) || 1;
    var font = doc.createElement('span');
    font.className = 'dk-font';
    font.innerHTML = '<button type="button" title="Smaller notes">A-</button>' +
      '<output></output><button type="button" title="Larger notes">A+</button>';
    var out = font.querySelector('output');
    function setScale(s) {
      scale = Math.min(2.5, Math.max(0.6, Math.round(s * 10) / 10));
      body.style.setProperty('--notes-scale', scale);
      out.textContent = Math.round(scale * 100) + '%';
      save(SCALE_KEY, scale);
    }
    var buttons = font.querySelectorAll('button');
    buttons[0].addEventListener('click', function (ev) { ev.stopPropagation(); setScale(scale - 0.1); });
    buttons[1].addEventListener('click', function (ev) { ev.stopPropagation(); setScale(scale + 0.1); });
    font.addEventListener('click', function (ev) { ev.stopPropagation(); }); // the time block resets the timer on click
    font.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); // keep keys going to the deck
    doc.querySelector('.speaker-controls-time').appendChild(font);
    setScale(scale);

    // Split panes: one {x, y} per layout.
    var split = load(SPLIT_KEY, {});
    function layout() {
      var l = body.getAttribute('data-speaker-layout') || 'default';
      return SPLIT_DEFAULT[l] ? l : null;
    }
    function apply() {
      var l = layout();
      if (!l) return;
      var s = split[l] || SPLIT_DEFAULT[l];
      body.style.setProperty('--split-x', s.x + '%');
      body.style.setProperty('--split-y', s.y + '%');
    }
    function bar(axis) {
      var el = doc.createElement('div');
      el.className = 'dk-bar ' + axis;
      el.title = 'Drag to resize. Double-click to reset.';
      el.addEventListener('pointerdown', function (ev) {
        var l = layout();
        if (!l) return;
        ev.preventDefault();
        el.setPointerCapture(ev.pointerId);
        el.classList.add('active');
        body.classList.add('dk-dragging');
        var cur = split[l] || { x: SPLIT_DEFAULT[l].x, y: SPLIT_DEFAULT[l].y };
        function move(e) {
          var pct = axis === 'v' ? e.clientX / win.innerWidth : e.clientY / win.innerHeight;
          pct = Math.min(80, Math.max(20, Math.round(pct * 1000) / 10));
          cur = { x: axis === 'v' ? pct : cur.x, y: axis === 'h' ? pct : cur.y };
          split[l] = cur;
          apply();
        }
        function up() {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.classList.remove('active');
          body.classList.remove('dk-dragging');
          save(SPLIT_KEY, split);
        }
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
      el.addEventListener('dblclick', function () {
        var l = layout();
        if (!l) return;
        delete split[l];
        save(SPLIT_KEY, split);
        apply();
      });
      body.appendChild(el);
    }
    bar('v');
    bar('h');
    apply();
    // A layout switch picks up that layout's saved split.
    new win.MutationObserver(apply).observe(body, { attributes: true, attributeFilter: ['data-speaker-layout'] });
  }

  var openWindow = window.open;
  window.open = function (url, name) {
    var win = openWindow.apply(window, arguments);
    if (win && name === NOTES_WINDOW) {
      var tries = 0;
      (function wait() {
        try {
          if (win.closed) return;
          if (win.document && win.document.getElementById('speaker-controls')) return enhanceSpeakerView(win);
        } catch (err) { return; }
        if (++tries < 50) setTimeout(wait, 100);
      })();
    }
    return win;
  };

  Reveal.initialize({
    width: 1280,
    height: 720,
    margin: 0,            // 1280x720 projector renders at scale 1 (QA measures at that size)
    minScale: 0.2,
    maxScale: 2.0,
    center: false,
    display: 'flex',
    hash: true,
    navigationMode: 'linear',   // a clicker walks every slide in order, stacks included
    controls: false,
    progress: true,
    slideNumber: 'c/t',
    transition: 'fade',
    transitionSpeed: 'fast',
    backgroundTransition: 'none',
    plugins: [RevealNotes]
  });

  // ?notes=auto (set by ./lab.sh launch): open the speaker view on load, no S
  // press. Chrome allows it only when the deck may open pop-ups (allow them
  // once for the deck); otherwise S still works. Top window only: the speaker
  // view's slide previews are this deck in iframes, with the same URL, and
  // an open() from them would rewrite (blank) the speaker view.
  if (window.self === window.top && /[?&]notes=auto\b/.test(window.location.search)) {
    Reveal.on('ready', function () {
      try { Reveal.getPlugin('notes').open(); } catch (err) { /* blocked: press S */ }
    });
  }
})();

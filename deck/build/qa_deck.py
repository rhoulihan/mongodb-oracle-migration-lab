"""Headless QA for the Reveal.js deck. Exit code 1 if any slide fails a check.

  python3 deck/build/qa_deck.py deck/index.html [--dark] [--offline] [--shots DIR]
                                [--word-budget 45] [--slides 3,4]

Adapted from converged-modeling-patterns/presentations/build/qa_deck.py: renders the deck
in headless Chrome at a 1280x720 viewport, walks ``Reveal.getSlides()`` (every fragment
shown), and checks each slide for:

  * overflow: scroll overflow, or any element outside the 1280x720 frame
  * an SVG figure (``svg.fig`` or ``figure svg``) drawn below 0.80 px per viewBox unit
  * a missing or empty ``<aside class="notes">``
  * the em dash character (U+2014), anywhere in the slide or its notes
  * the old database version name (say 26ai)
  * more visible words than ``--word-budget`` (default 45) on a slide without class
    ``demo``; SVG labels and notes do not count. Text is accent only on concept slides.

``--offline`` blocks DNS in the browser and fails on any request whose scheme is not
file: (or data:, blob:, about:), plus any http(s) reference in the deck source or its
local stylesheets. ``--dark`` renders with data-theme="dark". ``--shots`` writes one
1280x720 PNG per slide; always look at them, the checker cannot judge taste.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

EM_DASH = chr(0x2014)
OLD_VERSION = "23" + "ai"   # split so this file passes the repo copy lint
MIN_SCALE = 0.80
LOCAL_SCHEMES = ("file:", "data:", "blob:", "about:")

DARK = "<script>document.documentElement.dataset.theme='dark'</script>"

QA_JS = r"""<script>
(function () {
  const CFG = __CFG__;
  function done(o) {
    const pre = document.createElement('pre'); pre.id = 'qa-out';
    pre.textContent = JSON.stringify(o); document.body.appendChild(pre);
  }
  function words(slide) {
    let n = 0;
    const w = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      const p = t.parentElement;
      if (!p || p.closest('aside.notes, svg, script, style')) continue;
      if (!p.checkVisibility({ visibilityProperty: true, opacityProperty: false })) continue;
      n += (t.textContent.match(/[A-Za-z0-9][\w'.%-]*/g) || []).length;
    }
    return n;
  }
  function run() {
    Reveal.configure({ transition: 'none', backgroundTransition: 'none' });
    const out = [];
    Reveal.getSlides().forEach((s, i) => {
      const ix = Reveal.getIndices(s);
      Reveal.slide(ix.h, ix.v || 0, 999);
      const frame = document.querySelector('.reveal .slides').getBoundingClientRect();
      const fb = { l: frame.left, t: frame.top, r: frame.left + 1280 * Reveal.getScale(),
                   b: frame.top + 720 * Reveal.getScale() };
      const bad = [];
      if (s.scrollHeight > s.clientHeight + 2) bad.push('overflow: scroll ' + (s.scrollHeight - s.clientHeight) + 'px tall');
      if (s.scrollWidth > s.clientWidth + 2) bad.push('overflow: scroll ' + (s.scrollWidth - s.clientWidth) + 'px wide');
      s.querySelectorAll('*').forEach(el => {
        if (el.closest('aside.notes') || el.parentElement.closest('svg')) return;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        if (r.right > fb.r + 1 || r.left < fb.l - 1 || r.bottom > fb.b + 1 || r.top < fb.t - 1)
          bad.push('overflow: <' + el.tagName.toLowerCase() + '> outside the 1280x720 frame');
      });
      let k = null;
      s.querySelectorAll('svg.fig, figure svg').forEach(svg => {
        const vb = svg.viewBox && svg.viewBox.baseVal, r = svg.getBoundingClientRect();
        if (!vb || !vb.width || !r.width) return;
        const kk = Math.min(r.width / vb.width, r.height / vb.height);
        k = k === null ? kk : Math.min(k, kk);
      });
      if (k !== null && k < CFG.minScale) bad.push('svg scale ' + k.toFixed(2) + ' below ' + CFG.minScale.toFixed(2));
      const note = s.querySelector('aside.notes');
      if (!note) bad.push('missing speaker notes');
      else if (!note.textContent.trim()) bad.push('empty speaker notes');
      const src = s.outerHTML;
      if (src.includes(CFG.em)) bad.push('U+2014 (em dash) in slide or notes');
      if (src.toLowerCase().includes(CFG.old)) bad.push('old version name: say 26ai');
      const wc = words(s);
      const demo = s.classList.contains('demo');
      if (!demo && wc > CFG.budget) bad.push(wc + ' visible words, budget is ' + CFG.budget + ' (non-demo slide)');
      const h = s.querySelector('h1, h2');
      const seg = s.closest('[data-segment]');
      out.push({ slide: i + 1, index: ix.h + '.' + (ix.v || 0),
                 segment: seg ? seg.dataset.segment : null,
                 title: h ? h.textContent.trim().slice(0, 80) : (s.getAttribute('aria-label') || ''),
                 demo: demo, word_count: wc, min_svg_k: k === null ? null : +k.toFixed(2),
                 note_len: note ? note.textContent.trim().length : 0, issues: [...new Set(bad)] });
    });
    const urls = performance.getEntriesByType('navigation').concat(performance.getEntriesByType('resource')).map(e => e.name);
    done({ scale: Reveal.getScale(), viewport: innerWidth + 'x' + innerHeight, slides: out, requests: [...new Set(urls)] });
  }
  addEventListener('load', () => document.fonts.ready.then(() => {
    if (!window.Reveal || !Reveal.getSlides) return done({ fatal: 'Reveal did not load' });
    if (Reveal.isReady()) run(); else Reveal.on('ready', run);
  }));
})();
</script>"""

SHOT_JS = r"""<script>
addEventListener('load', () => {
  const go = () => {
    Reveal.configure({ transition: 'none', backgroundTransition: 'none' });
    const m = /qa_slide=(\d+)\.(\d+)/.exec(location.search);
    if (m) Reveal.slide(+m[1], +m[2], 999);
  };
  if (Reveal.isReady()) go(); else Reveal.on('ready', go);
});
</script>"""


def chrome() -> str:
    for c in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        if shutil.which(c):
            return c
    sys.exit("no chrome/chromium on PATH")


def chrome_base(profile: Path, offline: bool) -> list[str]:
    base = ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
            f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-component-update", "--disable-sync",
            "--disable-default-apps"]
    if offline:
        base.append("--host-resolver-rules=MAP * ~NOTFOUND")
    return base


def viewport_args(ch: str, base: list[str], w=1280, h=720) -> list[str]:
    """Headless 'window-size' includes window chrome; probe and correct so the viewport is w x h."""
    with tempfile.TemporaryDirectory() as td:
        pf = Path(td) / "probe.html"
        pf.write_text("<body><script>addEventListener('load',()=>{document.body.textContent="
                      "'VP'+innerWidth+'x'+innerHeight})</script></body>", encoding="utf-8")
        dom = subprocess.run([ch, *base, f"--window-size={w},{h}", "--virtual-time-budget=1000",
                              "--dump-dom", pf.as_uri()], capture_output=True, text=True,
                             timeout=60).stdout
    m = re.search(r"VP(\d+)x(\d+)", dom)
    dw, dh = (w - int(m.group(1)), h - int(m.group(2))) if m else (0, 0)
    return base + [f"--window-size={w + dw},{h + dh}"]


def variant(src: str, head_extra: str, body_extra: str) -> str:
    i = src.rindex("</body>")
    s = src[:i] + body_extra + src[i:]
    return s.replace("<head>", "<head>" + head_extra, 1)


def local_refs(deck: Path, text: str) -> list[Path]:
    """Local CSS/JS the deck links, outside vendor/ (third-party code is checked at vendoring)."""
    out = []
    for ref in re.findall(r'(?:href|src)\s*=\s*["\']([^"\'#?]+)', text):
        if re.match(r"^[a-z]+:|^//", ref, re.I) or "vendor/" in ref:
            continue
        p = (deck.parent / ref)
        if p.suffix in (".css", ".js") and p.is_file():
            out.append(p)
    return out


def source_issues(deck: Path, text: str, offline: bool) -> list[str]:
    bad = []
    files = [(deck, text)] + [(p, p.read_text(encoding="utf-8")) for p in local_refs(deck, text)]
    for p, s in files:
        name = p.name
        if EM_DASH in s:
            bad.append(f"U+2014 (em dash) in {name}")
        if OLD_VERSION in s.lower():
            bad.append(f"old version name in {name}: say 26ai")
        if offline:
            pat = (r'(?:src|href)\s*=\s*["\']?\s*((?:https?:)?//[^"\'\s>]+)' if p.suffix == ".html"
                   else r'(?:url\(|@import\s+)["\']?((?:https?:)?//[^"\')\s]+)')
            for u in re.findall(pat, s, re.I):
                bad.append(f"network reference in {name}: {u}")
    return bad


def run(deck: Path, shots: Path | None, dark: bool, offline: bool, budget: int,
        only: set[int] | None) -> int:
    ch = chrome()
    text = deck.read_text(encoding="utf-8")
    deck_issues = source_issues(deck, text, offline)
    cfg = json.dumps({"em": EM_DASH, "old": OLD_VERSION, "budget": budget, "minScale": MIN_SCALE})
    head = DARK if dark else ""
    tmp = []
    with tempfile.TemporaryDirectory() as prof:
        plain = chrome_base(Path(prof), offline)
        base = viewport_args(ch, plain)
        try:
            # The variant sits next to the deck so every relative asset path still resolves.
            qa = deck.parent / f".qa-{os.getpid()}.html"
            tmp.append(qa)
            qa.write_text(variant(text, head, QA_JS.replace("__CFG__", cfg)), encoding="utf-8")
            dom = subprocess.run([ch, *base, "--virtual-time-budget=8000", "--dump-dom", qa.as_uri()],
                                 capture_output=True, text=True, timeout=240).stdout
            m = re.search(r'<pre id="qa-out">(.*?)</pre>', dom, re.S)
            if not m:
                print(json.dumps({"deck": deck_issues + ["QA script produced no output (page error?)"]}))
                return 1
            res = json.loads(html.unescape(m.group(1)))
            if "fatal" in res:
                print(json.dumps({"deck": deck_issues + [res["fatal"]]}, indent=1))
                return 1
            if offline:
                for u in res["requests"]:
                    if not u.lower().startswith(LOCAL_SCHEMES):
                        deck_issues.append(f"network request: {u}")
            if res["viewport"] != "1280x720":
                deck_issues.append(f"QA viewport was {res['viewport']}, not 1280x720")
            if abs(res["scale"] - 1) > 0.01:
                deck_issues.append(f"Reveal scale {res['scale']:.2f} at 1280x720 (expected 1.00)")
            slides = res["slides"]
            if only:
                slides = [r for r in slides if r["slide"] in only]
            if shots:
                shots.mkdir(parents=True, exist_ok=True)
                sv = deck.parent / f".qa-shot-{os.getpid()}.html"
                tmp.append(sv)
                sv.write_text(variant(text, head, SHOT_JS), encoding="utf-8")
                for r in slides:
                    png = shots.resolve() / f"slide-{r['slide']:02d}{'-dark' if dark else ''}.png"
                    # --screenshot captures exactly --window-size, so it takes the raw 1280x720
                    subprocess.run([ch, *plain, "--window-size=1280,720", "--virtual-time-budget=4000",
                                    f"--screenshot={png}",
                                    sv.as_uri() + f"?qa_slide={r['index']}"],
                                   capture_output=True, timeout=120)
                    r["png"] = str(png)
        finally:
            for p in tmp:
                p.unlink(missing_ok=True)
    report = {"theme": "dark" if dark else "light", "offline": offline, "deck": deck_issues,
              "slides": slides}
    print(json.dumps(report, indent=1, ensure_ascii=True))
    failing = [r for r in slides if r["issues"]]
    print(f"QA {report['theme']}: {len(slides)} slides, {len(failing)} failing, "
          f"{len(deck_issues)} deck-level problem(s)", file=sys.stderr)
    return 1 if failing or deck_issues else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("deck", type=Path)
    ap.add_argument("--shots", type=Path)
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--word-budget", type=int, default=45)
    ap.add_argument("--slides", help="comma-separated slide numbers to report")
    a = ap.parse_args()
    sel = {int(x) for x in a.slides.split(",")} if a.slides else None
    sys.exit(run(a.deck.resolve(), a.shots, a.dark, a.offline, a.word_budget, sel))

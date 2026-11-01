"""Build every deck figure with deckfig, write deck/figures/<name>.svg, splice into the deck.

  python3 deck/build/build_figs.py [--png DIR] [--no-png] [name ...]

One ``fig_<name>()`` per figure; each returns a ``deckfig.Fig``. ``Fig.svg()`` refuses
anything out of frame (16px pad), text-on-text collisions and lines through text, and any
such refusal fails the build (exit 1). deckfig.py is a verbatim copy of
converged-modeling-patterns/presentations/build/deckfig.py.

Outputs per figure:
  * ``deck/figures/<name>.svg``: standalone file, light tokens from theme.css embedded
  * the same SVG, themed by CSS variables, spliced into ``deck/index.html`` between
    ``<!-- FIG:<name> -->`` and ``<!-- /FIG:<name> -->`` (inline so it follows light/dark and
    the deck stays file:// safe with no fetch)
  * PNG renders in light and dark (default: a fresh temp dir, printed at the end). Look at
    them before calling a figure done.

A marker in the deck with no builder is an error; a builder with no marker yet is a warning.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BUILD = Path(__file__).resolve().parent
DECK_DIR = BUILD.parent
DECK = DECK_DIR / "index.html"
FIGS = DECK_DIR / "figures"
sys.path.insert(0, str(BUILD))
from deckfig import HEAD, MONO, TONE, Fig, FigureError  # noqa: E402

MARK = re.compile(r"(<!-- FIG:([a-z0-9-]+) -->)(.*?)(<!-- /FIG:\2 -->)", re.S)


# ----------------------------------------------------------------------------- figures
SEGMENTS = [  # (number, title lines, minutes, demos, tone) from spec section 5.1
    (0, ["Open", "three doors,", "one room"], 5, "", "ink"),
    (1, ["Discovery", "decision", "factors"], 10, "D1", "flow"),
    (2, ["Strategy A", "age out"], 12, "D2", "flow"),
    (3, ["Strategy B", "dump and", "restore"], 13, "D3", "flow"),
    (4, ["Strategy C", "blue/green", "with fallback"], 14, "D4", "flow"),
    (5, ["Optimization", "model, duality,", "$sql, ETags"], 26, "D5 D6 D7", "cool"),
    (6, ["Recap", "decision", "matrix, Q&A"], 10, "", "ink"),
]


def fig_session_map() -> Fig:
    """The 90-minute session: a time bar to scale, then one card per segment."""
    total = sum(s[2] for s in SEGMENTS)
    f = Fig(1120, 270, f"Session map: seven segments over {total} minutes. Open, discovery, three "
                       "migration strategies (age out, dump and restore, blue/green), optimization, "
                       "and the decision matrix recap")
    x0, x1, gap = 18, 1102, 6
    f.text(x0, 34, f"{total} MINUTES", size=13, weight=600, font=MONO, fill="var(--muted)")
    span = x1 - x0 - gap * (len(SEGMENTS) - 1)
    x = x0
    for n, _, mins, _, tone in SEGMENTS:
        w = span * mins / total
        col = "var(--slate)" if tone == "ink" else TONE[tone][0]
        f.rect(x, 48, w, 22, fill=col, stroke=col, sw=1, rx=4, name=f"bar{n}")
        f.text(x + w / 2, 63.5, str(n), size=12, weight=700, font=MONO, fill="var(--panel)",
               anchor="middle")
        x += w + gap
    cw, cgap, cy, ch = 146, (x1 - x0 - 146 * len(SEGMENTS)) / (len(SEGMENTS) - 1), 92, 104
    for i, (n, lines, mins, demos, tone) in enumerate(SEGMENTS):
        cx = x0 + i * (cw + cgap)
        f.box(cx, cy, cw, ch, lines, tone=tone, size=15, sub_size=13)
        f.text(cx + cw / 2 + 2, cy + ch + 26, f"{mins} min", size=14, font=MONO,
               fill="var(--muted)", anchor="middle")
        if demos:
            col = TONE["cool" if tone == "cool" else "flow"][0]
            f.text(cx + cw / 2 + 2, cy + ch + 50, demos, size=14, weight=600, font=MONO,
                   fill=col, anchor="middle")
    return f


# ----------------------------------------------------------------------------- build
def figures() -> dict:
    return {k[4:].replace("_", "-"): v for k, v in globals().items()
            if k.startswith("fig_") and callable(v)}


def light_tokens() -> str:
    css = (DECK_DIR / "theme.css").read_text(encoding="utf-8")
    m = re.search(r":root\s*\{(.*?)\}", css, re.S)
    return re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)


def standalone(svg: str, w: int, h: int) -> str:
    """Viewable on its own: fixed size, light tokens, paper background (house SVG rules)."""
    style = f"<style>svg{{{' '.join(light_tokens().split())}}}</style>"
    svg = svg.replace("<svg ", f'<svg width="{w}" height="{h}" ', 1)
    svg = svg.replace("</defs>", '</defs><rect width="100%" height="100%" fill="var(--paper)"/>', 1)
    return svg.replace("<defs>", style + "<defs>", 1) + "\n"


def render_pngs(name: str, svg: str, w: int, h: int, out: Path) -> list[Path]:
    ch = next((c for c in ("google-chrome", "google-chrome-stable", "chromium") if shutil.which(c)), None)
    if not ch:
        print("  (no chrome on PATH: PNG render skipped)")
        return []
    pngs = []
    with tempfile.TemporaryDirectory() as td:
        for theme in ("light", "dark"):
            page = Path(td) / f"{name}-{theme}.html"
            page.write_text(
                f'<!doctype html><html data-theme="{theme}"><head><meta charset="utf-8">'
                f'<link rel="stylesheet" href="{(DECK_DIR / "fonts" / "fonts.css").as_uri()}">'
                f'<link rel="stylesheet" href="{(DECK_DIR / "theme.css").as_uri()}">'
                f'<style>body{{margin:0;background:var(--paper)}}svg{{display:block;margin:16px;'
                f'width:{w}px;height:{h}px;outline:1px dashed var(--faint)}}</style></head>'
                f'<body>{svg}</body></html>', encoding="utf-8")
            png = out / f"{name}-{theme}.png"
            subprocess.run([ch, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                            f"--user-data-dir={td}/prof", f"--window-size={w + 32},{h + 32}",
                            "--virtual-time-budget=2000", f"--screenshot={png}", page.as_uri()],
                           capture_output=True, timeout=120)
            pngs.append(png)
    return pngs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("names", nargs="*", help="figures to build (default: all)")
    ap.add_argument("--png", type=Path, help="directory for PNG renders (default: new temp dir)")
    ap.add_argument("--no-png", action="store_true")
    a = ap.parse_args()

    builders = figures()
    names = a.names or sorted(builders)
    unknown = [n for n in names if n not in builders]
    if unknown:
        print(f"unknown figure(s): {', '.join(unknown)}; have {', '.join(sorted(builders))}")
        return 1

    deck = DECK.read_text(encoding="utf-8")
    stale = sorted({m.group(2) for m in MARK.finditer(deck)} - set(builders))
    errors = [f"deck marker FIG:{n} has no fig_{n.replace('-', '_')}()" for n in stale]

    built = {}
    for n in names:
        try:
            fig = builders[n]()
            built[n] = (fig.svg(), fig.w, fig.h)
        except FigureError as ex:
            errors.append(str(ex))
    if errors:
        print("figure build FAILED:\n" + "\n".join(errors))
        return 1

    FIGS.mkdir(exist_ok=True)
    png_dir = None if a.no_png else (a.png or Path(tempfile.mkdtemp(prefix="deckfigs-")))
    if png_dir:
        png_dir.mkdir(parents=True, exist_ok=True)
    for n, (svg, w, h) in built.items():
        (FIGS / f"{n}.svg").write_text(standalone(svg, w, h), encoding="utf-8")
        hits = [m for m in MARK.finditer(deck) if m.group(2) == n]
        if hits:
            deck = MARK.sub(lambda m: m.group(1) + svg + m.group(4) if m.group(2) == n else m.group(0), deck)
            where = f"spliced x{len(hits)}"
        else:
            where = "WARNING: no <!-- FIG:%s --> marker in index.html yet" % n
        line = f"  {n}: figures/{n}.svg ({w}x{h}), {where}"
        if png_dir:
            line += "; png: " + ", ".join(str(p) for p in render_pngs(n, svg, w, h, png_dir))
        print(line)
    DECK.write_text(deck, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

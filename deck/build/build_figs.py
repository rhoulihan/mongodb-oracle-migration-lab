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
import zlib
from pathlib import Path

BUILD = Path(__file__).resolve().parent
DECK_DIR = BUILD.parent
DECK = DECK_DIR / "index.html"
FIGS = DECK_DIR / "figures"
sys.path.insert(0, str(BUILD))
from deckfig import HEAD, MONO, SANS, TONE, Fig, FigureError, Flow, tw  # noqa: E402

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


# ----------------------------------------------------------------------------- helpers
def group(f: Fig, cls: str = "", **attrs):
    """Open an SVG <g> (a Reveal fragment, or an auto-animate unit); close with f.raw('</g>')."""
    extra = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in attrs.items())
    f.raw(f'<g{f" class={chr(34)}{cls}{chr(34)}" if cls else ""}{extra}>')


def overlay(f: Fig, data_id: str, cls: str, x, y, w, h, extra: str = "", attrs: str = "") -> None:
    """A shape that Reveal auto-animate must move or resize. Reveal measures matched elements
    with offsetLeft/offsetWidth, which SVG shapes do not have, so a shape inside the SVG never
    morphs. The deck gets an HTML box laid over the SVG (percent of the viewBox, behind the SVG
    text); the SVG keeps a twin of it for the standalone file and the PNG check, hidden in the
    deck by .fig-stack .overlay-twin."""
    if not hasattr(f, "overlays"):
        f.overlays = []
    tone = {"cool": "cool", "flow": "flow", "hot": "hot", "ring": "hot"}[cls]
    f.raw('<g class="overlay-twin">')
    if cls == "ring":
        f.circle(x + w / 2, y + h / 2, w / 2 - 1.2, fill="none", stroke=TONE[tone][0], sw=2.4)
    elif w > 1:
        f.rect(x, y, w, h, fill=TONE[tone][1], stroke=TONE[tone][0], sw=1.8, rx=8, name=data_id)
    f.raw("</g>")
    pct = lambda v, t: f"{v / t * 100:.3f}%"
    f.overlays.append(f'<div class="ov {cls}{" " + extra if extra else ""}" data-id="{data_id}"{" " + attrs if attrs else ""} style="left:{pct(x, f.w)};top:{pct(y, f.h)};'
                      f'width:{pct(w, f.w)};height:{pct(h, f.h)}"></div>')


def door(f: Fig, x, y, w, h, tone: str, locked: bool = False) -> None:
    """A door glyph: arched top, soft fill, a knob (a padlock on a door that locks behind you)."""
    col, soft = TONE[tone]
    r = w / 2
    f.path(f"M{x},{y + h} V{y + r} A{r},{r} 0 0 1 {x + w},{y + r} V{y + h} Z",
           [(x, y), (x + w, y + h)], stroke=col, sw=2.2, fill=soft, name="door", seg=False)
    f.circle(x + w - 11, y + h * 0.62, 3.6, fill=col)
    if locked:
        lx, ly = x + w / 2, y + h * 0.40
        f.path(f"M{lx - 6},{ly} V{ly - 5} A6,6 0 0 1 {lx + 6},{ly - 5} V{ly}",
               [(lx - 6, ly - 11), (lx + 6, ly)], stroke=col, sw=2, name="shackle", seg=False)
        f.rect(lx - 9, ly, 18, 13, fill=col, stroke=col, sw=1, rx=2, name="lock")


def clock(f: Fig, cx, cy, r, tone: str) -> None:
    """A TTL clock: ring and two hands."""
    col = TONE[tone][0]
    f.raw(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="var(--panel)" stroke="{col}" stroke-width="2"/>')
    f.track(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, "clock")
    f.line(cx, cy, cx, cy - r * 0.62, stroke=col, sw=2, name="hand", seg=False)
    f.line(cx, cy, cx + r * 0.5, cy, stroke=col, sw=2, name="hand", seg=False)


# ----------------------------------------------------------------------------- segment 0
DOORS = [  # letter, title, two sub lines, tone, door x offset, door y offset, locked
    ("A", "Age out", ["near-zero downtime, slow", "old system becomes the archive"], "flow", 40, 124, False),
    ("B", "Dump and restore", ["planned downtime, fast", "one-way once writes resume"], "hot", 620, 214, True),
    ("C", "Blue/green", ["near-zero downtime, reversible", "the most moving parts"], "cool", 40, 18, False),
]


def fig_three_doors() -> Fig:
    """Three strategies on two axes. Each door is a Reveal fragment (A, then B, then C)."""
    f = Fig(1120, 412, "Three migration strategies plotted on downtime and reversibility. Age out: "
                       "near-zero downtime, slow, the old system becomes the archive. Dump and restore: "
                       "planned downtime, fast, one-way once writes resume. Blue/green: near-zero "
                       "downtime, reversible, the most moving parts")
    px, py, pw, ph = 168, 36, 920, 320
    base = py + ph
    f.line(px, base, px + pw, base, stroke="var(--faint)", sw=1.6, arrow=True, name="xaxis")
    f.line(px, base, px, py - 14, stroke="var(--faint)", sw=1.6, arrow=True, name="yaxis")
    f.text(px - 16, py + 6, "walk back", size=14, fill="var(--muted)", anchor="end")
    f.text(px - 16, base, "one-way", size=14, fill="var(--muted)", anchor="end")
    f.text(px - 16, py + ph / 2 + 5, "Reversibility", size=16, weight=700, font=HEAD, anchor="end")
    f.text(px, base + 28, "near zero", size=14, fill="var(--muted)")
    f.text(px + pw, base + 28, "planned window", size=14, fill="var(--muted)", anchor="end")
    f.text(px + pw / 2, base + 28, "Downtime", size=16, weight=700, font=HEAD, anchor="middle")
    for i, (letter, title, subs, tone, dx, dy, locked) in enumerate(DOORS, 1):
        group(f, "fragment", data_fragment_index=i)
        x, y = px + dx, py + dy
        door(f, x, y, 56, 86, tone, locked)
        tx = x + 76
        f.text(tx, y + 24, f"{letter}  {title}", size=19, weight=800, font=HEAD, fill=TONE[tone][0])
        for k, s in enumerate(subs):
            f.text(tx, y + 50 + k * 21, s, size=15, fill="var(--muted)")
        f.raw("</g>")
    return f


def fig_on_ramp() -> Fig:
    """Wire compatibility gets the app in; the converged engine is where it ends up."""
    f = Fig(1120, 300, "The on-ramp: the app keeps its code and MongoDB driver and changes only the "
                       "connection string to the Oracle API for MongoDB. The destination: Oracle AI "
                       "Database 26ai, one engine for JSON, SQL and the optimizer")
    fl = Flow(f)
    y, h = 96, 104
    fl.node("app", 18, y, 300, h, ["Your app", "same code,", "same MongoDB driver"], tone="ink", size=18, sub=15)
    fl.node("api", 410, y, 300, h, ["Oracle API for MongoDB", "speaks the MongoDB", "wire protocol"], tone="flow", size=18, sub=15)
    fl.node("db", 802, y, 300, h, ["Oracle AI Database 26ai", "JSON, SQL and the optimizer", "in one engine"], tone="cool", size=18, sub=15)
    fl.edge("app", "api", 364, tone="flow")
    fl.edge("api", "db", 756, tone="cool")
    f.text(364, y - 14, "new connection string", size=14, weight=600, font=MONO, fill="var(--flow)", anchor="middle")
    # brackets: on-ramp over the first two boxes, destination over the third
    for x0, x1, label, col in ((18, 710, "THE ON-RAMP", "var(--flow)"), (802, 1102, "THE DESTINATION", "var(--cool)")):
        f.path(f"M{x0},{58} V{48} H{x1} V{58}", [(x0, 48), (x1, 58)], stroke=col, sw=1.6, name="bracket", seg=False)
        f.text((x0 + x1) / 2, 36, label, size=14, weight=700, font=MONO, fill=col, anchor="middle")
    f.box(18, 228, 1084, 50, ["Post 46: my own app, Atlas free to ADB Free. One gap ($near), closed with $sql."],
          tone="hot", size=16)
    return f


# ----------------------------------------------------------------------------- segment 1
YEAR = 365 * 86400
LIFE = [  # collections, kind, lifetime (s) or None (open-ended), clock label, verdict, verdict tone
    ("subscribers, accounts", "entity", None, "", "move it", "cool"),
    ("catalog, regions", "entity", None, "", "move it", "cool"),
    ("orders", "event", 7 * YEAR, "retention policy", "archive, or move it", "flow"),
    ("orderEvents", "event", 7 * 86400, "TTL 7 days", "let it expire", "hot"),
    ("carts", "event", 120, "TTL 120 s", "let it expire", "hot"),
]
TICKS = [(60, "1 min"), (3600, "1 hour"), (86400, "1 day"), (7 * 86400, "1 week"), (YEAR, "1 year"),
         (10 * YEAR, "10 years")]


def fig_workload_inventory() -> Fig:
    """How long each collection's data stays useful (log time), and what that means for the move."""
    import math
    f = Fig(1120, 400, "Workload inventory: subscribers, accounts, catalog and regions are entity data "
                       "that lives for years, so they move. Orders age out under a retention policy. "
                       "Order events (TTL 7 days) and carts (TTL 120 seconds) expire on their own and "
                       "never need to move")
    x0, x1 = 272, 830
    lo, hi = math.log10(30), math.log10(10 * YEAR)

    def sx(sec):
        return x0 + (math.log10(sec) - lo) / (hi - lo) * (x1 - x0)

    f.text(18, 34, "DATA", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(x0, 34, "STAYS USEFUL FOR", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(870, 34, "IN THE MIGRATION", size=13, weight=700, font=MONO, fill="var(--muted)")
    top, rh = 56, 56
    for i, (name, kind, life, clk, verdict, vt) in enumerate(LIFE):
        y = top + i * rh
        cy = y + rh / 2
        tone = "cool" if kind == "entity" else "flow"
        col, soft = TONE[tone]
        f.rect(18, y + 8, 4, rh - 16, fill=col, stroke=col, sw=0, rx=2, name="accent")
        f.text(32, cy - 3, name, size=16, weight=600, font=MONO)
        f.text(32, cy + 16, "entity data" if kind == "entity" else "event data", size=13, fill="var(--muted)")
        end = sx(life) if life else x1
        f.rect(x0, cy - 9, end - x0, 18, fill=soft, stroke=col, sw=1.4, rx=4, name="bar")
        if life is None:
            f.text(x1 - 10, cy + 5, "as long as the customer", size=13, weight=600, fill=col, anchor="end")
        elif clk.startswith("TTL"):
            clock(f, end + 18, cy, 10, "hot")
            f.text(end + 36, cy + 5, clk, size=14, weight=600, font=MONO, fill="var(--hot)")
        else:
            f.text(end - 10, cy + 5, clk, size=13, weight=600, fill=col, anchor="end")
        vc, vs = TONE[vt]
        f.rect(870, y + 12, 232, rh - 24, fill=vs, stroke=vc, sw=1.4, rx=16, name="verdict")
        f.text(986, cy + 6, verdict, size=16, weight=700, fill=vc, anchor="middle")
    base = top + len(LIFE) * rh + 8
    f.line(x0, base, x1 + 8, base, stroke="var(--faint)", sw=1.3, arrow=True, name="axis")
    for sec, lab in TICKS:
        xx = sx(sec)
        f.line(xx, base, xx, base + 6, stroke="var(--faint)", sw=1.2, name="tick")
        f.text(xx, base + 24, lab, size=13, font=MONO, fill="var(--muted)", anchor="middle")
    return f


LANDMINES = [  # field, BSON type, value on MongoDB, how it reads back, what changes for queries
    ("catalog.skuPattern", "regex", "/^SKU-DEV-[0-9]{4}$/", '{"$regularExpression": ...}',
     "{$type: 'regex'} is rejected"),
    ("orderEvents.ts", "Timestamp", "Timestamp(t, i)", '{"$timestamp": ...}',
     "{$type: 'timestamp'} is rejected"),
    ("orders.version", "Int64", "2^53 + 1", "2^53 + 1, exact", "$inc by 1 stores 2^53"),
    ("catalog.price", "Decimal128", '"19.00"', '"19"', "same value, trailing zeros gone"),
    ("orders.lines", "array", "[{...}, {...}]", "[{...}, {...}]", "$type misses the elements"),
]


def fig_type_landmines() -> Fig:
    """Five BSON landmines: what MongoDB holds, what Oracle reads back, what a query sees."""
    f = Fig(1120, 444, "BSON type landmines. A regex and a BSON Timestamp read back from Oracle as "
                       "tagged objects, and $type queries on them are rejected. An Int64 above 2 to the "
                       "53 restores exactly, but $inc loses exactness. Decimal128 keeps its value and "
                       "drops trailing zeros. On an array, $type does not match the elements")
    cols = [(18, 320, "ON MONGODB (BSON)"), (378, 330, "READS BACK FROM ORACLE"), (748, 354, "WHAT A QUERY SEES")]
    for x, w, h in cols:
        f.text(x, 34, h, size=13, weight=700, font=MONO, fill="var(--muted)")
    top, rh = 50, 60
    for i, (field, typ, src, back, query) in enumerate(LANDMINES):
        y = top + i * rh
        cy = y + (rh - 8) / 2
        for k, (x, w, _) in enumerate(cols):
            hot = k == 2
            f.rect(x, y, w, rh - 8, fill="var(--hot-soft)" if hot else "var(--panel)",
                   stroke="var(--hot)" if hot else "var(--hairline)", sw=1.4, rx=6, name="cell")
        f.text(30, cy - 5, f"{field} · {typ}", size=13, fill="var(--muted)")
        f.text(30, cy + 15, src, size=15, font=MONO, weight=600)
        f.text(390, cy + 6, back, size=15, font=MONO, fill="var(--cool)" if i < 4 else "var(--ink)")
        f.text(760, cy + 6, query, size=15, weight=600, fill="var(--hot)")
        for xa, xb in ((338, 378), (708, 748)):
            f.line(xa + 6, cy, xb - 6, cy, stroke="var(--faint)", sw=1.6, arrow=True, name="arrow")
    yb = top + len(LANDMINES) * rh + 10
    f.rect(18, yb, 1084, 54, fill="var(--panel)", stroke="var(--hot)", sw=1.8, rx=27, name="callout")
    f.text(560, yb + 34, "Reads the same. Queries differently.", size=22, weight=800, font=HEAD,
           fill="var(--hot)", anchor="middle")
    return f


MATRIX = [  # factor, marks for A, B, C: 2 pushes toward, 1 also works, 0 no
    ("Data life cycle is short (days to months)", (2, 0, 0)),
    ("A downtime window fits the data volume", (0, 2, 0)),
    ("No downtime allowed, or rollback is required", (0, 0, 2)),
    ("Legal retention on the old data", (2, 1, 1)),
    ("Heavy joins and aggregations hurt today", (2, 2, 2)),
    ("Team can run two systems for a while", (2, 0, 2)),
    ("Budget for replication tools and a second stack", (0, 0, 2)),
]


def fig_decision_matrix() -> Fig:
    """The decision factors and which door each one pushes toward (outline section 1)."""
    f = Fig(1120, 462, "Decision matrix. Short data life cycle pushes toward age out. A downtime window "
                       "that fits the data volume pushes toward dump and restore. No downtime or a "
                       "required rollback pushes toward blue/green. Legal retention fits age out, or "
                       "moving everything. Heavy join and aggregation pain fits any door with the "
                       "optimization track. Running two systems is needed by age out and blue/green. "
                       "Budget for replication tools fits blue/green")
    fx, cx = 18, [700, 834, 968]
    heads = [("A", "Age out", "flow"), ("B", "Dump/restore", "hot"), ("C", "Blue/green", "cool")]
    f.text(fx, 54, "IF THIS IS TRUE", size=13, weight=700, font=MONO, fill="var(--muted)")
    for x, (l, t, tone) in zip(cx, heads):
        f.text(x, 36, l, size=20, weight=800, font=HEAD, fill=TONE[tone][0], anchor="middle")
        f.text(x, 56, t, size=14, weight=600, fill="var(--muted)", anchor="middle")
    top, rh = 72, 48
    for i, (factor, marks) in enumerate(MATRIX):
        y = top + i * rh
        if i % 2 == 0:
            f.rect(fx, y, 1084, rh, fill="var(--chip)", stroke="var(--chip)", sw=0, rx=6, name="band")
        cy = y + rh / 2
        f.text(fx + 14, cy + 6, factor, size=17)
        for x, m, (_, _, tone) in zip(cx, marks, heads):
            col = "var(--cool)" if i == 4 else TONE[tone][0]
            if m == 2:
                f.circle(x, cy, 10, fill=col)
            elif m == 1:
                f.circle(x, cy, 9, fill="none", stroke=col, sw=2.4)
    ly = top + len(MATRIX) * rh + 30
    f.circle(fx + 24, ly - 5, 9, fill="var(--ink)")
    f.text(fx + 42, ly, "pushes toward this door", size=15, fill="var(--muted)")
    f.circle(fx + 290, ly - 5, 8, fill="none", stroke="var(--ink)", sw=2.2)
    f.text(fx + 308, ly, "also works", size=15, fill="var(--muted)")
    f.circle(fx + 450, ly - 5, 9, fill="var(--cool)")
    f.text(fx + 468, ly, "any door, plus the optimization track", size=15, fill="var(--muted)")
    return f


# ----------------------------------------------------------------------------- segment 2
AGE_STATES = {  # state: (old-system box width, step index on the track, old-system sub line)
    "day": (640, 0, "every order before the cutoff, read only"),
    "mid": (300, 1, "older orders, shrinking"),
    "end": (0, 2, ""),
}
TRACK = ["Day N: cutoff", "Old orders age out", "Retention passes: switch it off"]


def _ageout_router(state: str) -> Fig:
    """App tier routes by cutoff. Same element ids in all three states, so Reveal auto-animate
    morphs one into the next: the old system shrinks to zero."""
    legacy_w, step, sub = AGE_STATES[state]
    f = Fig(1120, 420, {
        "day": "Age out, day N: the order service routes reads by the cutoff. New orders and the "
               "moved entity data are on Oracle; every older order stays in MongoDB, read only",
        "mid": "Age out, later: old orders age out of MongoDB under the retention policy, so the "
               "MongoDB archive shrinks while Oracle grows",
        "end": "Age out, retention passed: MongoDB holds nothing the business needs and is switched "
               "off; every read goes to Oracle",
    }[state])
    bx, rx = 18, 430
    f.box(bx, 128, 270, 112, ["Order service", "router: by placedAt", "vs. the cutoff"], tone="ink",
          size=19, sub_size=15, name="app")
    # Oracle: always there, grows a little over time
    ow = {"day": 560, "mid": 620, "end": 672}[state]
    overlay(f, "ar-oracle", "cool", rx, 54, ow, 104)
    f.text(rx + 20, 92, "Oracle AI Database 26ai", size=19, weight=800, font=HEAD, fill="var(--cool)")
    f.text(rx + 20, 118, "new orders from day N", size=15, fill="var(--muted)")
    f.text(rx + 20, 140, "+ subscribers, accounts, catalog", size=15, fill="var(--muted)")
    # app -> oracle, app -> legacy, through one lane
    lane = 360
    f.path(f"M{bx + 270},{170} H{lane} V{106} H{rx - 2}", [(bx + 270, 170), (lane, 106), (rx - 2, 106)],
           stroke="var(--cool)", sw=2, arrow=True, name="to-oracle")
    if legacy_w:
        f.path(f"M{bx + 270},{198} H{lane} V{282} H{rx - 2}", [(bx + 270, 198), (lane, 282), (rx - 2, 282)],
               stroke="var(--flow)", sw=2, arrow=True, dash="6 4", name="to-legacy")
        overlay(f, "ar-legacy", "flow", rx, 230, legacy_w, 104)
        f.text(rx + 20, 268, "MongoDB archive", size=19, weight=800, font=HEAD, fill="var(--flow)")
        f.text(rx + 20, 294, sub, size=15, fill="var(--muted)")
        if state == "day":
            clock(f, rx + 30, 316 - 4, 8, "hot")
            f.text(rx + 46, 316, "carts and events expire here", size=14, fill="var(--hot)")
    else:
        # the archive box shrinks to nothing (auto-animate target); a dashed ghost marks where it was
        overlay(f, "ar-legacy", "flow", rx, 230, 0.5, 104, extra="gone")
        f.rect(rx, 230, 300, 104, fill="none", stroke="var(--faint)", sw=1.6, rx=8, dash="6 5", name="legacy-gone")
        f.text(rx + 20, 276, "MongoDB: switched off", size=19, weight=800, font=HEAD, fill="var(--faint)")
        f.text(rx + 20, 302, "one database again", size=15, fill="var(--muted)")
    # time track
    ty, tx0, tx1 = 384, 120, 1000
    f.line(tx0, ty, tx1, ty, stroke="var(--hairline)", sw=3, name="track", seg=False)
    for k, lab in enumerate(TRACK):
        x = tx0 + k * (tx1 - tx0) / 2
        on = k == step
        f.circle(x, ty, 7, fill="var(--ink)" if k <= step else "var(--hairline)")
        anchor = "start" if k == 0 else ("end" if k == 2 else "middle")
        f.text(x + (-8 if k == 0 else (8 if k == 2 else 0)), ty - 16, lab, size=14, weight=700 if on else 400,
               fill="var(--ink)" if on else "var(--faint)", anchor=anchor)
    cx = tx0 + step * (tx1 - tx0) / 2
    overlay(f, "ar-now", "ring", cx - 12.2, ty - 12.2, 24.4, 24.4)
    auto_ids(f, "ar")
    return f


def auto_ids(f: Fig, prefix: str) -> None:
    """Give every untagged element a data-id from its own markup, so an element drawn the same
    in two auto-animate states matches (and stays put) instead of fading out and back in.
    Arrow marker ids differ per figure, so they are left out of the key."""
    seen: dict[str, int] = {}
    for i, el in enumerate(f.els):
        if "data-id=" in el or not el.startswith("<") or el.startswith("</"):
            continue
        key = re.sub(r'url\(#[^)]*\)', "", el)
        h = f"{prefix}-{zlib.crc32(key.encode()) & 0xFFFFFF:06x}"
        n = seen.get(h, 0)
        seen[h] = n + 1
        sp = el.index(" ")
        f.els[i] = el[:sp] + f' data-id="{h}{"-" + str(n) if n else ""}"' + el[sp:]



STACK = ["Patch cycle", "Login model", "Attack surface", "Backups", "On-call runbook"]


def fig_two_stacks() -> Fig:
    """Age out's cost: the same operational stack, twice, for the whole retention window."""
    f = Fig(1120, 400, "The cost of age out: two full operational stacks, one for the MongoDB archive and "
                       "one for Oracle, each with its own patch cycle, login model, attack surface, backups "
                       "and on-call runbook, for every year of the retention window")
    w, lh, gap, top = 330, 46, 8, 74
    cols = [(150, "MongoDB archive", "flow"), (640, "Oracle", "cool")]
    for x, title, tone in cols:
        col, soft = TONE[tone]
        f.rect(x, 24, w, 40, fill=soft, stroke=col, sw=1.8, rx=8, name="head")
        f.text(x + w / 2, 50, title, size=19, weight=800, font=HEAD, fill=col, anchor="middle")
        for i, layer in enumerate(STACK):
            y = top + i * (lh + gap)
            f.rect(x, y, w, lh, fill="var(--panel)", stroke="var(--hot)", sw=1.4, rx=6, name="layer")
            f.text(x + w / 2, y + lh / 2 + 6, layer, size=17, weight=600, anchor="middle")
    mid = (150 + w + 640) / 2
    f.text(mid, top + 2 * (lh + gap) + lh / 2 + 12, "×2", size=34, weight=800, font=HEAD, fill="var(--hot)",
           anchor="middle")
    yb = top + len(STACK) * (lh + gap) + 14
    f.text(560, yb + 14, "for every year of the retention window", size=17, weight=600, fill="var(--hot)",
           anchor="middle")
    return f


def fig_umt_chain() -> Fig:
    """Greenfield on Oracle: canonical form first, then projections, then the shapes consumers read."""
    f = Fig(1120, 360, "Model the domain, project the access: the canonical form (entities, properties, "
                       "relationships) is stored as projections (rows on tables, embedded documents, graph "
                       "edges), and each consumer reads a projected shape: a document for the app (a duality "
                       "view over the rows), a rowset for reports, a graph result for hierarchy walks")
    fl = Flow(f)
    f.text(18, 34, "CANONICAL FORM", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(420, 34, "PROJECTIONS", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(850, 34, "PROJECTED SHAPES", size=13, weight=700, font=MONO, fill="var(--muted)")
    fl.node("canon", 18, 124, 270, 132, ["Telecom domain", "subscriber, order, device:", "entities, properties,", "relationships"],
            tone="cool", size=18, sub=15)
    ys = [52, 150, 248]
    proj = [["Rows on tables"], ["Embedded documents"], ["Graph edges"]]
    shapes = [["Rowset", "for reports"], ["Order document", "for the app"], ["Graph result", "for hierarchy walks"]]
    for i, y in enumerate(ys):
        fl.node(f"p{i}", 420, y, 280, 80, proj[i], tone="flow", size=18, sub=15)
        fl.node(f"s{i}", 850, y, 252, 80, shapes[i], tone="ink", size=18, sub=15)
    for i, y in enumerate(ys):
        fl.edge("canon", f"p{i}", 354, tone="cool")
    fl.edge("p0", "s0", 770, tone="flow")
    fl.edge("p1", "s1", 770, tone="flow", ay=200, by=200)
    fl.edge("p2", "s2", 770, tone="flow")
    # the duality view: rows on tables projected as the app's document
    fl.edge("p0", "s1", 742, tone="cool", ay=106, by=170, dash="6 4")
    f.text(796, 162, "duality view", size=13, weight=600, font=MONO, fill="var(--cool)", anchor="middle")
    return f


def fig_ageout_router() -> Fig:
    return _ageout_router("day")


def fig_ageout_router_mid() -> Fig:
    return _ageout_router("mid")


def fig_ageout_router_end() -> Fig:
    return _ageout_router("end")


# ----------------------------------------------------------------------------- segment 3
WINDOW = [  # step, sub line, illustrative width (not to scale), tone
    ("Stop writes", "app down or read only", 24, "hot"),
    ("Dump", "mongodump --archive --gzip", 150, "flow"),
    ("Restore", "mongorestore, in parallel", 236, "flow"),
    ("Indexes", "rebuild or verify", 104, "flow"),
    ("Validate", "counts, $type, the app's queries", 132, "flow"),
    ("Rollback buffer", "time to go back", 132, "hot"),
]


def fig_window_math() -> Fig:
    """The maintenance window as a stacked timeline. Each bar is a fragment that grows in
    from the left (CSS .fragment.custom.bar-grow), so the window builds one step per click."""
    f = Fig(1120, 400, "The maintenance window as a stacked timeline: stop writes, dump, restore, "
                       "rebuild or verify indexes, validate, then a rollback buffer. The go or no-go "
                       "call comes after validation. The whole window is sized from a rehearsal")
    x0, top, rh = 300, 62, 46
    f.text(18, 34, "STEP", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(x0, 34, "TIME IN THE WINDOW (ILLUSTRATIVE)", size=13, weight=700, font=MONO, fill="var(--muted)")
    x = x0
    gate = None
    for i, (step, sub, w, tone) in enumerate(WINDOW):
        y = top + i * rh
        col, soft = TONE[tone]
        f.text(18, y + 17, step, size=17, weight=700, font=HEAD)
        f.text(18, y + 36, sub, size=13, font=MONO if sub.startswith("mongo") else SANS, fill="var(--muted)")
        group(f, "fragment custom bar-grow", data_fragment_index=i + 1)
        f.rect(x, y + 6, w, 28, fill=soft, stroke=col, sw=1.6, rx=5,
               dash="6 4" if step.startswith("Rollback") else None, name="bar")
        f.raw("</g>")
        x += w
        if step == "Validate":
            gate = x
    # the go / no-go call, after validation
    yb = top + len(WINDOW) * rh
    f.line(gate, top - 4, gate, top + (len(WINDOW) - 1) * rh + 2, stroke="var(--ink)", sw=1.6, dash="4 4", name="gate", seg=False)
    f.text(gate + 10, top + 12, "go / no-go", size=14, weight=700, font=MONO, fill="var(--ink)")
    # the window bracket
    f.path(f"M{x0},{yb + 4} V{yb + 14} H{x} V{yb + 4}", [(x0, yb + 4), (x, yb + 14)], stroke="var(--hot)",
           sw=1.8, name="bracket", seg=False)
    f.text((x0 + x) / 2, yb + 40, "your window", size=18, weight=800, font=HEAD, fill="var(--hot)",
           anchor="middle")
    return f



def fig_validation_gate() -> Fig:
    """Three checks before the flip; equal counts are only the first."""
    f = Fig(1120, 380, "The validation gate: compare counts at the dump snapshot, run a $type "
                       "differential per field on both sides, and replay the app's own queries on both "
                       "sides; only then flip the connection string. In this lab, catalog.skuPattern "
                       "reads back the same on Oracle, but a $type regex query finds 300 documents on "
                       "MongoDB and is rejected on Oracle")
    fl = Flow(f)
    y, h, w = 40, 112, 236
    xs = [18, 300, 582, 864]
    fl.node("g1", xs[0], y, w, h, ["1  Counts", "at the dump snapshot", "needed, not enough"], tone="flow", size=18, sub=15)
    fl.node("g2", xs[1], y, w, h, ["2  $type check", "every field,", "both sides"], tone="flow", size=18, sub=15)
    fl.node("g3", xs[2], y, w, h, ["3  App's queries", "same filters,", "same results?"], tone="flow", size=18, sub=15)
    fl.node("go", xs[3], y, 238, h, ["Flip", "the connection", "string"], tone="cool", size=18, sub=15)
    for a, b, lane in (("g1", "g2", 277), ("g2", "g3", 559), ("g3", "go", 841)):
        fl.edge(a, b, lane, tone="flow")
    # what check 2 caught in this lab
    py = 196
    f.text(18, py, "CAUGHT BY CHECK 2 IN THIS LAB", size=13, weight=700, font=MONO, fill="var(--muted)")
    cy, ch = py + 16, 132
    f.rect(18, cy, 530, ch, fill="var(--cool-soft)", stroke="var(--cool)", sw=1.4, rx=8, name="reads")
    f.text(40, cy + 34, "Read the document", size=17, weight=700, font=HEAD, fill="var(--cool)")
    f.text(40, cy + 66, 'skuPattern: /^SKU-DEV-[0-9]{4}$/', size=15, weight=600, font=MONO)
    f.text(40, cy + 98, "looks the same on both sides", size=15, fill="var(--muted)")
    f.rect(572, cy, 530, ch, fill="var(--hot-soft)", stroke="var(--hot)", sw=1.4, rx=8, name="query")
    f.text(594, cy + 34, "Query by type", size=17, weight=700, font=HEAD, fill="var(--hot)")
    f.text(594, cy + 66, "{skuPattern: {$type: 'regex'}}", size=15, weight=600, font=MONO)
    f.text(594, cy + 98, "MongoDB: 300 documents.  Oracle: rejected.", size=15, weight=600, fill="var(--hot)")
    return f


def fig_one_way_door() -> Fig:
    """Dump and restore locks once writes land on Oracle; a read-only soak moves the lock later."""
    f = Fig(1120, 332, "The one-way door, delayed. During the window and a read-only soak on Oracle, "
                       "MongoDB stays frozen, so going back is just pointing the app at MongoDB again. "
                       "Once writes open on Oracle the door locks: going back means losing those writes "
                       "or exporting them by hand. Decide in advance how much you would replay")
    xa, xb, xc, xd = 18, 380, 742, 1102
    by, bh = 166, 76
    phases = [(xa, xb, "The window", "dump, restore, validate", "hot"),
              (xb, xc, "Read-only soak", "Oracle serves reads; MongoDB frozen", "flow"),
              (xc, xd, "Writes open on Oracle", "new data exists only here", "cool")]
    for x0, x1, title, sub, tone in phases:
        col, soft = TONE[tone]
        f.rect(x0 + 4, by, x1 - x0 - 8, bh, fill=soft, stroke=col, sw=1.6, rx=8, name="phase")
        f.text(x0 + 22, by + 32, title, size=18, weight=800, font=HEAD, fill=col)
        f.text(x0 + 22, by + 58, sub, size=15, fill="var(--muted)")
    # the lock, at the moment writes open
    door(f, xc - 28, by - 98, 56, 86, "hot", locked=True)
    f.text(xc + 42, by - 46, "the lock", size=16, weight=700, font=MONO, fill="var(--hot)")
    # walk back vs. the way back after the lock
    for x0, x1, label, col in ((xa + 4, xc - 44, "Walk back: point the app at MongoDB. Nothing lost.", "var(--cool)"),
                               (xc + 44, xd - 4, "Way back: lose writes or export them", "var(--hot)")):
        f.path(f"M{x0},{by - 104} V{by - 114} H{x1} V{by - 104}", [(x0, by - 114), (x1, by - 104)],
               stroke=col, sw=1.8, name="bracket", seg=False)
        f.text((x0 + x1) / 2, by - 126, label, size=14 if "Way" in label else 15, weight=700, fill=col, anchor="middle")
    # the soak is what delays the lock
    f.path(f"M{xb + 4},{by + bh + 12} V{by + bh + 22} H{xc - 4} V{by + bh + 12}",
           [(xb + 4, by + bh + 12), (xc - 4, by + bh + 22)], stroke="var(--flow)", sw=1.8, name="soak", seg=False)
    f.text((xb + xc) / 2, by + bh + 46, "the soak moves the lock later", size=15, weight=700,
           fill="var(--flow)", anchor="middle")
    return f


# ----------------------------------------------------------------------------- segment 4
def ov(f: Fig, data_id: str, kind: str, tone: str, x, y, w, h) -> None:
    """Like overlay(), for the blue/green figure's moving parts: a solid wire (``wire``) or an
    arrowhead pointing right or left (``head-r``, ``head-l``). tone is flow, cool or idle."""
    if not hasattr(f, "overlays"):
        f.overlays = []
    col = "var(--faint)" if tone == "idle" else TONE[tone][0]
    f.raw('<g class="overlay-twin">')
    if kind == "wire":
        f.rect(x, y, w, h, fill=col, stroke=col, sw=0, rx=3, name=data_id)
    else:
        pts = ([(x, y), (x + w, y + h / 2), (x, y + h)] if kind == "head-r"
               else [(x + w, y), (x, y + h / 2), (x + w, y + h)])
        d = "M" + " L".join(f"{a:.1f},{b:.1f}" for a, b in pts) + " Z"
        f.path(d, pts, stroke=col, sw=0, fill=col, name=data_id, seg=False)
    f.raw("</g>")
    pct = lambda v, t: f"{v / t * 100:.3f}%"
    f.overlays.append(f'<div class="ov {kind} t-{tone}" data-id="{data_id}" style="left:{pct(x, f.w)};'
                      f'top:{pct(y, f.h)};width:{pct(w, f.w)};height:{pct(h, f.h)}"></div>')


BG_STATES = {  # state: app wire x, pipe tone, head, pipe label, under-pipe label, blue sub, green sub, step
    "fwd": (218, "flow", "head-r", "forward: every change", "lag: seconds, falling",
            "live: takes every write", "initial load, then changes", 0),
    "cut": (902, "idle", None, "drain to lag 0, stop", "the app flips",
            "frozen: no new writes", "takes every write now", 1),
    "rev": (902, "cool", "head-l", "reverse: the way back", "fallback stays warm",
            "fallback: kept in step", "live: takes every write", 2),
}
BG_TRACK = ["Sync live", "Cutover", "Fallback path"]


def _bluegreen(state: str) -> Fig:
    """Blue (MongoDB) and green (Oracle) both live. Same data-ids in all three states, so Reveal
    auto-animate slides the app's wire from blue to green at cutover and the replication arrow
    turns around (the forward head fades out, the reverse head fades in)."""
    wx, ptone, head, plabel, ulabel, bsub, gsub, step = BG_STATES[state]
    f = Fig(1120, 420, {
        "fwd": "Blue/green, sync live: the app writes to blue (MongoDB); after the initial load, every "
               "change replicates forward to green (Oracle) and the lag falls toward zero",
        "cut": "Blue/green, cutover: replication drains to lag zero and stops, and the app's connection "
               "string flips from blue to green",
        "rev": "Blue/green, fallback path: the app writes to green (Oracle) and replication runs in "
               "reverse, so blue (MongoDB) stays in step and a flip back loses nothing",
    }[state])
    f.box(18, 24, 1084, 64, ["Order service", "same code; only the connection string changes"],
          tone="ink", size=19, sub_size=15, name="app")
    bx, gx, y, w, h = 18, 702, 230, 400, 116
    f.rect(bx, y, w, h, fill="var(--flow-soft)", stroke="var(--flow)", sw=1.8, rx=8, name="blue")
    f.text(bx + 22, y + 38, "Blue: MongoDB", size=20, weight=800, font=HEAD, fill="var(--flow)")
    f.text(bx + 22, y + 70, bsub, size=16, fill="var(--muted)")
    f.rect(gx, y, w, h, fill="var(--cool-soft)", stroke="var(--cool)", sw=1.8, rx=8, name="green")
    f.text(gx + 22, y + 38, "Green: Oracle 26ai", size=20, weight=800, font=HEAD, fill="var(--cool)")
    f.text(gx + 22, y + 70, gsub, size=16, fill="var(--muted)")
    # the app's connection: a wire from the app bar down to the database it writes to
    ov(f, "bg-wire", "wire", "flow" if state == "fwd" else "cool", wx - 3, 92, 6, y - 96)
    f.text(wx + 16 if state == "fwd" else wx - 16, 168, "connection string", size=14, weight=600, font=MONO,
           fill="var(--flow)" if state == "fwd" else "var(--cool)", anchor="start" if state == "fwd" else "end")
    # replication pipe between the two
    py = 286
    ov(f, "bg-pipe", "wire", ptone, 444, py - 3, 232, 6)
    if head == "head-r":
        ov(f, "bg-head-fwd", "head-r", ptone, 676, py - 11, 20, 22)
    elif head == "head-l":
        ov(f, "bg-head-rev", "head-l", ptone, 424, py - 11, 20, 22)
    pcol = "var(--faint)" if ptone == "idle" else TONE[ptone][0]
    f.text(560, py - 22, plabel, size=14, weight=700, font=MONO, fill=pcol, anchor="middle")
    f.text(560, py + 36, ulabel, size=14, fill="var(--muted)", anchor="middle")
    # time track
    ty, tx0, tx1 = 388, 120, 1000
    f.line(tx0, ty, tx1, ty, stroke="var(--hairline)", sw=3, name="track", seg=False)
    for k, lab in enumerate(BG_TRACK):
        x = tx0 + k * (tx1 - tx0) / 2
        on = k == step
        f.circle(x, ty, 7, fill="var(--ink)" if k <= step else "var(--hairline)")
        anchor = "start" if k == 0 else ("end" if k == 2 else "middle")
        f.text(x + (-8 if k == 0 else (8 if k == 2 else 0)), ty - 16, lab, size=14, weight=700 if on else 400,
               fill="var(--ink)" if on else "var(--faint)", anchor=anchor)
    cx = tx0 + step * (tx1 - tx0) / 2
    overlay(f, "bg-now", "ring", cx - 12.2, ty - 12.2, 24.4, 24.4)
    auto_ids(f, "bg")
    return f


def fig_bluegreen_flow() -> Fig:
    return _bluegreen("fwd")


def fig_bluegreen_flow_cut() -> Fig:
    return _bluegreen("cut")


def fig_bluegreen_flow_rev() -> Fig:
    return _bluegreen("rev")


def fig_goldengate_topology() -> Fig:
    """The production replicator: GoldenGate forward, the reverse path unverified, two ways to buy it."""
    f = Fig(1120, 400, "Production topology: Oracle GoldenGate does the initial load and then every change "
                       "from the MongoDB replica set's oplog into Oracle AI Database 26ai. A reverse path, "
                       "Oracle back to MongoDB, is labeled verify for your release. Two ways to run "
                       "GoldenGate: GoldenGate for MongoDB Migrations, free-use terms with no support or "
                       "patching, and licensed OCI GoldenGate, the supported path")
    fl = Flow(f)
    y, h = 36, 104
    fl.node("mongo", 18, y, 300, h, ["MongoDB replica set", "oplog and", "change streams"], tone="flow", size=18, sub=15)
    fl.node("gg", 410, y, 300, h, ["Oracle GoldenGate", "initial load,", "then every change"], tone="ink", size=18, sub=15)
    fl.node("ora", 802, y, 300, h, ["Oracle AI Database 26ai", "green: the target"], tone="cool", size=18, sub=15)
    fl.edge("mongo", "gg", 364, tone="flow")
    fl.edge("gg", "ora", 756, tone="cool")
    # the reverse path: under the boxes, dashed, unverified
    ry = y + h + 34
    f.path(f"M952,{y + h + 2} V{ry} H168 V{y + h + 4}", [(952, y + h + 2), (952, ry), (168, ry), (168, y + h + 4)],
           stroke="var(--hot)", sw=1.8, dash="7 5", arrow=True, name="reverse")
    f.text(560, ry + 28, "Reverse to MongoDB: verify for your release", size=16, weight=700, fill="var(--hot)",
           anchor="middle")
    # two ways to run it
    cy, ch = 250, 126
    f.box(18, cy, 530, ch, ["GoldenGate for MongoDB Migrations", "recipe UI, offline or online",
                            "free-use terms", "no support or patching entitlement"], tone="hot", size=18, sub_size=15)
    f.box(572, cy, 530, ch, ["OCI GoldenGate", "licensed", "supported", "the production path"], tone="cool",
          size=18, sub_size=15)
    return f


def fig_fallback_constrains_model() -> Fig:
    """While a flip back is possible, green must still produce blue's document; duality is the bridge."""
    f = Fig(1120, 360, "Fallback constrains the model: green can normalize its tables, but as long as a flip "
                       "back is possible a duality view must project the exact order document blue holds. "
                       "The app reads that document, and so does the path back to MongoDB")
    fl = Flow(f)
    f.text(18, 34, "GREEN STORES", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(420, 34, "PROJECTION", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(820, 34, "WHAT READS IT", size=13, weight=700, font=MONO, fill="var(--muted)")
    fl.node("rows", 18, 100, 300, 132, ["Normalized tables", "orders, order lines,", "subscribers, devices"],
            tone="cool", size=18, sub=15)
    fl.node("dv", 420, 116, 300, 100, ["Duality view", "blue's order document,", "exact shape"], tone="cool",
            size=18, sub=15)
    fl.node("app", 820, 56, 282, 92, ["The app", "same document as today"], tone="ink", size=18, sub=15)
    fl.node("blue", 820, 184, 282, 92, ["The way back to blue", "MongoDB gets that shape"], tone="flow",
            size=18, sub=15)
    fl.edge("rows", "dv", 370, tone="cool")
    fl.edge("dv", "app", 770, tone="cool", ay=150, by=102)
    fl.edge("dv", "blue", 770, tone="flow", ay=182, by=230)
    f.text(18, 318, "GoldenGate in 26ai can replicate duality views as JSON. For a MongoDB target: verify first.",
           size=15, fill="var(--muted)")
    return f


# ----------------------------------------------------------------------------- segment 5
CP_YS = [52, 150, 248]
CP_PROJ = ["Rows on tables", "Embedded documents", "Graph edges"]
CP_SHAPES = [["Rowset", "for reports"], ["Order document", "for the app"], ["Graph result", "for hierarchy walks"]]
CP_SURF = ["SQL", "MongoDB API", "SQL/PGQ"]


def _canon(state: str) -> Fig:
    """umt_chain (segment 2), extended for segment 5: the same canonical form and layout, with
    the access surface on each query edge, in two auto-animate states. The projection boxes are
    overlays: in "seed" they sit hidden behind the canonical box, in "fan" they slide out to
    their columns while the shapes and edges fade in."""
    fan = state == "fan"
    f = Fig(1120, 360, {
        "seed": "One canonical form: the telecom domain modeled once, as entities, properties and "
                "relationships, before any storage choice",
        "fan": "One canonical form fans out into three projections (rows on tables, embedded "
               "documents, graph edges); queries on an access surface (SQL, the MongoDB API, SQL/PGQ) "
               "turn each projection into the shape a consumer reads: a rowset, the order document "
               "(a duality view over the rows), a graph result",
    }[state])
    fl = Flow(f)
    f.text(18, 34, "CANONICAL FORM", size=13, weight=700, font=MONO, fill="var(--muted)")
    for i, y in enumerate(CP_YS):
        if fan:
            overlay(f, f"cp-p{i}", "flow", 420, y, 280, 80)
        else:  # tucked behind the canonical box (drawn after it, so it covers them)
            overlay(f, f"cp-p{i}", "flow", 40, 140 + i * 34, 226, 28)
    fl.node("canon", 18, 124, 270, 132, ["Telecom domain", "subscriber, order, device:", "entities, properties,",
                                         "relationships"], tone="cool", size=18, sub=15)
    if not fan:
        f.text(420, 178, "Model the business once:", size=24, weight=800, font=HEAD)
        f.text(420, 212, "what exists, and how it relates.", size=20, fill="var(--muted)")
        auto_ids(f, "cp")
        return f
    f.text(420, 34, "PROJECTIONS", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(850, 34, "PROJECTED SHAPES", size=13, weight=700, font=MONO, fill="var(--muted)")
    for i, y in enumerate(CP_YS):
        fl.nodes[f"p{i}"] = (420, y, 280, 80)
        f.text(562, y + 46, CP_PROJ[i], size=18, weight=700, font=HEAD, anchor="middle")
        fl.node(f"s{i}", 850, y, 252, 80, CP_SHAPES[i], tone="ink", size=18, sub=15)
        fl.edge("canon", f"p{i}", 354, tone="cool")
    fl.edge("p0", "s0", 770, tone="flow", label=CP_SURF[0])
    fl.edge("p1", "s1", 770, tone="flow", ay=200, by=200, label=CP_SURF[1])
    fl.edge("p2", "s2", 770, tone="flow", label=CP_SURF[2])
    fl.edge("p0", "s1", 742, tone="cool", ay=106, by=170, dash="6 4")
    f.text(796, 162, "duality view", size=13, weight=600, font=MONO, fill="var(--cool)", anchor="middle")
    auto_ids(f, "cp")
    return f


def fig_canonical_to_projections_seed() -> Fig:
    return _canon("seed")


def fig_canonical_to_projections() -> Fig:
    return _canon("fan")


def fig_forced_embeds() -> Fig:
    """Why so many embeds exist: a read-only view was the only joined shape, so the copy was
    forced. On Oracle the joined shape takes writes."""
    f = Fig(1120, 380, "Forced embeds: the app wants an order with its subscriber joined in. A MongoDB "
                       "view can join it but is read only, so the order embeds a copy of the subscriber's "
                       "name, tier and address. One address change then rewrites every order that copied "
                       "it. On Oracle a duality view is that joined shape and takes writes, with the "
                       "subscriber stored once")
    fl = Flow(f)
    y, h = 36, 104
    fl.node("want", 18, y, 300, h, ["The app wants", "an order with its", "subscriber joined in"], size=18, sub=15)
    fl.node("view", 410, y, 300, h, ["A MongoDB view", "joins it, but read only:", "no writes through it"],
            tone="hot", size=18, sub=15)
    fl.node("copy", 802, y, 300, h, ["So the order embeds", "a copy: name, tier,", "address in every order"],
            tone="hot", size=18, sub=15)
    fl.edge("want", "view", 364, tone="flow")
    fl.edge("view", "copy", 756, tone="hot")
    # the write amplification that follows
    ry = 176
    f.text(18, ry + 30, "One address change", size=19, weight=800, font=HEAD, fill="var(--hot)")
    f.text(18, ry + 56, "rewrites every order that copied it", size=15, fill="var(--muted)")
    f.line(330, ry + 34, 404, ry + 34, stroke="var(--hot)", sw=1.8, arrow=True, name="fan")
    for k in range(11):
        x = 420 + k * 62
        f.rect(x, ry, 50, 68, fill="var(--panel)", stroke="var(--hot)", sw=1.4, rx=4, name="doc")
        for j, (fill, stroke) in enumerate((("var(--chip)", "var(--chip)"), ("var(--chip)", "var(--chip)"),
                                            ("var(--hot-soft)", "var(--hot)"))):
            f.rect(x + 8, ry + 12 + j * 16, 34, 8, fill=fill, stroke=stroke, sw=1, rx=2, name="bar")
    f.text(420, ry + 96, "order 1 ... order N: the same copied address, N writes", size=14, font=MONO,
           fill="var(--hot)")
    f.box(18, 300, 1084, 62, ["On Oracle: a duality view is that joined shape, and it takes writes",
                              "the subscriber is stored once, so one change is one row"], tone="cool",
          size=18, sub_size=15)
    return f


def _bars(f: Fig, x, y, w, n, hot=(), cool=(), h=6, gap=4):
    """A stack of thin bars (rows of a document or a table); hot/cool are highlighted rows."""
    for j in range(n):
        if j in hot:
            fill, stroke = "var(--hot-soft)", "var(--hot)"
        elif j in cool:
            fill, stroke = "var(--cool-soft)", "var(--cool)"
        else:
            fill, stroke = "var(--chip)", "var(--hairline)"
        f.rect(x, y + j * (h + gap), w, h, fill=fill, stroke=stroke, sw=1, rx=2, name="bar")


TOPN = [  # title, sub lines, tone, write (glyph, lines, tag, tone), read (glyph, lines, tag, tone)
    ("(a) Embedded", ["Top 10 stored in one", "document per region"], "hot",
     ("doc-all", ["rewrites the region's", "whole Top-N document"], "pays on every write", "hot"),
     ("doc-one", ["reads one document", "by its key"], "fast read", "cool")),
    ("(b) $lookup pipeline", ["count the orders", "at read time"], "hot",
     ("row-new", ["inserts the order,", "nothing else"], "cheap write", "cool"),
     ("funnel", ["groups every order", "line in the region"], "pays on every read", "hot")),
    ("(c) Converged", ["counter rows, a sorted", "index, a view"], "cool",
     ("row-one", ["one counter row, +1,", "same transaction"], "one row per order", "cool"),
     ("index", ["10 index entries, in", "order, then a join"], "short scan, cheap join", "cool")),
]


def _topn_glyph(f: Fig, kind: str, x, y):
    """Small pictures, 64 wide and 84 tall, for each write and read."""
    if kind in ("doc-all", "doc-one"):
        f.rect(x, y, 60, 84, fill="var(--panel)", stroke="var(--muted)", sw=1.4, rx=5, name="doc")
        _bars(f, x + 9, y + 9, 42, 7, hot=range(7) if kind == "doc-all" else (),
              cool=() if kind == "doc-all" else range(7))
    elif kind in ("row-new", "row-one"):
        _bars(f, x, y + 4, 60, 6, h=8, gap=5, cool=(5,) if kind == "row-new" else (2,))
        if kind == "row-one":
            f.text(x + 66, y + 39, "+1", size=13, weight=700, font=MONO, fill="var(--cool)")
    elif kind == "funnel":
        for r in range(6):
            for c in range(4):
                f.rect(x + c * 12, y + 4 + r * 13, 8, 8, fill="var(--hot-soft)", stroke="var(--hot)", sw=1,
                       rx=1, name="cell")
    elif kind == "index":
        _bars(f, x, y + 2, 52, 8, h=5, gap=3.5, cool=range(5))
        f.line(x - 4, y + 44, x + 58, y + 44, stroke="var(--hot)", sw=1.6, dash="4 3", name="stop", seg=False)
        f.text(x + 60, y + 48, "stop", size=11, weight=700, font=MONO, fill="var(--hot)")


def fig_topn_three_ways() -> Fig:
    """D5's question three ways. Each row is a fragment: the whole-document rewrite, then the
    re-aggregation, then the one counter row."""
    f = Fig(1120, 414, "Top 10 devices per region, three ways. Embedded: every order rewrites the "
                       "region's whole Top-N document; the read is one document by key. $lookup pipeline: "
                       "every order inserts only itself, and every dashboard read groups every order line "
                       "in the region. Converged: every order adds one to one counter row in the same "
                       "transaction, and the read takes 10 entries from a pre-sorted index, then joins "
                       "the device names")
    c2, c3, cw2, cw3 = 300, 700, 380, 402
    f.text(18, 34, "THE MODEL", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(c2, 34, "WHAT EACH ORDER WRITES", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(c3, 34, "WHAT EACH DASHBOARD READ DOES", size=13, weight=700, font=MONO, fill="var(--muted)")
    top, rh, ch = 52, 118, 108
    for i, (title, subs, tone, wr, rd) in enumerate(TOPN):
        y = top + i * rh
        group(f, "fragment", data_fragment_index=i + 1)
        f.text(18, y + 34, title, size=19, weight=800, font=HEAD, fill=TONE[tone][0])
        for k, s in enumerate(subs):
            f.text(18, y + 62 + k * 20, s, size=15, fill="var(--muted)")
        for x, w, (glyph, lines, tag, t) in ((c2, cw2, wr), (c3, cw3, rd)):
            col, soft = TONE[t]
            f.rect(x, y, w, ch, fill=soft, stroke=col, sw=1.4, rx=8, name="cell")
            _topn_glyph(f, glyph, x + 16, y + 12)
            tx = x + 112
            for k, s in enumerate(lines):
                f.text(tx, y + 32 + k * 21, s, size=15)
            f.text(tx, y + 88, tag, size=15, weight=700, fill=col)
        f.raw("</g>")
    return f


def fig_duality_tradeoff() -> Fig:
    """D5's measured result: where each model pays, after the dashboards were proven identical."""
    f = Fig(1120, 392, "Where each model pays, measured in D5 on the laptop after the three dashboards "
                       "were proven identical, relative only. Counter write per order: embedded about "
                       "2,600 bytes of redo, the lookup pipeline nothing extra, converged about 900 bytes. "
                       "Dashboard read for one region: embedded about 0.4 ms, the lookup pipeline about "
                       "236 ms, converged about 0.7 ms. A costlier read than one stored document, zero "
                       "write amplification, and the optimizer plans the join")
    cols = [(320, "(a) Embedded", "hot"), (580, "(b) $lookup", "hot"), (840, "(c) Converged", "cool")]
    cw = 262
    for x, t, tone in cols:
        f.text(x + cw / 2, 40, t, size=19, weight=800, font=HEAD, fill=TONE[tone][0], anchor="middle")
    rows = [
        ("Counter write", "redo per order, on top", "of the order itself",
         [("~2,600 B", "every order", "hot"), ("0 B", "nothing extra", "ink"), ("~900 B", "one row, +1", "cool")]),
        ("Dashboard read", "one region,", "median of 7",
         [("~0.4 ms", "fastest: one document", "cool"), ("~236 ms", "counts every order", "hot"),
          ("~0.7 ms", "index scan and a join", "cool")]),
    ]
    top, rh = 60, 104
    for i, (label, s1, s2, cells) in enumerate(rows):
        y = top + i * (rh + 12)
        f.text(18, y + 38, label, size=19, weight=800, font=HEAD)
        f.text(18, y + 62, s1, size=14, fill="var(--muted)")
        f.text(18, y + 80, s2, size=14, fill="var(--muted)")
        for (x, _, _), (big, sub, tone) in zip(cols, cells):
            col, soft = TONE[tone] if tone != "ink" else ("var(--ink)", "var(--panel)")
            f.rect(x, y, cw, rh, fill=soft, stroke=col if tone != "ink" else "var(--hairline)", sw=1.4, rx=8,
                   name="cell")
            f.text(x + cw / 2, y + 50, big, size=30, weight=800, font=HEAD, fill=col, anchor="middle")
            f.text(x + cw / 2, y + 80, sub, size=15, fill="var(--muted)", anchor="middle")
    f.box(18, 300, 1084, 74, ["A costlier read than one stored document. Zero write amplification.",
                              "The optimizer plans the join. Laptop, relative only, after the dashboards matched."],
          tone="cool", size=18, sub_size=15)
    return f


def fig_api_tax_by_shape() -> Fig:
    """The field PoC's finding as a routing rule: finds stay on the API, pipelines move to $sql."""
    f = Fig(1120, 340, "Route by shape. Finds and CRUD ran at parity through the Oracle API for MongoDB "
                       "in a field proof of concept, so they stay on the API. Aggregation pipelines ran "
                       "about 3 to 15 times slower through the API, so rewrite the hot ones as $sql and "
                       "the optimizer gets the whole question")
    fl = Flow(f)
    f.text(18, 34, "THE REQUEST", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(360, 34, "THROUGH THE API (FIELD POC)", size=13, weight=700, font=MONO, fill="var(--muted)")
    f.text(790, 34, "WHAT TO DO", size=13, weight=700, font=MONO, fill="var(--muted)")
    fl.node("app", 18, 135, 250, 100, ["Your app", "same driver,", "same code"], size=18, sub=15)
    fl.node("finds", 360, 50, 340, 100, ["Finds and CRUD", "at parity"], tone="cool", size=18, sub=15)
    fl.node("pipes", 360, 220, 340, 100, ["Aggregation pipelines", "about 3 to 15x slower"], tone="hot",
            size=18, sub=15)
    fl.node("api", 790, 50, 312, 100, ["Keep them on the API", "nothing to change"], tone="cool", size=18, sub=15)
    fl.node("sql", 790, 220, 312, 100, ["Rewrite the hot ones", "as $sql: the optimizer", "sees the whole question"],
            tone="cool", size=18, sub=15)
    fl.edge("app", "finds", 314, tone="cool")
    fl.edge("app", "pipes", 314, tone="hot")
    fl.edge("finds", "api", 745, tone="cool")
    fl.edge("pipes", "sql", 745, tone="cool")
    return f


SQL_FORMS = [
    ("1  Opening stage", ["SQL starts the pipeline;", "later stages keep going"],
     ["db.aggregate([", '  {$sql: "SELECT ..."},', "  {$match: {...}} ])"]),
    ("2  Mid-pipeline", ["earlier stages feed SQL", "as a table named input"],
     ["db.orders.aggregate([", "  {$match: {...}},", '  {$sql: "... FROM input"} ])']),
    ("3  The only stage", ["DDL and DML, and", "named binds"],
     ["db.aggregate([{$sql: {", '  statement: "...",', "  binds: {fromTs} }}])"]),
]


def fig_sql_stage_forms() -> Fig:
    """The three places a $sql stage can sit, with the shape of each call."""
    f = Fig(1120, 346, "Three forms of the $sql stage. Opening stage: SQL starts the pipeline and later "
                       "stages keep going. Mid-pipeline: the earlier stages' documents become a table named "
                       "input. The only stage: DDL and DML are allowed, and named binds work only here")
    w, y, h = 348, 18, 270
    for i, (title, subs, code) in enumerate(SQL_FORMS):
        x = 18 + i * (w + 19)
        f.rect(x, y, w, h, fill="var(--panel)", stroke="var(--cool)", sw=1.4, rx=8, name="card")
        f.raw(f'<rect x="{x}" y="{y}" width="4" height="{h}" rx="2" fill="var(--cool)"/>')
        f.text(x + 22, y + 38, title, size=20, weight=800, font=HEAD, fill="var(--cool)")
        for k, s in enumerate(subs):
            f.text(x + 22, y + 70 + k * 22, s, size=16, fill="var(--muted)")
        f.rect(x + 16, y + 132, w - 32, 112, fill="var(--chip)", stroke="var(--chip)", sw=1, rx=6, name="code")
        for k, s in enumerate(code):
            ind = len(s) - len(s.lstrip(" "))   # SVG collapses spaces: indent by position
            f.text(x + 28 + ind * 14 * 0.61, y + 166 + k * 28, s.strip(), size=14, font=MONO)
    f.text(560, 324, "Inside $sql: no 100 MB stage memory cap, no 16 MiB document cap.", size=17,
           weight=600, fill="var(--ink)", anchor="middle")
    return f


ET_STATES = {  # state: (A packet x, B packet x, B tone, B box sub, order lines, A note, B note, footer)
    "read": (330, 330, "flow", ["read the order:", "ETag E1"],
             ("placed", "phone A", "E1", "0"), "", "", ""),
    "clash": (470, 440, "hot", ["read the order:", "ETag E1"],
              ("provisioned", "phone A", "E2", "1"), "accepted: ETag now E2", "rejected: ORA-42699", ""),
    "retry": (470, 470, "cool", ["re-read: ETag E2,", "swapped again"],
              ("provisioned", "phone B", "E3", "2"), "accepted", "accepted: ETag now E3",
              "No ETag sent? Oracle accepts it: last writer wins."),
}


def _etag(state: str) -> Fig:
    """Two agents write one order. The write requests are overlays, so Reveal auto-animate moves
    them; B's starts later (data-auto-animate-delay) and turns red when the ETag check refuses it."""
    ax, bx, btone, bsub, (status, dev, etag, n), anote, bnote, foot = ET_STATES[state]
    f = Fig(1120, 400, {
        "read": "Two agents read the same order from its duality view; both hold ETag E1. Agent A will "
                "change the status, agent B will swap the device",
        "clash": "Agent A writes first with ETag E1: accepted, and the order's ETag becomes E2. Agent B "
                 "writes its device swap with the stale ETag E1: rejected with ORA-42699, nothing written",
        "retry": "Agent B re-reads (ETag E2), swaps the device again and writes: accepted. The order has "
                 "both changes, 2 updates applied. Without an ETag the write is accepted: last writer wins",
    }[state])
    f.box(18, 46, 290, 104, ["Agent A", "read the order:", "ETag E1"], tone="flow", size=19, sub_size=15, name="a")
    f.box(18, 226, 290, 104, ["Agent B"] + bsub, tone=btone if state != "read" else "flow", size=19,
          sub_size=15, name="b")
    pw, ph = 230, 56
    overlay(f, "et-a", "flow", ax, 70, pw, ph)
    overlay(f, "et-b", btone, bx, 250, pw, ph, attrs='data-auto-animate-delay="0.7"')
    f.text(ax + 16, 93, "status: provisioned", size=14, weight=600, font=MONO)
    f.text(ax + 16, 114, "with ETag E1", size=14, font=MONO, fill="var(--muted)")
    f.text(bx + 16, 273, "device: phone B", size=14, weight=600, font=MONO)
    f.text(bx + 16, 294, f"with ETag {'E2' if state == 'retry' else 'E1'}", size=14, font=MONO,
           fill="var(--muted)")
    if anote:
        f.text(ax + 8, 150, anote, size=14, weight=700, fill="var(--cool)")
    if bnote:
        f.text(bx + 8, 330, bnote, size=14, weight=700, fill="var(--hot)" if state == "clash" else "var(--cool)")
    # the order document, from the duality view
    ox, oy, ow, oh = 720, 46, 382, 284
    f.rect(ox, oy, ow, oh, fill="var(--cool-soft)", stroke="var(--cool)", sw=1.6, rx=8, name="order")
    f.text(ox + 22, oy + 36, "The order", size=20, weight=800, font=HEAD, fill="var(--cool)")
    f.text(ox + 22, oy + 60, "one document, from a duality view", size=14, fill="var(--muted)")
    for k, (key, val) in enumerate((("status", status), ("device", dev), ("etag", etag))):
        f.text(ox + 22, oy + 104 + k * 38, f"{key}:", size=16, font=MONO, fill="var(--muted)")
        f.text(ox + 120, oy + 104 + k * 38, val, size=16, weight=700, font=MONO,
               fill="var(--cool)" if key == "etag" else "var(--ink)")
    f.text(ox + 22, oy + 252, f"updates applied: {n}", size=15, weight=600, font=MONO)
    if foot:
        f.text(560, 376, foot, size=17, weight=700, fill="var(--hot)", anchor="middle")
    auto_ids(f, "et")
    return f


def fig_etag_collision() -> Fig:
    return _etag("read")


def fig_etag_collision_clash() -> Fig:
    return _etag("clash")


def fig_etag_collision_retry() -> Fig:
    return _etag("retry")


WHEN = [  # row, A, B, C (each a list of lines, or (text, tone) for the risk pills)
    ("Remodel the data", ["From day one:", "Oracle starts empty"], ["After cutover,", "in place"],
     ["During the move,", "behind blue's shape"]),
    ("$sql for hot pipelines", ["From day one"], ["Day one after", "cutover; no data moves"],
     ["On green,", "during validation"]),
    ("Risk it adds", ("Low", "cool"), ("None: its own project", "cool"), ("Medium: two shapes", "hot")),
]


def fig_when_to_optimize() -> Fig:
    """Outline section 5's table, as a graphic: when to optimize, by door."""
    f = Fig(1120, 372, "When to optimize, by door. Age out: remodel from day one because Oracle starts "
                       "empty, $sql from day one, low added risk. Dump and restore: remodel after cutover in "
                       "place, $sql from day one after cutover with no data move, no added risk because it is "
                       "a separate project. Blue/green: remodel during the move behind a projection of blue's "
                       "shape, $sql on green during validation, medium added risk with two shapes to validate")
    cx = [300, 570, 840]
    cw = 262
    heads = [("A  Age out", "flow"), ("B  Dump/restore", "hot"), ("C  Blue/green", "cool")]
    for x, (t, tone) in zip(cx, heads):
        f.text(x + cw / 2, 38, t, size=19, weight=800, font=HEAD, fill=TONE[tone][0], anchor="middle")
    top, rh = 56, 96
    for i, (label, *cells) in enumerate(WHEN):
        y = top + i * (rh + 8)
        f.text(18, y + rh / 2 + 7, label, size=19, weight=700, font=HEAD)
        for x, cell in zip(cx, cells):
            if isinstance(cell, tuple):
                t, tone = cell
                col, soft = TONE[tone]
                f.rect(x, y + 24, cw, rh - 48, fill=soft, stroke=col, sw=1.4, rx=(rh - 48) / 2, name="pill")
                f.text(x + cw / 2, y + rh / 2 + 6, t, size=17, weight=700, fill=col, anchor="middle")
                continue
            f.rect(x, y, cw, rh, fill="var(--panel)", stroke="var(--hairline)", sw=1.4, rx=8, name="cell")
            y0 = y + rh / 2 + 6 - (len(cell) - 1) * 11
            for k, s in enumerate(cell):
                f.text(x + cw / 2, y0 + k * 22, s, size=16, anchor="middle",
                       weight=600 if k == 0 else 400, fill="var(--ink)" if k == 0 else "var(--muted)")
    return f


# ----------------------------------------------------------------------------- segment 6
FINAL = [  # door, tone, downtime, way back, how long, ops load, optimize, top 3 risks
    ("A  Age out", "flow", ["near zero"], ["partial:", "old side stays"], ["months", "to years"],
     ["two systems", "for years"], ["best: Oracle", "starts empty"],
     ["seams across the cutoff", "an archive nobody retires", "two stacks to run"]),
    ("B  Dump and", "hot", ["planned", "window"], ["free until", "writes open"], ["one window"],
     ["lowest"], ["lift first,", "remodel later"],
     ["the window overruns", "types drift quietly", "no free way back later"]),
    ("C  Blue/green", "cool", ["near zero"], ["reverse sync"], ["weeks"],
     ["highest:", "replicator"], ["during, behind", "blue's shape"],
     ["oplog window too short", "split brain at the flip", "lag freezes writes"]),
]


def fig_decision_matrix_final() -> Fig:
    """Segment 1's matrix, filled in: each door on six columns."""
    f = Fig(1120, 400, "The decision matrix, filled in. Age out: near-zero downtime, a partial way back "
                       "since the old side stays, months to years, two systems to run, the best fit for "
                       "optimization; risks are the seams across the cutoff, an archive nobody retires, two "
                       "stacks. Dump and restore: a planned window, a free way back until writes open, one "
                       "window, the lowest ops load, lift first and remodel later; risks are a window "
                       "overrun, quiet type drift, no free way back later. Blue/green: near-zero downtime, "
                       "a reverse sync, weeks, the highest ops load, optimize during the move behind blue's "
                       "shape; risks are a short oplog window, split brain at the flip, lag that freezes writes")
    xs = [210, 340, 470, 600, 730]
    cw = 122
    heads = ["DOWNTIME", "WAY BACK", "HOW LONG", "OPS LOAD", "OPTIMIZE"]
    for x, t in zip(xs, heads):
        f.text(x + cw / 2, 38, t, size=13, weight=700, font=MONO, fill="var(--muted)", anchor="middle")
    rx = 870
    f.text(rx, 38, "TOP 3 RISKS", size=13, weight=700, font=MONO, fill="var(--muted)")
    top, rh = 54, 106
    for i, (door_, tone, *cells) in enumerate(FINAL):
        y = top + i * (rh + 6)
        col = TONE[tone][0]
        f.rect(18, y, 1084, rh, fill="var(--chip)" if i % 2 == 0 else "var(--panel)",
               stroke="var(--chip)" if i % 2 == 0 else "var(--hairline)", sw=1, rx=8, name="band")
        f.raw(f'<rect x="18" y="{y}" width="5" height="{rh}" rx="2" fill="{col}"/>')
        name = door_ if i != 1 else "B  Dump and"
        f.text(36, y + rh / 2 - (6 if i == 1 else -7), name, size=19, weight=800, font=HEAD, fill=col)
        if i == 1:
            f.text(36 + 21, y + rh / 2 + 20, "restore", size=19, weight=800, font=HEAD, fill=col)
        for x, cell in zip(xs, cells[:5]):
            y0 = y + rh / 2 + 6 - (len(cell) - 1) * 10
            for k, s in enumerate(cell):
                f.text(x + cw / 2, y0 + k * 20, s, size=15, anchor="middle",
                       weight=600 if k == 0 else 400, fill="var(--ink)" if k == 0 else "var(--muted)")
        for k, s in enumerate(cells[5]):
            f.text(rx, y + 32 + k * 25, f"{k + 1}  {s}", size=15, fill="var(--ink)")
    return f


HYBRIDS = [  # title, [(door letter, door name, tone, [collections])]
    ("Age out the events, dump and restore the entities",
     [("B", "dump and restore", "hot", ["subscribers", "accounts", "catalog", "regions"]),
      ("A", "age out", "flow", ["orders", "orderEvents", "carts"])]),
    ("Dump and restore now, live sync for the one you can't freeze",
     [("B", "dump and restore", "hot", ["subscribers", "accounts", "catalog", "regions", "orderEvents", "carts"]),
      ("C", "live sync", "cool", ["orders"])]),
]


def fig_hybrids() -> Fig:
    """Two common hybrids: a door per collection, not one door for the estate."""
    f = Fig(1120, 300, "Two common hybrids, a door per collection. One: dump and restore the entity "
                       "collections (subscribers, accounts, catalog, regions) and age out the event "
                       "collections (orders, order events, carts). Two: dump and restore everything now, "
                       "with live sync for the one collection the business cannot freeze, here orders")
    for i, (title, groups) in enumerate(HYBRIDS):
        y = 18 + i * 140
        f.text(18, y + 22, f"{i + 1}  {title}", size=20, weight=800, font=HEAD)
        x = 18
        for letter, name, tone, colls in groups:
            col, soft = TONE[tone]
            x0 = x
            for c in colls:
                w = tw(c, 15, MONO, 600) + 26
                f.rect(x, y + 40, w, 38, fill=soft, stroke=col, sw=1.4, rx=19, name="chip")
                f.text(x + w / 2, y + 64, c, size=15, weight=600, font=MONO, fill=col, anchor="middle")
                x += w + 10
            x1 = x - 10
            f.path(f"M{x0},{y + 88} V{y + 96} H{x1} V{y + 88}", [(x0, y + 88), (x1, y + 96)], stroke=col,
                   sw=1.6, name="bracket", seg=False)
            f.text((x0 + x1) / 2, y + 118, f"{letter}  {name}", size=16, weight=700, fill=col, anchor="middle")
            x += 24
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
            built[n] = (fig.svg(), fig.w, fig.h, "".join(getattr(fig, "overlays", [])))
        except FigureError as ex:
            errors.append(str(ex))
    if errors:
        print("figure build FAILED:\n" + "\n".join(errors))
        return 1

    FIGS.mkdir(exist_ok=True)
    png_dir = None if a.no_png else (a.png or Path(tempfile.mkdtemp(prefix="deckfigs-")))
    if png_dir:
        png_dir.mkdir(parents=True, exist_ok=True)
    for n, (svg, w, h, ov) in built.items():
        (FIGS / f"{n}.svg").write_text(standalone(svg, w, h), encoding="utf-8")
        inline = f'<div class="fig-stack">{svg}{ov}</div>' if ov else svg
        hits = [m for m in MARK.finditer(deck) if m.group(2) == n]
        if hits:
            deck = MARK.sub(lambda m: m.group(1) + inline + m.group(4) if m.group(2) == n else m.group(0), deck)
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

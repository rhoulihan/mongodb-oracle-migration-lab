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
from deckfig import HEAD, MONO, TONE, Fig, FigureError, Flow  # noqa: E402

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


def overlay(f: Fig, data_id: str, cls: str, x, y, w, h, extra: str = "") -> None:
    """A shape that Reveal auto-animate must move or resize. Reveal measures matched elements
    with offsetLeft/offsetWidth, which SVG shapes do not have, so a shape inside the SVG never
    morphs. The deck gets an HTML box laid over the SVG (percent of the viewBox, behind the SVG
    text); the SVG keeps a twin of it for the standalone file and the PNG check, hidden in the
    deck by .fig-stack .overlay-twin."""
    if not hasattr(f, "overlays"):
        f.overlays = []
    tone = {"cool": "cool", "flow": "flow", "ring": "hot"}[cls]
    f.raw('<g class="overlay-twin">')
    if cls == "ring":
        f.circle(x + w / 2, y + h / 2, w / 2 - 1.2, fill="none", stroke=TONE[tone][0], sw=2.4)
    elif w > 1:
        f.rect(x, y, w, h, fill=TONE[tone][1], stroke=TONE[tone][0], sw=1.8, rx=8, name=data_id)
    f.raw("</g>")
    pct = lambda v, t: f"{v / t * 100:.3f}%"
    f.overlays.append(f'<div class="ov {cls}{" " + extra if extra else ""}" data-id="{data_id}" style="left:{pct(x, f.w)};top:{pct(y, f.h)};'
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

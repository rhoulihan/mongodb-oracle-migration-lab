"""Inline-SVG figure helpers for the converged-modeling deck (Workshop 1).

Figures are themed with the deck's CSS custom properties (--ink, --muted, --hot, --cool,
--flow, --panel, --hairline, --chip, --hot-soft, --cool-soft, --flow-soft) so they follow
light/dark mode. Every primitive records its bounding box; ``Fig.svg()`` refuses to emit a
figure that breaks Rick's standing SVG rules:

  1. everything inside the frame (>= pad on every side)
  2. no text-on-text collisions (>= 2px gap)
  3. connectors orthogonal; 4. step-overs where a connector crosses another (``Flow``)

Components: ``erd`` (crow's-foot ERD), ``doc_panel`` (JSON document with highlighted lines
and callouts), ``dials`` (three knob gauges), ``chart`` (breakpoint / cost-model line chart,
linear or log x), ``Flow`` (column flow diagram with bus routing and automatic step-overs).
"""
from __future__ import annotations

import itertools
import math
import re
import zlib
from html import escape as _esc

SANS = "Public Sans, Segoe UI, system-ui, sans-serif"
MONO = "IBM Plex Mono, ui-monospace, monospace"
HEAD = "Bricolage Grotesque, Public Sans, sans-serif"

TONE = {  # semantic colour -> (stroke/text, soft fill)
    "hot": ("var(--hot)", "var(--hot-soft)"),
    "cool": ("var(--cool)", "var(--cool-soft)"),
    "flow": ("var(--flow)", "var(--flow-soft)"),
    "ink": ("var(--ink)", "var(--chip)"),
    "muted": ("var(--muted)", "var(--chip)"),
}


def e(s) -> str:
    return _esc(str(s), quote=True)


def tw(s: str, size: float, font: str = SANS, weight: int = 400) -> float:
    """Estimated rendered width of ``s``."""
    k = 0.61 if font == MONO else (0.60 if font == HEAD else 0.555)
    if weight >= 600 and font != MONO:
        k += 0.035
    return len(s) * size * k


_FIG_IDS = itertools.count(1)


class FigureError(ValueError):
    pass


def _seg_hits_box(x1, y1, x2, y2, bx0, by0, bx1, by1) -> bool:
    """Liang-Barsky: does segment (x1,y1)-(x2,y2) enter the box?"""
    dx, dy = x2 - x1, y2 - y1
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x1 - bx0), (dx, bx1 - x1), (-dy, y1 - by0), (dy, by1 - y1)):
        if p == 0:
            if q < 0:
                return False
        else:
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
            if t0 > t1:
                return False
    return True


class Fig:
    def __init__(self, w: int, h: int, label: str, pad: int = 16):
        self.w, self.h, self.pad, self.label = w, h, pad, label
        self.defs: list[str] = []
        self.els: list[str] = []
        self.bounds: list[tuple[float, float, float, float, str]] = []
        self.texts: list[tuple[float, float, float, float, str]] = []
        self.segs: list[tuple[float, float, float, float, str]] = []  # straight runs text must avoid
        # unique marker-id prefix: many SVGs share one page and are built by separate scripts
        # (separate processes), so a per-process counter alone collides; key it on the label too
        self.mid = f"dk{zlib.crc32(label.encode()) & 0xFFFFFF:06x}{next(_FIG_IDS)}"
        self.markers: dict[str, str] = {}  # stroke -> marker id

    # ---- bookkeeping ----------------------------------------------------------------
    def track(self, x0, y0, x1, y1, name=""):
        self.bounds.append((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), name))

    def raw(self, s: str):
        self.els.append(s)

    def arrow_id(self, stroke: str) -> str:
        """Explicitly-coloured arrowhead per stroke colour (context-stroke isn't rendered everywhere)."""
        if stroke not in self.markers:
            self.markers[stroke] = f"{self.mid}-{re.sub(r'[^a-z0-9]', '', stroke.lower()) or 'x'}"
        return self.markers[stroke]

    # ---- primitives -----------------------------------------------------------------
    def text(self, x, y, s, size=12, fill="var(--ink)", anchor="start", weight=400,
             font=SANS, italic=False, check=True):
        w = tw(s, size, font, weight)
        x0 = x if anchor == "start" else (x - w / 2 if anchor == "middle" else x - w)
        bb = (x0, y - size * 0.78, x0 + w, y + size * 0.24, "text:" + s[:28])
        self.track(*bb[:4], bb[4])
        if check:
            self.texts.append(bb)
        st = ' font-style="italic"' if italic else ""
        self.els.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" font-family="{font}" '
            f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{st}>{e(s)}</text>')
        return w

    def rect(self, x, y, w, h, fill="var(--panel)", stroke="var(--hairline)", sw=1.4, rx=6,
             dash=None, name="rect"):
        self.track(x - sw / 2, y - sw / 2, x + w + sw / 2, y + h + sw / 2, name)
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.els.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" '
                        f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def line(self, x1, y1, x2, y2, stroke="var(--muted)", sw=1.4, dash=None, arrow=False,
             name="line", seg=True):
        self.track(x1, y1, x2, y2, name)
        if seg:
            self.segs.append((x1, y1, x2, y2, name))
        d = f' stroke-dasharray="{dash}"' if dash else ""
        m = f' marker-end="url(#{self.arrow_id(stroke)})"' if arrow else ""
        self.els.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                        f'stroke="{stroke}" stroke-width="{sw}"{d}{m}/>')

    def path(self, d, pts, stroke="var(--muted)", sw=1.5, fill="none", arrow=False, dash=None,
             name="path", opacity=None, seg=True):
        if seg:
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                self.segs.append((ax, ay, bx, by, name))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        self.track(min(xs), min(ys), max(xs), max(ys), name)
        m = f' marker-end="url(#{self.arrow_id(stroke)})"' if arrow else ""
        da = f' stroke-dasharray="{dash}"' if dash else ""
        op = f' opacity="{opacity}"' if opacity is not None else ""
        self.els.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" '
                        f'stroke-linejoin="round"{m}{da}{op}/>')

    def circle(self, cx, cy, r, fill="var(--cool)", stroke="none", sw=0):
        self.track(cx - r, cy - r, cx + r, cy + r, "circle")
        self.els.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="{fill}" '
                        f'stroke="{stroke}" stroke-width="{sw}"/>')

    def box(self, x, y, w, h, lines, tone="ink", accent=True, size=13, sub_size=11.5,
            fill="var(--panel)", bold_first=True, name="box"):
        """Rounded box with optional left accent bar and centred text lines."""
        stroke = TONE[tone][0] if tone != "ink" else "var(--hairline)"
        self.rect(x, y, w, h, fill=fill, stroke=stroke, name=name)
        if accent:
            self.els.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="4" height="{h:.1f}" rx="2" '
                            f'fill="{TONE[tone][0]}"/>')
        n = len(lines)
        lh = size * 1.28
        top = y + h / 2 - (n - 1) * lh / 2 + size * 0.34
        for i, s in enumerate(lines):
            sz = size if i == 0 else sub_size
            wt = 700 if (i == 0 and bold_first) else 400
            fnt = HEAD if (i == 0 and bold_first) else SANS
            col = "var(--ink)" if i == 0 else "var(--muted)"
            if tw(s, sz, fnt, wt) > w - 18:
                raise FigureError(f"{self.label}: box text overflows ({s!r} in w={w})")
            self.text(x + w / 2 + 2, top + i * lh, s, size=sz, fill=col, anchor="middle",
                      weight=wt, font=fnt)

    # ---- output ---------------------------------------------------------------------
    def check(self):
        p = self.pad
        errs = []
        for x0, y0, x1, y1, n in self.bounds:
            if x0 < p - 0.5 or y0 < p - 0.5 or x1 > self.w - p + 0.5 or y1 > self.h - p + 0.5:
                errs.append(f"out of frame: {n} ({x0:.0f},{y0:.0f})-({x1:.0f},{y1:.0f})")
        t = self.texts
        for i in range(len(t)):
            for j in range(i + 1, len(t)):
                a, b = t[i], t[j]
                if a[0] < b[2] - 2 and b[0] < a[2] - 2 and a[1] < b[3] - 2 and b[1] < a[3] - 2:
                    errs.append(f"text collision: {a[4]!r} x {b[4]!r}")
        for tb in t:
            for x1, y1, x2, y2, n in self.segs:
                if _seg_hits_box(x1, y1, x2, y2, tb[0] + 1, tb[1] + 1, tb[2] - 1, tb[3] - 1):
                    errs.append(f"line through text: {n!r} x {tb[4]!r}")
        if errs:
            raise FigureError(f"{self.label}:\n  " + "\n  ".join(errs))

    def svg(self, cls="fig") -> str:
        self.check()
        mk = "".join(
            f'<marker id="{mid}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L10,5 L0,10 z" fill="{stroke}"/></marker>'
            for stroke, mid in self.markers.items())
        defs = "<defs>" + mk + "".join(self.defs) + "</defs>"
        return (f'<svg class="{cls}" viewBox="0 0 {self.w} {self.h}" role="img" '
                f'aria-label="{e(self.label)}" xmlns="http://www.w3.org/2000/svg">'
                + defs + "".join(self.els) + "</svg>")


# =====================================================================================
# ERD (crow's-foot)
# =====================================================================================
ROW = 21
HDR = 28


def _foot(fig: Fig, x, y, dx, dy, kind, col):
    """Crow's-foot glyph at (x,y) on an entity border; (dx,dy) points away from the entity."""
    px, py = -dy, dx
    if kind == "many":
        tip = (x + dx * 13, y + dy * 13)
        for o in (-7, 0, 7):
            fig.line(tip[0], tip[1], x + px * o, y + py * o, stroke=col, sw=1.5, name="foot")
        a = (x + dx * 17, y + dy * 17)
        fig.line(a[0] + px * 6, a[1] + py * 6, a[0] - px * 6, a[1] - py * 6, stroke=col, sw=1.5,
                 name="foot")
    else:  # one (mandatory)
        for d in (7, 12):
            a = (x + dx * d, y + dy * d)
            fig.line(a[0] + px * 6, a[1] + py * 6, a[0] - px * 6, a[1] - py * 6, stroke=col,
                     sw=1.5, name="foot")


def erd(fig: Fig, entities: list[dict], rels: list[dict], note_hot="write lands here"):
    """entities: {id,x,y,w,title,cols:[(name,type,flag)] , tone?}; flag in {'PK','FK','hot','snap',''}
    rels: {a,a_side,a_row,a_card, b,b_side,b_row,b_card, via?} sides l/r/t/b; cards one/many.
    Rows referenced by column name; ``via`` = x (for l/r) or y (for t/b) of the elbow."""
    geo = {}
    for en in entities:
        x, y, w = en["x"], en["y"], en["w"]
        h = HDR + ROW * len(en["cols"]) + 6
        tone = en.get("tone", "ink")
        stroke = TONE[tone][0] if tone != "ink" else "var(--muted)"
        fig.rect(x, y, w, h, fill=en.get("fill", "var(--panel)"), stroke=stroke, sw=1.5, rx=7, name=en["id"])
        fig.raw(f'<path d="M{x},{y + 7} a7,7 0 0 1 7,-7 h{w - 14} a7,7 0 0 1 7,7 v{HDR - 7} h{-w} z" '
                f'fill="{TONE[tone][1] if tone != "ink" else "var(--chip)"}"/>')
        fig.text(x + 12, y + 19, en["title"], size=13, weight=700, font=HEAD)
        rows = {}
        for i, (name, typ, flag) in enumerate(en["cols"]):
            ry = y + HDR + i * ROW
            if flag in ("hot", "snap"):
                c = "var(--hot-soft)" if flag == "hot" else "var(--cool-soft)"
                fig.raw(f'<rect x="{x + 1.5}" y="{ry + 1}" width="{w - 3}" height="{ROW - 2}" fill="{c}"/>')
            tag = {"PK": "PK", "FK": "FK", "hot": "", "snap": "", "": ""}[flag]
            if tag:
                fig.text(x + 10, ry + 15, tag, size=9.5, weight=600, font=MONO,
                         fill="var(--cool)" if tag == "PK" else "var(--flow)")
            col = "var(--hot)" if flag == "hot" else "var(--ink)"
            fig.text(x + 36, ry + 15, name, size=11.5, font=MONO, fill=col,
                     weight=600 if flag == "PK" else 400)
            fig.text(x + w - 10, ry + 15, typ, size=10, font=MONO, fill="var(--faint)",
                     anchor="end")
            rows[name] = ry + ROW / 2
        geo[en["id"]] = (x, y, w, h, rows)

    for r in rels:
        pa = _anchor(geo[r["a"]], r["a_side"], r.get("a_row"))
        pb = _anchor(geo[r["b"]], r["b_side"], r.get("b_row"))
        col = r.get("color", "var(--muted)")
        (ax, ay, adx, ady), (bx, by, bdx, bdy) = pa, pb
        if r["a_side"] in "lr" and r["b_side"] in "lr":
            mx = r.get("via", (ax + bx) / 2)
            d = f"M{ax},{ay} H{mx} V{by} H{bx}"
            pts = [(ax, ay), (mx, ay), (mx, by), (bx, by)]
        elif r["a_side"] in "tb" and r["b_side"] in "tb":
            my = r.get("via", (ay + by) / 2)
            d = f"M{ax},{ay} V{my} H{bx} V{by}"
            pts = [(ax, ay), (ax, my), (bx, my), (bx, by)]
        else:  # l/r -> t/b single elbow
            d = f"M{ax},{ay} H{bx} V{by}"
            pts = [(ax, ay), (bx, ay), (bx, by)]
        fig.path(d, pts, stroke=col, sw=1.5, name="rel")
        _foot(fig, ax, ay, adx, ady, r["a_card"], col)
        _foot(fig, bx, by, bdx, bdy, r["b_card"], col)
    return geo


def _anchor(g, side, row):
    x, y, w, h, rows = g
    yy = rows[row] if row else y + h / 2
    if side == "l":
        return x, yy, -1, 0
    if side == "r":
        return x + w, yy, 1, 0
    xx = x + w / 2 if not row else x + w / 2
    return (xx, y, 0, -1) if side == "t" else (xx, y + h, 0, 1)


def entity_height(ncols: int) -> int:
    return HDR + ROW * ncols + 6


# =====================================================================================
# Document panel (JSON with highlighted lines + right-hand callouts)
# =====================================================================================
def doc_panel(fig: Fig, x, y, w, lines: list[str], title="", hot=(), cool=(), callouts=(),
              size=11.5, lh=18.5, callout_x=None, callout_w=None):
    """lines: raw JSON lines (leading spaces kept). hot/cool: line indexes to tint.
    callouts: [(line_idx, [text lines], tone)] drawn to the right of the panel with a leader."""
    top = y + (26 if title else 12)
    h = (top - y) + lh * len(lines) + 10
    fig.rect(x, y, w, h, fill="var(--panel)", stroke="var(--hairline)", rx=8, name="doc")
    if title:
        fig.text(x + 12, y + 18, title, size=10.5, weight=600, font=MONO, fill="var(--faint)")
    for i, ln in enumerate(lines):
        ry = top + i * lh
        if i in hot or i in cool:
            c = "var(--hot-soft)" if i in hot else "var(--cool-soft)"
            fig.raw(f'<rect x="{x + 2}" y="{ry}" width="{w - 4}" height="{lh}" fill="{c}"/>')
        ind = len(ln) - len(ln.lstrip(" "))
        s = ln.strip()
        col = "var(--hot)" if i in hot else ("var(--cool)" if i in cool else "var(--ink)")
        tx = x + 12 + ind * size * 0.61
        if tx + tw(s, size, MONO) > x + w - 8:
            raise FigureError(f"{fig.label}: doc line overflows panel: {s!r}")
        fig.text(tx, ry + lh * 0.72, s, size=size, font=MONO, fill=col)
    cx = callout_x if callout_x is not None else x + w + 34
    for idx, tlines, tone in callouts:
        ly = top + idx * lh + lh / 2
        colr = TONE[tone][0]
        fig.line(x + w, ly, cx - 8, ly, stroke=colr, sw=1.3, dash="3 3", name="leader")
        fig.circle(x + w, ly, 3, fill=colr)
        for k, t in enumerate(tlines):
            fig.text(cx, ly + 4 + k * 15, t, size=11.5 if k == 0 else 11,
                     weight=600 if k == 0 else 400, fill=colr if k == 0 else "var(--muted)")
    return h


# =====================================================================================
# Dials (three knobs)
# =====================================================================================
def dials(fig: Fig, items: list[dict], cy=86, r=46):
    """items: {x, name, value 0..1, tone, low, high, lines:[caption lines]}"""
    for it in items:
        x = it["x"]
        tone = TONE[it.get("tone", "cool")][0]
        a0, a1 = math.pi, 0.0  # semicircle left->right

        def pt(a, rr=r):
            return x + rr * math.cos(a), cy - rr * math.sin(a)

        sx, sy = pt(a0)
        ex, ey = pt(a1)
        fig.path(f"M{sx:.1f},{sy:.1f} A{r},{r} 0 0 1 {ex:.1f},{ey:.1f}", [(x - r, cy - r), (x + r, cy)],
                 stroke="var(--hairline)", sw=11, name="dial-track")
        av = math.pi * (1 - it["value"])
        vx, vy = pt(av)
        large = 0
        fig.path(f"M{sx:.1f},{sy:.1f} A{r},{r} 0 {large} 1 {vx:.1f},{vy:.1f}", [(x - r, cy - r), (x + r, cy)],
                 stroke=tone, sw=11, name="dial-val")
        nx, ny = pt(av, r - 14)
        fig.line(x, cy, nx, ny, stroke="var(--ink)", sw=2.5, name="needle")
        fig.circle(x, cy, 5, fill="var(--ink)")
        fig.text(x - r - 2, cy + 18, it.get("low", "low"), size=10, fill="var(--faint)", anchor="middle")
        fig.text(x + r + 2, cy + 18, it.get("high", "high"), size=10, fill="var(--faint)", anchor="middle")
        fig.text(x, cy + 40, it["name"], size=13.5, weight=700, font=HEAD, anchor="middle")
        fig.text(x, cy + 58, it["setting"], size=12, weight=600, fill=tone, anchor="middle")
        for k, t in enumerate(it.get("lines", [])):
            fig.text(x, cy + 76 + k * 15.5, t, size=11.2, fill="var(--muted)", anchor="middle")


def knob_rows(fig: Fig, x, y, items: list[dict], row_h=106, r=25):
    """Compact vertical stack of knob gauges with text to the right.
    items: {name, value 0..1, tone, setting, lines:[<=2 short lines]}"""
    for i, it in enumerate(items):
        cx, cy = x + r + 4, y + i * row_h + r + 16
        tone = TONE[it.get("tone", "cool")][0]

        def pt(a, rr=r):
            return cx + rr * math.cos(a), cy - rr * math.sin(a)

        sx, sy = pt(math.pi)
        ex, ey = pt(0)
        fig.path(f"M{sx:.1f},{sy:.1f} A{r},{r} 0 0 1 {ex:.1f},{ey:.1f}", [(cx - r - 4, cy - r - 4), (cx + r + 4, cy)],
                 stroke="var(--hairline)", sw=8, name="knob-track")
        av = math.pi * (1 - it["value"])
        vx, vy = pt(av)
        fig.path(f"M{sx:.1f},{sy:.1f} A{r},{r} 0 0 1 {vx:.1f},{vy:.1f}", [(cx - r - 4, cy - r - 4), (cx + r + 4, cy)],
                 stroke=tone, sw=8, name="knob-val")
        nx, ny = pt(av, r - 9)
        fig.line(cx, cy, nx, ny, stroke="var(--ink)", sw=2.2, name="needle")
        fig.circle(cx, cy, 3.6, fill="var(--ink)")
        tx = cx + r + 18
        fig.text(tx, cy - 16, it["name"], size=13, weight=700, font=HEAD)
        fig.text(tx, cy + 1, it["setting"], size=12, weight=600, fill=tone)
        for k, t in enumerate(it.get("lines", [])[:2]):
            fig.text(tx, cy + 18 + k * 15, t, size=11, fill="var(--muted)")


# =====================================================================================
# Breakpoint / cost-model chart
# =====================================================================================
def _nice_log_ticks(lo, hi):
    t, k = [], math.floor(math.log10(lo))
    while 10 ** k <= hi * 1.0001:
        if 10 ** k >= lo * 0.9999:
            t.append(10 ** k)
        k += 1
    return t


def _fmt(v):
    if v >= 1e9:
        return f"{v / 1e9:g}B"
    if v >= 1e6:
        return f"{v / 1e6:g}M"
    if v >= 1e3:
        return f"{v / 1e3:g}k"
    return f"{v:g}"


def chart(fig: Fig, box, xr, yr, curves, xlabel, ylabel, logx=False, logy=False, xticks=None,
          yticks=None, ytick_fmt=_fmt, xtick_fmt=_fmt, regions=(), markers=(), cross=None,
          legend=None, cross_label=None, samples=160, points=(), legend_dir="v"):
    """box=(x,y,w,h) plot area. curves: [{name, fn, tone, dash?}]. regions: [(x0,x1,tone,label)].
    markers: [(xv, label, tone)] vertical dashed lines. cross: (name_a, name_b) -> auto crossover dot.
    legend: (x,y) top-left of legend block."""
    px, py, pw, ph = box
    (x0, x1), (y0, y1) = xr, yr

    def sx(v):
        if logx:
            return px + (math.log10(v) - math.log10(x0)) / (math.log10(x1) - math.log10(x0)) * pw
        return px + (v - x0) / (x1 - x0) * pw

    def sy(v):
        if logy:
            v = max(v, y0)
            return py + ph - (math.log10(v) - math.log10(y0)) / (math.log10(y1) - math.log10(y0)) * ph
        return py + ph - (v - y0) / (y1 - y0) * ph

    # regions (drawn first)
    for a, b, tone, lab in regions:
        xa, xb = sx(max(a, x0)), sx(min(b, x1))
        fig.raw(f'<rect x="{xa:.1f}" y="{py}" width="{xb - xa:.1f}" height="{ph}" fill="{TONE[tone][1]}"/>')
        if lab:
            fig.text((xa + xb) / 2, py - 8, lab, size=11, weight=600, fill=TONE[tone][0], anchor="middle")
    # grid + ticks
    xt = xticks or (_nice_log_ticks(x0, x1) if logx else None)
    yt = yticks
    if yt:
        for v in yt:
            yy = sy(v)
            fig.line(px, yy, px + pw, yy, stroke="var(--hairline)", sw=1, name="grid")
            fig.text(px - 8, yy + 4, ytick_fmt(v), size=10.5, fill="var(--faint)", anchor="end", font=MONO)
    if xt:
        for v in xt:
            xx = sx(v)
            fig.line(xx, py + ph, xx, py + ph + 5, stroke="var(--faint)", sw=1, name="tick")
            fig.text(xx, py + ph + 18, xtick_fmt(v), size=10.5, fill="var(--faint)", anchor="middle", font=MONO)
    # axes
    fig.line(px, py + ph, px + pw + 6, py + ph, stroke="var(--faint)", sw=1.3, arrow=True, name="xaxis")
    fig.line(px, py + ph, px, py - 6, stroke="var(--faint)", sw=1.3, arrow=True, name="yaxis")
    fig.text(px + pw / 2, py + ph + 38, xlabel, size=11.5, fill="var(--muted)", anchor="middle", weight=600)
    # rotated y label
    ylx = px - 50
    yly = py + ph / 2
    w = tw(ylabel, 11.5, SANS, 600)
    fig.track(ylx - 12, yly - w / 2, ylx + 4, yly + w / 2, "ylabel")
    fig.raw(f'<text x="{ylx}" y="{yly}" font-size="11.5" font-family="{SANS}" font-weight="600" '
            f'fill="var(--muted)" text-anchor="middle" transform="rotate(-90 {ylx} {yly})">{e(ylabel)}</text>')
    # markers
    for xv, lab, tone in markers:
        xx = sx(xv)
        fig.line(xx, py + 22, xx, py + ph, stroke=TONE[tone][0], sw=1.3, dash="4 4", name="marker")
        fig.text(xx + 5, py + 36, lab, size=10.5, weight=600, fill=TONE[tone][0])
    # curves
    pts_by = {}
    for c in curves:
        pts = []
        for i in range(samples + 1):
            t = i / samples
            v = (10 ** (math.log10(x0) + t * (math.log10(x1) - math.log10(x0)))) if logx else x0 + t * (x1 - x0)
            yv = c["fn"](v)
            yy = min(max(sy(yv), py), py + ph)
            pts.append((sx(v), yy, v, yv))
        pts_by[c["name"]] = pts
        d = "M" + " L".join(f"{p[0]:.1f},{p[1]:.1f}" for p in pts)
        fig.path(d, [(p[0], p[1]) for p in pts], stroke=TONE[c["tone"]][0], sw=2.6,
                 dash=c.get("dash"), name="curve:" + c["name"])
    # crossover
    if cross:
        a, b = pts_by[cross[0]], pts_by[cross[1]]
        for i in range(1, len(a)):
            da0, da1 = a[i - 1][3] - b[i - 1][3], a[i][3] - b[i][3]
            if da0 == 0 or da0 * da1 < 0:
                f = da0 / (da0 - da1) if da0 != da1 else 0
                cxp = a[i - 1][0] + f * (a[i][0] - a[i - 1][0])
                cyp = a[i - 1][1] + f * (a[i][1] - a[i - 1][1])
                fig.circle(cxp, cyp, 5.5, fill="var(--ink)")
                if cross_label:
                    dx, anchor = cross_label.get("dx", 10), cross_label.get("anchor", "start")
                    for k, t in enumerate(cross_label["lines"]):
                        fig.text(cxp + dx, cyp + cross_label.get("dy", -12) + k * 14.5, t, size=11,
                                 weight=700 if k == 0 else 400, anchor=anchor,
                                 fill="var(--ink)" if k == 0 else "var(--muted)")
                break
    # annotated points on a curve: (x value, curve name, label, dx, dy, anchor)
    fns = {c["name"]: c["fn"] for c in curves}
    for xv, cname, lab, dx, dy, anchor in points:
        xx, yy = sx(xv), sy(fns[cname](xv))
        fig.circle(xx, yy, 4.5, fill="var(--panel)", stroke="var(--ink)", sw=2)
        fig.text(xx + dx, yy + dy, lab, size=11, weight=600, fill="var(--ink)", anchor=anchor)
    if legend:
        lx, ly = legend
        for k, c in enumerate(curves):
            fig.line(lx, ly, lx + 24, ly, stroke=TONE[c["tone"]][0], sw=3, dash=c.get("dash"), name="legend", seg=False)
            w = fig.text(lx + 32, ly + 4, c["name"], size=11.5, fill="var(--ink)")
            if legend_dir == "h":
                lx += 32 + w + 26
            else:
                ly += 18
    return sx, sy


# =====================================================================================
# Flow diagram (columns of nodes, bus routing, automatic step-overs)
# =====================================================================================
class Flow:
    """Nodes are placed explicitly; edges are routed right-then-vertical-then-right through a
    lane between columns. Horizontal runs step over any earlier vertical run they cross."""

    def __init__(self, fig: Fig):
        self.fig = fig
        self.nodes: dict[str, tuple] = {}
        self.vsegs: list[tuple[float, float, float]] = []  # (x, y0, y1)

    def node(self, nid, x, y, w, h, lines, tone="ink", fill="var(--panel)", size=13, sub=11.2):
        self.fig.box(x, y, w, h, lines, tone=tone, fill=fill, size=size, sub_size=sub, name=nid)
        self.nodes[nid] = (x, y, w, h)

    def label(self, x, y, s, tone="muted", size=11, anchor="middle", weight=600):
        self.fig.text(x, y, s, size=size, fill=TONE[tone][0], anchor=anchor, weight=weight, font=MONO)

    def _hrun(self, x1, x2, y, r=5.5):
        """SVG path fragment for a horizontal run from x1 to x2 at y with bridges."""
        lo, hi = sorted((x1, x2))
        hops = sorted(vx for vx, a, b in self.vsegs if lo + r + 2 < vx < hi - r - 2 and a + 1 < y < b - 1)
        if x2 < x1:
            hops = hops[::-1]
        s = ""
        for hx in hops:
            if x2 > x1:
                s += f" H{hx - r:.1f} A{r},{r} 0 0 1 {hx + r:.1f},{y:.1f}"
            else:
                s += f" H{hx + r:.1f} A{r},{r} 0 0 0 {hx - r:.1f},{y:.1f}"
        return s + f" H{x2:.1f}"

    def edge(self, a, b, lane_x, tone="flow", ay=None, by=None, label=None, dash=None):
        ax, ay0, aw, ah = self.nodes[a]
        bx, by0, bw, bh = self.nodes[b]
        y1 = ay if ay is not None else ay0 + ah / 2
        y2 = by if by is not None else by0 + bh / 2
        sx, ex = ax + aw, bx
        col = TONE[tone][0]
        d = f"M{sx:.1f},{y1:.1f}" + self._hrun(sx, lane_x, y1)
        if abs(y2 - y1) > 0.5:
            d += f" V{y2:.1f}"
        d += self._hrun(lane_x, ex - 1, y2)
        self.fig.path(d, [(sx, y1), (lane_x, y1), (lane_x, y2), (ex, y2)], stroke=col, sw=1.7,
                      arrow=True, dash=dash, name=f"edge:{a}->{b}")
        if abs(y2 - y1) > 0.5:
            self.vsegs.append((lane_x, min(y1, y2), max(y1, y2)))
        if label:
            self.fig.text((lane_x + ex) / 2, y2 - 7, label, size=10, fill=col, anchor="middle", font=MONO)

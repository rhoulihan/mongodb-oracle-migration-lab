#!/usr/bin/env python3
"""README figures for the migration lab. Stdlib only.

    python3 docs/figures/build_figures.py      # writes docs/figures/*.svg

House style: Oracle palette, Segoe UI, white background, rounded boxes with an
accent bar, orthogonal connectors with a context-stroke arrowhead. Every
element registers its bounding box; the build fails if anything comes within
PAD px of the frame.
"""
import os
import sys

OUT = os.path.dirname(os.path.abspath(__file__))
W = 960
PAD = 16

INK = "#1a1a1a"; MUTE = "#5b6570"; FAINT = "#8a929b"; RULE = "#dfe3e7"; PANEL = "#f6f7f9"
RED = "#C74634"; REDSOFT = "#fdf6f5"; GREEN = "#16a34a"; GREENSOFT = "#f0fdf4"
BLUE = "#2563eb"; BLUESOFT = "#eff6ff"; AMBER = "#d97706"; AMBERSOFT = "#fffbeb"; SLATE = "#334155"
FONT = "'Segoe UI',system-ui,-apple-system,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Fig:
    def __init__(self, name, h, title, sub):
        self.name, self.h = name, h
        self.parts, self.bounds = [], []
        self.text(PAD + 8, 36, title, 18, RED, w=700)
        self.text(PAD + 8, 58, sub, 12.5, MUTE)

    def _b(self, x0, y0, x1, y1, what):
        self.bounds.append((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), what))

    # text: one line, or a list of lines (dy apart)
    def text(self, x, y, s, size=12, fill=INK, w=None, anchor="start", mono=False, dy=None):
        lines = s if isinstance(s, list) else [s]
        dy = dy or size * 1.4
        for i, ln in enumerate(lines):
            yy = y + i * dy
            a = f' text-anchor="{anchor}"' if anchor != "start" else ""
            wt = f' font-weight="{w}"' if w else ""
            ff = f' font-family="{MONO}"' if mono else ""
            self.parts.append(f'<text x="{x}" y="{yy:.1f}" font-size="{size}" fill="{fill}"{wt}{ff}{a}>{esc(ln)}</text>')
            tw = len(ln) * size * (0.6 if mono else (0.6 if w else 0.55))
            x0 = x - tw / 2 if anchor == "middle" else (x - tw if anchor == "end" else x)
            self._b(x0, yy - size * 0.8, x0 + tw, yy + size * 0.25, f"text {ln!r}")
        return y + len(lines) * dy

    def box(self, x, y, w, h, stroke=SLATE, fill="#ffffff", accent=None, dash=None, rx=6, sw=1.6):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
        if accent:
            self.parts.append(f'<rect x="{x}" y="{y}" width="5" height="{h}" rx="2" fill="{accent}"/>')
        self._b(x - sw, y - sw, x + w + sw, y + h + sw, f"box at {x},{y}")

    def card(self, x, y, w, h, title, lines=(), accent=SLATE, num=None, fill="#ffffff", dash=None,
             size=11.5, tag=None, title_color=INK, mono_lines=()):
        """Box with an optional red step number, a bold title and body lines."""
        self.box(x, y, w, h, stroke=accent if accent != SLATE else SLATE, fill=fill, accent=accent, dash=dash)
        tx = x + 16
        if num is not None:
            self.parts.append(f'<circle cx="{x + 26}" cy="{y + 22}" r="11" fill="{RED}"/>')
            self.parts.append(f'<text x="{x + 26}" y="{y + 26.5}" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">{num}</text>')
            self._b(x + 15, y + 11, x + 37, y + 33, "num")
            tx = x + 46
        self.text(tx, y + 27, title, 13.5, title_color, w=700)
        yy = y + 50
        for ln in lines:
            mono = ln in mono_lines
            self.text(x + 16, yy, ln, size, MUTE if not mono else SLATE, mono=mono)
            yy += size * 1.45
        if tag:
            self.text(x + w - 12, y + h - 12, tag, 10.5, FAINT, anchor="end")

    def path(self, pts, stroke=BLUE, sw=1.8, arrow=True, both=False, dash=None):
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        m = ' marker-end="url(#ar)"' if arrow else ""
        if both:
            m += ' marker-start="url(#ar)"'
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{sw}"{m}{da}/>')
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        self._b(min(xs) - 5, min(ys) - 5, max(xs) + 5, max(ys) + 5, f"path {pts}")

    def pill(self, x, y, w, label, color, soft, size=11.5):
        self.box(x, y, w, 26, stroke=color, fill=soft, rx=13, sw=1.4)
        self.text(x + w / 2, y + 17.5, label, size, color, w=700, anchor="middle")

    def save(self):
        bad = [b for b in self.bounds if b[0] < PAD or b[1] < PAD or b[2] > W - PAD or b[3] > self.h - PAD]
        if bad:
            for b in bad:
                print(f"{self.name}: out of frame {b}", file=sys.stderr)
            sys.exit(1)
        svg = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{self.h}" viewBox="0 0 {W} {self.h}" font-family="{FONT}">',
            '<defs><marker id="ar" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            '<path d="M0,0 L10,5 L0,10 Z" fill="context-stroke"/></marker></defs>',
            '<rect width="100%" height="100%" fill="#ffffff"/>',
            *self.parts, '</svg>', '']
        with open(os.path.join(OUT, f"{self.name}.svg"), "w") as f:
            f.write("\n".join(svg))
        print(f"wrote {self.name}.svg")


# ---------------------------------------------------------------------------
def lab_stack():
    f = Fig("lab-stack", 444, "What runs on the laptop",
            "One compose stack. Every port binds to 127.0.0.1, and after setup it runs with no network.")
    f.box(PAD + 4, 76, W - 2 * PAD - 8, 344, stroke=RULE, fill=PANEL, dash="5 4")
    f.text(W - PAD - 18, 96, "127.0.0.1 only", 11, FAINT, anchor="end")
    f.card(40, 108, 220, 92, "lab-console  :3200", ["Instructor console:", "runs and checks each step"], accent=BLUE)
    f.card(40, 300, 220, 92, "lab-app  :3300", ["Order service the demos drive;", "backend MongoDB or Oracle"], accent=BLUE)
    f.card(400, 108, 230, 92, "lab-mongo  :27117", ["MongoDB 8.2, replica set rs0", "the migration source"], accent=GREEN)
    f.card(400, 250, 230, 142, "lab-oracle", ["Oracle AI Database 26ai Free", "SQL  :1523  (schema MIG)", "ORDS  :8183",
                                              "Oracle API for MongoDB  :27119"], accent=RED)
    f.card(700, 182, 220, 92, "lab-replicator", ["stand-in for Oracle GoldenGate", "demo 4 only (profile d4)"],
           accent=AMBER, dash="5 4")
    # console and app reach both databases over one bus
    f.path([(260, 154), (330, 154)], BLUE, arrow=False)
    f.path([(260, 346), (330, 346)], BLUE, arrow=False)
    f.path([(330, 154), (330, 346)], BLUE, arrow=False)
    f.path([(330, 154), (400, 154)], BLUE)
    f.path([(330, 320), (400, 320)], BLUE)
    # replicator: MongoDB change stream in, Oracle API out (and back for the fallback)
    f.path([(630, 130), (810, 130), (810, 182)], AMBER, both=True)
    f.path([(810, 274), (810, 356), (630, 356)], AMBER, both=True)
    f.text(720, 122, "change stream", 11, AMBER, anchor="middle")
    f.text(720, 348, "MongoDB API", 11, AMBER, anchor="middle")
    f.save()


def session_flow():
    f = Fig("session-flow", 400, "The session, demo by demo",
            "Seven live demos in run-sheet order. Two need a reset afterwards; D6 setup starts while you talk.")
    f.box(28, 78, 904, 40, stroke=SLATE, fill=PANEL, accent=SLATE)
    f.text(44, 103, "Before the session:  ./lab.sh reset  then  ./lab.sh generate  (fresh data, carts still expiring)", 12, INK)
    demos = [("D1", "0:10, 3 min", ["Compatibility", "and type census"], "console"),
             ("D2", "0:22, 4 min", ["Age out"], "both"),
             ("D3", "0:36, 4 min", ["Dump, restore,", "prove it"], "both"),
             ("D4", "0:50, 4 min", ["Live sync", "and cutover"], "both"),
             ("D5", "1:00, 4 min", ["Top-N counter,", "three ways"], "both"),
             ("D6", "1:08, 4 min", ["Pipeline", "vs $sql"], "both"),
             ("D7", "1:15, 3 min", ["ETags, two", "agents"], "both")]
    bw, gap, x0, y0, bh = 114, 18, 28, 150, 110
    xs = [x0 + i * (bw + gap) for i in range(7)]
    for x, (d, clock, title, lane) in zip(xs, demos):
        f.box(x, y0, bw, bh, stroke=SLATE, accent=RED)
        f.text(x + 14, y0 + 26, d, 16, RED, w=700)
        f.text(x + bw - 10, y0 + 25, clock.split(",")[0], 11, FAINT, anchor="end")
        f.text(x + 14, y0 + 50, title, 11.5, INK, dy=16)
        f.text(x + 14, y0 + bh - 12, "console" if lane == "console" else "console + terminal", 9.5, MUTE)
    for i in range(6):
        f.path([(xs[i] + bw, y0 + 40), (xs[i + 1], y0 + 40)], SLATE, sw=1.6)
    for i, label in ((1, "./lab.sh reset d2"), (3, "./lab.sh reset d4")):
        gx = xs[i] + bw + gap / 2
        f.path([(gx, y0 + 40), (gx, 282)], RED, sw=1.4, dash="4 3", arrow=False)
        f.box(gx - 66, 282, 132, 26, stroke=RED, fill=REDSOFT, rx=13, sw=1.4)
        f.text(gx, 299, label, 11, RED, w=700, anchor="middle", mono=True)
    c5, c6 = xs[4] + bw - 30, xs[5] + 30
    f.path([(c5, y0 + bh), (c5, 334), (c6, 334), (c6, y0 + bh)], GREEN, sw=1.6)
    f.text((c5 + c6) / 2, 356, "D6 setup starts after D5's last step", 11, GREEN, anchor="middle")
    f.text((c5 + c6) / 2, 372, "and runs during slides 35 to 37", 11, GREEN, anchor="middle")
    f.save()


def drive_workflow():
    f = Fig("drive-workflow", 500, "The clicker drives the demos",
            "Share one display and never switch. Each press reaches the autopilot, which runs one step and logs it.")
    f.card(40, 84, 240, 92, "Your clicker", ["Right arrow or Page Down: on a", "demo slide it starts the demo,",
                                             "then one step per press"], accent=RED)
    f.card(360, 84, 240, 92, "Deck, notes or console", ["the window with the focus posts", "the press to /api/remote/key",
                                                       "(tmux binds Right arrow too)"], accent=BLUE)
    f.card(680, 84, 240, 92, "./lab.sh drive autopilot", ["on the host: takes each press,", "runs the step, logs the result"],
           accent=SLATE)
    f.path([(280, 130), (360, 130)], BLUE)
    f.path([(600, 130), (680, 130)], BLUE)
    # one bus from the autopilot to the three windows a step can use
    f.path([(800, 176), (800, 236)], BLUE)
    f.path([(800, 206), (160, 206), (160, 236)], BLUE)
    f.path([(480, 206), (480, 236)], BLUE)
    f.text(320, 198, "window in front, then the step", 11, BLUE, anchor="middle")
    f.card(40, 236, 240, 106, "Console in Chrome", ["console steps: the page presses", "its own button, same timer",
                                                   "and result as a click"], accent=GREEN)
    f.card(360, 236, 240, 106, "Shared terminal (tmux)", ["terminal steps type themselves,", "then Mark done in the console;",
                                                         "A and B panes for D7"], accent=GREEN)
    f.card(680, 236, 240, 106, "MongoDB Compass", ["D7 step 7: the filter is on the", "clipboard; you paste, click Find,",
                                                  "then click the speaker notes"], accent=AMBER)
    for x in (160, 480, 800):
        f.path([(x, 342), (x, 384)], GREEN)
    f.box(40, 384, 880, 58, stroke=SLATE, fill=PANEL, accent=SLATE)
    f.text(56, 407, "The shared display: the deck between demos, each step's window in front", 13, INK, w=700)
    f.text(56, 428, "The press after the last step brings the deck back, still on the demo slide, with the focus.", 11.5, MUTE)
    f.text(40, 470, "Claude watches the autopilot log and posts each result and the line to say, on the laptop.", 11.5, MUTE)
    f.save()


def d1_compat():
    f = Fig("d1-compat", 390, "Demo 1: will it run, and will the data come across?",
            "Two read-only checks against the source, before anything moves.")
    cols = [36, 355, 674]; cw = 250
    f.text(36, 90, "Will the app's queries run on the Oracle API for MongoDB?", 12, RED, w=700)
    f.card(cols[0], 102, cw, 108, "Order service + pipelines", ["app/**/*.mjs and the D5 and", "D6 aggregation stages"], accent=SLATE)
    f.card(cols[1], 102, cw, 108, "Operator scan", ["lists every $ operator, looks it", "up in the compatibility matrix"], accent=BLUE)
    f.box(cols[2], 102, cw, 108, stroke=SLATE, accent=SLATE)
    f.pill(cols[2] + 14, 112, 72, "supported", GREEN, GREENSOFT, size=10)
    f.pill(cols[2] + 92, 112, 72, "caveat", AMBER, AMBERSOFT, size=10)
    f.pill(cols[2] + 170, 112, 72, "unsupported", RED, REDSOFT, size=10)
    f.text(cols[2] + 16, 160, ["Order service: 8 of 8 supported", "Demo pipelines: 21 supported,", "2 caveat, 1 unsupported"], 11.5, INK, dy=17)
    f.text(36, 250, "Will the data come across as it is?", 12, RED, w=700)
    f.card(cols[0], 262, cw, 108, "MongoDB source", ["8 collections, database telco"], accent=GREEN)
    f.card(cols[1], 262, cw, 108, "BSON type census", ["the types seen in every field", "of every collection"], accent=BLUE)
    f.card(cols[2], 262, cw, 108, "Landmines flagged", ["regex (catalog.skuPattern), Timestamp,",
                                                        "Decimal128 trailing zeros, and arrays:",
                                                        "$type does not match their elements"], accent=RED, size=11)
    for y in (156, 316):
        f.path([(cols[0] + cw, y), (cols[1], y)], BLUE)
        f.path([(cols[1] + cw, y), (cols[2], y)], BLUE)
    f.save()


def d2_ageout():
    f = Fig("d2-ageout", 446, "Demo 2: age out",
            "Move what lives long. New orders go to Oracle; old ones stay readable on MongoDB until they age out.")
    f.card(32, 80, 230, 232, "MongoDB (source)", ["keeps orders, carts and", "orderEvents", "", "old orders: read-only",
                                                 "from the cutoff on", "", "carts expire here by TTL;", "nothing short-lived moves"],
           accent=GREEN)
    f.card(698, 80, 230, 232, "Oracle (target, MIG)", ["regions, catalog, accounts,", "subscribers: copied once", "",
                                                      "new orders, their events", "and the Top-N update", "",
                                                      "Oracle holds 0 carts"], accent=RED)
    f.path([(262, 136), (698, 136)], AMBER)
    f.text(480, 126, "1   ./lab.sh migrate-entities", 11.5, AMBER, w=700, anchor="middle", mono=True)
    f.text(480, 156, "the long-lived collections only", 11, AMBER, anchor="middle")
    f.card(365, 186, 230, 112, "Age-out router", ["./lab.sh app-mode ageout", "cutoff: 1 ms after the newest", "order on MongoDB"],
           accent=BLUE, num=2)
    f.path([(595, 222), (698, 222)], BLUE)
    f.text(646, 214, "new orders", 11, BLUE, anchor="middle")
    f.path([(262, 262), (365, 262)], GREEN)
    f.text(314, 254, "old orders", 11, GREEN, anchor="middle")
    f.path([(698, 276), (595, 276)], RED)
    f.text(646, 268, "since cutoff", 11, RED, anchor="middle")
    f.path([(480, 298), (480, 370)], BLUE)
    f.box(200, 370, 560, 54, stroke=BLUE, fill=BLUESOFT, accent=BLUE)
    f.text(218, 393, "3   One read across the cutoff", 12.5, INK, w=700)
    f.text(218, 412, "MongoDB rows + Oracle rows, merged newest first: equal to the union by _id", 11, MUTE)
    f.save()


def d3_dump_restore():
    f = Fig("d3-dump-restore", 384, "Demo 3: dump, restore, prove it",
            "The standard tools, unchanged. Then prove the counts, the types, the app and the indexes.")
    cw, xs = 260, [36, 350, 664]
    row = [(1, "Dump the source", ["mongodump --archive --gzip:", "8 collections in one file"], "terminal"),
           (2, "Restore as MIG", ["mongorestore into pre-created", "collections; read the time aloud"], "terminal"),
           (3, "Counts match the dump", ["compared at the dump snapshot;", "TTL keeps expiring on both sides"], "console")]
    row2 = [(4, "The $type differential", ["regex vs object, Int64 exact,", "Decimal128 loses trailing zeros"], "console"),
            (5, "Same app, now on Oracle", ["./lab.sh app-uri oracle, then", "a smoke test, code unchanged"], "terminal + console"),
            (6, "The index came across", ["explain: INDEX RANGE SCAN", "(MULTI VALUE) from the dump"], "terminal")]
    for (n, t, ls, lane), x in zip(row, xs):
        f.card(x, 84, cw, 110, t, ls, accent=BLUE, num=n, tag=lane)
    for (n, t, ls, lane), x in zip(row2, xs):
        f.card(x, 254, cw, 110, t, ls, accent=GREEN, num=n, tag=lane)
    for y, accent in ((139, BLUE), (309, GREEN)):
        f.path([(xs[0] + cw, y), (xs[1], y)], accent)
        f.path([(xs[1] + cw, y), (xs[2], y)], accent)
    f.path([(xs[2] + cw / 2, 194), (xs[2] + cw / 2, 224), (xs[0] + cw / 2, 224), (xs[0] + cw / 2, 254)], SLATE)
    f.save()


def d4_bluegreen():
    f = Fig("d4-bluegreen", 478, "Demo 4: live sync, cutover, and a way back",
            "The replicator is a stand-in for Oracle GoldenGate. Both directions run in the lab; cutover is one command.")
    xs, cw = [30, 216, 402, 588, 774], 156
    f.text(30, 98, "Forward, before cutover", 12, RED, w=700)
    f.card(xs[0], 110, cw, 86, "Order service", ["writes to MongoDB"], accent=BLUE)
    f.card(xs[1], 110, cw, 86, "MongoDB", ["the source, live"], accent=GREEN)
    f.card(xs[2], 110, cw, 86, "Replicator fwd", ["stand-in for", "Oracle GoldenGate"], accent=AMBER, dash="5 4")
    f.card(xs[3], 110, cw, 86, "Oracle", ["through the", "MongoDB API"], accent=RED)
    f.card(xs[4], 110, cw, 86, "Kill it any time", ["resumes from its token:", "no loss, no doubles"], accent=SLATE,
           fill=PANEL, size=10.5)
    for i in range(3):
        f.path([(xs[i] + cw, 153), (xs[i + 1], 153)], BLUE)
    f.box(30, 222, 900, 46, stroke=RED, fill=REDSOFT, accent=RED)
    f.text(48, 250, "Cutover:  ./lab.sh repl stop  (drains to lag 0)  then  ./lab.sh app-uri oracle", 12.5, INK, w=700)
    f.text(30, 300, "Reverse, the fallback path", 12, RED, w=700)
    f.card(xs[0], 312, cw, 86, "No ping-pong", ["triggers skip the", "forward session"], accent=SLATE, fill=PANEL, size=10.5)
    f.card(xs[1], 312, cw, 86, "MongoDB", ["stays current:", "a way back"], accent=GREEN)
    f.card(xs[2], 312, cw, 86, "Replicator rev", ["polls mig_changelog", "every 250 ms"], accent=AMBER, dash="5 4")
    f.card(xs[3], 312, cw, 86, "Oracle", ["row triggers write", "mig_changelog"], accent=RED)
    f.card(xs[4], 312, cw, 86, "Order service", ["now writes to Oracle"], accent=BLUE)
    for i in range(4, 1, -1):
        f.path([(xs[i], 355), (xs[i - 1] + cw, 355)], RED)
    f.box(216, 420, 528, 40, stroke=GREEN, fill=GREENSOFT, accent=GREEN)
    f.text(234, 445, "Proof: same count and sha-256 on both sides, no lost or doubled writes", 12, INK, w=700)
    f.save()


def d5_topn():
    f = Fig("d5-topn", 392, "Demo 5: a Top-N counter, three ways",
            "The same dashboard document from three designs. Watch what each order writes and what each read costs.")
    xs, cw, y, h = [28, 338, 648], 284, 80, 214
    cols = [
        ("(a) Embedded counter document", RED,
         [("Each order", "one $inc rewrites the"), ("", "whole 9.5 KB document"),
          ("Each read", "the whole document;"), ("", "the client sorts, keeps 10"), ("Redo per order", "about 17 KB"),
          ("Read", "about 0.6 ms")]),
        ("(b) Counter documents, $lookup", AMBER,
         [("Each order", "$inc one counter document"), ("", ""),
          ("Each read", "the app's own pipeline:"), ("", "sort, limit 10, $lookup"), ("Redo per order", "about 5 KB"),
          ("Read", "0.6 to 0.7 ms")]),
        ("(c) Converged counter", GREEN,
         [("Each order", "adds 1 to one counter row"), ("", ""),
          ("Each read", "one document from a view,"), ("", "SQL owned by the database"), ("Redo per order", "about 3.5 KB"),
          ("Read", "about 0.4 ms")]),
    ]
    for x, (title, color, rows) in zip(xs, cols):
        f.box(x, y, cw, h, stroke=color, accent=color)
        f.text(x + 18, y + 30, title, 14, color, w=700)
        yy = y + 62
        for k, v in rows:
            if k == "" and v == "":
                continue
            if k:
                f.text(x + 18, yy, k, 11, FAINT, w=700)
            f.text(x + 124, yy, v, 11.5, INK)
            yy += 24 if k or v else 0
    f.box(28, 316, 904, 58, stroke=GREEN, fill=GREENSOFT, accent=GREEN)
    f.text(46, 339, "Proof first: all 8 region dashboards are identical across the three, and only then do the times appear.", 12, INK, w=700)
    f.text(46, 359, "Redo includes the order itself. Measured on the Mac: relative numbers, not a benchmark.", 11, MUTE)
    f.save()


def d6_sql():
    f = Fig("d6-sql", 412, "Demo 6: the same question, two ways, one engine",
            "Top 5 subscribers by spend, per region and plan tier, over the last 90 days, with the plan name.")
    lx, sx, px, gx = 32, 242, 572, 762
    f.card(lx, 88, 180, 112, "Aggregation", ["pipeline, through", "the MongoDB API"], accent=AMBER)
    f.box(sx, 88, 300, 112, stroke=SLATE, accent=SLATE)
    f.text(sx + 18, 116, "the stages", 11, FAINT, w=700)
    f.text(sx + 18, 142, ["$match, $lookup x3, $unwind,", "$group, $sort, $limit"], 12, SLATE, mono=True, dy=20)
    f.card(px, 88, 160, 112, "Oracle plan", ["nested loops for", "the three $lookups"], accent=AMBER)
    f.card(lx, 248, 180, 112, "One $sql stage", ["the same question", "as SQL"], accent=GREEN)
    f.box(sx, 248, 300, 112, stroke=SLATE, accent=SLATE)
    f.text(sx + 18, 276, "the statement", 11, FAINT, w=700)
    f.text(sx + 18, 302, ["SELECT ... JOIN ... JOIN ...", "RANK() OVER (PARTITION BY", "region, tier ORDER BY spend)"],
           11.5, SLATE, mono=True, dy=19)
    f.card(px, 248, 160, 112, "Oracle plan", ["hash joins +", "WINDOW SORT", "PUSHED RANK"], accent=GREEN)
    for y in (144, 304):
        f.path([(lx + 180, y), (sx, y)], BLUE)
        f.path([(sx + 300, y), (px, y)], BLUE)
        f.path([(px + 160, y), (gx, y)], BLUE)
    f.box(gx, 88, 166, 272, stroke=RED, fill=REDSOFT, accent=RED)
    f.text(gx + 18, 116, "Equal first", 14, RED, w=700)
    f.text(gx + 18, 140, ["160 rows, identical", "on all three"], 11.5, INK, dy=17)
    f.text(gx + 18, 202, "Then the timing", 12, INK, w=700)
    f.text(gx + 18, 224, ["about 85 to 90x", "on the Mac,", "warm against warm"], 11.5, INK, dy=17)
    f.text(gx + 18, 300, ["In the field:", "3 to 15x"], 11.5, MUTE, dy=17)
    f.text(32, 388, "Same engine, same data, statistics gathered, both sides warmed once. Laptop times are relative.", 11, MUTE)
    f.save()


def d7_etag():
    f = Fig("d7-etag", 512, "Demo 7: two agents, one order, no lost update",
            "Both agents read the same ETag. The second write with a stale ETag is rejected, not silently overwritten.")
    ax, dx, bx = 190, 480, 770
    f.card(ax - 100, 78, 200, 52, "Agent A", [], accent=BLUE)
    f.card(dx - 120, 78, 240, 52, "Duality view orders_dv", [], accent=RED)
    f.card(bx - 100, 78, 200, 52, "Agent B", [], accent=BLUE)
    for x in (ax, dx, bx):
        f.path([(x, 130), (x, 430)], FAINT, sw=1.2, arrow=False, dash="4 4")
    y = 160

    def msg(frm, to, label, color=BLUE, reply=None, rcolor=None, n=None):
        nonlocal y
        f.path([(frm, y), (to - 6 if to > frm else to + 6, y)], color)
        mid = (frm + to) / 2
        f.text(mid, y - 7, label, 11, color, anchor="middle")
        if n:
            nx = frm - 28 if frm < to else frm + 28
            f.parts.append(f'<circle cx="{nx}" cy="{y}" r="10" fill="{RED}"/>')
            f.parts.append(f'<text x="{nx}" y="{y + 4}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">{n}</text>')
            f._b(nx - 10, y - 10, nx + 10, y + 10, "num")
        y += 26
        if reply:
            f.path([(to, y), (frm - 6 if frm > to else frm + 6, y)], rcolor or color, sw=1.4, dash="5 3")
            f.text(mid, y - 7, reply, 11, rcolor or MUTE, anchor="middle", w=700 if rcolor else None)
        y += 30

    msg(ax, dx, "read", reply="order + ETag e1", n=1)
    msg(bx, dx, "read", reply="same order, same ETag e1", n=2)
    msg(ax, dx, "write status = provisioned, ETag e1", reply="accepted: 1 update", rcolor=GREEN, n=3)
    msg(bx, dx, "write device swap, ETag e1 (stale)", color=AMBER, reply="rejected: ORA-42699", rcolor=RED, n=4)
    msg(bx, dx, "re-read (ETag e2), reapply, write", reply="accepted: 2 updates", rcolor=GREEN, n=5)
    f.box(dx - 230, 444, 460, 44, stroke=GREEN, fill=GREENSOFT, accent=GREEN)
    f.text(dx - 212, 471, "Final order: both changes, exactly 2 updates applied", 12.5, INK, w=700)
    f.save()


if __name__ == "__main__":
    for fn in (lab_stack, session_flow, drive_workflow, d1_compat, d2_ageout, d3_dump_restore, d4_bluegreen,
               d5_topn, d6_sql, d7_etag):
        fn()

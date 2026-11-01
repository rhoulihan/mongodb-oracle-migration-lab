"""Fixture tests for qa_deck.py: each fixture is a tiny Reveal deck that breaks exactly one rule.

  pytest deck/build/test_qa_deck.py

Fixtures are written to a temp dir at run time (banned characters are built from code
points, so this file passes the repo's copy lint). Each fixture links the real vendored
Reveal, theme and fonts through symlinks, so QA measures with the deck's own CSS.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

BUILD = Path(__file__).resolve().parent
DECK_DIR = BUILD.parent
QA = BUILD / "qa_deck.py"
EM_DASH = chr(0x2014)
OLD_VERSION = "23" + "ai"

NOTE = '<aside class="notes">Say this out loud.</aside>'
OK_SLIDE = f'<section><h2>Short title</h2><p>One accent line.</p>{NOTE}</section>'


def deck(body: str, head: str = "") -> str:
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>fixture</title>
<link rel="stylesheet" href="vendor/reveal/dist/reset.css">
<link rel="stylesheet" href="vendor/reveal/dist/reveal.css">
<link rel="stylesheet" href="fonts/fonts.css">
<link rel="stylesheet" href="theme.css">{head}
</head><body><div class="reveal"><div class="slides">
<section data-segment="0">{body}</section>
</div></div>
<script src="vendor/reveal/dist/reveal.js"></script>
<script src="vendor/reveal/plugin/notes/notes.js"></script>
<script src="deck.js"></script>
</body></html>
"""


def run_qa(tmp_path: Path, html: str, *args: str) -> subprocess.CompletedProcess:
    for name in ("vendor", "fonts", "theme.css", "deck.js"):
        link = tmp_path / name
        if not link.exists():
            link.symlink_to(DECK_DIR / name)
    p = tmp_path / "index.html"
    p.write_text(html, encoding="utf-8")
    return subprocess.run([sys.executable, str(QA), str(p), *args],
                          capture_output=True, text=True, timeout=300)


def test_clean_fixture_passes(tmp_path):
    r = run_qa(tmp_path, deck(OK_SLIDE + OK_SLIDE), "--offline")
    assert r.returncode == 0, r.stdout + r.stderr


def test_clean_fixture_passes_dark(tmp_path):
    r = run_qa(tmp_path, deck(OK_SLIDE), "--dark")
    assert r.returncode == 0, r.stdout + r.stderr


def test_overflowing_slide_fails(tmp_path):
    tall = f'<section><h2>Too tall</h2><div style="height:1400px;flex:none">x</div>{NOTE}</section>'
    r = run_qa(tmp_path, deck(OK_SLIDE + tall))
    assert r.returncode == 1
    assert "overflow" in r.stdout


def test_too_many_lines_fails(tmp_path):
    items = "".join(f"<li>line {i}</li>" for i in range(30))
    long = f'<section class="demo"><h2>Long list</h2><ul>{items}</ul>{NOTE}</section>'
    r = run_qa(tmp_path, deck(long))
    assert r.returncode == 1
    assert "overflow" in r.stdout


def test_wide_element_fails(tmp_path):
    wide = f'<section><h2>Too wide</h2><div style="width:2200px">x</div>{NOTE}</section>'
    r = run_qa(tmp_path, deck(wide))
    assert r.returncode == 1
    assert "overflow" in r.stdout


def test_em_dash_in_notes_fails(tmp_path):
    bad = f'<section><h2>Fine title</h2><aside class="notes">Pause {EM_DASH} then go.</aside></section>'
    r = run_qa(tmp_path, deck(bad))
    assert r.returncode == 1
    assert "U+2014" in r.stdout


def test_old_version_name_fails(tmp_path):
    bad = f'<section><h2>Oracle {OLD_VERSION}</h2>{NOTE}</section>'
    r = run_qa(tmp_path, deck(bad))
    assert r.returncode == 1
    assert "26ai" in r.stdout


def test_cdn_script_fails_offline(tmp_path):
    head = '<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>'
    r = run_qa(tmp_path, deck(OK_SLIDE, head), "--offline")
    assert r.returncode == 1
    assert "network" in r.stdout


def test_js_fetch_fails_offline(tmp_path):
    # a DNS-blocked fetch leaves no Resource Timing entry; the network layer must catch it
    body = f'<section><h2>Probe</h2><script>fetch("https://qa-probe.example/x.json").catch(() => 0)</script>{NOTE}</section>'
    r = run_qa(tmp_path, deck(body), "--offline")
    assert r.returncode == 1
    assert "qa-probe.example" in r.stdout


def test_late_js_fetch_fails_offline(tmp_path):
    # issued after the page settles: never in the Resource Timing snapshot QA reads
    js = 'addEventListener("load", () => setTimeout(() => fetch("https://qa-late.example/x.json").catch(() => 0), 300))'
    body = f'<section><h2>Late probe</h2><script>{js}</script>{NOTE}</section>'
    r = run_qa(tmp_path, deck(body), "--offline")
    assert r.returncode == 1, r.stdout
    assert "qa-late.example" in r.stdout


def test_url_in_local_js_fails_offline(tmp_path):
    (tmp_path / "extra.js").write_text('window.SRC = "https://cdn.example.com/lib.js";\n', encoding="utf-8")
    html = deck(OK_SLIDE).replace('<script src="deck.js">', '<script src="extra.js"></script><script src="deck.js">')
    r = run_qa(tmp_path, html, "--offline")
    assert r.returncode == 1, r.stdout
    assert "cdn.example.com" in r.stdout


def _figure_slide(svg_attrs: str, wrap_style: str = "") -> str:
    svg = (f'<svg {svg_attrs} viewBox="0 0 1120 520" xmlns="http://www.w3.org/2000/svg">'
           '<rect x="20" y="20" width="1080" height="480" fill="none" stroke="red"/></svg>')
    return ('<section><div class="eyebrow">Seg <span class="clock">0:00</span></div>'
            '<h2>Figure slide</h2><p class="lede">One accent line.</p>'
            f'<div class="body"{wrap_style}><figure>{svg}</figure></div>'
            f'<p class="takeaway">Takeaway line.</p>{NOTE}</section>')


def test_figure_spilling_over_takeaway_fails(tmp_path):
    # the figure keeps its aspect height while its row shrinks: it spills inside the frame
    html = deck(_figure_slide('style="display:block;width:100%;height:auto"',
                              ' style="flex:1;min-height:0;display:block"'))
    r = run_qa(tmp_path, html)
    assert r.returncode == 1, r.stdout
    assert '"overlap:' in r.stdout


def test_allow_overlap_on_section_does_not_disable_check(tmp_path):
    # the opt-out is scoped to a layer inside a row: on the <section> it must change nothing
    slide = _figure_slide('style="display:block;width:100%;height:auto"',
                          ' style="flex:1;min-height:0;display:block"')
    slide = slide.replace("<section>", "<section data-qa-allow-overlap>", 1)
    r = run_qa(tmp_path, deck(slide))
    assert r.returncode == 1, r.stdout
    assert '"overlap:' in r.stdout
    assert '"allow_overlap": 0' in r.stdout


def test_allow_overlap_inside_row_is_counted(tmp_path):
    body = (f'<section><h2>Layered</h2><div class="body"><div style="position:relative;height:80px">'
            f'<div data-qa-allow-overlap style="position:absolute;top:60px;height:60px">layer</div>'
            f'</div></div>{NOTE}</section>')
    r = run_qa(tmp_path, deck(body))
    assert r.returncode == 0, r.stdout + r.stderr
    assert '"allow_overlap": 1' in r.stdout


def test_theme_keeps_tall_figure_inside_its_row(tmp_path):
    # same tall figure with the house classes: the theme fits it to the row (no collision)
    r = run_qa(tmp_path, deck(_figure_slide('class="fig"')))
    assert '"overlap:' not in r.stdout, r.stdout


def test_eyebrow_and_clock_do_not_count_as_words(tmp_path):
    words = " ".join(f"w{i}" for i in range(40))
    body = (f'<section><div class="eyebrow">Segment 5 Optimization extra words here '
            f'<span class="clock">0:54 · 26 min</span></div><h2>T</h2><p>{words}</p>{NOTE}</section>')
    r = run_qa(tmp_path, deck(body))
    assert r.returncode == 0, r.stdout + r.stderr


def test_missing_notes_fails(tmp_path):
    r = run_qa(tmp_path, deck('<section><h2>No notes</h2></section>'))
    assert r.returncode == 1
    assert "notes" in r.stdout


def test_empty_notes_fails(tmp_path):
    r = run_qa(tmp_path, deck('<section><h2>Blank notes</h2><aside class="notes">  </aside></section>'))
    assert r.returncode == 1
    assert "notes" in r.stdout


WORDY = " ".join(f"word{i}" for i in range(60))


def test_word_budget_fails_on_concept_slide(tmp_path):
    r = run_qa(tmp_path, deck(f'<section><h2>Wordy</h2><p>{WORDY}</p>{NOTE}</section>'))
    assert r.returncode == 1
    assert "words" in r.stdout


def test_word_budget_is_a_flag(tmp_path):
    r = run_qa(tmp_path, deck(f'<section><h2>Wordy</h2><p>{WORDY}</p>{NOTE}</section>'),
               "--word-budget", "80")
    assert r.returncode == 0, r.stdout + r.stderr


def test_demo_slide_is_exempt_from_word_budget(tmp_path):
    r = run_qa(tmp_path, deck(f'<section class="demo"><h2>Demo</h2><p>{WORDY}</p>{NOTE}</section>'))
    assert r.returncode == 0, r.stdout + r.stderr


def test_small_svg_scale_fails(tmp_path):
    svg = ('<svg class="fig" viewBox="0 0 1000 500" style="width:500px;height:250px" '
           'xmlns="http://www.w3.org/2000/svg"><rect x="20" y="20" width="100" height="50"/></svg>')
    r = run_qa(tmp_path, deck(f'<section><h2>Tiny figure</h2>{svg}{NOTE}</section>'))
    assert r.returncode == 1
    assert "scale" in r.stdout


def test_shots_writes_one_png_per_slide(tmp_path):
    shots = tmp_path / "shots"
    r = run_qa(tmp_path, deck(OK_SLIDE + OK_SLIDE), "--shots", str(shots))
    assert r.returncode == 0, r.stdout + r.stderr
    assert len(list(shots.glob("*.png"))) == 2


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))

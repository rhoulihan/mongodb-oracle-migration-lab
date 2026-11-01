"""build_figs.py fails the build on any deckfig violation and on a stale deck marker."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_figs  # noqa: E402
from deckfig import Fig  # noqa: E402


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    deck = tmp_path / "index.html"
    deck.write_text("<p><!-- FIG:session-map --><!-- /FIG:session-map --></p>", encoding="utf-8")
    monkeypatch.setattr(build_figs, "DECK", deck)
    monkeypatch.setattr(build_figs, "FIGS", tmp_path / "figures")
    monkeypatch.setattr(sys, "argv", ["build_figs.py", "--no-png"])
    return tmp_path


def test_clean_build_writes_svg_and_splices(sandbox):
    assert build_figs.main() == 0
    assert (sandbox / "figures" / "session-map.svg").read_text().startswith("<svg")
    assert '<svg class="fig"' in (sandbox / "index.html").read_text()


def _bad() -> Fig:
    f = Fig(200, 100, "bad")
    f.text(4, 50, "label hanging off the left edge")
    return f


def test_out_of_frame_figure_fails(sandbox, monkeypatch, capsys):
    monkeypatch.setattr(build_figs, "fig_session_map", _bad)
    assert build_figs.main() == 1
    assert "out of frame" in capsys.readouterr().out
    assert not (sandbox / "figures").exists()


def test_colliding_text_fails(sandbox, monkeypatch, capsys):
    def clash() -> Fig:
        f = Fig(300, 100, "clash")
        f.text(40, 50, "first label")
        f.text(44, 52, "second label")
        return f
    monkeypatch.setattr(build_figs, "fig_session_map", clash)
    assert build_figs.main() == 1
    assert "text collision" in capsys.readouterr().out


def test_stale_marker_fails(sandbox, capsys):
    (sandbox / "index.html").write_text("<!-- FIG:gone --><!-- /FIG:gone -->", encoding="utf-8")
    assert build_figs.main() == 1
    assert "FIG:gone" in capsys.readouterr().out

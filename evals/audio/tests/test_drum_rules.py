"""
The drum counts services/audio/README.md quotes, read by scripts/drum_rules.py from the
2026-10-29 report, and its gliding-partials measurement on signals whose answer is known. The
script's full run (every served control and clip analysed again) is made by hand; these parts
need no audio but a few generated hits.
"""

import importlib.util

import numpy as np
import pytest

from evals_audio import service
from evals_audio.service import REPO_ROOT

SCRIPT = REPO_ROOT / "evals" / "audio" / "scripts" / "drum_rules.py"
REPORT = REPO_ROOT / "evals" / "reports" / "audio-2026-10-29.json"
SR = 22050


def load_script():
    spec = importlib.util.spec_from_file_location("drum_rules", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def served():
    script = load_script()
    _, controls_run, key_run = script.newest(REPORT)
    assert controls_run["gitCommit"] == "9682a4a" and key_run["gitCommit"] == "2901b7f"
    return script, controls_run, script.served_rows(controls_run, key_run)


def test_the_served_drum_keys_are_the_reports(served):
    script, _, rows = served
    keyed = {
        est: {
            (family, span): sum(r["drum"] == (family, span) and r["keys"][est][0] for r in rows)
            for family in script.DRUMS
            for span in script.SPANS
        }
        for est in script.ESTIMATORS
    }
    assert keyed == {
        "essentia": {
            ("toms", "pinned"): 9,
            ("toms", "held out"): 8,
            ("kit-toms", "pinned"): 7,
            ("kit-toms", "held out"): 15,
            ("tabla", "pinned"): 11,
            ("tabla", "held out"): 12,
        },
        "librosa": {
            ("toms", "pinned"): 7,
            ("toms", "held out"): 4,
            ("kit-toms", "pinned"): 6,
            ("kit-toms", "held out"): 17,
            ("tabla", "pinned"): 10,
            ("tabla", "held out"): 8,
        },
    }
    clips = [r for r in rows if r["kind"] == "clip"]
    assert len(clips) == 48
    for est in script.ESTIMATORS:
        assert sum(r["keys"][est][0] for r in clips) == 48


def test_the_served_drums_fail_the_time_test_on_shared_variance(served):
    """What the README says keeps the drums' keys: their lines do not rise and fall together."""
    script, controls_run, rows = served
    failing = script.time_test(rows, controls_run["rules"]["one_source"])
    assert failing == {
        ("toms", "pinned"): {"shared": 8, "movement+shared": 2},
        ("toms", "held out"): {"shared": 7, "bins+shared": 1},
        ("kit-toms", "pinned"): {"shared": 6, "movement+shared": 1},
        ("kit-toms", "held out"): {"shared": 15, "movement+shared": 3},
        ("tabla", "pinned"): {
            "shared": 5,
            "movement+shared": 3,
            "movement": 2,
            "still, spell a chord": 2,
        },
        ("tabla", "held out"): {
            "shared": 6,
            "movement+shared": 3,
            "movement": 2,
            "still, spell a chord": 1,
        },
    }


def hits(pitch_of, seconds: float = 8.0, period: float = 0.25) -> np.ndarray:
    """A hit every `period` s: `pitch_of(t)` (Hz over the hit's own time), dying away."""
    t = np.arange(int(period * SR)) / SR
    hit = np.sin(2 * np.pi * np.cumsum(pitch_of(t)) / SR) * np.exp(-t / 0.1)
    y = np.zeros(int(seconds * SR))
    for start in range(0, y.size - hit.size, hit.size):
        y[start : start + hit.size] += hit
    return (0.5 * y / np.abs(y).max()).astype(np.float32)


def test_gliding_partials_tell_a_falling_drum_from_a_struck_note():
    script = load_script()
    _, E = service.load()
    falling = hits(lambda t: 180.0 * (1 + 0.15 * np.exp(-t / 0.05)))
    steady = hits(lambda t: np.full(t.size, 180.0))
    rising = hits(lambda t: 180.0 * (1 - 0.15 * np.exp(-t / 0.05)))
    assert script.gliding_partials(E.Signals(falling, SR)) > 0.5
    assert abs(script.gliding_partials(E.Signals(steady, SR))) < 0.05
    assert script.gliding_partials(E.Signals(rising, SR)) < -0.5


def test_reproduce_refuses_a_key_the_service_withholds_or_other_evidence(served):
    """The script measures nothing until the service, as it is, gives what the run recorded."""
    script, _, rows = served
    row = next(r for r in rows if r["name"] == "toms-s502")
    source = row["source"]
    recorded = [source["bins"], source["movement"], source["shared"], source["depth"]]
    assert script.reproduce([row], {row["name"]: {"withheld": None, "source": recorded}}) == 1
    with pytest.raises(AssertionError):
        script.reproduce([row], {row["name"]: {"withheld": "one_held_pitch", "source": recorded}})
    moved = [recorded[0], recorded[1] + 0.01, *recorded[2:]]
    with pytest.raises(AssertionError):
        script.reproduce([row], {row["name"]: {"withheld": None, "source": moved}})

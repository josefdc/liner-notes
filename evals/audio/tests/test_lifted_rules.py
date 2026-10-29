"""
The single-rule costs services/audio/README.md quotes for the GiantSteps+ keys, re-derived from
the 2026-10-29 report by scripts/lifted_rules.py: a change to that report or to the derivation
that moves them must update the README.
"""

import importlib.util
import json

from evals_audio.service import REPO_ROOT

SCRIPT = REPO_ROOT / "evals" / "audio" / "scripts" / "lifted_rules.py"


def load_script():
    spec = importlib.util.spec_from_file_location("lifted_rules", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_one_key_rule_lifted_alone_gives_few_keys_on_giantsteps():
    script = load_script()
    path = REPO_ROOT / "evals" / "reports" / "audio-2026-10-29.json"
    _, key_run, calibration_run = script.newest(path)
    assert key_run["gitCommit"] == calibration_run["gitCommit"] == "2901b7f"
    got = script.costs(key_run, calibration_run)
    lines, series = script.LINES, script.SERIES
    assert got["essentia"][lines] == {
        "clips": 132,
        "rightAllLifted": 93,
        "served": 13,
        "servedRight": 9,
        "stillWithheld": {
            "fewer than three pitch classes": 71,
            "one harmonic series": 38,
            "one pitch line without stable notes": 10,
        },
    }
    assert got["librosa"][lines] == {
        "clips": 103,
        "rightAllLifted": 54,
        "served": 12,
        "servedRight": 8,
        "stillWithheld": {
            "fewer than three pitch classes": 57,
            "one harmonic series": 27,
            "one pitch line without stable notes": 7,
        },
    }
    for name in ("essentia", "librosa"):
        assert got[name][series] == {
            "clips": 11,
            "rightAllLifted": 9,
            "served": 1,
            "servedRight": 1,
            "stillWithheld": {"fewer than three pitch classes": 10},
        }
    assert json.loads(path.read_text())["date"] == "2026-10-29"

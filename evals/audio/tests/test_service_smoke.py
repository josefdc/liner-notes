"""
The real service, in-process, on a synthesized clip (no downloads): what it returns, and that
each rule the harness lifts for calibration really is lifted. The harness reaches into the
service (an estimator's min_tempo_confidence, estimators.MIN_TEMPO_PERIODICITY and
KEY_MIN_STRENGTH, Signals.key_withheld); a refactor there that keeps the service's own
answers can still break the calibration, and these tests catch it.
"""

import importlib.util

import numpy as np
import pytest
import soundfile as sf

from evals_audio import runner, service
from evals_audio.metrics import acc1

SR = 22050
SECONDS = 12.0
BPM = 120.0


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    """A C major triad (three harmonics per note) under noise clicks at 120 BPM."""
    t = np.arange(int(SR * SECONDS)) / SR
    chord = sum(
        np.sin(2 * np.pi * f * h * t) / h for f in (261.63, 329.63, 392.0) for h in (1, 2, 3)
    )
    clicks = np.zeros_like(t)
    rng = np.random.default_rng(0)
    width = int(0.03 * SR)
    decay = np.exp(-np.arange(width) / (0.004 * SR))
    for start in np.arange(0.0, SECONDS, 60.0 / BPM):
        i = int(start * SR)
        clicks[i : i + width] += decay * rng.standard_normal(width)
    audio = 0.1 * chord / np.max(np.abs(chord)) + 0.5 * clicks
    path = tmp_path_factory.mktemp("smoke") / "clip.wav"
    sf.write(path, audio.astype("float32"), SR)
    service.load()  # imported before the clip is read, so its import messages are not kept
    return str(path)


# Checked without importing the service: collection must not import numba (see conftest).
ESTIMATORS = [
    "librosa",
    pytest.param(
        "essentia",
        marks=pytest.mark.skipif(
            importlib.util.find_spec("essentia") is None,
            reason="essentia-tensorflow is not installed (the models extra)",
        ),
    ),
]


def analyse(clip, name):
    record = runner.analyze_track(("synthetic", "clip", clip, 1, (name,)))
    assert "error" not in record
    result = record["results"][name]
    assert "error" not in result and result["gate"]["passed"]
    return result


@pytest.mark.parametrize("name", ESTIMATORS)
def test_the_service_answers_the_clip(clip, name):
    result = analyse(clip, name)
    assert acc1(result["tempo"]["bpm"], BPM)
    assert (result["key"]["tonic"], result["key"]["mode"]) == ("C", "major")
    assert "tempoWithheld" not in result and "keyWithheld" not in result


@pytest.mark.parametrize("name", ESTIMATORS)
def test_the_confidence_minimum_is_lifted(clip, name, monkeypatch):
    est_class = type(runner._estimators((name,))[name])
    monkeypatch.setattr(est_class, "min_tempo_confidence", 0.99)
    result = analyse(clip, name)
    assert result["tempo"] is None
    withheld = result["tempoWithheld"]
    assert withheld["rules"] == [runner.TEMPO_LOW_CONFIDENCE]
    assert acc1(withheld["bpm"], BPM)
    assert est_class.min_tempo_confidence == 0.99  # restored after the lifted call


@pytest.mark.parametrize("name", ESTIMATORS)
def test_the_periodicity_minimum_is_lifted(clip, name, monkeypatch):
    _, estimators = service.load()
    monkeypatch.setattr(estimators, "MIN_TEMPO_PERIODICITY", 0.99)
    result = analyse(clip, name)
    assert result["tempo"] is None
    withheld = result["tempoWithheld"]
    assert withheld["rules"][0] == runner.TEMPO_LOW_PERIODICITY
    assert acc1(withheld["bpm"], BPM)
    assert estimators.MIN_TEMPO_PERIODICITY == 0.99


@pytest.mark.parametrize("name", ESTIMATORS)
def test_the_key_strength_minimum_is_lifted(clip, name, monkeypatch):
    _, estimators = service.load()
    monkeypatch.setattr(estimators, "KEY_MIN_STRENGTH", 0.99)
    result = analyse(clip, name)
    assert result["key"] is None
    assert result["keyWithheld"] == runner.KEY_WEAK
    assert result["keyRules"] == [runner.KEY_WEAK]
    unreturned = result["keyUnreturned"]
    assert (unreturned["tonic"], unreturned["mode"]) == ("C", "major")
    assert estimators.KEY_MIN_STRENGTH == 0.99


@pytest.mark.parametrize("name", ESTIMATORS)
def test_the_key_evidence_rule_is_lifted(clip, name, monkeypatch):
    _, estimators = service.load()
    monkeypatch.setattr(estimators.Signals, "key_withheld", lambda self: "a rule for the test")
    result = analyse(clip, name)
    assert result["key"] is None
    assert result["keyRules"] == ["a rule for the test"]
    unreturned = result["keyUnreturned"]
    assert (unreturned["tonic"], unreturned["mode"]) == ("C", "major")

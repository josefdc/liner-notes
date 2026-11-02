"""
The service answers with the AudioFeatures v2 block only. The v1 fields it sent next to the block
until analyzer 2.3.0 (bpm, key, mode, energy, the perceptual scores, ...) and the code that
derived them are gone, and a value the block leaves null says which check withheld it
(`v2.withheld`), so no reader has to guess from a flat null.
"""

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import estimators
import main
from tests import signals
from tests.checks import check_result

V1_FIELDS = (
    "bpm",
    "key",
    "mode",
    "energy",
    "duration",
    "source",
    "analyzer_version",
    "keyMoments",
    "valence",
    "danceability",
    "acousticness",
    "instrumentalness",
)
ESTIMATORS = [
    "librosa",
    pytest.param(
        "essentia",
        marks=pytest.mark.skipif(not estimators.ESSENTIA_AVAILABLE, reason="no essentia"),
    ),
]


def analyse_over_http(monkeypatch, tmp_path, y: np.ndarray) -> dict:
    """POST /analyze for a preview holding `y` (22.05 kHz WAV); the JSON body."""
    path = tmp_path / "preview.wav"
    sf.write(path, y, signals.SR)

    async def fake_download(url):
        return str(path)

    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(main, "download_preview", fake_download)
    with TestClient(main.app) as client:
        response = client.post(
            "/analyze", json={"preview_url": "https://cdnt-preview.dzcdn.net/a.mp3"}
        )
    assert response.status_code == 200, response.text
    return response.json()


def test_the_response_model_is_the_v2_block_only():
    assert set(main.AudioAnalysisResult.model_fields) == {"v2"}
    for name in ("v1_fields", "v1_energy", "V1_ENERGY_OFFSET", "V1_ENERGY_SPAN", "KeyMoment"):
        assert not hasattr(main, name), name


@pytest.mark.parametrize(
    "make",
    [lambda: signals.drum_pattern(97), lambda: np.zeros(10 * signals.SR, dtype=np.float32)],
    ids=["measured", "silence"],
)
def test_analyze_answers_with_the_v2_block_only(monkeypatch, tmp_path, make):
    body = analyse_over_http(monkeypatch, tmp_path, make())
    assert list(body) == ["v2"]
    assert not set(V1_FIELDS) & set(body)
    check_result(body)


def test_a_gated_preview_says_the_gate_withheld_every_value(monkeypatch, tmp_path):
    body = analyse_over_http(monkeypatch, tmp_path, np.zeros(10 * signals.SR, dtype=np.float32))
    v2 = body["v2"]
    assert v2["gate"] == {"passed": False, "reason": "silence"}
    assert v2["withheld"]["tempo"] == {"code": "gate_silence", "reason": "the preview is silent"}
    assert v2["withheld"]["key"] == v2["withheld"]["tempo"]


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_a_withheld_key_says_which_check_withheld_it(estimator):
    """
    A cowbell (seed 500): its partials hold still and rise and fall together, so the key is
    withheld as one pitched source, and the block says so for the key alone. Its tempo is
    measured.
    """
    signals_ = estimators.Signals(signals.seeded_cowbell(500), signals.SR)
    result = main.analyze_signals(signals_, estimators.select_estimator(estimator))
    v2 = check_result(result)
    assert v2["key"] is None
    assert v2["withheld"]["key"] == {"code": "one_pitched_source", "reason": estimators.ONE_SOURCE}
    assert v2["tempo"] is not None and "tempo" not in v2["withheld"]


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_a_withheld_tempo_says_which_check_withheld_it(estimator):
    """90 BPM, then 130: no single tempo over the window; the key is measured."""
    probe = signals.tempo_change(90, 130)
    result = main.analyze_signals(
        estimators.Signals(probe, signals.SR), estimators.select_estimator(estimator)
    )
    v2 = check_result(result)
    assert v2["tempo"] is None
    assert v2["withheld"]["tempo"] == main.UNSTEADY_TEMPO.entry()
    assert v2["key"] is not None and "key" not in v2["withheld"]


def test_without_a_beat_the_tempo_reason_is_that_there_is_no_beat():
    """A held chord pad: nothing repeats, so there is no beat to count (and no beat grid)."""
    pad = signals.chord_pad_progression()
    v2 = check_result(main.analyze_signals(estimators.Signals(pad, signals.SR)))
    assert v2["tempo"] is None and v2["beats"] is None
    assert v2["withheld"]["tempo"] == v2["withheld"]["beats"] == estimators.NO_BEAT.entry()

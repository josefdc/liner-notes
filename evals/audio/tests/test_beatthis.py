"""
beat-this behind the service's estimator interface: the service's rules on its beats, and the
checkpoint fetch. The tracker itself is replaced by fixed beats (no torch, no checkpoint).
"""

import hashlib

import httpx
import numpy as np
import pytest
import soundfile as sf

from evals_audio import beatthis, runner, service
from evals_audio.metrics import acc1
from evals_audio.storage import DataCapExceeded, DiskBudget

SR = 22050
SECONDS = 12.0
BPM = 120.0


@pytest.fixture(scope="module")
def signals(tmp_path_factory):
    """Noise clicks at 120 BPM over a quiet triad, decoded by the service."""
    t = np.arange(int(SR * SECONDS)) / SR
    chord = sum(np.sin(2 * np.pi * f * t) for f in (261.63, 329.63, 392.0))
    clicks = np.zeros_like(t)
    rng = np.random.default_rng(0)
    width = int(0.03 * SR)
    decay = np.exp(-np.arange(width) / (0.004 * SR))
    for start in np.arange(0.0, SECONDS, 60.0 / BPM):
        i = int(start * SR)
        clicks[i : i + width] += decay * rng.standard_normal(width)
    audio = 0.1 * chord / np.max(np.abs(chord)) + 0.5 * clicks
    path = tmp_path_factory.mktemp("beatthis") / "clip.wav"
    sf.write(path, audio.astype("float32"), SR)
    service.load()
    return service.decode_file(str(path))


class FixedBeats(beatthis.BeatThisEstimator):
    """The estimator with its tracker replaced by fixed beat times."""

    def __init__(self, beats):
        self._beats = np.asarray(beats, dtype=float)

    def beats(self, signals):
        return self._beats


def grid(bpm, seconds=SECONDS):
    return np.arange(0.0, seconds - 0.01, 60.0 / bpm)


def test_the_tempo_comes_from_the_beats_through_the_service_rules(signals):
    tempo = FixedBeats(grid(BPM)).tempo(signals)
    assert tempo is not None and acc1(tempo.bpm, BPM)
    assert tempo.confidence is None and tempo.steady and tempo.beats_follow_changes
    assert tempo.method.startswith("beat-this final0")


def test_too_few_beats_or_a_tempo_out_of_range_gives_none(signals):
    assert FixedBeats([0.0, 0.5, 1.0]).tempo(signals) is None
    assert FixedBeats(grid(240.0)).tempo(signals) is None  # above 208 BPM
    assert FixedBeats(grid(30.0)).tempo(signals) is None  # below 40 BPM


def test_the_periodicity_minimum_is_read_when_called(signals, monkeypatch):
    _, estimators = service.load()
    monkeypatch.setattr(estimators, "MIN_TEMPO_PERIODICITY", 1.01)
    est = FixedBeats(grid(BPM))
    assert est.tempo(signals) is None
    # The calibration lifts it and recovers the estimate, as for the service's estimators.
    lifted, steady = service.tempo_without_minimums(signals, est)
    assert lifted is not None and acc1(lifted.bpm, BPM)
    detail = runner.tempo_withheld(signals, est)
    assert detail["rules"][0] == runner.TEMPO_LOW_PERIODICITY and acc1(detail["bpm"], BPM)


def test_it_has_no_key(signals):
    assert FixedBeats(grid(BPM)).key(signals) is None


def test_the_estimator_needs_its_checkpoint(monkeypatch, tmp_path):
    monkeypatch.setattr(beatthis, "available", lambda: True)
    monkeypatch.delenv(beatthis.CHECKPOINT_ENV, raising=False)
    with pytest.raises(service.EstimatorUnavailable, match="checkpoint"):
        beatthis.estimator()
    monkeypatch.setenv(beatthis.CHECKPOINT_ENV, str(tmp_path / "missing.ckpt"))
    with pytest.raises(service.EstimatorUnavailable, match="checkpoint"):
        beatthis.estimator()


def test_the_key_suite_does_not_run_beat_this():
    assert "beat-this" not in service.SUITE_ESTIMATORS["key"]
    assert "beat-this" in service.SUITE_ESTIMATORS["tempo"]


def client_for(payload: bytes):
    return httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, content=payload))
    )


def test_a_checkpoint_that_does_not_match_its_hash_is_not_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(beatthis, "CHECKPOINT_BYTES", 10)
    with pytest.raises(beatthis.Unavailable, match="SHA-256"):
        beatthis.ensure_checkpoint(tmp_path, DiskBudget(tmp_path, 10**9), client_for(b"0123456789"))
    assert not list((tmp_path / "models" / "beat-this").iterdir())


def test_a_checkpoint_is_kept_once_verified_and_not_fetched_again(tmp_path, monkeypatch):
    payload = b"checkpoint bytes"
    monkeypatch.setattr(beatthis, "CHECKPOINT_BYTES", len(payload))
    monkeypatch.setattr(beatthis, "CHECKPOINT_SHA256", hashlib.sha256(payload).hexdigest())
    budget = DiskBudget(tmp_path, 10**9)
    path = beatthis.ensure_checkpoint(tmp_path, budget, client_for(payload))
    assert path.read_bytes() == payload

    def refuse(request):
        raise AssertionError("a verified checkpoint is not fetched again")

    no_network = httpx.Client(transport=httpx.MockTransport(refuse))
    assert beatthis.ensure_checkpoint(tmp_path, budget, no_network) == path


def test_the_checkpoint_asks_the_budget_first(tmp_path):
    with pytest.raises(DataCapExceeded):
        beatthis.ensure_checkpoint(tmp_path, DiskBudget(tmp_path, 1000), client_for(b"x"))

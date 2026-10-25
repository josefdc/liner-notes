"""
AudioFeatures v2 (the `v2` block of /analyze) on generated audio, through the real analysis.

Every result is checked by tests/checks.py: the v2 block validates against the contract's
JSON Schema after a strict JSON round trip, and the v1 fields agree with it.

Tempo and key tests run with both estimators; the Essentia cases are skipped (and reported as
skipped) without the "models" extra. Tests marked `needs_models` run the real Essentia models
and are skipped without them; the fingerprint logic is also covered with stand-in models.
"""

import os
import re
import threading
from types import SimpleNamespace

import librosa
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import estimators
import fingerprint
import main
import signal_features
from model_labels import DISCOGS_STYLES, MSD_TAGS
from tests import music, signals
from tests.checks import MEASURED_BLOCKS, VALIDATOR, check_result, check_v2
from tests.test_fixtures import (
    A_MINOR_PROGRESSION,
    C_MAJOR_PROGRESSION,
    FIXTURE_SR,
    FORMATS,
    PREVIEW_SR,
    a_major_triad,
    click_track,
    progression,
    split_click_track_stereo,
    split_triad_stereo,
    tones,
    white_noise,
)

needs_essentia = pytest.mark.skipif(
    not estimators.ESSENTIA_AVAILABLE, reason="essentia not installed (uv sync --extra models)"
)
needs_models = pytest.mark.skipif(not main.MODELS_LOADED, reason="Essentia models not loaded")
ESTIMATORS = ["librosa", pytest.param("essentia", marks=needs_essentia)]
PROBES = signals.probes()


@pytest.fixture(scope="module")
def analyse(tmp_path_factory):
    """
    Writes a signal, analyses it with the given estimator (the service default when None),
    checks the result (tests/checks.py) and returns (result, round-tripped v2 block).
    """
    directory = tmp_path_factory.mktemp("v2")
    count = 0

    def run(y: np.ndarray, fmt: str, sr: int = FIXTURE_SR, estimator: str | None = None):
        nonlocal count
        count += 1
        path = directory / f"fixture-{count}.{fmt.lower()}"
        sf.write(path, y, sr, format=fmt)
        if estimator is None:
            result = main.analyze_audio_file(str(path))
        else:
            chosen = estimators.select_estimator(estimator)
            assert chosen.name == estimator
            result = main.analyze_signals(main.decode(str(path)), chosen)
        return result, check_result(result)

    return run


def analyse_array(y: np.ndarray, estimator: str | None = None, sr: int = FIXTURE_SR):
    """The analysis of an in-memory signal (no file), checked."""
    chosen = estimators.select_estimator(estimator) if estimator else None
    result = main.analyze_signals(estimators.Signals(y, sr), chosen)
    return result, check_result(result)


# --- the schema, the response, versions --------------------------------------------------


def test_the_schema_enforces_the_gate():
    """The committed schema rejects a gated result that still measures something."""
    gated = {
        "version": 2,
        "analyzerVersion": main.analyzer_version(),
        "window": {"kind": "preview-30s", "durationSeconds": 10.0},
        "gate": {"passed": False, "reason": "silence"},
        **dict.fromkeys(MEASURED_BLOCKS),
        "keyMoments": [],
    }
    check_v2(gated)
    key = {"tonic": "C", "mode": "major", "strength": 0.5, "profile": "x", "method": "x"}
    assert not VALIDATOR.is_valid({**gated, "key": {**key, "basis": "signal"}})
    assert not VALIDATOR.is_valid({**gated, "gate": {"passed": False, "reason": None}})
    assert not VALIDATOR.is_valid({**gated, "gate": {"passed": True, "reason": "silence"}})
    with pytest.raises(ValueError):
        check_v2({**gated, "window": {"kind": "preview-30s", "durationSeconds": float("nan")}})


def test_analyze_endpoint_returns_a_valid_v2_block(monkeypatch, tmp_path):
    path = tmp_path / "preview.mp3"
    sf.write(path, signals.drum_pattern(97), FIXTURE_SR, format="MP3")

    async def fake_download(url):
        return str(path)

    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(main, "download_preview", fake_download)
    with TestClient(main.app) as client:
        response = client.post("/analyze", json={"preview_url": "https://p.scdn.co/a.mp3"})
        health = client.get("/health").json()
    assert response.status_code == 200, response.text
    body = response.json()
    v2 = check_result(body)
    assert v2["gate"] == {"passed": True, "reason": None}
    assert body["analyzer_version"] == v2["analyzerVersion"] == health["analyzer_version"]
    assert not path.exists()


SEMVER = re.compile(
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


def test_analyzer_version_is_short_semver_naming_estimator_and_models(monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", False)
    assert main.analyzer_version("librosa") == "2.2.0+librosa"
    assert main.analyzer_version("essentia") == "2.2.0+essentia"
    monkeypatch.setattr(main, "MODELS_LOADED", True)
    with_models = main.analyzer_version("essentia")
    assert with_models == f"2.2.0+essentia.models-{fingerprint.model_set_tag()}"
    assert SEMVER.fullmatch(with_models) and len(with_models) <= 40
    assert re.fullmatch(r"[0-9a-f]{8}", fingerprint.model_set_tag())
    # The tag changes with any pinned model checksum.
    first = fingerprint.MODELS[0]
    changed = (first.__class__(first.name, first.filename, first.url, "0" * 64, ""),)
    monkeypatch.setattr(fingerprint, "MODELS", changed + fingerprint.MODELS[1:])
    assert fingerprint.model_set_tag() != with_models.rsplit("-", 1)[1]


def test_results_carry_the_estimator_that_measured_them():
    result, _ = analyse_array(a_major_triad(), "librosa")
    assert result["v2"]["analyzerVersion"].startswith("2.2.0+librosa")


def test_one_decode_and_one_chromagram_per_analysis(monkeypatch, tmp_path):
    """
    The preview is decoded once; the STFT, onset envelope and chromagram computed once (and the
    pitch track's 36-bin chromagram once: with a beat the key is checked against one voice).
    """
    import librosa

    calls = {"read": 0, "chroma_cqt": 0, "chroma_cqt_36": 0, "stft": 0, "onset_strength": 0}
    calls["hpss"] = 0

    def counting(module, name):
        original = getattr(module, name)

        def wrapper(*args, **kwargs):
            calls[name if kwargs.get("n_chroma", 12) == 12 else f"{name}_36"] += 1
            return original(*args, **kwargs)

        monkeypatch.setattr(module, name, wrapper)

    counting(sf.SoundFile, "read")
    counting(librosa.feature, "chroma_cqt")
    counting(librosa, "stft")
    counting(librosa.onset, "onset_strength")
    counting(librosa.decompose, "hpss")
    path = tmp_path / "band.wav"
    sf.write(path, signals.drum_pattern(97), FIXTURE_SR)
    v2 = check_result(main.analyze_audio_file(str(path)))
    assert v2["gate"]["passed"] and v2["key"] is not None
    assert calls == {
        "read": 1,
        "chroma_cqt": 1,
        "chroma_cqt_36": 1,
        "stft": 2,  # the analysis and the pitch track's harmonicity spectrum
        "onset_strength": 1,
        "hpss": 1,
    }


def test_non_finite_samples_are_refused_with_422(monkeypatch, tmp_path):
    y = np.sin(np.arange(FIXTURE_SR * 5) / 10).astype(np.float32)
    y[1000] = np.nan
    path = tmp_path / "nan.wav"
    sf.write(path, y, FIXTURE_SR, subtype="FLOAT")
    with pytest.raises(main.InvalidAudioError):
        main.decode(str(path))

    async def fake_download(url):
        return str(path)

    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(main, "download_preview", fake_download)
    with TestClient(main.app) as client:
        response = client.post("/analyze", json={"preview_url": "https://p.scdn.co/a.mp3"})
    assert response.status_code == 422
    assert "non-finite" in response.json()["detail"]


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        (b"", "the file could not be decoded as audio"),
        (b"ID3" + b"\x00" * 4093, "the file could not be decoded as audio"),
        ("huge", "the decoded audio holds samples far beyond full scale"),
    ],
    ids=["zero-bytes", "corrupt-mp3", "samples-1e30"],
)
def test_undecodable_or_absurd_audio_is_a_422(tmp_path, body, reason):
    path = tmp_path / "preview.wav"
    if body == "huge":
        sf.write(path, np.full(FIXTURE_SR * 5, 1e30, np.float32), FIXTURE_SR, subtype="FLOAT")
    else:
        path.write_bytes(body)
    with pytest.raises(main.InvalidAudioError, match=reason):
        main.decode(str(path))


def test_float_overs_are_still_audio(analyse):
    """Float samples a few times full scale (clipped masters, overs) are analysed."""
    _, v2 = analyse(10 * signals.drum_pattern(97), "WAV")
    assert v2["tempo"]["bpm"] == pytest.approx(97, abs=1)


def test_antiphase_stereo_is_analysed_on_one_channel(analyse):
    """Left and right in antiphase cancel in the mono downmix; one channel is analysed."""
    band = signals.drum_pattern(97)
    _, v2 = analyse(np.stack([band, -band], axis=1), "WAV")
    assert v2["gate"]["passed"]
    assert v2["tempo"]["bpm"] == pytest.approx(97, abs=1)


# --- tempo -------------------------------------------------------------------------------


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize("bpm", [85, 120, 140, 174])
def test_tempo_of_click_tracks_is_within_one_bpm(analyse, bpm, fmt, estimator):
    result, v2 = analyse(click_track(bpm), fmt, estimator=estimator)
    tempo = v2["tempo"]
    assert tempo is not None
    assert tempo["bpm"] == pytest.approx(bpm, abs=1.0)
    assert tempo["confidence"] is not None and 0.5 <= tempo["confidence"] <= 1.0
    assert tempo["method"].startswith(estimator)
    if estimator == "essentia":
        raw = tempo["rawConfidence"]
        assert raw["range"] == [0.0, 5.32]
        assert tempo["confidence"] == pytest.approx(min(raw["value"] / 5.32, 1.0), abs=1e-3)
    assert result["bpm"] == bpm


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_tempo_of_a_44k_stereo_mp3(analyse, estimator):
    _, v2 = analyse(split_click_track_stereo(), "MP3", sr=PREVIEW_SR, estimator=estimator)
    assert v2["tempo"]["bpm"] == pytest.approx(120, abs=1.0)


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("bpm", [97, 128])
def test_tempo_of_a_drum_pattern(analyse, bpm, estimator):
    """Kick, snare, hats and chords: the beat, not the bar or the eighth notes."""
    _, v2 = analyse(signals.drum_pattern(bpm), "MP3", estimator=estimator)
    assert v2["tempo"]["bpm"] == pytest.approx(bpm, abs=1.0)
    assert v2["tempo"]["confidence"] >= 0.5


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("probe", ["drums-crash-jitter-15ms", "drums-crash-jitter-25ms"])
def test_tempo_of_a_human_drum_take(probe, estimator):
    """Drums with 15-25 ms timing jitter and a crash every bar: a beat, not noise."""
    _, v2 = analyse_array(PROBES[probe], estimator)
    assert v2["gate"]["passed"]
    assert v2["tempo"]["bpm"] == pytest.approx(100, abs=1.0)
    assert v2["key"] is None


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_tempo_and_key_of_a_band_with_jitter(estimator):
    """Drums and chords with 10 ms jitter (its onset periodicity read 0.398 and lost its tempo)."""
    _, v2 = analyse_array(PROBES["band-jitter-10ms"], estimator)
    assert v2["tempo"]["bpm"] == pytest.approx(100, abs=1.0)
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == ("C", "major")


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_no_tempo_when_the_tempo_changes(estimator):
    """
    90 BPM, then 130: no single tempo (Essentia read 90.09 at 0.55 before). Essentia's beats
    follow the change and are kept, on the true beats in both halves; librosa's tracker keeps
    one period (half its beats were off in the 130 BPM half), so it gives none.
    """
    result, v2 = analyse_array(PROBES["tempo-change-90-130"], estimator)
    assert v2["tempo"] is None and result["bpm"] is None
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == ("C", "major")
    if estimator == "librosa":
        assert v2["beats"] is None
        return
    truth = np.array(signals.grid(90, 15.0) + [15 + b for b in signals.grid(130, 15.0)])
    beats = np.array(v2["beats"]["times"])
    for lo, hi in ((1.0, 14.0), (16.0, 29.0)):
        true, found = truth[(truth >= lo) & (truth < hi)], beats[(beats >= lo) & (beats < hi)]
        recall = np.mean([np.min(np.abs(found - t)) <= 0.07 for t in true])
        precision = np.mean([np.min(np.abs(true - b)) <= 0.07 for b in found])
        assert recall >= 0.9 and precision >= 0.9, (lo, recall, precision)


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_no_tempo_for_an_accelerando(estimator):
    _, v2 = analyse_array(PROBES["accelerando-80-140"], estimator)
    assert v2["tempo"] is None
    if estimator == "librosa":
        assert v2["beats"] is None


LATE_STARTS = [
    ("band-97-after-10s-silence", 97),
    ("band-97-after-10s-pad", 97),
    ("band-132-after-12s-pad", 132),
    ("band-85-after-10s-pad", 85),
]


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize(("probe", "bpm"), LATE_STARTS, ids=[p for p, _ in LATE_STARTS])
def test_a_tempo_that_starts_late_is_reported(probe, bpm, estimator, request):
    """
    A band entering 10-12 s in, after silence or a pad: the beatless intro is no evidence
    about steadiness, and the beats tracked through it are left out of the tempo fit. (These
    gave no tempo, or 95.44 and 129.05 BPM with Essentia.)
    """
    if estimator == "librosa" and bpm == 85:
        request.applymarker(
            pytest.mark.xfail(
                strict=True, reason="librosa reports the double (170 BPM): an octave error"
            )
        )
    result, v2 = analyse_array(PROBES[probe], estimator)
    assert v2["tempo"]["bpm"] == pytest.approx(bpm, abs=1.0)
    assert result["bpm"] == bpm


def test_no_steady_tempo_without_a_beat_anywhere():
    """No third of the window has repeating onsets: nothing says the tempo holds."""
    flat = SimpleNamespace(
        onset_envelope=np.zeros(1300),
        smoothed_onset_envelope=np.zeros(1300),
        sr=FIXTURE_SR,
        hop=512,
    )
    assert not estimators.steady_tempo(np.arange(60) * 0.5, 120.0, flat)


# A band whose tempo swings around 100 BPM every 12 s (both estimators read about 107.7 at
# +-10 %). The thirds' medians smooth the swing: librosa withholds the +-12 % swing, Essentia
# reports a tempo for both, and librosa for the +-10 % one (strict expected failures, so a
# change is seen).
@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("swing", [0.1, 0.12])
def test_no_tempo_for_a_slow_tempo_swing(swing, estimator, request):
    if swing == 0.1 or estimator == "essentia":
        request.applymarker(
            pytest.mark.xfail(strict=True, reason="its thirds stay within 5 % of the tempo")
        )
    _, v2 = analyse_array(signals.tempo_swing(swing=swing), estimator)
    assert v2["tempo"] is None


def test_steady_tempo_follows_the_beat_grid():
    steady = np.arange(60) * 0.5
    assert estimators.steady_tempo(steady, 120.0)
    assert not estimators.steady_tempo(steady, 126.5)  # 5.4% off
    assert estimators.steady_tempo(steady, 125.9)  # 4.9% off
    change = np.concatenate([np.arange(23) * 60 / 90, 15 + np.arange(33) * 60 / 130])
    assert not estimators.steady_tempo(change, 90.0)
    assert not estimators.steady_tempo(change, 130.0)
    assert not estimators.steady_tempo(steady[:6], 120.0)  # too few beats to tell


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize(
    "make",
    [
        lambda: a_major_triad(),
        lambda: tones((440.0,)),
        lambda: progression(C_MAJOR_PROGRESSION),
        lambda: progression(A_MINOR_PROGRESSION),
        lambda: signals.piano_line(),
    ],
    ids=["triad", "440Hz", "C-F-G-C", "Am-Dm-E-Am", "rubato-piano"],
)
def test_no_tempo_without_a_beat(analyse, make, estimator):
    """
    Measured, but no tempo: nothing repeats at a beat rate. (Without the periodicity check
    Essentia reports 93 BPM for the triad and 90 for the progressions, beat_track 30 BPM for
    the progressions' chord changes.)
    """
    _, v2 = analyse(make(), "WAV", estimator=estimator)
    assert v2["gate"]["passed"]
    assert v2["tempo"] is None and v2["beats"] is None
    assert v2["loudness"] is not None


@needs_essentia
def test_essentia_tempo_is_withheld_at_low_confidence(analyse):
    """Essentia scores a 6 s click track 0 of 5.32 (it ignores the first 5 s): no tempo."""
    _, v2 = analyse(click_track(120, seconds=6.0), "WAV", estimator="essentia")
    assert v2["gate"]["passed"]
    assert v2["tempo"] is None


def test_refined_tempo_never_changes_octave():
    beats = np.arange(40) * 0.5  # exactly 120 BPM
    assert estimators.refine_bpm(beats, 117.45) == pytest.approx(120.0, abs=1e-6)
    assert estimators.refine_bpm(beats, 60.0) == 60.0  # every other beat: left alone
    assert estimators.refine_bpm(beats, 100.0) == 100.0  # beats at 120: 20% away, left alone
    assert estimators.refine_bpm(beats, 114.0) == 114.0  # 5.3% away, left alone
    skipped = np.delete(beats, [5, 17])
    assert estimators.refine_bpm(skipped, 118.0) == pytest.approx(120.0, abs=1e-6)


def test_refined_tempo_fits_the_longest_regular_run():
    """
    Beats drifting through an intro (82-97 BPM, off a 120 BPM grid by up to 0.4 period) are
    left out: the fit is on the regular run after them. With no run of MIN_BEATS beats the
    estimate is kept.
    """
    intro = np.cumsum(60 / np.array([82.0, 90.0, 97.0, 85.0, 92.0, 88.0]))
    run = intro[-1] + 0.7 + np.arange(30) * 0.5
    assert estimators.refine_bpm(np.concatenate([intro, run]), 118.0) == pytest.approx(120.0)
    irregular = np.cumsum(np.tile([0.5, 0.7], 20))  # every other interval 1.4 periods
    assert estimators.refine_bpm(irregular, 118.0) == 118.0
    assert estimators.refine_bpm(run[:3], 118.0) == 118.0  # fewer than MIN_BEATS


def test_beats_off_the_onsets_are_left_out_of_the_fit():
    """Ticks counted through a beatless intro carry no onset and are dropped (onset_beats)."""
    y = signals.late_start(signals.drum_pattern(97), 10.0, "pad")
    s_ = estimators.Signals(y, FIXTURE_SR)
    ticks = np.concatenate([np.arange(0.3, 10.0, 0.66), 10.0 + np.arange(32) * 60 / 97])
    kept = estimators.onset_beats(ticks, s_)
    assert kept.min() >= 9.9 and kept.size >= 25


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_tempo_beat_grid_follows_the_clicks(analyse, estimator):
    """Beats in preview time, on the clicks (from t = 0.3 s); trackers may need a beat or two."""
    _, v2 = analyse(click_track(120, offset=0.3), "WAV", estimator=estimator)
    times = np.array(v2["beats"]["times"])
    assert len(times) >= 50
    assert np.median(np.diff(times)) == pytest.approx(0.5, abs=0.01)
    off = np.abs((times - 0.3) / 0.5 - np.round((times - 0.3) / 0.5)) * 0.5
    assert np.mean(off <= 0.03) >= 0.9, times


class FakeEstimator:
    """An estimator returning fixed estimates (or raising), for the analysis around it."""

    name = "fake"

    def __init__(self, tempo=None, key=None):
        self._tempo, self._key = tempo, key

    def tempo(self, signals):
        if isinstance(self._tempo, Exception):
            raise self._tempo
        return self._tempo

    def key(self, signals):
        if isinstance(self._key, Exception):
            raise self._key
        return self._key


A_MAJOR = estimators.KeyEstimate("A", "major", 0.8, "x", "fake")


def test_an_estimator_failure_only_loses_its_own_measurement():
    tempo_fails = FakeEstimator(tempo=RuntimeError("boom"), key=A_MAJOR)
    result = main.analyze_signals(estimators.Signals(a_major_triad(), FIXTURE_SR), tempo_fails)
    v2 = check_result(result)
    assert v2["tempo"] is None and (v2["key"]["tonic"], result["key"]) == ("A", "A")
    key_fails = FakeEstimator(tempo=None, key=RuntimeError("boom"))
    v2 = check_result(main.analyze_signals(estimators.Signals(a_major_triad(), 22050), key_fails))
    assert v2["key"] is None and v2["loudness"] is not None


def test_beats_are_clipped_to_the_window():
    beats = np.array([-0.2, 0.5, 1.0, 9.0, 10.4])
    estimate = estimators.TempoEstimate(120.0, 0.9, None, beats, "fake", steady=True)
    result = main.analyze_signals(
        estimators.Signals(a_major_triad(), FIXTURE_SR), FakeEstimator(tempo=estimate)
    )
    v2 = check_result(result)
    assert v2["beats"]["times"] == [0.0, 0.5, 1.0, 9.0, 10.0]


@pytest.mark.parametrize(
    ("steady", "follows", "method"),
    [
        (True, False, "novelty-on-beat-chroma"),
        (False, True, "novelty-on-beat-chroma"),
        (False, False, "novelty-on-chroma-0.5s"),
    ],
)
def test_sections_only_use_a_trusted_beat_grid(steady, follows, method, monkeypatch):
    """
    An unsteady tempo from a tracker that keeps one period (librosa's) gives a grid that drifts
    off the music: sections and harmonic changes then use the fixed 0.5 s grid, and no beats are
    published.
    """
    seen = []
    harmony = signal_features.harmony
    monkeypatch.setattr(
        signal_features, "harmony", lambda s, beats: seen.append(beats) or harmony(s, beats)
    )
    beats = np.arange(0.0, 30.0, 0.5)
    estimate = estimators.TempoEstimate(
        120.0, 0.9, None, beats, "fake", steady=steady, beats_follow_changes=follows
    )
    c, f_sharp = (48, 60, 64, 67), (54, 66, 70, 73)
    y = signals.chord_blocks([c, f_sharp, c])
    v2 = check_result(
        main.analyze_signals(estimators.Signals(y, FIXTURE_SR), FakeEstimator(tempo=estimate))
    )
    assert v2["sections"]["method"] == method
    trusted = steady or follows
    assert (seen[0] is not None) == trusted and (v2["beats"] is not None) == trusted


# --- Essentia estimator wiring, with stand-in algorithms (runs without Essentia) ----------


class FakeAlgorithm:
    def __init__(self, output):
        self.output = output
        self.resets = 0

    def reset(self):
        self.resets += 1

    def __call__(self, audio):
        return self.output


def with_essentia_algorithms(monkeypatch, rhythm=None, key=None):
    algorithms = {"rhythm": rhythm, "key-bgate": key}
    monkeypatch.setattr(estimators, "_essentia_algorithm", lambda name, f: algorithms[name])


def steady_signals():
    return estimators.Signals(click_track(120), FIXTURE_SR)


@pytest.mark.parametrize(
    ("raw", "confidence"), [(1.49, None), (1.51, 0.284), (2.66, 0.5), (5.32, 1.0), (6.1, 1.0)]
)
def test_essentia_confidence_is_raw_over_5_32_clipped(monkeypatch, raw, confidence):
    ticks = np.arange(60) * 0.5
    with_essentia_algorithms(monkeypatch, rhythm=FakeAlgorithm((120.0, ticks, raw, [], [])))
    estimate = estimators.EssentiaEstimator().tempo(steady_signals())
    if confidence is None:
        assert estimate is None  # below the "good" band (1.5)
    else:
        assert estimate.confidence == pytest.approx(confidence, abs=1e-3)
        assert estimate.raw_confidence == (raw, (0.0, 5.32))


@pytest.mark.parametrize(("ticks", "expected"), [(3, False), (4, True)])
def test_a_tempo_needs_four_beats(monkeypatch, ticks, expected):
    rhythm = FakeAlgorithm((120.0, np.arange(ticks) * 0.5, 4.0, [], []))
    with_essentia_algorithms(monkeypatch, rhythm=rhythm)
    assert (estimators.EssentiaEstimator().tempo(steady_signals()) is not None) == expected


@pytest.mark.parametrize(
    ("name", "tonic"), [("Ab", "G#"), ("Bb", "A#"), ("Db", "C#"), ("Eb", "D#"), ("Gb", "F#")]
)
def test_essentia_flat_names_become_sharps(monkeypatch, name, tonic):
    with_essentia_algorithms(monkeypatch, key=FakeAlgorithm((name, "major", 0.8)))
    estimate = estimators.EssentiaEstimator().key(estimators.Signals(a_major_triad(), 22050))
    assert (estimate.tonic, estimate.mode) == (tonic, "major")


# Each estimator's own minimum key strength (values pinned here, not read from the module): set
# by the calibration in evals/audio from atonal controls and annotated clips.
@pytest.mark.parametrize(
    ("estimator", "minimum"),
    [(estimators.LibrosaEstimator, 0.4), (estimators.EssentiaEstimator, 0.4)],
)
def test_weak_keys_are_withheld_at_each_estimators_minimum(estimator, minimum):
    assert estimator.min_key_strength == minimum
    key = estimators._key_estimate
    assert key("C", "major", minimum - 0.01, "p", "m", estimator.min_key_strength) is None
    assert key("C", "major", minimum + 0.01, "p", "m", estimator.min_key_strength) is not None
    assert key("C", "major", float("nan"), "p", "m", minimum) is None
    assert key("H", "major", 0.9, "p", "m", minimum) is None


# Atonal material: random chromatic notes (with and without drums), a chromatic cluster and
# twelve-tone rows. Neither estimator's strength separates it from tonal music: at their minimum
# of 0.4 Essentia still keys seven of the ten, librosa six. Those are strict expected
# failures, so a change in either direction is seen.
ATONAL = {
    **{f"random-notes-{k}": (lambda k=k: signals.random_notes(k)) for k in (83, 84, 85)},
    **{
        f"random-notes-drums-{k}": (lambda k=k: signals.random_notes(k, beat=True))
        for k in (83, 84, 85)
    },
    "chromatic-cluster": signals.chromatic_cluster,
    **{f"twelve-tone-row-{k}": (lambda k=k: signals.twelve_tone_row(k)) for k in (12, 13, 14)},
}
KEYS_ATONAL = {
    "essentia": set(ATONAL) - {"random-notes-85", "random-notes-drums-84", "chromatic-cluster"},
    "librosa": {
        "random-notes-83",
        "random-notes-84",
        "random-notes-85",
        "twelve-tone-row-12",
        "twelve-tone-row-13",
        "twelve-tone-row-14",
    },
}


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("name", ATONAL)
def test_no_key_for_atonal_material(name, estimator, request):
    if name in KEYS_ATONAL[estimator]:
        request.applymarker(
            pytest.mark.xfail(
                strict=True, reason="the key strength is as high here as on tonal music"
            )
        )
    signals_ = estimators.Signals(ATONAL[name](), FIXTURE_SR)
    assert estimators.select_estimator(estimator).key(signals_) is None


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_over_a_beat_the_spectral_lines_decide_for_both_estimators(estimator):
    """
    Pitchless drums at 128 BPM (kit seed 3): Essentia's strength for them is 0.85, so only the
    spectral-line rule keeps a key off them. D major pads under drums 18 dB louder leave too few
    lines as well and lose their key: the cost of that rule.
    """
    drums = estimators.Signals(signals.drums_only(128, seed=3), FIXTURE_SR)
    assert why(drums.key_withheld()) == "no sustained pitch"
    assert estimators.select_estimator(estimator).key(drums) is None
    y = music.mix((signals.chord_pad_progression(), 0), (signals.drums_only(120, seed=2), 18))
    buried = estimators.Signals(y, FIXTURE_SR)
    assert buried.has_beat and why(buried.key_withheld()) == "no sustained pitch"
    assert estimators.select_estimator(estimator).key(buried) is None


@pytest.mark.parametrize(("confidence", "kept"), [(0.29, False), (0.31, True)])
def test_librosa_tempo_is_withheld_at_low_confidence(monkeypatch, confidence, kept):
    monkeypatch.setattr(estimators, "periodicity_at_lag", lambda envelope, lag: confidence)
    estimate = estimators.LibrosaEstimator().tempo(steady_signals())
    assert (estimate is not None) == kept


def test_essentia_algorithms_are_per_thread_and_reused():
    made = []

    def factory():
        algorithm = FakeAlgorithm(None)
        made.append(algorithm)
        return algorithm

    first = estimators._essentia_algorithm("test-algorithm", factory)
    again = estimators._essentia_algorithm("test-algorithm", factory)
    assert first is again and first.resets == 1
    other = []
    thread = threading.Thread(
        target=lambda: other.append(estimators._essentia_algorithm("test-algorithm", factory))
    )
    thread.start()
    thread.join()
    assert other[0] is not first and len(made) == 2


# --- key ---------------------------------------------------------------------------------


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("fmt", FORMATS)
def test_key_of_the_a_major_triad(analyse, fmt, estimator):
    result, v2 = analyse(a_major_triad(), fmt, estimator=estimator)
    key = v2["key"]
    assert (key["tonic"], key["mode"]) == ("A", "major")
    assert key["strength"] >= 0.7
    assert key["method"].startswith(estimator)
    assert (result["key"], result["mode"]) == ("A", "Major")


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_key_of_a_44k_stereo_mp3(analyse, estimator):
    _, v2 = analyse(split_triad_stereo(), "MP3", sr=PREVIEW_SR, estimator=estimator)
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == ("A", "major")


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize(
    ("chords", "expected"),
    [(C_MAJOR_PROGRESSION, ("C", "major")), (A_MINOR_PROGRESSION, ("A", "minor"))],
    ids=["C-F-G-C", "Am-Dm-E-Am"],
)
def test_key_of_the_progressions(analyse, chords, expected, fmt, estimator):
    _, v2 = analyse(progression(chords), fmt, estimator=estimator)
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == expected
    assert v2["key"]["strength"] >= 0.8


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize(
    ("probe", "expected"),
    [
        ("band-97", ("C", "major")),
        ("chords-D", ("D", "major")),
        ("piano-line", ("C", "major")),
        ("rain-chords-0dB", ("D", "major")),
        ("rain-piano-0dB", ("C", "major")),
        ("chords-under-loud-drums", ("D", "major")),
        ("piano-under-loud-drums", ("C", "major")),
        ("sung-melody-vibrato", ("G", "major")),
    ],
)
def test_key_of_tonal_music(probe, expected, estimator):
    """
    Music keeps its key, under a rain-like noise bed at 0 dB or drums four times louder than
    it. (Without the harmonic/percussive separation, librosa reads F# minor and E minor under
    the loud drums.)
    """
    result, v2 = analyse_array(PROBES[probe], estimator)
    assert v2["gate"]["passed"]
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == expected
    assert result["key"] == expected[0]


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize(
    ("root", "tonic"), [(233.08, "A#"), (311.13, "D#"), (207.65, "G#"), (277.18, "C#")]
)
def test_key_names_are_sharps(analyse, root, tonic, estimator):
    """Bb, Eb, Ab and Db major triads (Essentia names them with flats) come out as sharps."""
    freqs = [root, root * 2 ** (4 / 12), root * 2 ** (7 / 12)]
    _, v2 = analyse(tones(freqs), "WAV", estimator=estimator)
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == (tonic, "major")


PITCHLESS = [
    "noise-bursts",
    "drums-only-97",
    "drums-only-120",
    "drums-only-140",
    "metronome-1kHz",
    "metronome-accented",
    "square-2Hz",
    "brown-noise-with-kick",
    "drums-crash-jitter-15ms",
    "drums-crash-jitter-25ms",
]


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("probe", PITCHLESS)
def test_no_key_for_pitchless_rhythm(probe, estimator):
    """Drums, clicks, a square wave and noise with a beat pass the gate but have no key."""
    result, v2 = analyse_array(PROBES[probe], estimator)
    assert v2["gate"]["passed"]
    assert v2["key"] is None and result["key"] is None
    assert v2["beats"] is not None


@pytest.mark.seeded
@pytest.mark.estimators
@pytest.mark.parametrize("family", signals.PITCHLESS_SEEDED)
def test_no_key_for_pitchless_material_at_control_seeds(family):
    """
    Drums, noise with a beat, a siren over drums and clicks, 30 seeds each (tempo, kit, noise,
    levels and sounds drawn from the seed; the calibration also sees these as controls): never
    a key, with either estimator (on the same signals).
    """
    make = signals.PITCHLESS_SEEDED[family]
    keyed = {}
    for seed in signals.CONTROL_SEEDS:
        signals_ = estimators.Signals(make(seed), FIXTURE_SR)
        for name in KEY_ESTIMATORS:
            key = estimators.select_estimator(name).key(signals_)
            if key is not None:
                keyed[(name, seed)] = (key.tonic, key.mode, key.strength)
    assert keyed == {}


# One pitched source, 30 seeds each (signals.ONE_PITCH_CLASS_SEEDED): a note's overtones, its
# octaves or a bell's or a drum's partials can spell three pitch classes. The single-source rule
# (estimators.SourceEvidence) withholds the keys that analyzer 2.1.0 gave most cowbells and
# one-note basses. The seeds that get a key are pinned exactly, in both directions: a change
# that keys one more or one fewer fails here. Still keyed: bells, alone and over drums (the
# tierce is a minor third over the hum: two notes a third apart, as in a chord); three cowbells
# whose oscillators read as a sixth or whose fifth harmonic counts as a note; two basses whose
# harmonics the notes test does not fold within its tolerance; toms (two or three drums, each with its own envelope) and tabla whose
# strokes alternate partials, which do not move together. Seeds 600-629 are an evaluation set
# (evals/audio controls) and are kept out of these tests.
ONE_PITCH_CLASS_KEYED = {
    ("one-note-bass", "essentia"): {500, 501},
    ("bell", "essentia"): {503, 507, 509, 513, 514, 521, 527},
    ("bell", "librosa"): {503, 507, 509, 513, 514, 521, 527},
    ("bell-over-drums", "essentia"): {509, 513, 514, 522},
    ("bell-over-drums", "librosa"): {509, 513, 514, 522},
    ("tabla", "essentia"): {500, 503, 504, 505, 512, 513, 515, 516, 521, 526, 527},
    ("tabla", "librosa"): {500, 503, 505, 512, 513, 515, 516, 519, 526, 527},
    ("toms", "essentia"): {502, 507, 509, 514, 515, 517, 521, 522, 526},
    ("toms", "librosa"): {502, 507, 509, 517, 522, 526, 529},
    ("cowbell", "essentia"): {508, 515, 528},
    ("cowbell", "librosa"): {508, 528},
}


@pytest.mark.seeded
@pytest.mark.estimators
@pytest.mark.parametrize("family", signals.ONE_PITCH_CLASS_SEEDED)
def test_one_pitch_class_material_gets_exactly_the_pinned_keys(family):
    """Both estimators on the same signals (they share the representations)."""
    make = signals.ONE_PITCH_CLASS_SEEDED[family]
    keyed = {name: {} for name in KEY_ESTIMATORS}
    for seed in signals.ONE_PITCH_CLASS_SEEDS:
        signals_ = estimators.Signals(make(seed), FIXTURE_SR)
        for name in KEY_ESTIMATORS:
            key = estimators.select_estimator(name).key(signals_)
            if key is not None:
                keyed[name][seed] = (key.tonic, key.mode, round(key.strength, 2))
    for name in KEY_ESTIMATORS:
        expected = ONE_PITCH_CLASS_KEYED.get((family, name), set())
        assert set(keyed[name]) == expected, (name, keyed[name])


@pytest.mark.parametrize(
    "family, seed",
    [("cowbell", 500), ("cowbell", 502), ("one-note-bass", 504), ("one-note-bass", 507)],
)
def test_one_pitched_source_has_no_key(family, seed):
    """
    Material that every other key rule lets through (analyzer 2.1.0 keyed these seeds): its
    lines hold still, move together and spell one note, or two a fifth or a tritone apart, so
    the key is withheld as one source. The reason does not judge the input not music: the
    fingerprint is kept.
    """
    signals_ = estimators.Signals(signals.ONE_PITCH_CLASS_SEEDED[family](seed), FIXTURE_SR)
    evidence = signals_.source_evidence
    assert evidence.single, evidence
    withheld = signals_.key_withheld()
    assert str(withheld) == estimators.ONE_SOURCE
    assert not withheld.one_source and signals_.not_music() is None
    for name in KEY_ESTIMATORS:
        assert estimators.select_estimator(name).key(signals_) is None


def test_a_bell_holds_still_but_spells_a_minor_third():
    """A tolling bell's lines move together, but its hum and tierce are a minor third apart."""
    evidence = estimators.Signals(signals.seeded_bell(509), FIXTURE_SR).source_evidence
    assert evidence.still and evidence.chord and not evidence.single, evidence


@pytest.mark.seeded
@pytest.mark.parametrize("family", signals.CHORD_KEYED_SEEDED)
def test_chords_keep_the_key_the_other_rules_give_them(family):
    """
    Held chords faded, swelling, getting louder, with tremolo or a sidechain pump, chord stabs,
    a bass and chord riff on one chord and one-bar riffs (signals.CHORD_KEYED_SEEDED, seeds
    700-729): many hold still and move together, but their lines spell a chord, so the
    single-source rule withholds none of their keys, and what the other rules decide is left
    as analyzer 2.1.0 had it.
    """
    make = signals.CHORD_KEYED_SEEDED[family]
    fired, still = [], 0
    for seed in signals.CHORD_KEYED_SEEDS:
        y, _ = make(seed)
        signals_ = estimators.Signals(y, FIXTURE_SR)
        still += signals_.source_evidence.still
        if str(signals_.key_withheld()) == estimators.ONE_SOURCE:
            fired.append(seed)
    assert fired == []
    if family != "one-bar-riff":  # its chords change within a bar: the lines move
        assert still > 0  # the notes test, not time, keeps these keys


@pytest.mark.seeded
@pytest.mark.parametrize("root", range(4), ids=["C3", "C#3", "D3", "D#3"])
def test_a_chord_with_a_softer_third_over_a_doubled_root_keeps_its_key(root):
    """
    A triad at C3-D#3 with its root doubled an octave down and its third 1.5-6 dB softer
    (signals.SOFT_THIRD_GRID, both modes, three timbres, pumped, faded, with tremolo or
    stabbed): the doubled root is the strongest line and the third sits on its flank, but down
    to 4.5 dB softer its notes still spell a chord, and at 6 dB the single-source rule still
    withholds no key (the other rules decide those).
    """
    for index, (grid_root, _, _, level) in enumerate(signals.SOFT_THIRD_GRID):
        if grid_root != root:
            continue
        y, key = signals.soft_third_chord(index)
        s = estimators.Signals(y, FIXTURE_SR)
        notes = estimators.source_notes(s.harmonic_stft, s.sr, s.hop)
        if level > -6.0:
            assert estimators.spells_chord(notes), (key, level, notes)
        assert str(s.key_withheld()) != estimators.ONE_SOURCE, (key, level, notes)


@pytest.mark.parametrize("cents", signals.THIRD_DETUNE_CENTS)
def test_a_detuned_third_over_a_doubled_root_is_still_a_third(cents):
    """A root doubled an octave down with its third 10-25 cents off and no fifth: a chord."""
    for root, mode in ((0, "minor"), (1, "major")):
        s = estimators.Signals(signals.detuned_third(root, mode, cents), FIXTURE_SR)
        notes = estimators.source_notes(s.harmonic_stft, s.sr, s.hop)
        assert estimators.spells_chord(notes), (root, mode, cents, notes)


@pytest.mark.parametrize("kind", ["sus2", "sus4"])
def test_sus_chords_over_their_root_are_chords(kind):
    """
    A sus2 or sus4 chord with its root doubled below is three pitch classes: its fifth, as loud
    as the root, is a chord tone and not the root's third harmonic. Whatever key the other rules
    give it stays, and the single-source reason is never given.
    """
    for root in (0, 5, 9):
        s = estimators.Signals(signals.sus_chord(root, kind), FIXTURE_SR)
        notes = estimators.source_notes(s.harmonic_stft, s.sr, s.hop)
        assert estimators.spells_chord(notes), (root, notes)
        assert str(s.key_withheld()) != estimators.ONE_SOURCE


def test_chord_key_names_each_family_s_key():
    for family, make in signals.CHORD_KEYED_SEEDED.items():
        assert make(700)[1] == signals.chord_key(family, 700), family


def test_held_and_struck_lines_by_the_numbers():
    """The rule's values, one measurement at a time across its limit (literal, not the names)."""
    one_note = {"bins": 12, "movement": 0.01, "shared": 0.9, "depth": 0.4, "notes": (98.0,)}
    assert estimators.SourceEvidence(**one_note).single
    for field, value in (("bins", 5), ("movement", 0.06), ("shared", 0.55), ("depth", 0.1)):
        evidence = estimators.SourceEvidence(**{**one_note, field: value})
        assert not evidence.still and not evidence.single, field
    # The notes decide once time says one source.
    for notes, chord in (
        ((98.0,), False),
        ((540.0, 800.0), False),  # 680 cents: a cowbell's two oscillators
        ((220.0, 330.0), False),  # a fifth
        ((73.42, 174.61), True),  # D2 and F3: a minor third over the root
        ((65.41, 329.63), True),  # C2 and E4: a major third (not C2's fifth harmonic)
        ((261.63, 440.0), True),  # a major sixth
        ((130.81, 164.81, 196.0), True),
        # The root's octave 16 cents low and the third 16 cents high: any pair decides.
        ((65.41, 130.81 * 2 ** (-16 / 1200), 164.81 * 2 ** (16 / 1200)), True),
    ):
        evidence = estimators.SourceEvidence(**{**one_note, "notes": notes})
        assert evidence.chord == chord and evidence.single == (not chord), notes
    assert not estimators.SourceEvidence(**{**one_note, "notes": None}).single


def test_source_notes_folds_overtones_and_keeps_chord_tones():
    """source_notes on 30 s made up for the test, through the shared STFT."""
    t = np.arange(30 * FIXTURE_SR) / FIXTURE_SR

    def tone(f, harmonics=8):
        return sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, harmonics + 1))

    def notes_of(y):
        s = estimators.Signals((0.2 * y).astype(np.float32), FIXTURE_SR)
        return estimators.source_notes(s.harmonic_stft, s.sr, s.hop)

    # One note repeated every sixteenth at 120 BPM: its repetition leaves no extra notes.
    step = t % 0.125
    assert len(notes_of(tone(98.0) * (step < 0.1) * np.exp(-step / 0.05))) == 1
    triad = notes_of(tone(130.81) + tone(164.81) + tone(196.0))
    assert len(triad) >= 3 and estimators.spells_chord(triad)
    over_root = notes_of(2 * tone(65.41) + tone(261.63) + tone(329.63) + tone(392.0))
    assert estimators.spells_chord(over_root), over_root  # C2 + C4 E4 G4: E4 is a note
    # E-flat 5 over C1 is C1's 19th harmonic within 0.14 %: past SOURCE_NOTE_MAX_HARMONIC it is
    # a note (the minor third), not an overtone.
    deep = notes_of(tone(32.70, 4) + 0.4 * np.sin(2 * np.pi * 622.25 * t))
    assert estimators.spells_chord(deep), deep


def _lines(hz: np.ndarray) -> estimators.Tonality:
    return estimators.Tonality(1.0, np.ones(12), None, hz, np.ones(hz.size))


def test_source_evidence_needs_partials_that_share_one_struck_envelope():
    """The time half of SourceEvidence on lines and STFT magnitudes made up for the test."""
    sr, hop, frames = FIXTURE_SR, 512, 1300
    bins = np.arange(10, 90, 10)  # eight lines, one per STFT bin
    hz = bins * sr / 2048
    rng = np.random.default_rng(1)
    strokes = np.exp(-(np.arange(frames) % 11) / 2.0)  # one stroke every 11 frames
    stft = np.zeros((1025, frames))
    stft[bins] = strokes * rng.uniform(0.5, 1.0, (bins.size, 1))
    one = estimators.source_evidence(_lines(hz), stft, sr, hop)
    assert one.bins == bins.size and one.still and one.notes is None, one
    # Each line struck on its own pattern: no shared envelope.
    for k, b in enumerate(bins):
        stft[b] = np.exp(-(np.arange(frames) % (7 + 2 * k)) / 2.0)
    assert not estimators.source_evidence(_lines(hz), stft, sr, hop).still
    # Too few lines to tell: two lines struck together.
    stft[bins] = strokes
    two = estimators.source_evidence(_lines(hz[:2]), stft, sr, hop)
    assert two.bins == 2 and two.shared > 0.99 and not two.still
    # Held, not struck.
    stft[bins] = 1.0 + 0.01 * rng.standard_normal((bins.size, frames))
    assert not estimators.source_evidence(_lines(hz), stft, sr, hop).still
    assert estimators.source_evidence(_lines(np.zeros(0)), stft, sr, hop) == (
        estimators.NO_SOURCE_EVIDENCE
    )


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("bpm", [85, 120, 174])
def test_no_key_for_click_tracks(analyse, bpm, estimator):
    result, v2 = analyse(click_track(bpm), "MP3", estimator=estimator)
    assert v2["key"] is None and result["key"] is None


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize(
    "probe", ["hum-50Hz-steep", "hum-50Hz-gentle", "hum-60Hz-gentle", "tone-440Hz"]
)
def test_no_key_for_hum_or_a_single_tone(analyse, probe, fmt, estimator):
    """
    Mains hum (harmonics 1-6 steep, or 1-10 with a gentle roll-off, which spell G, B and D for
    50 Hz) and a lone tone are one harmonic series: no key.
    """
    y = tones((440.0,)) if probe == "tone-440Hz" else PROBES[probe]
    _, v2 = analyse(y, fmt, estimator=estimator)
    assert v2["gate"]["passed"]
    assert v2["key"] is None


def why(withheld):
    """The reason text of a withheld key, or None."""
    return None if withheld is None else withheld.reason


# Tonal evidence at its thresholds (values pinned here, not read from the module).
@pytest.mark.parametrize(
    ("ratio", "classes", "series", "reason"),
    [
        # C, E and G: a major triad's pitch classes.
        (0.09, [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], None, "no sustained pitch"),
        (0.11, [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], None, None),
        (0.5, [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0], None, "fewer than three pitch classes"),
        (0.5, [1, 0, 0, 0, 1, 0, 0, 0.27, 0, 0, 0, 0], None, "fewer than three pitch classes"),
        (0.5, [1, 0, 0, 0, 1, 0, 0, 0.29, 0, 0, 0, 0], None, None),
        (0.5, [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], 50.0, "one harmonic series on 50.0 Hz"),
    ],
)
def test_key_evidence_thresholds(ratio, classes, series, reason):
    tonality = estimators.Tonality(ratio, np.array(classes, dtype=float), series)
    assert why(tonality.key_withheld()) == reason


def lines_on_110_hz(off_series: float, ratio: float = 0.9, series=None, classes=(1, 4, 9)):
    """
    Lines at 110, 220 and 330 Hz (power 1 each) and one at 138.6 Hz (C#3, off the series of
    110 Hz) with power `off_series`; pitch classes as given (A major's by default).
    """
    pitch_classes = np.zeros(12)
    pitch_classes[list(classes)] = 1.0
    return estimators.Tonality(
        ratio,
        pitch_classes,
        series,
        np.array([110.0, 220.0, 330.0, 138.6]),
        np.array([1.0, 1.0, 1.0, off_series]),
    )


def a_voice(**changes):
    """One voice held on A2 (110 Hz), with no vibrato and a 100-cent span."""
    fields = dict(
        voiced=0.9,
        harmonicity=0.9,
        span_cents=100.0,
        on_grid=1.0,
        low_share=0.5,
        f0_hz=110.0,
        vibrato_cents=0.0,
        note_classes=frozenset({9}),
        relative_movement=1.0,
    )
    return estimators.Voice(**{**fields, **changes})


HELD = "one held pitch (vibrato or a bend)"
SPEECH_LIKE = "one voice without stable notes (speech-like)"


# One voice and the chromagram's movement at their thresholds, for input without a beat. An
# off-series line of power 0.058 leaves 0.981 of the line energy on the series, 0.0644 0.979.
@pytest.mark.parametrize(
    ("voice", "movement", "off_series", "reason"),
    [
        (a_voice(), 0.059, 0.058, HELD),
        (a_voice(), 0.059, 0.0644, None),  # a chord with its root in the bass
        (a_voice(), 0.061, 0.058, None),  # something else moves: a melody over a drone
        (a_voice(relative_movement=0.059), 0.061, 0.058, HELD),  # it moves with the voice
        (a_voice(relative_movement=0.059, harmonicity=0.49), 0.061, 0.058, None),
        (a_voice(span_cents=349.0), 0.059, 0.058, HELD),
        (a_voice(span_cents=351.0), 0.059, 0.058, None),  # a melody
        (a_voice(voiced=0.29), 0.059, 0.058, None),
        (a_voice(harmonicity=0.49), 0.059, 0.058, None),
        (a_voice(low_share=0.14), 0.059, 0.058, None),  # a virtual fundamental: a triad
        (a_voice(low_share=0.16), 0.059, 0.058, HELD),
        (a_voice(span_cents=600.0, on_grid=0.76), 0.4, 0.0, SPEECH_LIKE),
        (a_voice(span_cents=600.0, on_grid=0.78), 0.4, 0.0, None),
    ],
)
def test_one_voice_thresholds(voice, movement, off_series, reason):
    assert why(lines_on_110_hz(off_series).key_withheld(voice, movement)) == reason


def test_the_vibrato_widens_what_one_voice_explains():
    """
    The C#3 line, 28.6 Hz above 110 Hz, is within 2 x vibrato + span / 2 + 20 cents (+ 8 Hz)
    of the voice's fundamental only with 150 cents of vibrato.
    """
    tonality = lines_on_110_hz(0.5)
    assert tonality.explained_by(110.0, *a_voice(span_cents=0.0).tolerance) == pytest.approx(
        0.857, abs=0.001
    )
    wide = a_voice(span_cents=0.0, vibrato_cents=150.0)
    assert tonality.explained_by(110.0, *wide.tolerance) == 1.0
    assert why(tonality.key_withheld(wide, 0.0)) == HELD


def test_a_moving_voice_supplies_its_notes_and_its_own_evidence():
    """
    Without lines (an a cappella line with vibrato leaves none) a voice that moves between
    notes keeps the key open, and its notes count as pitch classes; one fixed voice does not.
    """
    singer = a_voice(span_cents=1200.0, note_classes=frozenset({2, 4, 9}))
    assert lines_on_110_hz(0.0, ratio=0.0).key_withheld(singer, 0.5) is None
    assert why(lines_on_110_hz(0.0, ratio=0.0).key_withheld(a_voice(), 0.5)) == "no sustained pitch"
    two_lines = lines_on_110_hz(0.0, classes=(4, 9))
    assert why(two_lines.key_withheld(a_voice(span_cents=1200.0), 0.5)) == (
        "fewer than three pitch classes"
    )
    assert two_lines.key_withheld(singer, 0.5) is None


def test_one_harmonic_series_needs_a_still_chromagram_without_a_beat():
    """A drone that leaves one series, under a melody that moves the chromagram, is music."""
    drone = lines_on_110_hz(0.0, series=110.0)
    assert why(drone.key_withheld(estimators.NO_VOICE, 0.059)) == "one harmonic series on 110.0 Hz"
    assert drone.key_withheld(estimators.NO_VOICE, 0.061) is None
    # With a beat (no voice, no movement given), the series decides.
    assert why(drone.key_withheld()) == "one harmonic series on 110.0 Hz"


def test_with_a_beat_a_tracker_failure_leaves_the_lines_to_decide(monkeypatch):
    signals_ = estimators.Signals(PROBES["band-97"], FIXTURE_SR)
    assert signals_.has_beat
    monkeypatch.setattr(estimators, "voice", raises)
    assert signals_.key_withheld() is None and signals_.not_music() is None


@pytest.mark.parametrize(
    ("withheld", "not_music"),
    [
        (estimators.Withheld("one held pitch (vibrato or a bend)", one_source=True), True),
        (estimators.Withheld("one-sounding text, other evidence"), False),
        (estimators.Withheld("no pitch track"), False),
        (None, False),
    ],
)
def test_not_music_follows_the_evidence_flag_not_the_text(withheld, not_music, monkeypatch):
    signals_ = estimators.Signals(tones((440.0,), 30.0), FIXTURE_SR)
    monkeypatch.setattr(estimators.Signals, "key_withheld", lambda self: withheld)
    assert (signals_.not_music() is not None) == not_music


def test_a_pitch_tracker_failure_only_loses_the_key_without_a_beat(monkeypatch, caplog):
    """
    A failing pitch track is logged; without a beat the key cannot be checked against one held
    pitch, so it is missing. The rest of the analysis completes.
    """
    monkeypatch.setattr(estimators, "voice", raises)
    signals_ = estimators.Signals(PROBES["chords-D"], FIXTURE_SR)
    result = check_result(main.analyze_signals(signals_))
    assert signals_.voice is None and "pitch track failed" in caplog.text
    assert why(signals_.key_withheld()) == "no pitch track"
    assert result["gate"]["passed"] and result["key"] is None
    assert result["loudness"] is not None and result["sections"] is not None
    # A test tone still reads as one harmonic series, and is still not music.
    tone = estimators.Signals(tones((440.0,)), FIXTURE_SR)
    assert tone.not_music() == "one harmonic series on 440.1 Hz, and no beat"


def test_harmonicity_is_zero_for_a_flat_spectrum_and_one_for_harmonics():
    freqs = librosa.fft_frequencies(sr=estimators.VOICE_RATE, n_fft=2048)
    flat = estimators.harmonicity(np.ones(freqs.size), freqs, 110.0)
    assert flat[0] == pytest.approx(0.0, abs=1e-9)
    comb = np.zeros(freqs.size)
    for k in range(1, 11):
        comb[np.argmin(np.abs(freqs - 110.0 * k))] = 1.0 / k
    harmonic, low = estimators.harmonicity(comb, freqs, 110.0)
    assert harmonic == pytest.approx(1.0) and low == 1.0
    assert estimators.harmonicity(np.zeros(freqs.size), freqs, 110.0) is None


def test_a_pitch_below_the_tracker_range_is_no_voice():
    """A 32.7 Hz sine (C1) pins the tracker at its 40 Hz edge: those frames are not a voice."""
    t = np.arange(30 * FIXTURE_SR) / FIXTURE_SR
    sine = (0.5 * np.sin(2 * np.pi * 32.7 * t)).astype(np.float32)
    assert estimators.voice(estimators.Signals(sine, FIXTURE_SR)).voiced < 0.3


def test_one_held_pitch_with_a_beat_is_still_music():
    """A 440 Hz tone over a click track: one harmonic series, so no key, but a beat: music."""
    y = (tones((440.0,), 30.0) + click_track(120)).astype(np.float32)
    signals_ = estimators.Signals(y, FIXTURE_SR)
    assert signals_.has_beat
    assert why(signals_.key_withheld()).startswith("one harmonic series")
    assert signals_.not_music() is None


def test_spectral_lines_must_stand_12_db_above_the_floor():
    """A 1 kHz sine 9 dB above white noise in the long-term spectrum is not a line; 18 dB is."""
    noise = signals.colored_noise(0, seconds=30.0, rms=0.2)
    t = np.arange(noise.size) / FIXTURE_SR
    weak, strong = (noise + a * np.sin(2 * np.pi * 1000 * t) for a in (0.01, 0.03))
    assert estimators.tonality(weak.astype(np.float32), FIXTURE_SR).tonal_ratio == 0.0
    assert estimators.tonality(strong.astype(np.float32), FIXTURE_SR).tonal_ratio > 0.0


# Without a beat: one held pitch (vibrato from +-35 to +-120 cents, G1 to E6, a slow 0.5 Hz
# pitch swing, bends) and speech-like voices (irregular syllables, gliding pitch) get no key and
# no fingerprint; music keeps both.
ONE_PITCH = {
    "A4-vibrato-40c": lambda: PROBES["A4-vibrato-40c"],
    "A4-vibrato-80c": lambda: PROBES["A4-vibrato-80c"],
    "A4-vibrato-120c": lambda: PROBES["A4-vibrato-120c"],
    "Bb3-brass-vibrato-40c": lambda: PROBES["Bb3-brass-vibrato-40c"],
    "Bb3-brass-vibrato-80c": lambda: PROBES["Bb3-brass-vibrato-80c"],
    "Bb3-brass-vibrato-120c": lambda: PROBES["Bb3-brass-vibrato-120c"],
    "F4-brass-vibrato-40c": lambda: PROBES["F4-brass-vibrato-40c"],
    "D4-clarinet-vibrato": lambda: PROBES["D4-clarinet-vibrato"],
    "G1-brass-vibrato-60c": lambda: music.held(music.hz(31)),
    "C6-brass-vibrato-60c": lambda: music.held(music.hz(84)),
    "E6-brass-vibrato-60c": lambda: music.held(music.hz(88)),
    "Bb3-brass-swing-0.5Hz-80c": lambda: music.held(233.08, 80.0, 0.5),
    "bend-1-semitone": lambda: signals.bend(semitones=1.0),
    "bend-2-semitones": lambda: PROBES["bend-2-semitones"],
    "bend-3-semitones": lambda: signals.bend(semitones=3.0),
    "speech-low": lambda: music.speech(4, 95.0, 160.0),
    "speech-high": lambda: music.speech(9, 170.0, 260.0),
}
MUSIC_WITHOUT_A_BEAT = {
    "band-C-G-Am-F-no-drums": (lambda: music.band_mix("C-G-Am-F", False), ("C", "major")),
    "band-Dm-C-no-drums": (lambda: music.band_mix("Dm-C", False), ("D", "minor")),
    "band-C-vamp-no-drums": (lambda: music.band_mix("C-vamp", False), ("C", "major")),
    # E minor and A major chords under an E minor melody (E dorian): no single answer.
    "band-Em-A-no-drums": (lambda: music.band_mix("Em-A", False), None),
    "pad-Am-root-in-bass": (music.ambient_pad, ("A", "minor")),
    "melody-over-louder-drone": (music.melody_over_drone, ("D", "major")),
    "melody-over-drone": (lambda: music.melody_over_drone(0.0), ("D", "major")),
    # D, Eb, F and G fit Bb major, G minor and others.
    "narrow-trumpet-melody": (music.trumpet_melody, None),
    "a-cappella-vibrato-70c-A": (lambda: music.sung(9, "major", 57, 72, 31, 70.0), ("A", "major")),
    "a-cappella-vibrato-70c-Dm": (lambda: music.sung(2, "minor", 50, 66, 21, 70.0), ("D", "minor")),
    "pop-vocal-scoops-and-glides": (
        lambda: music.sung(4, "minor", 55, 71, 33, 30.0, 150.0, 0.2),
        ("E", "minor"),
    ),
}
# Band mixes with drums, the bass level with the rest and 6 dB louder. A one-chord C major vamp
# under a bass 6 dB louder is left out: it reads as one held C2 (harmonics 4, 5 and 6 are the
# triad), and its key is withheld.
BAND_MIXES = {
    f"band-{name}-bass{bass_db:+d}": (
        lambda name=name, db=bass_db: music.band_mix(name, True, db),
        key,
    )
    for name, (_, key) in music.PROGRESSIONS.items()
    for bass_db in (0, 6)
    if (name, bass_db) != ("C-vamp", 6)
}
KEY_ESTIMATORS = ["librosa"] + (["essentia"] if estimators.ESSENTIA_AVAILABLE else [])


def gate_key_and_music(y: np.ndarray):
    """(gate, {estimator: (tonic, mode) or None}, not-music reason, has a beat) of a signal."""
    signals_ = estimators.Signals(y, FIXTURE_SR)
    gate = signal_features.check_gate(signals_, signal_features.levels(signals_))
    keys = {}
    for name in KEY_ESTIMATORS:
        key = estimators.select_estimator(name).key(signals_)
        keys[name] = key and (key.tonic, key.mode)
    return gate, keys, signals_.not_music(), signals_.has_beat


@pytest.mark.parametrize("name", ONE_PITCH)
def test_no_key_and_not_music_for_one_held_pitch_or_speech(name):
    gate, keys, not_music, beat = gate_key_and_music(ONE_PITCH[name]())
    assert gate.passed and not beat
    assert set(keys.values()) == {None}, keys
    assert not_music is not None


def test_no_key_for_a_held_note_above_2_khz():
    """C7 (2093 Hz) with +-30 cents of vibrato: the tracker reaches 4 kHz, so it is one voice."""
    gate, keys, _, beat = gate_key_and_music(music.held(music.hz(96), 30.0, 5.0, music.FLUTE))
    assert gate.passed and not beat
    assert set(keys.values()) == {None}, keys


@pytest.mark.parametrize("name", MUSIC_WITHOUT_A_BEAT)
def test_music_without_a_beat_keeps_its_key_and_fingerprint(name):
    """
    A pad with its root in the bass, a melody over a drone, a narrow trumpet melody, an a
    cappella line with +-70 cents of vibrato and drumless band mixes with a bass at E1-C2.
    """
    make, expected = MUSIC_WITHOUT_A_BEAT[name]
    gate, keys, not_music, beat = gate_key_and_music(make())
    assert gate.passed and not beat
    assert None not in keys.values(), keys
    if expected is not None:
        assert set(keys.values()) == {expected}, keys
    assert not_music is None


@pytest.mark.parametrize("name", BAND_MIXES)
def test_band_mixes_with_a_bass_line_keep_their_key(name):
    """
    Drums, a bass at E1-D2, a pad and a sung lead: the tracker may follow the bass, but the
    chords are off its harmonics.
    """
    make, expected = BAND_MIXES[name]
    gate, keys, not_music, beat = gate_key_and_music(make())
    assert gate.passed and beat and not_music is None
    assert None not in keys.values(), keys
    if not name.startswith("band-Em-A"):  # E dorian, as above
        assert set(keys.values()) == {expected}, keys


# With a beat: one pitched source over drums has no key. A drone (mains-hum-like harmonics, as
# the drone-with-drums probe) under drums 2 or 4 times louder, a held brass note with vibrato,
# speech over drums.
ONE_SOURCE_OVER_DRUMS = {
    f"drone-{f0:.0f}Hz-drums-x{k}-s{seed}": (
        lambda f0=f0, k=k, seed=seed: signals.normalise(
            signals.hum(f0, gentle=True) + k * signals.drums_only(120, seed=seed)
        )
    )
    for f0 in (98.0, 110.0, 147.0)
    for k in (2, 4)
    for seed in (1, 2)
}
ONE_SOURCE_OVER_DRUMS["Bb3-brass-vibrato-60c-over-drums"] = lambda: music.mix(
    (music.held(233.08, 60.0), 0), (music.drums(music.ROCK, 100), 0)
)
ONE_SOURCE_OVER_DRUMS["speech-over-trap"] = lambda: music.mix(
    (music.speech(4), 0), (music.drums(music.TRAP, 90), -6)
)
ONE_SOURCE_OVER_DRUMS["speech-over-rock"] = lambda: music.mix(
    (music.speech(9, 170.0, 260.0), 0), (music.drums(music.ROCK, 96), -3)
)


@pytest.mark.parametrize("name", ONE_SOURCE_OVER_DRUMS)
def test_no_key_for_one_source_over_drums(name):
    gate, keys, not_music, beat = gate_key_and_music(ONE_SOURCE_OVER_DRUMS[name]())
    assert gate.passed and beat and not_music is None  # a beat: music, with a fingerprint
    assert set(keys.values()) == {None}, keys


def speech_variants(y: np.ndarray) -> dict:
    """Speech pitched 7 semitones down and up, and played at 0.8 and 1.25 times the speed."""
    out = {
        f"shift{st:+d}": librosa.effects.pitch_shift(y, sr=FIXTURE_SR, n_steps=st) for st in (-7, 7)
    }
    for rate in (0.8, 1.25):
        out[f"stretch{rate}"] = np.resize(librosa.effects.time_stretch(y, rate=rate), y.size)
    return out


@pytest.mark.parametrize("variant", ["shift-7", "shift+7", "stretch0.8", "stretch1.25"])
def test_no_key_for_shifted_or_stretched_speech(variant):
    y = speech_variants(music.speech(4))[variant]
    gate, keys, not_music, beat = gate_key_and_music(music.normalise(y))
    assert gate.passed and not beat
    assert set(keys.values()) == {None}, keys
    assert not_music is not None


SPEECH = "/usr/share/sounds/speech-dispatcher/dummy-message.wav"


@pytest.mark.skipif(not os.path.exists(SPEECH), reason="no speech recording on this machine")
@pytest.mark.parametrize("variant", ["as-is", "shift-7", "shift+7", "stretch0.8", "stretch1.25"])
def test_no_key_for_recorded_speech_shifted_or_stretched(variant):
    """The speech-dispatcher recording, looped to 30 s: it passes the gate and gets no key."""
    y, sr = sf.read(SPEECH, dtype="float32")
    y = librosa.resample(y if y.ndim == 1 else y.mean(axis=1), orig_sr=sr, target_sr=FIXTURE_SR)
    y = np.resize(y, 30 * FIXTURE_SR)
    y = y if variant == "as-is" else speech_variants(y)[variant]
    gate, keys, not_music, beat = gate_key_and_music(music.normalise(y))
    assert gate.passed and not beat
    assert set(keys.values()) == {None}, keys


@pytest.mark.skipif(not os.path.exists(SPEECH), reason="no speech recording on this machine")
@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_no_key_for_speech(estimator, monkeypatch):
    """A real speech recording passes the gate (it is voiced, not noise) and gets no key."""
    y, sr = sf.read(SPEECH, dtype="float32")
    signals_ = estimators.Signals(y if y.ndim == 1 else y.mean(axis=1), sr)
    assert signals_.voice.without_notes
    result = check_result(main.analyze_signals(signals_, estimators.select_estimator(estimator)))
    assert result["gate"] == {"passed": True, "reason": None}
    assert result["key"] is None and result["tempo"] is None


def test_harmonic_series_detection():
    bin_hz = 22050 / 16384
    hum = np.array([50.0, 100.0, 150.0, 200.0, 250.0, 300.0, 400.0, 500.0])
    assert estimators.harmonic_series(hum, np.ones(8), bin_hz) == pytest.approx(50.0, abs=0.1)
    # 60 Hz read off whole bins (60.6, then 600.2 for the 10th harmonic) still fits.
    sixty = np.array([60.6, 120.4, 180.4, 240.3, 300.2, 360.2, 420.1, 480.1, 540.1, 600.2])
    assert estimators.harmonic_series(sixty, np.ones(10), bin_hz) == pytest.approx(60.0, abs=0.2)
    triad = np.array([220.0, 277.18, 329.63])
    assert estimators.harmonic_series(triad, np.ones(3), bin_hz) is None
    # High harmonics may be 0.4% off either way (8 Hz at 2 kHz, beyond the two-bin floor), not 1%.
    near = np.array([200.0, 400.0, 2008.0, 2192.0])
    far = np.array([200.0, 400.0, 2020.0, 2178.0])
    assert estimators.harmonic_series(near, np.ones(4), bin_hz) == pytest.approx(200, abs=0.5)
    assert estimators.harmonic_series(far, np.ones(4), bin_hz) is None
    # A line off the series with under 10% of the energy does not break it; with more it does.
    off = np.array([50.0, 100.0, 173.0])
    assert estimators.harmonic_series(off, np.array([1, 1, 0.2]), bin_hz) is not None
    assert estimators.harmonic_series(off, np.array([1, 1, 0.25]), bin_hz) is None


# --- gate --------------------------------------------------------------------------------

GATED = [
    ("silence", lambda: np.zeros(10 * FIXTURE_SR), "silence"),
    ("dc-offset", lambda: np.full(10 * FIXTURE_SR, 0.5), "silence"),
    (
        "dither",
        lambda: np.random.default_rng(3).uniform(-1, 1, 10 * FIXTURE_SR) / 32768,
        "silence",
    ),
    ("white-noise", lambda: white_noise(), "noise"),
    ("quiet-white-noise", lambda: white_noise(rms=0.006), "noise"),
    ("pink-noise", lambda: signals.colored_noise(1), "noise"),
    ("brown-noise", lambda: signals.colored_noise(2), "noise"),
    ("brown-noise-30s", lambda: signals.colored_noise(2, seconds=30.0), "noise"),
    ("pink-noise-other-seed", lambda: signals.colored_noise(1, seed=17), "noise"),
    ("white-noise-whine-14dB", lambda: PROBES["white-noise-whine-14dB"], "noise"),
    ("white-noise-whine-10dB", lambda: PROBES["white-noise-whine-10dB"], "noise"),
    ("white-noise-whine-6dB", lambda: PROBES["white-noise-whine-6dB"], "noise"),
    ("pink-noise-hum-6dB", lambda: PROBES["pink-noise-hum-6dB"], "noise"),
    ("pink-noise-hum-10dB", lambda: signals.noise_with_tone(signals.hum(50), 1, -10), "noise"),
    ("1s-click-track", lambda: click_track(120, seconds=1.0), "too_short"),
    ("1s-triad", lambda: a_major_triad(seconds=1.0), "too_short"),
    ("3.9s-band", lambda: signals.drum_pattern(120, seconds=3.9), "too_short"),
    ("10-samples", lambda: np.full(10, 0.3), "too_short"),
]


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize(("make", "reason"), [g[1:] for g in GATED], ids=[g[0] for g in GATED])
def test_gated_input_measures_nothing(analyse, make, reason, fmt):
    result, v2 = analyse(np.asarray(make(), dtype=np.float32), fmt)
    assert v2["gate"] == {"passed": False, "reason": reason}
    assert all(v2[block] is None for block in MEASURED_BLOCKS)
    assert v2["keyMoments"] == []
    # The v1 fields: no tempo, no key ("C Major" for silence before the gate), nothing derived.
    assert (result["bpm"], result["key"], result["mode"], result["energy"]) == (None,) * 4
    for field in ("valence", "danceability", "acousticness", "instrumentalness"):
        assert result[field] is None


def test_zero_length_file_is_gated(analyse):
    result, v2 = analyse(np.zeros(0, dtype=np.float32), "WAV")
    assert v2["gate"] == {"passed": False, "reason": "too_short"}
    assert v2["window"]["durationSeconds"] == 0
    assert result["energy"] is None


@pytest.mark.parametrize(
    "make",
    [
        lambda: signals.noise_bursts(),
        lambda: a_major_triad() + white_noise(rms=0.1),
        lambda: a_major_triad(gain=0.02),
        lambda: signals.drum_pattern(97),
        lambda: signals.drum_pattern(120, seconds=4.1),
        lambda: PROBES["rain-chords-0dB"],
        lambda: PROBES["rain-piano-0dB"],
        lambda: PROBES["drums-crash-jitter-25ms"],
        lambda: PROBES["drums-crash-jitter-40ms"],
        lambda: signals.under_noise(signals.chord_pad_progression(), alpha=0, snr_db=-10),
    ],
    ids=[
        "noise-bursts-in-rhythm",
        "triad-under-noise",
        "quiet-triad",
        "drum-pattern",
        "4.1s-band",
        "rain-and-chords",
        "rain-and-piano",
        "drum-take-25ms-jitter",
        "drum-take-40ms-jitter",
        "chords-under-hiss-at-10dB",
    ],
)
def test_structured_input_passes_the_gate(analyse, make):
    """Rhythm made of noise, music under noise, a quiet chord: measured, not gated."""
    _, v2 = analyse(make().astype(np.float32), "MP3")
    assert v2["gate"] == {"passed": True, "reason": None}
    assert v2["loudness"] is not None and v2["energyContour"] is not None


@pytest.mark.parametrize(
    ("duration", "loud", "periodicity", "tonal", "reason"),
    [
        (3.99, 0.1, 0.9, 0.9, "too_short"),
        (4.01, 0.1, 0.9, 0.9, None),
        (30, 0.99e-3, 0.9, 0.9, "silence"),
        (30, 1.01e-3, 0.9, 0.9, None),
        (30, 0.1, 0.19, 0.09, "noise"),
        (30, 0.1, 0.21, 0.09, None),
        (30, 0.1, 0.19, 0.11, None),
        # One harmonic series (a whine, hum) is not musical pitch unless it is nearly all there is.
        (30, 0.1, 0.19, (0.89, 1000.0), "noise"),
        (30, 0.1, 0.19, (0.91, 1000.0), None),
        (30, 0.1, 0.21, (0.5, 1000.0), None),
    ],
)
def test_gate_thresholds(duration, loud, periodicity, tonal, reason):
    """The gate at its thresholds (values pinned here, not read from the module)."""
    ratio, series = tonal if isinstance(tonal, tuple) else (tonal, None)
    fake = SimpleNamespace(
        duration=duration,
        onset_periodicity=periodicity,
        tonality=estimators.Tonality(ratio, np.ones(12), series),
        voice=estimators.NO_VOICE,
    )
    levels = signal_features.Levels(frames=np.full(100, loud), hop_seconds=0.1)
    gate = signal_features.check_gate(fake, levels)
    assert gate == signal_features.Gate(reason is None, reason)
    if reason == "noise":
        # One moving voice (speech, or an a cappella line whose vibrato leaves few lines or one
        # series) is not noise; one fixed pitch is, and so is a failed pitch track.
        # One voice without stable notes and a narrow span (speech pitched up) is not noise.
        for voice in (
            estimators.Voice(0.9, 0.9, 351, 1.0, 1.0),
            estimators.Voice(0.9, 0.9, 349, 0.5, 1.0),
        ):
            fake.voice = voice
            assert signal_features.check_gate(fake, levels) == signal_features.Gate(True, None)
        for voice in (estimators.Voice(0.9, 0.9, 349, 1.0, 1.0), None):
            fake.voice = voice
            assert signal_features.check_gate(fake, levels) == signal_features.Gate(False, reason)


@pytest.mark.parametrize(("periodicity", "kept"), [(0.19, False), (0.21, True)])
def test_a_tempo_needs_repeating_onsets(monkeypatch, periodicity, kept):
    signals_ = steady_signals()
    signals_.__dict__["onset_periodicity"] = periodicity
    assert (estimators.LibrosaEstimator().tempo(signals_) is not None) == kept


def test_the_gate_withholds_models_on_silence(analyse, monkeypatch):
    def fail(*args):
        raise AssertionError("a model ran on gated input")

    monkeypatch.setattr(main, "MODELS_LOADED", True)
    monkeypatch.setattr(fingerprint, "fingerprint", fail)
    result, v2 = analyse(np.zeros(10 * FIXTURE_SR, dtype=np.float32), "WAV")
    assert v2["fingerprint"] is None and result["danceability"] is None


# --- loudness and the energy contour -----------------------------------------------------


def test_loudness_is_the_mean_frame_rms(analyse):
    """A chord, five seconds at RMS 0.05 then five at 0.15: mean 0.1, and the contour steps."""
    rms = float(np.sqrt(np.mean(a_major_triad() ** 2)))
    y = np.concatenate(
        [a_major_triad(seconds=5.0, gain=0.05 / rms), a_major_triad(seconds=5.0, gain=0.15 / rms)]
    )
    _, v2 = analyse(y, "WAV")
    assert v2["loudness"]["rmsMean"] == pytest.approx(0.1, abs=0.003)
    contour = v2["energyContour"]
    hop = contour["hopSeconds"]
    assert hop == pytest.approx(2048 / 22050, abs=1e-4)
    assert len(contour["values"]) == int(10.0 / hop)
    values = np.array(contour["values"])
    first, second = values[: int(4.5 / hop)], values[int(5.5 / hop) :]
    assert np.allclose(first, 0.05, rtol=0.1) and np.allclose(second, 0.15, rtol=0.1)


def test_loudness_of_a_click_track_is_not_zero(analyse):
    _, v2 = analyse(click_track(120), "WAV")
    assert v2["loudness"]["rmsMean"] == pytest.approx(0.0112, abs=0.0005)


def test_loudness_ignores_dc(analyse):
    _, plain = analyse(a_major_triad(gain=0.4), "WAV")
    _, offset = analyse((a_major_triad(gain=0.4) + 0.3).astype(np.float32), "WAV")
    assert offset["loudness"]["rmsMean"] == pytest.approx(plain["loudness"]["rmsMean"], rel=1e-3)


def test_louder_input_measures_louder(analyse):
    levels = [analyse(a_major_triad(gain=g), "WAV")[1]["loudness"]["rmsMean"] for g in (0.1, 1)]
    assert levels[1] == pytest.approx(10 * levels[0], rel=0.01)


@pytest.mark.parametrize(
    ("dbfs", "energy"),
    [
        # As before v2: (mean RMS - 0.02) / 0.25, clipped.
        (-10, 1.0),
        (-14, 0.718),
        (-20, 0.32),
        (-24, 0.172),
        (-30, 0.046),
        # Below the old scale's zero (-34 dBFS): the floor, from 0.005 at -86 dBFS (the
        # quietest mean the gate passes) to 0.02 at -34 dBFS.
        (-42, 0.018),
        (-48, 0.016),
        (-86, 0.005),
    ],
)
def test_v1_energy_scale(dbfs, energy):
    assert main.v1_energy(10 ** (dbfs / 20)) == pytest.approx(energy, abs=0.001)


# --- key moments and sections -------------------------------------------------------------

HIT_TIMES = [3.0, 9.0, 15.0, 21.0, 27.0]
HIT_GAINS = [0.15, 0.8, 0.3, 1.0, 0.5]


@pytest.mark.parametrize("fmt", FORMATS)
def test_key_moments_cover_the_window_with_intensities_from_the_signal(analyse, fmt):
    """
    Five hits of different loudness spread over 30 s: an energy peak at each, with intensities
    ordered like the hits, and an onset and a drop. (v1 gave every peak 1.0, every onset 0.8 and
    every harmonic change 0.7, and took the earliest candidates, so nothing came after about
    20 s.)
    """
    _, v2 = analyse(signals.triad_hits(HIT_TIMES, HIT_GAINS), fmt)
    moments = v2["keyMoments"]
    peaks = [m for m in moments if m["type"] == "energy_peak"]
    found = []
    for time in HIT_TIMES:
        near = [m for m in peaks if abs(m["time"] - (time + 0.25)) <= 0.75]
        assert near, (time, moments)
        found.append(near[0]["intensity"])
    assert list(np.argsort(found)) == list(np.argsort(HIT_GAINS)), found
    assert max(found) == pytest.approx(1.0, abs=0.05)
    assert min(found) < 0.3
    for kind in ("onset", "energy_drop"):
        assert len([m for m in moments if m["type"] == kind]) == len(HIT_TIMES), moments
    assert any(m["time"] >= 25 for m in moments)


def test_key_moments_after_twenty_seconds(analyse):
    """A quiet chord, four times louder from 12 s, and a loud noise burst at 25-26 s."""
    y = 0.02 * a_major_triad(seconds=30.0) / 0.25
    y[25 * FIXTURE_SR : 26 * FIXTURE_SR] += 0.8 * np.random.default_rng(1).standard_normal(
        FIXTURE_SR
    )
    y[12 * FIXTURE_SR :] *= 4
    _, v2 = analyse(y.astype(np.float32), "WAV")
    moments = v2["keyMoments"]
    burst = [m for m in moments if 24.5 <= m["time"] <= 26.5]
    assert any(m["type"] == "energy_peak" and m["intensity"] > 0.9 for m in burst), moments
    assert any(m["type"] == "energy_drop" for m in burst), moments
    assert len({m["intensity"] for m in moments}) >= 3


def test_key_moments_are_capped_and_spaced(analyse):
    _, v2 = analyse(signals.drum_pattern(128), "WAV")
    times = [m["time"] for m in v2["keyMoments"]]
    assert 1 <= len(times) <= 16
    assert times == sorted(times)
    for kind in {m["type"] for m in v2["keyMoments"]}:
        same = [m["time"] for m in v2["keyMoments"] if m["type"] == kind]
        assert np.all(np.diff(same) >= 0.5 - 0.011)
    # One per sixth of the window at least, wherever the signal has something.
    assert {int(t // 5) for t in times} == set(range(6))


def moment(time, kind="onset", intensity=0.5):
    return {"time": time, "type": kind, "intensity": intensity, "description": kind}


def test_key_moment_selection_covers_every_sixth_first():
    """Twenty strong onsets in the first 5 s cannot crowd out a weak one in each later sixth."""
    early = [moment(0.1 + 0.24 * i, "energy_drop", 0.9) for i in range(20)]
    early += [moment(0.2 + 0.24 * i, intensity=0.9) for i in range(20)]
    late = [moment(5.5 + 5 * k, "energy_peak", 0.1) for k in range(5)]
    chosen = signal_features._select(early + late, 30.0)
    assert len(chosen) == 16
    peaks = {m["time"] for m in chosen if m["type"] == "energy_peak"}
    assert peaks == {5.5, 10.5, 15.5, 20.5, 25.5}


def test_key_moment_selection_reaches_the_end_of_the_window():
    """Thirty strong onsets in the first half cannot crowd out weak ones in the second."""
    strong = [moment(0.5 * i, intensity=0.9) for i in range(30)]
    weak = [moment(t, intensity=0.1) for t in (17.0, 22.0, 27.0)]
    chosen = signal_features._select(strong + weak, 30.0)
    assert {17.0, 22.0, 27.0} <= {m["time"] for m in chosen}


def test_key_moment_spacing_is_per_type():
    candidates = [moment(10.0), moment(10.3), moment(10.6), moment(10.05, "energy_peak")]
    chosen = signal_features._select(candidates, 30.0)
    assert sorted((m["time"], m["type"]) for m in chosen) == [
        (10.0, "onset"),
        (10.05, "energy_peak"),
        (10.6, "onset"),
    ]


def test_silence_moments_mark_a_gap(analyse):
    """A 1.5 s gap in a band 12 s in: a silence moment there, scored by its length."""
    y = signals.drum_pattern(120).copy()
    y[12 * FIXTURE_SR : int(13.5 * FIXTURE_SR)] = 0
    _, v2 = analyse(y, "WAV")
    gaps = [m for m in v2["keyMoments"] if m["type"] == "silence"]
    assert len(gaps) == 1 and gaps[0]["time"] == pytest.approx(12.0, abs=0.2)
    assert gaps[0]["intensity"] == pytest.approx(0.7, abs=0.1)  # about 1.4 s of 2 s


def test_novelty_measures_chroma_change():
    a, b = np.zeros((12, 8)), np.zeros((12, 8))
    a[0], b[6] = 1, 1  # two disjoint pitch classes
    novelty = signal_features._novelty(np.hstack([a, b]), 4)
    assert novelty[8] == pytest.approx(1.0) and novelty[4] == pytest.approx(0.0)
    same = signal_features._novelty(np.hstack([a, a]), 4)
    assert np.all(same == 0)


def test_sections_follow_the_harmony(analyse):
    """C major, F# major, C major (10 s each, a chord on every beat): sections A, B, A."""
    c, f_sharp = (48, 60, 64, 67), (54, 66, 70, 73)
    _, v2 = analyse(signals.chord_blocks([c, f_sharp, c]), "MP3")
    sections = v2["sections"]
    assert sections["method"] == "novelty-on-beat-chroma"
    assert [s["label"] for s in sections["segments"]] == ["A", "B", "A"]
    starts = [s["start"] for s in sections["segments"]]
    assert starts[0] == 0
    assert starts[1] == pytest.approx(10, abs=1) and starts[2] == pytest.approx(20, abs=1)
    assert sections["segments"][-1]["end"] == pytest.approx(30, abs=0.05)
    changes = [m["time"] for m in v2["keyMoments"] if m["type"] == "harmonic_change"]
    assert any(abs(t - 10) <= 1 for t in changes) and any(abs(t - 20) <= 1 for t in changes)


def test_harmonic_changes_are_between_sections_not_between_beats(analyse):
    """
    C and G alternating on every beat for 10 s, then F# and C#, then C and G again: the change
    is at 10 and 20 s; the beat-to-beat alternation inside a block is not a harmonic change.
    """
    c, g, f_sharp, c_sharp = (48, 60, 64, 67), (43, 55, 59, 62), (54, 66, 70, 73), (49, 61, 65, 68)
    chords = [c, g] * 10 + [f_sharp, c_sharp] * 10 + [c, g] * 10
    y = signals.normalise(np.concatenate([signals.chord_blocks([ch], 0.5) for ch in chords]))
    _, v2 = analyse(y, "WAV")
    changes = [m["time"] for m in v2["keyMoments"] if m["type"] == "harmonic_change"]
    assert changes and all(min(abs(t - 10), abs(t - 20)) <= 1.5 for t in changes), changes
    assert [s["label"] for s in v2["sections"]["segments"]] == ["A", "B", "A"]


def test_similar_sections_share_a_label(analyse):
    """C major, A minor, then C major with a soft D added: A, B, A (cosine below 1)."""
    c, a_minor, c_add9 = (48, 60, 64, 67), (45, 57, 60, 64), (48, 60, 62, 64, 67)
    _, v2 = analyse(signals.chord_blocks([c, a_minor, c_add9]), "WAV")
    assert [s["label"] for s in v2["sections"]["segments"]] == ["A", "B", "A"]


def test_sections_are_at_least_four_seconds(analyse):
    """Chords every 2 s give no 2 s sections."""
    _, v2 = analyse(np.tile(progression(C_MAJOR_PROGRESSION), 2), "WAV")
    segments = v2["sections"]["segments"]
    assert all(s["end"] - s["start"] >= 4.0 - 0.01 for s in segments), segments


@pytest.mark.parametrize(
    "make", [a_major_triad, lambda: a_major_triad() + white_noise(rms=0.05)], ids=["clean", "noisy"]
)
def test_steady_material_is_one_section_without_harmonic_changes(analyse, make):
    _, v2 = analyse(make().astype(np.float32), "WAV")
    assert [s["label"] for s in v2["sections"]["segments"]] == ["A"]
    assert not [m for m in v2["keyMoments"] if m["type"] == "harmonic_change"]


# --- fingerprint, with stand-in models (runs without Essentia) ---------------------------


def stand_in_models(monkeypatch, **overrides):
    """
    Loaded "models" with known outputs: style i scores i/400 and tag i scores i/50, the heads
    give [0.7, 0.3] (danceability), [0.2, 0.8] (acoustic), [0.9, 0.1] (instrumental) and DEAM
    [4.0, 6.0] (valence, arousal).
    """

    def head(values):
        return lambda embeddings: np.tile(values, (len(embeddings), 1)).astype(np.float32)

    models = {
        "effnet": lambda p: (
            np.tile(np.arange(400) / 400, (len(p), 1)),
            np.ones((len(p), 1280), np.float32),
        ),
        "musicnn": lambda p: (
            np.tile(np.arange(50) / 50, (len(p), 1)),
            np.ones((len(p), 200), np.float32),
        ),
        "danceability": head([0.7, 0.3]),
        "acousticness": head([0.2, 0.8]),
        "instrumentalness": head([0.9, 0.1]),
        "valence": head([4.0, 6.0]),
    }
    models.update(overrides)
    monkeypatch.setattr(main, "MODELS_LOADED", True)
    monkeypatch.setattr(fingerprint, "_models", models)
    monkeypatch.setattr(fingerprint, "model_input", lambda native, sr: native)
    monkeypatch.setattr(fingerprint, "mel_frames", lambda audio: np.zeros((1875, 96), np.float32))


def stand_in_fingerprint():
    result, v2 = analyse_array(signals.drum_pattern(97))
    return result, v2["fingerprint"]


def test_fingerprint_maps_outputs_to_labels_columns_and_ranges(monkeypatch):
    stand_in_models(monkeypatch)
    result, fp = stand_in_fingerprint()
    top = fp["styles"]["top"]
    assert [s["label"] for s in top] == [DISCOGS_STYLES[399 - i] for i in range(10)]
    assert top[0]["score"] == pytest.approx(399 / 400, abs=1e-4)
    assert [s["label"] for s in fp["tags"]["scores"]] == [MSD_TAGS[49 - i] for i in range(50)]
    moods = {name: score["value"] for name, score in fp["moods"].items()}
    assert moods == {
        "danceability": 0.7,
        "acoustic": 0.2,
        "instrumental": 0.9,
        "valence": 4.0,
        "arousal": 6.0,
    }
    assert fp["moods"]["valence"]["range"] == [1.0, 9.0]
    assert fp["moods"]["arousal"]["model"]["id"] == "deam-msd-musicnn-2"
    assert fp["moods"]["acoustic"]["model"]["id"] == "mood_acoustic-discogs-effnet-1"
    assert result["valence"] == pytest.approx(0.375) and result["danceability"] == 0.7


def nan_head(embeddings):
    return np.full((len(embeddings), 2), np.nan, np.float32)


def raises(*args):
    raise RuntimeError("model failed")


@pytest.mark.parametrize(
    ("overrides", "missing"),
    [
        ({"danceability": nan_head}, {"danceability"}),
        ({"valence": lambda e: np.full((len(e), 2), np.inf)}, {"valence", "arousal"}),
        ({"valence": lambda e: np.tile([9.5, 5.0], (len(e), 1))}, {"valence"}),
        ({"valence": raises}, {"valence", "arousal"}),
        ({"acousticness": raises}, {"acoustic"}),
        ({"danceability": lambda e: np.zeros((len(e), 1))}, {"danceability"}),
        (
            {"effnet": lambda p: (np.full((len(p), 400), np.nan), np.ones((len(p), 1280)))},
            {"styles"},
        ),
        ({"musicnn": lambda p: (np.zeros((len(p), 49)), np.ones((len(p), 200)))}, {"tags"}),
        (
            {"effnet": lambda p: (np.zeros((len(p), 400)), np.full((len(p), 1280), np.nan))},
            {"acoustic"},
        ),
        ({"musicnn": raises}, {"tags", "danceability", "instrumental", "valence", "arousal"}),
        ({"effnet": raises}, {"styles", "acoustic"}),
    ],
    ids=[
        "head-nan",
        "deam-inf",
        "deam-out-of-range",
        "deam-raises",
        "acoustic-raises",
        "head-one-column",
        "styles-nan",
        "tags-49-columns",
        "effnet-embeddings-nan",
        "musicnn-raises",
        "effnet-raises",
    ],
)
def test_a_failing_model_part_is_null_on_its_own(monkeypatch, overrides, missing):
    """Failures, non-finite or out-of-range values and wrong widths null only that part."""
    stand_in_models(monkeypatch, **overrides)
    result, fp = stand_in_fingerprint()
    parts = {"styles": fp["styles"], "tags": fp["tags"], **fp["moods"]}
    assert {name for name, part in parts.items() if part is None} == missing
    if "valence" in missing:
        assert result["valence"] is None


@pytest.mark.parametrize(
    "make",
    [
        lambda: tones((440.0,)),
        lambda: PROBES["hum-50Hz-gentle"],
        lambda: PROBES["A4-vibrato-80c"],
        lambda: music.held(music.hz(31)),
        lambda: music.speech(4),
    ],
    ids=["test-tone", "hum", "vibrato-note", "G1-vibrato-note", "speech"],
)
def test_no_fingerprint_for_input_that_is_not_music(monkeypatch, make):
    """
    A tone, hum, one held note or speech with no beat: no styles, tags or moods (and no v1
    moods).
    """
    stand_in_models(monkeypatch)
    result, v2 = analyse_array(make())
    assert v2["gate"]["passed"]
    assert v2["fingerprint"] is None
    assert (result["danceability"], result["valence"]) == (None, None)


@pytest.mark.parametrize(
    "make",
    [
        music.ambient_pad,
        music.melody_over_drone,
        music.trumpet_melody,
        lambda: music.sung(9, "major", 57, 72, 31, 70.0),
        lambda: music.band_mix("C-G-Am-F", False),
    ],
    ids=["pad-root-in-bass", "melody-over-drone", "trumpet", "a-cappella-vibrato", "band"],
)
def test_music_without_a_beat_has_a_fingerprint(monkeypatch, make):
    stand_in_models(monkeypatch)
    result, v2 = analyse_array(make())
    assert v2["gate"]["passed"] and v2["tempo"] is None
    assert v2["fingerprint"] is not None and result["danceability"] == 0.7


@pytest.mark.skipif(not os.path.exists(SPEECH), reason="no speech recording on this machine")
def test_no_fingerprint_for_speech(monkeypatch):
    stand_in_models(monkeypatch)
    y, sr = sf.read(SPEECH, dtype="float32")
    result = main.analyze_signals(estimators.Signals(y if y.ndim == 1 else y.mean(axis=1), sr))
    assert check_result(result)["fingerprint"] is None and result["danceability"] is None


def test_a_drone_with_a_beat_is_music(monkeypatch):
    """One held pitch over drums: no key (one pitch), but music, so it has a fingerprint."""
    stand_in_models(monkeypatch)
    result, v2 = analyse_array(PROBES["drone-with-drums"])
    assert v2["key"] is None and v2["tempo"]["bpm"] == pytest.approx(120, abs=1)
    assert v2["fingerprint"] is not None and result["danceability"] == 0.7


def test_no_moods_when_the_strongest_style_is_not_music(monkeypatch):
    spoken = DISCOGS_STYLES.index("Non-Music---Spoken Word")
    scores = np.zeros(400)
    scores[spoken] = 0.9
    stand_in_models(
        monkeypatch,
        effnet=lambda p: (np.tile(scores, (len(p), 1)), np.ones((len(p), 1280), np.float32)),
    )
    result, fp = stand_in_fingerprint()
    assert fp["styles"]["top"][0]["label"] == "Non-Music---Spoken Word"
    assert all(score is None for score in fp["moods"].values())
    assert result["danceability"] is None and result["valence"] is None


def test_no_fingerprint_when_no_model_part_works(monkeypatch):
    stand_in_models(monkeypatch, effnet=raises, musicnn=raises)
    result, fp = stand_in_fingerprint()
    assert fp is None and result["danceability"] is None


def test_a_non_finite_head_is_not_a_server_error(monkeypatch, tmp_path):
    stand_in_models(monkeypatch, danceability=nan_head, valence=lambda e: np.full((len(e), 2), 1e9))
    path = tmp_path / "band.wav"
    sf.write(path, signals.drum_pattern(97), FIXTURE_SR)

    async def fake_download(url):
        return str(path)

    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(main, "download_preview", fake_download)
    with TestClient(main.app) as client:
        response = client.post("/analyze", json={"preview_url": "https://p.scdn.co/a.mp3"})
    assert response.status_code == 200, response.text
    body = response.json()
    check_result(body)
    assert body["danceability"] is None and body["valence"] is None


def test_model_label_counts():
    assert len(DISCOGS_STYLES) == 400 and len(set(DISCOGS_STYLES)) == 400
    assert len(MSD_TAGS) == 50 and len(set(MSD_TAGS)) == 50
    assert DISCOGS_STYLES[0] == "Blues---Boogie Woogie" and MSD_TAGS[:2] == ("rock", "pop")


def test_no_fingerprint_without_models(monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", False)
    result, v2 = analyse_array(signals.drum_pattern(97))
    assert v2["gate"]["passed"]
    assert v2["fingerprint"] is None
    assert v2["analyzerVersion"] == f"2.2.0+{main.ESTIMATOR.name}"
    assert result["valence"] is None and result["danceability"] is None


def test_valence_mapping_is_continuous():
    """DEAM valence (1-9) maps linearly onto v1's 0-1; the old mapping jumped at 1.5."""

    def v1_valence(raw):
        v2 = {
            "tempo": None,
            "key": None,
            "loudness": None,
            "keyMoments": [],
            "window": {"durationSeconds": 30},
            "fingerprint": {"moods": {"valence": {"value": raw}}},
        }
        return main.v1_fields(v2)["valence"]

    assert v1_valence(1.49) == pytest.approx(v1_valence(1.51), abs=0.01)
    assert (v1_valence(1.0), v1_valence(5.0), v1_valence(9.0)) == (0.0, 0.5, 1.0)


# --- fingerprint, with the real models ----------------------------------------------------

# Essentia algorithms the reference tests create stay alive: deleting the most recently
# created Essentia network makes every composite algorithm used afterwards (the service's
# RhythmExtractor2013 and KeyExtractor) log "No network created" for every frame. The service
# never deletes one (estimators._essentia_algorithm keeps them per thread).
_REFERENCE_ALGORITHMS = []


def reference(algorithm):
    _REFERENCE_ALGORITHMS.append(algorithm)
    return algorithm


@needs_models
def test_backbones_give_what_the_essentia_predictors_give():
    """One session per backbone, two outputs: identical to two TensorflowPredict* runs."""
    import essentia.standard as es

    from download_models import models_dir

    audio = fingerprint.model_input(signals.drum_pattern(97), FIXTURE_SR)
    mel = fingerprint.mel_frames(audio)
    styles, effnet = fingerprint._models["effnet"](fingerprint.patches(mel, 128, 62))
    tags, musicnn = fingerprint._models["musicnn"](fingerprint.patches(mel, 187, 93))
    directory = models_dir()
    for output, ours in [("PartitionedCall:0", styles), ("PartitionedCall:1", effnet)]:
        expected = reference(
            es.TensorflowPredictEffnetDiscogs(
                graphFilename=f"{directory}/discogs-effnet-bs64-1.pb", output=output
            )
        )(audio)
        assert np.max(np.abs(np.squeeze(expected) - ours)) < 1e-5
    for output, ours in [("model/Sigmoid", tags), ("model/dense/BiasAdd", musicnn)]:
        expected = reference(
            es.TensorflowPredictMusiCNN(
                graphFilename=f"{directory}/msd-musicnn-1.pb", output=output
            )
        )(audio)
        assert np.max(np.abs(np.squeeze(expected) - ours)) < 1e-5


@needs_models
@pytest.mark.parametrize("fmt", FORMATS)
def test_moods_match_the_mtg_reference_pipeline(fmt, tmp_path):
    """
    MonoLoader(sampleRate=16000, resampleQuality=4) and the Essentia predictors, as the service
    ran them before (origin/main): the same moods, columns and valence/arousal order.
    """
    import essentia.standard as es

    from download_models import models_dir

    path = tmp_path / f"piano.{fmt.lower()}"
    sf.write(path, signals.piano_line(), FIXTURE_SR, format=fmt)
    result = main.analyze_audio_file(str(path))
    moods = check_result(result)["fingerprint"]["moods"]
    d = models_dir()
    audio = reference(es.MonoLoader(filename=str(path), sampleRate=16000, resampleQuality=4))()
    musicnn = reference(
        es.TensorflowPredictMusiCNN(
            graphFilename=f"{d}/msd-musicnn-1.pb", output="model/dense/BiasAdd"
        )
    )(audio)
    effnet = reference(
        es.TensorflowPredictEffnetDiscogs(
            graphFilename=f"{d}/discogs-effnet-bs64-1.pb", output="PartitionedCall:1"
        )
    )(audio)

    def mean(graph, output, embeddings, column):
        head = reference(es.TensorflowPredict2D(graphFilename=f"{d}/{graph}", output=output))
        return float(np.mean(head(embeddings)[:, column]))

    expected = {
        "danceability": mean("danceability-msd-musicnn-1.pb", "model/Softmax", musicnn, 0),
        "instrumental": mean("voice_instrumental-msd-musicnn-1.pb", "model/Softmax", musicnn, 0),
        "acoustic": mean("mood_acoustic-discogs-effnet-1.pb", "model/Softmax", effnet, 0),
        "valence": mean("deam-msd-musicnn-2.pb", "model/Identity", musicnn, 0),
        "arousal": mean("deam-msd-musicnn-2.pb", "model/Identity", musicnn, 1),
    }
    for name, value in expected.items():
        assert moods[name]["value"] == pytest.approx(value, abs=0.002), name
    assert result["instrumentalness"] == pytest.approx(expected["instrumental"], abs=0.002)
    assert result["danceability"] == pytest.approx(expected["danceability"], abs=0.002)


@needs_models
@pytest.mark.parametrize("fmt", FORMATS)
def test_fingerprint_with_the_models(analyse, fmt):
    _, v2 = analyse(signals.drum_pattern(97), fmt)
    fp = v2["fingerprint"]
    assert fp is not None
    styles = fp["styles"]
    assert styles["model"] == {"id": "discogs-effnet-bs64-1", "licence": "CC BY-NC-SA 4.0"}
    assert len(styles["top"]) == 10
    scores = [s["score"] for s in styles["top"]]
    assert scores == sorted(scores, reverse=True) and 0 < scores[0] <= 1
    tags = fp["tags"]
    assert tags["model"]["id"] == "msd-musicnn-1"
    assert sorted(s["label"] for s in tags["scores"]) == sorted(MSD_TAGS)
    for name, score in fp["moods"].items():
        assert score is not None, name
        assert score["basis"] == "model" and score["model"]["licence"] == "CC BY-NC-SA 4.0"
    assert v2["analyzerVersion"] == main.analyzer_version()


@needs_models
def test_models_after_essentia_estimators_do_not_flood_the_log(analyse, capfd):
    """Essentia logs "No network created" per frame once the newest Essentia network is gone."""
    for _ in range(2):
        analyse(signals.drum_pattern(97), "WAV")
    assert "No network created" not in capfd.readouterr().err

"""
AudioFeatures v2 (the `v2` block of /analyze) on generated audio, through the real analysis.

Every result is checked by tests/checks.py: the v2 block validates against the contract's
JSON Schema after a strict JSON round trip, and every value it leaves null has its reason in
`withheld` (and no measured value has one).

Tempo and key tests run with both estimators; the Essentia cases are skipped (and reported as
skipped) without the "models" extra. Tests marked `needs_models` run the real Essentia models
and are skipped without them; the fingerprint logic is also covered with stand-in models.
"""

import json
import os
import re
import subprocess
import sys
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
    assert list(body) == ["v2"]  # the v1 fields are gone (tests/test_v1_removed.py)
    assert v2["analyzerVersion"] == health["analyzer_version"]
    assert not path.exists()


SEMVER = re.compile(
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


def test_analyzer_version_is_short_semver_naming_estimator_and_models(monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", False)
    assert main.analyzer_version("librosa") == "2.3.4+librosa"
    assert main.analyzer_version("essentia") == "2.3.4+essentia"
    monkeypatch.setattr(main, "MODELS_LOADED", True)
    with_models = main.analyzer_version("essentia")
    assert with_models == f"2.3.4+essentia.models-{fingerprint.model_set_tag()}"
    assert SEMVER.fullmatch(with_models) and len(with_models) <= 40
    assert re.fullmatch(r"[0-9a-f]{8}", fingerprint.model_set_tag())
    # The tag changes with any pinned model checksum.
    first = fingerprint.MODELS[0]
    changed = (first.__class__(first.name, first.filename, first.url, "0" * 64, ""),)
    monkeypatch.setattr(fingerprint, "MODELS", changed + fingerprint.MODELS[1:])
    assert fingerprint.model_set_tag() != with_models.rsplit("-", 1)[1]


def test_results_carry_the_estimator_that_measured_them():
    result, _ = analyse_array(a_major_triad(), "librosa")
    assert result["v2"]["analyzerVersion"].startswith("2.3.4+librosa")


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
    assert round(tempo["bpm"]) == bpm and "tempo" not in v2["withheld"]


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
    assert v2["tempo"] is None and v2["withheld"]["tempo"]["code"] == "unsteady_tempo"
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
    assert round(v2["tempo"]["bpm"]) == bpm


def sound_within(y: np.ndarray, t: float, reach: float) -> bool:
    """Whether any sample of `y` within `reach` seconds of `t` is not zero."""
    lo = max(0, round((t - reach) * FIXTURE_SR))
    return bool(np.any(y[lo : max(lo, round((t + reach) * FIXTURE_SR) + 1)]))


def tracked_beats(y: np.ndarray, estimator: str) -> list[float]:
    """Every beat the estimator tracked, in the window and rounded as the service reports them."""
    found = estimators.select_estimator(estimator).measure_tempo(estimators.Signals(y, FIXTURE_SR))
    assert isinstance(found, estimators.TempoEstimate)
    beats = np.sort(np.clip(np.asarray(found.beats, dtype=float), 0.0, y.size / FIXTURE_SR))
    return [round(float(t), 3) for t in beats]


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_no_beats_are_reported_in_digital_silence(estimator):
    """
    The band enters at 10 s, after digital silence. Essentia's tracker counts through the
    silence (23 of its 55 beats, the first at 0.348 s); only the beats on the band are
    reported, and the tempo, fitted to the beats on onsets, stays 97 BPM.
    """
    y = PROBES["band-97-after-10s-silence"]
    tracked = tracked_beats(y, estimator)
    _, v2 = analyse_array(y, estimator)
    reported = v2["beats"]["times"]
    # The rule, with 1 ms either way for the rounding of the reported times: a beat with no
    # sample of the band within 51 ms is left out, one with the band within 49 ms is kept.
    reach = 0.05
    assert all(sound_within(y, t, reach + 0.001) for t in reported)
    assert [t for t in tracked if sound_within(y, t, reach - 0.001)] == [
        t for t in reported if sound_within(y, t, reach - 0.001)
    ]
    assert len(reported) >= 30
    assert round(v2["tempo"]["bpm"]) == 97


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize(
    "probe",
    ["band-97", "brown-noise-with-kick", "drums-crash-jitter-15ms", "drums-crash-jitter-25ms"],
)
def test_every_beat_is_reported_without_silence(probe, estimator):
    """
    With sound throughout, the reported grid is every beat tracked, as before. (Brown noise
    with a kick 6 dB under it holds the quietest beats of the probes, 26 dB under the loudest
    frame; the drum take with 15 ms of jitter starts and ends with a beat off the onsets, which
    stays.)
    """
    tracked = tracked_beats(PROBES[probe], estimator)
    _, v2 = analyse_array(PROBES[probe], estimator)
    assert v2["beats"]["times"] == tracked


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_beats_in_a_silent_gap_are_left_out(estimator):
    """
    2.5 s of digital silence inside a band (12-14.5 s): both trackers keep counting through it
    (four beats); only those are left out, and the tempo is still reported.
    """
    y = signals.drum_pattern(97).copy()
    y[12 * FIXTURE_SR : int(14.5 * FIXTURE_SR)] = 0
    tracked = tracked_beats(y, estimator)
    _, v2 = analyse_array(y, estimator)
    in_gap = [t for t in tracked if 12.0 < t < 14.5]
    assert len(in_gap) == 4
    assert v2["beats"]["times"] == [t for t in tracked if t not in in_gap]
    assert round(v2["tempo"]["bpm"]) == 97


def test_beats_over_silence_or_a_dc_offset_are_left_out_for_any_tracker():
    """
    The rule is the service's, not an estimator's: whatever tracked the beats, those over 2 s
    of digital silence or of a DC offset are not reported. The beats at the edges of those
    stretches still have sound within BEAT_LEVEL_WINDOW_S and are kept.
    """
    y = a_major_triad()
    y[3 * FIXTURE_SR : 5 * FIXTURE_SR] = 0.0
    y[6 * FIXTURE_SR : 8 * FIXTURE_SR] = 0.5
    beats = np.arange(0.0, 10.0, 0.5)
    estimate = estimators.TempoEstimate(120.0, 0.9, None, beats, "fake", steady=True)
    result = main.analyze_signals(estimators.Signals(y, FIXTURE_SR), FakeEstimator(tempo=estimate))
    v2 = check_result(result)
    left_out = [3.5, 4.0, 4.5, 6.5, 7.0, 7.5]
    assert v2["beats"]["times"] == [float(b) for b in beats if b not in left_out]
    assert v2["tempo"]["bpm"] == 120.0


def reported_over(y: np.ndarray, beats) -> list[float]:
    """The beat grid the service reports when a tracker gives `beats` over `y`."""
    beats = np.asarray(beats, dtype=float)
    estimate = estimators.TempoEstimate(120.0, 0.9, None, beats, "fake", steady=True)
    result = main.analyze_signals(estimators.Signals(y, FIXTURE_SR), FakeEstimator(tempo=estimate))
    return check_result(result)["beats"]["times"]


def to_16_bit(y: np.ndarray, seed: int = 3) -> np.ndarray:
    """
    `y` with TPDF dither (two uniform draws of half a bit each), rounded to 16 bits, as a
    16-bit master holds it. Where `y` is 0 the dither rounds to 0 or one bit: 1.53e-5 RMS
    (-96.3 dBFS), 1.43e-5 to 1.62e-5 in the beat windows of 30 s of it.
    """
    rng = np.random.default_rng(seed)
    dither = rng.uniform(-0.5, 0.5, y.size) + rng.uniform(-0.5, 0.5, y.size)
    return np.round(y * 32768 + dither) / 32768


@pytest.mark.parametrize(("noise_db", "kept"), [(-55.0, True), (-65.0, False)])
def test_beats_over_noise_count_from_60_db_under_the_loudest_frame(noise_db, kept):
    """
    5 s of white noise, then a triad: the beats over the noise are reported when it is 55 dB
    under the triad's frames and left out when it is 65 dB under (BEAT_BELOW_PEAK_DB is 60;
    both noises are far above the absolute floor).
    """
    triad = a_major_triad()
    peak = float(signal_features.levels(estimators.Signals(triad, FIXTURE_SR)).frames.max())
    noise = np.random.default_rng(5).standard_normal(5 * FIXTURE_SR)
    noise *= peak * 10 ** (noise_db / 20) / np.sqrt(np.mean(noise**2))
    assert peak * 10 ** (noise_db / 20) > 1e-4
    y = triad.copy()
    y[: 5 * FIXTURE_SR] = noise
    over_noise = [0.5, 1.5, 2.5, 3.5, 4.5]
    # One grid throughout. With the triad's beats at 6, 7, 8 and 9 s (as before 2.3.3) their
    # fate would depend on the noise's level, which is not what this test is about: with the
    # noise 55 dB under the triad, its beats count as on onsets and the triad's do not, so the
    # triad's form a trailing run 10 % off the noise's grid and are left out
    # (beats_on_the_grid); at 65 dB under, all nine count as on onsets (onset support is
    # relative to the clip's own beats) and stay.
    over_triad = [5.5, 6.5, 7.5, 8.5, 9.5]
    reported = reported_over(y, [*over_noise, *over_triad])
    assert reported == [*(over_noise if kept else []), *over_triad]


def test_the_beat_window_reaches_50_ms_on_each_side():
    """
    A triad with 3 s of digital silence (3-6 s): a beat 35 ms into the silence still has sound
    within 50 ms and is kept, ones 60 and 100 ms into it are not. (A window of 30 ms would drop
    the first, one of more than 60 ms keep the second.)
    """
    y = a_major_triad()
    y[3 * FIXTURE_SR : 6 * FIXTURE_SR] = 0.0
    beats = [1.0, 2.0, 3.035, 3.06, 3.1, 4.5, 5.9, 5.94, 5.965, 7.0, 8.0]
    assert reported_over(y, beats) == [1.0, 2.0, 3.035, 5.965, 7.0, 8.0]


def test_beats_over_dither_are_left_out_of_a_quiet_clip():
    """
    A triad peaking at -36 dBFS, with 16-bit dither throughout and nothing else from 3 to 6 s.
    Its loudest frame is -43.6 dBFS, so 60 dB under it is below the dither: the absolute
    floor (BEAT_MIN_RMS) leaves the beats over the dither out.
    """
    y = a_major_triad()
    y = y / np.max(np.abs(y)) * 10 ** (-36 / 20)
    y[3 * FIXTURE_SR : 6 * FIXTURE_SR] = 0.0
    y = to_16_bit(y)
    beats = np.arange(0.5, 10.0, 0.5)
    assert reported_over(y, beats) == [float(b) for b in beats if not 3.0 < b < 6.0]


def test_a_quiet_beat_over_sound_is_kept_on_a_quiet_clip():
    """
    A triad at 7e-5 RMS (-83 dBFS) for 5 s, then at -40 dBFS: 60 dB under the loudest frame
    is 1e-5, so the absolute floor decides, and the quiet triad is 7 dB over it. The quietest
    beat kept on the real clips measured is 5.8e-4 (-64.8 dBFS); a floor of 1e-4 or more would
    drop this one.
    """
    triad = a_major_triad()
    triad = triad / float(
        signal_features.levels(estimators.Signals(triad, FIXTURE_SR)).frames.max()
    )
    y = 1e-2 * triad
    y[: 5 * FIXTURE_SR] *= 7e-5 / 1e-2
    quiet = [0.5, 1.5, 2.5, 3.5, 4.5]
    reach = round(0.05 * FIXTURE_SR)
    levels = [np.sqrt(np.mean(y[round(t * FIXTURE_SR) - reach :][: 2 * reach] ** 2)) for t in quiet]
    assert all(6e-5 < level < 8e-5 for level in levels), levels
    assert reported_over(y, [*quiet, 6.0, 7.0, 8.0, 9.0]) == [*quiet, 6.0, 7.0, 8.0, 9.0]


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_no_beats_over_dithered_silence_before_a_quiet_band(estimator):
    """
    The band enters at 10 s after silence, the clip peaks at -36 dBFS (loudest frame -45.5
    dBFS) and is rounded to 16 bits with dither. Essentia counted every beat over the dither
    (48 of 48 with float dither 53 dB under the loudest frame) before the absolute floor.
    """
    y = signals.drum_pattern(97).copy()
    y[: 10 * FIXTURE_SR] = 0.0
    y = to_16_bit(y / np.max(np.abs(y)) * 10 ** (-36 / 20))
    tracked = tracked_beats(y, estimator)
    _, v2 = analyse_array(y, estimator)
    assert min(v2["beats"]["times"]) >= 10.0
    assert v2["beats"]["times"] == [t for t in tracked if t >= 10.0]


PAD_INTROS = [("band-97-after-10s-pad", 10.0), ("band-132-after-12s-pad", 12.0)]


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize(("probe", "start"), PAD_INTROS, ids=[p for p, _ in PAD_INTROS])
def test_no_beats_are_reported_under_a_pad_before_the_band(probe, start, estimator):
    """
    A pad, then the band: Essentia counts 15 beats under the pad before the 97 BPM band and 23
    before the 132 BPM one, none on an onset and 6.8 and 12.8 % off the band's spacing. Only
    the band's beats are reported, all of them, and the tempo is unchanged.
    """
    y = PROBES[probe]
    tracked = tracked_beats(y, estimator)
    _, v2 = analyse_array(y, estimator)
    assert v2["beats"]["times"] == [t for t in tracked if t >= start]
    assert round(v2["tempo"]["bpm"]) == round(float(probe.split("-")[1]))


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_a_quiet_intro_with_a_beat_keeps_its_beats(estimator):
    """
    The band 30 dB down for its first 10 s: every beat Essentia tracks there is on an onset
    and stays. (librosa's tracker leaves weak beats at the ends out itself.)
    """
    y = signals.drum_pattern(97).copy()
    y[: 10 * FIXTURE_SR] *= 10 ** (-30 / 20)
    tracked = tracked_beats(y, estimator)
    _, v2 = analyse_array(y, estimator)
    assert v2["beats"]["times"] == tracked
    if estimator == "essentia":
        assert sum(t < 10.0 for t in tracked) >= 14


def pad_then_band(intro_s: float = 6.0, outro_s: float = 0.0) -> np.ndarray:
    """A 120 BPM band with a pad (no onsets) for its first `intro_s` and last `outro_s` seconds."""
    y = signals.drum_pattern(120)
    chord = [signals.hz(62), signals.hz(66), signals.hz(69)]
    for lo, hi in ((0.0, intro_s), (30.0 - outro_s, 30.0)):
        if hi > lo:
            a, b = round(lo * FIXTURE_SR), round(hi * FIXTURE_SR)
            y[a:b] = 0.3 * signals.normalise(signals.pad(chord, (b - a) / FIXTURE_SR))[: b - a]
    return y


@pytest.mark.parametrize(
    ("count", "off", "kept"),
    [
        (6, 0.035, True),
        (6, 0.045, False),
        (6, -0.035, True),
        (6, -0.045, False),
        (3, 0.1, True),
        (4, 0.1, False),
    ],
)
def test_a_run_off_onsets_and_off_the_grid_at_the_start_is_left_out(count, off, kept):
    """
    A tracker's beats under a 6 s pad before a 120 BPM band, `off` from the band's spacing
    (slower or faster): a run of four or more is left out when it is more than 4 % off
    (EDGE_RUN_TOLERANCE, EDGE_RUN_MIN_BEATS); a run within 4 %, or a shorter one, stays.
    """
    band = list(np.arange(6.0, 30.0, 0.5))
    intro = [6.0 - k * 0.5 * (1 + off) for k in range(count, 0, -1)]
    reported = reported_over(pad_then_band(), [*intro, *band])
    assert reported == [round(t, 3) for t in ([*intro, *band] if kept else band)]


@pytest.mark.parametrize(
    ("off", "kept"), [(0.035, True), (0.045, False), (-0.035, True), (-0.045, False)]
)
def test_a_run_off_onsets_and_off_the_grid_at_the_end_is_left_out(off, kept):
    """
    The same at the end: six beats under a pad after the band, `off` from its spacing. (The
    pad's entry at 24 s is an onset, so the run starts one period after it.)
    """
    band = list(np.arange(0.0, 24.0, 0.5))
    outro = [23.5 + k * 0.5 * (1 + off) for k in range(2, 8)]
    reported = reported_over(pad_then_band(0.0, 6.0), [*band, *outro])
    assert reported == [round(t, 3) for t in ([*band, *outro] if kept else band)]


@pytest.mark.parametrize(("pad_end", "kept"), [(26.0, True), (26.5, False)])
def test_only_beats_with_sound_count_toward_the_minimum_run(pad_end, kept):
    """
    Five ticks 10 % slow after the band, over a pad until `pad_end` and digital silence after
    it. The ticks over silence are not reported and do not count toward EDGE_RUN_MIN_BEATS:
    with three ticks over the pad the run is too short to judge and those three stay, with
    four it is judged and left out. (The pad's entry at 24 s is an onset, so the ticks start
    one period after it.)
    """
    y = pad_then_band(0.0, 6.0)
    y[round(pad_end * FIXTURE_SR) :] = 0.0
    band = list(np.arange(0.0, 24.0, 0.5))
    outro = [23.5 + k * 0.55 for k in range(2, 7)]
    audible = [t for t in outro if t + 0.05 < pad_end]
    reported = reported_over(y, [*band, *outro])
    assert reported == [round(float(t), 3) for t in [*band, *(audible if kept else [])]]


def test_a_run_on_the_spacing_but_off_the_beat_is_left_out():
    """
    Six beats under the pad at the band's spacing, but 35 % of a period early against its
    first beat: the interval to that beat is part of the run's spacing (5.8 % off), so the run
    is left out. (It is also off the grid's phase.)
    """
    band = list(np.arange(6.0, 30.0, 0.5))
    intro = [6.0 - 0.5 * 1.35 - 0.5 * k for k in range(5, -1, -1)]
    assert reported_over(pad_then_band(), [*intro, *band]) == [round(t, 3) for t in band]


@pytest.mark.parametrize(
    ("phase", "kept"),
    [(0.0, True), (0.2, True), (0.23, True), (0.27, False), (0.3, False), (0.45, False)],
)
def test_a_long_run_on_the_spacing_is_left_out_off_the_grid_phase(phase, kept):
    """
    Fourteen beats under an 8 s pad at the band's spacing, `phase` of a period early against
    its grid. Spread over the run, the phase leaves its spacing within EDGE_RUN_TOLERANCE (3.2 %
    off at 45 %), so the run is judged on its phase too: its beats are more than
    EDGE_RUN_PHASE_TOLERANCE (a quarter of a period) from the grid counted back from the band's
    first beat, and it is left out; at 0 to 23 % of a period it stays.
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    intro = [8.0 - 0.5 * (1 + phase) - 0.5 * k for k in range(13, -1, -1)]
    reported = reported_over(pad_then_band(8.0), [*intro, *band])
    assert reported == [round(float(t), 3) for t in ([*intro, *band] if kept else band)]


def add_click(y: np.ndarray, t: float, amplitude: float) -> np.ndarray:
    """`y` with a 10 ms burst of noise (2 ms decay) at `t`: a stray click, a breath."""
    y = y.copy()
    n = round(0.01 * FIXTURE_SR)
    burst = np.random.default_rng(round(t * 1000)).standard_normal(n)
    a = round(t * FIXTURE_SR)
    y[a : a + n] += amplitude * burst * np.exp(-np.arange(n) / (0.002 * FIXTURE_SR))
    return y


@pytest.mark.parametrize("beat", [4, 7, 10])
def test_one_click_under_an_intro_beat_does_not_bring_its_run_back(beat):
    """
    Fourteen beats 10 % slow under an 8 s pad before a 120 BPM band, with one click under the
    pad's `beat`th beat. That beat is on an onset, but the measured grid starts at the first
    two beats on onsets in a row (the band's), so the whole run is judged and left out.
    (Before 2.3.4 the grid started at the click: the beats from it to the band were reported.)
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    intro = [8.0 - 0.55 * k for k in range(14, 0, -1)]
    y = add_click(pad_then_band(8.0), intro[beat - 1], 0.3)
    assert reported_over(y, [*intro, *band]) == [round(float(t), 3) for t in band]


@pytest.mark.parametrize("beat", [2, 5, 8])
def test_one_click_under_an_outro_beat_does_not_bring_its_run_back(beat):
    """
    The same at the end: ten beats 10 % slow under a pad after the band, with one click under
    the pad's `beat`th beat; the measured grid ends with the band's last beats on onsets. A
    click on the second beat makes the beats around the band's last one on, off and on onsets,
    which is not the alternation that would carry the grid on. (The pad's entry at 24 s is an
    onset, so the run starts one period after it.)
    """
    band = list(np.arange(0.0, 24.0, 0.5))
    outro = [23.5 + k * 0.55 for k in range(2, 12)]
    y = add_click(pad_then_band(0.0, 6.0), outro[beat - 1], 0.3)
    assert reported_over(y, [*band, *outro]) == [round(float(t), 3) for t in band]


def test_the_ticks_before_an_onset_in_a_run_are_judged_on_the_grid_spacing():
    """
    Twelve ticks under a pad before a 120 BPM band at 8 s that come closer to its tempo: four
    6.5 % slow, then eight 2.5 % slow, with a click under the first of those eight. The run as
    a whole, and its part from the click on, are within the tolerances (3.8 and 2.5 % off the
    grid's spacing). The four ticks before the click are judged on their own against the
    grid's spacing, from its beats on onsets, and none of them is reported; every beat of the
    band is. (Against the spacing of the beats from the click on, mostly the ticks' own, they
    are 3.9 % off and would stay. The eight ticks from the click on stay: a run that close to
    the grid is a known limit.)
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    near = [8.0 - 0.5 * 1.025 * k for k in range(8, 0, -1)]
    slow = [near[0] - 0.5 * 1.065 * k for k in range(4, 0, -1)]
    y = add_click(pad_then_band(8.0), near[0], 0.3)
    reported = reported_over(y, [*slow, *near, *band])
    assert not [t for t in reported if t < round(near[0], 3)]
    assert set(round(float(t), 3) for t in band) <= set(reported)


def test_a_run_whose_drift_turns_around_an_onset_is_left_out():
    """
    Sixteen ticks under a pad before a 120 BPM band at 10 s: ten 3 % fast, then six 5 % slow
    from a click on. The drifts cancel, so the run as a whole is on the grid (0 % off its
    spacing, a median 0.15 of a period off its phase), but its part from the click on is 5 %
    off on its own: the whole run is left out, the ticks before the click with it (on their
    own they are only 3 % off). Only the band is reported.
    """
    band = list(np.arange(10.0, 30.0, 0.5))
    near = [10.0 - 0.5 * 1.05 * k for k in range(6, 0, -1)]
    far = [near[0] - 0.5 * 0.97 * k for k in range(10, 0, -1)]
    y = add_click(pad_then_band(10.0), near[0], 0.3)
    reported = reported_over(y, [*far, *near, *band])
    assert reported == [round(float(t), 3) for t in band]


@pytest.mark.parametrize("beat", [8, 12])
def test_one_click_under_a_near_tempo_intro_tick_does_not_bring_its_run_back(beat):
    """
    Fifteen ticks 3.5 % slow under a 10 s pad before a 120 BPM band (within EDGE_RUN_TOLERANCE
    of its spacing, a median 0.28 of a period off its phase), with one click under the pad's
    `beat`th tick. The ticks from the click on come close to the grid, but the run is judged
    whole and left out. (Judging the part from the click on its own reported all 15.)
    """
    band = list(np.arange(10.0, 30.0, 0.5))
    intro = [10.0 - 0.5175 * k for k in range(15, 0, -1)]
    y = add_click(pad_then_band(10.0), intro[beat - 1], 0.3)
    assert reported_over(y, [*intro, *band]) == [round(float(t), 3) for t in band]


@pytest.mark.parametrize("beat", [8, 12])
def test_one_click_under_a_near_tempo_outro_tick_does_not_bring_its_run_back(beat):
    """
    The same at the end: fifteen ticks 3.5 % slow under a pad after the band, with one click
    under the `beat`th tick counted back from the last. (The pad's entry at 20 s is an onset,
    so the run starts one period after it.)
    """
    band = list(np.arange(0.0, 20.0, 0.5))
    outro = [19.5 + 0.5175 * k for k in range(2, 17)]
    y = add_click(pad_then_band(0.0, 10.0), outro[-beat], 0.3)
    assert reported_over(y, [*band, *outro]) == [round(float(t), 3) for t in band]


@pytest.mark.parametrize("pickups", [2, 3])
def test_a_pickup_before_the_band_does_not_start_the_grid_in_the_pad(pickups):
    """
    Two or three eighth-note clicks (a pickup) just before a 120 BPM band, after eight beats
    10 % slow under a 6 s pad. The pad's last beat falls on the pickup and is reported with
    the band; the beats before it are left out, not taken into the measured grid.
    """
    band = list(np.arange(6.0, 30.0, 0.5))
    intro = [5.5 - 0.55 * k for k in range(7, -1, -1)]
    notes = [6.0 - 0.25 * k for k in range(pickups, 0, -1)]
    y = pad_then_band()
    for t in notes:
        y = add_click(y, t, 0.3)
    reported = reported_over(y, [*intro, *band])
    on_the_pickup = [t for t in intro if min(abs(t - n) for n in notes) < 0.07]
    assert on_the_pickup == [intro[-1]]
    assert reported == [round(float(t), 3) for t in [*on_the_pickup, *band]]


def with_kicks(y: np.ndarray, times, amplitude: float = 1.0) -> np.ndarray:
    """`y` with the 120 BPM band's kick (its first 0.2 s) added at each of `times`."""
    y = y.copy()
    kick = amplitude * signals.drum_pattern(120)[: round(0.2 * FIXTURE_SR)]
    for t in times:
        a = round(t * FIXTURE_SR)
        y[a : a + kick.size] += kick[: max(0, y.size - a)]
    return y


@pytest.mark.parametrize(
    "kicks",
    [
        pytest.param([4.0, 5.0, 6.0, 7.0], id="every-other-beat"),
        pytest.param([4.0, 4.5, 5.5, 6.0, 7.0, 7.5], id="two-of-three-beats"),
    ],
)
def test_a_band_whose_first_beats_are_not_all_on_onsets_starts_the_grid(kicks):
    """
    A 120 BPM band whose first two bars (4-8 s) are only kicks over a pad, after ticks 20 %
    slow under the pad alone. With a kick on every other beat, no two beats on onsets come in a
    row before 8 s, but beats alternating on and off onsets (GRID_START_ALTERNATE) start the
    measured grid too; with kicks on two beats of every three, two in a row (GRID_START_BEATS)
    do, where three would not until 7 s. Either way the grid starts at the first kick, and only
    the pad's ticks before it are left out. (The first beats of two Ballroom clips are on and
    off onsets like these.)
    """
    y = with_kicks(pad_then_band(8.0), kicks)
    intro = [4.0 - 0.6 * k for k in range(6, 0, -1)]
    band = list(np.arange(4.0, 30.0, 0.5))
    assert reported_over(y, [*intro, *band]) == [round(float(t), 3) for t in band]


@pytest.mark.parametrize(
    "kicks", [pytest.param([6.0], id="one-hit"), pytest.param([6.0, 8.0], id="two-downbeats")]
)
def test_known_limit_a_band_whose_first_bars_have_only_a_downbeat_loses_them_after_ticks(kicks):
    """
    A known limit, pinned as it is: ten ticks 10 % slow under a pad, then a 120 BPM band whose
    first two bars (6-10 s) are only a kick on the downbeat, before the groove at 10 s. The
    measured grid starts at 10 s, and the run before it, the ticks and the band's sparse bars
    together, is off the grid (5.6 % off its spacing) and left out as a whole: the band's first
    eight beats are missing, and none of the ticks is reported. Keeping the sparse bars when
    they alone were on the grid also kept a pad's ticks after one click (Essentia's ticks come
    close to the band's grid after a while).
    """
    y = with_kicks(pad_then_band(10.0), kicks)
    intro = [6.0 - 0.55 * k for k in range(10, 0, -1)]
    band = list(np.arange(6.0, 30.0, 0.5))
    reported = reported_over(y, [*intro, *band])
    assert reported == [round(float(t), 3) for t in band if t >= 10.0]


@pytest.mark.parametrize("before", [2, 3])
def test_known_limit_a_lone_first_hit_just_before_the_groove_is_missing_with_the_ticks(before):
    """
    A known limit, pinned as it is: ten ticks 10 % slow under a pad, then one kick `before`
    beats before a 120 BPM band's groove at 10 s. The kick is the band's, but the grid starts
    at 10 s and the run before it, the ticks with the kick, is off the grid and left out as a
    whole: the kick is missing, and none of the ticks is reported. (2.3.3 kept it.)
    """
    hit = 10.0 - 0.5 * before
    y = with_kicks(pad_then_band(10.0), [hit])
    intro = [hit - 0.55 * k for k in range(10, 0, -1)]
    band = list(np.arange(hit, 30.0, 0.5))
    reported = reported_over(y, [*intro, *band])
    assert reported == [round(float(t), 3) for t in band if t >= 10.0]


def test_the_ticks_before_an_onset_in_a_run_are_judged_on_the_grid_phase():
    """
    Fourteen beats under a pad before a 120 BPM band at 8 s, all at its spacing: five 0.35 of
    a period early, then nine on its grid, with a click under the last early one. The run as a
    whole, and its part from the click on, are on the grid (2.5 and 3.5 % off its spacing, a
    median 0 off its phase). The four ticks before the click are judged on their own, against
    the grid's spacing and phase counted from its first beat (0.35 of a period off), and none
    of them is reported; every beat of the band is. (Counted from the click, they would be on
    the grid and stay.)
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    on_the_grid = [8.0 - 0.5 * k for k in range(9, 0, -1)]
    early = [3.0 - 0.5 * 0.35 - 0.5 * k for k in range(4, -1, -1)]
    y = add_click(pad_then_band(8.0), early[-1], 0.3)
    reported = reported_over(y, [*early, *on_the_grid, *band])
    assert not [t for t in reported if t < round(early[-1], 3)]
    assert set(round(float(t), 3) for t in band) <= set(reported)


def test_sparse_kicks_after_the_band_do_not_keep_the_ticks_after_them():
    """
    The band to 20 s, then a pad with two kicks on its grid (22 and 24 s), then six ticks 10 %
    slow from 26.55 s. The ticks after the last kick are judged on their own and left out, with
    the three beats on the grid between that kick and them (no onset under them), as before
    2.3.4. (Judged as one run with the kicks, the ticks were reported.)
    """
    y = with_kicks(pad_then_band(0.0, 10.0), [22.0, 24.0])
    band = list(np.arange(0.0, 26.0, 0.5))
    outro = [26.0 + 0.55 * k for k in range(1, 7)]
    reported = reported_over(y, [*band, *outro])
    assert reported == [round(float(t), 3) for t in band if t <= 24.0]


def test_a_grid_that_ends_on_alternate_beats_ends_on_its_last_onset():
    """
    The band to 20 s, then a pad with kicks on every other beat to 23 s, then eight ticks 20 %
    slow. Read backward, the kicks alternate on and off onsets (GRID_START_ALTERNATE), so the
    grid ends at the last kick: the band's beats to 23 s stay and the ticks are left out.
    """
    y = with_kicks(pad_then_band(0.0, 10.0), [21.0, 22.0, 23.0])
    band = list(np.arange(0.0, 23.5, 0.5))
    outro = [23.0 + 0.6 * k for k in range(1, 9)]
    assert reported_over(y, [*band, *outro]) == [round(float(t), 3) for t in band]


@pytest.mark.parametrize(
    ("every", "offbeats"),
    [
        pytest.param(4, False, id="downbeats"),
        pytest.param(3, False, id="waltz-downbeats"),
        pytest.param(4, True, id="one-drop"),
    ],
)
def test_a_band_with_no_two_beats_on_onsets_in_a_row_still_has_its_intro_judged(every, offbeats):
    """
    A pad throughout, fourteen ticks 10 % slow under it to 8 s, then a 120 BPM band whose only
    onsets on its beats are kicks on every `every`th beat (with offbeat skanks for a one-drop).
    No beat starts the measured grid (_measured_span), so it runs from the first beat on an
    onset to the last, as before 2.3.4, and the ticks before it are left out.
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    y = 0.5 * pad_then_band(30.0)
    if offbeats:
        y = with_kicks(y, [t + 0.25 for t in band])
        y = with_kicks(y, band[::every], 0.5)
    else:
        y = with_kicks(y, band[::every])
    intro = [8.0 - 0.55 * k for k in range(14, 0, -1)]
    assert reported_over(y, [*intro, *band]) == [round(float(t), 3) for t in band]


@pytest.mark.parametrize(
    "clicks", [pytest.param([14], id="last-tick"), pytest.param([6, 7], id="adjacent-ticks")]
)
@pytest.mark.parametrize(
    ("every", "offbeats"),
    [
        pytest.param(4, False, id="downbeats"),
        pytest.param(3, False, id="waltz-downbeats"),
        pytest.param(4, True, id="one-drop"),
    ],
)
def test_clicks_before_a_band_with_no_start_of_its_own_do_not_take_the_grid(
    every, offbeats, clicks
):
    """
    The band with no two beats on onsets in a row, after fourteen ticks 10 % slow under the
    pad, with a click under the last tick (next to the band's first beat on an onset) or under
    the 6th and 7th. Those onsets on two beats in a row were the measured span: the band was
    judged off it and left out (43 or 44 of its 44 beats), and the ticks reported. A span with
    under half of the beats on onsets is not the band's, so the grid runs from the first beat
    on an onset to the last: every beat of the band is reported. The ticks from the first click
    on are too (a known limit: one onset on the tick next to the band joins it, and two on
    adjacent ticks start the grid there); those before it are left out.
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    y = 0.5 * pad_then_band(30.0)
    if offbeats:
        y = with_kicks(y, [t + 0.25 for t in band])
        y = with_kicks(y, band[::every], 0.5)
    else:
        y = with_kicks(y, band[::every])
    intro = [8.0 - 0.55 * k for k in range(14, 0, -1)]
    for k in clicks:
        y = add_click(y, intro[k - 1], 0.3)
    reported = reported_over(y, [*intro, *band])
    assert reported == [round(float(t), 3) for t in [*intro[clicks[0] - 1 :], *band]]


@pytest.mark.parametrize(
    ("pattern", "span"),
    [
        ("0010101111", (2, 9)),
        ("1111010100", (0, 7)),
        ("0110", (1, 2)),
        ("0100100", None),
    ],
)
def test_the_measured_span_starts_and_ends_where_the_onsets_do(pattern, span):
    """
    Beats on onsets (1) or not (0): the measured grid starts at the first two in a row or the
    first five that alternate, starting on an onset, and ends at the last, read backward.
    """
    on = np.array([c == "1" for c in pattern])
    assert signal_features._measured_span(on) == span


def test_a_run_is_compared_with_the_grid_next_to_it():
    """
    Six beats under the pad on the band's 120 BPM grid stay, though the tracker later counts
    every other beat (most of the window's intervals are then 1 s).
    """
    band = [*np.arange(6.0, 11.0, 0.5), *np.arange(11.0, 30.0, 1.0)]
    intro = [6.0 - 0.5 * k for k in range(6, 0, -1)]
    reported = reported_over(pad_then_band(), [*intro, *band])
    assert reported == [round(float(t), 3) for t in [*intro, *band]]


def test_a_beat_skipped_next_to_a_run_does_not_set_its_spacing():
    """
    Six beats under the pad on the band's grid stay, though the tracker skipped the band's
    second beat: the grid's spacing is the median over its first EDGE_RUN_GRID_BEATS beats on
    onsets, not the first interval.
    """
    band = [6.0, *np.arange(7.0, 30.0, 0.5)]
    intro = [6.0 - 0.5 * k for k in range(6, 0, -1)]
    reported = reported_over(pad_then_band(), [*intro, *band])
    assert reported == [round(float(t), 3) for t in [*intro, *band]]


def test_a_run_is_judged_against_a_short_band():
    """
    A band of eight beats (6-10 s) between pads: the six beats before it, 10 % off its
    spacing, are left out, though the grid has fewer than EDGE_RUN_GRID_BEATS + 1 beats on
    onsets.
    """
    band = list(np.arange(6.0, 10.0, 0.5))
    intro = [6.0 - k * 0.5 * 1.1 for k in range(6, 0, -1)]
    reported = reported_over(pad_then_band(6.0, 20.0), [*intro, *band])
    assert reported == [round(float(t), 3) for t in band]


def test_a_tick_less_than_half_a_period_after_the_last_counts_as_a_period():
    """
    Six beats under the pad on the band's grid, except one late by 52 % of a period: the
    interval after it is under half a period and counts as one, so the run is 14 % off and is
    left out. (Counted as none, the run would come out on the grid.)
    """
    band = list(np.arange(6.0, 30.0, 0.5))
    intro = [6.0 - 0.5 * k for k in range(6, 0, -1)]
    intro[2] += 0.26
    reported = reported_over(pad_then_band(), [*intro, *band])
    assert reported == [round(float(t), 3) for t in band]


def intro_then_band(intro: np.ndarray, bpm: float = 97) -> np.ndarray:
    """`intro` for the first 10 s, then the band at `bpm`."""
    y = signals.drum_pattern(bpm).copy()
    y[: 10 * FIXTURE_SR] = intro[: 10 * FIXTURE_SR]
    return y


SECONDS_30 = np.arange(30 * FIXTURE_SR) / FIXTURE_SR
NOISE_INTROS = {
    "hum-50Hz-50dBFS": np.sqrt(2) * np.sin(2 * np.pi * 50 * SECONDS_30) * 10 ** (-50 / 20),
    "hiss-60dBFS": np.random.default_rng(0).standard_normal(30 * FIXTURE_SR) * 10 ** (-60 / 20),
}


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("intro", list(NOISE_INTROS))
def test_no_beats_are_reported_under_hum_or_hiss_before_the_band(intro, estimator):
    """
    10 s of 50 Hz hum at -50 dBFS, or of white hiss at -60 dBFS, then the 97 BPM band.
    Essentia counted 18 and 17 beats through them, 9.7 and 4.9 % off the band's spacing
    (the hiss is close to EDGE_RUN_TOLERANCE); only the band's beats are reported.
    """
    y = intro_then_band(NOISE_INTROS[intro])
    tracked = tracked_beats(y, estimator)
    _, v2 = analyse_array(y, estimator)
    assert v2["beats"]["times"] == [t for t in tracked if t >= 10.0]


@needs_essentia
@pytest.mark.parametrize(
    ("probe", "beat", "amplitude"),
    [
        ("band-97-after-10s-pad", 4, 0.3),
        ("band-97-after-10s-pad", 7, 0.1),
        ("band-97-after-10s-pad", 10, 0.03),
        ("band-132-after-12s-pad", 14, 0.1),
        ("band-85-after-10s-pad", 8, 0.1),
    ],
)
def test_one_click_under_a_pad_beat_brings_none_of_its_beats_back(probe, beat, amplitude):
    """
    A pad before the band, with one 10 ms click under the pad's `beat`th beat as Essentia
    tracks it. Before 2.3.4 the measured grid started at the click, and Essentia's beats under
    the pad before the 97 BPM band were reported again (15, 15 and 6 of 15); now none is. On
    the 132 and 85 BPM probes, Essentia's ticks from the click on come close to the band's
    grid: judged apart from the ticks before the click, they were reported (11 and 8 beats).
    """
    start = float(probe.split("after-")[1].split("s")[0])
    y = PROBES[probe]
    pad = [t for t in tracked_beats(y, "essentia") if t < start]
    y = add_click(y, pad[beat - 1], amplitude)
    tracked = tracked_beats(y, "essentia")
    _, v2 = analyse_array(y, "essentia")
    assert v2["beats"]["times"] == [t for t in tracked if t >= start]
    assert round(v2["tempo"]["bpm"]) == round(float(probe.split("-")[1]))


@needs_essentia
@pytest.mark.parametrize(("beat", "amplitude"), [(8, 0.3), (9, 0.3), (10, 0.1)])
def test_one_click_under_a_pad_beat_before_a_one_drop_brings_none_of_its_beats_back(
    beat, amplitude
):
    """
    A pad throughout, a one-drop band from 8 s (a kick on every 4th beat, offbeat skanks),
    and one click under the pad's `beat`th beat as Essentia tracks it. Essentia's ticks under
    the pad run about 9 % fast before the click and 4 to 5 % slow from it to the band: over the
    whole run the drifts cancel (2.0 to 2.4 % off the grid's spacing), and the ticks from the
    click on were reported (7, 6 and 5). Their part from the click on is 4.2 to 4.7 % off on
    its own, so none is now, and every beat of the band is.
    """
    band = list(np.arange(8.0, 30.0, 0.5))
    y = 0.5 * pad_then_band(30.0)
    y = with_kicks(y, [t + 0.25 for t in band])
    y = with_kicks(y, band[::4], 0.5)
    pad = [t for t in tracked_beats(y, "essentia") if t < 7.93]
    y = add_click(y, pad[beat - 1], amplitude)
    tracked = tracked_beats(y, "essentia")
    _, v2 = analyse_array(y, "essentia")
    assert v2["beats"]["times"] == [t for t in tracked if t >= 7.93]


@needs_essentia
@pytest.mark.parametrize("pickups", [2, 3])
def test_a_pickup_before_the_band_reports_no_pad_beat_before_it(pickups):
    """
    Two or three eighth-note piano notes just before the 97 BPM band, after the pad: Essentia
    puts a beat on the last of them, which is reported with the band; none of the beats it
    counted under the pad before them is.
    """
    first = 17 * 60 / 97
    notes = [first - k * 30 / 97 for k in range(pickups, 0, -1)]
    y = PROBES["band-97-after-10s-pad"].copy()
    for t in notes:
        a = round(t * FIXTURE_SR)
        y[a : a + round(0.3 * FIXTURE_SR)] += 0.3 * signals.piano_note(signals.hz(69), 0.3)
    tracked = tracked_beats(y, "essentia")
    _, v2 = analyse_array(y, "essentia")
    before = [t for t in v2["beats"]["times"] if t < 10.0]
    assert before and all(min(abs(t - n) for n in notes) < 0.07 for t in before)
    assert v2["beats"]["times"] == [t for t in tracked if t >= before[0]]


@needs_essentia
def test_known_limit_beats_counted_at_the_band_spacing_through_a_rubato_intro_are_reported():
    """
    A known limit, pinned as it is: 8 s of a rubato piano (onsets but no beat), then a 120 BPM
    band. Essentia counts on through the piano at the band's spacing; those beats are off
    onsets but keep the grid, so they are reported as measured. When a rule catches them,
    this test should change.
    """
    y = signals.drum_pattern(120).copy()
    y[: 8 * FIXTURE_SR] = 0.5 * signals.piano_line(8.0)[: 8 * FIXTURE_SR]
    tracked = tracked_beats(y, "essentia")
    _, v2 = analyse_array(y, "essentia")
    assert v2["beats"]["times"] == tracked
    assert sum(t < 8.0 for t in tracked) >= 12


# Analysed first in a new process, this probe gave 97.0 BPM at 0.568 with 55 beats; after three
# other probes in the same process, 97.0 BPM at 0.558 with 54 beats.
HISTORY_PROBE = "band-97-after-10s-silence"
EARLIER_PROBES = ["noise-bursts", "drums-only-97", "drums-only-120"]
FIRST_ANALYSIS = """
import json, sys
import estimators, main
from tests import signals
from tests.checks import check_result
signal = signals.probes()[sys.argv[2]]
chosen = estimators.select_estimator(sys.argv[1])
result = main.analyze_signals(estimators.Signals(signal, signals.SR), chosen)
print("V2 " + json.dumps(check_result(result)))
"""


def first_analysis_in_a_new_process(probe: str, estimator: str) -> dict:
    """The v2 block of `probe` analysed by a new Python process that analyses nothing else."""
    service = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    run = subprocess.run(
        [sys.executable, "-c", FIRST_ANALYSIS, estimator, probe],
        cwd=service,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert run.returncode == 0, run.stderr[-3000:]
    lines = [line for line in run.stdout.splitlines() if line.startswith("V2 ")]
    assert len(lines) == 1, run.stdout[-3000:]
    return json.loads(lines[0].removeprefix("V2 "))


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_an_analysis_does_not_depend_on_what_the_process_analysed_before(estimator):
    """
    The same signal gives the same v2 block whatever the process analysed before it, one
    after another or at the same time in other worker threads. (Essentia's tempo tracker adds
    noise from the C library's rand(), whose state the whole process shares.)
    """
    first = first_analysis_in_a_new_process(HISTORY_PROBE, estimator)
    for probe in EARLIER_PROBES:
        analyse_array(PROBES[probe], estimator)
    _, after = analyse_array(PROBES[HISTORY_PROBE], estimator)
    assert after == first
    probes = [*EARLIER_PROBES, HISTORY_PROBE] * 2
    # The service's own workers: their threads never end, so no Essentia network is deleted
    # (see test_models_after_essentia_estimators_do_not_flood_the_log).
    blocks = list(main.executor.map(lambda p: analyse_array(PROBES[p], estimator)[1], probes))
    for probe, block in zip(probes, blocks, strict=True):
        if probe == HISTORY_PROBE:
            assert block == first, "analysed while other threads analysed"


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
    """
    An estimator returning fixed estimates (or raising), for the analysis around it; without
    one it gives a fixed reason.
    """

    name = "fake"
    NO_TEMPO = estimators.Withheld("no tempo here", code="no_beat")
    NO_KEY = estimators.Withheld("no key here", code="no_key_estimate")

    def __init__(self, tempo=None, key=None):
        self._tempo, self._key = tempo, key

    def measure_tempo(self, signals):
        if isinstance(self._tempo, Exception):
            raise self._tempo
        return self.NO_TEMPO if self._tempo is None else self._tempo

    def measure_key(self, signals):
        if isinstance(self._key, Exception):
            raise self._key
        return self.NO_KEY if self._key is None else self._key


A_MAJOR = estimators.KeyEstimate("A", "major", 0.8, "x", "fake")


def test_an_estimator_failure_only_loses_its_own_measurement():
    tempo_fails = FakeEstimator(tempo=RuntimeError("boom"), key=A_MAJOR)
    result = main.analyze_signals(estimators.Signals(a_major_triad(), FIXTURE_SR), tempo_fails)
    v2 = check_result(result)
    assert v2["tempo"] is None and v2["key"]["tonic"] == "A"
    assert v2["withheld"]["tempo"] == v2["withheld"]["beats"] == main.ESTIMATE_FAILED.entry()
    key_fails = FakeEstimator(tempo=None, key=RuntimeError("boom"))
    v2 = check_result(main.analyze_signals(estimators.Signals(a_major_triad(), 22050), key_fails))
    assert v2["key"] is None and v2["loudness"] is not None
    assert v2["withheld"]["key"]["code"] == "estimate_failed"
    assert v2["withheld"]["tempo"] == {"code": "no_beat", "reason": "no tempo here"}


class AnswersOnly:
    """An estimator with only tempo() and key(), as the evals' beat-this one: no reasons."""

    name = "answers-only"

    def tempo(self, signals):
        return None

    def key(self, signals):
        return "not an estimate"


def test_an_estimator_that_gives_no_reason_gets_a_generic_one():
    signals_ = estimators.Signals(a_major_triad(), FIXTURE_SR)
    v2 = check_result(main.analyze_signals(signals_, AnswersOnly()))
    assert v2["tempo"] is None and v2["key"] is None
    assert v2["withheld"]["tempo"] == main.NO_TEMPO_ESTIMATE.entry()
    assert v2["withheld"]["key"] == estimators.NO_KEY_ESTIMATE.entry()


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
    ("bpm", "ticks", "raw", "code"),
    [
        (120.0, 60, 1.49, "low_confidence"),
        (120.0, 3, 4.0, "too_few_beats"),
        (220.0, 60, 4.0, "tempo_out_of_range"),
        (39.0, 60, 4.0, "tempo_out_of_range"),
        (float("nan"), 60, 4.0, "estimate_failed"),
    ],
)
def test_essentia_says_which_rule_withheld_the_tempo(monkeypatch, bpm, ticks, raw, code):
    rhythm = FakeAlgorithm((bpm, np.arange(ticks) * 0.5, raw, [], []))
    with_essentia_algorithms(monkeypatch, rhythm=rhythm)
    estimator = estimators.EssentiaEstimator()
    withheld = estimator.measure_tempo(steady_signals())
    assert isinstance(withheld, estimators.Withheld) and withheld.code == code
    assert estimator.tempo(steady_signals()) is None
    assert f"{bpm:g}" not in withheld.reason  # the reason never shows the withheld tempo


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_no_repeating_onsets_is_no_beat_for_both_estimators(estimator):
    signals_ = steady_signals()
    signals_.__dict__["onset_periodicity"] = 0.19
    assert estimators.select_estimator(estimator).measure_tempo(signals_) == estimators.NO_BEAT


@pytest.mark.parametrize(
    ("output", "code"),
    [(("C", "major", 0.39), "low_key_strength"), (("H", "major", 0.9), "no_key_estimate")],
)
def test_essentia_says_which_rule_withheld_the_key(monkeypatch, output, code):
    with_essentia_algorithms(monkeypatch, key=FakeAlgorithm(output))
    signals_ = estimators.Signals(a_major_triad(), 22050)
    withheld = estimators.EssentiaEstimator().measure_key(signals_)
    assert isinstance(withheld, estimators.Withheld) and withheld.code == code


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


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_a_tempo_under_the_confidence_minimum_says_so_for_both_estimators(monkeypatch, estimator):
    """The reason is the confidence rule's, whichever estimator withheld the tempo."""
    monkeypatch.setattr(estimators, "periodicity_at_lag", lambda envelope, lag: 0.29)
    ticks = np.arange(60) * 0.5
    with_essentia_algorithms(monkeypatch, rhythm=FakeAlgorithm((120.0, ticks, 1.49, [], [])))
    withheld = estimators.select_estimator(estimator).measure_tempo(steady_signals())
    assert isinstance(withheld, estimators.Withheld) and withheld.code == "low_confidence"
    assert withheld.reason.startswith("the tempo estimator's confidence")


def test_a_steady_clip_too_short_to_check_is_not_called_unsteady():
    """
    Six seconds at 60 BPM: five beats, a steady tempo, but too few beat intervals for the
    steadiness check. The tempo is withheld as before; the reason is the beat count, not a change.
    """
    v2 = check_result(
        main.analyze_signals(
            estimators.Signals(click_track(60, seconds=6.0), FIXTURE_SR),
            estimators.select_estimator("librosa"),
        )
    )
    assert v2["tempo"] is None and v2["beats"] is None
    assert v2["withheld"]["tempo"] == v2["withheld"]["beats"] == main.UNCHECKED_TEMPO.entry()


# Each key rule says which rule it is: the probes where it decides (values pinned here).
KEY_RULE_PROBES = {
    "no_sustained_pitch": lambda: PROBES["drums-only-120"],
    "one_harmonic_series": lambda: PROBES["hum-50Hz-gentle"],
    "one_held_pitch": lambda: PROBES["A4-vibrato-80c"],
    "few_pitch_classes": lambda: PROBES["drone-with-drums"],
    "speech_like": lambda: music.speech(4),
    "one_pitched_source": lambda: signals.seeded_cowbell(500),
}


@pytest.mark.parametrize("estimator", ESTIMATORS)
@pytest.mark.parametrize("code", KEY_RULE_PROBES)
def test_each_key_rule_names_itself(code, estimator):
    signals_ = estimators.Signals(KEY_RULE_PROBES[code](), FIXTURE_SR)
    withheld = estimators.select_estimator(estimator).measure_key(signals_)
    assert isinstance(withheld, estimators.Withheld) and withheld.code == code, withheld


def test_without_a_pitch_track_the_key_rule_is_no_pitch_track(monkeypatch):
    monkeypatch.setattr(estimators, "voice", raises)
    signals_ = estimators.Signals(PROBES["chords-D"], FIXTURE_SR)
    for name in KEY_ESTIMATORS:
        assert estimators.select_estimator(name).measure_key(signals_).code == "no_pitch_track"


@pytest.mark.parametrize("estimator", ESTIMATORS)
def test_a_weak_key_says_its_strength_was_under_the_minimum(monkeypatch, estimator):
    monkeypatch.setattr(estimators, "krumhansl_key", lambda chroma: ("C", "major", 0.39))
    with_essentia_algorithms(monkeypatch, key=FakeAlgorithm(("C", "major", 0.39)))
    signals_ = estimators.Signals(a_major_triad(), 22050)
    withheld = estimators.select_estimator(estimator).measure_key(signals_)
    assert isinstance(withheld, estimators.Withheld) and withheld.code == "low_key_strength"


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
    assert "key" not in v2["withheld"]


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
    assert "key" not in v2["withheld"]


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
    assert v2["key"] is None and v2["withheld"]["key"]["code"] == "no_sustained_pitch"
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
# harmonics the notes test does not fold within its tolerance; toms (two or three drums, each
# with its own envelope, alone or over a kit) and tabla, whose lines mostly move apart, and
# where they hold still (tabla 504, 516, 520; kit toms 528) spell a chord; and a tubular bell,
# whose modes hold still and move together but spell three or more pitch classes, as a chord's
# notes do.
# Seeds 600-629 are an evaluation set (evals/audio controls) and are kept out of these tests.
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
    ("kit-toms", "essentia"): {500, 505, 507, 513, 515, 523, 529},
    ("kit-toms", "librosa"): {500, 505, 507, 513, 515, 529},
    ("tubular-bell", "essentia"): {
        *{500, 502, 503, 504, 505, 506, 507, 508, 510, 511, 513, 514, 515, 516, 517, 518},
        *{519, 520, 521, 522, 524, 526, 527, 529},
    },
    ("tubular-bell", "librosa"): {
        *{500, 502, 503, 504, 506, 508, 510, 511, 512, 513, 514, 515, 516, 518, 519, 520},
        *{521, 522, 524, 526, 527, 528, 529},
    },
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


def test_a_tubular_bell_holds_still_but_spells_a_chord():
    """
    A limit: a tubular bell's modes hold still and move together, but they spell pitch classes
    as a chord's notes do, so the single-source rule keeps the key the other rules give it.
    """
    evidence = estimators.Signals(signals.seeded_tubular_bell(500), FIXTURE_SR).source_evidence
    assert evidence.still and evidence.chord and not evidence.single, evidence


def one_source_withheld(signals_: estimators.Signals) -> bool:
    """The key is withheld as one pitched source, under whatever reason that code is given."""
    withheld = signals_.key_withheld()
    return withheld is not None and withheld.code == "one_pitched_source"


def test_one_source_withheld_sees_the_single_source_rule():
    """The guards below rest on this helper: it sees a cowbell's key withheld, not a chord's."""
    assert one_source_withheld(estimators.Signals(signals.seeded_cowbell(500), FIXTURE_SR))
    y, _ = signals.seeded_faded_pad(700)
    assert not one_source_withheld(estimators.Signals(y, FIXTURE_SR))


# The chord families' keys that the service withholds at seeds 700-729, by any rule, with the
# rule's code (estimator-independent: Signals.key_withheld). None is the single-source rule's;
# the earlier rules withhold them as one held pitch, one harmonic series or, for two one-bar
# riffs, speech. Pinned exactly, so a rule that takes a chord's key under any code, new or old,
# fails here.
CHORD_WITHHELD = {
    "faded-pad": {
        **dict.fromkeys((704, 708, 722), "one_harmonic_series"),
        **dict.fromkeys((716, 728), "one_held_pitch"),
    },
    "swelling-pad": {
        **dict.fromkeys((704, 708, 722), "one_harmonic_series"),
        **dict.fromkeys((716, 728), "one_held_pitch"),
    },
    "crescendo-pad": {
        **dict.fromkeys((704, 708, 722), "one_harmonic_series"),
        **dict.fromkeys((716, 728), "one_held_pitch"),
    },
    "tremolo-pad": {**dict.fromkeys((716, 728), "one_held_pitch")},
    "pumped-pad": {
        **dict.fromkeys((704, 708, 722), "one_harmonic_series"),
        **dict.fromkeys((709, 716, 728), "one_held_pitch"),
    },
    "c-major-stabs": {},
    "one-chord-riff": {
        **dict.fromkeys(
            (
                700,
                701,
                702,
                703,
                704,
                705,
                707,
                708,
                709,
                710,
                711,
                712,
                713,
                715,
                716,
                717,
                722,
                724,
                725,
                727,
                728,
                729,
            ),
            "one_held_pitch",
        )
    },
    "one-bar-riff": {**dict.fromkeys((726, 727), "speech_like")},
    "soft-chord": {
        **dict.fromkeys((704, 708, 710, 716, 718, 722, 726), "one_held_pitch"),
        **dict.fromkeys((709,), "one_harmonic_series"),
    },
    "mallet-chord": {**dict.fromkeys((710, 714, 718, 722, 724), "one_held_pitch")},
}


@pytest.mark.seeded
@pytest.mark.parametrize("family", signals.CHORD_KEYED_SEEDED)
def test_chords_keep_the_key_the_other_rules_give_them(family):
    """
    Held chords faded, swelling, getting louder, with tremolo or a sidechain pump, chord stabs,
    a bass and chord riff on one chord, one-bar riffs, triads in soft timbres (an electric
    piano, a flute, an FM electric piano, a triangle wave) and triads struck on bars
    (signals.CHORD_KEYED_SEEDED, seeds 700-729): many hold still and move together, but their
    lines spell a chord, so the single-source rule withholds none of their keys. Every key
    that is withheld is withheld as pinned in CHORD_WITHHELD, by the same rule.
    """
    make = signals.CHORD_KEYED_SEEDED[family]
    withheld, still = {}, 0
    for seed in signals.CHORD_KEYED_SEEDS:
        y, _ = make(seed)
        signals_ = estimators.Signals(y, FIXTURE_SR)
        still += signals_.source_evidence.still
        reason = signals_.key_withheld()
        if reason is not None:
            withheld[seed] = reason.code
    assert withheld == CHORD_WITHHELD[family]
    if family != "one-bar-riff":  # its chords change within a bar: the lines move
        assert still > 0  # the notes test, not time, keeps these keys


def soft_third_indices(root: int) -> list[int]:
    """
    The signals.SOFT_THIRD_GRID chords the tests analyse at `root`: both modes and every level,
    in one timbre per root (pad, organ and saw in turn, each at four roots), 96 of the 288. The
    evals/audio controls run all 288.
    """
    timbre = ("pad", "organ", "saw")[root % 3]
    return [
        index
        for index, (grid_root, _, grid_timbre, _) in enumerate(signals.SOFT_THIRD_GRID)
        if grid_root == root and grid_timbre == timbre
    ]


# The keys the rules withhold among those 96 chords (Signals.key_withheld, the same for both
# estimators), with the rule's code: 64 of 96. None is the single-source rule's. Every one of them
# has a right key with the rules lifted, as the 2026-10-29 controls run records for all 288.
SOFT_THIRD_WITHHELD = {
    **dict.fromkeys(
        (3, 13, 14, 29, 30, 31, 40, 42, 43, 57, 58, 59, 70, 71, 73, 74, 75, 86, 87, 102, 103),
        "one_harmonic_series",
    ),
    **dict.fromkeys(
        (112, 113, 115, 131, 142, 147, 158, 172, 173, 174, 185, 186, 187, 201, 202, 203, 214),
        "one_harmonic_series",
    ),
    **dict.fromkeys(
        (215, 217, 218, 219, 230, 231, 246, 247, 256, 257, 259, 275, 286), "one_harmonic_series"
    ),
    **dict.fromkeys((141, 157, 184, 212, 213, 228, 229, 258, 284, 285), "one_held_pitch"),
    **dict.fromkeys((15, 28, 41), "few_pitch_classes"),
}
# The keys served that are wrong: Essentia names the parallel minor of an F# major triad.
SOFT_THIRD_WRONG = {("essentia", 159): ("F#", "minor")}


@pytest.mark.seeded
@pytest.mark.estimators
@pytest.mark.parametrize("root", range(12), ids=[f"{n}3" for n in signals.PITCH_NAMES])
def test_a_chord_with_a_softer_third_over_a_doubled_root_gets_exactly_the_pinned_answers(root):
    """
    A triad with its root doubled an octave down and its third 1.5-6 dB softer
    (signals.SOFT_THIRD_GRID at every root, both modes, pumped, faded, with tremolo or stabbed;
    soft_third_indices): the doubled root is the strongest line and the third sits on its
    flank, but down to 4.5 dB softer its notes still spell a chord. Each estimator's answer is
    pinned exactly: the key it serves (32 of the 96; one of Essentia's is wrong) or the code of
    the rule that withholds it (64: one harmonic series, one held pitch, fewer than three pitch
    classes). The single-source rule withholds none of them: it is reached only when every
    other rule lets the key through, so on the 32 it lets them all through, and on the 64 it is
    not asked (for 3 and 131 it would withhold the key: see the test below).
    """
    answers, expected = {}, {}
    for index in soft_third_indices(root):
        level = signals.SOFT_THIRD_GRID[index][3]
        y, key = signals.soft_third_chord(index)
        s = estimators.Signals(y, FIXTURE_SR)
        notes = estimators.source_notes(s.harmonic_stft, s.sr, s.hop)
        if level > -6.0:
            assert estimators.spells_chord(notes), (index, key, notes)
        withheld = s.key_withheld()
        assert (withheld and withheld.code) == SOFT_THIRD_WITHHELD.get(index), (index, withheld)
        for name in KEY_ESTIMATORS:
            found = estimators.select_estimator(name).measure_key(s)
            answers[(name, index)] = (
                (found.tonic, found.mode)
                if isinstance(found, estimators.KeyEstimate)
                else found.code
            )
            expected[(name, index)] = SOFT_THIRD_WITHHELD.get(index) or SOFT_THIRD_WRONG.get(
                (name, index), key
            )
    assert answers == expected


@pytest.mark.seeded
@pytest.mark.estimators
@pytest.mark.parametrize("index", (3, 35, 131, 179))
def test_a_minor_triad_whose_notes_spell_no_chord_loses_its_right_key(index, monkeypatch):
    """
    A known limit, pinned as it is: four minor triads stabbed with their third 6 dB down
    (C minor in a pad, C#, F and G minor in a saw; soft-third-3, -35, -131 and -179 in the
    evals/audio controls). Their lines are the doubled root's harmonics and the fifth: they form
    one harmonic series, so the key is withheld as one_harmonic_series with both estimators,
    though each estimator's key is right with the rules lifted. The notes test finds no third
    in them either (one source), so the single-source rule would withhold the key if the series
    rule did not.
    """
    root, mode, _, level = signals.SOFT_THIRD_GRID[index]
    assert (mode, level, signals.soft_third_shape(index)) == ("minor", -6.0, "stabs")
    y, key = signals.soft_third_chord(index)
    s = estimators.Signals(y, FIXTURE_SR)
    assert s.key_withheld().code == "one_harmonic_series"
    assert s.source_evidence.single, s.source_evidence
    for name in KEY_ESTIMATORS:
        assert estimators.select_estimator(name).measure_key(s).code == "one_harmonic_series"
    # With the evidence rules and the strength minimum lifted, every estimator names the key.
    monkeypatch.setattr(s, "key_withheld", lambda: None)
    for name in KEY_ESTIMATORS:
        est = estimators.select_estimator(name)
        monkeypatch.setattr(est, "min_key_strength", 0.0)
        found = est.key(s)
        assert (found.tonic, found.mode) == key, (name, found)


@pytest.mark.parametrize("cents", signals.THIRD_DETUNE_CENTS)
def test_a_detuned_third_over_a_doubled_root_is_still_a_third(cents):
    """
    A root doubled an octave down with its third 10-25 cents off and no fifth: a chord, and the
    key decision is the one an in-tune third gets: the minor third keeps its key, and the major
    third's lines spell fewer than three pitch classes. A rule that took off-grid notes for one
    source would withhold the minor thirds here.
    """
    for root, mode, code in ((0, "minor", None), (1, "major", "few_pitch_classes")):
        s = estimators.Signals(signals.detuned_third(root, mode, cents), FIXTURE_SR)
        notes = estimators.source_notes(s.harmonic_stft, s.sr, s.hop)
        assert estimators.spells_chord(notes), (root, mode, cents, notes)
        withheld = s.key_withheld()
        assert (withheld and withheld.code) == code, (root, mode, cents, withheld)


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
        assert not one_source_withheld(s)


@pytest.mark.seeded
def test_a_seventh_chord_with_a_quiet_third_is_a_chord():
    """
    Seventh chords whose fifth (6 dB down) folds into a root doubled below and whose third is
    6-12 dB down under the seventh (signals.SEVENTH_GRID at C, D#, F# and A; the evals/audio
    controls hold every root): root and seventh are what is left of the notes, and a seventh
    is a chord.
    """
    for index, (root, _, _, _) in enumerate(signals.SEVENTH_GRID):
        if root % 3:
            continue
        y, key = signals.seventh_chord(index)
        s = estimators.Signals(y, FIXTURE_SR)
        notes = estimators.source_notes(s.harmonic_stft, s.sr, s.hop)
        assert estimators.spells_chord(notes), (signals.SEVENTH_GRID[index], key, notes)


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="a known limit: a fourth (G2 under C3) with its third 15 dB down reads as two notes "
    "a fourth apart; without the rule librosa gives the right C major (0.768), Essentia C minor",
)
def test_a_fourth_with_a_third_15_db_down_keeps_its_key():
    s = estimators.Signals(signals.fourth_with_quiet_third(), FIXTURE_SR)
    assert not one_source_withheld(s), s.source_evidence


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="a known limit: a sine bass 15 dB over an A major triad (third 3 dB down) reads as one "
    "note; without the rule both estimators give the right A major (0.75 and 0.862)",
)
def test_a_triad_under_a_bass_15_db_louder_keeps_its_key():
    s = estimators.Signals(signals.triad_under_a_loud_sine_bass(), FIXTURE_SR)
    assert not one_source_withheld(s), s.source_evidence


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
        # A seventh or a second over the root (a seventh chord whose fifth folded into the
        # root and whose third is too quiet to count): a chord.
        ((65.41, 233.08), True),  # C2 and B-flat 3
        ((65.41, 246.94), True),  # C2 and B3
        ((130.81, 146.83), True),  # C3 and D3
        ((220.0, 293.66), False),  # a fourth
        ((220.0, 311.13), False),  # a tritone
    ):
        evidence = estimators.SourceEvidence(**{**one_note, "notes": notes})
        assert evidence.chord == chord and evidence.single == (not chord), notes
    assert not estimators.SourceEvidence(**{**one_note, "notes": None}).single


def test_intervals_on_the_notes_grid_are_decided_in_whole_steps():
    """
    Notes are 2-cent bin centres, so their intervals sit on the same grid as the limits: a tie
    is decided by integer steps, both limits included, never by float rounding.
    """

    def up(cents):
        return 440.0 * 2 ** (cents / 1200)

    assert estimators._cents(up(70), 440.0) == 70.0
    for cents, chord in (
        (830, True),  # a sixth 30 cents wide: on the limit, a chord
        (832, False),
        (270, True),  # a third 30 cents narrow
        (268, False),
        (250, True),  # a second or seventh: more than 50, at most 250
        (252, False),
        (52, True),
        (50, False),
        (2030, True),  # an octave higher changes nothing
    ):
        assert estimators.spells_chord((440.0, up(cents))) == chord, cents
    # The pinned cowbell-515 (Essentia keyed): its oscillators read exactly 830 cents apart.
    assert estimators.spells_chord((517.7304143215058, 836.2114159454611))


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
    assert v2["key"] is None and v2["withheld"]["key"]["code"] == "no_sustained_pitch"


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
SPEECH_LIKE = "one pitch line without stable notes"


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
    assert result["withheld"]["key"] == {"code": "no_pitch_track", "reason": "no pitch track"}
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
    # Each block says the gate withheld it, and nothing else.
    assert set(v2["withheld"]) == set(MEASURED_BLOCKS)
    assert {entry["code"] for entry in v2["withheld"].values()} == {f"gate_{reason}"}


def test_zero_length_file_is_gated(analyse):
    result, v2 = analyse(np.zeros(0, dtype=np.float32), "WAV")
    assert v2["gate"] == {"passed": False, "reason": "too_short"}
    assert v2["window"]["durationSeconds"] == 0
    assert v2["loudness"] is None and v2["withheld"]["loudness"]["code"] == "gate_too_short"


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
    assert v2["fingerprint"] is None and v2["withheld"]["fingerprint"]["code"] == "gate_silence"


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
    assert not {"fingerprint", "styles", "tags", "moods"} & set(result["v2"]["withheld"])


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
    reasons = result["v2"]["withheld"]
    codes = {part: reasons[part]["code"] for part in ("styles", "tags") if part in reasons}
    codes.update({head: reason["code"] for head, reason in reasons.get("moods", {}).items()})
    assert set(codes) == missing
    # Only DEAM's 9.5 is a value outside its range; the rest failed or gave unusable output.
    assert set(codes.values()) == {"out_of_range" if missing == {"valence"} else "model_failed"}


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
    assert v2["withheld"]["fingerprint"]["code"] == "not_music"


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
    assert v2["fingerprint"]["moods"]["danceability"]["value"] == 0.7


@pytest.mark.skipif(not os.path.exists(SPEECH), reason="no speech recording on this machine")
def test_no_fingerprint_for_speech(monkeypatch):
    stand_in_models(monkeypatch)
    y, sr = sf.read(SPEECH, dtype="float32")
    result = main.analyze_signals(estimators.Signals(y if y.ndim == 1 else y.mean(axis=1), sr))
    v2 = check_result(result)
    assert v2["fingerprint"] is None and v2["withheld"]["fingerprint"]["code"] == "not_music"


def test_a_drone_with_a_beat_is_music(monkeypatch):
    """One held pitch over drums: no key (one pitch), but music, so it has a fingerprint."""
    stand_in_models(monkeypatch)
    result, v2 = analyse_array(PROBES["drone-with-drums"])
    assert v2["key"] is None and v2["tempo"]["bpm"] == pytest.approx(120, abs=1)
    assert v2["fingerprint"]["moods"]["danceability"]["value"] == 0.7


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
    reasons = result["v2"]["withheld"]["moods"]
    assert set(reasons) == set(fp["moods"])
    assert {reason["code"] for reason in reasons.values()} == {"non_music_style"}
    assert reasons["valence"]["reason"].startswith("the strongest style score is a Non-Music")


def test_no_fingerprint_when_no_model_part_works(monkeypatch):
    stand_in_models(monkeypatch, effnet=raises, musicnn=raises)
    result, fp = stand_in_fingerprint()
    assert fp is None and result["v2"]["withheld"]["fingerprint"]["code"] == "model_failed"


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
    v2 = check_result(body)
    assert v2["fingerprint"]["moods"]["danceability"] is None
    assert v2["fingerprint"]["moods"]["valence"] is None
    reasons = v2["withheld"]["moods"]
    assert (reasons["danceability"]["code"], reasons["valence"]["code"]) == (
        "model_failed",
        "out_of_range",
    )


def test_model_label_counts():
    assert len(DISCOGS_STYLES) == 400 and len(set(DISCOGS_STYLES)) == 400
    assert len(MSD_TAGS) == 50 and len(set(MSD_TAGS)) == 50
    assert DISCOGS_STYLES[0] == "Blues---Boogie Woogie" and MSD_TAGS[:2] == ("rock", "pop")


def test_no_fingerprint_without_models(monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", False)
    result, v2 = analyse_array(signals.drum_pattern(97))
    assert v2["gate"]["passed"]
    assert v2["fingerprint"] is None
    assert v2["analyzerVersion"] == f"2.3.4+{main.ESTIMATOR.name}"
    assert v2["withheld"]["fingerprint"] == {
        "code": "models_not_loaded",
        "reason": "the audio models are not loaded",
    }


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

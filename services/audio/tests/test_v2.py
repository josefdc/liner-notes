"""
AudioFeatures v2 (the `v2` block of /analyze) on generated audio, through the real analysis.

Every v2 result is checked against packages/contract/schemas/audio-features.schema.json after a
strict JSON round trip (json.dumps(allow_nan=False)): JSON Schema range checks accept NaN and
infinity, so without the round trip a NaN would pass. The schema states the gate with if/then:
a gate that did not pass has a reason, every measured block null and no key moments.

Tempo and key tests run with every estimator that is installed (librosa always, Essentia with
the "models" extra). Fingerprint tests need the models and are skipped without them.
"""

import json
import os

import jsonschema
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import estimators
import main
import signal_features
from model_labels import DISCOGS_STYLES, MSD_TAGS
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
    tempo_bounds,
    tones,
    white_noise,
)

SCHEMA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "packages", "contract", "schemas"
)
SCHEMA = json.load(open(os.path.join(SCHEMA_PATH, "audio-features.schema.json")))
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
MEASURED_BLOCKS = ["tempo", "key", "loudness", "beats", "energyContour", "sections", "fingerprint"]

ESTIMATOR_NAMES = ["librosa"] + (["essentia"] if estimators.ESSENTIA_AVAILABLE else [])
needs_models = pytest.mark.skipif(not main.MODELS_LOADED, reason="Essentia models not loaded")


def check_v2(v2: dict) -> dict:
    """Strict JSON round trip, the contract's JSON Schema, and the producer-side checks."""
    data = json.loads(json.dumps(v2, allow_nan=False))
    errors = sorted(VALIDATOR.iter_errors(data), key=lambda e: list(e.path))
    assert not errors, [f"{list(e.path)}: {e.message}" for e in errors]
    duration = data["window"]["durationSeconds"]
    if data["beats"]:
        times = data["beats"]["times"]
        assert times == sorted(times) and all(0 <= t <= duration for t in times)
    for moment in data["keyMoments"]:
        assert 0 <= moment["time"] <= duration
    for segment in (data["sections"] or {}).get("segments", []):
        assert 0 <= segment["start"] < segment["end"] <= duration
    moods = ((data["fingerprint"] or {}).get("moods")) or {}
    for score in moods.values():
        if score is not None:
            low, high = score["range"]
            assert low <= score["value"] <= high
    return data


@pytest.fixture(scope="module")
def analyse(tmp_path_factory):
    """
    Writes a signal, analyses it with the given estimator (the service default when None) and
    returns (v1 result, checked v2 block).
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
        return result, check_v2(result["v2"])

    return run


def drum_pattern(bpm: float, seconds: float = 30.0, seed: int = 7) -> np.ndarray:
    """Kick on 1 and 3, snare on 2 and 4, eighth-note hats, and an Am-F-C-G pad, one bar each."""
    rng = np.random.default_rng(seed)
    sr = FIXTURE_SR
    y = np.zeros(int(seconds * sr))
    beat = 60.0 / bpm

    def add(start, sig):
        i = round(start * sr)
        j = min(len(y), i + len(sig))
        if i < len(y):
            y[i:j] += sig[: j - i]

    t = np.arange(int(0.25 * sr)) / sr
    kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.12)
    snare = (0.6 * rng.standard_normal(len(t)) + 0.4 * np.sin(2 * np.pi * 190 * t)) * np.exp(
        -t / 0.06
    )
    th = np.arange(int(0.05 * sr)) / sr
    hat = np.diff(rng.standard_normal(len(th) + 1)) * np.exp(-th / 0.015)
    bar = 4 * beat
    tb = np.arange(int(bar * sr)) / sr
    chords = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
    start, n = 0.0, 0
    while start < seconds:
        for b in range(4):
            if b % 2 == 0:
                add(start + b * beat, 0.8 * kick)
            else:
                add(start + b * beat, 0.5 * snare)
            add(start + b * beat, 0.15 * hat)
            add(start + (b + 0.5) * beat, 0.1 * hat)
        freqs = [440 * 2 ** ((m - 69) / 12) for m in chords[n % 4]]
        pad = sum(np.sin(2 * np.pi * f * tb) + 0.3 * np.sin(4 * np.pi * f * tb) for f in freqs)
        add(start, 0.12 * pad * np.minimum(1, tb / 0.05) * np.exp(-tb / (1.5 * bar)))
        start += bar
        n += 1
    return (0.8 * y / np.max(np.abs(y))).astype(np.float32)


def colored_noise(alpha: float, seconds: float = 10.0, rms: float = 0.2, seed: int = 5):
    """Noise with a 1/f^alpha power spectrum: pink for alpha = 1, brown for 2."""
    rng = np.random.default_rng(seed)
    n = int(seconds * FIXTURE_SR)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / FIXTURE_SR)
    freqs[0] = freqs[1]
    y = np.fft.irfft(spectrum / freqs ** (alpha / 2), n)
    return (rms * y / np.sqrt(np.mean(y**2))).astype(np.float32)


def noise_bursts(bpm: float = 120, seconds: float = 30.0) -> np.ndarray:
    """A hi-hat-like track: 50 ms noise bursts on every eighth note (rhythm without pitch)."""
    rng = np.random.default_rng(11)
    y = np.zeros(int(seconds * FIXTURE_SR))
    th = np.arange(int(0.05 * FIXTURE_SR)) / FIXTURE_SR
    burst = rng.standard_normal(len(th)) * np.exp(-th / 0.015)
    for start in np.arange(0, seconds - 0.1, 30 / bpm):
        i = round(start * FIXTURE_SR)
        y[i : i + len(burst)] += burst
    return (0.5 * y / np.max(np.abs(y))).astype(np.float32)


def triad_hits(times, gains, seconds: float = 30.0, floor: float = 0.01) -> np.ndarray:
    """A quiet A major triad with louder hits of the same chord at `times`, decaying in 0.3 s."""
    t = np.arange(int(seconds * FIXTURE_SR)) / FIXTURE_SR
    chord = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.18, 329.63)) / 3
    envelope = np.full_like(t, floor)
    for start, gain in zip(times, gains, strict=True):
        hit = t >= start
        envelope[hit] += gain * np.exp(-(t[hit] - start) / 0.3)
    return (0.8 * chord * envelope).astype(np.float32)


def chord_blocks(chords, block_seconds: float = 10.0, bpm: float = 120) -> np.ndarray:
    """Each chord (MIDI notes) struck on every beat for block_seconds, one block after another."""
    beat = 60.0 / bpm
    t = np.arange(int(beat * FIXTURE_SR)) / FIXTURE_SR
    envelope = np.exp(-t / 0.4) * (1 - np.exp(-t / 0.005))

    def strike(notes):
        freqs = [440 * 2 ** ((m - 69) / 12) for m in notes]
        return envelope * sum(
            0.6**k * np.sin(2 * np.pi * f * (k + 1) * t) for f in freqs for k in range(4)
        )

    y = np.concatenate(
        [strike(chord) for chord in chords for _ in range(round(block_seconds / beat))]
    )
    return (0.8 * y / np.max(np.abs(y))).astype(np.float32)


# --- the schema and the response -----------------------------------------------------------


def test_the_schema_enforces_the_gate():
    """The committed schema rejects a gated result that still measures something."""
    gated = {
        "version": 2,
        "analyzerVersion": main.analyzer_version_v2(),
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
        json.dumps({**gated, "window": {"durationSeconds": float("nan")}}, allow_nan=False)


def test_analyze_endpoint_returns_a_valid_v2_block(monkeypatch, tmp_path):
    path = tmp_path / "preview.mp3"
    sf.write(path, drum_pattern(97), FIXTURE_SR, format="MP3")

    async def fake_download(url):
        return str(path)

    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(main, "download_preview", fake_download)
    with TestClient(main.app) as client:
        response = client.post("/analyze", json={"preview_url": "https://p.scdn.co/a.mp3"})
    assert response.status_code == 200, response.text
    body = response.json()
    v2 = check_v2(body["v2"])
    assert v2["gate"] == {"passed": True, "reason": None}
    assert v2["analyzerVersion"] == main.analyzer_version_v2()
    assert v2["analyzerVersion"].startswith(f"{main.ANALYZER_VERSION}+{main.ESTIMATOR.name}")
    assert body["keyMoments"] == v2["keyMoments"]
    assert not path.exists()


def test_one_decode_and_one_chromagram_per_analysis(analyse, monkeypatch):
    """The preview is decoded once and the chromagram, STFT and onset envelope computed once."""
    import librosa

    calls = {"load": 0, "chroma_cqt": 0, "stft": 0, "onset_strength": 0}

    def counting(module, name):
        original = getattr(module, name)

        def wrapper(*args, **kwargs):
            calls[name] += 1
            return original(*args, **kwargs)

        monkeypatch.setattr(module, name, wrapper)

    counting(librosa, "load")
    counting(librosa.feature, "chroma_cqt")
    counting(librosa, "stft")
    counting(librosa.onset, "onset_strength")
    _, v2 = analyse(drum_pattern(97), "WAV")
    assert v2["gate"]["passed"]
    assert calls == {"load": 1, "chroma_cqt": 1, "stft": 1, "onset_strength": 1}
    assert not hasattr(main, "MonoLoader")


# --- tempo -------------------------------------------------------------------------------


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
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
    # The v1 field still reports the beat tracker's grid (unchanged until the API reads v2).
    assert result["bpm"] in tempo_bounds(bpm)


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
def test_tempo_of_a_44k_stereo_mp3(analyse, estimator):
    _, v2 = analyse(split_click_track_stereo(), "MP3", sr=PREVIEW_SR, estimator=estimator)
    assert v2["tempo"]["bpm"] == pytest.approx(120, abs=1.0)


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
@pytest.mark.parametrize("bpm", [97, 128])
def test_tempo_of_a_drum_pattern(analyse, bpm, estimator):
    """Kick, snare, hats and chords: the beat, not the bar or the eighth notes."""
    _, v2 = analyse(drum_pattern(bpm), "MP3", estimator=estimator)
    assert v2["tempo"]["bpm"] == pytest.approx(bpm, abs=1.0)
    assert v2["tempo"]["confidence"] >= 0.5


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
@pytest.mark.parametrize(
    "make",
    [
        lambda: a_major_triad(),
        lambda: tones((440.0,)),
        lambda: progression(C_MAJOR_PROGRESSION),
        lambda: progression(A_MINOR_PROGRESSION),
    ],
    ids=["triad", "440Hz", "C-F-G-C", "Am-Dm-E-Am"],
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


@pytest.mark.skipif(not estimators.ESSENTIA_AVAILABLE, reason="essentia not installed")
def test_essentia_tempo_is_withheld_at_low_confidence(analyse):
    """Essentia scores a 6 s click track 0 of 5.32 (it ignores the first 5 s): no tempo."""
    _, v2 = analyse(click_track(120, seconds=6.0), "WAV", estimator="essentia")
    assert v2["gate"]["passed"]
    assert v2["tempo"] is None


def test_refined_tempo_never_changes_octave():
    beats = np.arange(40) * 0.5  # exactly 120 BPM
    assert estimators.refine_bpm(beats, 117.45) == pytest.approx(120.0, abs=1e-6)
    assert estimators.refine_bpm(beats, 60.0) == 60.0  # every other beat: left alone
    skipped = np.delete(beats, [5, 17])
    assert estimators.refine_bpm(skipped, 118.0) == pytest.approx(120.0, abs=1e-6)


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
def test_tempo_beat_grid_follows_the_clicks(analyse, estimator):
    """Beats in preview time, on the clicks (from t = 0.3 s); trackers may need a beat or two."""
    _, v2 = analyse(click_track(120, offset=0.3), "WAV", estimator=estimator)
    times = np.array(v2["beats"]["times"])
    assert len(times) >= 50
    assert np.median(np.diff(times)) == pytest.approx(0.5, abs=0.01)
    off = np.abs((times - 0.3) / 0.5 - np.round((times - 0.3) / 0.5)) * 0.5
    assert np.mean(off <= 0.03) >= 0.9, times


# --- key ---------------------------------------------------------------------------------


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
@pytest.mark.parametrize("fmt", FORMATS)
def test_key_of_the_a_major_triad(analyse, fmt, estimator):
    result, v2 = analyse(a_major_triad(), fmt, estimator=estimator)
    key = v2["key"]
    assert (key["tonic"], key["mode"]) == ("A", "major")
    assert key["strength"] >= 0.7
    assert key["method"].startswith(estimator)
    assert (result["key"], result["mode"]) == ("A", "Major")


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
def test_key_of_a_44k_stereo_mp3(analyse, estimator):
    _, v2 = analyse(split_triad_stereo(), "MP3", sr=PREVIEW_SR, estimator=estimator)
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == ("A", "major")


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
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


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
@pytest.mark.parametrize(
    ("root", "tonic"), [(233.08, "A#"), (311.13, "D#"), (207.65, "G#"), (277.18, "C#")]
)
def test_key_names_are_sharps(analyse, root, tonic, estimator):
    """Bb, Eb, Ab and Db major triads (Essentia names them with flats) come out as sharps."""
    freqs = [root, root * 2 ** (4 / 12), root * 2 ** (7 / 12)]
    _, v2 = analyse(tones(freqs), "WAV", estimator=estimator)
    assert (v2["key"]["tonic"], v2["key"]["mode"]) == (tonic, "major")


@pytest.mark.parametrize("estimator", ESTIMATOR_NAMES)
@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize(
    "make",
    [
        lambda: tones((440.0,)),
        lambda: 0.2 * sum(0.5**k * tones((50.0 * (k + 1),)) for k in range(6)),
    ],
    ids=["440Hz", "50Hz-hum"],
)
def test_no_key_for_a_single_pitch(analyse, make, fmt, estimator):
    """A tone has one pitch class (A major from WAV, A minor from MP3 in v1); hum two."""
    _, v2 = analyse(make().astype(np.float32), fmt, estimator=estimator)
    assert v2["gate"]["passed"]
    assert v2["key"] is None


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
    ("pink-noise", lambda: colored_noise(1), "noise"),
    ("brown-noise", lambda: colored_noise(2), "noise"),
    ("1s-click-track", lambda: click_track(120, seconds=1.0), "too_short"),
    ("1s-triad", lambda: a_major_triad(seconds=1.0), "too_short"),
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
    assert (result["bpm"], result["key"], result["mode"]) == (None, None, None)
    assert result["keyMoments"] == []
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
        lambda: noise_bursts(),
        lambda: a_major_triad() + white_noise(rms=0.1),
        lambda: a_major_triad(gain=0.02),
        lambda: drum_pattern(97),
    ],
    ids=["noise-bursts-in-rhythm", "triad-under-noise", "quiet-triad", "drum-pattern"],
)
def test_structured_input_passes_the_gate(analyse, make):
    """Rhythm made of noise, a chord under noise, a quiet chord: measured, not gated."""
    _, v2 = analyse(make().astype(np.float32), "MP3")
    assert v2["gate"] == {"passed": True, "reason": None}
    assert v2["loudness"] is not None and v2["energyContour"] is not None


def test_the_gate_withholds_models_on_silence(analyse, monkeypatch):
    def fail(audio):
        raise AssertionError("a model ran on gated input")

    monkeypatch.setattr(main, "MODELS_LOADED", True)
    monkeypatch.setattr(main, "_models", dict.fromkeys(["styles", "effnet", "tags"], fail))
    _, v2 = analyse(np.zeros(10 * FIXTURE_SR, dtype=np.float32), "WAV")
    assert v2["fingerprint"] is None


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
    assert hop == pytest.approx(2048 / main.SAMPLE_RATE, abs=1e-4)
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
    ordered like the hits, and an onset and a drop. (v1 gave every peak 1.0, every onset 0.8 and every harmonic change
    0.7, and took the earliest candidates, so nothing came after about 20 s.)
    """
    result, v2 = analyse(triad_hits(HIT_TIMES, HIT_GAINS), fmt)
    moments = v2["keyMoments"]
    assert result["keyMoments"] == moments
    peaks = [m for m in moments if m["type"] == "energy_peak"]
    found = []
    for time in HIT_TIMES:
        near = [m for m in peaks if abs(m["time"] - (time + 0.25)) <= 0.75]
        assert near, (time, moments)
        found.append(near[0]["intensity"])
    order = np.argsort(HIT_GAINS)
    assert list(np.argsort(found)) == list(order), found
    assert max(found) == pytest.approx(1.0, abs=0.05)
    assert min(found) < 0.3
    for kind in ("onset", "energy_drop"):
        assert len([m for m in moments if m["type"] == kind]) == len(HIT_TIMES), moments
    assert any(m["time"] >= 25 for m in moments)


def test_key_moments_after_twenty_seconds(analyse):
    """A quiet tone, four times louder from 12 s, and a loud noise burst at 25-26 s."""
    t = np.arange(30 * FIXTURE_SR) / FIXTURE_SR
    y = 0.05 * np.sin(2 * np.pi * 220 * t)
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
    _, v2 = analyse(drum_pattern(128), "WAV")
    times = [m["time"] for m in v2["keyMoments"]]
    assert 1 <= len(times) <= signal_features.MAX_KEY_MOMENTS
    assert times == sorted(times)
    for kind in {m["type"] for m in v2["keyMoments"]}:
        same = [m["time"] for m in v2["keyMoments"] if m["type"] == kind]
        assert np.all(np.diff(same) >= signal_features.MIN_MOMENT_SPACING_S - 0.011)
    # One per sixth of the window at least, wherever the signal has something.
    assert {int(t // 5) for t in times} == set(range(6))


def test_sections_follow_the_harmony(analyse):
    """C major, F# major, C major (10 s each, a chord on every beat): sections A, B, A."""
    c, f_sharp = (48, 60, 64, 67), (54, 66, 70, 73)
    _, v2 = analyse(chord_blocks([c, f_sharp, c]), "MP3")
    sections = v2["sections"]
    assert sections["method"] == "novelty-on-beat-chroma"
    assert [s["label"] for s in sections["segments"]] == ["A", "B", "A"]
    starts = [s["start"] for s in sections["segments"]]
    assert (
        starts[0] == 0
        and starts[1] == pytest.approx(10, abs=1)
        and starts[2] == pytest.approx(20, abs=1)
    )
    assert sections["segments"][-1]["end"] == pytest.approx(30, abs=0.05)
    changes = [m["time"] for m in v2["keyMoments"] if m["type"] == "harmonic_change"]
    assert any(abs(t - 10) <= 1 for t in changes) and any(abs(t - 20) <= 1 for t in changes)


def test_steady_material_is_one_section(analyse):
    _, v2 = analyse(a_major_triad(), "WAV")
    assert [s["label"] for s in v2["sections"]["segments"]] == ["A"]


# --- fingerprint -------------------------------------------------------------------------


def test_model_labels_match_the_model_outputs():
    assert len(DISCOGS_STYLES) == 400 and len(set(DISCOGS_STYLES)) == 400
    assert len(MSD_TAGS) == 50 and len(set(MSD_TAGS)) == 50
    assert DISCOGS_STYLES[0] == "Blues---Boogie Woogie" and MSD_TAGS[:2] == ("rock", "pop")


def test_no_fingerprint_without_models(analyse, monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", False)
    result, v2 = analyse(drum_pattern(97), "WAV")
    assert v2["gate"]["passed"]
    assert v2["fingerprint"] is None
    assert v2["analyzerVersion"] == f"{main.ANALYZER_VERSION}+{main.ESTIMATOR.name}"
    assert result["valence"] is None and result["danceability"] is None


def test_valence_mapping_is_continuous():
    """DEAM valence (1-9) maps linearly onto v1's 0-1; the old mapping jumped at 1.5."""

    def v1_valence(raw):
        moods = {"valence": {"value": raw}}
        return main.v1_perceptual({"moods": moods})["valence"]

    assert v1_valence(1.49) == pytest.approx(v1_valence(1.51), abs=0.01)
    assert (v1_valence(1.0), v1_valence(5.0), v1_valence(9.0)) == (0.0, 0.5, 1.0)


@needs_models
@pytest.mark.parametrize("fmt", FORMATS)
def test_fingerprint_with_the_models(analyse, fmt):
    result, v2 = analyse(drum_pattern(97), fmt)
    fp = v2["fingerprint"]
    assert fp is not None
    styles = fp["styles"]
    assert styles["model"] == {"id": "discogs-effnet-bs64-1", "licence": "CC BY-NC-SA 4.0"}
    assert len(styles["top"]) == main.STYLE_TOP_K
    scores = [s["score"] for s in styles["top"]]
    assert scores == sorted(scores, reverse=True) and 0 < scores[0] <= 1
    assert all(s["label"] in DISCOGS_STYLES for s in styles["top"])
    tags = fp["tags"]
    assert tags["model"]["id"] == "msd-musicnn-1"
    assert sorted(s["label"] for s in tags["scores"]) == sorted(MSD_TAGS)
    moods = fp["moods"]
    assert set(moods) == {"danceability", "acoustic", "instrumental", "valence", "arousal"}
    for name, score in moods.items():
        assert score is not None, name
        assert score["basis"] == "model" and score["model"]["licence"] == "CC BY-NC-SA 4.0"
    assert moods["valence"]["range"] == [1, 9] and moods["arousal"]["range"] == [1, 9]
    assert moods["valence"]["model"]["id"] == "deam-msd-musicnn-2"
    assert moods["danceability"]["range"] == [0, 1]
    assert result["valence"] == pytest.approx((moods["valence"]["value"] - 1) / 8, abs=0.001)
    assert result["danceability"] == pytest.approx(moods["danceability"]["value"], abs=0.001)
    assert "discogs-effnet-bs64-1" in v2["analyzerVersion"]


@needs_models
def test_fingerprint_heads_fail_alone(analyse, monkeypatch):
    def broken(embeddings):
        raise RuntimeError("head failed")

    monkeypatch.setitem(main._models, "danceability", broken)
    _, v2 = analyse(drum_pattern(97), "WAV")
    moods = v2["fingerprint"]["moods"]
    assert moods["danceability"] is None
    assert moods["valence"] is not None and v2["fingerprint"]["styles"] is not None


@needs_models
def test_models_after_essentia_estimators_do_not_flood_the_log(analyse, capfd):
    """Essentia logs "No network created" per frame once the newest Essentia network is gone."""
    for _ in range(2):
        analyse(drum_pattern(97), "WAV")
    assert "No network created" not in capfd.readouterr().err

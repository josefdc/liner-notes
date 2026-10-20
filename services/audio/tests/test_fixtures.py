"""
Measurements on generated audio, through the real analysis (no mocks).

The fixtures are synthesised at test time with numpy and written with soundfile, as WAV and
as MP3 (the preview format), so the tests also cover decoding through libsndfile:

- click tracks at 85, 120, 140 and 174 BPM (30 s, like a preview);
- an A major triad (A3, C#4, E4);
- digital silence, a 1 s clip and white noise.

Known gaps are marked xfail(strict=True) with the measured behaviour in the reason: the
analyzer has no minimum-length or confidence gate yet. A strict xfail fails as soon as the gap
is closed, so the marker has to be removed along with it.
"""

import math

import numpy as np
import pytest
import soundfile as sf

import main

SR = 22050
# Hop of the onset envelope that librosa.beat.beat_track uses by default.
HOP = 512
FORMATS = ["WAV", "MP3"]


def click_track(bpm: float, seconds: float = 30.0) -> np.ndarray:
    """10 ms bursts of a decaying 1 kHz tone, one per beat, starting at t = 0."""
    y = np.zeros(int(seconds * SR), dtype=np.float32)
    t = np.arange(int(0.01 * SR)) / SR
    burst = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t / 0.002)).astype(np.float32)
    period = 60.0 / bpm
    for beat in range(int(seconds / period) + 1):
        start = round(beat * period * SR)
        end = min(len(y), start + len(burst))
        y[start:end] += burst[: end - start]
    return 0.8 * y


def a_major_triad(seconds: float = 10.0) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (0.25 * sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.18, 329.63))).astype(
        np.float32
    )


def white_noise(seconds: float = 10.0) -> np.ndarray:
    return (0.3 * np.random.default_rng(1234).standard_normal(int(seconds * SR))).astype(np.float32)


@pytest.fixture(scope="module")
def analyse(tmp_path_factory):
    """Writes a signal in the given format and returns main.analyze_audio_file's result."""
    directory = tmp_path_factory.mktemp("fixtures")
    count = 0

    def run(y: np.ndarray, fmt: str) -> dict:
        nonlocal count
        count += 1
        path = directory / f"fixture-{count}.{fmt.lower()}"
        sf.write(path, y, SR, format=fmt)
        return main.analyze_audio_file(str(path))

    return run


def tempo_bounds(bpm: float) -> tuple[int, int]:
    """
    The tempo a correct estimate may report for a click track at `bpm`.

    beat_track reads the tempo off the autocorrelation of the onset envelope, so it can only
    report 60 * SR / (HOP * lag) BPM for a whole lag in frames (23.2 ms at 22.05 kHz). A
    correct estimate is one of the two representable tempi on either side of the true one,
    rounded to whole BPM like the service does. The resulting tolerance grows with the tempo:
    [83, 86] at 85, [117, 123] at 120, [136, 144] at 140 and [172, 185] at 174 BPM. A half- or
    double-tempo answer is outside these bounds and fails.
    """
    lag = 60 * SR / (HOP * bpm)
    return round(60 * SR / (HOP * math.ceil(lag))), round(60 * SR / (HOP * math.floor(lag)))


def test_tempo_bounds_bracket_the_true_tempo():
    assert tempo_bounds(85) == (83, 86)
    assert tempo_bounds(120) == (117, 123)
    assert tempo_bounds(140) == (136, 144)
    assert tempo_bounds(174) == (172, 185)


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize("bpm", [85, 120, 140, 174])
def test_click_track_tempo(analyse, bpm, fmt):
    result = analyse(click_track(bpm), fmt)
    low, high = tempo_bounds(bpm)
    assert result["bpm"] is not None
    assert low <= result["bpm"] <= high, f"{bpm} BPM click track measured as {result['bpm']}"
    assert result["duration"] == pytest.approx(30.0, abs=0.1)


@pytest.mark.parametrize("fmt", FORMATS)
def test_a_major_triad_is_a_major(analyse, fmt):
    result = analyse(a_major_triad(), fmt)
    assert (result["key"], result["mode"]) == ("A", "Major")


@pytest.mark.parametrize("fmt", FORMATS)
def test_silence_has_no_tempo_and_no_key(analyse, fmt):
    result = analyse(np.zeros(10 * SR, dtype=np.float32), fmt)
    assert result["bpm"] is None
    assert (result["key"], result["mode"]) == (None, None)
    assert result["energy"] == 0.0


@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_clip_is_analysed(analyse, fmt):
    result = analyse(click_track(120, seconds=1.0), fmt)
    assert result["duration"] == pytest.approx(1.0, abs=0.05)
    assert result["bpm"] is None or result["bpm"] > 0


@pytest.mark.xfail(
    strict=True,
    reason="no minimum-length gate: the two clicks of a 1 s clip are reported as a tempo "
    "(117 BPM) with no confidence attached",
)
@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_clip_has_no_tempo(analyse, fmt):
    assert analyse(click_track(120, seconds=1.0), fmt)["bpm"] is None


@pytest.mark.xfail(
    strict=True,
    reason="no key-strength threshold: white noise gets the best-correlating key "
    "(G Minor) with no confidence attached",
)
@pytest.mark.parametrize("fmt", FORMATS)
def test_noise_has_no_key(analyse, fmt):
    result = analyse(white_noise(), fmt)
    assert (result["key"], result["mode"]) == (None, None)


@pytest.mark.xfail(
    strict=True,
    reason="no onset-strength gate: white noise is reported with a tempo (129 BPM from WAV, "
    "96 BPM from MP3) and no confidence attached",
)
@pytest.mark.parametrize("fmt", FORMATS)
def test_noise_has_no_tempo(analyse, fmt):
    assert analyse(white_noise(), fmt)["bpm"] is None

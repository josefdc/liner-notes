"""
Measurements on generated audio, through the real analysis (no mocks).

The fixtures are synthesised at test time with numpy and written with soundfile, as WAV and
as MP3 (the preview format), so the tests also cover decoding through libsndfile:

- click tracks at 85, 120, 140 and 174 BPM (30 s, like a preview);
- an A major triad (A3, C#4, E4), and the progressions C-F-G-C and Am-Dm-E-Am;
- digital silence, a DC offset, 1 s clips and white noise;
- a click track and the triad as 44.1 kHz stereo MP3, like a real preview, with the material
  split across the channels so that only a correct downmix (and resampling) gives the answer.

These tests pin the v1 fields. The gate (signal_features.check_gate) nulls the v1 bpm, key and
mode of too-short, silent and noise-like input; energy is the mean RMS level in dBFS on 0-1.
The v2 block has its own tests in test_v2.py.
"""

import math

import numpy as np
import pytest
import soundfile as sf

import main

# Rate the fixtures are written at. It matches main.SAMPLE_RATE today, but the tests read the
# analysis rate from main, so a change there is caught rather than absorbed.
FIXTURE_SR = 22050
PREVIEW_SR = 44100
FORMATS = ["WAV", "MP3"]
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Chords as MIDI notes: C-F-G-C in C major, Am-Dm-E-Am in A (harmonic) minor. The relative
# pair shares almost every pitch class, so only the mode decision tells them apart.
C_MAJOR_PROGRESSION = [(48, 60, 64, 67), (53, 57, 60, 65), (55, 59, 62, 67), (48, 60, 64, 67)]
A_MINOR_PROGRESSION = [(45, 57, 60, 64), (50, 57, 62, 65), (52, 56, 59, 64), (45, 57, 60, 64)]


def click_track(
    bpm: float, seconds: float = 30.0, sr: int = FIXTURE_SR, offset: float = 0.0
) -> np.ndarray:
    """10 ms bursts of a decaying 1 kHz tone (0.8 peak), one per beat from t = offset."""
    y = np.zeros(int(seconds * sr), dtype=np.float32)
    t = np.arange(int(0.01 * sr)) / sr
    burst = (np.sin(2 * np.pi * 1000 * t) * np.exp(-t / 0.002)).astype(np.float32)
    period = 60.0 / bpm
    for beat in range(int(seconds / period) + 1):
        start = round((offset + beat * period) * sr)
        end = min(len(y), start + len(burst))
        y[start:end] += burst[: end - start]
    return 0.8 * y


def tones(freqs, seconds: float = 10.0, sr: int = FIXTURE_SR, gain: float = 1.0) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (0.25 * gain * sum(np.sin(2 * np.pi * f * t) for f in freqs)).astype(np.float32)


def a_major_triad(seconds: float = 10.0, sr: int = FIXTURE_SR, gain: float = 1.0) -> np.ndarray:
    return tones((220.0, 277.18, 329.63), seconds, sr, gain)


def progression(chords, chord_seconds: float = 2.0, cycles: int = 2) -> np.ndarray:
    """Piano-like notes (six harmonics, decaying), one chord every chord_seconds."""
    t = np.arange(int(chord_seconds * FIXTURE_SR)) / FIXTURE_SR
    envelope = np.exp(-t / 1.2) * (1 - np.exp(-t / 0.01))

    def note(midi):
        f = 440 * 2 ** ((midi - 69) / 12)
        return envelope * sum(0.6**k * np.sin(2 * np.pi * f * (k + 1) * t) for k in range(6))

    y = np.concatenate([sum(note(m) for m in chord) for _ in range(cycles) for chord in chords])
    return (0.8 * y / np.max(np.abs(y))).astype(np.float32)


def white_noise(seconds: float = 10.0, rms: float = 0.3, seed: int = 1234) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rms * rng.standard_normal(int(seconds * FIXTURE_SR))).astype(np.float32)


def split_click_track_stereo() -> np.ndarray:
    """
    120 BPM only in the downmix: each channel clicks at 60 BPM, the right one half a beat
    later (either channel alone measures 60 BPM).
    """
    left = click_track(60, sr=PREVIEW_SR)
    right = click_track(60, sr=PREVIEW_SR, offset=0.5)
    return np.stack([left, right], axis=1)


def split_triad_stereo() -> np.ndarray:
    """
    A major only in the downmix: C#4 and E4 on the left, A3 on the right (alone they measure
    C# Minor and A Minor).
    """
    left = tones((277.18, 329.63), sr=PREVIEW_SR)
    right = tones((220.0,), sr=PREVIEW_SR)
    return np.stack([left, right], axis=1)


@pytest.fixture(scope="module")
def analyse(tmp_path_factory):
    """Writes a signal in the given format and rate and returns analyze_audio_file's result."""
    directory = tmp_path_factory.mktemp("fixtures")
    count = 0

    def run(y: np.ndarray, fmt: str, sr: int = FIXTURE_SR) -> dict:
        nonlocal count
        count += 1
        path = directory / f"fixture-{count}.{fmt.lower()}"
        sf.write(path, y, sr, format=fmt)
        info = sf.info(path)
        assert (info.samplerate, info.channels) == (sr, 1 if y.ndim == 1 else y.shape[1])
        return main.analyze_audio_file(str(path))

    return run


def tempo_bounds(bpm: float) -> tuple[int, int]:
    """
    The tempi a correct estimate may report for a click track at `bpm`.

    beat_track reads the tempo off the autocorrelation of the onset envelope, so it can only
    report 60 * SAMPLE_RATE / (BEAT_HOP_LENGTH * lag) BPM for a whole lag in frames (23.2 ms
    at 22.05 kHz with a 512-sample hop). A correct estimate is one of the two representable
    tempi on either side of the true one, rounded to whole BPM like the service does: 83 or 86
    at 85, 117 or 123 at 120, 136 or 144 at 140, and 172 or 185 at 174 BPM. A half- or
    double-tempo answer, a value off this grid (another rate or hop than main's) or a value
    rounded differently is not one of them.
    """
    step = 60 * main.SAMPLE_RATE / main.BEAT_HOP_LENGTH
    lag = step / bpm
    return round(step / math.ceil(lag)), round(step / math.floor(lag))


def assert_in_range(result: dict, duration: float) -> None:
    """Every field is null or a plausible value, whatever the input."""
    bpm = result["bpm"]
    assert bpm is None or (isinstance(bpm, int) and 20 <= bpm <= 320)
    assert result["key"] is None or result["key"] in PITCH_CLASSES
    assert result["mode"] in ({None} if result["key"] is None else {"Major", "Minor"})
    assert 0.0 <= result["energy"] <= 1.0
    assert result["duration"] == pytest.approx(duration, abs=0.1)
    for moment in result["keyMoments"]:
        assert 0.0 <= moment["time"] <= result["duration"]
        assert 0.0 <= moment["intensity"] <= 1.0


# --- tempo -------------------------------------------------------------------------------


def test_tempo_bounds_bracket_the_true_tempo():
    # Pinned: a change to the analysis rate or hop changes the tempo grid and fails here.
    assert tempo_bounds(85) == (83, 86)
    assert tempo_bounds(120) == (117, 123)
    assert tempo_bounds(140) == (136, 144)
    assert tempo_bounds(174) == (172, 185)


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize("bpm", [85, 120, 140, 174])
def test_click_track_tempo(analyse, bpm, fmt):
    result = analyse(click_track(bpm), fmt)
    low, high = tempo_bounds(bpm)
    assert result["bpm"] in (low, high), f"{bpm} BPM click track measured as {result['bpm']}"
    assert result["duration"] == pytest.approx(30.0, abs=0.1)


def test_click_track_tempo_from_a_44k_stereo_mp3(analyse):
    result = analyse(split_click_track_stereo(), "MP3", sr=PREVIEW_SR)
    assert result["bpm"] in tempo_bounds(120)
    assert result["duration"] == pytest.approx(30.0, abs=0.1)


@pytest.mark.parametrize("fmt", FORMATS)
def test_click_track_onsets_fall_on_the_clicks(analyse, fmt):
    """Onset moments are within two onset frames (46 ms) of a click (clicks from t = 0.3 s)."""
    period, offset = 60.0 / 120, 0.3
    result = analyse(click_track(120, offset=offset), fmt)
    onsets = [m["time"] for m in result["keyMoments"] if m["type"] == "onset"]
    assert onsets
    for time in onsets:
        beat = round((time - offset) / period)
        assert abs(time - (offset + beat * period)) <= 0.046, result["keyMoments"]


# --- key and mode ------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", FORMATS)
def test_a_major_triad_is_a_major(analyse, fmt):
    result = analyse(a_major_triad(), fmt)
    assert (result["key"], result["mode"]) == ("A", "Major")


def test_a_major_triad_from_a_44k_stereo_mp3(analyse):
    result = analyse(split_triad_stereo(), "MP3", sr=PREVIEW_SR)
    assert (result["key"], result["mode"]) == ("A", "Major")
    assert result["duration"] == pytest.approx(10.0, abs=0.1)


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize(
    ("chords", "expected"),
    [(C_MAJOR_PROGRESSION, ("C", "Major")), (A_MINOR_PROGRESSION, ("A", "Minor"))],
    ids=["C-F-G-C", "Am-Dm-E-Am"],
)
def test_progression_key_and_mode(analyse, chords, expected, fmt):
    result = analyse(progression(chords), fmt)
    assert (result["key"], result["mode"]) == expected


# --- silence, short clips, noise ---------------------------------------------------------


@pytest.mark.parametrize("fmt", FORMATS)
def test_silence_has_no_tempo_and_no_key(analyse, fmt):
    result = analyse(np.zeros(10 * FIXTURE_SR, dtype=np.float32), fmt)
    assert result["bpm"] is None
    assert (result["key"], result["mode"]) == (None, None)
    assert result["energy"] == 0.0


@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_triad_is_too_short_for_a_key(analyse, fmt):
    """A 1 s cut of a steady chord gets no key or tempo, but the same energy as 10 s of it."""
    short = analyse(a_major_triad(seconds=1.0, gain=0.4), fmt)
    long = analyse(a_major_triad(seconds=10.0, gain=0.4), fmt)
    # Neither 0 nor clipped at 1, so comparing the two energies means something.
    assert 0.0 < long["energy"] < 1.0
    assert (long["key"], long["mode"]) == ("A", "Major")
    assert short["duration"] == pytest.approx(1.0, abs=0.05)
    assert short["bpm"] is None
    assert (short["key"], short["mode"]) == (None, None)
    assert short["keyMoments"] == []
    assert short["energy"] == pytest.approx(long["energy"], abs=0.05)


@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_click_clip_is_too_short_to_measure(analyse, fmt):
    """A 1 s cut of a click track is analysed without error, has the energy of 30 s of it, and
    gets no key (30 s of it does)."""
    short = analyse(click_track(120, seconds=1.0), fmt)
    long = analyse(click_track(120), fmt)
    assert_in_range(short, 1.0)
    assert long["key"] is not None
    assert (short["key"], short["mode"]) == (None, None)
    assert short["energy"] == pytest.approx(long["energy"], abs=0.05)


@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_clip_has_no_tempo(analyse, fmt):
    assert analyse(click_track(120, seconds=1.0), fmt)["bpm"] is None


@pytest.mark.parametrize("fmt", FORMATS)
def test_noise_is_analysed_with_values_in_range(analyse, fmt):
    assert_in_range(analyse(white_noise(), fmt), 10.0)


@pytest.mark.parametrize("fmt", FORMATS)
def test_noise_has_no_key(analyse, fmt):
    result = analyse(white_noise(), fmt)
    assert (result["key"], result["mode"]) == (None, None)


@pytest.mark.parametrize("fmt", FORMATS)
def test_noise_has_no_tempo(analyse, fmt):
    assert analyse(white_noise(), fmt)["bpm"] is None


# --- energy ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "make",
    [lambda gain: white_noise(rms=0.3 * gain), lambda gain: a_major_triad(gain=gain)],
    ids=["noise", "triad"],
)
def test_louder_signal_does_not_measure_lower_energy(analyse, make):
    gains = [0.02, 0.1, 0.25, 0.5, 1.0]
    energies = [analyse(make(gain), "WAV")["energy"] for gain in gains]
    assert all(0.0 <= e <= 1.0 for e in energies), energies
    assert energies == sorted(energies), energies


def test_energy_is_the_mean_rms_in_dbfs(analyse):
    """
    Pins the definition (README, "How it works"): energy = (20 log10(mean frame RMS) + 60) / 60,
    clipped to 0..1, with frames of 2048 samples after removing DC. Five seconds of noise at RMS
    0.05 then five at 0.15 have a mean frame RMS of 0.1 (-20 dBFS), so energy 0.667; the overall
    RMS (0.112) would give 0.675 and the peak frame RMS (0.15) 0.725. Changing the definition
    means bumping ANALYZER_VERSION and this test.
    """
    y = np.concatenate(
        [white_noise(seconds=5.0, rms=0.05, seed=1), white_noise(seconds=5.0, rms=0.15, seed=2)]
    )
    assert analyse(y, "WAV")["energy"] == pytest.approx(0.667, abs=0.004)


def test_audible_click_track_has_energy(analyse):
    # Mean frame RMS 0.011 (-39 dBFS): quiet, but not silence.
    assert analyse(click_track(120), "WAV")["energy"] == pytest.approx(0.35, abs=0.02)


def test_dc_offset_has_no_energy(analyse):
    result = analyse(np.full(10 * FIXTURE_SR, 0.5, dtype=np.float32), "WAV")
    assert result["energy"] in (None, 0.0)
    assert (result["bpm"], result["key"], result["mode"]) == (None, None, None)


def test_zero_length_file_has_no_energy(analyse):
    result = analyse(np.zeros(0, dtype=np.float32), "WAV")
    assert result["energy"] is None
    assert result["duration"] == 0.0
    assert (result["bpm"], result["key"], result["keyMoments"]) == (None, None, [])

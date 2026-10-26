"""
Measurements on generated audio, through the real analysis (no mocks).

The fixtures are synthesised at test time with numpy and written with soundfile, as WAV and
as MP3 (the preview format), so the tests also cover decoding through libsndfile:

- click tracks at 85, 120, 140 and 174 BPM (30 s, like a preview);
- an A major triad (A3, C#4, E4), and the progressions C-F-G-C and Am-Dm-E-Am;
- digital silence, a DC offset, 1 s clips and white noise;
- a click track and the triad as 44.1 kHz stereo MP3, like a real preview, with the material
  split across the channels so that only a correct downmix (and resampling) gives the answer.

These tests pin what the v2 block measures on them (tempo rounded to a whole BPM, key and mode,
loudness, duration, key moments) and why it withholds the rest; every result here is also
checked against the contract and its reasons (tests/checks.py). The v2 block has its own,
finer tests in test_v2.py.
"""

import numpy as np
import pytest
import soundfile as sf

import main
from tests.checks import check_result

# Rate the fixtures are written at (the analysis rate, estimators.SAMPLE_RATE).
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


def measured(v2: dict) -> dict:
    """What the tests below pin from a v2 block: null wherever the block measured nothing."""
    tempo, key, loudness = v2["tempo"], v2["key"], v2["loudness"]
    return {
        "bpm": None if tempo is None else round(tempo["bpm"]),
        "key": None if key is None else key["tonic"],
        "mode": None if key is None else key["mode"],
        "rms": None if loudness is None else loudness["rmsMean"],
        "duration": v2["window"]["durationSeconds"],
        "keyMoments": v2["keyMoments"],
        "withheld": {field: reason["code"] for field, reason in v2["withheld"].items()},
    }


@pytest.fixture(scope="module")
def analyse(tmp_path_factory):
    """
    Writes a signal in the given format and rate, analyses it with analyze_audio_file, checks
    the result and returns what it measured (measured()).
    """
    directory = tmp_path_factory.mktemp("fixtures")
    count = 0

    def run(y: np.ndarray, fmt: str, sr: int = FIXTURE_SR) -> dict:
        nonlocal count
        count += 1
        path = directory / f"fixture-{count}.{fmt.lower()}"
        sf.write(path, y, sr, format=fmt)
        info = sf.info(path)
        assert (info.samplerate, info.channels) == (sr, 1 if y.ndim == 1 else y.shape[1])
        return measured(check_result(main.analyze_audio_file(str(path))))

    return run


def assert_in_range(result: dict, duration: float) -> None:
    """Every field is null or a plausible value, whatever the input."""
    bpm = result["bpm"]
    assert bpm is None or (isinstance(bpm, int) and 20 <= bpm <= 320)
    assert result["key"] is None or result["key"] in PITCH_CLASSES
    assert result["mode"] in ({None} if result["key"] is None else {"major", "minor"})
    assert result["rms"] is None or 0.0 <= result["rms"] <= 1.0
    assert result["duration"] == pytest.approx(duration, abs=0.1)
    for moment in result["keyMoments"]:
        assert 0.0 <= moment["time"] <= result["duration"]
        assert 0.0 <= moment["intensity"] <= 1.0


# --- tempo -------------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize("bpm", [85, 120, 140, 174])
def test_click_track_tempo(analyse, bpm, fmt):
    """The tempo is refined from the beats, not the beat tracker's grid (120 read 117)."""
    result = analyse(click_track(bpm), fmt)
    assert result["bpm"] == bpm, f"{bpm} BPM click track measured as {result['bpm']}"
    assert result["duration"] == pytest.approx(30.0, abs=0.1)


def test_click_track_tempo_from_a_44k_stereo_mp3(analyse):
    result = analyse(split_click_track_stereo(), "MP3", sr=PREVIEW_SR)
    assert result["bpm"] == 120
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
    assert (result["key"], result["mode"]) == ("A", "major")


def test_a_major_triad_from_a_44k_stereo_mp3(analyse):
    result = analyse(split_triad_stereo(), "MP3", sr=PREVIEW_SR)
    assert (result["key"], result["mode"]) == ("A", "major")
    assert result["duration"] == pytest.approx(10.0, abs=0.1)


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize(
    ("chords", "expected"),
    [(C_MAJOR_PROGRESSION, ("C", "major")), (A_MINOR_PROGRESSION, ("A", "minor"))],
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
    assert result["rms"] is None  # gated: no loudness either
    assert result["withheld"]["tempo"] == result["withheld"]["key"] == "gate_silence"


@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_triad_is_too_short_for_a_key(analyse, fmt):
    """A 1 s cut of a steady chord measures nothing; 10 s of it gets its key and loudness."""
    short = analyse(a_major_triad(seconds=1.0, gain=0.4), fmt)
    long = analyse(a_major_triad(seconds=10.0, gain=0.4), fmt)
    assert 0.0 < long["rms"] < 1.0
    assert (long["key"], long["mode"]) == ("A", "major")
    assert short["duration"] == pytest.approx(1.0, abs=0.05)
    assert (short["bpm"], short["key"], short["mode"], short["rms"]) == (None,) * 4
    assert short["keyMoments"] == []
    assert set(short["withheld"].values()) == {"gate_too_short"}


@pytest.mark.parametrize("fmt", FORMATS)
def test_one_second_click_clip_is_too_short_to_measure(analyse, fmt):
    """A 1 s cut of a click track is analysed without error and measures nothing (30 s of it
    gets a tempo)."""
    short = analyse(click_track(120, seconds=1.0), fmt)
    long = analyse(click_track(120), fmt)
    assert_in_range(short, 1.0)
    assert long["bpm"] == 120
    assert (short["bpm"], short["key"], short["rms"]) == (None, None, None)


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
    assert result["withheld"]["key"] == "gate_noise"


@pytest.mark.parametrize("fmt", FORMATS)
def test_noise_has_no_tempo(analyse, fmt):
    assert analyse(white_noise(), fmt)["bpm"] is None


# --- loudness ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "make",
    [lambda gain: gain * click_track(120), lambda gain: a_major_triad(gain=gain)],
    ids=["click-track", "triad"],
)
def test_louder_signal_does_not_measure_lower_loudness(analyse, make):
    gains = [0.02, 0.1, 0.25, 0.5, 1.0]
    levels = [analyse(make(gain), "WAV")["rms"] for gain in gains]
    assert all(0.0 < level <= 1.0 for level in levels), levels
    assert levels == sorted(levels), levels


def test_audible_click_track_has_a_loudness(analyse):
    """Mean frame RMS 0.0112 (-39 dBFS): measured as it is, whatever scale a reader puts it on."""
    assert analyse(click_track(120), "WAV")["rms"] == pytest.approx(0.0112, abs=0.0002)


def test_quiet_music_has_a_loudness_above_silence(analyse):
    """
    The drum pattern peaking at -48 dBFS passes the gate, and its loudness is measured: mean
    frame RMS 0.000498 (-66.1 dBFS), the level the first service version's energy floor read as
    0.011.
    """
    from tests.signals import drum_pattern

    result = analyse(drum_pattern(97) * 10 ** (-48 / 20) / 0.8, "WAV")
    assert result["bpm"] == 97
    assert result["rms"] == pytest.approx(0.000498, rel=0.02)


def test_dc_offset_has_no_loudness(analyse):
    result = analyse(np.full(10 * FIXTURE_SR, 0.5, dtype=np.float32), "WAV")
    assert result["rms"] is None  # gated as silence
    assert (result["bpm"], result["key"], result["mode"]) == (None, None, None)
    assert result["withheld"]["loudness"] == "gate_silence"


def test_zero_length_file_has_no_loudness(analyse):
    result = analyse(np.zeros(0, dtype=np.float32), "WAV")
    assert result["rms"] is None
    assert result["duration"] == 0.0
    assert (result["bpm"], result["key"], result["keyMoments"]) == (None, None, [])
    assert result["withheld"]["loudness"] == "gate_too_short"

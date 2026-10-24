"""
Generated-audio controls: signals whose truth is known by construction, run through the service
next to the annotated datasets. Most have nothing to measure for a field (no key in a chromatic
cluster, no single tempo in an accelerando, no music at all in a siren in noise); the others
carry a value the service is known to have lost or got wrong (a key under a loud bass, 140 BPM
read as 70). They come from the issue's lists of defects found with generated probes, and
from the probe sets of the service's own tests (one held pitch, music without a beat, band
mixes, one source over drums, pitchless rhythm).

The generators of the service's own tests (services/audio/tests/signals.py and music.py,
deterministic, 22.05 kHz mono) are reused; the rest are below, deterministic as well. A control
is written to a WAV file (or MP3 where the codec is the point) and analysed whole, as the
service gets a preview.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache

import numpy as np
import soundfile as sf

from . import service

SR = 22050
NONE = None  # truth: nothing to measure for the field
NOT_SCORED = "not scored"
ANY = "any key"  # truth: music in more than one key (E dorian): some key, none in particular


@cache
def _module(name: str):
    """One of the service's test generators, loaded by path under a name of its own."""
    path = service.SERVICE_DIR / "tests" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"liner_notes_audio_test_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def signals():
    return _module("signals")


def music():
    return _module("music")


@dataclass(frozen=True)
class Control:
    name: str
    group: str
    description: str
    make: Callable[[], np.ndarray]
    # Truths: a BPM or NONE; (tonic, mode) or NONE; "pass" or "noise"; NOT_SCORED to leave a
    # field out (its truth is not known or not the point of the control).
    tempo: float | None | str = NOT_SCORED
    key: tuple[str, str] | None | str = NOT_SCORED
    gate: str = "pass"
    fmt: str = "WAV"
    # libsndfile's MP3 compression level (higher: lower bit rate; 0.85 gives 32 kbit/s at 22.05
    # kHz mono, constant bit rate); the bit rate written is measured and recorded.
    mp3_level: float = 0.0


# --- generators ----------------------------------------------------------------------------------


def _t(seconds: float = 30.0) -> np.ndarray:
    return np.arange(int(seconds * SR)) / SR


def _norm(y: np.ndarray, peak: float = 0.8) -> np.ndarray:
    top = float(np.max(np.abs(y)))
    return (peak * y / top).astype(np.float32) if top > 0 else y.astype(np.float32)


def _rms(y: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.asarray(y, dtype=np.float64) ** 2)))


def _mix(*parts: tuple[np.ndarray, float]) -> np.ndarray:
    """Parts at relative levels (dB of RMS), each first brought to RMS 1."""
    n = min(len(p) for p, _ in parts)
    y = sum(p[:n] / _rms(p[:n]) * 10 ** (db / 20) for p, db in parts)
    return _norm(y)


def inharmonic_fm(carrier: float = 300.0, ratio: float = 2**0.5, index: float = 3.0):
    """A sustained FM tone whose modulator is an irrational multiple of the carrier."""
    t = _t()
    return _norm(np.sin(2 * np.pi * carrier * t + index * np.sin(2 * np.pi * carrier * ratio * t)))


def noise_bands(centres=(1200.0, 2100.0), width: float = 30.0, seed: int = 4) -> np.ndarray:
    """Whistling noise: white noise through narrow bands around `centres`."""
    rng = np.random.default_rng(seed)
    n = int(30 * SR)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    gain = sum(np.exp(-0.5 * ((freqs - c) / width) ** 2) for c in centres)
    return _norm(np.fft.irfft(spectrum * gain, n))


def hum_and_tone() -> np.ndarray:
    """50 Hz mains hum with a 440 Hz tone over it."""
    s = signals()
    t = _t()
    return _norm(s.hum(50.0) + 0.3 * np.sin(2 * np.pi * 440.0 * t))


def compound_meter(bpm: float = 60.0) -> np.ndarray:
    """12/8 at `bpm` dotted quarters: kick on beats 1 and 3, snare on 2 and 4, eighth-note hats."""
    m = music()
    pattern = [(0, "kick", 1.0), (6, "snare", 0.8), (12, "kick", 1.0), (18, "snare", 0.8)]
    pattern += [(s, "hat", 0.2) for s in range(0, 24, 2)]
    # music.drums takes sixteenths of a 4/4 bar; a 12/8 bar of 4 dotted quarters at `bpm` is a
    # 4/4 bar of 24 "sixteenths" at bpm * 1.5 / 1.5: place the hits on that grid instead.
    return _drums_on_grid(pattern, bar_seconds=4 * 60.0 / bpm, steps=24, kit=m)


def _drums_on_grid(pattern, bar_seconds: float, steps: int, kit, seconds: float = 30.0):
    s = signals()
    k = s.Kit()
    sounds = {"kick": k.kick, "snare": k.snare, "hat": k.hat}
    y = np.zeros(int(seconds * SR))
    start = 0.0
    while start < seconds:
        for step, name, gain in pattern:
            s.place(y, start + step * bar_seconds / steps, gain * sounds[name])
        start += bar_seconds
    return _norm(y)


DNB = [(0, "kick", 1.0), (10, "kick", 0.9), (4, "snare", 1.0), (12, "snare", 1.0)] + [
    (s, "hat", 0.2) for s in range(0, 16, 2)
]


def drum_and_bass(bpm: float = 174.0) -> np.ndarray:
    """A two-step drum-and-bass break at `bpm`: kick on 1 and the and of 3, snare on 2 and 4."""
    return _drums_on_grid(DNB, bar_seconds=4 * 60.0 / bpm, steps=16, kit=music())


def chords_under_loud_drums(db: float = 18.0) -> np.ndarray:
    """The D major pad progression with a 120 BPM drum kit `db` louder (RMS)."""
    s = signals()
    return _mix((s.chord_pad_progression(), 0.0), (s.drums_only(120, seed=2), db))


def sparse_melody(seed: int = 10) -> np.ndarray:
    """A sparse D major melody (piano), one note every 1-2.5 s."""
    s = signals()
    rng = np.random.default_rng(seed)
    scale = [62, 64, 66, 67, 69, 71, 73, 74]
    weights = np.array([3, 1, 2, 1, 2, 1, 1, 2], dtype=float)
    y = np.zeros(int(30 * SR))
    t = 0.3
    while t < 29.0:
        note = scale[rng.choice(len(scale), p=weights / weights.sum())]
        s.place(y, t, s.piano_note(s.hz(note), 2.0))
        t += float(rng.uniform(1.0, 2.5))
    return _norm(y)


def bugle_call() -> np.ndarray:
    """A bugle call (harmonics 3-6 of C3, brass-like) over a held C2 pedal."""
    m = music()
    s = signals()
    rng = np.random.default_rng(6)
    y = np.zeros(int(30 * SR))
    t = 0.0
    while t < 29.0:
        harmonic = int(rng.choice([3, 4, 5, 6]))
        length = float(rng.choice([0.25, 0.5, 1.0]))
        f0 = np.full(int(length * SR), 130.81 * harmonic / 2)
        note = m.additive(f0, m.BRASS) * np.minimum(1, np.arange(f0.size) / (0.02 * SR))
        s.place(y, t, note * np.minimum(1, (f0.size - np.arange(f0.size)) / (0.02 * SR)))
        t += length + 0.05
    pedal = m.additive(np.full(int(30 * SR), 65.41), [1, 0.6, 0.4, 0.3, 0.2])
    return _mix((y, 0.0), (pedal, -6.0))


def band_mix(progression: str, bass_db: float, drums: str = "ROCK") -> np.ndarray:
    """music.band_mix with a rock or a trap beat."""
    m = music()
    if drums == "ROCK":
        return m.band_mix(progression, bass_db=bass_db)
    chords_, (tonic, mode) = m.PROGRESSIONS[progression]
    bpm = 70
    bar = 240.0 / bpm
    lowest = [c[0] - 12 if c[0] - 12 <= 39 else c[0] - 24 for c in chords_]
    roots = [note for note in lowest for _ in range(2)]
    parts = [
        (m.drums(m.TRAP, bpm), 0.0),
        (m.bass(roots, bar), bass_db),
        (m.chords(chords_, bar), -4),
    ]
    return m.mix(*parts)


def chord_over_root() -> np.ndarray:
    """A sustained C major chord over its root one and two octaves down (no beat)."""
    return music().ambient_pad(chord=(60, 64, 67))


def chords_over_pedal(db: float = 10.0) -> np.ndarray:
    """C-F-G-C pads, one every 3 s, over a C2 pedal `db` louder (no beat)."""
    m = music()
    s = signals()
    y = np.zeros(int(30 * SR))
    for k, start in enumerate(np.arange(0.0, 30.0, 3.0)):
        chord = [(60, 64, 67), (60, 65, 69), (59, 62, 67), (60, 64, 67)][k % 4]
        s.place(y, float(start), s.pad([s.hz(n) for n in chord], 3.0))
    pedal = m.additive(np.full(int(30 * SR), 65.41), [1, 0.6, 0.4, 0.3, 0.2])
    return _mix((y, 0.0), (pedal, db))


def speech_over_piano() -> np.ndarray:
    """Synthetic speech over the rubato C major piano line, the speech 6 dB louder."""
    return _mix((music().speech(), 6.0), (signals().piano_line(), 0.0))


def babble(talkers: int) -> np.ndarray:
    """`talkers` synthetic voices at once (different seeds and pitch ranges)."""
    m = music()
    ranges = [(95.0, 160.0), (180.0, 280.0), (110.0, 190.0), (200.0, 320.0)]
    voices = [m.speech(seed=4 + k, low=lo, high=hi) for k, (lo, hi) in enumerate(ranges[:talkers])]
    return _mix(*((v, 0.0) for v in voices))


def noise_hum_whine() -> np.ndarray:
    """Pink noise with 50 Hz hum and an unrelated 1 kHz whine, each 6 dB under it."""
    s = signals()
    bed = s.colored_noise(1, seconds=30.0, rms=1.0, seed=9)
    whine = np.sin(2 * np.pi * 1000.0 * _t())
    return _mix((bed, 0.0), (s.hum(50.0), -6.0), (whine, -6.0))


def brown_noise_hum() -> np.ndarray:
    """Brown noise with 50 Hz mains hum 6 dB under it."""
    s = signals()
    return _mix((s.colored_noise(2, seconds=30.0, rms=1.0, seed=9), 0.0), (s.hum(50.0), -6.0))


def _sweep(f: np.ndarray, harmonics=(1.0,)) -> np.ndarray:
    phase = 2 * np.pi * np.cumsum(f) / SR
    return sum(a * np.sin((k + 1) * phase) for k, a in enumerate(harmonics))


def siren_in_noise(snr_db: float = 0.0) -> np.ndarray:
    """A two-tone siren sweeping 600-1200 Hz every 3 s in pink noise."""
    s = signals()
    t = _t()
    f = 900.0 + 300.0 * np.sin(2 * np.pi * t / 3.0)
    return _mix(
        (s.colored_noise(1, seconds=30.0, rms=1.0, seed=7), 0.0), (_sweep(f, (1, 0.3)), snr_db)
    )


def engine_rev() -> np.ndarray:
    """An engine revving: harmonics of 30-120 Hz rising and falling every 5 s, in brown noise."""
    s = signals()
    t = _t()
    f = 75.0 + 45.0 * np.sin(2 * np.pi * t / 5.0)
    tone = _sweep(f, (1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2))
    return _mix((s.colored_noise(2, seconds=30.0, rms=1.0, seed=3), 0.0), (tone, -3.0))


def kettle() -> np.ndarray:
    """A kettle's whistle rising from 1.8 to 2.4 kHz with breath noise, in white noise."""
    s = signals()
    t = _t()
    f = 1800.0 + 600.0 * t / 30.0 + 15.0 * np.sin(2 * np.pi * 0.7 * t)
    return _mix((s.colored_noise(0, seconds=30.0, rms=1.0, seed=2), 0.0), (_sweep(f), -3.0))


# The service's pitchless-rhythm probes (tests/signals.py), with their tempo where it is one.
PITCHLESS = (
    ("noise-bursts", NOT_SCORED),
    ("drums-only-97", 97.0),
    ("drums-only-120", 120.0),
    ("drums-only-140", 140.0),
    ("metronome-1kHz", 120.0),
    ("metronome-accented", 120.0),
    ("square-2Hz", NOT_SCORED),
    ("brown-noise-with-kick", 120.0),
    ("pink-noise-with-bursts", NOT_SCORED),  # bursts 6 dB under the noise: gated
    ("drums-crash-jitter-15ms", 100.0),
    ("drums-crash-jitter-25ms", 100.0),
    ("drums-crash-jitter-40ms", NOT_SCORED),
)


@cache
def _probes() -> dict:
    return signals().probes()


def probe(name: str) -> np.ndarray:
    return _probes()[name]


# --- the list ------------------------------------------------------------------------------------

GROUPS = {
    "no-key": "no key: atonal, inharmonic or pitchless",
    "one-source": "no key: one held pitch or one voice, or one pitched source over drums",
    "pitchless-seeded": "no key: drums, noise with a beat, a siren over drums and clicks, 30 "
    "seeds each, drawn from the seed (tempo, kit, levels, sounds)",
    "music": "music the service's tests expect a key for",
    "no-tempo": "no single tempo",
    "tempo": "a known tempo (octave and meter)",
    "key": "a known key the service lost or changed",
    "noise": "noise: nothing to measure",
}


def controls() -> list[Control]:
    s = signals()
    c = Control
    return [
        # no key
        *(
            c(
                f"random-notes-{seed}",
                "no-key",
                f"83 random chromatic notes, irregular onsets (seed {seed})",
                lambda seed=seed: s.random_notes(seed),
                tempo=NONE,
                key=NONE,
            )
            for seed in (83, 84, 85)
        ),
        *(
            c(
                f"random-notes-drums-{seed}",
                "no-key",
                f"83 random chromatic notes over 120 BPM drums (seed {seed})",
                lambda seed=seed: s.random_notes(seed, beat=True),
                tempo=120.0,
                key=NONE,
            )
            for seed in (83, 84, 85)
        ),
        c(
            "chromatic-cluster",
            "no-key",
            "all twelve semitones held together",
            s.chromatic_cluster,
            key=NONE,
        ),
        *(
            c(
                f"twelve-tone-row-{seed}",
                "no-key",
                f"a twelve-tone row and its transpositions (octaves seed {seed})",
                lambda seed=seed: s.twelve_tone_row(seed),
                key=NONE,
            )
            for seed in (12, 13, 14)
        ),
        c(
            "inharmonic-fm",
            "no-key",
            "an FM tone with an irrational modulator ratio",
            inharmonic_fm,
            tempo=NONE,
            key=NONE,
        ),
        c(
            "whistling-noise-bands",
            "no-key",
            "white noise through two narrow bands",
            noise_bands,
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "hum-and-440",
            "no-key",
            "50 Hz hum with a 440 Hz tone",
            hum_and_tone,
            tempo=NONE,
            key=NONE,
        ),
        c(
            "drone-with-drums",
            "no-key",
            "a 110 Hz drone under 120 BPM drums",
            lambda: s.normalise(s.hum(110, gentle=True) + 2 * s.drums_only(120, seed=2)),
            tempo=120.0,
            key=NONE,
        ),
        # pitchless rhythm: no key (the service's own probes)
        *(
            c(
                name,
                "no-key",
                f"pitchless rhythm: {name}",
                lambda name=name: probe(name),
                tempo=bpm,
                key=NONE,
            )
            for name, bpm in PITCHLESS
        ),
        # no single tempo
        c(
            "tempo-swing-10",
            "no-tempo",
            "a band swinging +-10 % around 100 BPM every 12 s",
            s.tempo_swing,
            tempo=NONE,
        ),
        c(
            "tempo-swing-12",
            "no-tempo",
            "a band swinging +-12 % around 100 BPM every 12 s",
            lambda: s.tempo_swing(swing=0.12),
            tempo=NONE,
        ),
        c(
            "tempo-change-90-130",
            "no-tempo",
            "a band at 90 BPM, then 130",
            s.tempo_change,
            tempo=NONE,
            key=("C", "major"),
        ),
        c(
            "accelerando-80-140",
            "no-tempo",
            "a band accelerating from 80 to 140 BPM",
            lambda: s.band(s.accelerando(80, 140)),
            tempo=NONE,
        ),
        c(
            "rubato-piano",
            "no-tempo",
            "a rubato C major piano line",
            s.piano_line,
            tempo=NONE,
            key=("C", "major"),
        ),
        c(
            "chord-pads-D",
            "no-tempo",
            "D major pads, one chord every 3 s",
            s.chord_pad_progression,
            tempo=NONE,
            key=("D", "major"),
        ),
        # known tempo
        c(
            "compound-12-8-60",
            "tempo",
            "12/8 at 60 BPM (dotted quarters)",
            compound_meter,
            tempo=60.0,
            key=NONE,
        ),
        c(
            "drum-pattern-140",
            "tempo",
            "a band at 140 BPM",
            lambda: s.drum_pattern(140),
            tempo=140.0,
        ),
        c(
            "drum-and-bass-174",
            "tempo",
            "a drum-and-bass break at 174 BPM",
            drum_and_bass,
            tempo=174.0,
            key=NONE,
        ),
        c(
            "band-85-after-pad",
            "tempo",
            "an 85 BPM band after a 10 s pad",
            lambda: s.late_start(s.drum_pattern(85), 10.0, "pad"),
            tempo=85.0,
        ),
        # known key
        c(
            "chords-under-loud-drums",
            "key",
            "D major pads under drums 12 dB louder (peak)",
            lambda: probe("chords-under-loud-drums"),
            tempo=120.0,
            key=("D", "major"),
        ),
        c(
            "piano-under-loud-drums",
            "key",
            "the C major piano line under louder drums",
            lambda: probe("piano-under-loud-drums"),
            tempo=97.0,
            key=("C", "major"),
        ),
        c(
            "chords-under-drums-18dB",
            "key",
            "D major pads with drums 18 dB louder",
            chords_under_loud_drums,
            tempo=120.0,
            key=("D", "major"),
        ),
        c(
            "sparse-melody-mp3-32k",
            "key",
            "a sparse D major melody as a low bit-rate MP3",
            sparse_melody,
            tempo=NONE,
            key=("D", "major"),
            fmt="MP3",
            mp3_level=0.85,
        ),
        c(
            "bugle-over-pedal",
            "key",
            "a bugle call over its pedal note",
            bugle_call,
            tempo=NONE,
            key=("C", "major"),
        ),
        c(
            "band-C-G-Am-F-bass+10",
            "key",
            "a band, I-V-vi-IV, the bass 10 dB over the chords",
            lambda: band_mix("C-G-Am-F", 10.0),
            tempo=100.0,
            key=("C", "major"),
        ),
        c(
            "band-Em-A-bass+10",
            "key",
            "a band, Em-A, the bass 10 dB over the chords",
            lambda: band_mix("Em-A", 10.0),
            tempo=100.0,
            key=ANY,
        ),
        c(
            "trap-Em-A-bass+6",
            "key",
            "trap drums, Em-A, the bass 6 dB over the chords",
            lambda: band_mix("Em-A", 6.0, "TRAP"),
            key=ANY,
        ),
        c(
            "trap-Em-A-bass+10",
            "key",
            "trap drums, Em-A, the bass 10 dB over the chords",
            lambda: band_mix("Em-A", 10.0, "TRAP"),
            key=ANY,
        ),
        c(
            "vamp-C-bass+6",
            "key",
            "a one-chord C major vamp, the bass 6 dB over it",
            lambda: band_mix("C-vamp", 6.0),
            tempo=100.0,
            key=("C", "major"),
        ),
        c(
            "chord-over-root",
            "key",
            "a sustained C major chord over its own root",
            chord_over_root,
            tempo=NONE,
            key=("C", "major"),
        ),
        c(
            "chords-over-loud-pedal",
            "key",
            "C-F-G-C pads over a C2 pedal 10 dB louder",
            chords_over_pedal,
            tempo=NONE,
            key=("C", "major"),
        ),
        c(
            "speech-over-piano",
            "key",
            "speech over the C major piano line",
            speech_over_piano,
            tempo=NONE,
            key=("C", "major"),
        ),
        # pitchless material at many seeds (services/audio/tests/signals.py PITCHLESS_SEEDED)
        *(
            c(
                f"{family}-s{seed}",
                "pitchless-seeded",
                f"pitchless: {family}, seed {seed}",
                lambda make=make, seed=seed: make(seed),
                key=NONE,
            )
            for family, make in s.PITCHLESS_SEEDED.items()
            for seed in s.UNSEEN_SEEDS
        ),
        # the service's own probe sets (tests/test_v2.py)
        *one_source_controls(),
        *music_controls(),
        # noise
        c(
            "babble-2",
            "noise",
            "two talkers at once",
            lambda: babble(2),
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "babble-4",
            "noise",
            "four talkers at once",
            lambda: babble(4),
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "pink-noise-hum-whine",
            "noise",
            "pink noise with 50 Hz hum and a 1 kHz whine",
            noise_hum_whine,
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "brown-noise-hum",
            "noise",
            "brown noise with 50 Hz hum",
            brown_noise_hum,
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "siren-in-pink-noise",
            "noise",
            "a siren in pink noise",
            siren_in_noise,
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "engine-rev",
            "noise",
            "an engine revving in brown noise",
            engine_rev,
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "kettle",
            "noise",
            "a kettle's whistle in white noise",
            kettle,
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "white-noise",
            "noise",
            "white noise",
            lambda: s.colored_noise(0, seconds=30.0),
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "pink-noise",
            "noise",
            "pink noise",
            lambda: s.colored_noise(1, seconds=30.0),
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
        c(
            "brown-noise",
            "noise",
            "brown noise",
            lambda: s.colored_noise(2, seconds=30.0),
            tempo=NONE,
            key=NONE,
            gate="noise",
        ),
    ]


def one_source_controls() -> list[Control]:
    """One held pitch, a bend or speech without a beat; one pitched source over drums."""
    s, m = signals(), music()
    held = {
        "A4-vibrato-40c": lambda: probe("A4-vibrato-40c"),
        "A4-vibrato-120c": lambda: probe("A4-vibrato-120c"),
        "Bb3-brass-vibrato-80c": lambda: probe("Bb3-brass-vibrato-80c"),
        "D4-clarinet-vibrato": lambda: probe("D4-clarinet-vibrato"),
        "G1-brass-vibrato-60c": lambda: m.held(m.hz(31)),
        "E6-brass-vibrato-60c": lambda: m.held(m.hz(88)),
        "Bb3-brass-swing-0.5Hz-80c": lambda: m.held(233.08, 80.0, 0.5),
        "bend-2-semitones": lambda: probe("bend-2-semitones"),
        "speech-low": lambda: m.speech(4, 95.0, 160.0),
        "speech-high": lambda: m.speech(9, 170.0, 260.0),
    }
    over = {
        f"drone-{f0:.0f}Hz-drums-x{k}-s{seed}": (
            lambda f0=f0, k=k, seed=seed: s.normalise(
                s.hum(f0, gentle=True) + k * s.drums_only(120, seed=seed)
            )
        )
        for f0 in (98.0, 110.0, 147.0)
        for k in (2, 4)
        for seed in (1, 2)
    }
    over["Bb3-brass-vibrato-60c-over-drums"] = lambda: m.mix(
        (m.held(233.08, 60.0), 0), (m.drums(m.ROCK, 100), 0)
    )
    over["speech-over-trap"] = lambda: m.mix((m.speech(4), 0), (m.drums(m.TRAP, 90), -6))
    over["speech-over-rock"] = lambda: m.mix(
        (m.speech(9, 170.0, 260.0), 0), (m.drums(m.ROCK, 96), -3)
    )
    return [
        *(Control(n, "one-source", f"one source: {n}", f, key=NONE) for n, f in held.items()),
        *(Control(n, "one-source", f"over drums: {n}", f, key=NONE) for n, f in over.items()),
    ]


def music_controls() -> list[Control]:
    """Music without a beat, and band mixes with a bass line and drums."""
    m = music()
    without = {
        "band-C-G-Am-F-no-drums": (lambda: m.band_mix("C-G-Am-F", False), ("C", "major")),
        "band-Dm-C-no-drums": (lambda: m.band_mix("Dm-C", False), ("D", "minor")),
        "band-C-vamp-no-drums": (lambda: m.band_mix("C-vamp", False), ("C", "major")),
        "band-Em-A-no-drums": (lambda: m.band_mix("Em-A", False), ANY),
        "pad-Am-root-in-bass": (m.ambient_pad, ("A", "minor")),
        "melody-over-louder-drone": (m.melody_over_drone, ("D", "major")),
        "melody-over-drone": (lambda: m.melody_over_drone(0.0), ("D", "major")),
        "narrow-trumpet-melody": (m.trumpet_melody, ANY),
        "a-cappella-vibrato-70c-A": (lambda: m.sung(9, "major", 57, 72, 31, 70.0), ("A", "major")),
        "a-cappella-vibrato-70c-Dm": (lambda: m.sung(2, "minor", 50, 66, 21, 70.0), ("D", "minor")),
        "pop-vocal-scoops-and-glides": (
            lambda: m.sung(4, "minor", 55, 71, 33, 30.0, 150.0, 0.2),
            ("E", "minor"),
        ),
    }
    mixes = {
        f"band-{name}-bass{db:+d}": (
            lambda name=name, db=db: m.band_mix(name, True, db),
            ANY if name == "Em-A" else key,
        )
        for name, (_, key) in m.PROGRESSIONS.items()
        for db in (0, 6)
        if (name, db) != ("C-vamp", 6)
    }
    return [
        *(Control(n, "music", f"without a beat: {n}", f, key=k) for n, (f, k) in without.items()),
        *(
            Control(n, "music", f"band mix: {n}", f, tempo=100.0, key=k)
            for n, (f, k) in mixes.items()
        ),
    ]


def write(control: Control, directory) -> str:
    """The control as a file (WAV, or MP3 at its level) in `directory`; returns the path."""
    y = np.asarray(control.make(), dtype=np.float32)
    path = f"{directory}/{control.name}.{control.fmt.lower()}"
    if control.fmt == "MP3":
        sf.write(
            path, y, SR, format="MP3", compression_level=control.mp3_level, bitrate_mode="CONSTANT"
        )
    else:
        sf.write(path, y, SR, format="WAV", subtype="FLOAT")
    return path


def bit_rate(path: str) -> float:
    """kbit/s of an encoded file."""
    info = sf.info(path)
    with open(path, "rb") as f:
        size = len(f.read())
    return size * 8 / info.duration / 1000 if info.duration else 0.0

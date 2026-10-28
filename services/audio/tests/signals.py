"""
Generated test signals beyond the basic fixtures of test_fixtures.py: music-like material
(drums, chords, a piano line, a band with human timing), pitchless rhythm (drum loops,
metronomes, noise bursts, a square wave), noise beds with and without music, and mains hum.

Every generator is deterministic (fixed seeds) and returns float32 mono at `sr` (22.05 kHz
unless given), peak-normalised.
"""

import numpy as np

SR = 22050

# Kick and snare on alternate beats, hats on every eighth note.
AM_F_C_G = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
# I-vi-IV-V in D major.
D_MAJOR_CHORDS = [(62, 66, 69), (59, 62, 66), (55, 59, 62), (57, 61, 64)]
C_MAJOR_SCALE = [60, 62, 64, 65, 67, 69, 71, 72]


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def seconds_of(duration: float, sr: int = SR) -> np.ndarray:
    return np.arange(int(duration * sr)) / sr


def place(y: np.ndarray, start: float, sound: np.ndarray, sr: int = SR) -> None:
    i = round(start * sr)
    if 0 <= i < len(y):
        j = min(len(y), i + len(sound))
        y[i:j] += sound[: j - i]


def normalise(y: np.ndarray, peak: float = 0.8) -> np.ndarray:
    top = float(np.max(np.abs(y))) if y.size else 0.0
    return (peak * y / top).astype(np.float32) if top > 0 else y.astype(np.float32)


def grid(bpm: float, seconds: float = 30.0, start: float = 0.0) -> list[float]:
    return list(np.arange(start, seconds, 60.0 / bpm))


def jittered(bpm: float, jitter_s: float, seconds: float = 30.0, seed: int = 21) -> list[float]:
    """A beat grid with Gaussian timing jitter (a human drummer)."""
    rng = np.random.default_rng(seed)
    return sorted(max(0.0, b + rng.normal(0, jitter_s)) for b in grid(bpm, seconds))


class Kit:
    """Drum sounds for one seed."""

    def __init__(self, sr: int = SR, seed: int = 7):
        rng = np.random.default_rng(seed)
        self.rng = rng
        t = seconds_of(0.25, sr)
        self.kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.12)
        self.snare = (0.6 * rng.standard_normal(len(t)) + 0.4 * np.sin(2 * np.pi * 190 * t)) * (
            np.exp(-t / 0.06)
        )
        th = seconds_of(0.05, sr)
        self.hat = np.diff(rng.standard_normal(len(th) + 1)) * np.exp(-th / 0.015)
        tc = seconds_of(1.5, sr)
        self.crash = rng.standard_normal(len(tc)) * np.exp(-tc / 0.5)


def pad(freqs, duration: float, sr: int = SR) -> np.ndarray:
    t = seconds_of(duration, sr)
    tone = sum(np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t) for f in freqs)
    return tone * np.minimum(1, t / 0.05) * np.minimum(1, (duration - t) / 0.05)


def piano_note(f: float, duration: float = 2.0, sr: int = SR) -> np.ndarray:
    t = seconds_of(duration, sr)
    tone = sum(0.6**k * np.sin(2 * np.pi * f * (k + 1) * t) for k in range(6))
    return tone * np.exp(-t / 0.6) * np.minimum(1, t / 0.005)


def band(
    beats,
    *,
    chords: bool = True,
    crash: bool = False,
    seconds: float = 30.0,
    sr: int = SR,
    seed: int = 7,
) -> np.ndarray:
    """Drums on the given beat times (4/4), optionally an Am-F-C-G pad and a crash per bar."""
    kit = Kit(sr, seed)
    y = np.zeros(int(seconds * sr))
    for n, b in enumerate(beats):
        period = (beats[n + 1] - b) if n + 1 < len(beats) else (b - beats[n - 1])
        place(y, b, 0.8 * kit.kick if n % 2 == 0 else 0.5 * kit.snare, sr)
        place(y, b, 0.15 * kit.hat, sr)
        place(y, b + period / 2, 0.1 * kit.hat, sr)
        if n % 4 == 0:
            if crash:
                place(y, b, 0.3 * kit.crash, sr)
            if chords:
                bar = 4 * period
                freqs = [hz(m) for m in AM_F_C_G[(n // 4) % 4]]
                decay = np.exp(-seconds_of(bar, sr) / (1.5 * bar))
                place(y, b, 0.12 * pad(freqs, bar, sr) * decay, sr)
    return normalise(y)


def drums_only(bpm: float, seed: int = 1) -> np.ndarray:
    return band(grid(bpm), chords=False, seed=seed)


def metronome(bpm: float = 120, freq: float = 1000.0, accent: float | None = None, sr: int = SR):
    """30 ms tone bursts on every beat; the first of each bar at `accent` Hz when given."""
    y = np.zeros(30 * sr)
    t = seconds_of(0.03, sr)
    for n, b in enumerate(grid(bpm)):
        f = accent if accent and n % 4 == 0 else freq
        place(y, b, np.sin(2 * np.pi * f * t) * np.exp(-t / 0.01), sr)
    return normalise(y)


def square_wave(freq: float = 2.0, seconds: float = 30.0, sr: int = SR) -> np.ndarray:
    return normalise(np.sign(np.sin(2 * np.pi * freq * seconds_of(seconds, sr))), 0.5)


def colored_noise(
    alpha: float, seconds: float = 10.0, rms: float = 0.2, seed: int = 5, sr: int = SR
) -> np.ndarray:
    """Noise with a 1/f^alpha power spectrum: white for alpha = 0, pink for 1, brown for 2."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    freqs[0] = freqs[1]
    y = np.fft.irfft(spectrum / freqs ** (alpha / 2), n)
    return (rms * y / np.sqrt(np.mean(y**2))).astype(np.float32)


def noise_bursts(bpm: float = 120, seconds: float = 30.0, sr: int = SR) -> np.ndarray:
    """A hi-hat-like track: 50 ms noise bursts on every eighth note (rhythm without pitch)."""
    rng = np.random.default_rng(11)
    y = np.zeros(int(seconds * sr))
    th = seconds_of(0.05, sr)
    burst = rng.standard_normal(len(th)) * np.exp(-th / 0.015)
    for start in np.arange(0, seconds - 0.1, 30 / bpm):
        place(y, start, burst, sr)
    return normalise(y, 0.5)


def noise_with_beat(alpha: float, kick: bool = True, bpm: float = 120) -> np.ndarray:
    """A noise bed with a kick (or a noise burst) on every beat, the beat 6 dB under it."""
    bed = colored_noise(alpha, seconds=30.0)
    beat = np.zeros_like(bed)
    kit = Kit()
    t = seconds_of(0.03)
    burst = np.random.default_rng(3).standard_normal(len(t)) * np.exp(-t / 0.008)
    for b in grid(bpm):
        place(beat, b, kit.kick if kick else burst)
    return normalise(bed + 0.1 * beat / np.max(np.abs(beat)), 0.9)


def hum(f0: float = 50.0, gentle: bool = False, seconds: float = 30.0, sr: int = SR):
    """
    Mains hum: harmonics 1-6 falling by half per harmonic (steep), or harmonics 1-10 with a
    gentle roll-off, as transformer hum with rectifier buzz has.
    """
    t = seconds_of(seconds, sr)
    if gentle:
        weights = [(1, 1.0), (2, 0.6), (3, 0.5), (4, 0.4), (5, 0.35), (6, 0.3), (7, 0.25)]
        weights += [(8, 0.2), (9, 0.17), (10, 0.15)]
    else:
        weights = [(k + 1, 0.5**k) for k in range(6)]
    return normalise(sum(a * np.sin(2 * np.pi * f0 * k * t) for k, a in weights), 0.3)


def chord_pad_progression(seconds: float = 30.0, chord_s: float = 3.0, sr: int = SR):
    """I-vi-IV-V in D major, one sustained chord every `chord_s` seconds, no drums."""
    y = np.zeros(int(seconds * sr))
    for n, b in enumerate(np.arange(0, seconds, chord_s)):
        place(y, b, pad([hz(m) for m in D_MAJOR_CHORDS[n % 4]], chord_s, sr), sr)
    return normalise(y)


# A melody in C major leans on the tonic triad: C, E and G are drawn more often.
C_MAJOR_WEIGHTS = np.array([3, 1, 2, 1, 2, 1, 1, 2], dtype=float)


def piano_line(seconds: float = 30.0, seed: int = 5, sr: int = SR) -> np.ndarray:
    """A rubato melody in C major: irregular onsets, no beat."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(seconds * sr))
    t = 0.2
    weights = C_MAJOR_WEIGHTS / C_MAJOR_WEIGHTS.sum()
    while t < seconds - 1:
        note = C_MAJOR_SCALE[rng.choice(len(C_MAJOR_SCALE), p=weights)]
        place(y, t, piano_note(hz(note), 2.0, sr), sr)
        t += rng.uniform(0.25, 1.4)
    return normalise(y)


def under_noise(music: np.ndarray, alpha: float = 1.0, snr_db: float = 0.0, seed: int = 9):
    """`music` in a noise bed (pink: rain) at the given music-to-noise RMS ratio."""
    bed = colored_noise(alpha, seconds=len(music) / SR, rms=1.0, seed=seed)
    music = music / np.sqrt(np.mean(music**2))
    return normalise(bed + music * 10 ** (snr_db / 20), 0.7)


def held_note(
    f0: float,
    vibrato_cents: float = 0.0,
    rate: float = 6.0,
    weights=None,
    seconds: float = 30.0,
    sr: int = SR,
) -> np.ndarray:
    """One held note with vibrato; `weights` are the harmonic amplitudes (0.7^k by default)."""
    t = seconds_of(seconds, sr)
    f = f0 * 2 ** ((vibrato_cents / 1200) * np.sin(2 * np.pi * rate * t))
    phase = 2 * np.pi * np.cumsum(f) / sr
    weights = weights or [0.7**k for k in range(10)]
    return normalise(sum(a * np.sin((k + 1) * phase) for k, a in enumerate(weights)))


# Harmonic amplitudes: brass-like (harmonics 2-5 strong, which spell root, fifth and major
# third) and clarinet-like (odd harmonics).
BRASS = [0.5, 1, 1, 0.9, 0.8, 0.4, 0.3, 0.2]
CLARINET = [1, 0.05, 0.7, 0.05, 0.5, 0.05, 0.35, 0.05, 0.25]


def bend(f0: float = 220.0, semitones: float = 2.0, period: float = 2.0, sr: int = SR):
    """One note bending up `semitones` and back every `period` seconds."""
    t = seconds_of(30.0, sr)
    f = f0 * 2 ** ((semitones / 12) * (0.5 - 0.5 * np.cos(2 * np.pi * t / period)))
    phase = 2 * np.pi * np.cumsum(f) / sr
    return normalise(sum(0.7**k * np.sin((k + 1) * phase) for k in range(10)))


def sung_melody(vibrato_cents: float = 50.0, seed: int = 3, sr: int = SR) -> np.ndarray:
    """A legato G major melody with wide vibrato, one voice (no accompaniment)."""
    rng = np.random.default_rng(seed)
    melody = [67, 69, 71, 72, 74, 72, 71, 69, 67, 66, 67, 71, 74, 79, 78, 74]
    t = seconds_of(30.0, sr)
    f = np.zeros(t.size)
    i = k = 0
    while i < t.size:
        n = int(rng.uniform(0.8, 2.2) * sr)
        f[i : i + n] = hz(melody[k % len(melody)])
        i, k = i + n, k + 1
    f *= 2 ** ((vibrato_cents / 1200) * np.sin(2 * np.pi * 5.5 * t))
    phase = 2 * np.pi * np.cumsum(f) / sr
    return normalise(sum(0.6**h * np.sin((h + 1) * phase) for h in range(10)))


def noise_with_tone(
    tone: np.ndarray, alpha: float = 0.0, snr_db: float = -10.0, seed: int = 9
) -> np.ndarray:
    """A noise bed with one tonal artefact (a whine, hum) `snr_db` under it."""
    bed = colored_noise(alpha, seconds=len(tone) / SR, rms=1.0, seed=seed)
    tone = tone / np.sqrt(np.mean(tone**2))
    return normalise(bed + tone * 10 ** (snr_db / 20), 0.7)


def late_start(music: np.ndarray, start: float, intro: str = "silence") -> np.ndarray:
    """`music` silenced before `start` seconds, then optionally a sustained D major pad there."""
    y = music.copy()
    i = int(start * SR)
    y[:i] = 0
    if intro == "pad":
        y[:i] += 0.3 * normalise(pad([hz(62), hz(66), hz(69)], start))
    return normalise(y)


def tempo_change(first: float = 90, second: float = 130) -> np.ndarray:
    """A band at `first` BPM for 15 s, then at `second` BPM."""
    beats = grid(first, 15.0) + [15.0 + b for b in grid(second, 15.0)]
    return band(beats)


def accelerando(start: float, end: float, seconds: float = 30.0) -> list[float]:
    """Beat times of a tempo rising linearly from `start` to `end` BPM."""
    beats, t = [], 0.0
    while t < seconds:
        beats.append(t)
        t += 60.0 / (start + (end - start) * t / seconds)
    return beats


def drum_pattern(bpm: float, seconds: float = 30.0, seed: int = 7) -> np.ndarray:
    """Kick on 1 and 3, snare on 2 and 4, eighth-note hats, and an Am-F-C-G pad, one bar each."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(seconds * SR))
    beat = 60.0 / bpm
    t = seconds_of(0.25)
    kick = np.sin(2 * np.pi * (50 + 80 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.12)
    snare = (0.6 * rng.standard_normal(len(t)) + 0.4 * np.sin(2 * np.pi * 190 * t)) * np.exp(
        -t / 0.06
    )
    th = seconds_of(0.05)
    hat = np.diff(rng.standard_normal(len(th) + 1)) * np.exp(-th / 0.015)
    bar = 4 * beat
    tb = seconds_of(bar)
    start, n = 0.0, 0
    while start < seconds:
        for b in range(4):
            place(y, start + b * beat, 0.8 * kick if b % 2 == 0 else 0.5 * snare)
            place(y, start + b * beat, 0.15 * hat)
            place(y, start + (b + 0.5) * beat, 0.1 * hat)
        freqs = [hz(m) for m in AM_F_C_G[n % 4]]
        tone = sum(np.sin(2 * np.pi * f * tb) + 0.3 * np.sin(4 * np.pi * f * tb) for f in freqs)
        place(y, start, 0.12 * tone * np.minimum(1, tb / 0.05) * np.exp(-tb / (1.5 * bar)))
        start += bar
        n += 1
    return normalise(y)


def triad_hits(times, gains, seconds: float = 30.0, floor: float = 0.01) -> np.ndarray:
    """A quiet A major triad with louder hits of the same chord at `times`, decaying in 0.3 s."""
    t = seconds_of(seconds)
    chord = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.18, 329.63)) / 3
    envelope = np.full_like(t, floor)
    for start, gain in zip(times, gains, strict=True):
        hit = t >= start
        envelope[hit] += gain * np.exp(-(t[hit] - start) / 0.3)
    return (0.8 * chord * envelope).astype(np.float32)


def chord_blocks(chords, block_seconds: float = 10.0, bpm: float = 120) -> np.ndarray:
    """Each chord (MIDI notes) struck on every beat for block_seconds, one block after another."""
    beat = 60.0 / bpm
    t = seconds_of(beat)
    envelope = np.exp(-t / 0.4) * (1 - np.exp(-t / 0.005))

    def strike(notes):
        freqs = [hz(m) for m in notes]
        return envelope * sum(
            0.6**k * np.sin(2 * np.pi * f * (k + 1) * t) for f in freqs for k in range(4)
        )

    y = np.concatenate(
        [strike(chord) for chord in chords for _ in range(round(block_seconds / beat))]
    )
    return normalise(y)


def random_notes(seed: int = 83, count: int = 83, beat: bool = False) -> np.ndarray:
    """
    `count` piano notes whose pitch classes are drawn uniformly (C3-B5) at irregular onsets:
    atonal, no key. With `beat`, over drums at 120 BPM at the same level (RMS).
    """
    rng = np.random.default_rng(seed)
    y = np.zeros(30 * SR)
    starts, notes = np.sort(rng.uniform(0.0, 29.0, count)), rng.integers(48, 84, count)
    for start, note in zip(starts, notes, strict=True):
        place(y, float(start), piano_note(hz(int(note)), 1.5))
    if not beat:
        return normalise(y)
    drums = drums_only(120, seed=2)
    return normalise(y / np.sqrt(np.mean(y**2)) + drums / np.sqrt(np.mean(drums**2)))


def chromatic_cluster() -> np.ndarray:
    """All twelve semitones C4-B4 held together, struck again every 3 s: no key."""
    y = np.zeros(30 * SR)
    for start in np.arange(0.0, 30.0, 3.0):
        place(y, float(start), pad([hz(m) for m in range(60, 72)], 3.0))
    return normalise(y)


TONE_ROW = (0, 11, 7, 8, 3, 1, 2, 10, 6, 5, 4, 9)  # each pitch class once


def twelve_tone_row(seed: int = 12) -> np.ndarray:
    """A twelve-tone row and its transpositions, 0.6 s per note, octaves 3-5 drawn at `seed`."""
    y = np.zeros(30 * SR)
    rng = np.random.default_rng(seed)
    t, k = 0.0, 0
    while t < 29.0:
        row = (np.array(TONE_ROW) + 5 * (k // 12)) % 12
        place(y, t, piano_note(hz(48 + int(row[k % 12]) + 12 * int(rng.integers(0, 3))), 1.2))
        t, k = t + 0.6, k + 1
    return normalise(y)


def tempo_swing(bpm: float = 100.0, swing: float = 0.1, period: float = 12.0) -> np.ndarray:
    """A band whose tempo swings +-`swing` around `bpm`, once every `period` seconds."""
    beats, t = [], 0.0
    while t < 30.0:
        beats.append(t)
        t += 60.0 / (bpm * (1 + swing * np.sin(2 * np.pi * t / period)))
    return band(beats)


# --- pitchless material at many seeds ------------------------------------------------------
# Each generator draws its tempo, kit, noise colour, levels and sounds from the seed. None of it
# has a key. Seeds 100-129 are calibration controls (evals/audio): the calibration sees them, so
# the tests on them check material the rules were chosen with, not new material.


def _db(y: np.ndarray, db: float) -> np.ndarray:
    return y / max(float(np.sqrt(np.mean(y**2))), 1e-12) * 10 ** (db / 20)


def seeded_drums(seed: int) -> np.ndarray:
    """A drum kit (kick, snare, hats) at a tempo of 70-180 BPM, kit and tempo from the seed."""
    bpm = float(np.random.default_rng(seed).uniform(70.0, 180.0))
    return drums_only(round(bpm, 1), seed=seed)


def seeded_noise_rhythm(seed: int) -> np.ndarray:
    """White, pink or brown noise with kicks or noise bursts on a beat, -6 to +6 dB against it."""
    rng = np.random.default_rng(seed)
    alpha = int(rng.integers(0, 3))
    bpm = float(rng.uniform(70.0, 180.0))
    bed = colored_noise(alpha, seconds=30.0, rms=1.0, seed=seed)
    beat = np.zeros_like(bed)
    kit = Kit(seed=seed)
    t = seconds_of(0.03)
    burst = rng.standard_normal(len(t)) * np.exp(-t / 0.008)
    sound = kit.kick if rng.uniform() < 0.5 else burst
    for b in grid(bpm):
        place(beat, b, sound)
    return normalise(bed + _db(beat, float(rng.uniform(-6.0, 6.0))))


def seeded_siren_over_drums(seed: int) -> np.ndarray:
    """A siren (500-1500 Hz, swinging 20-40 % every 1-4 s) over a seeded drum kit."""
    rng = np.random.default_rng(seed)
    centre, swing, period = rng.uniform(500, 1500), rng.uniform(0.2, 0.4), rng.uniform(1.0, 4.0)
    t = seconds_of(30.0)
    f = centre * (1 + swing * np.sin(2 * np.pi * t / period))
    siren = np.sin(2 * np.pi * np.cumsum(f) / SR)
    drums = seeded_drums(seed)
    return normalise(_db(drums, 0.0) + _db(siren, float(rng.uniform(-6.0, 6.0))))


def seeded_clicks(seed: int) -> np.ndarray:
    """Clicks on a beat: 30 ms tone bursts (400-4000 Hz) or noise bursts, every 2nd accented."""
    rng = np.random.default_rng(seed)
    bpm = float(rng.uniform(60.0, 200.0))
    t = seconds_of(0.03)
    if rng.uniform() < 0.5:
        click = np.sin(2 * np.pi * rng.uniform(400, 4000) * t) * np.exp(-t / 0.01)
    else:
        click = rng.standard_normal(len(t)) * np.exp(-t / 0.006)
    y = np.zeros(30 * SR)
    for n, b in enumerate(grid(bpm)):
        place(y, b, (1.0 if n % 2 == 0 else 0.5) * click)
    return normalise(y)


def seeded_drum_patterns(seed: int) -> np.ndarray:
    """
    Rock or trap patterns with the kit of tests/music.py (a kick sweeping from 135 to 45 Hz, a
    snare with a 190 Hz partial), tempo and pattern from the seed.
    """
    rng = np.random.default_rng(seed)
    bpm = float(rng.uniform(70.0, 160.0))
    t = seconds_of(0.3)
    kit = {
        "kick": np.sin(2 * np.pi * (45 + 90 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.15),
        "snare": (0.6 * rng.standard_normal(t.size) + 0.4 * np.sin(2 * np.pi * 190 * t))
        * np.exp(-t / 0.07),
    }
    th = seconds_of(0.05)
    kit["hat"] = np.diff(rng.standard_normal(th.size + 1)) * np.exp(-th / 0.015)
    if rng.uniform() < 0.5:  # rock
        pattern = [(0, "kick", 1), (8, "kick", 1), (4, "snare", 0.8), (12, "snare", 0.8)]
        pattern += [(k, "hat", 0.2) for k in range(0, 16, 2)]
    else:  # trap
        pattern = [(0, "kick", 1), (6, "kick", 0.8), (11, "kick", 0.7), (8, "snare", 1)]
        pattern += [(k, "hat", 0.15) for k in range(16)]
    y = np.zeros(30 * SR)
    bar = 240.0 / bpm
    for start in np.arange(0, 30.0, bar):
        for step, instrument, gain in pattern:
            place(y, start + step * bar / 16, gain * kit[instrument])
    return normalise(y)


PITCHLESS_SEEDED = {
    "drums": seeded_drums,
    "drum-patterns": seeded_drum_patterns,
    "noise-rhythm": seeded_noise_rhythm,
    "siren-over-drums": seeded_siren_over_drums,
    "clicks": seeded_clicks,
}
CONTROL_SEEDS = range(100, 130)


# --- one pitch class at many seeds ---------------------------------------------------------
# One pitched source (a note and its overtones, its octaves, a bell's or a drum's partials) is
# no key: its overtones or inharmonic partials can still spell three pitch classes. Seeds
# 500-529 are also calibration controls: the calibration sees them, so these tests pin today's
# counts rather than check unseen signals.


def _drums_at(seed: int, bpm: float | None = None) -> np.ndarray:
    if bpm is None:
        bpm = float(np.random.default_rng(seed).uniform(80.0, 160.0))
    return drums_only(round(bpm, 1), seed=seed).astype(float)


def seeded_one_note_bass(seed: int) -> np.ndarray:
    """A picked bass on one note (E1-G#2) in sixteenths, slightly inharmonic, over drums."""
    rng = np.random.default_rng(seed)
    f0 = hz(int(rng.integers(28, 45)))
    bpm = float(rng.uniform(110.0, 140.0))
    stiffness = (0.0, 0.0002, 0.0008)[seed % 3]
    step = 60.0 / bpm / 4
    t = seconds_of(step * 0.9)
    note = sum(
        np.sin(2 * np.pi * f0 * k * np.sqrt(1 + stiffness * k * k) * t) / k for k in range(1, 16)
    ) * np.exp(-t / 0.12)
    y = np.zeros(30 * SR)
    for start in np.arange(0.0, 30.0, step):
        place(y, float(start), note)
    if seed % 4 == 0:  # with a kick only
        kick = np.zeros(30 * SR)
        for start in grid(bpm):
            place(kick, start, Kit(seed=seed).kick)
        return normalise(_db(y, 0.0) + _db(kick, 0.0))
    return normalise(_db(y, 0.0) + _db(_drums_at(seed, bpm), 0.0))


def seeded_octave_riff(seed: int) -> np.ndarray:
    """One note jumping between its octaves (a detuned saw arpeggio or a sine bass), over drums."""
    rng = np.random.default_rng(seed)
    root = int(rng.integers(30, 46))
    bpm = float(rng.uniform(110.0, 135.0))
    y = np.zeros(30 * SR)
    if seed % 2:
        step = 60.0 / bpm / 4
        t = seconds_of(step * 0.9)
        notes = []
        for octave in (0, 12, 24):
            f = hz(root + octave)
            saw = sum(
                (np.sin(2 * np.pi * f * 1.003 * k * t) + np.sin(2 * np.pi * f * 0.997 * k * t)) / k
                for k in range(1, 12)
                if f * k < 5000
            )
            notes.append(saw * np.exp(-t / 0.1))
        for n, start in enumerate(np.arange(0.0, 30.0, step)):
            place(y, float(start), notes[(0, 1, 2, 1)[n % 4]])
    else:
        step = 60.0 / bpm / 2
        t = seconds_of(step * 0.9)
        for n, start in enumerate(np.arange(0.0, 30.0, step)):
            f = hz(root + 12 * (n % 2))
            tone = sum(
                a * np.sin(2 * np.pi * f * h * t) for h, a in ((1, 1.0), (2, 0.4), (3, 0.25))
            )
            place(y, float(start), tone * np.exp(-t / 0.2))
    return normalise(_db(y, -1.0) + _db(_drums_at(seed, bpm), 0.0))


BELL_RATIOS = (0.5, 1.0, 1.183, 1.506, 2.0, 2.514, 2.662, 3.011, 4.166)  # hum, prime, tierce, ...


def seeded_bell(seed: int) -> np.ndarray:
    """A tolling church bell (inharmonic partials: a minor-third tierce, a fifth), every 1.6-3 s."""
    rng = np.random.default_rng(seed)
    f = hz(float(rng.uniform(55.0, 72.0)))
    amps = (0.8, 0.6, 0.7, 0.3, 1.0, 0.4, 0.3, 0.3, 0.2)
    decays = (4.0, 2.5, 2.0, 1.5, 1.5, 0.8, 0.7, 0.6, 0.4)
    period = float(rng.uniform(1.6, 3.0))
    t = seconds_of(6.0)
    strike = sum(
        a * np.sin(2 * np.pi * f * r * t) * np.exp(-t / d)
        for r, a, d in zip(BELL_RATIOS, amps, decays, strict=True)
    )
    y = np.zeros(30 * SR)
    for start in np.arange(0.0, 30.0, period):
        place(y, float(start), strike)
    return normalise(y)


def seeded_bell_over_drums(seed: int) -> np.ndarray:
    return normalise(_db(seeded_bell(seed).astype(float), -3.0) + _db(_drums_at(seed), 0.0))


def seeded_tabla(seed: int) -> np.ndarray:
    """Tabla-like strokes: a near-harmonic dayan, an inharmonic 'tin', a bayan gliding up."""
    rng = np.random.default_rng(seed)
    f0 = hz(float(rng.uniform(58.0, 66.0)))
    bpm = float(rng.uniform(70.0, 120.0))
    step = 60.0 / bpm / 4
    t = seconds_of(0.6)
    stretch = rng.uniform(1.0, 1.02, 6)
    na = sum(0.8**k * np.sin(2 * np.pi * f0 * (k + 1) * stretch[k] * t) for k in range(5))
    na = na * np.exp(-t / 0.25)
    tin = sum(np.sin(2 * np.pi * f0 * r * t) for r in (1.0, 2.72, 3.9)) * np.exp(-t / 0.08)
    ge = np.sin(2 * np.pi * np.cumsum(80 * (1 + 0.4 * (1 - np.exp(-t / 0.15)))) / SR)
    ge = ge * np.exp(-t / 0.3)
    strokes = (na, 0.6 * tin, ge, 0.5 * na + 0.7 * ge)
    pattern = rng.integers(0, 4, 16)
    y = np.zeros(30 * SR)
    for n, start in enumerate(np.arange(0.0, 30.0, step)):
        place(y, float(start), strokes[pattern[n % 16]])
    return normalise(y)


def seeded_toms(seed: int) -> np.ndarray:
    """Three tuned toms or congas (90-330 Hz, gliding down), on a random pattern."""
    rng = np.random.default_rng(seed)
    pitches = rng.uniform(90.0, 330.0, 3)
    bpm = float(rng.uniform(90.0, 130.0))
    step = 60.0 / bpm / 4
    t = seconds_of(0.4)
    hits = [
        np.sin(2 * np.pi * np.cumsum(p * (1 + 0.15 * np.exp(-t / 0.05))) / SR) * np.exp(-t / 0.15)
        + 0.2 * rng.standard_normal(t.size) * np.exp(-t / 0.01)
        for p in pitches
    ]
    pattern = rng.integers(-1, 3, 16)
    y = np.zeros(30 * SR)
    for n, start in enumerate(np.arange(0.0, 30.0, step)):
        if pattern[n % 16] >= 0:
            place(y, float(start), hits[pattern[n % 16]])
    return normalise(y)


def seeded_cowbell(seed: int) -> np.ndarray:
    """An 808 cowbell (two square waves near 540 and 800 Hz) on a pattern, odd seeds over drums."""
    rng = np.random.default_rng(seed)
    bpm = float(rng.uniform(90.0, 140.0))
    t = seconds_of(0.25)
    f1, f2 = 540 * rng.uniform(0.95, 1.05), 800 * rng.uniform(0.95, 1.05)
    bell = np.sign(np.sin(2 * np.pi * f1 * t)) + np.sign(np.sin(2 * np.pi * f2 * t))
    bell = bell * np.exp(-t / 0.07)
    pattern = rng.uniform(size=16) < 0.45
    pattern[0] = True
    step = 60.0 / bpm / 4
    y = np.zeros(30 * SR)
    for n, start in enumerate(np.arange(0.0, 30.0, step)):
        if pattern[n % 16]:
            place(y, float(start), bell)
    if seed % 2:
        y = _db(y, -3.0) + _db(_drums_at(seed, bpm), 0.0)
    return normalise(y)


def seeded_synth_note(seed: int) -> np.ndarray:
    """One held note of seven detuned saw voices (+-30 cents), over drums."""
    rng = np.random.default_rng(seed)
    f0 = hz(int(rng.integers(33, 52)))
    t = seconds_of(30.0)
    y = np.zeros_like(t)
    for cents in np.linspace(-30, 30, 7):
        f = f0 * 2 ** (cents / 1200)
        phase = rng.uniform(0, 2 * np.pi)
        y += sum(
            np.sin(2 * np.pi * f * k * t + phase * k) / k for k in range(1, 25) if f * k < 5000
        )
    return normalise(_db(y, -3.0) + _db(_drums_at(seed), 0.0))


# Circular-membrane modes over the fundamental (zeros of the Bessel functions) and their levels.
MEMBRANE_MODES = ((1.0, 1.0), (1.594, 0.45), (2.136, 0.3), (2.296, 0.2), (2.653, 0.12))


def _membrane(f0: float, drop: float, decay: float, rng, seconds: float = 0.8) -> np.ndarray:
    """One drum stroke: membrane modes whose pitch falls by `drop` just after the stick hits."""
    t = seconds_of(seconds)
    glide = 1 + drop * np.exp(-t / rng.uniform(0.04, 0.09))
    phase = 2 * np.pi * np.cumsum(f0 * glide) / SR
    body = sum(a * np.sin(r * phase) * np.exp(-t * r / decay) for r, a in MEMBRANE_MODES)
    stick = 0.3 * rng.standard_normal(t.size) * np.exp(-t / 0.008)
    return (body + stick) * np.minimum(1, t / 0.002)


def seeded_kit_toms(seed: int) -> np.ndarray:
    """Two rack toms and a floor tom (pitch falling 4-12 % per stroke) over a drum kit."""
    rng = np.random.default_rng(seed)
    bpm = float(rng.uniform(90.0, 140.0))
    floor = float(rng.uniform(70.0, 110.0))
    racks = sorted(rng.uniform(140.0, 280.0, 2))
    toms = [
        _membrane(f, rng.uniform(0.04, 0.12), rng.uniform(0.25, 0.6), rng) for f in (*racks, floor)
    ]
    step = 60.0 / bpm / 4
    pattern = rng.integers(-2, 3, 16)  # sixteenths; negative: no tom
    y = np.zeros(30 * SR)
    for n, start in enumerate(np.arange(0.0, 30.0, step)):
        if pattern[n % 16] >= 0:
            place(y, float(start), toms[pattern[n % 16]] * rng.uniform(0.7, 1.0))
    return normalise(_db(y, 0.0) + _db(_drums_at(seed, bpm), rng.uniform(-6.0, 0.0)))


# A tubular bell (a chime): the modes of a free bar (ratio, level, decay in s). The strike note
# is heard an octave under the fourth mode, and no mode is a harmonic of another.
CHIME_MODES = (
    (1.0, 0.15, 1.0),
    (2.756, 0.3, 1.5),
    (5.404, 0.6, 3.0),
    (8.933, 1.0, 4.0),
    (13.34, 0.7, 3.0),
    (18.64, 0.4, 2.0),
)


def seeded_tubular_bell(seed: int) -> np.ndarray:
    """One tubular bell (strike note G3-G5) tolling every 1.5-3 s, odd seeds over drums."""
    rng = np.random.default_rng(seed)
    first = 2 * hz(float(rng.uniform(55.0, 79.0))) / CHIME_MODES[3][0]
    t = seconds_of(6.0)
    strike = sum(
        a * np.sin(2 * np.pi * first * r * t) * np.exp(-t / d)
        for r, a, d in CHIME_MODES
        if first * r < 5000
    )
    period = float(rng.uniform(1.5, 3.0))
    y = np.zeros(30 * SR)
    for start in np.arange(0.0, 30.0, period):
        place(y, float(start), strike)
    if seed % 2:
        return normalise(_db(y, -3.0) + _db(_drums_at(seed), 0.0))
    return normalise(y)


ONE_PITCH_CLASS_SEEDED = {
    "one-note-bass": seeded_one_note_bass,
    "octave-riff": seeded_octave_riff,
    "bell": seeded_bell,
    "bell-over-drums": seeded_bell_over_drums,
    "tabla": seeded_tabla,
    "toms": seeded_toms,
    "cowbell": seeded_cowbell,
    "synth-note-over-drums": seeded_synth_note,
    "kit-toms": seeded_kit_toms,
    "tubular-bell": seeded_tubular_bell,
}
ONE_PITCH_CLASS_SEEDS = range(500, 530)
# Seeds 600-629 of these families are kept out of every test and every threshold choice: they
# are an evaluation set (evals/audio controls), not pins.


# --- chords that keep their key, at many seeds ------------------------------------------------
# Music in one key whose spectrum hardly changes or whose level moves as a whole: a held chord
# faded in and out, swelling, getting louder, with tremolo or pumped by a sidechain, chord stabs
# on one chord, a bass and chord riff on one chord, a one-bar I-V-vi-IV riff. Its lines are a
# chord, not one pitched source, so whatever key the other rules let through must stay.
# CHORD_KEYED_SEEDED maps each family to (signal, its key as (tonic, mode)).

PITCH_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_TIMBRES = {
    "pad": [(1, 1.0), (2, 0.5), (3, 0.3), (4, 0.2)],
    "organ": [(0.5, 0.5), (1, 1.0), (2, 0.7), (3, 0.4), (4, 0.3), (6, 0.15)],
    "saw": [(k, 1.0 / k) for k in range(1, 9)],
}


def _chord_tone(midi_notes, t: np.ndarray, timbre: str) -> np.ndarray:
    return sum(
        w * np.sin(2 * np.pi * hz(m) * r * t)
        for m in midi_notes
        for r, w in _TIMBRES[timbre]
        if hz(m) * r < 5000
    )


def _key_draw(rng, mode: str | None = None) -> tuple[int, str]:
    root = int(rng.integers(0, 12))
    if mode is None:
        mode = "minor" if rng.uniform() < 0.5 else "major"
    return root, mode


def _triad(root: int, mode: str, base: int = 48) -> list[int]:
    return [base + root, base + root + (3 if mode == "minor" else 4), base + root + 7]


def _held_chord(seed: int) -> tuple[np.ndarray, tuple[str, str], np.random.Generator]:
    """A chord held for 30 s (root doubled an octave down on even seeds), 50 ms edges."""
    rng = np.random.default_rng(seed)
    root, mode = _key_draw(rng)
    notes = _triad(root, mode)
    if seed % 2 == 0:
        notes = notes + [notes[0] - 12]
    timbre = ("pad", "organ", "saw")[int(rng.integers(0, 3))]
    t = seconds_of(30.0)
    y = _chord_tone(notes, t, timbre) * np.minimum(1, t / 0.05) * np.minimum(1, (30 - t) / 0.05)
    return y, (PITCH_NAMES[root], mode), rng


def _with_drums(y: np.ndarray, seed: int, db: float = -6.0) -> np.ndarray:
    return normalise(_db(y, 0.0) + _db(_drums_at(seed), db))


def seeded_faded_pad(seed: int):
    """A held chord faded in and out over 1-2 s each, over drums on odd seeds."""
    y, key, rng = _held_chord(seed)
    t = seconds_of(30.0)
    fade_in, fade_out = rng.uniform(1.0, 2.0, 2)
    y = y * np.minimum(1, t / fade_in) * np.minimum(1, (30 - t) / fade_out)
    return (_with_drums(y, seed) if seed % 2 else normalise(y)), key


def seeded_swelling_pad(seed: int):
    """A held chord swelling and fading every 5-12 s."""
    y, key, rng = _held_chord(seed)
    t = seconds_of(30.0)
    depth = rng.uniform(0.2, 0.45)
    swell = 1 - depth + depth * np.sin(2 * np.pi * rng.uniform(0.08, 0.2) * t + rng.uniform(0, 6))
    return normalise(y * swell), key


def seeded_crescendo_pad(seed: int):
    """A held chord getting louder over the window (quieter on odd seeds), 10-20 dB."""
    y, key, rng = _held_chord(seed)
    t = seconds_of(30.0)
    level = 10 ** (-rng.uniform(10, 20) * (1 - t / 30) / 20)
    return normalise(y * (level[::-1] if seed % 2 else level)), key


def seeded_tremolo_pad(seed: int):
    """A held chord with a 5.5-6.5 Hz tremolo, 40-60 % deep."""
    y, key, rng = _held_chord(seed)
    t = seconds_of(30.0)
    depth = rng.uniform(0.4, 0.6)
    return normalise(
        y * (1 - depth * (0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(5.5, 6.5) * t)))
    ), key


def seeded_pumped_pad(seed: int):
    """A held chord ducked by a 128 BPM sidechain (70-90 %), with the kick on odd seeds."""
    y, key, rng = _held_chord(seed)
    t = seconds_of(30.0)
    beat = 60.0 / 128.0
    pump = 1 - rng.uniform(0.7, 0.9) * np.exp(-(t % beat) / rng.uniform(0.08, 0.15))
    y = normalise(y * pump).astype(float)
    if seed % 2:
        kick = np.zeros(30 * SR)
        for start in grid(128.0):
            place(kick, start, Kit(seed=seed).kick)
        y = normalise(_db(y, 0.0) + _db(kick, -3.0))
    return y, key


def _stabs(chords, rng, bpm: float, seconds: float = 30.0) -> np.ndarray:
    """Each bar: the chords of `chords` in turn on a hit pattern, decaying stabs."""
    beat = 60.0 / bpm
    hits = ([0, 1, 2, 3], [0.5, 1.5, 2.5, 3.5], [0, 1.5, 2.5, 3.5])[int(rng.integers(0, 3))]
    decay = rng.uniform(0.08, 0.35)
    timbre = ("pad", "organ", "saw")[int(rng.integers(0, 3))]
    length = min(beat, 3 * decay)
    t = seconds_of(length)
    shaped = np.exp(-t / decay) * np.minimum(1, t / 0.004) * np.minimum(1, (length - t) / 0.01)
    sounds = [_chord_tone(c, t, timbre) * shaped for c in chords]
    y = np.zeros(int(seconds * SR))
    for start in np.arange(0.0, seconds, 4 * beat):
        for j, h in enumerate(hits):
            place(y, float(start + h * beat), sounds[j % len(sounds)])
    return y


def seeded_c_major_stabs(seed: int):
    """C major stabs (one of three voicings) on a one-bar pattern, over drums on odd seeds."""
    rng = np.random.default_rng(seed)
    voicing = ([48, 52, 55, 60, 64], [60, 64, 67], [55, 60, 64, 67])[int(rng.integers(0, 3))]
    bpm = rng.uniform(110.0, 130.0)
    y = _stabs([voicing], rng, bpm)
    return (_with_drums(y, seed, -3.0) if seed % 2 else normalise(y)), ("C", "major")


def seeded_one_chord_riff(seed: int):
    """A bass and a chord on eighths together (one envelope), on one chord, over drums."""
    rng = np.random.default_rng(seed)
    root, mode = _key_draw(rng)
    bpm = rng.uniform(100.0, 130.0)
    eighth = 30.0 / bpm
    chord = _triad(root, mode, 55)
    t = seconds_of(0.9 * eighth)
    envelope = np.exp(-t / rng.uniform(0.08, 0.2)) * np.minimum(1, t / 0.004)
    bass = sum(np.sin(2 * np.pi * hz(chord[0] - 24) * k * t) / k for k in range(1, 11))
    sound = (_chord_tone(chord, t, "saw") + 1.5 * bass) * envelope
    y = np.zeros(30 * SR)
    for start in np.arange(0.0, 30.0, eighth):
        place(y, float(start), sound)
    return _with_drums(y, seed, -4.0), (PITCH_NAMES[(chord[0]) % 12], mode)


def seeded_one_bar_riff(seed: int):
    """I-V-vi-IV stabs within one bar at 118-140 BPM, drums at -12 to -3 dB or none."""
    rng = np.random.default_rng(seed)
    root, _ = _key_draw(rng, "major")
    bpm = rng.uniform(118.0, 140.0)
    chords = [[60 + root + i for i in c] for c in ([0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0])]
    chords = [c + [c[0] - 12] for c in chords]
    y = _stabs(chords, rng, bpm)
    drums_db = (None, -12.0, -6.0, -3.0)[int(rng.integers(0, 4))]
    y = normalise(y) if drums_db is None else _with_drums(y, seed, drums_db)
    return y, (PITCH_NAMES[root], "major")


CHORD_KEYED_SEEDED = {
    "faded-pad": seeded_faded_pad,
    "swelling-pad": seeded_swelling_pad,
    "crescendo-pad": seeded_crescendo_pad,
    "tremolo-pad": seeded_tremolo_pad,
    "pumped-pad": seeded_pumped_pad,
    "c-major-stabs": seeded_c_major_stabs,
    "one-chord-riff": seeded_one_chord_riff,
    "one-bar-riff": seeded_one_bar_riff,
}
CHORD_KEYED_SEEDS = range(700, 730)


# A triad with its root doubled an octave down and its third softer than root and fifth
# (THIRD_LEVELS_DB), at every root C3-B3, both modes and three timbres, each pumped, faded,
# with tremolo or stabbed (soft_third_shape: every level meets every shape, 18 times). The stacked root is
# the strongest line, and the third sits within its STFT main lobe at C3-D#3: what is still a
# chord at these levels must stay one.
THIRD_LEVELS_DB = (-1.5, -3.0, -4.5, -6.0)
SHAPES = ("pumped", "faded", "tremolo", "stabs")
SOFT_THIRD_GRID = tuple(
    (root, mode, timbre, level)
    for root in range(12)
    for mode in ("minor", "major")
    for timbre in ("pad", "organ", "saw")
    for level in THIRD_LEVELS_DB
)


def _shaped(y_of, shape: str) -> np.ndarray:
    """`y_of(t)` held for 30 s and shaped: pumped at 128 BPM, faded, with tremolo, or stabbed."""
    t = seconds_of(30.0)
    if shape == "stabs":
        beat = 60.0 / 120.0
        length = 0.3
        ts = seconds_of(length)
        sound = y_of(ts) * np.exp(-ts / 0.12) * np.minimum(1, ts / 0.004)
        sound *= np.minimum(1, (length - ts) / 0.01)
        y = np.zeros(t.size)
        for start in np.arange(0.0, 30.0, beat):
            place(y, float(start), sound)
        return normalise(y)
    y = y_of(t) * np.minimum(1, t / 0.05) * np.minimum(1, (30 - t) / 0.05)
    if shape == "pumped":
        y = y * (1 - 0.8 * np.exp(-(t % (60.0 / 128.0)) / 0.1))
    elif shape == "faded":
        y = y * np.minimum(1, t / 1.5) * np.minimum(1, (30 - t) / 1.5)
    elif shape == "tremolo":
        y = y * (1 - 0.5 * (0.5 + 0.5 * np.sin(2 * np.pi * 6.0 * t)))
    return normalise(y)


def soft_third_chord(index: int):
    """SOFT_THIRD_GRID[index] as a signal, with its key."""
    root, mode, timbre, level = SOFT_THIRD_GRID[index]
    triad = _triad(root, mode)
    gain = 10 ** (level / 20)

    def y_of(t):
        return _chord_tone([triad[0], triad[2], triad[0] - 12], t, timbre) + gain * _chord_tone(
            [triad[1]], t, timbre
        )

    return _shaped(y_of, soft_third_shape(index)), (PITCH_NAMES[root], mode)


def soft_third_shape(index: int) -> str:
    return SHAPES[(index + index // len(THIRD_LEVELS_DB)) % len(SHAPES)]


# A root doubled an octave down with its third over it and no fifth, the third detuned by
# THIRD_DETUNE_CENTS: still a third (the key of the dyad is the root's major or minor).
THIRD_DETUNE_CENTS = (-25.0, -20.0, -10.0, 10.0, 20.0, 25.0)


def detuned_third(root: int, mode: str, cents: float, timbre: str = "saw") -> np.ndarray:
    third = _triad(root, mode)[1] + cents / 100

    def y_of(t):
        return _chord_tone([48 + root, 36 + root], t, timbre) + _chord_tone([third], t, timbre)

    return _shaped(y_of, "pumped")


def sus_chord(root: int, kind: str, timbre: str = "organ", shape: str = "stabs") -> np.ndarray:
    """A sus2 or sus4 chord (root, second or fourth, fifth) with its root doubled below."""
    notes = [48 + root, 48 + root + (2 if kind == "sus2" else 5), 48 + root + 7, 36 + root]
    return _shaped(lambda t: _chord_tone(notes, t, timbre), shape)


# A seventh chord whose fifth (6 dB down) folds into a root doubled an octave below and whose
# third is quiet (6-12 dB down) under a seventh at 0 or +6 dB: root and seventh are what is
# left, and a seventh is a chord. Every root, m7 and maj7, three timbres, four shapes.
SEVENTH_GRID = tuple(
    (root, quality, third_db, seventh_db)
    for root in range(12)
    for quality in ("m7", "maj7")
    for third_db in (-6.0, -9.0, -12.0)
    for seventh_db in (0.0, 6.0)
)


def seventh_chord(index: int):
    """SEVENTH_GRID[index] as a signal, with its key (m7: minor, maj7: major)."""
    root, quality, third_db, seventh_db = SEVENTH_GRID[index]
    mode = "minor" if quality == "m7" else "major"
    third, seventh = (3, 10) if quality == "m7" else (4, 11)
    timbre = ("pad", "saw", "organ")[index % 3]
    voices = [
        (36 + root, 0.0),
        (48 + root, 0.0),
        (48 + root + third, third_db),
        (55 + root, -6.0),
        (48 + root + seventh, seventh_db),
    ]

    def y_of(t):
        return sum(10 ** (db / 20) * _chord_tone([m], t, timbre) for m, db in voices)

    shape = SHAPES[(index + index // 6) % len(SHAPES)]
    return _shaped(y_of, shape), (PITCH_NAMES[root], mode)


# Two limits of the notes test, kept as signals so that tests can say what happens to them:
# a fourth (fifth below, root above) with its third 15 dB down, and a sine bass 15 dB over a
# triad whose third is 3 dB down. In both the third does not count and the key is withheld.
def fourth_with_quiet_third(root: int = 0, third_db: float = -15.0) -> np.ndarray:
    voices = [(43 + root, 0.0), (48 + root, 0.0), (52 + root, third_db)]
    return _shaped(
        lambda t: sum(10 ** (db / 20) * _chord_tone([m], t, "saw") for m, db in voices),
        "tremolo",
    )


def _phased_tone(midi: float, t: np.ndarray, partials, db: float = 0.0) -> np.ndarray:
    """One note whose partials start at phases drawn from the note (not all at zero)."""
    rng = np.random.default_rng(int(midi * 100))
    f0 = hz(midi)
    y = sum(
        w * np.sin(2 * np.pi * f0 * r * t + rng.uniform(0, 6.28))
        for r, w in partials
        if f0 * r < 5000
    )
    return 10 ** (db / 20) * y


def triad_under_a_loud_sine_bass(root: int = 9, bass_db: float = 15.0) -> np.ndarray:
    voices = [(48 + root, 0.0), (52 + root, -3.0), (55 + root, 0.0)]

    def y_of(t):
        bass = _phased_tone(36 + root, t, [(1, 1.0)], bass_db)
        return bass + sum(_phased_tone(m, t, _TIMBRES["organ"], db) for m, db in voices)

    return _shaped(y_of, "tremolo")


def chord_key(family: str, seed: int) -> tuple[str, str]:
    """The key of CHORD_KEYED_SEEDED[family](seed), without making the signal."""
    if family == "c-major-stabs":
        return ("C", "major")
    rng = np.random.default_rng(seed)
    if family == "one-bar-riff":
        return (PITCH_NAMES[_key_draw(rng, "major")[0]], "major")
    root, mode = _key_draw(rng)
    if family == "one-chord-riff":
        return (PITCH_NAMES[_triad(root, mode, 55)[0] % 12], mode)
    return (PITCH_NAMES[root], mode)


def probes() -> dict[str, np.ndarray]:
    """Named probe signals used across the tests (and for threshold measurements)."""
    return {
        # pitchless rhythm: no key
        "noise-bursts": noise_bursts(),
        "drums-only-97": drums_only(97, seed=1),
        "drums-only-120": drums_only(120, seed=2),
        "drums-only-140": drums_only(140, seed=3),
        "metronome-1kHz": metronome(),
        "metronome-accented": metronome(accent=1500.0),
        "square-2Hz": square_wave(),
        "brown-noise-with-kick": noise_with_beat(2),
        "pink-noise-with-bursts": noise_with_beat(1, kick=False),
        "drums-crash-jitter-15ms": band(jittered(100, 0.015), chords=False, crash=True),
        "drums-crash-jitter-25ms": band(jittered(100, 0.025), chords=False, crash=True),
        "drums-crash-jitter-40ms": band(jittered(100, 0.040), chords=False, crash=True),
        # hum: no key
        "hum-50Hz-steep": hum(50),
        "hum-50Hz-gentle": hum(50, gentle=True),
        "hum-60Hz-gentle": hum(60, gentle=True),
        # tonal music: a key
        "band-97": drum_pattern(97),
        "band-jitter-10ms": band(jittered(100, 0.010)),
        "chords-D": chord_pad_progression(),
        "rain-chords-0dB": under_noise(chord_pad_progression()),
        "rain-piano-0dB": under_noise(piano_line()),
        "piano-line": piano_line(),
        "tempo-change-90-130": tempo_change(),
        "accelerando-80-140": band(accelerando(80, 140)),
        "chords-under-loud-drums": normalise(chord_pad_progression() + 4 * drums_only(120, seed=2)),
        "piano-under-loud-drums": normalise(piano_line() + 4 * drums_only(97, seed=1)),
        # one held pitch (vibrato, a bend) without a beat: no key
        "A4-vibrato-40c": held_note(440.0, 40),
        "A4-vibrato-80c": held_note(440.0, 80),
        "A4-vibrato-120c": held_note(440.0, 120),
        "Bb3-brass-vibrato-40c": held_note(233.08, 40, 5.5, BRASS),
        "Bb3-brass-vibrato-80c": held_note(233.08, 80, 5.5, BRASS),
        "Bb3-brass-vibrato-120c": held_note(233.08, 120, 5.5, BRASS),
        "F4-brass-vibrato-40c": held_note(349.23, 40, 5.5, BRASS),
        "D4-clarinet-vibrato": held_note(293.66, 35, 5.0, CLARINET),
        "bend-2-semitones": bend(),
        # one voice with notes: a key
        "sung-melody-vibrato": sung_melody(),
        # a drone with a drum beat: music
        "drone-with-drums": normalise(hum(110, gentle=True) + 2 * drums_only(120, seed=2)),
        # noise with one tonal artefact: gated
        "white-noise-whine-14dB": noise_with_tone(held_note(1000.0, weights=[1]), 0, -14),
        "white-noise-whine-10dB": noise_with_tone(held_note(1000.0, weights=[1]), 0, -10),
        "white-noise-whine-6dB": noise_with_tone(held_note(1000.0, weights=[1]), 0, -6),
        "pink-noise-hum-6dB": noise_with_tone(hum(50), 1, -6),
        # a steady tempo from 10 s on: reported
        "band-97-after-10s-silence": late_start(drum_pattern(97), 10.0),
        "band-97-after-10s-pad": late_start(drum_pattern(97), 10.0, "pad"),
        "band-132-after-12s-pad": late_start(drum_pattern(132), 12.0, "pad"),
        "band-85-after-10s-pad": late_start(drum_pattern(85), 10.0, "pad"),
        # noise: gated
        "white-noise": colored_noise(0, seconds=30.0),
        "pink-noise": colored_noise(1, seconds=30.0),
        "brown-noise": colored_noise(2, seconds=30.0),
    }

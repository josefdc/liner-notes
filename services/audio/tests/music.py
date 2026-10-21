"""
Music-like test material with the detail real recordings have: sung and played melodies with
vibrato, scoops and intonation drift, formant voices, speech with irregular syllables, and band
mixes with a bass line at 41-73 Hz. All generators are deterministic (fixed seeds) and return
float32 mono at SR (22.05 kHz), peak-normalised.
"""

import numpy as np

SR = 22050
MAJOR = {0, 2, 4, 5, 7, 9, 11}
MINOR = {0, 2, 3, 5, 7, 8, 10}
# Formants F1-F3 (Hz) of five vowels.
VOWELS = {
    "a": (730, 1090, 2440),
    "e": (530, 1840, 2480),
    "i": (390, 1990, 2550),
    "o": (570, 840, 2410),
    "u": (440, 1020, 2240),
}
# Harmonic amplitudes of a few instruments.
TRUMPET = [0.5, 1, 1, 0.9, 0.8, 0.5, 0.4, 0.3, 0.2, 0.1]
FLUTE = [1, 0.4, 0.15, 0.08, 0.04]
BRASS = [0.5, 1, 1, 0.9, 0.8, 0.4, 0.3, 0.2]
# One bar of drums: (sixteenth, instrument, gain).
ROCK = [(0, "kick", 1), (8, "kick", 1), (4, "snare", 0.8), (12, "snare", 0.8)] + [
    (s, "hat", 0.2) for s in range(0, 16, 2)
]
TRAP = [(0, "kick", 1), (6, "kick", 0.8), (11, "kick", 0.7), (8, "snare", 1)] + [
    (s, "hat", 0.15) for s in range(16)
]


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def seconds_of(duration: float) -> np.ndarray:
    return np.arange(int(duration * SR)) / SR


def normalise(y: np.ndarray, peak: float = 0.8) -> np.ndarray:
    top = float(np.max(np.abs(y)))
    return (peak * y / top).astype(np.float32) if top > 0 else y.astype(np.float32)


def place(y: np.ndarray, start: float, sound: np.ndarray) -> None:
    i = int(round(start * SR))
    if 0 <= i < len(y):
        j = min(len(y), i + len(sound))
        y[i:j] += sound[: j - i]


def rms(y: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(y, dtype=np.float64))))


def mix(*parts) -> np.ndarray:
    """(signal, level in dB relative to unit RMS) pairs, summed and peak-normalised."""
    y = np.zeros(max(len(p) for p, _ in parts))
    for part, db in parts:
        y[: len(part)] += part / max(rms(part), 1e-12) * 10 ** (db / 20)
    return normalise(y)


def scale(root: int, mode: str) -> set[int]:
    return {(p + root) % 12 for p in (MAJOR if mode == "major" else MINOR)}


def melody(pitches: set[int], low: int, high: int, seed: int, shortest=0.3, longest=1.2, step=3):
    """A random walk on the scale `pitches` between MIDI `low` and `high`, filling 30 s."""
    rng = np.random.default_rng(seed)
    pool = [m for m in range(low, high + 1) if m % 12 in pitches]
    i, t, notes, durations = len(pool) // 2, 0.0, [], []
    while t < 30.0:
        i = int(np.clip(i + rng.integers(-step, step + 1), 0, len(pool) - 1))
        notes.append(pool[i])
        durations.append(float(rng.uniform(shortest, longest)))
        t += durations[-1]
    return notes, durations


def f0_track(
    notes,
    durations,
    vibrato=0.0,
    rate=5.5,
    glide=0.0,
    intonation=0.0,
    scoop=0.0,
    gap=0.0,
    vibrato_delay=0.0,
    seed=3,
):
    """f0 (Hz) and amplitude per sample for the notes, as a singer or player shapes them."""
    rng = np.random.default_rng(seed)
    n = int(sum(durations) * SR)
    cents, amp = np.zeros(n), np.zeros(n)
    i, previous = 0, None
    for note, duration in zip(notes, durations, strict=True):
        length = min(int(duration * SR), n - i)
        if length <= 0:
            break
        target = 100 * (note - 69) + (rng.normal(0, intonation) if intonation else 0.0)
        c = np.full(length, target)
        t = np.arange(length) / SR
        if glide and previous is not None:
            k = min(length, int(glide * SR))
            c[:k] = previous + (target - previous) * (0.5 - 0.5 * np.cos(np.pi * np.arange(k) / k))
        if scoop:
            k = min(length, int(0.08 * SR))
            c[:k] -= scoop * (1 - np.arange(k) / k)
        if vibrato:
            onset = np.clip((t - vibrato_delay) / 0.25, 0, 1) if vibrato_delay else 1.0
            c += vibrato * onset * np.sin(2 * np.pi * rate * t + rng.uniform(0, 2 * np.pi))
        a = np.ones(length)
        attack = min(length, int(0.04 * SR))
        a[:attack] = np.linspace(0, 1, attack)
        if gap:
            silent = min(length, int(gap * SR))
            fade = min(length - silent, int(0.06 * SR))
            a[length - silent :] = 0
            a[length - silent - fade : length - silent] = np.linspace(1, 0, fade)
        cents[i : i + length], amp[i : i + length] = c, a
        previous, i = target, i + length
    return 440.0 * 2 ** (cents / 1200), amp


def formant_gain(f: np.ndarray, formants) -> np.ndarray:
    widths = (90, 110, 140)
    return 0.15 + sum(1 / (1 + ((f - c) / w) ** 2) for c, w in zip(formants, widths, strict=True))


def voice(f0: np.ndarray, amp: np.ndarray, vowels=None, harmonics=40, tilt=1.0) -> np.ndarray:
    """A formant voice: harmonic k at k^-tilt times the vowel's formant envelope."""
    phase = 2 * np.pi * np.cumsum(f0) / SR
    names = list(VOWELS)
    y = np.zeros_like(f0)
    for k in range(1, harmonics + 1):
        fk = k * f0
        audible = fk < SR / 2 - 200
        if not audible.any():
            break
        if vowels is None:
            gain = formant_gain(fk, VOWELS["a"])
        else:
            gain = np.zeros_like(fk)
            for v, name in enumerate(names):
                sel = vowels == v
                gain[sel] = formant_gain(fk[sel], VOWELS[name])
        y += np.where(audible, k**-tilt * gain * np.sin(k * phase), 0.0)
    return y * amp


def additive(f0: np.ndarray, weights, amp=None) -> np.ndarray:
    phase = 2 * np.pi * np.cumsum(f0) / SR
    y = sum(
        w * np.sin((k + 1) * phase) for k, w in enumerate(weights) if (k + 1) * f0.max() < SR / 2
    )
    return y * (1 if amp is None else amp)


def pad_chord(freqs, duration: float, weights=(1, 0.5, 0.3, 0.2)) -> np.ndarray:
    t = seconds_of(duration)
    y = sum(w * np.sin(2 * np.pi * f * (k + 1) * t) for f in freqs for k, w in enumerate(weights))
    return y * np.minimum(1, t / 0.3) * np.minimum(1, (duration - t) / 0.3)


def drums(pattern, bpm: float, seconds: float = 30.0, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = seconds_of(0.3)
    kit = {
        "kick": np.sin(2 * np.pi * (45 + 90 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.15),
        "snare": (0.6 * rng.standard_normal(t.size) + 0.4 * np.sin(2 * np.pi * 190 * t))
        * np.exp(-t / 0.07),
    }
    th = seconds_of(0.05)
    kit["hat"] = np.diff(rng.standard_normal(th.size + 1)) * np.exp(-th / 0.015)
    y = np.zeros(int(seconds * SR))
    bar = 240.0 / bpm
    for start in np.arange(0, seconds, bar):
        for step, instrument, gain in pattern:
            place(y, start + step * bar / 16, gain * kit[instrument])
    return y


# --- single voices and instruments ---------------------------------------------------------


def sung(
    root: int,
    mode: str,
    low: int,
    high: int,
    seed: int,
    vibrato: float = 30.0,
    scoop: float = 40.0,
    glide: float = 0.1,
    rate: float = 5.6,
) -> np.ndarray:
    """An a cappella line: scoops, glides, intonation drift and vibrato, vowels per note."""
    notes, durations = melody(scale(root, mode), low, high, seed, 0.4, 1.4)
    f0, amp = f0_track(notes, durations, vibrato, rate, glide, 12, scoop, 0.05, 0.2, seed)
    n = int(30 * SR)
    vowels = np.zeros(f0.size, int)
    rng, i = np.random.default_rng(seed + 100), 0
    for duration in durations:
        length = int(duration * SR)
        vowels[i : i + length] = rng.integers(0, len(VOWELS))
        i += length
    return normalise(voice(f0[:n], amp[:n], vowels[:n], tilt=1.1))


def played(root: int, mode: str, low: int, high: int, seed: int, weights, vibrato=0.0, step=3):
    notes, durations = melody(scale(root, mode), low, high, seed, 0.6, 2.0, step)
    f0, amp = f0_track(notes, durations, vibrato, 5.5, 0.05, 8, 0, 0.03, 0.0, seed)
    n = int(30 * SR)
    return normalise(additive(f0[:n], weights, amp[:n]))


def trumpet_melody() -> np.ndarray:
    """A narrow trumpet line in Bb major: D4, Eb4, F4 and G4 in steps, +-40 cents of vibrato."""
    return played(10, "major", 62, 67, 62, TRUMPET, 40.0, step=1)


def held(f0: float, vibrato: float = 60.0, rate: float = 5.5, weights=BRASS) -> np.ndarray:
    """One held note with vibrato."""
    t = seconds_of(30.0)
    return normalise(additive(f0 * 2 ** ((vibrato / 1200) * np.sin(2 * np.pi * rate * t)), weights))


def speech(seed: int = 4, low: float = 95.0, high: float = 160.0) -> np.ndarray:
    """
    Speech-like: one voice whose pitch glides with intonation (no notes), in syllables of
    irregular length (80-300 ms) with vowel changes and pauses, in phrases.
    """
    rng = np.random.default_rng(seed)
    n = int(30 * SR)
    walk = np.cumsum(rng.normal(0, 0.003, n))
    walk = (walk - walk.min()) / np.ptp(walk)
    f0 = low * (high / low) ** walk
    vowels, amp, i = np.zeros(n, int), np.zeros(n), 0
    while i < n:
        length = int(rng.uniform(0.08, 0.3) * SR)
        vowels[i : i + length] = rng.integers(0, len(VOWELS))
        amp[i : i + length] = 1.0 if rng.uniform() > 0.25 else 0.0
        i += length
    amp = np.convolve(amp, np.ones(200) / 200, mode="same")
    phrases = (np.sin(2 * np.pi * 0.2 * seconds_of(30.0)) > -0.6).astype(float)
    return normalise(voice(f0, amp * phrases, vowels))


# --- ensembles ---------------------------------------------------------------------------


def bass(roots, bar: float, weights=(1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6)) -> np.ndarray:
    """Eighth notes on the root of each bar, decaying (a picked bass)."""
    y = np.zeros(int(30 * SR))
    t, eighth = 0.0, bar / 8
    while t < 30.0:
        f = hz(roots[int(t // bar) % len(roots)])
        length = seconds_of(eighth * 0.95)
        note = sum(w * np.sin(2 * np.pi * f * (h + 1) * length) for h, w in enumerate(weights))
        place(y, t, note * np.exp(-length / 0.25))
        t += eighth
    return y


def chords(progression, bar: float, bars_per_chord: int = 2) -> np.ndarray:
    """A slightly detuned pad, one chord every `bars_per_chord` bars."""
    y = np.zeros(int(30 * SR))
    for k, start in enumerate(np.arange(0, 30, bar)):
        chord = progression[(k // bars_per_chord) % len(progression)]
        freqs = [hz(m) * (1 + d) for m in chord for d in (-0.004, 0.0, 0.0045)]
        place(y, start, pad_chord(freqs, bar, (1, 0.6, 0.36, 0.22, 0.13, 0.08)))
    return y


# Progressions (MIDI chords) with their key.
PROGRESSIONS = {
    "C-G-Am-F": ([(48, 52, 55), (43, 47, 50), (45, 48, 52), (41, 45, 48)], ("C", "major")),
    "Dm-C": ([(50, 53, 57), (48, 52, 55)], ("D", "minor")),
    "C-vamp": ([(48, 52, 55)], ("C", "major")),
    "Em-A": ([(52, 55, 59), (45, 49, 52)], ("E", "minor")),
}
ROOTS = {"C": 0, "D": 2, "E": 4}


def band_mix(
    progression: str,
    with_drums: bool = True,
    bass_db: float = 0.0,
    lead_db: float = -6.0,
    bass_shift: int = 0,
):
    """
    Drums, a bass line on the chord roots between E1 and D2 (41-73 Hz; `bass_shift` semitones
    lower or higher), a pad and a sung lead in the key.
    """
    chords_, (tonic, mode) = PROGRESSIONS[progression]
    bpm = 100
    bar = 240.0 / bpm
    lowest = [chord[0] - 12 if chord[0] - 12 <= 39 else chord[0] - 24 for chord in chords_]
    roots = [note + bass_shift for note in lowest for _ in range(2)]
    root = ROOTS[tonic]
    parts = [(bass(roots, bar), bass_db), (chords(chords_, bar), -4)]
    if with_drums:
        parts.insert(0, (drums(ROCK, bpm), 0))
    lead_notes, durations = melody(scale(root, mode), 60 + root, 74 + root, 1, 0.2, 0.8)
    f0, amp = f0_track(lead_notes, durations, 30, 5.5, 0.05, 10, 60, 0.06, 0.25, 1)
    n = int(30 * SR)
    parts.append((voice(f0[:n], amp[:n], None, tilt=1.1), lead_db))
    return mix(*parts)


def ambient_pad(chord=(57, 60, 64)) -> np.ndarray:
    """One sustained chord with its root doubled one and two octaves down (A1 for A minor)."""
    notes = list(chord) + [chord[0] - 12, chord[0] - 24]
    return normalise(pad_chord([hz(m) for m in notes], 30.6))


def melody_over_drone(drone_db: float = 6.0) -> np.ndarray:
    """A D2 drone (cello-like) under a flute melody in D major."""
    n = int(30 * SR)
    drone = additive(np.full(n, hz(38)), [1, 0.7, 0.5, 0.35, 0.25, 0.15])
    notes, durations = melody(scale(2, "major"), 62, 79, 81, 0.4, 1.2)
    f0, amp = f0_track(notes, durations, 20, 5.5, 0.05, 5, 0, 0.04, 0.0, 81)
    return mix((drone, drone_db), (additive(f0[:n], FLUTE, amp[:n]), 0.0))

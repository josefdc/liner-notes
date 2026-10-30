"""
Rules that could withhold the keys still served to a cowbell, a one-note bass and a church
bell, alone and over drums: one-pitched-source controls whose lines hold still and move
together, so the single-source rule asks what they spell, and they spell a chord. Measured on
the newest committed report, as scripts/drum_rules.py measures the drum rules and with its
code: how many of these keys each rule would withhold, and how many right keys it would take
from every other control and from the GiantSteps+ clips.

Every rule here is asked only where the single-source rule asks what the lines spell (its time
test holds: SourceEvidence.still), after it has found a chord, so it can only withhold a key
that is served from still lines. As in drum_rules.py, every control and clip with a served key
is made again, decoded and analysed by the service, and reproduce() checks each against the
report before anything is reported; here the notes the lines spell (read again by this
script's own copy of source_notes) must also be the recorded ones.

Why each family keeps a key, from the lines source_notes reads (level: the line's share of the
strongest line). The run prints the notes of every keyed control, and for the basses the causes
(kept_because, bass_causes); tests/test_still_chord_rules.py pins them.

- **Cowbell**: two square waves. In s508, s515, s600 and s601 their two notes lie a minor sixth
  apart, within SOURCE_THIRD_CENTS of 800 cents (s515 at 830, on the edge, which counts): a
  sixth is a chord interval. s601 also has a line at 49.2 Hz, a third pitch class. In s528 and
  s606 the line on the third harmonic of one oscillator reads 0.53 and 0.51 of that
  oscillator's level, over SOURCE_OVERTONE_RATIO, so it is not folded and counts as a third
  pitch class.
- **One-note bass**: notes the overtone test does not fold into the bass note, for one or more
  of three reasons. Harmonics lie further than SOURCE_NOTE_TOLERANCE from a multiple of the
  note's line: in s500, s611, s617 and s626, whose harmonics the generator stretches as a stiff
  string's (B = 0.0008), and in s501 (B = 0), whose line a line 120 cents under it pulls off.
  That line, like the line beside s615's note, is the bass's own: it is there without the
  drums, from re-striking the note every sixteenth, not a whole number of its periods.
  Harmonics on the line are louder than SOURCE_OVERTONE_RATIO of the note: in s611 (0.60), s612
  (0.53 and 0.51) and s615 (0.60). Lines under or beside the note count as notes of their own:
  in s500, s501, s611, s612, s615 and s626. Without the line beside its note, s615 spells no
  chord, and s617 none without its harmonics off the line; the others still spell one without
  any one of their causes.
- **Church bell, alone and over drums**: the tierce, a minor tenth over the hum, already spells a
  chord with it (s513 alone and over drums has only these two pitch classes). In the rest, the
  quint and the upper third (BELL_RATIOS in services/audio/tests/signals.py) lie 0.35-0.56 %
  off the hum's harmonics, beyond SOURCE_NOTE_TOLERANCE, and count as notes too: with the hum
  and the tierce they spell a minor triad on the hum, most often with a major third over it.

The measurements, each on still lines only (None elsewhere):

- **A higher overtone ratio**: the lowest ratio (from SOURCE_OVERTONE_RATIO up, in steps of
  0.01) at which a line on a harmonic of a note folds into it and the notes no longer spell a
  chord.
- **One stretched harmonic series**: the largest share of the lines' level that one harmonic
  series explains, its fundamental within OCTAVE_SPAN of a line and its harmonics stretched as
  a stiff string's, k f0 sqrt(1 + B k^2) with B up to STIFFNESS[-1]: the note tolerances of
  source_notes around each (an octave's for the powers of two). This is the model
  seeded_one_note_bass (services/audio/tests/signals.py) makes the bass controls with, B 0,
  0.0002 or 0.0008, so the bass controls fit it by construction. With CLOSE_CENTS: the same
  after the lines within CLOSE_CENTS of a stronger one are merged into it.
- **A third or sixth off the grid**: when the notes spell two pitch classes a third or a sixth
  apart, the least distance from equal temperament among those pairs, in cents.
- **Lines dying away after each hit** (drum_rules.decaying_lines): the share of the hits'
  harmonic energy 70 ms or more after each hit's loudest frame.
- **Both thirds over one note**: 1 when a note has a minor and a major third (or tenth, or
  seventeenth) over it, each within SOURCE_THIRD_CENTS; else 0. A bell's tierce is a minor
  third over its hum, and its upper partial 2.514 (a major seventeenth) a major one.
- **Notes decaying at different rates**: per hit (drum_rules.hit_spans) of at least
  DECAY_MIN_FRAMES after its loudest frame, each note's decay in dB per second (a line fitted
  to its level in its STFT bins from the loudest frame on), for the notes at DECAY_LEVEL or
  more of the loudest one there; the fastest over the slowest (at least DECAY_FLOOR); the
  median over hits. A bell's partials each decay at their own rate; a chord's notes struck
  together decay together.
- **Note pairs off the grid** (source_rules.off_grid): the share of the notes' pairs more than
  20 cents off the equal-tempered grid.
- **The lowest note** (Hz), **pitch classes** (how many the notes spell) and **the two lowest
  notes' interval** (cents): three plain readings of the notes, aimed at the cowbells (whose
  oscillators lie over 500 Hz) and the basses (many pitch classes; a line next to the note).

Thresholds, halves and counts are drum_rules.candidates(): each threshold is chosen on the
training half and judged on the held-out half, one threshold for both estimators; seeded
controls go by seed (500-529 and 700-729 train), the unseeded ones and the clips alternately by
name. "More than half" counts only the families a rule is aimed at, and only the estimators
that served one of their keys in the training half (librosa served none of the training
one-note basses).

Every measurement and constant here was set after the recorded notes of every keyed control of
the four families, held-out seeds included, had been read from the report (before any
measurement of the held-out half was printed): the merge of close lines answers lines seen next
to the bass notes of seeds 501, 611, 615 and 626, and the three plain readings were proposed
after the first run. So no held-out number here is an untouched test. No GiantSteps+ clip with a
served key has still lines, so the clips can show no cost of these rules, and no gain.

The controls' chords have their roots in C3-B4, and none has a ninth or a second at the bottom,
so a rule that takes no right key among them can still take the keys of chords just outside
them. probe_chords() makes 276 such chords (triads from C5 up, ninth chords, triads with an
added second, some of it flat), analyses them as the controls are, and the run prints the right
keys each chosen threshold would take from them, and how near to each threshold the chords keyed
right come.

    cd evals/audio && uv sync --extra models
    uv run python scripts/still_chord_rules.py ../reports/audio-2026-10-29.json [--jobs J]

5-10 min at --jobs 4 on a shared machine, as its load allows. Needs what drum_rules.py needs: the GiantSteps+
audio and mirdata's index, checked first, and Essentia (the models extra; without it the
service answers for Essentia with librosa and the check against the report stops the run). In
a fresh environment, run once with --jobs 1 first: librosa's numba cache written by several
workers at once can crash them. After such a crash, delete the cache files (*.nbi, *.nbc under
librosa's __pycache__ directories in the environment) before running again. Nothing is
written. Deterministic.
"""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import drum_rules as D  # noqa: E402
import source_rules  # noqa: E402

FAMILIES = ("cowbell", "one-note-bass", "bell", "bell-over-drums")
BELLS = ("bell", "bell-over-drums")
RATIO_STEP = 0.01
OCTAVE_SPAN = 0.01  # a series' fundamental is sought within this of a line, as an octave
SPAN_STEPS = 41
STIFFNESS = np.linspace(0.0, 0.002, 21)  # B; the bass controls are made with 0, 2e-4 and 8e-4
CLOSE_CENTS = 150.0
DECAY_MIN_FRAMES = 8  # 186 ms
DECAY_LEVEL = 0.1
DECAY_FLOOR = 1.0  # dB per second
# Per measurement: 1 when a rule withholds at or above its threshold, -1 at or below.
MEASURES = {
    "a higher overtone ratio": -1,
    "one stretched harmonic series": 1,
    "one stretched series, close lines merged": 1,
    "a third or sixth off the grid": 1,
    "lines dying away after each hit": -1,
    "both thirds over one note": 1,
    "notes decaying at different rates": 1,
    "note pairs off the grid": 1,
    "the lowest note": 1,
    "pitch classes": 1,
    "the two lowest notes' interval": -1,
}
# Each script signs its own measurements: drum_rules signs its own names once more.
assert not set(MEASURES) & set(D.MEASURES)
# Per candidate, as drum_rules.CANDIDATES: how, measurements, the families it is aimed at.
CANDIDATES = {
    "a higher overtone ratio": ("any", ("a higher overtone ratio",), ("cowbell", "one-note-bass")),
    "a third or sixth off the grid": ("any", ("a third or sixth off the grid",), ("cowbell",)),
    "lines dying away after each hit": (
        "any",
        ("lines dying away after each hit",),
        ("cowbell",),
    ),
    "one stretched harmonic series": (
        "any",
        ("one stretched harmonic series",),
        ("one-note-bass",),
    ),
    "one stretched series, close lines merged": (
        "any",
        ("one stretched series, close lines merged",),
        ("one-note-bass",),
    ),
    "both thirds over one note": ("any", ("both thirds over one note",), BELLS),
    "notes decaying at different rates": ("any", ("notes decaying at different rates",), BELLS),
    "note pairs off the grid": ("any", ("note pairs off the grid",), BELLS),
    "the lowest note": ("any", ("the lowest note",), ("cowbell",)),
    "pitch classes": ("any", ("pitch classes",), ("one-note-bass",)),
    "the two lowest notes' interval": (
        "any",
        ("the two lowest notes' interval",),
        ("one-note-bass",),
    ),
}


def _service():
    from evals_audio import service

    return service.load()[1]


# --- what the lines spell ----------------------------------------------------------------------


def note_lines(stft: np.ndarray, sr: int, hop: int) -> list[tuple[float, float]]:
    """
    The lines source_notes reads (Hz, level over the strongest line), lowest first, from
    SOURCE_NOTE_FLOOR of the strongest: the same votes, histogram, peaks and merge.
    """
    import scipy.ndimage
    import scipy.signal

    E = _service()
    lo, hi = E.SERIES_LOW_HZ, E.HARMONIC_MAX_HZ
    n_fft = 2 * (stft.shape[0] - 1)
    rows = int(min(stft.shape[0], np.ceil(hi * n_fft / sr) + 2))
    if stft.shape[1] < 2 or rows < 3:
        return []
    spectrum = stft[:rows]
    k = np.arange(rows)[:, None]
    advance = np.angle(spectrum[:, 1:]) - np.angle(spectrum[:, :-1]) - 2 * np.pi * k * hop / n_fft
    advance = (advance + np.pi) % (2 * np.pi) - np.pi
    freqs = (k + advance * n_fft / (2 * np.pi * hop)) * sr / n_fft
    magnitude = np.abs(spectrum)
    weight = np.sqrt(magnitude[:, 1:] * magnitude[:, :-1])
    if not weight.max() > 0:
        return []
    vote = (weight > 1e-3 * weight.max()) & (freqs >= lo) & (freqs <= hi)
    position = 1200 * np.log2(freqs[vote] / lo) / E.SOURCE_NOTE_CENTS_BIN
    size = int(1200 * np.log2(hi / lo) / E.SOURCE_NOTE_CENTS_BIN) + 1
    histogram = np.bincount(position.astype(int), weights=weight[vote], minlength=size)
    smooth = scipy.ndimage.gaussian_filter1d(histogram, 2.0)
    if not smooth.max() > 0:
        return []
    found, _ = scipy.signal.find_peaks(smooth, prominence=0.01 * smooth.max())
    lines = [
        (
            lo * 2 ** ((i + 0.5) * E.SOURCE_NOTE_CENTS_BIN / 1200),
            float(histogram[max(0, i - 7) : i + 8].sum()),
        )
        for i in found
    ]
    kept: list[tuple[float, float]] = []
    for f, a in sorted(lines, key=lambda line: -line[1]):
        if all(E._cents(f, g) > E.SOURCE_NOTE_MERGE_CENTS for g, _ in kept):
            kept.append((f, a))
    if not kept:
        return []
    strongest = kept[0][1]
    return [(f, a / strongest) for f, a in sorted(kept) if a >= E.SOURCE_NOTE_FLOOR * strongest]


def _overtone(f: float, a: float, f0: float, a0: float, ratio: float) -> bool:
    """estimators._overtone on levels over the strongest line, with the overtone ratio `ratio`."""
    E = _service()
    harmonic = round(f / f0)
    if a0 < E.SOURCE_NOTE_LEVEL or not 2 <= harmonic <= E.SOURCE_NOTE_MAX_HARMONIC:
        return False
    if harmonic & (harmonic - 1) == 0:
        return abs(f - harmonic * f0) <= E.SOURCE_OCTAVE_TOLERANCE * f
    return abs(f - harmonic * f0) <= E.SOURCE_NOTE_TOLERANCE * f and a <= ratio * a0


def spelled(lines: list[tuple[float, float]], ratio: float | None = None) -> tuple[float, ...]:
    """The notes source_notes spells from `lines`, folding overtones up to `ratio` of a note."""
    E = _service()
    ratio = E.SOURCE_OVERTONE_RATIO if ratio is None else ratio
    notes: list[tuple[float, float]] = []
    for f, a in lines:
        if not any(_overtone(f, a, f0, a0, ratio) for f0, a0 in notes):
            notes.append((f, a))
    if not notes:
        return ()
    loudest = max(a for _, a in notes)
    return tuple(f for f, a in notes if a >= E.SOURCE_NOTE_COUNT * loudest)


# --- the measurements --------------------------------------------------------------------------


def overtone_ratio(lines: list[tuple[float, float]]) -> float | None:
    """The lowest overtone ratio, in steps of RATIO_STEP up to 1, at which no chord is spelled."""
    E = _service()
    for step in range(int(round((1.0 - E.SOURCE_OVERTONE_RATIO) / RATIO_STEP)) + 1):
        ratio = round(E.SOURCE_OVERTONE_RATIO + step * RATIO_STEP, 2)
        if not E.spells_chord(spelled(lines, ratio)):
            return ratio
    return None


def merged(lines: list[tuple[float, float]], cents: float) -> list[tuple[float, float]]:
    """`lines` with each line within `cents` of a stronger one merged into it (levels added)."""
    kept: list[list[float]] = []
    for f, a in sorted(lines, key=lambda line: -line[1]):
        near = [k for k in kept if abs(1200 * np.log2(f / k[0])) <= cents]
        if near:
            near[0][1] += a
        else:
            kept.append([f, a])
    return sorted((f, a) for f, a in kept)


def series_share(lines: list[tuple[float, float]]) -> float | None:
    """
    The largest share of the lines' level within the note tolerances of one stretched harmonic
    series, k f0 sqrt(1 + B k^2) for k up to SOURCE_NOTE_MAX_HARMONIC, f0 within OCTAVE_SPAN of
    a line and B in STIFFNESS.
    """
    if not lines:
        return None
    E = _service()
    hz = np.array([f for f, _ in lines])
    level = np.array([a for _, a in lines])
    k = np.arange(1, E.SOURCE_NOTE_MAX_HARMONIC + 1, dtype=float)
    octave = (k.astype(int) & (k.astype(int) - 1)) == 0
    stretch = k[None, :] * np.sqrt(1 + STIFFNESS[:, None] * k[None, :] ** 2)  # B x k
    best = 0.0
    for f1 in hz:
        f0 = f1 * (1 + np.linspace(-OCTAVE_SPAN, OCTAVE_SPAN, SPAN_STEPS))
        partials = f0[:, None, None] * stretch[None, :, :]  # f0 x B x k
        error = np.abs(hz[:, None, None, None] - partials[None]) / hz[:, None, None, None]
        nearest = np.argmin(error, axis=-1)  # line x f0 x B
        off = np.take_along_axis(error, nearest[..., None], axis=-1)[..., 0]
        tolerance = np.where(octave[nearest], E.SOURCE_OCTAVE_TOLERANCE, E.SOURCE_NOTE_TOLERANCE)
        on = off <= tolerance
        best = max(best, float(np.max(np.tensordot(level, on, axes=1)) / level.sum()))
    return best


def third_off_grid(notes: tuple[float, ...]) -> float | None:
    """
    For notes of two pitch classes: the least distance from 300 or 400 cents (folded into 0-600)
    of the intervals between them within SOURCE_THIRD_CENTS of one (the thirds and sixths
    spells_chord counts). None otherwise.
    """
    E = _service()
    classes: dict[int, list[float]] = {}
    for f in notes:
        classes.setdefault(int(round(69 + 12 * np.log2(f / 440.0))) % 12, []).append(f)
    if len(classes) != 2:
        return None
    first, second = classes.values()
    offs = []
    for a in first:
        for b in second:
            cents = E._cents(max(a, b), min(a, b)) % 1200
            cents = min(cents, 1200 - cents)
            off = min(abs(cents - 300), abs(cents - 400))
            if off <= E.SOURCE_THIRD_CENTS:
                offs.append(off)
    return float(min(offs)) if offs else None


def both_thirds(notes: tuple[float, ...]) -> float:
    """1.0 when a note has a minor and a major third (in any octave) over it, else 0.0."""
    E = _service()
    for i, low in enumerate(notes):
        intervals = [E._cents(high, low) % 1200 for high in notes[i + 1 :]]
        has = [
            any(abs(c - third) <= E.SOURCE_THIRD_CENTS for c in intervals) for third in (300, 400)
        ]
        if all(has):
            return 1.0
    return 0.0


def decay_spread(signals, notes: tuple[float, ...]) -> float | None:
    """
    The median over hits of the fastest note's decay over the slowest's (dB per second, the
    slowest at least DECAY_FLOOR), for the notes at DECAY_LEVEL or more of the loudest.
    """
    stft = signals.harmonic_stft
    magnitude = np.abs(stft)
    n_fft = 2 * (stft.shape[0] - 1)
    bins = [int(round(f * n_fft / signals.sr)) for f in notes]
    if len(bins) < 2:
        return None
    level = np.array([magnitude[max(0, b - 1) : b + 2].max(axis=0) for b in bins])
    energy = (magnitude**2).sum(axis=0)
    seconds = signals.hop / signals.sr
    spreads = []
    for _, loudest, end in D.hit_spans(energy, D.onsets(signals)):
        if end - loudest < DECAY_MIN_FRAMES:
            continue
        span = level[:, loudest:end]
        audible = span[:, 0] >= DECAY_LEVEL * span[:, 0].max()
        if audible.sum() < 2 or not np.all(span[audible] > 0):
            continue
        t = np.arange(span.shape[1]) * seconds
        rates = [-np.polyfit(t, 20 * np.log10(s), 1)[0] for s in span[audible]]
        spreads.append(max(rates) / max(min(rates), DECAY_FLOOR))
    return float(np.median(spreads)) if spreads else None


def measure(signals) -> dict:
    """
    drum_rules.checked(), the notes this script's line reader spells (None when the lines are
    not still) and the measurements (None when not still).
    """
    out = D.checked(signals)
    names = list(MEASURES)
    evidence = signals.source_evidence
    if not evidence.still:
        return {**out, "notes": None, **dict.fromkeys(names)}
    lines = note_lines(signals.harmonic_stft, signals.sr, signals.hop)
    notes = spelled(lines)
    return {
        **out,
        "notes": list(notes),
        "lines": [list(line) for line in lines],
        "a higher overtone ratio": overtone_ratio(lines),
        "one stretched harmonic series": series_share(lines),
        "one stretched series, close lines merged": series_share(merged(lines, CLOSE_CENTS)),
        "a third or sixth off the grid": third_off_grid(notes),
        "lines dying away after each hit": D.decaying_lines(signals),
        "both thirds over one note": both_thirds(notes),
        "notes decaying at different rates": decay_spread(signals, notes),
        "note pairs off the grid": source_rules.off_grid(list(notes)) if len(notes) > 1 else None,
        "the lowest note": float(notes[0]) if notes else None,
        "pitch classes": float(pitch_classes(notes)),
        "the two lowest notes' interval": lowest_interval(notes),
    }


def lowest_interval(notes: tuple[float, ...]) -> float | None:
    """The interval between the two lowest notes, in cents; None for fewer than two."""
    if len(notes) < 2:
        return None
    low, next_up = sorted(notes)[:2]
    return float(1200 * np.log2(next_up / low))


def analyse(item: tuple[str, str, int, str]) -> dict:
    """One served control or clip, made again and measured (in a worker)."""
    return measure(D.signals_of(item))


def signed(measured: dict) -> dict:
    """The measurements signed so that each rule withholds at or above its threshold."""
    return {
        name: {m: (None if got.get(m) is None else MEASURES[m] * got[m]) for m in MEASURES}
        for name, got in measured.items()
    }


def reproduce(rows: list[dict], measured: dict) -> int:
    """
    drum_rules.reproduce(), and the notes: where the recorded lines were still, the notes this
    script spells are the recorded ones (and none where they were not). Exits on the first row
    that differs.
    """
    checked = D.reproduce(rows, measured)
    for row in rows:
        recorded = (row["source"] or {}).get("notes")
        got = measured[row["name"]]["notes"]
        if (recorded is None) != (got is None) or (
            got is not None
            and (len(got) != len(recorded) or not np.allclose(got, recorded, rtol=1e-6))
        ):
            raise SystemExit(
                f"{row['name']}: the notes differ from the report; nothing is reported"
            )
    return checked


def still_rows(rows: list[dict], values: dict) -> list[dict]:
    """The rows whose recorded lines pass the single-source time test."""
    return [r for r in rows if r["source"] and source_rules.still(r["source"], values)]


def pitch_classes(notes) -> int:
    """How many pitch classes the notes spell (as spells_chord counts them)."""
    return len({int(round(69 + 12 * np.log2(f / 440.0))) % 12 for f in notes})


# Why a note other than the loudest is not folded into the loudest one (kept_because).
UNDER = "under the note"
BESIDE = "beside the note"
OFF = "a harmonic off its line"
LOUD = "a harmonic too loud to fold"
ABOVE = "above the harmonics"


def kept_because(lines: list[tuple[float, float]]) -> dict[float, str]:
    """
    Per note spelled from `lines` other than the loudest, why the overtone test does not fold
    it into the loudest note: it lies under it (UNDER) or under 1.5 times it (BESIDE); its
    nearest harmonic of the loudest note is further off than the note tolerance
    (SOURCE_OCTAVE_TOLERANCE at the powers of two, SOURCE_NOTE_TOLERANCE elsewhere: OFF), or
    within it but over SOURCE_OVERTONE_RATIO of the loudest note's level (LOUD); or it lies past
    SOURCE_NOTE_MAX_HARMONIC (ABOVE). A one-note bass's note is its loudest.
    """
    E = _service()
    level = dict(lines)
    notes = spelled(lines)
    if not notes:
        return {}
    top = max(notes, key=lambda f: level[f])
    out = {}
    for f in notes:
        if f == top:
            continue
        k = round(f / top)
        if f < top:
            out[f] = UNDER
        elif k < 2:
            out[f] = BESIDE
        elif k > E.SOURCE_NOTE_MAX_HARMONIC:
            out[f] = ABOVE
        else:
            tolerance = E.SOURCE_OCTAVE_TOLERANCE if k & (k - 1) == 0 else E.SOURCE_NOTE_TOLERANCE
            if abs(f - k * top) > tolerance * f:
                out[f] = OFF
            elif level[f] > E.SOURCE_OVERTONE_RATIO * level[top]:
                out[f] = LOUD
            else:  # folded by the test; not reached for a note it spells
                raise AssertionError(f"{f:.1f} Hz is an overtone of {top:.1f} Hz")
    return out


def bass_causes(lines: list[tuple[float, float]]) -> dict[str, tuple[int, bool]]:
    """
    {why: (notes kept for it, whether the other notes still spell a chord)} over kept_because():
    the causes without which a one-note bass's notes would spell no chord.
    """
    E = _service()
    why = kept_because(lines)
    notes = spelled(lines)
    out = {}
    for cause in sorted(set(why.values())):
        rest = tuple(f for f in notes if why.get(f) != cause)
        out[cause] = (sum(c == cause for c in why.values()), bool(E.spells_chord(rest)))
    return out


def causes(rows: list[dict], measured: dict) -> dict:
    """
    {(family, span): [(name, pitch classes, detail)]} for each served row of the four
    families: how many pitch classes its notes spell, and per note its level (over the
    strongest line) and, when a line under it reaches SOURCE_NOTE_LEVEL, the nearest harmonic
    of such a line, how far off it is (%) and the note's level over that line's.
    """
    E = _service()
    out: dict = {}
    for r in rows:
        if r["drum"] is None:
            continue
        got = measured[r["name"]]
        lines = [tuple(line) for line in got.get("lines") or []]
        level = dict(lines)
        detail = []
        for f in got["notes"] or []:
            near = [
                (abs(f - round(f / f0) * f0) / f, round(f / f0), level[f] / a0, f0)
                for f0, a0 in lines
                if f0 < f and a0 >= E.SOURCE_NOTE_LEVEL and round(f / f0) >= 2
            ]
            if near:
                off, k, ratio, f0 = min(near)
                detail.append(
                    f"{f:.1f} ({level[f]:.2f}; {k} x {f0:.1f} {100 * off:+.2f} %, {ratio:.2f})"
                )
            else:
                detail.append(f"{f:.1f} ({level[f]:.2f})")
        classes = pitch_classes(got["notes"] or [])
        if r["drum"][0] == "one-note-bass":
            detail.append(
                "kept: "
                + ", ".join(
                    f"{cause} {n} ({'a chord' if chord else 'no chord'} without)"
                    for cause, (n, chord) in bass_causes(lines).items()
                )
            )
        out.setdefault(r["drum"], []).append((r["name"], classes, detail))
    return out


# --- chords the controls leave out --------------------------------------------------------------

PROBE_SHAPES = ("tremolo", "pumped")


def probe_chords() -> dict[str, tuple]:
    """
    Chords the controls leave out (their triads' roots lie in C3-B4; none has a ninth or a second
    at the bottom), {name: (group, MIDI notes, timbre, shape, (tonic, mode))}, held for 30 s with
    tremolo or pumped at 128 BPM (signals._shaped; held without either, most do not hold still):

    - "triads C5-G#5": C, E and G# major and minor triads from C5 up, in the three chord timbres
      and the flute and electric-piano ones;
    - "ninths": an add9, a minor ninth and a major ninth chord (the ninth over the triad, with
      the seventh for the last two) on every root from C3, the root doubled an octave down, in
      an organ and a saw timbre;
    - "add2": a triad from C3 on every other root with the second added between the root and the
      third, in tune or 10 or 20 cents flat, in a pad timbre.
    """
    from evals_audio import controls as C

    sig = C.signals()
    names = sig.PITCH_NAMES
    out = {}
    for shape in PROBE_SHAPES:
        for root in (0, 4, 8):
            for mode in ("major", "minor"):
                for timbre in ("pad", "organ", "saw", "flute", "e-piano"):
                    notes = sig._triad(root, mode, 72)
                    out[f"{timbre} {names[root]}5 {mode}, {shape}"] = (
                        "triads C5-G#5",
                        notes,
                        timbre,
                        shape,
                        (names[root], mode),
                    )
        for root in range(12):
            for label, mode, extra in (
                ("add9", "major", (14,)),
                ("m9", "minor", (10, 14)),
                ("maj9", "major", (11, 14)),
            ):
                triad = sig._triad(root, mode)
                notes = [*triad, *(triad[0] + e for e in extra), triad[0] - 12]
                for timbre in ("organ", "saw"):
                    out[f"{timbre} {names[root]}{label}, {shape}"] = (
                        "ninths",
                        notes,
                        timbre,
                        shape,
                        (names[root], mode),
                    )
        for root in range(0, 12, 2):
            for mode in ("major", "minor"):
                for flat in (0, 10, 20):
                    triad = sig._triad(root, mode)
                    notes = [triad[0], triad[0] + 2 - flat / 100, *triad[1:]]
                    tag = f" {flat} c flat" if flat else ""
                    out[f"pad {names[root]} {mode} add2{tag}, {shape}"] = (
                        "add2",
                        notes,
                        "pad",
                        shape,
                        (names[root], mode),
                    )
    return out


def probe_audio(name: str) -> np.ndarray:
    """One of probe_chords() as samples at the controls' rate."""
    from evals_audio import controls as C

    sig = C.signals()
    _, notes, timbre, shape, _ = probe_chords()[name]

    def y_of(t):
        if timbre in sig._SOFT_TIMBRES:
            return sum(
                w * np.sin(2 * np.pi * sig.hz(m) * r * t)
                for m in notes
                for r, w in sig._SOFT_TIMBRES[timbre]
                if sig.hz(m) * r < 5000
            )
        return sig._chord_tone(notes, t, timbre)

    return np.asarray(sig._shaped(y_of, shape), dtype=np.float32)


def probe_analyse(name: str) -> dict:
    """One probe chord, written and decoded as a WAV control is, and measured (in a worker)."""
    import tempfile

    import soundfile as sf

    from evals_audio import controls as C
    from evals_audio import service

    with tempfile.TemporaryDirectory(prefix="still-chord-probe-") as tmp:
        path = f"{tmp}/probe.wav"
        sf.write(path, probe_audio(name), C.SR, format="WAV", subtype="FLOAT")
        return measure(service.decode_file(path))


def probe_rows(measured: dict) -> list[dict]:
    """The probe chords as rows: group and, per estimator, (served, right)."""
    chords = probe_chords()
    rows = []
    for name, got in measured.items():
        group, *_, truth = chords[name]
        keys = {}
        for est, key in got["keys"].items():
            served = got["withheld"] is None and key is not None
            keys[est] = (served, served and tuple(key[:2]) == truth)
        rows.append({"name": name, "group": group, "keys": keys})
    return rows


def probe_costs(entries: dict, rows: list[dict], measured: dict) -> dict:
    """
    {candidate: {rule ("free", "most"): {group: {estimator: (right keys taken, right keys)}}}}
    for each rule candidates() chose, over the probe chords.
    """
    values = signed(measured)
    out: dict = {}
    for name, entry in entries.items():
        rules = {}
        if "freeRule" in entry:
            rules["free"] = entry["freeRule"]
        if entry["most"] is not None:
            (m,) = CANDIDATES[name][1]
            rules["most"] = ("any", {m: entry["most"]})
        for kind, rule in rules.items():
            groups: dict = {}
            for r in rows:
                for est, (_, right) in r["keys"].items():
                    taken, total = groups.setdefault(r["group"], {}).get(est, (0, 0))
                    hit = right and D.withholds(values, r["name"], rule)
                    groups[r["group"]][est] = (taken + hit, total + right)
            out.setdefault(name, {})[kind] = groups
    return out


def probe_nearest(rows: list[dict], measured: dict) -> dict:
    """
    {measurement: (value, chord)}: the most family-like value among the probe chords that some
    estimator keys right (None when none reads one): how near a threshold they come.
    """
    values = signed(measured)
    right = [r["name"] for r in rows if any(ok for _, ok in r["keys"].values())]
    out = {}
    for m in MEASURES:
        read = [(values[n][m], n) for n in right if values[n][m] is not None]
        if read:
            top, name = max(read)
            out[m] = (MEASURES[m] * top, name)
    return out


def _fmt_threshold(measure: str, signed_value: float) -> str:
    side = "at or above" if MEASURES[measure] > 0 else "at or under"
    return f"{measure} {side} {MEASURES[measure] * signed_value:.4g}"


def _print_judged(entry: dict, prefix: str) -> None:
    print(f"    keys withheld: {D._fmt_drums(entry[prefix + 'Drums'])}")
    for half, costs in entry[prefix + "Costs"].items():
        print(f"    right keys taken, {half} (of keys withheld): {D._fmt_costs(costs)}")


def report(rows: list[dict], measured: dict) -> dict:
    """Print each candidate's thresholds and counts; returns candidates()."""
    values = signed(measured)
    half = D.halves(rows)
    for h in ("training", "held out"):
        part = [r for r in rows if half[r["name"]] == h]
        print(
            f"{h}: {sum(r['drum'] is not None for r in part)} keyed controls of the four families, "
            f"{sum(D._right(r) for r in part)} other rows with a right key "
            f"({sum(r['kind'] == 'clip' for r in part)} clips)"
        )
    entries = D.candidates(rows, values, CANDIDATES, FAMILIES)
    training = [r for r in rows if half[r["name"]] == "training" and D._right(r)]
    for name, entry in entries.items():
        print(f"\n{name} (aimed at {', '.join(CANDIDATES[name][2])}):")
        free = entry["free"]
        if free is None:
            print("  no threshold withholds a training key it is aimed at without a right one")
        else:
            print(
                "  no right key of the training half taken at "
                + " or ".join(_fmt_threshold(m, t) for m, (t, _) in free.items())
            )
            for m, (_, top) in free.items():
                shown = "none" if top == -np.inf else f"{MEASURES[m] * top:.4g}"
                which = [r["name"] for r in training if D._value(values, r["name"], m) == top]
                at = f", {', '.join(which)}" if top != -np.inf else ""
                print(f"    (the most family-like right key there, {m}: {shown}{at})")
            _print_judged(entry, "free")
        if entry["most"] is None:
            print("  no threshold withholds more than half of the training keys it is aimed at")
        else:
            (m,) = CANDIDATES[name][1]
            print(
                f"  more than half of the training keys aimed at: {_fmt_threshold(m, entry['most'])}"
            )
            _print_judged(entry, "most")
    return entries


def main() -> None:
    from evals_audio import datasets

    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("results", nargs="?", type=Path)
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument(
        "--data-dir",
        default=os.environ.get("LINER_NOTES_DATA", str(Path.home() / "liner-notes-data")),
    )
    args = p.parse_args()
    name, controls_run, key_run, calibration_run = D.newest(args.results)
    print(
        f"{name}: controls run on commit {controls_run['gitCommit']}, GiantSteps+ key and "
        f"calibration runs on commits {key_run['gitCommit']} and {calibration_run['gitCommit']}, "
        f"analyzer {controls_run['analyzerVersion']}"
    )
    rows = D.served_rows(controls_run, key_run, calibration_run, FAMILIES)
    spec = datasets.DATASETS[D.DATASET]
    home = Path(args.data_dir) / spec.mirdata_name
    try:
        refs = {datasets.public_id(spec, r.track_id): r for r in datasets.references(spec, home)}
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(
            f"GiantSteps+ index or annotations not readable under {home}: {error}"
        ) from None
    clips = [r for r in rows if r["kind"] == "clip"]
    missing = [r["name"] for r in clips if not (home / refs[r["name"]].audio_rel).is_file()]
    if missing:
        raise SystemExit(f"GiantSteps+ audio missing under {home}: {', '.join(missing)}")
    values = controls_run["rules"]["one_source"]
    still = still_rows(rows, values)
    print(
        f"{len(rows)} served controls and clips, {len(still)} of them still "
        f"({sum(r['kind'] == 'clip' for r in still)} clips); right keys among the clips: "
        f"{D._right_keys(rows)}"
    )
    seed = key_run["seeds"]["clips"]
    items = [(r["kind"], r["name"], seed, args.data_dir) for r in rows]
    D._cap_threads()
    with ProcessPoolExecutor(args.jobs, mp_context=get_context("spawn")) as pool:
        results = list(pool.map(analyse, items, chunksize=4))
    measured = dict(zip([r["name"] for r in rows], results, strict=True))
    print(f"reproduced: {reproduce(rows, measured)} served controls and clips")
    print(
        "\nwhat the still lines of the four families spell (pitch classes; per note: Hz, level;"
        " the nearest harmonic of a line at SOURCE_NOTE_LEVEL under it, % off, level over it):"
    )
    for (family, span), found in sorted(causes(rows, measured).items()):
        for row_name, classes, detail in found:
            print(f"  {family}, {span}, {row_name}: {classes}; {'; '.join(detail)}")
    print()
    entries = report(rows, measured)
    chords = list(probe_chords())
    with ProcessPoolExecutor(args.jobs, mp_context=get_context("spawn")) as pool:
        probed = dict(zip(chords, pool.map(probe_analyse, chords, chunksize=4), strict=True))
    found = probe_rows(probed)
    print(
        f"\n{len(found)} chords the controls leave out (probe_chords), right keys served: "
        + "; ".join(
            f"{group} "
            + ", ".join(
                f"{est} {sum(r['keys'][est][1] for r in found if r['group'] == group)}"
                for est in D.ESTIMATORS
            )
            + f" of {sum(r['group'] == group for r in found)}"
            for group in dict.fromkeys(r["group"] for r in found)
        )
    )
    for m, (value, chord) in probe_nearest(found, probed).items():
        print(f"  the most family-like right key among them, {m}: {value:.4g}, {chord}")
    for name, rules in probe_costs(entries, found, probed).items():
        for kind, groups in rules.items():
            print(
                f"  {name}, {kind}: right keys taken "
                + "; ".join(
                    f"{group} "
                    + ", ".join(f"{est} {taken}/{total}" for est, (taken, total) in by_est.items())
                    for group, by_est in groups.items()
                )
            )


if __name__ == "__main__":
    main()

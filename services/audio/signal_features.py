"""
Signal measurements of the v2 features that do not depend on the tempo or key estimator:
the gate, loudness, the energy contour, which tracked beats have sound under them, neutral
sections and key moments.

Every time is in seconds from the start of the decoded preview. The thresholds below were
picked on the generated fixtures in tests/ (WAV and MP3); each comment gives the values
measured on them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import librosa
import numpy as np
from scipy.signal import find_peaks

import estimators
from estimators import Signals

# --- gate --------------------------------------------------------------------------------

# Shorter input is not measured. The 1 s fixture holds two clicks of a 120 BPM track, which
# beat tracking reported as 117 BPM; four beats at 60 BPM take 4 s. Previews are 30 s.
MIN_DURATION_S = 4.0

# Silence: the loud end (95th percentile) of the frame RMS, after removing DC, below -60 dBFS.
# Measured (WAV/MP3): digital silence 0, a DC offset of 0.5 0 (MP3 1.4e-5), 16-bit dither
# 1.5e-5-1.8e-5, a sine peaking at -60 dBFS 7.1e-4-7.4e-4; the quietest fixtures that must not
# count as silence, the triad at 2% gain and white noise at RMS 0.006 (gated as noise),
# 6.2e-3-6.5e-3 (-44 dBFS); the click tracks 5.9e-2.
SILENCE_RMS = 1e-3

# Noise: neither rhythm nor sustained pitch. Rhythm is the onset periodicity (Signals.
# onset_periodicity, tolerant of human timing), pitch the share of energy in spectral lines
# (Tonality.tonal_ratio); both thresholds and the values behind them are in estimators.py.
# White, pink and brown noise score at most 0.13 and 0.000; a drum take with crashes and 25 ms
# jitter passes on rhythm (0.38), chords or a piano line under rain at 0 dB pass on pitch
# (0.67-0.73). (Spectral and chroma flatness, used before, called the latter noise: chroma
# flatness 0.92-0.98 under rain against 0.986 for brown noise.)
# A single harmonic series (a whine, mains hum) is not musical pitch: noise carrying one holds
# less than NOISE_MAX_ARTEFACT_RATIO of its energy in lines and is gated as noise. White noise
# with a 1 kHz whine 14/10/6 dB under it scores 0.08/0.18/0.36, pink noise with 50 Hz hum 6 dB
# under it 0.12. A tone or hum on its own (0.99-1.0) is not noise; it passes the gate and gets
# no key and no fingerprint. One voice that moves or has no stable notes (Voice.moving or
# Voice.without_notes: speech, an a cappella line) passes whatever its lines: its vibrato and
# intonation can leave none (the a cappella lines of tests/music.py with +-70 cents of vibrato
# score 0.00-0.01), or leave one series; speech pitched up 7 semitones spans under
# ONE_PITCH_SPAN_CENTS but has no notes.
# The pitch track is only computed when one of these noise rules would apply.
NOISE_MAX_PERIODICITY = estimators.MIN_TEMPO_PERIODICITY
NOISE_MAX_TONAL_RATIO = estimators.MIN_TONAL_RATIO
NOISE_MAX_ARTEFACT_RATIO = 0.9

# --- loudness and the energy contour -----------------------------------------------------

# Frame RMS over non-overlapping 2048-sample frames (92.9 ms at 22.05 kHz), after removing
# the mean (DC). One pass feeds loudness, the contour, the gate and the energy moments.
RMS_FRAME = 2048

# --- sections and key moments ------------------------------------------------------------

# Half width of the novelty kernel, in beats (or in fallback grid steps when there is no
# beat grid), and the fallback grid step.
NOVELTY_HALF_WIDTH = 4
FALLBACK_GRID_S = 0.5
# Novelty (within-block minus cross-block chroma similarity, 0..1) a change must reach: two
# chords sharing one note of three score about 0.6, repeated material about 0.
MIN_NOVELTY = 0.15
# Neutral sections are at least this long, and two sections are given the same label when
# their mean chroma vectors have a cosine similarity of at least SAME_SECTION_SIMILARITY.
MIN_SECTION_S = 4.0
SAME_SECTION_SIMILARITY = 0.9

MAX_KEY_MOMENTS = 16
# Key moments are first picked one per bin (the strongest), so they cover the whole window.
KEY_MOMENT_BINS = 6
# Two moments of the same type are at least MIN_MOMENT_SPACING_S apart. Moments of different
# types may coincide: a hit is an onset and an energy peak at once, then a drop.
MIN_MOMENT_SPACING_S = 0.5
# Energy peaks: a local maximum of the 1 s smoothed level standing 3 dB above its
# surroundings, at least 2 s from the next. Drops: the level falls by 6 dB or more within
# 0.5 s; 30 dB counts as the strongest drop. Silences: at least 0.5 s 40 dB below the
# loudest frame (or under SILENCE_RMS); 2 s counts as the longest.
PEAK_PROMINENCE_DB = 3.0
PEAK_DISTANCE_S = 2.0
DROP_MIN_DB = 6.0
DROP_FULL_DB = 30.0
DROP_SPAN_S = 0.5
SILENCE_BELOW_PEAK_DB = 40.0
SILENCE_MIN_S = 0.5
SILENCE_FULL_S = 2.0

# --- beats -------------------------------------------------------------------------------

# A tracked beat is reported only where there is sound to carry it: the RMS of the signal
# within BEAT_LEVEL_WINDOW_S of the beat (the window's own mean removed, so a DC offset counts
# as silence) must reach BEAT_BELOW_PEAK_DB under the loudest frame of the energy contour.
# Trackers keep counting through silence: Essentia put 23 of its 55 beats in the 10 s of
# digital silence before a 97 BPM band (tests/signals.py), and both trackers four beats in a
# 2.5 s gap inside one. Those beats are extrapolated, not measured; the tempo, its steadiness
# and the sections are still measured from the tracked beats, as before. Measured on the probes: the beats in digital
# silence read exactly 0 (WAV and MP3); the quietest other beat is 26 dB under the loudest
# frame (brown noise with a kick). On 30 s clips of 100 Ballroom and 100 GiantSteps Tempo
# tracks (a random window of each, and the first 30 s of the GiantSteps ones), the quietest
# beat on an onset (onset_beats) is 43 dB under; the 51 beats under 60 dB are Essentia's,
# in the silence that ends 32 Ballroom files and starts one (42 at exactly 0, the others
# under -70 dBFS), and none is on an onset. A floor of 40 dB would drop 2 beats on onsets; the
# count does not change with windows of 25 to 100 ms. Beats tracked through an audible intro
# without onsets (a pad) are kept: of the 208 beats off onsets at either end of those grids,
# 101 are within 20 dB of the loudest frame, in the music, so onsets alone cannot tell them
# from extrapolated ones.
BEAT_LEVEL_WINDOW_S = 0.05
BEAT_BELOW_PEAK_DB = 60.0


@dataclass(frozen=True)
class Gate:
    passed: bool
    reason: str | None  # "silence" | "noise" | "too_short"


@dataclass(frozen=True)
class Levels:
    """Frame RMS of the DC-free signal and what is derived from it."""

    frames: np.ndarray
    hop_seconds: float

    @property
    def mean(self) -> float:
        return float(np.mean(self.frames)) if self.frames.size else 0.0

    @property
    def loud(self) -> float:
        return float(np.percentile(self.frames, 95)) if self.frames.size else 0.0


def levels(signals: Signals) -> Levels:
    y = signals.y.astype(np.float64)
    y = y - np.mean(y) if y.size else y
    if y.size < RMS_FRAME:
        frames = np.array([np.sqrt(np.mean(y**2))]) if y.size else np.zeros(0)
    else:
        frames = librosa.feature.rms(
            y=y, frame_length=RMS_FRAME, hop_length=RMS_FRAME, center=False
        )[0]
    return Levels(frames=frames, hop_seconds=RMS_FRAME / signals.sr)


def check_gate(signals: Signals, loudness: Levels | None) -> Gate:
    """Too short, silent or noise-like input is not measured (in that order)."""
    if signals.duration < MIN_DURATION_S or loudness is None:
        return Gate(False, "too_short")
    if loudness.loud < SILENCE_RMS:
        return Gate(False, "silence")
    if signals.onset_periodicity < NOISE_MAX_PERIODICITY:
        tonal = signals.tonality
        no_pitch = tonal.tonal_ratio < NOISE_MAX_TONAL_RATIO
        one_artefact = tonal.series_f0 is not None and tonal.tonal_ratio < NOISE_MAX_ARTEFACT_RATIO
        voice = signals.voice
        if (no_pitch or one_artefact) and not (voice and (voice.moving or voice.without_notes)):
            return Gate(False, "noise")
    return Gate(True, None)


# --- beats -------------------------------------------------------------------------------


def beat_floor(loudness: Levels) -> float:
    """The RMS a beat needs within BEAT_LEVEL_WINDOW_S to be reported."""
    peak = float(np.max(loudness.frames)) if loudness.frames.size else 0.0
    return peak * 10 ** (-BEAT_BELOW_PEAK_DB / 20)


def beat_levels(signals: Signals, beats: np.ndarray) -> np.ndarray:
    """The RMS of the signal within BEAT_LEVEL_WINDOW_S of each beat, its own mean removed."""
    y = signals.y
    rms = []
    for t in np.asarray(beats, dtype=float):
        lo = max(0, round((t - BEAT_LEVEL_WINDOW_S) * signals.sr))
        part = y[lo : max(lo, round((t + BEAT_LEVEL_WINDOW_S) * signals.sr) + 1)]
        part = part.astype(np.float64)
        rms.append(float(np.sqrt(np.mean((part - part.mean()) ** 2))) if part.size else 0.0)
    return np.array(rms)


def audible_beats(signals: Signals, beats: np.ndarray, loudness: Levels) -> np.ndarray:
    """
    The beats with sound under them (BEAT_LEVEL_WINDOW_S), in their order: the beat grid the
    service reports. The tempo and the sections are measured from every tracked beat.
    """
    beats = np.asarray(beats, dtype=float)
    if beats.size == 0:
        return beats
    return beats[beat_levels(signals, beats) >= beat_floor(loudness)]


# --- sections ----------------------------------------------------------------------------


def _novelty(units: np.ndarray, half: int) -> np.ndarray:
    """Foote novelty of column vectors: within-block minus cross-block cosine similarity."""
    norms = np.linalg.norm(units, axis=0)
    x = units / np.where(norms > 0, norms, 1.0)
    sim = x.T @ x
    n = sim.shape[0]
    novelty = np.zeros(n)
    for i in range(half, n - half + 1):
        before = sim[i - half : i, i - half : i]
        after = sim[i : i + half, i : i + half]
        cross = sim[i - half : i, i : i + half]
        novelty[i] = 0.5 * (before.mean() + after.mean()) - cross.mean()
    return np.clip(novelty, 0.0, 1.0)


@dataclass(frozen=True)
class Harmony:
    """Novelty on beat-synchronous (or fixed-grid) chroma: change points and sections."""

    unit_starts: np.ndarray  # seconds
    novelty: np.ndarray
    segments: list[dict]
    method: str


def harmony(signals: Signals, beats: np.ndarray | None) -> Harmony:
    chroma = signals.chroma
    duration = signals.duration
    frames_per_s = signals.sr / signals.hop
    if beats is not None and len(beats) >= 2 * NOVELTY_HALF_WIDTH:
        boundaries = librosa.time_to_frames(beats, sr=signals.sr, hop_length=signals.hop)
        method = "novelty-on-beat-chroma"
    else:
        step = max(1, round(FALLBACK_GRID_S * frames_per_s))
        boundaries = np.arange(step, chroma.shape[1], step)
        method = "novelty-on-chroma-0.5s"
    boundaries = np.unique(boundaries[(boundaries > 0) & (boundaries < chroma.shape[1])])
    units = librosa.util.sync(chroma, boundaries, aggregate=np.median, pad=True)
    starts = np.concatenate([[0.0], boundaries / frames_per_s])[: units.shape[1]]
    novelty = (
        _novelty(units, NOVELTY_HALF_WIDTH)
        if units.shape[1] > 2 * NOVELTY_HALF_WIDTH
        else np.zeros(units.shape[1])
    )

    # Boundaries: the strongest novelty peaks, at least MIN_SECTION_S apart and from the ends.
    cuts: list[float] = []
    for i in np.argsort(novelty)[::-1]:
        if novelty[i] < MIN_NOVELTY:
            break
        t = float(starts[i])
        if t < MIN_SECTION_S or duration - t < MIN_SECTION_S:
            continue
        if all(abs(t - c) >= MIN_SECTION_S for c in cuts):
            cuts.append(t)
    edges = [0.0, *sorted(cuts), duration]

    segments: list[dict] = []
    labelled: list[tuple[str, np.ndarray]] = []
    for start, end in zip(edges[:-1], edges[1:], strict=True):
        lo = min(int(start * frames_per_s), chroma.shape[1] - 1)
        hi = max(lo + 1, int(end * frames_per_s))
        profile = chroma[:, lo:hi].mean(axis=1)
        norm = np.linalg.norm(profile)
        profile = profile / norm if norm > 0 else profile
        label = next(
            (name for name, ref in labelled if float(profile @ ref) >= SAME_SECTION_SIMILARITY),
            None,
        )
        if label is None:
            label = _section_label(len({name for name, _ in labelled}))
            labelled.append((label, profile))
        if segments and segments[-1]["label"] == label:
            segments[-1]["end"] = round(end, 3)
        else:
            segments.append({"label": label, "start": round(start, 3), "end": round(end, 3)})
    return Harmony(unit_starts=starts, novelty=novelty, segments=segments, method=method)


def _section_label(index: int) -> str:
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return letters[index] if index < len(letters) else f"S{index + 1}"


# --- key moments -------------------------------------------------------------------------


def _moving_average(x: np.ndarray, width: int) -> np.ndarray:
    """Centred moving average; the ends are padded with the edge values (not with zeros)."""
    if width <= 1 or x.size < width:
        return x
    padded = np.pad(x, (width // 2, width - 1 - width // 2), mode="edge")
    return np.convolve(padded, np.ones(width) / width, mode="valid")


def key_moments(signals: Signals, loudness: Levels, harmonic: Harmony | None) -> list[dict]:
    """
    Notable moments over the whole preview, each with an intensity taken from the signal:
    energy peaks (level relative to the loudest frame), energy drops (size of the fall),
    onsets (onset strength relative to the strongest), harmonic changes (chroma novelty) and
    silences (length).
    """
    duration = signals.duration
    candidates: list[dict] = []
    hop_s = loudness.hop_seconds
    rms = loudness.frames
    peak_rms = float(np.max(rms)) if rms.size else 0.0

    if rms.size >= 3 and peak_rms > 0:
        level_db = 20 * np.log10(np.maximum(rms, peak_rms * 1e-5) / peak_rms)
        smooth = _moving_average(level_db, max(1, round(1.0 / hop_s)))
        peaks, _ = find_peaks(
            smooth,
            prominence=PEAK_PROMINENCE_DB,
            distance=max(1, round(PEAK_DISTANCE_S / hop_s)),
        )
        # Each peak is placed on, and scored by, the loudest frame within half a second of it.
        reach = max(1, round(0.5 / hop_s))
        for i in peaks:
            lo = max(0, i - reach)
            j = lo + int(np.argmax(rms[lo : i + reach + 1]))
            candidates.append(
                _moment((j + 0.5) * hop_s, "energy_peak", rms[j] / peak_rms, "Energy peak")
            )

        span = max(1, round(DROP_SPAN_S / hop_s))
        if smooth.size > span:
            fall = smooth[span:] - smooth[:-span]
            drops, _ = find_peaks(-fall, height=DROP_MIN_DB, distance=span)
            for i in drops:
                candidates.append(
                    _moment(
                        (i + span + 0.5) * hop_s,
                        "energy_drop",
                        -fall[i] / DROP_FULL_DB,
                        f"Level drops by {-fall[i]:.0f} dB",
                    )
                )

        quiet = rms < max(SILENCE_RMS, peak_rms * 10 ** (-SILENCE_BELOW_PEAK_DB / 20))
        for start, end in _runs(quiet):
            length = (end - start) * hop_s
            if length >= SILENCE_MIN_S and start * hop_s > SILENCE_MIN_S:
                candidates.append(
                    _moment(start * hop_s, "silence", length / SILENCE_FULL_S, "Silence")
                )

    oenv = signals.onset_envelope
    if oenv.size and np.max(oenv) > 0:
        frames = librosa.onset.onset_detect(
            onset_envelope=oenv, sr=signals.sr, hop_length=signals.hop
        )
        strongest = float(np.max(oenv))
        times = librosa.frames_to_time(frames, sr=signals.sr, hop_length=signals.hop)
        for frame, t in zip(frames, times, strict=True):
            candidates.append(_moment(t, "onset", oenv[frame] / strongest, "Onset"))

    if harmonic is not None:
        for i in find_peaks(harmonic.novelty, height=MIN_NOVELTY)[0]:
            time, novelty = harmonic.unit_starts[i], harmonic.novelty[i]
            candidates.append(_moment(time, "harmonic_change", novelty, "Harmonic change"))

    return _select(candidates, duration)


def _moment(time: float, kind: str, intensity: float, description: str) -> dict:
    return {
        "time": float(time),
        "type": kind,
        "intensity": float(np.clip(intensity, 0.0, 1.0)),
        "description": description,
    }


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """(start, end) index pairs of the runs of True in `mask`."""
    padded = np.concatenate([[False], mask, [False]]).astype(int)
    changes = np.flatnonzero(np.diff(padded))
    return list(zip(changes[::2], changes[1::2], strict=True))


def _select(candidates: list[dict], duration: float) -> list[dict]:
    """
    Up to MAX_KEY_MOMENTS moments: the strongest of each of KEY_MOMENT_BINS equal parts of the
    window first, then the strongest remaining of each type in turn; two of the same type are
    never closer than MIN_MOMENT_SPACING_S.
    """
    valid = [c for c in candidates if 0.0 <= c["time"] <= duration]
    ranked = sorted(valid, key=lambda c: (-c["intensity"], c["time"]))
    chosen: list[dict] = []

    def take(moment: dict) -> None:
        if len(chosen) < MAX_KEY_MOMENTS and all(
            abs(moment["time"] - c["time"]) >= MIN_MOMENT_SPACING_S
            for c in chosen
            if c["type"] == moment["type"]
        ):
            chosen.append(moment)

    if duration > 0:
        width = duration / KEY_MOMENT_BINS
        for b in range(KEY_MOMENT_BINS):
            in_bin = [
                c
                for c in ranked
                if b * width <= c["time"] < (b + 1) * width
                or (b == KEY_MOMENT_BINS - 1 and c["time"] == duration)
            ]
            for moment in in_bin:
                before = len(chosen)
                take(moment)
                if len(chosen) > before:
                    break
    # Then by rounds, the strongest remaining moment of each type in turn, so that a strong
    # run of one type (onsets) does not crowd out the rest (a silence, a drop).
    remaining: dict[str, list[dict]] = {}
    for moment in ranked:
        if moment not in chosen:
            remaining.setdefault(moment["type"], []).append(moment)
    while len(chosen) < MAX_KEY_MOMENTS and any(remaining.values()):
        heads = [queue.pop(0) for queue in remaining.values() if queue]
        for moment in sorted(heads, key=lambda c: (-c["intensity"], c["time"])):
            take(moment)
    # Rounded down to the centisecond, so a moment never lies past the rounded duration.
    return [
        {**m, "time": math.floor(m["time"] * 100) / 100, "intensity": round(m["intensity"], 3)}
        for m in sorted(chosen, key=lambda m: m["time"])
    ]

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
# as silence) must be no more than BEAT_BELOW_PEAK_DB under the loudest frame of the energy
# contour, and at least BEAT_MIN_RMS. Trackers keep counting through silence: Essentia put
# 23 of its 55 beats in the 10 s of digital silence before a 97 BPM band (tests/signals.py),
# and both trackers four beats in a 2.5 s gap inside one. Those beats are extrapolated, not
# measured. The tempo is still fitted to the tracked beats on onsets, and the steadiness
# check and the sections still use every tracked beat, as before.
# Measured on the probes: the beats in digital silence read exactly 0 (WAV and MP3); the
# quietest other beat is 26 dB under the loudest frame (brown noise with a kick). On 30 s clips
# of 100 Ballroom and 100 GiantSteps Tempo tracks (a random window of each, and the first 30 s
# of the GiantSteps ones), the quietest beat on an onset (onset_beats) is 43 dB under the
# loudest frame and -54.8 dBFS, the quietest beat kept -64.8 dBFS; the 51 beats under 60 dB are
# Essentia's, in the silence that ends 32 Ballroom files and starts one (42 at exactly 0, the
# others at -72.5 dBFS and under), and none is on an onset. A floor of 40 dB would drop 2 beats
# on onsets; the count does not change with windows of 25 to 100 ms.
# The relative floor alone keeps beats over dither in a quiet clip: with its loudest frame at
# -45.5 dBFS, 60 dB under it is -105.5 dBFS, and Essentia's beats over a dithered intro (-98
# dBFS) were all reported. BEAT_MIN_RMS (-90.5 dBFS) is above 16-bit TPDF dither in the
# window (rounded to 16 bits at 22.05 kHz, 1.43e-5 to 1.62e-5; at 44.1 kHz, once resampled,
# 1.1e-5, and 8.9e-6 in float; shaped dither less; MP3 decodes it to 0 or 1.2e-6;
# SILENCE_RMS's note measured 1.5e-5 to 1.8e-5, 4.4 dB under it) and 25.7 dB under the
# quietest beat kept on the clips above, which it leaves unchanged. The tests pin it between
# the two: rounded dither must count as silence, a triad at 7e-5 on a quiet clip as sound.
# Known limits: beats tracked through an audible intro without onsets (a pad) are kept: of the
# 208 beats off onsets at either end of those grids, 101 are within 20 dB of the loudest frame,
# in the music, so onsets alone cannot tell them from extrapolated ones. Beats over a low noise
# floor (hum or hiss at -70 to -50 dBFS, vinyl crackle) are kept too: that is sound, and a level
# cannot tell it from a quiet passage.
BEAT_LEVEL_WINDOW_S = 0.05
BEAT_BELOW_PEAK_DB = 60.0
BEAT_MIN_RMS = 3e-5
# A tracker also keeps counting through an intro or an ending that has sound but no beat (a pad, a
# drone, hum or hiss): Essentia reported 15 beats under the pad before a 97 BPM band and 23 before a
# 132 BPM one (tests/signals.py), none on an onset. The measured grid starts where the band's onsets
# start: at the first two beats on onsets in a row (GRID_START_BEATS), or the first five beats that
# alternate on and off onsets, starting on one (GRID_START_ALTERNATE: a band whose beat sounds on
# every other tick). It ends at the last such beats, read backward. So one onset in an intro (a
# click, a breath) does not start the grid: with one 10 ms click under a pad tick, Essentia's beats
# under the pad before the 97 BPM band were reported again before 2.3.4 (15, 15 and 6 of 15 for a
# click under the 4th, 7th and 10th), and none are now. A pickup on the beat before the band does
# start it there, with that beat. With no such start anywhere (a band with onsets only on its
# downbeats, a one-drop), the grid runs from the first beat on an onset to the last, as before
# 2.3.4.
# The run of beats before the grid's start, or after its end, onsets included, is left out of the
# reported grid when it has at least EDGE_RUN_MIN_BEATS beats with sound under them (audible_beats;
# ticks over silence are left out anyway and do not count) and is off the grid's spacing or phase:
# - spacing: its spacing is more than EDGE_RUN_TOLERANCE off the grid next to it: the median
#   interval of the EDGE_RUN_GRID_BEATS beats on onsets nearest to it, inside the grid, against the
#   mean interval of the run and the beat it meets, over whole periods (a beat the tracker skipped
#   counts as two periods, a tick less than half a period after the last as one);
# - phase: the median distance of its beats from the grid counted on from that beat, every median
#   interval, is more than EDGE_RUN_PHASE_TOLERANCE of a period. The spacing alone spreads a phase p
#   over the run, about p / n off for n beats, so a long run on the spacing but out of phase used to
#   stay (at 45 % out, runs of 14 beats or more).
# Both are measured on every tick of the run. When the run has onsets, two parts of it are also
# judged on their own:
# - from its first onset to the grid: a band's sparse first bars (a downbeat hit, then the
#   groove). When this part has EDGE_RUN_MIN_BEATS audible beats and is on the grid's spacing and
#   phase, the run is not left out as a whole: judged with the ticks before them, the 8 beats of
#   two such bars after 10 ticks under a pad were left out with the ticks;
# - before its first onset, against the grid from that onset (as before 2.3.4): the ticks before
#   a sparse start, or after the last of a few kicks at the end, are left out on their own. Judged
#   with two kicks on the grid after the band, six ticks 10 % slow after them were reported.
# A run within the spacing tolerance drifts too: 3.5 % off, a six-beat run is a median 0.12 of a
# period off the grid and stays, a 15-beat run 0.28 and is left out. Onset support is relative to the clip's own beats (at least 0.1 of the 90th percentile
# of their onset strength), so with only a few beats on the band, under a tenth of the window, the
# beats under the pad count as on onsets and nothing is left out.
# Measured: the runs under the probes' pads are 13 to 23 beats long and 6.4 to 12.8 % off the grid
# (6.8 % at 97 BPM, 12.8 % at 132, 6.4 % at 85); under hum at -50 dBFS 9.7 %, under hiss at -60 dBFS
# 4.9 %. On the evals harness's 30 s clips of 100 Ballroom and 100 GiantSteps Tempo tracks (seed 1;
# 600 results), with Ballroom's beat annotations aligned to each clip's window (clips.clip_offset):
# - 2.3.3, with the grid starting at the first beat on an onset, left out 15 beats, all Essentia's:
#   a fade-in in GiantSteps 4565270 (7 beats, no beat annotations), a crescendo in Ballroom
#   Latin_Jam5-08 (3 beats 481 to 1584 ms before its first annotated beat, 1 within 64 ms of it) and
#   the end of Classics4-11 (2 within 47 to 65 ms of an annotated beat, 2 at 90 and 91 ms).
#   Essentia's beats within 70 ms of an annotated beat went from 3630 to 3627, those further from
#   947 to 942. (Counting ticks over silence toward EDGE_RUN_MIN_BEATS, as first written, also
#   removed the ends of three more Ballroom clips, 6 of their 14 beats within 37 to 65 ms of an
#   annotated beat.)
# - 2.3.4 leaves out 53 more, all Essentia's, in four intros with one to three isolated onsets:
#   Ballroom Media-103815 (9 beats, 618 to 4484 ms before the first annotated beat) and GiantSteps
#   3964688, 4265125 and 3873575 (31, 9 and 4 beats; no beat annotations; a median onset strength of
#   0.00 to 0.53 against 5.8 to 16.7 on the rest of the grid). The four runs are 4.5 to 19.5 % off
#   the grid's spacing. Within 70 ms of an annotated beat: still 3627; further: 933. The phase rule
#   changes none of the 600 results; it is what leaves out two of the hiss intros below. No result
#   lacks a start, and judging the parts of a run on their own changes none either. Starting
#   the grid only at two or three beats on onsets in a row, without the alternation, would also have
#   left out 4 and 9 Ballroom beats within 70 ms of an annotated beat (the first five beats of
#   Media-103815's band alternate on and off onsets).
# Runs of one to three audible beats are not judged: the drift of so few intervals is within the
# trackers' frame grid (23 ms for librosa, 12 ms for Essentia: two frames over three intervals at
# 140 BPM is up to 3.6 %), and on the real clips 31 such runs (45 beats, 21 of them a single beat,
# 23 at the start) are more than 4 % off, 25 of them within 20 dB of the loudest frame.
# Known limits:
# - A tracker that counts through a beatless intro at the band's own spacing and phase is not
#   caught. Essentia counts 15 beats at the band's spacing through 8 s of a rubato piano before a
#   120 BPM band (all reported, tests/test_v2.py), and in 27 hiss and hum intros (-70 to -40 dBFS)
#   before bands at 97, 120 and 132 BPM, 1 run of 19 beats (hiss at -70 dBFS before the 120 BPM
#   band, 0.2 % off) stays and is reported; 8 left out were only 5.0 to 5.9 % off.
# - Two onsets on adjacent ticks of an intro, or three on alternate ticks, start the grid there; one
#   onset on the tick just before the band (or just after it) joins the grid, as a pickup does. Two
#   onsets two ticks apart can too, through Essentia's own ticks: clicks under the 4th and 6th pad
#   beats of the 85 BPM probe brought back 14 of its 15 beats (none on the 97 and 132 BPM probes).
# - The phase rule leaves out a whole intro whose only onsets are sparse (kicks on downbeats) when
#   its tempo drifts from the band's: over 24 beats, all 23 to 24 at 2.5 to 3 % (spacing 2.5 to 3 %
#   off, phase 0.31 to 0.33 of a period), none at 1 or 2 % (0.13 and 0.24 to 0.25); the 14 beats of
#   a 110 BPM intro with downbeat kicks before a 120 BPM band. Those beats are missing, not
#   invented; none of the 600 real results changes with the phase rule.
EDGE_RUN_MIN_BEATS = 4
EDGE_RUN_TOLERANCE = 0.04
EDGE_RUN_GRID_BEATS = 8
GRID_START_BEATS = 2
GRID_START_ALTERNATE = (True, False, True, False, True)
EDGE_RUN_PHASE_TOLERANCE = 0.25


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
    return max(BEAT_MIN_RMS, peak * 10 ** (-BEAT_BELOW_PEAK_DB / 20))


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
    The beats with sound under them (BEAT_LEVEL_WINDOW_S, beat_floor), in their order: the
    beat grid the service reports. The tempo, the steadiness check and the sections are
    measured from the tracked beats, before this.
    """
    beats = np.asarray(beats, dtype=float)
    if beats.size == 0:
        return beats
    return beats[beat_levels(signals, beats) >= beat_floor(loudness)]


def _spacing_off(beats: np.ndarray, period: float) -> float:
    """How far the mean interval of `beats`, over whole periods, is from `period` (0..)."""
    intervals = np.diff(beats)
    whole = np.maximum(np.round(intervals / period), 1)
    return abs(float(intervals.sum() / (whole.sum() * period)) - 1)


def _phase_off(run: np.ndarray, anchor: float, period: float) -> float:
    """
    How far the beats of `run` are from the grid counted from `anchor` every `period`: the
    median distance of a beat to the nearest beat of that grid, in periods (0..0.5).
    """
    periods = np.abs(run - anchor) / period
    return float(np.median(np.abs(periods - np.round(periods))))


def _grid_starts(on: np.ndarray) -> np.ndarray:
    """
    Whether the measured grid can start at each beat, reading `on` (each beat on an onset or
    not) from it onward: the beat and the next are on onsets (GRID_START_BEATS), or the beat
    and the next four alternate on and off onsets (GRID_START_ALTERNATE).
    """
    starts = np.zeros(on.size, dtype=bool)
    for pattern in (np.ones(GRID_START_BEATS, dtype=bool), np.array(GRID_START_ALTERNATE)):
        if on.size >= pattern.size:
            windows = np.lib.stride_tricks.sliding_window_view(on, pattern.size)
            starts[: on.size - pattern.size + 1] |= (windows == pattern).all(axis=1)
    return starts


def _measured_span(on: np.ndarray) -> tuple[int, int] | None:
    """
    The first and last beat of the measured grid, by index (_grid_starts, read forward from
    the start and backward from the end), or None when no beat can start it.
    """
    starts = np.flatnonzero(_grid_starts(on))
    ends = np.flatnonzero(_grid_starts(on[::-1]))
    if starts.size == 0:
        return None
    return int(starts[0]), on.size - 1 - int(ends[0])


def _off_the_grid(
    beats: np.ndarray, audible: np.ndarray, run: slice, anchor: int, grid: np.ndarray
) -> bool | None:
    """
    Whether the run beats[run], which ends just before beats[anchor], is off the spacing or
    the phase of `grid` (EDGE_RUN_TOLERANCE, EDGE_RUN_PHASE_TOLERANCE); None when it has fewer
    than EDGE_RUN_MIN_BEATS beats with sound under them, and is not judged.
    """
    if np.count_nonzero(audible[run]) < EDGE_RUN_MIN_BEATS:
        return None
    period = float(np.median(np.diff(grid)))
    if not period > 0:
        return None
    return (
        _spacing_off(beats[run.start : anchor + 1], period) > EDGE_RUN_TOLERANCE
        or _phase_off(beats[run], beats[anchor], period) > EDGE_RUN_PHASE_TOLERANCE
    )


def _kept_before(
    beats: np.ndarray, on: np.ndarray, audible: np.ndarray, first: int, last: int
) -> np.ndarray:
    """
    Which beats stay at the start of the grid that runs from beats[first] to beats[last] (the
    measured span). The run before beats[first] is left out when it is off the grid
    (_off_the_grid, against the grid's first EDGE_RUN_GRID_BEATS beats on onsets), unless the
    part of it from its first onset on is long enough to judge and on the grid: a band's sparse
    first bars, which stay. The part before that first onset is also judged on its own,
    against the grid from that onset (as before 2.3.4), so the ticks before a sparse start do
    not stay with it.
    """
    keep = np.ones(beats.size, dtype=bool)
    onsets = np.flatnonzero(on[: last + 1])
    inside = onsets[onsets >= first]
    grid = beats[first : inside[:EDGE_RUN_GRID_BEATS][-1] + 1]
    onset = int(onsets[0])
    sparse = (
        _off_the_grid(beats, audible, slice(onset, first), first, grid) if onset < first else None
    )
    if sparse is not False and _off_the_grid(beats, audible, slice(0, first), first, grid):
        keep[:first] = False
    if onset < first:
        grid = beats[onset : onsets[:EDGE_RUN_GRID_BEATS][-1] + 1]
        if _off_the_grid(beats, audible, slice(0, onset), onset, grid):
            keep[:onset] = False
    return keep


def beats_on_the_grid(signals: Signals, beats: np.ndarray, loudness: Levels) -> np.ndarray:
    """
    The beats without a leading or trailing run that a tracker counted through a stretch
    without a beat, in their order. The measured grid starts where the band's onsets start
    and ends where they end (_measured_span), so one onset on a beat of an intro does not
    start it; every beat between stays. With no such start, it runs from the first beat on an
    onset to the last. The runs before and after it are judged by _kept_before (the end read
    backward, with time reversed).
    """
    beats = np.asarray(beats, dtype=float)
    on = np.isin(beats, estimators.onset_beats(beats, signals))
    onsets = np.flatnonzero(on)
    if onsets.size < 2:
        return beats
    span = _measured_span(on)
    first, last = span if span is not None else (int(onsets[0]), int(onsets[-1]))
    audible = beat_levels(signals, beats) >= beat_floor(loudness)
    n = beats.size
    keep = _kept_before(beats, on, audible, first, last)
    keep &= _kept_before(-beats[::-1], on[::-1], audible[::-1], n - 1 - last, n - 1 - first)[::-1]
    return beats[keep]


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

"""
Tempo and key estimators behind one interface, and the shared signal representations.

- ``EssentiaEstimator``: RhythmExtractor2013 (multifeature) on 44.1 kHz audio and KeyExtractor
  (bgate profile) on the harmonic part of the signal. The default when essentia is installed
  (the "models" extra).
- ``LibrosaEstimator``: librosa's tempo estimate (log-normal prior around 120 BPM, 40-208 BPM)
  and beat tracking on the onset envelope, and Krumhansl-Kessler profiles correlated with the
  constant-Q chromagram of the harmonic part.

``AUDIO_ESTIMATOR=essentia|librosa`` picks one; an unavailable choice falls back to librosa.

Both refine the tempo from the beat positions they track (``refine_bpm``), so the result is not
limited to the grid of the onset envelope (23.2 ms frames at 22.05 kHz with a 512-sample hop,
which turns 120 BPM into 117 and 140 into 144), and both withhold a tempo that the beat grid
does not keep (``steady_tempo``). A key is only estimated from tonal evidence they share
(``Tonality``, ``Signals.key_withheld``): one harmonic series (a tone, mains hum), one held
pitch or one voice without notes get no key, and neither does pitchless sound (drums, clicks,
noise): for librosa by the spectral-line rules, for Essentia over a beat by its key strength
(see ``EssentiaEstimator.key_lines_with_beat``).
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from functools import cached_property

import librosa
import numpy as np
import scipy.ndimage
import scipy.signal

logger = logging.getLogger("audio")

PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Pitch classes are always spelled with sharps; Essentia's KeyExtractor answers with flats.
FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}

# Rate and hop of the shared analysis signals (librosa's defaults).
SAMPLE_RATE = 22050
HOP_LENGTH = 512
# RhythmExtractor2013 assumes 44.1 kHz.
ESSENTIA_RATE = 44100

# Tempo range both estimators search, RhythmExtractor2013's defaults.
MIN_BPM = 40.0
MAX_BPM = 208.0

# RhythmExtractor2013 reports its confidence on 0..5.32 (Zapata et al., 2012); the documented
# bands are < 1 very low, 1-1.5 low, 1.5-3.5 good and > 3.5 excellent.
ESSENTIA_CONFIDENCE_SCALE = (0.0, 5.32)

# --- rhythm --------------------------------------------------------------------------------

# Onset periodicity (Signals.onset_periodicity) is how far the peak of librosa's tempogram
# (local autocorrelation of the onset envelope over 8.9 s windows, averaged over the window)
# stands above its median over the beat periods of 40-240 BPM. It is taken on the envelope as
# it is and on the envelope smoothed by a Gaussian of ONSET_SMOOTHING_FRAMES frames, whichever
# is higher, so that a human drummer's timing still counts as a beat. Measured on
# tests/signals.py and the fixtures, WAV and MP3 (as it is / smoothed):
#   white, pink and brown noise, 10 and 30 s, two seeds: at most 0.13 / 0.12;
#   drums with a crash per bar and 15/25 ms jitter 0.35/0.27 / 0.47/0.38, with 40 ms jitter
#   0.18 / 0.29; brown noise with a kick 6 dB under it 0.24-0.26 / 0.17-0.19; the band 0.78,
#   with 10 ms jitter 0.70; click tracks and drum loops 0.76-0.91;
#   a rubato piano line 0.11, a triad, tones, hum and the chord progressions 0.00.
# (A plain autocorrelation of the smoothed envelope let 10 s of brown noise reach 0.31 against
# 0.41 for the 25 ms drum take.)
ONSET_SMOOTHING_FRAMES = 1.0
# A tempo needs onsets that repeat (the noise gate in signal_features.py uses the same
# threshold). Without it Essentia reports 90 BPM for the chord progressions (one chord every
# 2 s, raw confidence 2.2-3.0), beat_track 30 BPM, and Essentia 93 BPM for a steady triad.
MIN_TEMPO_PERIODICITY = 0.2
# Below these confidences (0..1) a tempo is withheld as well.
# - Essentia: the bottom of the band its documentation calls "good" (1.5 of 5.32). Fixtures and
#   probes with a beat score 2.55-4.15 raw (0.48-0.78; the lowest is brown noise with a kick);
#   Essentia ignores the first 5 s when it scores, so a 6 s clip scores 0.
# - librosa: the autocorrelation of the smoothed onset envelope at the beat period. Fixtures and
#   probes with a beat score 0.33-0.95 (brown noise with a kick 0.33, the 25 ms drum take 0.37).
ESSENTIA_MIN_TEMPO_CONFIDENCE = 1.5 / 5.32
LIBROSA_MIN_TEMPO_CONFIDENCE = 0.3
# At least this many tracked beats (three intervals) for the tempo refinement; a reported tempo
# needs 2 * STEADY_TEMPO_PARTS (6) intervals, see steady_tempo.
MIN_BEATS = 4
# A beat counts for the refinement when the onset envelope near it reaches this share of the
# 90th percentile over the beats (onset_beats).
BEAT_MIN_ONSET = 0.1
# One tempo for the window only when it holds in each third of it: the median beat interval of
# each third of the beats, and librosa's tempo estimate on each third of the onset envelope (at
# the reported tempo, half or double it), are within STEADY_TEMPO_TOLERANCE of the reported
# tempo. Both checks are needed: Essentia's beats follow a tempo change, librosa's beat
# tracker keeps the period it was given. A band going from 90 to 130 BPM halfway fails both;
# 25 ms of jitter moves the beat medians by under 1%. The calibration in evals/audio kept the
# tolerance and both checks (see its section of the report): without the onset part, Essentia's
# extra tempos were right less often than those it reports.
STEADY_TEMPO_PARTS = 3
STEADY_TEMPO_TOLERANCE = 0.05
# The local estimates are read off whole onset frames, and jitter moves their peak: they may
# also be STEADY_LAG_FRAMES frames off (a drum take with 25 ms jitter at 100 BPM reads 107.7,
# 1.8 frames from the true period; the 90-to-130 change is 3.3 frames off at best).
STEADY_LAG_FRAMES = 2.0
# Beat drift (beat_drift): within each third that counts, the median beat interval over windows
# of STEADY_DRIFT_WINDOW_S (half a window apart, at least four beats each), as a tempo, and its
# largest relative distance from the reported tempo. The thirds' medians hide a tempo that
# swings around the reported one: a band swinging +-10 % around 100 BPM every 12 s passed the
# steadiness check at 107.7 BPM with both estimators. Set by the calibration in evals/audio (see
# its section of the report): librosa's beats drift 0.14 on that control, and 0.12 withheld no
# tempo of its calibration clips. For Essentia every tolerance that removed the swing's tempo
# also withheld a right Ballroom tempo, so it has none and still reports that swing's tempo.
STEADY_DRIFT_WINDOW_S = 6.0
LIBROSA_STEADY_DRIFT_TOLERANCE: float | None = 0.12
ESSENTIA_STEADY_DRIFT_TOLERANCE: float | None = None

# --- tonality and key ------------------------------------------------------------------------

# Spectral lines: bins of the long-term spectrum (Welch, 16384-sample segments, 1.35 Hz bins
# at 22.05 kHz) standing LINE_PROMINENCE_DB above the spectrum median-filtered over
# LINE_FLOOR_BINS bins (136 Hz). Sustained pitched sound puts its energy in lines; drums,
# clicks and noise do not.
LINE_BAND_HZ = (60.0, 5000.0)
# Harmonic series are looked for from 30 Hz, so that 50 and 60 Hz hum keep their fundamental.
SERIES_LOW_HZ = 30.0
LINE_PROMINENCE_DB = 12.0
LINE_FLOOR_BINS = 101
# A key needs at least MIN_TONAL_RATIO of the band's energy in lines. Measured: drum loops,
# noise bursts, metronomes, click tracks, a 2 Hz square wave, noise with a beat, drums with
# crashes 0.000-0.023; music 0.52-1.0 (the band with drums 0.52-0.62), chords or a piano line
# under pink noise at 0 dB 0.67-0.73, a chord pad under white noise at -10 dB 0.16, under pink
# noise at -10 dB 0.135. The share of energy in the harmonic part of a harmonic/percussive
# separation does not separate them: the square wave has 0.96 and brown noise with a kick
# 0.99, against 0.41 for the band.
MIN_TONAL_RATIO = 0.1
# The lines must spell at least KEY_MIN_PITCH_CLASSES pitch classes, together with the notes of
# a single voice (Voice.note_classes). A pitch class counts when its line amplitude (the square
# root of the power, so that a bass 6 dB louder than the chords does not hide them) reaches
# KEY_PITCH_CLASS_LEVEL of the strongest: a 440 Hz tone has 1, the A major triad 3, the chord
# progressions 5-7. Third-strongest pitch class: band mixes with a bass 6 dB over the chords
# 0.26-0.49, an A minor one-chord vamp under a bass 6 dB louder 0.18-0.25 (withheld). The
# overtones of one note also spell three or more classes at this weighting (a drone with
# mains-hum-like harmonics under drums 0.24 and above, a held brass note): without a beat the
# pitch track withholds those, and with a beat Signals.key_withheld does.
KEY_MIN_PITCH_CLASSES = 3
KEY_PITCH_CLASS_LEVEL = 0.28
# A single harmonic series (every line within SERIES_TOLERANCE of a multiple of the lowest
# line, for at least SERIES_SHARE of the line energy) is one sustained pitch, not a key: mains
# hum (50 Hz harmonics 1-6 or 1-10 spell G, B and D) or a lone tone. A tolerance of 0.5% (or two
# bins) keeps equal-tempered chords out: in the A major triad C# is 0.8% off 5 x 55 Hz, and its
# share is 0.27; the progressions 0.58, the band 0.17.
SERIES_TOLERANCE = 0.005
SERIES_SHARE = 0.9
# One voice (Voice): pYIN on the harmonic part (11.025 kHz, 40 Hz-4 kHz, a 46 ms YIN window so
# that it follows vibrato), refined by YIN, frames pinned at the edges of the range dropped. It
# is one voice when the tracker calls at least VOICE_MIN_VOICED of the window voiced, the
# harmonics 1-10 of its f0 explain the voiced frames' spectrum (median harmonicity: the share of
# the energy within VOICE_TOLERANCE x f0 of a harmonic, corrected for what a flat spectrum
# scores at that f0, at least VOICE_MIN_HARMONICITY), and its fundamental or octave is a real
# partial (VOICE_MIN_LOW_SHARE of the strongest harmonic; the virtual fundamental of a triad of
# pure tones has nothing there). The f0 is averaged over one vibrato cycle, then median-smoothed.
# Measured on tests/signals.py and tests/music.py (no beat):
# - smoothed 5th-95th percentile span: held notes with +-35 to +-120 cents of vibrato (G1 to E6,
#   sine, brass- and clarinet-like) 0-4 cents, a 0.5 Hz +-80 cent swing 152, bends of one to
#   three semitones 95-284; melodies 524-3392 (over a drone 132-159), speech 585-1058;
# - harmonicity: held notes 0.83-1.0, speech 0.99-1.0, melodies 0.98-1.0, band mixes without
#   drums 0.89-0.92, the A minor pad 0.87: no evidence of a single source by itself;
# - share of the held f0 (slope under VOICE_STABLE_SLOPE) within 25 cents of a semitone,
#   tuning-corrected: synthetic speech 0.55-0.68; the speech-dispatcher recording 0.49-0.73
#   (as is, pitched -7 to +7 semitones, played at 0.8-1.25 times the speed, under room noise);
#   melodies 0.81-1.0, band mixes 0.82-0.99 (with drums too). The threshold errs toward
#   withholding: a sung line with +-120 cents of vibrato (about 0.74), heavy scoops and
#   portamento or a vocal 30 cents out of tune per note (0.69-0.76) lose their key.
VOICE_MIN_VOICED = 0.3
VOICE_MIN_HARMONICITY = 0.5
VOICE_MIN_LOW_SHARE = 0.15
VOICE_MIN_ON_GRID = 0.77
VOICE_RATE = 11025
VOICE_RANGE_HZ = (40.0, 4000.0)
VOICE_FRAME = 1024  # YIN window of 512 samples (46 ms); lags up to 511 samples (21.6 Hz)
VOICE_HOP = 256  # 23 ms, the hop of the 22.05 kHz chromagram
VOICE_RESOLUTION = 0.25  # pYIN's pitch bins, in semitones (0.1 by default); YIN refines them
VOICE_SPECTRUM_FRAME = 2048  # harmonicity: 5.4 Hz bins resolve the harmonics of 40 Hz
VOICE_HARMONICS = 10
VOICE_TOLERANCE = 0.2  # of f0, around each harmonic
VOICE_VIBRATO_FRAMES = 8  # 0.19 s: one cycle of a 5.3 Hz vibrato, averaged out
VOICE_SMOOTHING_FRAMES = 15  # 0.35 s, a median (keeps note changes)
VOICE_STABLE_SLOPE = 100.0  # cents per second
VOICE_NOTE_SHARE = 0.05  # a note's pitch class counts with this share of the held frames
# Without a beat, one held pitch (a note with vibrato, a bend, a test tone) is no key. It needs
# (1) a smoothed span of at most ONE_PITCH_SPAN_CENTS; (2) at least ONE_PITCH_MIN_EXPLAINED of
# the line energy near the harmonics of the median f0, as far as the voice moves (Voice.
# tolerance): held notes, bends and tones 1.0, the C vamp with its bass on C2 0.943, the A
# minor pad (C is off the A1 series) 0.855; (3) a still chromagram: movement under
# STILL_MAX_MOVEMENT, either plain (Signals.chroma_movement) or relative to the voice
# (Voice.relative_movement, which a bend does not move). Held notes 0.004-0.022 plain and
# 0.008-0.029 relative, tones and hum 0.007-0.015, bends 0.024-0.049 relative; a melody over a
# D2 drone 6 dB louder 0.091 plain and 0.272 relative (without (3) it reads as one pitch: the
# tracker stays on the drone and the melody leaves weaker lines than the drone's harmonics),
# the C vamp 0.057 and 0.089. One harmonic series is only withheld without a beat when the
# chromagram is still, for the same reason.
ONE_PITCH_SPAN_CENTS = 350.0
ONE_PITCH_MIN_EXPLAINED = 0.98
STILL_MAX_MOVEMENT = 0.06
MOVEMENT_WINDOW_S = 0.5  # the chromagram is averaged over this before it is compared
# Below these strengths (0..1) the key is withheld. Set by the calibration in evals/audio (see
# its section of the report). Essentia scores atonal controls (random chromatic notes with and
# without drums, twelve-tone rows, a chromatic cluster) 0.21-0.69, so 0.7 removes their keys;
# no tonal control and no exact key of the annotated clips is lost. librosa's correlations
# overlap tonal music (the twelve-tone rows score 0.62-0.82, a Dm-C band mix under 0.5): the
# value chosen on the calibration clips, 0.45, withheld right keys more often than wrong ones
# on the evaluation clips, so it stays at 0.3 and librosa still keys atonal material.
ESSENTIA_MIN_KEY_STRENGTH = 0.7
LIBROSA_MIN_KEY_STRENGTH = 0.3

# The harmonic part is separated below this frequency (see Signals.harmonic).
HARMONIC_MAX_HZ = 5000.0

# Krumhansl-Kessler key profiles (major, minor), C first.
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

try:
    import essentia.standard as _es

    ESSENTIA_AVAILABLE = True
except ImportError:
    _es = None
    ESSENTIA_AVAILABLE = False


@dataclass(frozen=True)
class TempoEstimate:
    bpm: float
    confidence: float | None  # 0..1, None when the estimator gives none
    raw_confidence: tuple[float, tuple[float, float]] | None  # value and the estimator's scale
    beats: np.ndarray  # beat positions, seconds from the start
    method: str
    steady: bool  # the beat grid and the onsets keep this tempo over the whole window
    # The tracker follows tempo changes (its beats stay valid when the tempo is not steady).
    # librosa's beat tracker keeps one period, so its beats are dropped with an unsteady tempo.
    beats_follow_changes: bool = False
    # What the steadiness check measured (see Steadiness); `steady` is its verdict.
    steadiness: Steadiness | None = None


@dataclass(frozen=True)
class KeyEstimate:
    tonic: str
    mode: str  # "major" or "minor"
    strength: float | None  # 0..1
    profile: str
    method: str


@dataclass(frozen=True)
class Voice:
    """What a pitch track of the harmonic part says (see VOICE_MIN_HARMONICITY)."""

    voiced: float  # share of the frames the tracker calls voiced (off the range edges)
    harmonicity: float  # median baseline-corrected share on harmonics 1-10 of the f0
    span_cents: float  # 5th-95th percentile span of the smoothed f0
    on_grid: float  # share of the held f0 (VOICE_STABLE_SLOPE) within 25 cents of a semitone
    low_share: float  # median energy of harmonic 1 or 2 against the strongest harmonic
    f0_hz: float = 0.0  # median f0 of the voiced frames
    vibrato_cents: float = 0.0  # 90th percentile of the f0's distance from its smoothed track
    note_classes: frozenset[int] = frozenset()  # pitch classes (C = 0) of the smoothed f0
    # Chromagram movement with each voiced frame transposed to the voice's pitch: what moves
    # besides the voice (1.0 when unknown).
    relative_movement: float = 1.0

    @property
    def single(self) -> bool:
        return (
            self.voiced >= VOICE_MIN_VOICED
            and self.harmonicity >= VOICE_MIN_HARMONICITY
            and self.low_share >= VOICE_MIN_LOW_SHARE
        )

    @property
    def one_pitch(self) -> bool:
        return self.single and self.span_cents <= ONE_PITCH_SPAN_CENTS

    @property
    def without_notes(self) -> bool:
        return self.single and self.on_grid < VOICE_MIN_ON_GRID

    @property
    def moving(self) -> bool:
        """One voice whose pitch moves: speech, a melody, a sweep (not one held pitch)."""
        return self.single and not self.one_pitch

    @property
    def tolerance(self) -> tuple[float, float]:
        """
        How far (cents, Hz) its partials stray from the harmonics of the median f0: twice the
        measured vibrato (the 46 ms window reads 0.6-0.85 of a 5.5 Hz vibrato's extent), half
        the span, 20 cents, and 8 Hz for the FM sidebands, which reach about one vibrato rate
        beyond the extent.
        """
        return 2 * self.vibrato_cents + self.span_cents / 2 + 20.0, 8.0

    @property
    def held_tolerance(self) -> tuple[float, float]:
        """The tolerance without the span: how far one fixed pitch's partials stray."""
        return 2 * self.vibrato_cents + 20.0, 8.0


NO_VOICE = Voice(0.0, 0.0, 0.0, 0.0, 0.0)


@dataclass(frozen=True)
class Withheld:
    """
    Why no key is measured. `one_source` marks evidence of one pitched source (one harmonic
    series, one held pitch, one voice without notes): without a beat, such input is not music.
    """

    reason: str
    one_source: bool = False

    def __str__(self) -> str:
        return self.reason


SPEECH_LIKE = "one voice without stable notes (speech-like)"


@dataclass(frozen=True)
class Tonality:
    """What the long-term spectrum says about pitch, shared by the gate and both estimators."""

    tonal_ratio: float  # share of the 60 Hz-5 kHz energy in spectral lines
    pitch_classes: np.ndarray  # line amplitude per pitch class, C first
    series_f0: float | None  # lowest line when the lines form one harmonic series
    line_hz: np.ndarray = field(default_factory=lambda: np.zeros(0))  # line bins (Hz)
    line_power: np.ndarray = field(default_factory=lambda: np.zeros(0))  # their power

    def explained_by(self, f0: float, cents: float, hz: float = 0.0) -> float:
        """Share of the line energy within `cents` + `hz` of a harmonic of `f0`."""
        total = float(np.sum(self.line_power))
        if not total > 0 or not f0 > 0:
            return 0.0
        harmonic = np.maximum(1, np.round(self.line_hz / f0))
        tolerance = harmonic * f0 * (2 ** (cents / 1200) - 1) + hz
        near = np.abs(self.line_hz - harmonic * f0) <= tolerance
        return float(np.sum(self.line_power[near]) / total)

    @property
    def line_classes(self) -> frozenset[int]:
        """Pitch classes whose line amplitude reaches KEY_PITCH_CLASS_LEVEL of the strongest."""
        peak = float(np.max(self.pitch_classes)) if self.pitch_classes.size else 0.0
        if not peak > 0:
            return frozenset()
        return frozenset(
            np.flatnonzero(self.pitch_classes >= KEY_PITCH_CLASS_LEVEL * peak).tolist()
        )

    def key_withheld(self, voice: Voice = NO_VOICE, movement: float = 0.0) -> Withheld | None:
        """
        Why no key can be measured, or None when the evidence supports one. `voice` and
        `movement` (Signals.chroma_movement) are only given for input without a beat.
        """
        still = movement < STILL_MAX_MOVEMENT or (
            voice.single and voice.relative_movement < STILL_MAX_MOVEMENT
        )
        if self.tonal_ratio < MIN_TONAL_RATIO and not voice.moving:
            if voice.without_notes:  # speech pitched up leaves no lines and spans little
                return Withheld(SPEECH_LIKE, one_source=True)
            return Withheld("no sustained pitch")
        if self.series_f0 is not None and still:
            return Withheld(f"one harmonic series on {self.series_f0:.1f} Hz", one_source=True)
        if (
            voice.one_pitch
            and still
            and self.explained_by(voice.f0_hz, *voice.tolerance) >= ONE_PITCH_MIN_EXPLAINED
        ):
            return Withheld("one held pitch (vibrato or a bend)", one_source=True)
        if voice.without_notes:
            return Withheld(SPEECH_LIKE, one_source=True)
        if len(self.line_classes | voice.note_classes) < KEY_MIN_PITCH_CLASSES:
            return Withheld("fewer than three pitch classes")
        return None


class Signals:
    """
    One decoded preview and the representations every analysis step shares, computed once:
    the 22.05 kHz signal, its STFT, the onset envelope, the harmonic part (harmonic/percussive
    separation) and its chromagram (all with a 512-sample hop), the long-term spectrum, and
    resampled copies for the estimators that need them.
    """

    def __init__(self, native: np.ndarray, native_sr: int):
        self.native = np.asarray(native, dtype=np.float32)
        self.native_sr = int(native_sr)
        self.sr = SAMPLE_RATE
        self.hop = HOP_LENGTH
        self._resampled: dict[int, np.ndarray] = {}

    def at(self, sr: int) -> np.ndarray:
        """The signal at `sr`, resampled from the decoded rate (soxr_hq, as librosa.load)."""
        if sr == self.native_sr:
            return self.native
        if sr not in self._resampled:
            if self.native.size == 0:
                self._resampled[sr] = self.native
            else:
                y = librosa.resample(self.native, orig_sr=self.native_sr, target_sr=sr)
                self._resampled[sr] = np.ascontiguousarray(y, dtype=np.float32)
        return self._resampled[sr]

    @property
    def y(self) -> np.ndarray:
        return self.at(self.sr)

    @property
    def duration(self) -> float:
        return self.native.size / self.native_sr if self.native_sr else 0.0

    @cached_property
    def stft(self) -> np.ndarray:
        return librosa.stft(self.y, n_fft=2048, hop_length=self.hop)

    @cached_property
    def stft_magnitude(self) -> np.ndarray:
        return np.abs(self.stft)

    @cached_property
    def onset_envelope(self) -> np.ndarray:
        """librosa's beat-tracking onset envelope (median over mel bands), from the shared STFT."""
        mel = librosa.feature.melspectrogram(S=self.stft_magnitude**2, sr=self.sr)
        return librosa.onset.onset_strength(
            S=librosa.power_to_db(mel), sr=self.sr, hop_length=self.hop, aggregate=np.median
        )

    @cached_property
    def smoothed_onset_envelope(self) -> np.ndarray:
        """The onset envelope smoothed over ONSET_SMOOTHING_FRAMES, tolerant of human timing."""
        return scipy.ndimage.gaussian_filter1d(self.onset_envelope, ONSET_SMOOTHING_FRAMES)

    @cached_property
    def onset_periodicity(self) -> float:
        """How strongly the onsets repeat at some tempo, 0..1 (see ONSET_SMOOTHING_FRAMES)."""
        return max(
            tempogram_contrast(envelope, self.sr, self.hop)
            for envelope in (self.onset_envelope, self.smoothed_onset_envelope)
        )

    @cached_property
    def harmonic_stft(self) -> np.ndarray:
        top = int(np.searchsorted(librosa.fft_frequencies(sr=self.sr, n_fft=2048), HARMONIC_MAX_HZ))
        harmonic = np.zeros_like(self.stft)
        harmonic[:top], _ = librosa.decompose.hpss(self.stft[:top])
        return harmonic

    @cached_property
    def harmonic(self) -> np.ndarray:
        """
        The harmonic part of the signal below HARMONIC_MAX_HZ (librosa's median-filter
        separation), 22.05 kHz. Keys and chroma only use pitches up to C8 (4.2 kHz); leaving
        the rest out halves the cost of the separation.
        """
        y = librosa.istft(self.harmonic_stft, hop_length=self.hop, length=self.y.size)
        return np.ascontiguousarray(y, dtype=np.float32)

    @cached_property
    def chroma(self) -> np.ndarray:
        """Constant-Q chromagram of the harmonic part."""
        return librosa.feature.chroma_cqt(y=self.harmonic, sr=self.sr, hop_length=self.hop)

    @cached_property
    def chroma_mean(self) -> np.ndarray:
        return np.mean(self.chroma, axis=1) if self.chroma.size else np.zeros(12)

    @cached_property
    def tonality(self) -> Tonality:
        return tonality(self.y, self.sr)

    @cached_property
    def voice(self) -> Voice | None:
        """The pitch track's summary, or None when the tracker failed (logged)."""
        try:
            return voice(self)
        except Exception:
            logger.warning("The pitch track failed", exc_info=True)
            return None

    @cached_property
    def chroma_movement(self) -> float:
        """
        How much the pitch content changes, 0..1: the chromagram averaged over
        MOVEMENT_WINDOW_S and normalised per frame, its mean total-variation distance from the
        mean. Vibrato (4-8 Hz) averages out; a melody or chord changes it.
        """
        return chroma_movement(self.chroma, self.sr, self.hop)

    def not_music(self) -> str | None:
        """
        Why the service judges the input not to be music, or None: no beat (onset periodicity
        under MIN_TEMPO_PERIODICITY) and its pitch is one harmonic series (a tone, hum), one
        held pitch, or one voice without notes (speech). The fingerprint is not computed for
        it: the style and mood models answer for any input, and a test tone or speech gets
        danceability 0.996.
        """
        if self.has_beat:
            return None
        withheld = self.key_withheld()
        if withheld is None or not withheld.one_source:
            return None
        return f"{withheld}, and no beat"

    @property
    def has_beat(self) -> bool:
        return self.onset_periodicity >= MIN_TEMPO_PERIODICITY

    @cached_property
    def harmonic_tonality(self) -> Tonality:
        """The spectral lines of the harmonic part (drums left out)."""
        return tonality(self.harmonic, self.sr)

    def key_withheld(self, lines_with_beat: bool = True) -> Withheld | None:
        """
        Why no key can be measured. Without a beat, the pitch track and the chromagram's
        movement decide with the lines. With a beat, the lines decide first (unless
        `lines_with_beat` is False, see EssentiaEstimator); then a voice without stable notes
        (speech or rap over drums) or one held pitch whose harmonics explain the harmonic
        part's lines (a drone or one bass note under drums) still has no key. Over a beat the
        tolerance does not widen with the span: a band's bass line can look like one held
        pitch to the tracker, but its chords are off that pitch's harmonics.
        """
        if self.has_beat:
            withheld = self.tonality.key_withheld() if lines_with_beat else None
            voice = self.voice
            if withheld is not None or voice is None:
                return withheld
            if voice.without_notes:
                return Withheld(SPEECH_LIKE, one_source=True)
            explained = self.harmonic_tonality.explained_by(voice.f0_hz, *voice.held_tolerance)
            if voice.one_pitch and explained >= ONE_PITCH_MIN_EXPLAINED:
                return Withheld("one held pitch over the beat (a drone or one bass note)", True)
            return None
        if self.voice is None:
            # Without a pitch track, one held pitch cannot be told from music: no key.
            withheld = self.tonality.key_withheld(NO_VOICE, self.chroma_movement)
            return withheld or Withheld("no pitch track")
        return self.tonality.key_withheld(self.voice, self.chroma_movement)


def chroma_movement(chroma: np.ndarray, sr: int, hop: int) -> float:
    """Mean total-variation distance of the window-averaged, normalised chromagram from its mean."""
    if chroma.size == 0:
        return 0.0
    width = max(1, int(round(MOVEMENT_WINDOW_S * sr / hop)))
    chroma = scipy.ndimage.uniform_filter1d(chroma, width, axis=1, mode="nearest")
    chroma = chroma / np.maximum(chroma.sum(axis=0, keepdims=True), 1e-12)
    mean = chroma.mean(axis=1, keepdims=True)
    return float(np.mean(0.5 * np.abs(chroma - mean).sum(axis=0)))


def voice(signals: Signals) -> Voice:
    """The pitch track of the harmonic part, summarised (see VOICE_MIN_HARMONICITY)."""
    if signals.duration < 1.0:
        return NO_VOICE
    y = librosa.resample(signals.harmonic, orig_sr=signals.sr, target_sr=VOICE_RATE)
    track = dict(
        fmin=VOICE_RANGE_HZ[0],
        fmax=VOICE_RANGE_HZ[1],
        sr=VOICE_RATE,
        frame_length=VOICE_FRAME,
        hop_length=VOICE_HOP,
    )
    f0, voiced, _ = librosa.pyin(y, resolution=VOICE_RESOLUTION, **track)
    # pYIN's f0 sits on its pitch bins (25 cents apart); YIN's interpolated f0 refines it where
    # the two agree within half a bin's distance to the next semitone.
    with np.errstate(divide="ignore", invalid="ignore"):
        fine = librosa.yin(y, **track)[: f0.size]
        agree = np.abs(1200 * np.log2(fine / f0)) <= 50
    f0 = np.where(agree, fine, f0)
    # Frames pinned at the edges of the range are the tracker giving up (a bass under 40 Hz
    # reads 40 Hz), not a pitch.
    edge = 2 ** (50 / 1200)
    voiced &= np.isfinite(f0)
    voiced &= (f0 > VOICE_RANGE_HZ[0] * edge) & (f0 < VOICE_RANGE_HZ[1] / edge)
    if voiced.sum() < 2 * VOICE_SMOOTHING_FRAMES:
        return Voice(float(voiced.mean()) if voiced.size else 0.0, 0.0, 0.0, 0.0, 0.0)

    power = np.abs(librosa.stft(y, n_fft=VOICE_SPECTRUM_FRAME, hop_length=VOICE_HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=VOICE_RATE, n_fft=VOICE_SPECTRUM_FRAME)
    harmonicities, low_shares = [], []
    for frame in np.flatnonzero(voiced):
        if frame < power.shape[1]:
            measured = harmonicity(power[:, frame], freqs, f0[frame])
            if measured is not None:
                harmonicities.append(measured[0])
                low_shares.append(measured[1])

    raw = 1200 * np.log2(f0[voiced] / 440.0)
    cents = scipy.ndimage.median_filter(
        scipy.ndimage.uniform_filter1d(raw, VOICE_VIBRATO_FRAMES), size=VOICE_SMOOTHING_FRAMES
    )
    # Notes are where the smoothed f0 holds still (under VOICE_STABLE_SLOPE): scoops, glides and
    # portamento between notes are left out, and so is a glide that never settles.
    slope = np.abs(np.gradient(scipy.ndimage.uniform_filter1d(cents, 5))) * VOICE_RATE / VOICE_HOP
    held = cents[slope < VOICE_STABLE_SLOPE]
    if held.size >= 2 * VOICE_SMOOTHING_FRAMES:
        angle = 2 * np.pi * (held % 100) / 100
        tuning = np.angle(np.mean(np.exp(1j * angle))) * 100 / (2 * np.pi)
        on_grid = float(np.mean(np.abs((held - tuning + 50) % 100 - 50) <= 25))
        classes = (np.round((held - tuning) / 100).astype(int) + 9) % 12  # A4 = 0 cents -> 9
        counts = np.bincount(classes, minlength=12) / held.size
    else:
        on_grid, counts = 0.0, np.zeros(12)
    return Voice(
        voiced=float(voiced.mean()),
        harmonicity=float(np.median(harmonicities)) if harmonicities else 0.0,
        span_cents=float(np.percentile(cents, 95) - np.percentile(cents, 5)),
        on_grid=on_grid,
        low_share=float(np.median(low_shares)) if low_shares else 0.0,
        f0_hz=float(np.median(f0[voiced])),
        vibrato_cents=float(np.percentile(np.abs(raw - cents), 90)),
        note_classes=frozenset(np.flatnonzero(counts >= VOICE_NOTE_SHARE).tolist()),
        relative_movement=relative_movement(signals, np.flatnonzero(voiced), cents),
    )


def harmonicity(
    column: np.ndarray, freqs: np.ndarray, fundamental: float
) -> tuple[float, float] | None:
    """
    (harmonicity, low share) of one power spectrum for an f0: the share of the energy between
    0.5 and VOICE_HARMONICS + 0.5 times f0 lying within VOICE_TOLERANCE x f0 of a harmonic,
    rescaled so that a flat spectrum scores 0 and a pure harmonic one 1; and the energy of
    harmonic 1 or 2 against the strongest harmonic. None for a silent band.
    """
    band = (freqs >= 0.5 * fundamental) & (freqs <= (VOICE_HARMONICS + 0.5) * fundamental)
    column, f = column[band], freqs[band]
    total = float(column.sum())
    if not total > 0:
        return None
    harmonic = np.round(f / fundamental)
    tolerance = max(VOICE_TOLERANCE * fundamental, freqs[1] - freqs[0])
    near = (harmonic >= 1) & (np.abs(f - harmonic * fundamental) <= tolerance)
    share = float(column[near].sum()) / total
    flat = float(near.mean())  # what a flat spectrum scores at this f0
    corrected = (share - flat) / (1 - flat) if flat < 1 else 0.0
    per_harmonic = np.bincount(harmonic[near].astype(int), weights=column[near])
    strongest = float(per_harmonic.max()) if per_harmonic.size else 0.0
    low = float(per_harmonic[1:3].max()) if per_harmonic.size > 1 else 0.0
    return corrected, (low / strongest if strongest > 0 else 0.0)


def relative_movement(signals: Signals, frames: np.ndarray, cents: np.ndarray) -> float:
    """
    Chromagram movement (as Signals.chroma_movement) with each voiced frame transposed by the
    voice's smoothed pitch, on a 36-bin chromagram (a third of a semitone): a bend or a slow
    vibrato moves the plain chromagram, not this one; a melody over a drone moves both.
    """
    chroma = librosa.feature.chroma_cqt(
        y=signals.harmonic,
        sr=signals.sr,
        hop_length=signals.hop,
        tuning=0.0,  # the frames are transposed by the f0 in absolute cents
        n_chroma=36,
        bins_per_octave=36,
    )
    keep = frames < chroma.shape[1]  # the pitch track's hop is the chromagram's (23 ms)
    frames, cents = frames[keep], cents[keep]
    if frames.size == 0:
        return 1.0
    shift = 3 * cents / 100.0  # in bins
    source = (np.arange(36)[:, None] + shift[None, :]) % 36
    low = np.floor(source).astype(int)
    weight = source - low
    columns = chroma[:, frames]
    index = np.arange(frames.size)[None, :]
    moved = (1 - weight) * columns[low, index] + weight * columns[(low + 1) % 36, index]
    return chroma_movement(moved, signals.sr, signals.hop)


def tonality(y: np.ndarray, sr: int) -> Tonality:
    """Spectral lines of the long-term spectrum: their energy share, pitch classes and series."""
    if y.size < 4096:
        return Tonality(0.0, np.zeros(12), None)
    freqs, power = scipy.signal.welch(y.astype(np.float64), sr, nperseg=min(16384, y.size))
    db = 10 * np.log10(power + 1e-20)
    floor = scipy.ndimage.median_filter(db, size=LINE_FLOOR_BINS, mode="nearest")
    band = (freqs >= LINE_BAND_HZ[0]) & (freqs <= LINE_BAND_HZ[1])
    total = float(np.sum(power[band]))
    lines = band & (db > floor + LINE_PROMINENCE_DB)
    if not total > 0 or not lines.any():
        return Tonality(0.0, np.zeros(12), None)

    pitch_classes = np.zeros(12)
    midi = np.round(librosa.hz_to_midi(freqs[lines])).astype(int)
    np.add.at(pitch_classes, midi % 12, np.sqrt(power[lines]))

    # Peaks of the lines (one per partial) from SERIES_LOW_HZ, for the harmonic-series check.
    candidates = (
        (freqs >= SERIES_LOW_HZ) & (freqs <= LINE_BAND_HZ[1]) & (db > floor + LINE_PROMINENCE_DB)
    )
    peaks, _ = scipy.signal.find_peaks(np.where(candidates, db, -np.inf))
    return Tonality(
        float(np.sum(power[lines]) / total),
        pitch_classes,
        harmonic_series(freqs[peaks], power[peaks], freqs[1] - freqs[0]),
        freqs[lines],
        power[lines],
    )


def harmonic_series(peaks_hz: np.ndarray, peak_power: np.ndarray, bin_hz: float) -> float | None:
    """
    The fundamental when the spectral peaks are (nearly all) harmonics of the lowest one, else
    None. The fundamental is fitted to all the harmonics (least squares), so a bin-quantised
    lowest peak does not throw the upper harmonics out of tolerance.
    """
    if peaks_hz.size == 0:
        return None
    harmonic = np.maximum(1, np.round(peaks_hz / peaks_hz.min()))
    # Fit (weighted by power) on the lines within 2% of a multiple of the lowest one, then
    # check them all.
    near = np.abs(peaks_hz / harmonic - peaks_hz.min()) <= 0.02 * peaks_hz.min()
    w, h, f = peak_power[near], harmonic[near], peaks_hz[near]
    f0 = float(np.sum(w * h * f) / np.sum(w * h**2))
    tolerance = np.maximum(SERIES_TOLERANCE * peaks_hz, 2 * bin_hz)
    on_series = np.abs(peaks_hz - harmonic * f0) <= tolerance
    if np.sum(peak_power[on_series]) >= SERIES_SHARE * np.sum(peak_power):
        return f0
    return None


def tempogram_contrast(onset_envelope: np.ndarray, sr: int, hop: int) -> float:
    """Peak of the mean tempogram minus its median, over the lags of 40-240 BPM (0..1)."""
    if onset_envelope.size < 2 or not np.any(onset_envelope):
        return 0.0
    tempogram = librosa.feature.tempogram(onset_envelope=onset_envelope, sr=sr, hop_length=hop)
    mean = np.mean(tempogram, axis=1)
    lags = np.arange(mean.size) * hop / sr
    window = (lags >= 60.0 / 240) & (lags <= 60.0 / 40)
    contrast = float(np.max(mean[window]) - np.median(mean[window]))
    return float(np.clip(contrast, 0.0, 1.0)) if np.isfinite(contrast) else 0.0


def onset_beats(beats: np.ndarray, signals: Signals) -> np.ndarray:
    """
    The beats that fall on an onset: the onset envelope within 3 frames of the beat reaches
    BEAT_MIN_ONSET of the 90th percentile over all beats. Trackers keep counting through an
    intro without drums (Essentia's ticks drift from 82 to 97 BPM under a 10 s pad before a
    97 BPM band, at 0.00 of the reference); beats on the drums score 0.4-1.6.
    """
    beats = np.asarray(beats, dtype=float)
    envelope = signals.onset_envelope
    if beats.size == 0 or envelope.size == 0:
        return beats
    frames = np.clip(
        librosa.time_to_frames(beats, sr=signals.sr, hop_length=signals.hop), 0, envelope.size - 1
    )
    strength = np.array([envelope[max(0, f - 3) : f + 4].max() for f in frames])
    reference = float(np.percentile(strength, 90))
    return beats[strength >= BEAT_MIN_ONSET * reference] if reference > 0 else beats


def refine_bpm(beats: np.ndarray, bpm: float) -> float:
    """
    The tempo from a least-squares fit of beat time against beat number over the longest run
    of beats that follows `bpm` (intervals within a quarter period of whole periods, so skipped
    beats are numbered correctly), when that run has at least MIN_BEATS beats; otherwise
    `bpm`. The fit is only kept within 4% of `bpm`, so it sharpens the estimate (frame
    quantisation averages out over the beats) but never changes its octave. The estimators
    pass only the beats on onsets (onset_beats).
    """
    beats = np.asarray(beats, dtype=float)
    if len(beats) < MIN_BEATS or not bpm > 0:
        return bpm
    steps = np.diff(beats) / (60.0 / bpm)
    whole = np.round(steps)
    regular = (whole >= 1) & (np.abs(steps - whole) <= 0.25)
    best, start = (0, 0), None
    for i, ok in enumerate([*regular, False]):
        if ok and start is None:
            start = i
        elif not ok and start is not None:
            best = max(best, (i - start, start))
            start = None
    length, first = best
    if length + 1 < MIN_BEATS:
        return bpm
    run = beats[first : first + length + 1]
    numbers = np.concatenate([[0.0], np.cumsum(whole[first : first + length])])
    slope = np.polyfit(numbers, run, 1)[0]
    refined = 60.0 / slope if slope > 0 else bpm
    return refined if abs(refined - bpm) <= 0.04 * bpm else bpm


@dataclass(frozen=True)
class SteadyPart:
    """One part of the window (a third) as the steadiness check measures it."""

    rhythm: float  # onset periodicity of the part; it counts at MIN_TEMPO_PERIODICITY
    beat_bpm: float | None  # the median interval of its beats as a tempo (None under 3 beats)
    # librosa's tempo estimate on the part's onset envelope, as a period in onset frames (nan
    # when the part has no onsets at all)
    onset_period: float = float("nan")
    drift: float | None = None  # see STEADY_DRIFT_WINDOW_S (None: no window has four beats)


@dataclass(frozen=True)
class Steadiness:
    """
    What the steadiness check measures for one tempo (see steady_tempo); `holds` applies the
    tolerances, so the same measurements can be judged at other values (calibration).
    """

    bpm: float
    enough_beats: bool  # at least 2 * STEADY_TEMPO_PARTS beat intervals
    parts: tuple[SteadyPart, ...] = ()
    period: float = 0.0  # the tempo's period in onset frames (0 when split by beat count)
    by_count: bool = False  # no signals: the beat intervals split into thirds by count

    def holds(
        self,
        tolerance: float | None = None,
        lag_frames: float | None = None,
        min_rhythm: float | None = None,
        onset_check: bool = True,
        drift_tolerance: float | None = None,
    ) -> bool:
        tolerance = STEADY_TEMPO_TOLERANCE if tolerance is None else tolerance
        lag_frames = STEADY_LAG_FRAMES if lag_frames is None else lag_frames
        min_rhythm = MIN_TEMPO_PERIODICITY if min_rhythm is None else min_rhythm
        if not self.enough_beats or not self.bpm > 0:
            return False

        def matches(local: float | None) -> bool:
            return local is not None and abs(local - self.bpm) <= tolerance * self.bpm

        if self.by_count:
            return all(matches(part.beat_bpm) for part in self.parts)
        counted = 0
        for part in self.parts:
            if part.rhythm < min_rhythm:
                continue
            counted += 1
            if part.beat_bpm is not None and not matches(part.beat_bpm):
                return False
            if drift_tolerance is not None and (part.drift or 0.0) > drift_tolerance:
                return False
            if onset_check and not any(
                abs(part.onset_period - octave * self.period)
                <= max(tolerance * octave * self.period, lag_frames)
                for octave in (0.5, 1, 2)
            ):
                return False
        return counted > 0


def steadiness(beats: np.ndarray, bpm: float, signals: Signals | None = None) -> Steadiness:
    """The measurements behind steady_tempo, for each third of the window."""
    beats = np.asarray(beats, dtype=float)
    intervals = np.diff(beats)
    enough = intervals.size >= 2 * STEADY_TEMPO_PARTS and bpm > 0
    if not enough:
        return Steadiness(bpm=float(bpm), enough_beats=False)
    if signals is None:
        parts = tuple(
            SteadyPart(rhythm=1.0, beat_bpm=60.0 / float(np.median(part)))
            for part in np.array_split(intervals, STEADY_TEMPO_PARTS)
        )
        return Steadiness(bpm=float(bpm), enough_beats=True, parts=parts, by_count=True)
    frames_per_minute = 60.0 * signals.sr / signals.hop
    envelope, smoothed = signals.onset_envelope, signals.smoothed_onset_envelope
    edges = np.linspace(0, envelope.size, STEADY_TEMPO_PARTS + 1).astype(int)
    parts = []
    for lo, hi in zip(edges[:-1], edges[1:], strict=True):
        part = envelope[lo:hi]
        rhythm = max(
            tempogram_contrast(part, signals.sr, signals.hop),
            tempogram_contrast(smoothed[lo:hi], signals.sr, signals.hop),
        )
        start, end = lo * signals.hop / signals.sr, hi * signals.hop / signals.sr
        inside = beats[(beats >= start) & (beats < end)]
        beat_bpm = 60.0 / float(np.median(np.diff(inside))) if inside.size >= 3 else None
        onset_period = float("nan")
        if np.any(part):
            local = librosa.feature.tempo(
                onset_envelope=part, sr=signals.sr, hop_length=signals.hop, max_tempo=MAX_BPM
            )
            onset_period = frames_per_minute / float(np.atleast_1d(local)[0])
        drift = beat_drift(beats, bpm, start, end, STEADY_DRIFT_WINDOW_S)
        parts.append(SteadyPart(rhythm, beat_bpm, onset_period, drift))
    return Steadiness(
        bpm=float(bpm),
        enough_beats=True,
        parts=tuple(parts),
        period=frames_per_minute / bpm,
    )


def beat_drift(
    beats: np.ndarray, bpm: float, start: float, end: float, window: float
) -> float | None:
    """
    The largest relative distance from `bpm` of the median beat interval (as a tempo) in the
    windows of `window` seconds, half a window apart, between `start` and `end` (the last one
    shorter); windows with fewer than four beats are skipped. None when none has four.
    """
    worst = None
    t = start
    while True:
        stop = min(t + window, end)
        inside = beats[(beats >= t) & (beats < stop)]
        if inside.size >= 4:
            local = 60.0 / float(np.median(np.diff(inside)))
            distance = abs(local - bpm) / bpm
            worst = distance if worst is None else max(worst, distance)
        if stop >= end:
            return worst
        t += window / 2


def steady_tempo(beats: np.ndarray, bpm: float, signals: Signals | None = None) -> bool:
    """
    True when the tempo holds in each third of the window that has a beat. Given `signals`, a
    third counts when its own onsets repeat (onset periodicity at least MIN_TEMPO_PERIODICITY);
    a beatless intro is no evidence either way. In each counted third, the median interval of
    the beats in it and librosa's tempo estimate on its onset envelope (up to an octave) must
    match `bpm`. Without `signals`, the beats are split into thirds by count. Either way it
    takes at least 2 * STEADY_TEMPO_PARTS beat intervals.
    """
    return steadiness(beats, bpm, signals).holds()


def periodicity_at_lag(onset_envelope: np.ndarray, lag_frames: float) -> float:
    """Autocorrelation of the onset envelope (mean removed, 1 at lag 0) at a fractional lag."""
    x = onset_envelope - np.mean(onset_envelope)
    if x.size < 2 or not np.any(x):
        return 0.0
    ac = librosa.autocorrelate(x)
    ac = ac / ac[0]
    if not 0 <= lag_frames < ac.size - 1:
        return 0.0
    i = int(lag_frames)
    frac = lag_frames - i
    return float(np.clip((1 - frac) * ac[i] + frac * ac[i + 1], 0.0, 1.0))


def krumhansl_key(chroma_mean: np.ndarray) -> tuple[str, str, float] | None:
    """Best-correlating Krumhansl-Kessler key: (tonic, mode, correlation), or None if undefined."""
    total = float(np.sum(chroma_mean))
    if not total > 0 or not np.all(np.isfinite(chroma_mean)) or np.ptp(chroma_mean) < 1e-6:
        return None
    profile = chroma_mean / total
    best = None
    for shift in range(12):
        rotated = np.roll(profile, -shift)
        for mode, reference in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            corr = float(np.corrcoef(rotated, reference)[0, 1])
            if np.isfinite(corr) and (best is None or corr > best[2]):
                best = (PITCH_CLASSES[shift], mode, corr)
    return best


def _key_estimate(
    tonic: str, mode: str, strength: float, profile: str, method: str, minimum: float
):
    strength = float(np.clip(strength, 0.0, 1.0)) if np.isfinite(strength) else 0.0
    if tonic not in PITCH_CLASSES or mode not in ("major", "minor"):
        return None
    if strength < minimum:
        return None
    return KeyEstimate(tonic=tonic, mode=mode, strength=strength, profile=profile, method=method)


class LibrosaEstimator:
    name = "librosa"
    min_tempo_confidence = LIBROSA_MIN_TEMPO_CONFIDENCE
    min_key_strength = LIBROSA_MIN_KEY_STRENGTH
    key_lines_with_beat = True
    # Its beat tracker keeps one period, so only librosa's tempo on each third's onsets shows a
    # tempo change: the steadiness check needs that part.
    steady_onset_check = True
    steady_drift_tolerance: float | None = LIBROSA_STEADY_DRIFT_TOLERANCE

    def tempo(self, signals: Signals) -> TempoEstimate | None:
        oenv = signals.onset_envelope
        if not oenv.any() or signals.onset_periodicity < MIN_TEMPO_PERIODICITY:
            return None
        # librosa's default log-normal prior around 120 BPM, capped at MAX_BPM.
        start = librosa.feature.tempo(
            onset_envelope=oenv, sr=signals.sr, hop_length=signals.hop, max_tempo=MAX_BPM
        )
        start_bpm = float(np.atleast_1d(start)[0])
        if not MIN_BPM <= start_bpm <= MAX_BPM:
            return None
        _, frames = librosa.beat.beat_track(
            onset_envelope=oenv, sr=signals.sr, hop_length=signals.hop, bpm=start_bpm
        )
        beats = librosa.frames_to_time(frames, sr=signals.sr, hop_length=signals.hop)
        if len(beats) < MIN_BEATS:
            return None
        bpm = refine_bpm(onset_beats(beats, signals), start_bpm)
        lag = 60.0 / bpm * signals.sr / signals.hop
        confidence = periodicity_at_lag(signals.smoothed_onset_envelope, lag)
        if confidence < self.min_tempo_confidence:
            return None
        measured = steadiness(beats, bpm, signals)
        return TempoEstimate(
            bpm=bpm,
            confidence=confidence,
            raw_confidence=None,
            beats=beats,
            method="librosa.beat.beat_track+beat-regression",
            steady=measured.holds(
                onset_check=self.steady_onset_check, drift_tolerance=self.steady_drift_tolerance
            ),
            steadiness=measured,
        )

    def key(self, signals: Signals) -> KeyEstimate | None:
        if signals.key_withheld(self.key_lines_with_beat):
            return None
        found = krumhansl_key(signals.chroma_mean)
        if found is None:
            return None
        tonic, mode, corr = found
        return _key_estimate(
            tonic,
            mode,
            corr,
            "krumhansl",
            "librosa.feature.chroma_cqt+krumhansl-kessler",
            self.min_key_strength,
        )


_thread_state = threading.local()


def _essentia_algorithm(name: str, factory):
    """
    One instance per worker thread, reset before each use. Instances are kept rather than
    created per call: when the most recently created Essentia network is deleted, every later
    TensorFlow predictor call logs "No network created" thousands of times. They are not shared
    between threads: an algorithm instance is not safe to call from two threads at once.
    """
    algorithms = _thread_state.__dict__.setdefault("algorithms", {})
    if name in algorithms:
        algorithms[name].reset()
    else:
        algorithms[name] = factory()
    return algorithms[name]


class EssentiaEstimator:
    name = "essentia"
    min_tempo_confidence = ESSENTIA_MIN_TEMPO_CONFIDENCE
    min_key_strength = ESSENTIA_MIN_KEY_STRENGTH
    # With a beat, the spectral-line rules (no sustained pitch, one harmonic series, fewer than
    # three pitch classes) are not applied to Essentia. On electronic dance music they withheld
    # most keys, which Essentia mostly got right, while its key strength separates pitchless
    # rhythm from tonal music there (the pitchless controls with a beat score at most 0.64,
    # under ESSENTIA_MIN_KEY_STRENGTH). The one-source rules (speech or rap over drums, a drone
    # or one bass note under drums) still apply. librosa's strength does not separate them, so
    # it keeps the line rules. Measured by the calibration in evals/audio (see the report).
    key_lines_with_beat = False
    steady_onset_check = True
    steady_drift_tolerance: float | None = ESSENTIA_STEADY_DRIFT_TOLERANCE
    key_profile = "bgate"

    def tempo(self, signals: Signals) -> TempoEstimate | None:
        if signals.onset_periodicity < MIN_TEMPO_PERIODICITY:
            return None
        rhythm = _essentia_algorithm(
            "rhythm",
            lambda: _es.RhythmExtractor2013(
                method="multifeature", minTempo=int(MIN_BPM), maxTempo=int(MAX_BPM)
            ),
        )
        bpm, ticks, raw, _, _ = rhythm(signals.at(ESSENTIA_RATE))
        ticks = np.asarray(ticks, dtype=float)
        if not MIN_BPM <= bpm <= MAX_BPM or len(ticks) < MIN_BEATS:
            return None
        low, high = ESSENTIA_CONFIDENCE_SCALE
        confidence = float(np.clip((raw - low) / (high - low), 0.0, 1.0))
        if confidence < self.min_tempo_confidence:
            return None
        bpm = refine_bpm(onset_beats(ticks, signals), float(bpm))
        measured = steadiness(ticks, bpm, signals)
        return TempoEstimate(
            bpm=bpm,
            confidence=confidence,
            raw_confidence=(float(raw), ESSENTIA_CONFIDENCE_SCALE),
            beats=ticks,
            method="essentia.RhythmExtractor2013+beat-regression",
            steady=measured.holds(
                onset_check=self.steady_onset_check, drift_tolerance=self.steady_drift_tolerance
            ),
            beats_follow_changes=True,
            steadiness=measured,
        )

    def key(self, signals: Signals) -> KeyEstimate | None:
        if signals.key_withheld(self.key_lines_with_beat):
            return None
        extractor = _essentia_algorithm(
            f"key-{self.key_profile}",
            lambda: _es.KeyExtractor(sampleRate=signals.sr, profileType=self.key_profile),
        )
        name, scale, strength = extractor(signals.harmonic)
        return _key_estimate(
            FLAT_TO_SHARP.get(name, name),
            scale,
            strength,
            self.key_profile,
            "essentia.KeyExtractor",
            self.min_key_strength,
        )


ESTIMATORS = {"essentia": EssentiaEstimator, "librosa": LibrosaEstimator}


def select_estimator(name: str | None = None) -> LibrosaEstimator | EssentiaEstimator:
    """The estimator named by `name` or AUDIO_ESTIMATOR; Essentia by default when installed."""
    choice = (name or os.environ.get("AUDIO_ESTIMATOR") or "").strip().lower()
    if not choice:
        choice = "essentia" if ESSENTIA_AVAILABLE else "librosa"
    if choice not in ESTIMATORS:
        logger.warning("Unknown AUDIO_ESTIMATOR %r; using librosa", choice)
        choice = "librosa"
    if choice == "essentia" and not ESSENTIA_AVAILABLE:
        logger.warning("AUDIO_ESTIMATOR=essentia but essentia is not installed; using librosa")
        choice = "librosa"
    return ESTIMATORS[choice]()

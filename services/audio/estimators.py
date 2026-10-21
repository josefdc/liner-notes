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
does not keep (``steady_tempo``). A key is only estimated from tonal evidence that both share
(``Tonality``): pitchless sound (drums, clicks, noise) and a single harmonic series (a tone,
mains hum) get no key, whatever an estimator would answer.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
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
# At least this many tracked beats (three intervals) before a tempo is reported.
MIN_BEATS = 4
# One tempo for the window only when it holds in each third of it: the median beat interval of
# each third of the beats, and librosa's tempo estimate on each third of the onset envelope (at
# the reported tempo, half or double it), are within STEADY_TEMPO_TOLERANCE of the reported
# tempo. Both checks are needed: Essentia's beats follow a tempo change, librosa's beat
# tracker keeps the period it was given. A band going from 90 to 130 BPM halfway fails both;
# 25 ms of jitter moves the beat medians by under 1%.
STEADY_TEMPO_PARTS = 3
STEADY_TEMPO_TOLERANCE = 0.05
# The local estimates are read off whole onset frames, and jitter moves their peak: they may
# also be STEADY_LAG_FRAMES frames off (a drum take with 25 ms jitter at 100 BPM reads 107.7,
# 1.8 frames from the true period; the 90-to-130 change is 3.3 frames off at best).
STEADY_LAG_FRAMES = 2.0

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
# The lines must spell at least KEY_MIN_PITCH_CLASSES pitch classes (a pitch class counts when
# its line energy reaches KEY_PITCH_CLASS_LEVEL of the strongest one): a 440 Hz tone has 1, the
# A major triad 3, the chord progressions 5-7.
KEY_MIN_PITCH_CLASSES = 3
KEY_PITCH_CLASS_LEVEL = 0.25
# A single harmonic series (every line within SERIES_TOLERANCE of a multiple of the lowest
# line, for at least SERIES_SHARE of the line energy) is one sustained pitch, not a key: mains
# hum (50 Hz harmonics 1-6 or 1-10 spell G, B and D) or a lone tone. A tolerance of 0.5% (or two
# bins) keeps equal-tempered chords out: in the A major triad C# is 0.8% off 5 x 55 Hz, and its
# share is 0.27; the progressions 0.58, the band 0.17.
SERIES_TOLERANCE = 0.005
SERIES_SHARE = 0.9
# Below this strength (0..1) the key is withheld. Tonal fixtures and probes score 0.80-0.97 with
# Essentia (bgate profile, on the harmonic part) and 0.73-0.97 with librosa (Krumhansl-Kessler
# correlation); digital silence and dither score 0 with Essentia.
KEY_MIN_STRENGTH = 0.3

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


@dataclass(frozen=True)
class KeyEstimate:
    tonic: str
    mode: str  # "major" or "minor"
    strength: float | None  # 0..1
    profile: str
    method: str


@dataclass(frozen=True)
class Tonality:
    """What the long-term spectrum says about pitch, shared by the gate and both estimators."""

    tonal_ratio: float  # share of the 60 Hz-5 kHz energy in spectral lines
    pitch_classes: np.ndarray  # line energy per pitch class, C first
    series_f0: float | None  # lowest line when the lines form one harmonic series

    @property
    def pitch_class_count(self) -> int:
        peak = float(np.max(self.pitch_classes)) if self.pitch_classes.size else 0.0
        if not peak > 0:
            return 0
        return int(np.sum(self.pitch_classes >= KEY_PITCH_CLASS_LEVEL * peak))

    def key_withheld(self) -> str | None:
        """Why no key can be measured, or None when the evidence supports one."""
        if self.tonal_ratio < MIN_TONAL_RATIO:
            return "no sustained pitch"
        if self.series_f0 is not None:
            return f"one harmonic series on {self.series_f0:.1f} Hz"
        if self.pitch_class_count < KEY_MIN_PITCH_CLASSES:
            return "fewer than three pitch classes"
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
    def harmonic(self) -> np.ndarray:
        """
        The harmonic part of the signal below HARMONIC_MAX_HZ (librosa's median-filter
        separation), 22.05 kHz. Keys and chroma only use pitches up to C8 (4.2 kHz); leaving
        the rest out halves the cost of the separation.
        """
        top = int(np.searchsorted(librosa.fft_frequencies(sr=self.sr, n_fft=2048), HARMONIC_MAX_HZ))
        harmonic = np.zeros_like(self.stft)
        harmonic[:top], _ = librosa.decompose.hpss(self.stft[:top])
        y = librosa.istft(harmonic, hop_length=self.hop, length=self.y.size)
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
    np.add.at(pitch_classes, midi % 12, power[lines])

    # Peaks of the lines (one per partial) from SERIES_LOW_HZ, for the harmonic-series check.
    candidates = (
        (freqs >= SERIES_LOW_HZ) & (freqs <= LINE_BAND_HZ[1]) & (db > floor + LINE_PROMINENCE_DB)
    )
    peaks, _ = scipy.signal.find_peaks(np.where(candidates, db, -np.inf))
    return Tonality(
        float(np.sum(power[lines]) / total),
        pitch_classes,
        harmonic_series(freqs[peaks], power[peaks], freqs[1] - freqs[0]),
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


def refine_bpm(beats: np.ndarray, bpm: float) -> float:
    """
    The tempo from a least-squares fit of beat time against beat number, when the tracked beats
    follow `bpm`; otherwise `bpm`. Skipped beats are numbered by rounding each interval to whole
    periods, and the fit is only kept within 4% of `bpm`, so it sharpens the estimate (frame
    quantisation averages out over the beats) but never changes its octave.
    """
    if len(beats) < MIN_BEATS or not bpm > 0:
        return bpm
    period = 60.0 / bpm
    steps = np.diff(beats) / period
    whole = np.round(steps)
    if np.any(whole < 1) or np.max(np.abs(steps - whole)) > 0.25:
        return bpm
    numbers = np.concatenate([[0.0], np.cumsum(whole)])
    slope = np.polyfit(numbers, beats, 1)[0]
    refined = 60.0 / slope if slope > 0 else bpm
    return refined if abs(refined - bpm) <= 0.04 * bpm else bpm


def steady_tempo(beats: np.ndarray, bpm: float, signals: Signals | None = None) -> bool:
    """
    True when every third of the beat grid runs at `bpm`, and (given `signals`) librosa's tempo
    estimate on every third of the onset envelope agrees, up to an octave.
    """
    intervals = np.diff(np.asarray(beats, dtype=float))
    if intervals.size < 2 * STEADY_TEMPO_PARTS or not bpm > 0:
        return False
    for part in np.array_split(intervals, STEADY_TEMPO_PARTS):
        local = 60.0 / float(np.median(part))
        if abs(local - bpm) > STEADY_TEMPO_TOLERANCE * bpm:
            return False
    if signals is None:
        return True
    frames_per_minute = 60.0 * signals.sr / signals.hop
    period = frames_per_minute / bpm  # in onset frames
    for part in np.array_split(signals.onset_envelope, STEADY_TEMPO_PARTS):
        local = librosa.feature.tempo(
            onset_envelope=part, sr=signals.sr, hop_length=signals.hop, max_tempo=MAX_BPM
        )
        local_period = frames_per_minute / float(np.atleast_1d(local)[0])
        if not any(
            abs(local_period - octave * period)
            <= max(STEADY_TEMPO_TOLERANCE * octave * period, STEADY_LAG_FRAMES)
            for octave in (0.5, 1, 2)
        ):
            return False
    return True


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


def _key_estimate(tonic: str, mode: str, strength: float, profile: str, method: str):
    strength = float(np.clip(strength, 0.0, 1.0)) if np.isfinite(strength) else 0.0
    if tonic not in PITCH_CLASSES or mode not in ("major", "minor"):
        return None
    if strength < KEY_MIN_STRENGTH:
        return None
    return KeyEstimate(tonic=tonic, mode=mode, strength=strength, profile=profile, method=method)


class LibrosaEstimator:
    name = "librosa"
    min_tempo_confidence = LIBROSA_MIN_TEMPO_CONFIDENCE

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
        bpm = refine_bpm(beats, start_bpm)
        lag = 60.0 / bpm * signals.sr / signals.hop
        confidence = periodicity_at_lag(signals.smoothed_onset_envelope, lag)
        if confidence < self.min_tempo_confidence:
            return None
        return TempoEstimate(
            bpm=bpm,
            confidence=confidence,
            raw_confidence=None,
            beats=beats,
            method="librosa.beat.beat_track+beat-regression",
            steady=steady_tempo(beats, bpm, signals),
        )

    def key(self, signals: Signals) -> KeyEstimate | None:
        if signals.tonality.key_withheld():
            return None
        found = krumhansl_key(signals.chroma_mean)
        if found is None:
            return None
        tonic, mode, corr = found
        return _key_estimate(
            tonic, mode, corr, "krumhansl", "librosa.feature.chroma_cqt+krumhansl-kessler"
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
        bpm = refine_bpm(ticks, float(bpm))
        return TempoEstimate(
            bpm=bpm,
            confidence=confidence,
            raw_confidence=(float(raw), ESSENTIA_CONFIDENCE_SCALE),
            beats=ticks,
            method="essentia.RhythmExtractor2013+beat-regression",
            steady=steady_tempo(ticks, bpm, signals),
        )

    def key(self, signals: Signals) -> KeyEstimate | None:
        if signals.tonality.key_withheld():
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

"""
Tempo and key estimators behind one interface.

- ``EssentiaEstimator``: RhythmExtractor2013 (multifeature) and KeyExtractor (bgate profile) on
  44.1 kHz audio. The default when essentia is installed (the "models" extra).
- ``LibrosaEstimator``: librosa's tempo estimate (log-normal prior around 120 BPM, 40-208 BPM)
  and beat tracking on the onset envelope, and Krumhansl-Kessler profiles correlated with the
  constant-Q chromagram.

``AUDIO_ESTIMATOR=essentia|librosa`` picks one; an unavailable choice falls back to librosa.

Both refine the tempo from the beat positions they track (``refine_bpm``), so the result is not
limited to the grid of the onset envelope (23.2 ms frames at 22.05 kHz with a 512-sample hop,
which turns 120 BPM into 117 and 140 into 144). Both report a confidence from 0 to 1 and
withhold a tempo or a key that they cannot support (``None``).
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from functools import cached_property

import librosa
import numpy as np

logger = logging.getLogger("audio")

PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Pitch classes are always spelled with sharps; Essentia's KeyExtractor answers with flats.
FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}

# Rate and hop of the shared analysis signals (librosa's defaults; v1 uses the same).
SAMPLE_RATE = 22050
HOP_LENGTH = 512
# Essentia's rhythm and key algorithms are tuned for (and RhythmExtractor2013 assumes) 44.1 kHz.
ESSENTIA_RATE = 44100

# Tempo range both estimators search, RhythmExtractor2013's defaults.
MIN_BPM = 40.0
MAX_BPM = 208.0

# RhythmExtractor2013 reports its confidence on 0..5.32 (Zapata et al., 2012); the documented
# bands are < 1 very low, 1-1.5 low, 1.5-3.5 good and > 3.5 excellent.
ESSENTIA_CONFIDENCE_SCALE = (0.0, 5.32)

# A tempo needs onsets that repeat: Signals.onset_periodicity (the onset envelope's highest
# autocorrelation over the beat periods of 40-240 BPM) must reach MIN_TEMPO_PERIODICITY, the
# measure and threshold of the noise gate in signal_features.py. Measured on the fixtures
# (WAV and MP3): click tracks at 85-174 BPM 0.89-0.95, a drum pattern at 97 and 128 BPM
# 0.80-0.86; a steady triad, pure tones, 50 Hz hum and the chord progressions (one chord every
# 2 s) 0.00, noise 0.09-0.17. Without it, the progressions measure 90 BPM with Essentia (raw
# confidence 2.2-3.0) and 30 BPM with beat_track, and a steady triad 93 BPM (raw 1.7-1.9).
MIN_TEMPO_PERIODICITY = 0.4
# Below these confidences (0..1) a tempo is withheld as well.
# - Essentia: the bottom of the band its documentation calls "good" (1.5 of 5.32). Fixtures with
#   a beat score 3.27-4.15 raw (0.61-0.78); Essentia ignores the first 5 s when it scores, so a
#   6 s clip scores 0.
# - librosa: the onset autocorrelation at the beat period. Fixtures with a beat score 0.67-0.85.
ESSENTIA_MIN_TEMPO_CONFIDENCE = 1.5 / 5.32
LIBROSA_MIN_TEMPO_CONFIDENCE = 0.3
# At least this many tracked beats (three intervals) before a tempo is reported.
MIN_BEATS = 4

# A key needs a chord's worth of pitch classes: at least KEY_MIN_PITCH_CLASSES classes whose
# mean chroma reaches KEY_PITCH_CLASS_LEVEL of the strongest one. Measured on the fixtures:
# a 440 Hz tone has 1 (and flips between A major and A minor with the codec), 50 Hz mains hum
# 2 (G and G#), the A major triad 3, the C-F-G-C and Am-Dm-E-Am progressions 6. Key strength
# alone does not separate them: Essentia gives the tone 0.69 and the triad 0.74-0.84, the hum
# 0.83. (Hum whose harmonics spell a chord would pass; the gate does not detect hum.)
KEY_MIN_PITCH_CLASSES = 3
KEY_PITCH_CLASS_LEVEL = 0.25
# Below this strength (0..1) the key is withheld. Fixtures that get a key score 0.51-0.97 with
# Essentia (bgate profile) and 0.35-0.97 with librosa (Krumhansl-Kessler correlation); digital
# silence and dither score 0 with Essentia.
KEY_MIN_STRENGTH = 0.3

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


@dataclass(frozen=True)
class KeyEstimate:
    tonic: str
    mode: str  # "major" or "minor"
    strength: float | None  # 0..1
    profile: str
    method: str


class Signals:
    """
    One decoded preview and the representations every analysis step shares, computed once:
    the 22.05 kHz signal, its STFT magnitude, the onset envelope and the chromagram (all with
    a 512-sample hop), and resampled copies for the estimators and models that need them.
    """

    def __init__(self, native: np.ndarray, native_sr: int):
        self.native = np.nan_to_num(np.asarray(native, dtype=np.float32))
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
    def stft_magnitude(self) -> np.ndarray:
        return np.abs(librosa.stft(self.y, n_fft=2048, hop_length=self.hop))

    @cached_property
    def onset_envelope(self) -> np.ndarray:
        """librosa's beat-tracking onset envelope (median over mel bands), from the shared STFT."""
        mel = librosa.feature.melspectrogram(S=self.stft_magnitude**2, sr=self.sr)
        return librosa.onset.onset_strength(
            S=librosa.power_to_db(mel), sr=self.sr, hop_length=self.hop, aggregate=np.median
        )

    @cached_property
    def onset_periodicity(self) -> float:
        """
        Highest autocorrelation of the onset envelope over the beat periods of 40-240 BPM
        (0..1): how strongly the onsets repeat at some tempo.
        """
        x = self.onset_envelope - np.mean(self.onset_envelope)
        if x.size < 2 or not np.any(x):
            return 0.0
        ac = librosa.autocorrelate(x)
        lags = np.arange(ac.size) * self.hop / self.sr
        window = (lags >= 60.0 / 240) & (lags <= 60.0 / 40)
        return float(np.clip(np.max(ac[window]) / ac[0], 0.0, 1.0)) if window.any() else 0.0

    @cached_property
    def chroma(self) -> np.ndarray:
        return librosa.feature.chroma_cqt(y=self.y, sr=self.sr, hop_length=self.hop)

    @cached_property
    def chroma_mean(self) -> np.ndarray:
        return np.mean(self.chroma, axis=1) if self.chroma.size else np.zeros(12)


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


def has_key_material(chroma_mean: np.ndarray) -> bool:
    """True when enough pitch classes sound to imply a key (see KEY_MIN_PITCH_CLASSES)."""
    peak = float(np.max(chroma_mean)) if chroma_mean.size else 0.0
    if not peak > 0 or not np.all(np.isfinite(chroma_mean)):
        return False
    return int(np.sum(chroma_mean >= KEY_PITCH_CLASS_LEVEL * peak)) >= KEY_MIN_PITCH_CLASSES


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
        confidence = periodicity_at_lag(oenv, 60.0 / bpm * signals.sr / signals.hop)
        if confidence < self.min_tempo_confidence:
            return None
        return TempoEstimate(
            bpm=bpm,
            confidence=confidence,
            raw_confidence=None,
            beats=beats,
            method="librosa.beat.beat_track+beat-regression",
        )

    def key(self, signals: Signals) -> KeyEstimate | None:
        if not has_key_material(signals.chroma_mean):
            return None
        found = krumhansl_key(signals.chroma_mean)
        if found is None:
            return None
        tonic, mode, corr = found
        strength = float(np.clip(corr, 0.0, 1.0))
        if strength < KEY_MIN_STRENGTH:
            return None
        return KeyEstimate(
            tonic=tonic,
            mode=mode,
            strength=strength,
            profile="krumhansl",
            method="librosa.feature.chroma_cqt+krumhansl-kessler",
        )


_thread_state = threading.local()


def _essentia_algorithm(name: str, factory):
    """
    One instance per worker thread, reset before each use. Instances are kept rather than
    created per call: when the most recently created Essentia network is deleted, every later
    TensorFlow predictor call logs "No network created" thousands of times.
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
        return TempoEstimate(
            bpm=refine_bpm(ticks, float(bpm)),
            confidence=confidence,
            raw_confidence=(float(raw), ESSENTIA_CONFIDENCE_SCALE),
            beats=ticks,
            method="essentia.RhythmExtractor2013+beat-regression",
        )

    def key(self, signals: Signals) -> KeyEstimate | None:
        if not has_key_material(signals.chroma_mean):
            return None
        extractor = _essentia_algorithm(
            f"key-{self.key_profile}",
            lambda: _es.KeyExtractor(sampleRate=ESSENTIA_RATE, profileType=self.key_profile),
        )
        name, scale, strength = extractor(signals.at(ESSENTIA_RATE))
        tonic = FLAT_TO_SHARP.get(name, name)
        if tonic not in PITCH_CLASSES or scale not in ("major", "minor"):
            return None
        strength = float(np.clip(strength, 0.0, 1.0)) if np.isfinite(strength) else 0.0
        if strength < KEY_MIN_STRENGTH:
            return None
        return KeyEstimate(
            tonic=tonic,
            mode=scale,
            strength=strength,
            profile=self.key_profile,
            method="essentia.KeyExtractor",
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

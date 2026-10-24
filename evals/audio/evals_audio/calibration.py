"""
Calibration of the service's withholding rules from measured results.

For every clip the worker records, besides what the service served, what each rule compares:
the gate's measurements (level, onset periodicity, spectral lines, the pitch track), the key
evidence rule's (the share of energy in spectral lines, the pitch classes they spell, the pitch
track's verdicts) and, per estimator, the estimate it makes with every withholding rule lifted
(tempo: the confidence and what the steadiness check measured in each third; key: the
strength). `derive_tempo` and `derive_key` apply a set of rule values (`Rules`) to those
records; at the service's own values they must give what the service served, and every run
checks that on every clip (`mismatches`).

The choice (`select`) is made on the calibration clips only (datasets.split_of) and on the
generated controls (controls.py), one family of rules after another, under the acceptance
criteria below, fixed before any evaluation clip was scored. `evaluate` then compares the
service's values before this calibration (BASELINE) with the values it has now, on the
evaluation clips, which never took part in a choice.

Acceptance (pooled over the family's datasets, per deciding estimator):
- a loosening (answers the old value withheld): its extra answers are right (tempo Acc1, key
  exact) with a Wilson 95 % lower bound of at least L1_MIN_LOWER; their share right is at most
  L2_MAX_DROP below that of the answers the old value gave; their share wrong even forgiving
  octave and meter (tempo) or relation (key: MIREX 0) is at most L3_MAX_GROSS_RISE above the
  old answers' share;
- a tightening (answers the old value gave, withheld): it must remove a value a control shows
  where the truth is none or another value; correct / n falls by at most T2_MAX_DROP on each
  dataset; and the answers it withholds are right less often than those it keeps;
- either way, no control goes from right to wrong.
Among accepted loosenings the one answering most calibration clips is chosen; among accepted
tightenings (when no loosening is accepted) the one fixing most controls, then withholding
fewest answers, then the least strict. Otherwise the value stays.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, replace

import numpy as np

from . import service
from .metrics import Item, mcnemar_exact, ranking_auc, wilson

# Acceptance criteria (shares, 0..1).
L1_MIN_LOWER = 0.5
L2_MAX_DROP = 0.10
L3_MAX_GROSS_RISE = 0.10
T2_MAX_DROP = 0.02

# Pitch classes of the lines from these frequencies up only (the bass region left out).
UPPER_HZ = (130.0, 260.0)
# The overtone-aware pitch classes: a partial is an overtone when it lies within this share (or
# two spectrum bins) of harmonic 2-8 of a stronger, lower partial; partials are looked for from
# PARTIAL_LOW_HZ, so that a bass under the 60 Hz edge of the line band is still a fundamental.
OVERTONE_TOLERANCE = 0.01
OVERTONE_HARMONICS = range(2, 9)
PARTIAL_LOW_HZ = 30.0
# Window lengths (s) at which the beat drift is recorded (estimators.beat_drift).
DRIFT_WINDOWS = (4.0, 6.0)

SERVICE_ESTIMATORS = ("librosa", "essentia")


# --- rules -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Rules:
    """The values of the withholding rules that calibration varies; dicts are per estimator."""

    min_periodicity: float
    min_confidence: dict
    steady_tolerance: float
    steady_lag_frames: float
    onset_check: dict  # the steadiness check's onset-tempo part (missing: on)
    drift: dict  # [window s, tolerance] or None (missing: none)
    line_rules_with_beat: dict  # the key evidence's spectral-line rules over a beat (missing: on)
    min_tonal_ratio: float
    tonal_source: str  # "mix" or "harmonic"
    class_vector: str  # "lines", "upper130", "upper260" or "fundamental"
    class_level: float
    min_classes: int
    min_strength: dict

    def as_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> Rules:
        return cls(**d)

    def set(self, name: str, value, estimator: str | None = None) -> Rules:
        """A copy with `name` set to `value` (for one estimator when the field is per estimator)."""
        if estimator is None:
            return replace(self, **{name: value})
        return replace(self, **{name: {**getattr(self, name), estimator: value}})

    def get(self, name: str, estimator: str | None = None):
        value = getattr(self, name)
        return value.get(estimator, FIELD_DEFAULTS.get(name)) if estimator else value


FIELD_DEFAULTS = {
    "min_confidence": 0.0,
    "onset_check": True,
    "drift": None,
    "line_rules_with_beat": True,
    "min_strength": 0.0,
}

# The service's values before this calibration (commit ec7d24b), each named after its constant
# there: what "before" means in the report.
BASELINE = Rules(
    min_periodicity=0.2,  # MIN_TEMPO_PERIODICITY
    min_confidence={  # LIBROSA_ and ESSENTIA_MIN_TEMPO_CONFIDENCE
        "librosa": 0.3,
        "essentia": 1.5 / 5.32,
        "beat-this": 0.0,
    },
    steady_tolerance=0.05,  # STEADY_TEMPO_TOLERANCE
    steady_lag_frames=2.0,  # STEADY_LAG_FRAMES
    onset_check={"librosa": True, "essentia": True, "beat-this": True},
    drift={"librosa": None, "essentia": None, "beat-this": None},
    line_rules_with_beat={"librosa": True, "essentia": True},
    min_tonal_ratio=0.1,  # MIN_TONAL_RATIO
    tonal_source="mix",
    class_vector="lines",
    class_level=0.28,  # KEY_PITCH_CLASS_LEVEL
    min_classes=3,  # KEY_MIN_PITCH_CLASSES
    min_strength={"librosa": 0.3, "essentia": 0.3},  # KEY_MIN_STRENGTH
)


def service_rules() -> Rules:
    """The values the imported service uses now (beat-this as the harness runs it)."""
    from .beatthis import BeatThisEstimator

    _, est = service.load()
    classes = {n: est.ESTIMATORS[n] for n in SERVICE_ESTIMATORS}
    tempo_classes = {**classes, "beat-this": BeatThisEstimator}

    def drift(c):
        tolerance = c.steady_drift_tolerance
        return None if tolerance is None else [est.STEADY_DRIFT_WINDOW_S, tolerance]

    return Rules(
        min_periodicity=est.MIN_TEMPO_PERIODICITY,
        min_confidence={n: c.min_tempo_confidence for n, c in tempo_classes.items()},
        steady_tolerance=est.STEADY_TEMPO_TOLERANCE,
        steady_lag_frames=est.STEADY_LAG_FRAMES,
        onset_check={n: c.steady_onset_check for n, c in tempo_classes.items()},
        drift={n: drift(c) for n, c in tempo_classes.items()},
        line_rules_with_beat={n: c.key_lines_with_beat for n, c in classes.items()},
        min_tonal_ratio=est.MIN_TONAL_RATIO,
        tonal_source="mix",
        class_vector="lines",
        class_level=est.KEY_PITCH_CLASS_LEVEL,
        min_classes=est.KEY_MIN_PITCH_CLASSES,
        min_strength={n: c.min_key_strength for n, c in classes.items()},
    )


# --- recording (in the worker) -----------------------------------------------------------------


def _f(x) -> float | None:
    """
    A float for the JSON at full precision (None for nan or None): the rules compare these, and
    tempos on librosa's frame grid can sit exactly on a tolerance (103.36 against 107.67 BPM is
    0.96 to the last bit), where a rounded value would flip the decision.
    """
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) else x


def class_vector(hz: np.ndarray, amp: np.ndarray) -> list[float]:
    """Amplitude per pitch class (C first), relative to the strongest; zeros when empty."""
    import librosa

    classes = np.zeros(12)
    if hz.size:
        midi = np.round(librosa.hz_to_midi(hz)).astype(int)
        np.add.at(classes, midi % 12, amp)
    peak = float(classes.max())
    return [_f(c / peak) if peak > 0 else 0.0 for c in classes]


def partials(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, float]:
    """
    The partials of the long-term spectrum from PARTIAL_LOW_HZ (runs of line bins, found as the
    service finds lines): their power-weighted frequency, their amplitude (the sum of the square
    root of the power over the run) and the bin width.
    """
    import scipy.ndimage
    import scipy.signal

    _, est = service.load()
    if y.size < 4096:
        return np.zeros(0), np.zeros(0), 1.0
    freqs, power = scipy.signal.welch(y.astype(np.float64), sr, nperseg=min(16384, y.size))
    db = 10 * np.log10(power + 1e-20)
    floor = scipy.ndimage.median_filter(db, size=est.LINE_FLOOR_BINS, mode="nearest")
    band = (freqs >= PARTIAL_LOW_HZ) & (freqs <= est.LINE_BAND_HZ[1])
    labels, count = scipy.ndimage.label(band & (db > floor + est.LINE_PROMINENCE_DB))
    hz, amp = [], []
    for k in range(1, count + 1):
        idx = np.flatnonzero(labels == k)
        w = power[idx]
        hz.append(float(np.sum(freqs[idx] * w) / np.sum(w)))
        amp.append(float(np.sum(np.sqrt(w))))
    return np.array(hz), np.array(amp), float(freqs[1] - freqs[0])


def fundamentals(hz: np.ndarray, amp: np.ndarray, bin_hz: float) -> np.ndarray:
    """Which partials are not overtones (harmonic 2-8 of a stronger, lower partial)."""
    keep = np.ones(hz.size, dtype=bool)
    order = np.argsort(hz)
    for position, j in enumerate(order):
        for i in order[:position]:
            if not keep[i] or amp[i] <= amp[j]:
                continue
            k = round(hz[j] / hz[i])
            if k in OVERTONE_HARMONICS and abs(hz[j] - k * hz[i]) <= max(
                OVERTONE_TOLERANCE * hz[j], 2 * bin_hz
            ):
                keep[j] = False
                break
    return keep


def evidence(signals) -> dict:
    """What the key evidence rule (Signals.key_withheld) compares, for one clip."""
    _, est = service.load()
    tonality = signals.tonality
    voice = signals.voice
    hz, amp, bin_hz = partials(signals.y, signals.sr)
    in_band = (hz >= est.LINE_BAND_HZ[0]) & fundamentals(hz, amp, bin_hz)
    vectors = {
        "lines": class_vector(tonality.line_hz, np.sqrt(tonality.line_power)),
        "fundamental": class_vector(hz[in_band], amp[in_band]),
    }
    for cut in UPPER_HZ:
        upper = tonality.line_hz >= cut
        vectors[f"upper{cut:g}"] = class_vector(
            tonality.line_hz[upper], np.sqrt(tonality.line_power[upper])
        )
    record = {
        "periodicity": _f(signals.onset_periodicity),
        "tonalRatio": _f(tonality.tonal_ratio),
        "harmonicTonalRatio": _f(signals.harmonic_tonality.tonal_ratio),
        "series": tonality.series_f0 is not None,
        "movement": _f(signals.chroma_movement),
        "classes": vectors,
        "voice": None,
    }
    if voice is not None:
        record["voice"] = {
            "single": voice.single,
            "onePitch": voice.one_pitch,
            "withoutNotes": voice.without_notes,
            "moving": voice.moving,
            "relativeMovement": _f(voice.relative_movement),
            "noteClasses": sorted(voice.note_classes),
            # The one-held-pitch tests: without a beat on the mix's lines with the voice's
            # tolerance, with a beat on the harmonic part's lines with the held tolerance.
            "explained": _f(tonality.explained_by(voice.f0_hz, *voice.tolerance)),
            "explainedHeld": _f(
                signals.harmonic_tonality.explained_by(voice.f0_hz, *voice.held_tolerance)
            ),
        }
    return record


def gate_stats(signals, loudness) -> dict:
    """What the noise gate (signal_features.check_gate) compares, for one clip."""
    tonality = signals.tonality
    record = {
        "duration": _f(signals.duration),
        "loud": _f(loudness.loud) if loudness is not None else None,
        "periodicity": _f(signals.onset_periodicity),
        "tonalRatio": _f(tonality.tonal_ratio),
        "series": tonality.series_f0 is not None,
        "voiceMovingOrWithoutNotes": None,
    }
    voice = signals.voice
    if voice is not None:
        record["voiceMovingOrWithoutNotes"] = bool(voice.moving or voice.without_notes)
    return record


def tempo_stats(signals, est) -> dict | None:
    """The estimate with every tempo rule lifted, and what the steadiness check measured."""
    _, estimators = service.load()
    minimum = estimators.MIN_TEMPO_PERIODICITY
    estimators.MIN_TEMPO_PERIODICITY = 0.0
    est.min_tempo_confidence = 0.0
    try:
        tempo = est.tempo(signals)
    finally:
        estimators.MIN_TEMPO_PERIODICITY = minimum
        del est.min_tempo_confidence  # back to the class value
    if tempo is None:
        return None
    measured = tempo.steadiness or estimators.steadiness(tempo.beats, tempo.bpm, signals)
    beats = np.asarray(tempo.beats, dtype=float)
    n = signals.onset_envelope.size
    edges = np.linspace(0, n, estimators.STEADY_TEMPO_PARTS + 1).astype(int)
    seconds = edges * signals.hop / signals.sr
    thirds = list(zip(seconds[:-1], seconds[1:], strict=True))
    return {
        "bpm": _f(tempo.bpm),
        "confidence": _f(tempo.confidence),
        "steadiness": {
            "enoughBeats": measured.enough_beats,
            "period": _f(measured.period),
            "byCount": measured.by_count,
            "parts": [[_f(p.rhythm), _f(p.beat_bpm), _f(p.onset_period)] for p in measured.parts],
        },
        "drift": {
            f"{w:g}": [_f(estimators.beat_drift(beats, tempo.bpm, a, b, w)) for a, b in thirds]
            for w in DRIFT_WINDOWS
        },
    }


def key_stats(signals, est) -> dict | None:
    """The key with the evidence rule and the minimum strength lifted."""
    raw = service.key_without_withholding(signals, est)
    if raw is None:
        return None
    return {"tonic": raw.tonic, "mode": raw.mode, "strength": _f(raw.strength)}


def record(signals, ests: dict, suite: str) -> dict:
    """The calibration record of one clip (see the module docstring)."""
    import signal_features

    loudness = signal_features.levels(signals) if signals.native.size else None
    out: dict = {"gate": gate_stats(signals, loudness), "estimators": {}}
    if suite in ("key", "controls"):
        out["evidence"] = evidence(signals)
    for name, est in ests.items():
        entry: dict = {}
        if suite in ("tempo", "controls"):
            entry["tempo"] = tempo_stats(signals, est)
        if suite in ("key", "controls") and name in service.SUITE_ESTIMATORS["key"]:
            entry["key"] = key_stats(signals, est)
        out["estimators"][name] = entry
    return out


# --- deriving the service's decisions -----------------------------------------------------------


def steady(stats: dict, rules: Rules, name: str) -> bool:
    """The steadiness check on recorded measurements, under `rules`."""
    _, est = service.load()
    s = stats["steadiness"]
    parts = tuple(est.SteadyPart(r, b, math.nan if o is None else o) for r, b, o in s["parts"])
    measured = est.Steadiness(
        bpm=stats["bpm"],
        enough_beats=s["enoughBeats"],
        parts=parts,
        period=s["period"] or 0.0,
        by_count=s["byCount"],
    )
    if not measured.holds(
        rules.steady_tolerance,
        rules.steady_lag_frames,
        rules.min_periodicity,
        onset_check=rules.get("onset_check", name),
    ):
        return False
    drift = rules.get("drift", name)
    if drift is not None:
        window, tolerance = drift
        for part, d in zip(s["parts"], stats["drift"][f"{window:g}"], strict=True):
            if part[0] is not None and part[0] >= rules.min_periodicity and (d or 0.0) > tolerance:
                return False
    return True


def derive_tempo(
    gate_passed: bool, periodicity: float, stats: dict | None, name: str, rules: Rules
):
    """The tempo the service would serve under `rules` (None when withheld)."""
    if not gate_passed or stats is None or periodicity < rules.min_periodicity:
        return None
    confidence = stats["confidence"]
    if confidence is not None and confidence < rules.get("min_confidence", name):
        return None
    return stats["bpm"] if steady(stats, rules, name) else None


ONE_SERIES = "one harmonic series"


def evidence_withheld(ev: dict, rules: Rules, name: str) -> str | None:
    """Signals.key_withheld for estimator `name`, on the recorded evidence, under `rules`."""
    _, est = service.load()
    has_beat = ev["periodicity"] >= est.MIN_TEMPO_PERIODICITY
    ratio = ev["tonalRatio"] if rules.tonal_source == "mix" else ev["harmonicTonalRatio"]
    vector = ev["classes"][rules.class_vector]
    line_classes = {i for i, a in enumerate(vector) if a > 0 and a >= rules.class_level}
    voice = ev["voice"]

    def tonality_rule(v: dict | None, still: bool) -> str | None:
        moving = bool(v and v["moving"])
        without_notes = bool(v and v["withoutNotes"])
        if ratio < rules.min_tonal_ratio and not moving:
            return est.SPEECH_LIKE if without_notes else "no sustained pitch"
        if ev["series"] and still:
            return ONE_SERIES
        if v and v["onePitch"] and still and v["explained"] >= est.ONE_PITCH_MIN_EXPLAINED:
            return "one held pitch (vibrato or a bend)"
        if without_notes:
            return est.SPEECH_LIKE
        notes = set(v["noteClasses"]) if v else set()
        if len(line_classes | notes) < rules.min_classes:
            return "fewer than three pitch classes"
        return None

    if has_beat:
        lines = rules.get("line_rules_with_beat", name)
        withheld = tonality_rule(None, True) if lines else None
        if withheld is not None or voice is None:
            return withheld
        if voice["withoutNotes"]:
            return est.SPEECH_LIKE
        if voice["onePitch"] and voice["explainedHeld"] >= est.ONE_PITCH_MIN_EXPLAINED:
            return "one held pitch over the beat (a drone or one bass note)"
        return None
    if voice is None:
        return tonality_rule(None, ev["movement"] < est.STILL_MAX_MOVEMENT) or "no pitch track"
    still = ev["movement"] < est.STILL_MAX_MOVEMENT or (
        voice["single"] and voice["relativeMovement"] < est.STILL_MAX_MOVEMENT
    )
    return tonality_rule(voice, still)


def derive_key(gate_passed: bool, ev: dict, stats: dict | None, name: str, rules: Rules):
    """The key the service would serve under `rules`, as [tonic, mode], or None."""
    if not gate_passed or stats is None or evidence_withheld(ev, rules, name) is not None:
        return None
    if (stats["strength"] or 0.0) < rules.get("min_strength", name):
        return None
    return [stats["tonic"], stats["mode"]]


def derived(clip: dict, name: str, kind: str, rules: Rules):
    """What the service would serve for one recorded clip (a run's clip record or a control)."""
    entry = clip["estimators"][name]
    raw = entry[kind]["raw"]
    if kind == "tempo":
        return derive_tempo(entry["gatePassed"], clip["gate"]["periodicity"], raw, name, rules)
    return derive_key(entry["gatePassed"], clip["evidence"], raw, name, rules)


def usable(clip: dict, name: str, kind: str) -> bool:
    """The clip has a record of `kind` for estimator `name` (no failure)."""
    entry = clip["estimators"].get(name)
    return entry is not None and not entry.get("error") and kind in entry


def mismatches(clips: list[dict], names, kind: str, rules: Rules) -> dict:
    """Per estimator: the clips where the derivation under `rules` differs from what was served."""
    out = {}
    for name in names:
        bad = []
        for clip in clips:
            if not usable(clip, name, kind):
                continue
            value = derived(clip, name, kind, rules)
            served = clip["estimators"][name][kind]["served"]
            if kind == "tempo":
                same = (value is None) == (served is None) and (
                    value is None or abs(value - served) <= 0.01
                )
            else:
                same = value == served
            if not same:
                bad.append(clip["trackId"])
        out[name] = bad
    return out


# --- scoring ---------------------------------------------------------------------------------------


def outcome(clip: dict, name: str, kind: str, rules: Rules) -> dict | None:
    """The scores of what the service would serve under `rules`; None when it withholds."""
    if derived(clip, name, kind, rules) is None:
        return None
    return clip["estimators"][name][kind]["raw"]["scores"]


def right(kind: str, scores: dict) -> bool:
    return bool(scores["acc1"] if kind == "tempo" else scores["exact"])


def gross(kind: str, scores: dict) -> bool:
    """Wrong even forgiving octave and meter (tempo), or no relation to the key (MIREX 0)."""
    return not scores["acc2"] if kind == "tempo" else scores["mirex"] == 0


def comparison(clips: list[dict], name: str, kind: str, new: Rules, old: Rules) -> dict:
    """Old against new rules on the same clips: answers gained and lost, and how right they are."""
    c = {k: 0 for k in ("n", "old", "new", "oldRight", "newRight", "oldGross")}
    c |= {k: 0 for k in ("extra", "extraRight", "extraGross", "lost", "lostRight")}
    c |= {"kept": 0, "keptRight": 0, "discordantNew": 0, "discordantOld": 0}
    for clip in clips:
        if not usable(clip, name, kind):
            continue
        a, b = outcome(clip, name, kind, new), outcome(clip, name, kind, old)
        c["n"] += 1
        ra, rb = bool(a and right(kind, a)), bool(b and right(kind, b))
        c["newRight"] += ra
        c["oldRight"] += rb
        c["discordantNew"] += ra and not rb
        c["discordantOld"] += rb and not ra
        if a is not None:
            c["new"] += 1
        if b is not None:
            c["old"] += 1
            c["oldGross"] += gross(kind, b)
        if a is not None and b is None:
            c["extra"] += 1
            c["extraRight"] += right(kind, a)
            c["extraGross"] += gross(kind, a)
        if b is not None and a is None:
            c["lost"] += 1
            c["lostRight"] += right(kind, b)
        if b is not None and a is not None:
            c["kept"] += 1
            c["keptRight"] += right(kind, b)
    c["mcnemarP"] = mcnemar_exact(c["discordantNew"], c["discordantOld"])
    return c


def _share(k: int, n: int) -> float | None:
    return k / n if n else None


# --- controls ----------------------------------------------------------------------------------


def control_ok(truth, value, kind: str) -> bool | None:
    """Whether a control's value matches its truth; None when the field is not scored."""
    from .controls import ANY, NOT_SCORED
    from .metrics import acc1

    if truth == NOT_SCORED:
        return None
    if truth is None:
        return value is None
    if kind == "tempo":
        return value is not None and bool(acc1(value, truth))
    if truth == ANY:
        return value is not None
    return value is not None and list(value) == list(truth)


def control_changes(controls: list[dict], name: str, kind: str, new: Rules, old: Rules) -> dict:
    """Controls that go from wrong to right (fixed) and from right to wrong (broken)."""
    fixed, broken = [], []
    for ctl in controls:
        if not usable(ctl, name, kind):
            continue
        truth = ctl["truth"][kind]
        a, b = derived(ctl, name, kind, new), derived(ctl, name, kind, old)
        ok_new, ok_old = control_ok(truth, a, kind), control_ok(truth, b, kind)
        if ok_new is None:
            continue
        if ok_new and not ok_old:
            fixed.append(ctl["name"])
        if ok_old and not ok_new:
            broken.append(ctl["name"])
    return {"fixed": fixed, "broken": broken}


# --- the families of rules and the choice ------------------------------------------------------------


@dataclass(frozen=True)
class Family:
    key: str
    kind: str  # "tempo" or "key"
    field: str  # the Rules field
    title: str
    values: tuple
    per_estimator: bool
    deciding: tuple  # estimators whose clips decide
    shown: tuple = ()  # estimators shown, not deciding


ESSENTIA_CONFIDENCES = (0.0, 0.1, 0.15, 0.2, 0.25, 1.5 / 5.32, 0.35, 0.4, 0.5)
LIBROSA_CONFIDENCES = (0.0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5)
STRENGTHS = (0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8)
DRIFTS = (None, *([w, t] for w in DRIFT_WINDOWS for t in (0.08, 0.1, 0.12, 0.15)))
CLASS_RULES = tuple(
    [vector, level]
    for vector in ("lines", "fundamental", "upper130", "upper260")
    for level in (0.28, 0.2, 0.15, 0.1)
)

FAMILIES = (
    Family(
        "onset",
        "tempo",
        "onset_check",
        "steadiness check: librosa's tempo on each third's onsets",
        (True, False),
        True,
        ("essentia",),  # librosa's tracker keeps one period: it needs this part
        ("beat-this",),
    ),
    Family(
        "tolerance",
        "tempo",
        "steady_tolerance",
        "steadiness check: tolerance",
        (0.04, 0.05, 0.06, 0.08, 0.1),
        False,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "drift",
        "tempo",
        "drift",
        "steadiness check: beat drift within a third (window, tolerance)",
        DRIFTS,
        True,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "confidence",
        "tempo",
        "min_confidence",
        "tempo confidence minimum",
        (),  # per estimator, below
        True,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "periodicity",
        "tempo",
        "min_periodicity",
        "onset periodicity minimum (tempo)",
        (0.1, 0.15, 0.2, 0.25, 0.3),
        False,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "strength",
        "key",
        "min_strength",
        "key strength minimum",
        STRENGTHS,
        True,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "lines",
        "key",
        "line_rules_with_beat",
        "key evidence over a beat: the spectral-line rules",
        (True, False),
        True,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "tonal",
        "key",
        "min_tonal_ratio",
        "key evidence: share of energy in spectral lines (no sustained pitch)",
        (0.1, 0.075, 0.05, 0.03, 0.02, 0.0),
        False,
        SERVICE_ESTIMATORS,
    ),
    Family(
        "classes",
        "key",
        "class_rule",
        "key evidence: pitch classes (fewer than three), by vector and level",
        CLASS_RULES,
        False,
        SERVICE_ESTIMATORS,
    ),
)


def family_values(family: Family, name: str | None) -> tuple:
    if family.key == "confidence":
        return ESSENTIA_CONFIDENCES if name == "essentia" else LIBROSA_CONFIDENCES
    return family.values


def apply(rules: Rules, family: Family, value, name: str | None) -> Rules:
    if family.field == "class_rule":
        return rules.set("class_vector", value[0]).set("class_level", value[1])
    return rules.set(family.field, value, name if family.per_estimator else None)


def current(rules: Rules, family: Family, name: str | None):
    if family.field == "class_rule":
        return [rules.class_vector, rules.class_level]
    return rules.get(family.field, name if family.per_estimator else None)


def judge(cmp: dict, per_dataset: dict, changes: dict, kind: str) -> dict:
    """The acceptance criteria for one candidate against the old value (see the docstring)."""
    out: dict = {"loosens": cmp["extra"] > 0, "tightens": cmp["lost"] > 0 or bool(changes["fixed"])}
    reasons = []
    if cmp["extra"]:
        w = wilson(cmp["extraRight"], cmp["extra"])
        old_share = _share(cmp["oldRight"], cmp["old"]) or 0.0
        extra_share = cmp["extraRight"] / cmp["extra"]
        old_gross = _share(cmp["oldGross"], cmp["old"]) or 0.0
        out["L1"] = w.low >= L1_MIN_LOWER
        out["L2"] = extra_share >= old_share - L2_MAX_DROP
        out["L3"] = cmp["extraGross"] / cmp["extra"] <= old_gross + L3_MAX_GROSS_RISE
        reasons += [r for r in ("L1", "L2", "L3") if not out[r]]
    if cmp["lost"] or (changes["fixed"] and not cmp["extra"]):
        out["T1"] = bool(changes["fixed"])
        drops = [(d["newRight"] - d["oldRight"]) / d["n"] for d in per_dataset.values() if d["n"]]
        lost_share = _share(cmp["lostRight"], cmp["lost"])
        kept_share = _share(cmp["keptRight"], cmp["kept"])
        out["T2"] = all(x >= -T2_MAX_DROP for x in drops) and (
            lost_share is None or kept_share is None or lost_share < kept_share
        )
        reasons += [r for r in ("T1", "T2") if not out[r]]
    out["controls"] = not changes["broken"]
    if not out["controls"]:
        reasons.append("controls")
    changed = cmp["extra"] or cmp["lost"] or changes["fixed"] or changes["broken"]
    out["accepted"] = bool(changed) and not reasons
    out["failed"] = reasons
    return out


def candidate_row(
    runs, controls, family, name, value, base: Rules, split: str = "calibration"
) -> dict:
    """One candidate for one estimator: the comparison on the clips of `split`, and the verdict."""
    new = apply(base, family, value, name if family.per_estimator else None)
    per_dataset = {}
    for run in runs:
        clips = [c for c in run["clips"] if c["split"] == split]
        per_dataset[run["dataset"]["name"]] = comparison(clips, name, family.kind, new, base)
    pooled = {
        k: sum(d[k] for d in per_dataset.values())
        for k in next(iter(per_dataset.values()))
        if k != "mcnemarP"
    }
    changes = control_changes(controls, name, family.kind, new, base)
    return {
        "value": value,
        "estimator": name,
        "pooled": pooled,
        "perDataset": per_dataset,
        "controls": changes,
        "verdict": judge(pooled, per_dataset, changes, family.kind),
    }


def looseness(family: str, value) -> tuple:
    """Orders a family's values from the strictest to the least strict."""
    if family in ("onset", "lines"):
        return (not value,)  # on is stricter than off
    if family == "drift":
        return (1, 0.0, 0.0) if value is None else (0, value[1], value[0])
    if family == "classes":
        return (-value[1],)
    if family in ("tolerance",):
        return (value,)
    return (-value,)  # minimums: a lower one is less strict


def choose(rows: list[dict], family: str = "") -> int | None:
    """The index of the chosen candidate among accepted ones (see the docstring), or None."""
    loose = [i for i, r in enumerate(rows) if r["verdict"]["accepted"] and r["verdict"]["loosens"]]
    if loose:
        return max(
            loose, key=lambda i: (rows[i]["pooled"]["new"], looseness(family, rows[i]["value"]))
        )
    tight = [i for i, r in enumerate(rows) if r["verdict"]["accepted"]]
    if not tight:
        return None
    return max(
        tight,
        key=lambda i: (
            len(rows[i]["controls"]["fixed"]),
            -rows[i]["pooled"]["lost"],
            looseness(family, rows[i]["value"]),
        ),
    )


def select(runs: list[dict], controls: list[dict]) -> dict:
    """
    The choice, family by family, from the baseline: each family's candidates on the calibration
    clips of the runs of its kind and on the controls, with the earlier choices in place.
    """
    rules = BASELINE
    out = []
    for family in FAMILIES:
        kind_runs = [r for r in runs if r["kind"] == family.kind]
        if not kind_runs:
            continue
        names = family.deciding if family.per_estimator else (None,)
        entry: dict = {"family": family.key, "title": family.title, "kind": family.kind}
        groups = []
        for name in names:
            deciding = [name] if name else list(family.deciding)
            rows_by = {
                n: [
                    candidate_row(kind_runs, controls, family, n, v, rules)
                    for v in family_values(family, name)
                ]
                for n in deciding
            }
            if name is None:
                # A shared rule must be accepted for every deciding estimator.
                merged = []
                for k, value in enumerate(family.values):
                    per = {n: rows_by[n][k] for n in deciding}
                    accepted = all(r["verdict"]["accepted"] for r in per.values())
                    loosens = any(r["verdict"]["loosens"] for r in per.values())
                    merged.append(
                        {
                            "value": value,
                            "rows": per,
                            "verdict": {"accepted": accepted, "loosens": loosens},
                            "pooled": {"new": sum(r["pooled"]["new"] for r in per.values())},
                            "controls": {
                                "fixed": [f for r in per.values() for f in r["controls"]["fixed"]]
                            },
                        }
                    )
                for m in merged:
                    m["pooled"]["lost"] = sum(r["pooled"]["lost"] for r in m["rows"].values())
                pick = choose(merged, family.key)
                chosen = merged[pick]["value"] if pick is not None else current(rules, family, None)
                groups.append(
                    {
                        "estimator": None,
                        "before": current(rules, family, None),
                        "chosen": chosen,
                        "candidates": merged,
                    }
                )
                if pick is not None:
                    rules = apply(rules, family, chosen, None)
            else:
                rows = rows_by[name]
                pick = choose(rows, family.key)
                before = current(rules, family, name)
                chosen = rows[pick]["value"] if pick is not None else before
                groups.append(
                    {"estimator": name, "before": before, "chosen": chosen, "candidates": rows}
                )
                if pick is not None:
                    rules = apply(rules, family, chosen, name)
        for name in family.shown:
            rows = [
                candidate_row(kind_runs, controls, family, name, v, rules)
                for v in family_values(family, name)
            ]
            groups.append(
                {
                    "estimator": name,
                    "shown": True,
                    "before": current(rules, family, name),
                    "chosen": None,
                    "candidates": rows,
                }
            )
        entry["groups"] = groups
        out.append(entry)
    return {"families": out, "rules": rules.as_dict()}


FAMILY_BY_KEY = {f.key: f for f in FAMILIES}


def confirm(runs: list[dict], controls: list[dict], choice: dict) -> dict:
    """
    Each change the choice made, judged again with the same criteria on the evaluation clips
    (and the controls), in the same order: a change that fails there is reverted to the value
    before it. Returns the changes with their verdicts and the rules that remain.
    """
    rules = BASELINE
    out = []
    for entry in choice["families"]:
        family = FAMILY_BY_KEY[entry["family"]]
        kind_runs = [r for r in runs if r["kind"] == family.kind]
        for group in entry["groups"]:
            name = group["estimator"]
            if group.get("shown") or group["chosen"] == group["before"]:
                continue
            deciding = [name] if name else list(family.deciding)
            rows = {
                n: candidate_row(
                    kind_runs, controls, family, n, group["chosen"], rules, "evaluation"
                )
                for n in deciding
            }

            def unchanged(r):
                p, c = r["pooled"], r["controls"]
                return not (p["extra"] or p["lost"] or c["fixed"] or c["broken"])

            confirmed = all(r["verdict"]["accepted"] or unchanged(r) for r in rows.values())
            out.append(
                {
                    "family": family.key,
                    "title": family.title,
                    "kind": family.kind,
                    "estimator": name,
                    "before": group["before"],
                    "chosen": group["chosen"],
                    "rows": rows,
                    "confirmed": confirmed,
                }
            )
            if confirmed:
                rules = apply(rules, family, group["chosen"], name)
    return {"changes": out, "rules": rules.as_dict()}


# --- the held-out evaluation and the rest of the report's figures --------------------------------------


def evaluate(
    runs: list[dict], before: Rules, after: Rules, split: str = "evaluation"
) -> list[dict]:
    """Per dataset and estimator, the rules before against after on the clips of `split`."""
    out = []
    for run in runs:
        clips = [c for c in run["clips"] if c["split"] == split]
        for name in run["estimators"]:
            out.append(
                {
                    "dataset": run["dataset"]["name"],
                    "estimator": name,
                    **comparison(clips, name, run["kind"], after, before),
                }
            )
    return out


def controls_table(controls: list[dict], names, before: Rules, after: Rules) -> list[dict]:
    """Every control: its truth, and per estimator the value before and after, and whether right."""
    rows = []
    for ctl in controls:
        row = {"name": ctl["name"], "group": ctl["group"], "truth": ctl["truth"], "estimators": {}}
        for name in names:
            entry = ctl["estimators"].get(name)
            if entry is None:
                continue
            cells = {}
            for kind in ("tempo", "key"):
                if not usable(ctl, name, kind):
                    continue
                truth = ctl["truth"][kind]
                b = derived(ctl, name, kind, before)
                a = derived(ctl, name, kind, after)
                cells[kind] = {
                    "before": b,
                    "after": a,
                    "okBefore": control_ok(truth, b, kind),
                    "okAfter": control_ok(truth, a, kind),
                }
            row["estimators"][name] = cells
        rows.append(row)
    return rows


def octave_ranking(runs: list[dict], rules: Rules, split: str, seed: int) -> list[dict]:
    """
    Whether the tempo confidence ranks octave and meter errors: among the served tempos that
    are right forgiving octave and meter (Acc2), the AUC of the confidence for Acc1.
    """
    out = []
    for run in runs:
        if run["kind"] != "tempo":
            continue
        for name in run["estimators"]:
            items = []
            for clip in run["clips"]:
                if clip["split"] != split or not usable(clip, name, "tempo"):
                    continue
                scores = outcome(clip, name, "tempo", rules)
                raw = clip["estimators"][name]["tempo"]["raw"]
                if scores is None or not scores["acc2"] or raw["confidence"] is None:
                    continue
                items.append(Item(clip["trackId"], raw["confidence"], {"acc1": scores["acc1"]}))
            if items:
                out.append(
                    {
                        "dataset": run["dataset"]["name"],
                        "estimator": name,
                        **ranking_auc(items, "acc1", seed),
                    }
                )
    return out

"""
Scores, intervals and the accuracy-vs-coverage curve.

Tempo (Gouyon et al. 2006): Acc1 is an estimate within 4 % of the reference tempo; Acc2 also
accepts the reference times 2, 3, 1/2 or 1/3 (octave and meter errors), each within 4 %.

Key (MIREX): 1 for the same key, 0.5 for the key a perfect fifth above the reference in the
same mode, 0.3 for the relative key, 0.2 for the parallel key, 0 otherwise (mir_eval's
weighted score with ascending fifths only). Exact accuracy counts only the same key.

An item the service answered nothing for is *withheld*: it is counted on its own, never scored
as wrong and never left out of n. Accuracy is over the answered items; coverage is answered / n.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

TEMPO_TOLERANCE = 0.04
ACC2_FACTORS = (1.0, 2.0, 3.0, 1.0 / 2.0, 1.0 / 3.0)
BOOTSTRAP_RESAMPLES = 10_000
CI_LEVEL = 0.95

PITCH_CLASS = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "Fb": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
    "Cb": 11,
}


# --- tempo -----------------------------------------------------------------------------------


def within(estimate: float, reference: float, tolerance: float = TEMPO_TOLERANCE) -> bool:
    return abs(estimate - reference) <= tolerance * reference


def acc1(estimate: float, reference: float) -> bool:
    return within(estimate, reference)


def acc2(estimate: float, reference: float) -> bool:
    return any(within(estimate, reference * f) for f in ACC2_FACTORS)


# --- key -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Key:
    tonic: int  # pitch class, C = 0
    mode: str  # "major" or "minor"

    def __str__(self) -> str:
        names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
        return f"{names[self.tonic]} {self.mode}"


def parse_key(tonic: str, mode: str) -> Key:
    tonic = tonic.strip()
    if tonic not in PITCH_CLASS:
        raise ValueError(f"unknown tonic {tonic!r}")
    mode = mode.strip().lower()
    if mode not in ("major", "minor"):
        raise ValueError(f"unknown mode {mode!r}")
    return Key(PITCH_CLASS[tonic], mode)


def mirex_key_score(estimate: Key, reference: Key) -> float:
    interval = (estimate.tonic - reference.tonic) % 12
    if estimate.mode == reference.mode:
        if interval == 0:
            return 1.0
        if interval == 7:
            return 0.5
        return 0.0
    if interval == 0:
        return 0.2  # parallel
    if reference.mode == "major" and interval == 9:
        return 0.3  # relative minor
    if reference.mode == "minor" and interval == 3:
        return 0.3  # relative major
    return 0.0


# --- intervals -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Estimate:
    """A mean with its percentile-bootstrap interval; all None when there is nothing to score."""

    n: int
    mean: float | None
    low: float | None
    high: float | None

    def as_dict(self) -> dict:
        return {"n": self.n, "mean": self.mean, "ciLow": self.low, "ciHigh": self.high}


def bootstrap_mean(
    values: Sequence[float],
    seed: int,
    resamples: int = BOOTSTRAP_RESAMPLES,
    level: float = CI_LEVEL,
) -> Estimate:
    """Mean of `values` and its percentile bootstrap interval, reproducible for a seed."""
    data = np.asarray(values, dtype=float)
    n = int(data.size)
    if n == 0:
        return Estimate(0, None, None, None)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n, size=(resamples, n))
    means = data[idx].mean(axis=1)
    alpha = (1.0 - level) / 2.0
    low, high = np.quantile(means, [alpha, 1.0 - alpha])
    return Estimate(n, float(data.mean()), float(low), float(high))


# --- withheld accounting and coverage --------------------------------------------------------


@dataclass(frozen=True)
class Item:
    """
    One track for one estimator. `scores` maps a metric name to the item's score; it is None
    when the service withheld the answer (or the analysis failed: `failed` is True then).
    """

    track_id: str
    confidence: float | None
    scores: dict[str, float] | None
    failed: bool = False

    @property
    def answered(self) -> bool:
        return self.scores is not None


@dataclass(frozen=True)
class Summary:
    n: int  # every item with audio and a reference
    answered: int
    withheld: int
    failed: int
    metrics: dict[str, Estimate]  # over the answered items

    @property
    def coverage(self) -> float | None:
        return None if self.n == 0 else self.answered / self.n

    def as_dict(self) -> dict:
        return {
            "n": self.n,
            "answered": self.answered,
            "withheld": self.withheld,
            "failed": self.failed,
            "coverage": self.coverage,
            "metrics": {k: v.as_dict() for k, v in self.metrics.items()},
        }


def summarize(items: Sequence[Item], metric_names: Sequence[str], seed: int) -> Summary:
    answered = [i for i in items if i.answered]
    failed = sum(1 for i in items if i.failed)
    withheld = len(items) - len(answered) - failed
    metrics = {
        # One seed per metric (offset by its position) so the intervals do not share draws
        # by accident; the same seed always gives the same interval.
        name: bootstrap_mean([i.scores[name] for i in answered], seed + k)
        for k, name in enumerate(metric_names)
    }
    return Summary(len(items), len(answered), withheld, failed, metrics)


@dataclass(frozen=True)
class CoveragePoint:
    coverage: float  # answered share of all n items at this threshold
    answered: int
    min_confidence: float  # the lowest confidence still answered
    accuracy: dict[str, float]


def coverage_curve(
    items: Sequence[Item],
    metric_names: Sequence[str],
    levels: Sequence[float] = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
) -> list[CoveragePoint]:
    """
    Accuracy when only the most confident answers are kept: answered items sorted by the
    service's confidence (highest first, ties by track id), and for each coverage level the
    accuracy of the top ceil(level * n) items. Coverage is a share of all n items, withheld ones
    included, so levels above the service's own coverage are not reachable and are left out; the
    last point is always every answered item. Items without a confidence are not ranked.
    """
    n = len(items)
    ranked = sorted(
        (i for i in items if i.answered and i.confidence is not None),
        key=lambda i: (-i.confidence, i.track_id),
    )
    if n == 0 or not ranked:
        return []
    counts = sorted({math.ceil(level * n - 1e-9) for level in levels} | {len(ranked)})
    points = []
    for k in counts:
        if k <= 0 or k > len(ranked):
            continue
        top = ranked[:k]
        points.append(
            CoveragePoint(
                coverage=k / n,
                answered=k,
                min_confidence=float(top[-1].confidence),
                accuracy={m: float(np.mean([i.scores[m] for i in top])) for m in metric_names},
            )
        )
    return points

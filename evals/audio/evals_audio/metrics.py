"""
Scores, intervals, the accuracy-vs-coverage curve and the paired comparison.

Tempo (Gouyon et al. 2006): Acc1 is an estimate within 4 % of the reference tempo; Acc2 also
accepts the reference times 2, 3, 1/2 or 1/3 (octave and meter errors), each within 4 %.

Key (MIREX): 1 for the same key, 0.5 for the key a perfect fifth above the reference in the
same mode, 0.3 for the relative key, 0.2 for the parallel key, 0 otherwise (mir_eval's
weighted score with ascending fifths only). Exact accuracy counts only the same key.

Every metric is given two ways:

- **over n**: the share of all n clips for which the service returned a correct value; a clip
  the service withheld counts as no correct value. This answers "how often does a user get a
  right value".
- **over answered**: the share of the returned values that are correct. This answers "how
  often is a value the service shows right". It is conditional on the service choosing to
  answer, so two estimators that answer different clips cannot be ranked by it.

Withheld clips are counted on their own and never dropped. Intervals: Wilson score intervals
for the binary metrics (Acc1, Acc2, exact); a BCa bootstrap for the MIREX score, which is not
binary (no interval when every score is equal).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from scipy import stats

TEMPO_TOLERANCE = 0.04
ACC2_FACTORS = (1.0, 2.0, 3.0, 1.0 / 2.0, 1.0 / 3.0)
BOOTSTRAP_RESAMPLES = 10_000
CI_LEVEL = 0.95
BINARY_METRICS = frozenset({"acc1", "acc2", "exact"})
# Coverage-curve points resting on fewer answered clips than this are left out.
MIN_CURVE_ANSWERED = 10

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
    """
    A mean over n values with its 95 % interval. `total` is the sum of the scores (the number
    correct for a binary metric). `method` names the interval; low/high are None when there is
    nothing to score or no interval can be given (`note` says why).
    """

    n: int
    total: float
    mean: float | None
    low: float | None
    high: float | None
    method: str
    note: str | None = None

    def as_dict(self) -> dict:
        return {
            "n": self.n,
            "total": self.total,
            "mean": self.mean,
            "ciLow": self.low,
            "ciHigh": self.high,
            "method": self.method,
            "note": self.note,
        }


def wilson(k: int, n: int, level: float = CI_LEVEL) -> Estimate:
    """Wilson score interval for k successes in n trials."""
    if n == 0:
        return Estimate(0, 0.0, None, None, None, "Wilson")
    z = float(stats.norm.ppf(0.5 + level / 2))
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return Estimate(n, float(k), p, max(0.0, centre - half), min(1.0, centre + half), "Wilson")


def bca_mean(
    values: Sequence[float],
    seed: int,
    resamples: int = BOOTSTRAP_RESAMPLES,
    level: float = CI_LEVEL,
) -> Estimate:
    """
    Mean of `values` with a bias-corrected and accelerated (BCa) bootstrap interval,
    reproducible for a seed. When every value is equal no interval is given: resampling cannot
    say anything about the spread then.
    """
    # Sorted, so the interval depends on the values only, not on the order they come in (the
    # summary lists clips by id, the coverage curve by confidence).
    data = np.sort(np.asarray(values, dtype=float))
    n = int(data.size)
    if n == 0:
        return Estimate(0, 0.0, None, None, None, "BCa bootstrap")
    mean = float(data.mean())
    if np.all(data == data[0]):
        return Estimate(n, float(data.sum()), mean, None, None, "BCa bootstrap", "all scores equal")
    rng = np.random.default_rng(seed)
    means = data[rng.integers(0, n, size=(resamples, n))].mean(axis=1)
    below = np.mean(means < mean) + 0.5 * np.mean(means == mean)
    z0 = float(stats.norm.ppf(np.clip(below, 1e-9, 1 - 1e-9)))
    jack = (data.sum() - data) / (n - 1)
    d = jack.mean() - jack
    denom = 6.0 * float(np.sum(d**2)) ** 1.5
    accel = float(np.sum(d**3)) / denom if denom > 0 else 0.0
    alphas = []
    for q in ((1 - level) / 2, 1 - (1 - level) / 2):
        zq = float(stats.norm.ppf(q))
        alphas.append(float(stats.norm.cdf(z0 + (z0 + zq) / (1 - accel * (z0 + zq)))))
    low, high = np.quantile(means, alphas)
    return Estimate(n, float(data.sum()), mean, float(low), float(high), "BCa bootstrap")


def estimate(metric: str, values: Sequence[float], seed: int) -> Estimate:
    if metric in BINARY_METRICS:
        return wilson(int(round(sum(values))), len(values))
    return bca_mean(values, seed)


# --- withheld accounting and coverage --------------------------------------------------------


@dataclass(frozen=True)
class Item:
    """
    One clip for one estimator. `scores` maps a metric name to the clip's score; it is None
    when the service withheld the answer (or the analysis failed: `failed` is True then).
    """

    track_id: str
    confidence: float | None
    scores: dict[str, float] | None
    failed: bool = False

    @property
    def answered(self) -> bool:
        return self.scores is not None

    def score(self, metric: str) -> float:
        """The clip's score with a withheld or failed answer counted as not correct."""
        return 0.0 if self.scores is None else self.scores[metric]


@dataclass(frozen=True)
class Summary:
    n: int  # every clip with audio and a usable reference
    answered: int
    withheld: int
    failed: int
    over_n: dict[str, Estimate]  # withheld and failed count as not correct
    over_answered: dict[str, Estimate]

    @property
    def coverage(self) -> float | None:
        return None if self.n == 0 else self.answered / self.n

    def as_dict(self) -> dict:
        return {
            "n": self.n,
            "answered": self.answered,
            "withheld": self.withheld,
            "failed": self.failed,
            "coverage": wilson(self.answered, self.n).as_dict(),
            "overN": {k: v.as_dict() for k, v in self.over_n.items()},
            "overAnswered": {k: v.as_dict() for k, v in self.over_answered.items()},
        }


def answered_seed(seed: int, k: int) -> int:
    """The bootstrap seed for the k-th metric over answered clips (summary and curve alike)."""
    return seed + 100 + k


def summarize(items: Sequence[Item], metric_names: Sequence[str], seed: int) -> Summary:
    answered = [i for i in items if i.answered]
    failed = sum(1 for i in items if i.failed)
    withheld = len(items) - len(answered) - failed
    # One seed per metric and view, so bootstrap draws are not shared by accident; the same
    # seed always gives the same interval.
    over_n = {
        name: estimate(name, [i.score(name) for i in items], seed + k)
        for k, name in enumerate(metric_names)
    }
    over_answered = {
        name: estimate(name, [i.scores[name] for i in answered], answered_seed(seed, k))
        for k, name in enumerate(metric_names)
    }
    return Summary(len(items), len(answered), withheld, failed, over_n, over_answered)


AUC_EXACT_MAX = 200_000  # orderings of correct vs wrong up to which the p-value is exact
AUC_RESAMPLES = 100_000


def ranking_auc(items: Sequence[Item], metric: str, seed: int = 0) -> dict:
    """
    Whether the service's confidence puts correct answers first: over the answered clips with
    a confidence, the chance that a correct one has a higher confidence than a wrong one (the
    area under the ROC curve; 0.5 is random order, ties count half), with a one-sided
    Mann-Whitney permutation p-value against random order. The p-value is exact (every split of
    the clips into correct and wrong) when there are at most AUC_EXACT_MAX splits, and a Monte
    Carlo estimate at a fixed seed otherwise; ties are handled either way. Binary metrics only.
    """
    ranked = [i for i in items if i.answered and i.confidence is not None]
    right = [i.confidence for i in ranked if i.scores[metric] == 1.0]
    wrong = [i.confidence for i in ranked if i.scores[metric] != 1.0]
    out: dict = {"correct": len(right), "wrong": len(wrong), "auc": None, "p": None}
    if right and wrong:
        out["auc"], out["p"], out["pMethod"] = _auc_permutation(right, wrong, seed)
    return out


def _auc_permutation(right: list[float], wrong: list[float], seed: int) -> tuple:
    """AUC from mid-ranks, and its one-sided permutation p-value (see ranking_auc)."""
    ranks = stats.rankdata(np.concatenate([right, wrong]))  # ties get the mean rank
    n1, n2 = len(right), len(wrong)
    total = n1 + n2

    def auc(rank_sums):
        return (rank_sums - n1 * (n1 + 1) / 2) / (n1 * n2)

    observed = float(auc(ranks[:n1].sum()))
    if math.comb(total, n1) <= AUC_EXACT_MAX:
        k = min(n1, n2)
        groups = np.array(list(itertools.combinations(range(total), k)), dtype=int)
        sums = ranks[groups].sum(axis=1)
        if k != n1:  # the combinations picked the wrong answers
            sums = ranks.sum() - sums
        method = "exact permutation"
    else:
        order = np.random.default_rng(seed).random((AUC_RESAMPLES, total)).argsort(axis=1)
        sums = ranks[order[:, :n1]].sum(axis=1)
        method = f"Monte Carlo, {AUC_RESAMPLES:,} permutations"
    p = float(np.mean(auc(sums) >= observed - 1e-12))
    return observed, p, method


@dataclass(frozen=True)
class CoveragePoint:
    coverage: float  # answered share of all n clips at this point
    answered: int
    min_confidence: float | None  # the lowest confidence kept (None: unranked clips included)
    accuracy: dict[str, Estimate]  # over the clips kept


def coverage_curve(
    items: Sequence[Item],
    metric_names: Sequence[str],
    seed: int = 0,
    levels: Sequence[float] = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0),
    min_answered: int = MIN_CURVE_ANSWERED,
) -> tuple[list[CoveragePoint], list[str]]:
    """
    Accuracy when only the most confident answers are kept: answered clips sorted by the
    service's confidence (highest first, ties by track id), and for each coverage level the
    accuracy of the top ceil(level * n) clips, with its interval. Coverage is a share of all n
    clips, withheld ones included, so levels above the service's own coverage are not reachable.
    Answered clips without a confidence cannot be ranked: they come last, and their ids are
    returned with the points. The last point is always every answered clip, with the same
    interval as the summary over answered clips; other points resting on fewer than
    `min_answered` clips are left out.
    """
    n = len(items)
    answered = [i for i in items if i.answered]
    ranked = sorted(
        (i for i in answered if i.confidence is not None),
        key=lambda i: (-i.confidence, i.track_id),
    )
    unranked = sorted((i for i in answered if i.confidence is None), key=lambda i: i.track_id)
    order = ranked + unranked
    unranked_ids = [i.track_id for i in unranked]
    if n == 0 or not order:
        return [], unranked_ids
    counts = {math.ceil(level * n - 1e-9) for level in levels}
    counts = {k for k in counts if 0 < k <= len(ranked) and k >= min_answered}
    counts.add(len(order))
    points = []
    for k in sorted(counts):
        top = order[:k]
        points.append(
            CoveragePoint(
                coverage=k / n,
                answered=k,
                min_confidence=None if k > len(ranked) else float(top[-1].confidence),
                accuracy={
                    m: estimate(m, [i.scores[m] for i in top], answered_seed(seed, j))
                    for j, m in enumerate(metric_names)
                },
            )
        )
    return points, unranked_ids


# --- paired comparison -----------------------------------------------------------------------


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value for b and c discordant pairs."""
    if b + c == 0:
        return 1.0
    return float(min(1.0, 2 * stats.binom.cdf(min(b, c), b + c, 0.5)))


# Paired differences of MIREX scores lie in [-1, 1].
DIFFERENCE_RANGE = 1.0
SIGN_FLIP_EXACT_MAX = 16  # nonzero differences up to which all sign patterns are enumerated
SIGN_FLIP_RESAMPLES = 100_000


def paired_difference_interval(differences: Sequence[float], level: float = CI_LEVEL) -> Estimate:
    """
    Mean paired difference with a t interval whose spread includes two pseudo-differences at
    the ends of the range (-1 and +1, about the mean), in the spirit of the Agresti-Caffo
    interval for two proportions. Paired MIREX differences are mostly zero, and a plain t or
    bootstrap interval then undercovers (a sample of zeros gives a zero-width interval); the
    pseudo-differences keep the spread from collapsing. Coverage was checked by simulation
    from observed difference distributions (see the report's guide).
    """
    d = np.asarray(differences, dtype=float)
    n = int(d.size)
    method = "paired t, ±1 pseudo-differences"
    if n < 2:
        mean = float(d.mean()) if n else None
        return Estimate(n, float(d.sum()), mean, None, None, method, "fewer than two pairs")
    mean = float(d.mean())
    spread = np.concatenate([d - mean, [-DIFFERENCE_RANGE, DIFFERENCE_RANGE]])
    sd = math.sqrt(float(np.sum(spread**2)) / (n + 1))
    half = float(stats.t.ppf(0.5 + level / 2, n - 1)) * sd / math.sqrt(n)
    low = max(-DIFFERENCE_RANGE, mean - half)
    high = min(DIFFERENCE_RANGE, mean + half)
    return Estimate(n, float(d.sum()), mean, low, high, method)


def sign_flip_p(differences: Sequence[float], seed: int) -> tuple[float, str]:
    """
    Two-sided sign-flip permutation p-value for "no difference" (the paired differences are
    symmetric about zero), with the mean as the statistic. Exact over every sign pattern of the
    nonzero differences when there are at most SIGN_FLIP_EXACT_MAX of them; otherwise a Monte
    Carlo estimate from SIGN_FLIP_RESAMPLES random patterns at a fixed seed.
    """
    d = np.asarray([x for x in differences if x != 0], dtype=float)
    k = int(d.size)
    if k == 0:
        return 1.0, "exact"
    observed = abs(float(d.sum()))
    if k <= SIGN_FLIP_EXACT_MAX:
        signs = 1 - 2 * ((np.arange(2**k)[:, None] >> np.arange(k)) & 1)
        method = "exact"
    else:
        signs = np.random.default_rng(seed).choice([-1, 1], size=(SIGN_FLIP_RESAMPLES, k))
        method = f"Monte Carlo, {SIGN_FLIP_RESAMPLES:,} sign patterns"
    sums = np.abs(signs @ d)
    p = float(np.mean(sums >= observed - 1e-12))
    return p, method


def compare(
    first: Sequence[Item],
    second: Sequence[Item],
    metric_names: Sequence[str],
    seed: int,
) -> dict:
    """
    Two estimators on the same clips, two ways:

    - "bothAnswered": only the clips both estimators answered, so each is judged on the same
      clips;
    - "allN": every clip, a withheld answer counted as not correct.

    Binary metrics give each side's correct count, the discordant pairs (right for one only)
    and an exact McNemar p-value. MIREX gives each side's mean, the pairs where one side scores
    higher, the mean paired difference (first minus second) with paired_difference_interval,
    and a sign-flip permutation p-value.
    """
    a_by = {i.track_id: i for i in first}
    b_by = {i.track_id: i for i in second}
    if set(a_by) != set(b_by):
        raise ValueError("the two estimators were not run on the same clips")
    ids = sorted(a_by)
    both = [t for t in ids if a_by[t].answered and b_by[t].answered]
    out = {}
    for label, subset in (("bothAnswered", both), ("allN", ids)):
        block: dict = {"n": len(subset), "metrics": {}}
        for j, m in enumerate(metric_names):
            a = np.array([a_by[t].score(m) for t in subset], dtype=float)
            b = np.array([b_by[t].score(m) for t in subset], dtype=float)
            if m in BINARY_METRICS:
                only_a = int(np.sum((a == 1) & (b == 0)))
                only_b = int(np.sum((a == 0) & (b == 1)))
                block["metrics"][m] = {
                    "firstCorrect": int(a.sum()),
                    "secondCorrect": int(b.sum()),
                    "onlyFirst": only_a,
                    "onlySecond": only_b,
                    "mcnemarP": mcnemar_exact(only_a, only_b),
                }
            else:
                p, p_method = sign_flip_p(list(a - b), seed + j)
                block["metrics"][m] = {
                    "firstMean": float(a.mean()) if subset else None,
                    "secondMean": float(b.mean()) if subset else None,
                    "firstHigher": int(np.sum(a > b)),
                    "secondHigher": int(np.sum(a < b)),
                    "difference": paired_difference_interval(list(a - b)).as_dict(),
                    "signFlipP": p,
                    "signFlipMethod": p_method,
                }
        out[label] = block
    return out

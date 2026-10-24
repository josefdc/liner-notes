"""
Coverage of the paired MIREX difference interval (metrics.paired_difference_interval) next to
a BCa bootstrap, by simulation:

- from the paired key differences in a results file, the observed differences standing in for
  the population (what each paired row of the report also checks);
- over random difference distributions, sparse (mostly zero, as for keys) and dense.

    uv run python scripts/paired_coverage.py [evals/reports/audio-<date>.json] [--draws N]

Deterministic for the same arguments. Prints one line per population; nothing is written.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from evals_audio.metrics import bca_mean, paired_difference_interval

MIREX_VALUES = np.array([0.0, 0.2, 0.3, 0.5, 1.0])


def coverage(pop: np.ndarray, draws: int, rng: np.random.Generator, bca: bool) -> tuple:
    mu, n = float(pop.mean()), int(pop.size)
    hit = hit_bca = 0
    for k in range(draws):
        x = list(rng.choice(pop, n))
        e = paired_difference_interval(x)
        hit += e.low - 1e-12 <= mu <= e.high + 1e-12
        if bca:
            b = bca_mean(x, k, resamples=2_000)
            hit_bca += b.low is not None and b.low - 1e-12 <= mu <= b.high + 1e-12
    return hit / draws, (hit_bca / draws if bca else None)


def from_results(path: Path) -> dict[str, np.ndarray]:
    """The paired MIREX differences (first minus second estimator) of every key run."""
    out = {}
    for run in json.loads(path.read_text())["runs"]:
        paired = run.get("paired")
        if run["suite"] != "key" or not paired:
            continue
        first = {r["trackId"]: r for r in run["tracks"][paired["first"]]}
        second = {r["trackId"]: r for r in run["tracks"][paired["second"]]}

        def score(r):
            return 0.0 if r.get("scores") is None else r["scores"]["mirex"]

        ids = sorted(first)
        both = [t for t in ids if first[t].get("scores") and second[t].get("scores")]
        name = run["dataset"]["name"]
        out[f"{name} both answered"] = np.array([score(first[t]) - score(second[t]) for t in both])
        out[f"{name} all n"] = np.array([score(first[t]) - score(second[t]) for t in ids])
    return out


def random_population(rng: np.random.Generator, n: int, disagree: float) -> np.ndarray:
    """Differences of two MIREX score columns that disagree on about `disagree` of the clips."""
    a = rng.choice(MIREX_VALUES, n)
    b = np.where(rng.random(n) < disagree, rng.choice(MIREX_VALUES, n), a)
    return a - b


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], allow_abbrev=False)
    p.add_argument("results", nargs="?", type=Path)
    p.add_argument("--draws", type=int, default=2_000)
    p.add_argument("--populations", type=int, default=100, help="random ones per n and density")
    args = p.parse_args()
    rng = np.random.default_rng(19)
    if args.results:
        for label, pop in from_results(args.results).items():
            cov, cov_bca = coverage(pop, args.draws, rng, bca=True)
            print(
                f"{label} (n={pop.size}, nonzero={int(np.sum(pop != 0))}): interval {cov:.3f}, "
                f"BCa {cov_bca:.3f}"
            )
    for n in (11, 50, 200):
        for disagree in (0.1, 0.5, 0.9):
            covs = [
                coverage(random_population(rng, n, disagree), args.draws // 4, rng, bca=False)[0]
                for _ in range(args.populations)
            ]
            covs = np.array(covs)
            print(
                f"random n={n:3d}, about {disagree:.0%} of pairs differ: interval coverage "
                f"min {covs.min():.3f}, 5th percentile {np.quantile(covs, 0.05):.3f}, median "
                f"{np.median(covs):.3f}, share under 0.94 {np.mean(covs < 0.94):.3f}"
            )


if __name__ == "__main__":
    main()

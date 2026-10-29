"""
What one key rule costs on its own, on the newest committed report that holds a GiantSteps+ key
run and its key calibration run. The key run's rows say which rule withheld each clip, but
`Signals.key_withheld` gives only the first rule that fires, and the estimate scored for a
withheld clip has every rule and the strength minimum lifted. So "93 of the 132 clips that no
sustained pitch withholds are right with the rules lifted" is the cost of every rule, not of
that one. This script re-derives each such clip from the calibration run's recorded evidence
with only that rule lifted (`evals_audio.calibration`, no audio analysed): how many then get a
key, how many of those are right, and which rule withholds the rest.

    cd evals/audio && uv run python scripts/lifted_rules.py [../reports/audio-<date>.json]

Prints, per estimator and rule (no sustained pitch: the spectral-line share at 0; one harmonic
series: the series test off), the clips whose first reason is that rule and which the strength
minimum does not also withhold (the key run's "only:" rows; most of them are withheld by later
rules too, which the service never asks), their exact keys with every rule lifted, and the same
with that rule alone lifted, with the first of the later rules to fire on the rest. Nothing is
written.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from evals_audio import calibration as cal

REPORTS = Path(__file__).resolve().parents[2] / "reports"
DATASET = "giantsteps-key"
LINES = "no sustained pitch"
SERIES = "one harmonic series"


def newest(path: Path | None) -> tuple[str, dict, dict]:
    """The report's key run and key calibration run (the newest report that holds both)."""
    for p in [path] if path else sorted(REPORTS.glob("audio-*.json"), reverse=True):
        runs = json.loads(p.read_text())["runs"]
        key = [r for r in runs if r["suite"] == "key" and r["dataset"]["name"] == DATASET]
        calib = [r for r in runs if r["suite"] == "calibration" and r["dataset"]["name"] == DATASET]
        if key and calib:
            return p.name, key[0], calib[0]
    raise SystemExit("no report holds a GiantSteps+ key run and its key calibration run")


def first_rule(reason: str) -> str:
    """'one harmonic series on 65.2 Hz' -> 'one harmonic series'."""
    return SERIES if reason.startswith(SERIES) else reason


STRENGTH = "key strength under the minimum"


def reproduce(key_run: dict, calibration_run: dict) -> int:
    """
    Check that the calibration run's recorded evidence gives what the key run recorded, on
    every clip and estimator: served or withheld, the first reason (or the strength minimum
    alone), and the estimate scored with the rules lifted (the calibration run's raw key).
    Returns how many withheld rows with such an estimate were checked.
    """
    rules = cal.Rules.from_dict(calibration_run["rules"])
    clips = {c["trackId"]: c for c in calibration_run["clips"]}
    checked = 0
    for name, rows in key_run["tracks"].items():
        for row in rows:
            clip = clips[row["trackId"]]
            where = (name, row["trackId"])
            derived = cal.derived(clip, name, "key", rules)
            assert (derived is None) == bool(row["withheld"]), where
            unreturned = row.get("unreturned")
            if not row["withheld"] or unreturned is None:  # served, or gated with no estimate
                continue
            reason = cal.evidence_withheld(clip["evidence"], rules, name)
            if reason is None:
                assert unreturned["rules"] == [STRENGTH], where
            else:
                assert first_rule(unreturned["rules"][0]) == first_rule(reason), where
            raw = clip["estimators"][name]["key"]["raw"]
            assert unreturned["estimate"] == f"{raw['tonic']} {raw['mode']}", where
            checked += 1
    return checked


def costs(key_run: dict, calibration_run: dict) -> dict:
    """
    {estimator: {rule: {"clips", "rightAllLifted", "served", "servedRight", "stillWithheld"}}}
    for the clips whose first reason in the key run is `rule` and which the strength minimum
    does not also withhold (the report's "only:" rows). The service asks no rule after the
    first, so most of these clips are withheld by later rules too: "stillWithheld" counts, with
    `rule` alone lifted, the first of those to fire.
    """
    # The derivation must give what the service served before it says what a lift gives.
    reproduce(key_run, calibration_run)
    rules = cal.Rules.from_dict(calibration_run["rules"])
    clips = {c["trackId"]: c for c in calibration_run["clips"]}
    out: dict = {}
    for name, rows in key_run["tracks"].items():
        out[name] = {}
        for rule in (LINES, SERIES):
            ids = [
                row["trackId"]
                for row in rows
                if row["withheld"]
                and row.get("unreturned")
                and [first_rule(r) for r in row["unreturned"]["rules"]] == [rule]
            ]
            right_all = sum(
                row["unreturned"]["scores"]["exact"] == 1 for row in rows if row["trackId"] in ids
            )
            served = right = 0
            still: Counter = Counter()
            for tid in ids:
                clip = clips[tid]
                if rule == LINES:
                    lifted, lifted_rules = clip, rules.set("min_tonal_ratio", 0.0)
                else:
                    evidence = {**clip["evidence"], "series": False}
                    lifted, lifted_rules = {**clip, "evidence": evidence}, rules
                key = cal.derived(lifted, name, "key", lifted_rules)
                if key is None:
                    reason = cal.evidence_withheld(lifted["evidence"], lifted_rules, name)
                    still[first_rule(reason) if reason else STRENGTH] += 1
                    continue
                served += 1
                right += clip["estimators"][name]["key"]["raw"]["scores"]["exact"] == 1
            out[name][rule] = {
                "clips": len(ids),
                "rightAllLifted": right_all,
                "served": served,
                "servedRight": right,
                "stillWithheld": dict(still.most_common()),
            }
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("results", nargs="?", type=Path)
    args = p.parse_args()
    name, key_run, calibration_run = newest(args.results)
    print(
        f"{name}: key run on commit {key_run['gitCommit']}, calibration run on commit "
        f"{calibration_run['gitCommit']}, analyzer {calibration_run['analyzerVersion']}"
    )
    for estimator, by_rule in costs(key_run, calibration_run).items():
        for rule, c in by_rule.items():
            still = ", ".join(f"{k} {v}" for k, v in c["stillWithheld"].items()) or "none"
            print(
                f"{estimator}, {rule} the first reason, no strength minimum: {c['clips']} clips, "
                f"{c['rightAllLifted']} exact with every rule and the strength minimum lifted; "
                f"with this rule alone lifted {c['served']} get a key, {c['servedRight']} "
                f"exact; still withheld, by the first later rule to fire: {still}"
            )


if __name__ == "__main__":
    main()

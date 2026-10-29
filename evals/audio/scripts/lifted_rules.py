"""
What one key rule costs on its own, on the newest committed report that holds a GiantSteps+ key
run and its key calibration run. The key run's rows say which rule withheld each clip, but
`Signals.key_withheld` gives only the first rule that fires, and the estimate scored for a
withheld clip has every rule and the strength minimum lifted. So "93 of the 132 clips that no
sustained pitch withholds are right with the rules lifted" is the cost of every rule, not of
that one. This script re-derives each such clip from the calibration run's recorded evidence
with only that rule lifted (`evals_audio.calibration`, no audio analysed): how many then get a
key, how many of those are right, and which rule withholds the rest.

    uv run python scripts/lifted_rules.py [evals/reports/audio-<date>.json]

Prints, per estimator and rule (no sustained pitch: the spectral-line share at 0; one harmonic
series: the series test off), the clips for which that rule is the reason given and no other
withholds them (the key run's "only:" rows), their exact keys with every rule lifted, and the
same with that rule alone lifted. Nothing is written.
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


def costs(key_run: dict, calibration_run: dict) -> dict:
    """
    {estimator: {rule: {"clips", "rightAllLifted", "served", "servedRight", "stillWithheld"}}}
    for the clips the key run withheld for `rule` alone (no other rule and no strength minimum).
    """
    rules = cal.Rules.from_dict(calibration_run["rules"])
    clips = {c["trackId"]: c for c in calibration_run["clips"]}
    out: dict = {}
    for name, rows in key_run["tracks"].items():
        # The derivation must give what the service served before it says what a lift gives.
        for row in rows:
            derived = cal.derived(clips[row["trackId"]], name, "key", rules)
            assert (derived is None) == bool(row["withheld"]), (name, row["trackId"])
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
                    still[first_rule(reason) if reason else "key strength under the minimum"] += 1
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
                f"{estimator}, {rule} the only reason given: {c['clips']} clips, "
                f"{c['rightAllLifted']} exact with every rule and the strength minimum lifted; "
                f"with this rule alone lifted {c['served']} get a key, {c['servedRight']} "
                f"exact; still withheld: {still}"
            )


if __name__ == "__main__":
    main()

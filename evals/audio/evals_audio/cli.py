"""
uv run python -m evals_audio --suite tempo|key [--dataset NAME] [--limit N]
                             [--estimator librosa|essentia|all] [--seed S] [--jobs J]

Fetches the selected tracks (storage.py caps the data directory), runs the service on a
30-second clip of each, prints the accuracy per estimator with n and 95 % intervals, and
writes evals/reports/audio-<date>.md and .json.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import platform
import shlex
import subprocess
import sys
import time
from collections import Counter
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from . import clips, datasets, report, runner, service
from .metrics import coverage_curve, summarize
from .storage import DataCapExceeded, DiskBudget, cap_bytes, data_dir, disk_usage, human

DEFAULT_SEED = 1
REPORT_DIR = service.REPO_ROOT / "evals" / "reports"

logger = logging.getLogger("evals_audio")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m evals_audio", description=__doc__.split("\n\n")[1])
    p.add_argument("--suite", choices=sorted(datasets.SUITE_DATASETS))
    p.add_argument("--dataset", choices=sorted(datasets.DATASETS))
    p.add_argument("--limit", type=int, help="tracks to draw at the seed (default: all usable)")
    p.add_argument("--estimator", default="all", choices=[*service.ESTIMATOR_NAMES, "all"])
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--jobs", type=int, default=runner.MAX_JOBS, help="worker processes (max 4)")
    p.add_argument(
        "--data-dir", help="dataset directory (default: $LINER_NOTES_DATA or ~/liner-notes-data)"
    )
    p.add_argument("--report-dir", type=Path, default=REPORT_DIR)
    p.add_argument("--no-report", action="store_true", help="print only; write no report")
    p.add_argument("--verbose", action="store_true")
    p.add_argument(
        "--render",
        type=Path,
        metavar="JSON",
        help="only render the Markdown report again from an audio-<date>.json results file",
    )
    args = p.parse_args(argv)
    if args.render is not None:
        return args
    if args.suite is None:
        p.error("--suite is required (or --render JSON)")
    if args.dataset is None:
        args.dataset = datasets.SUITE_DATASETS[args.suite][0]
    if args.dataset not in datasets.SUITE_DATASETS[args.suite]:
        p.error(
            f"--dataset {args.dataset} has no {args.suite} labels; "
            f"use one of {', '.join(datasets.SUITE_DATASETS[args.suite])}"
        )
    if args.limit is not None and args.limit <= 0:
        p.error("--limit must be positive")
    return args


def git_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(service.REPO_ROOT), "describe", "--always", "--dirty", "--abbrev=7"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def environment(names: list[str]) -> dict[str, str]:
    env = {"python": platform.python_version()}
    packages = ["librosa", "numpy", "mirdata"]
    if "essentia" in names:
        packages.append("essentia-tensorflow")
    for package in packages:
        try:
            env[package] = version(package)
        except PackageNotFoundError:
            env[package] = "not installed"
    return env


def print_summary(suite: str, dataset: str, summaries: dict) -> None:
    metrics = runner.METRICS[suite]
    print(f"\n{suite} on {dataset}")
    head = f"{'estimator':<10} {'n':>4} {'answered':>8} {'withheld':>8} {'failed':>6}"
    for m in metrics:
        head += f"  {runner.METRIC_LABELS[m] + ' [95% CI]':<24}"
    print(head)
    for name, s in summaries.items():
        line = f"{name:<10} {s.n:>4} {s.answered:>8} {s.withheld:>8} {s.failed:>6}"
        for m in metrics:
            e = s.metrics[m]
            cell = (
                "-"
                if e.mean is None
                else f"{100 * e.mean:5.1f}% [{100 * e.low:5.1f}, {100 * e.high:5.1f}]"
            )
            line += f"  {cell:<24}"
        print(line)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = parse_args(argv)
    if args.render is not None:
        print(f"report: {report.rerender(args.render)}")
        return 0
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    started = time.monotonic()
    started_at = dt.datetime.now(dt.UTC).replace(microsecond=0)
    names = list(service.ESTIMATOR_NAMES) if args.estimator == "all" else [args.estimator]
    try:
        for name in names:
            service.estimator(name)
    except service.EstimatorUnavailable as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    spec = datasets.DATASETS[args.dataset]
    root = data_dir(args.data_dir)
    home = root / spec.mirdata_name
    budget = DiskBudget(root, cap_bytes())
    try:
        datasets.ensure_annotations(spec, home, budget)
        refs = datasets.references(spec, home)
        selected = datasets.select(refs, args.limit, args.seed)
        present, fetched = datasets.ensure_audio(spec, home, selected, budget)
    except DataCapExceeded as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    unavailable = [r.track_id for r in selected if r.track_id not in present]
    if not present:
        print(
            f"error: no audio could be fetched for {spec.name} "
            f"({len(selected)} tracks tried); nothing to measure",
            file=sys.stderr,
        )
        return 3
    if unavailable:
        print(f"warning: audio unavailable for {len(unavailable)} tracks: {unavailable}")

    measured = [r for r in selected if r.track_id in present]
    by_id = {r.track_id: r for r in measured}
    tasks = [
        (spec.name, r.track_id, str(home / r.audio_rel), args.seed, tuple(names)) for r in measured
    ]

    def progress(k: int, total: int) -> None:
        if k == total or k % 10 == 0:
            print(f"  analysed {k}/{total}", file=sys.stderr)

    analysed = runner.analyze_all(tasks, args.jobs, progress)
    metric_names = runner.METRICS[args.suite]
    summaries, curves, tracks = {}, {}, {}
    for name in names:
        items, rows = runner.items_for(args.suite, by_id, analysed, name)
        summaries[name] = summarize(items, metric_names, args.seed)
        curves[name] = coverage_curve(items, metric_names)
        tracks[name] = rows
    print_summary(args.suite, spec.name, summaries)

    usage = disk_usage(root)
    print(f"\ndata directory {root}: {human(usage)} (cap {human(budget.cap)})")
    if args.no_report:
        return 0

    windows = {a["trackId"]: a.get("window") for a in analysed}
    excluded = Counter(r.excluded for r in refs if r.excluded)
    command = "uv run python -m evals_audio " + " ".join(shlex.quote(a) for a in argv)
    run = {
        "suite": args.suite,
        "command": command,
        "startedAt": started_at.isoformat().replace("+00:00", "Z"),
        "wallSeconds": round(time.monotonic() - started, 1),
        "jobs": max(1, min(args.jobs, runner.MAX_JOBS)),
        "seed": args.seed,
        "limit": args.limit,
        "selection": (
            f"{len(selected)} of {sum(1 for r in refs if r.excluded is None)} usable tracks "
            f"drawn with numpy default_rng({args.seed})"
        ),
        "clipSeconds": clips.CLIP_SECONDS,
        "gitCommit": git_commit(),
        "analyzerVersion": service.base_version(),
        "analyzerVersions": service.analyzer_versions(names),
        "environment": environment(names),
        "dataUsageBytes": usage,
        "dataCapBytes": budget.cap,
        "dataset": {
            "name": spec.name,
            "mirdataName": spec.mirdata_name,
            "title": spec.title,
            "licence": spec.licence,
            "licenceSource": spec.licence_source,
            "sources": [list(s) for s in spec.sources],
            "referenceNote": spec.reference_note,
            "notes": list(spec.notes),
            "tracksInIndex": len(refs),
            "usable": sum(1 for r in refs if r.excluded is None),
            "excluded": dict(excluded),
            "selected": len(selected),
            "audioPresent": len(measured),
            "audioUnavailable": unavailable,
            "audioSources": dict(Counter(fetched.values())),
        },
        "summaries": {name: s.as_dict() for name, s in summaries.items()},
        "coverage": {
            name: [
                {
                    "coverage": p.coverage,
                    "answered": p.answered,
                    "minConfidence": p.min_confidence,
                    "accuracy": p.accuracy,
                }
                for p in points
            ]
            for name, points in curves.items()
        },
        "clips": [
            {
                "trackId": r.track_id,
                "reference": runner.reference_text(r.value),
                "audio": r.audio_rel,
                "window": windows.get(r.track_id),
            }
            for r in measured
        ],
        "tracks": tracks,
    }
    date = started_at.date().isoformat()
    md_path, json_path = report.write(args.report_dir, date, run)
    print(f"report: {md_path}\nresults: {json_path}")
    return 0

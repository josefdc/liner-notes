"""
uv run python -m evals_audio --suite tempo|key|golden|cost [--dataset NAME] [--limit N]
                             [--estimator librosa|essentia|beat-this|all] [--seed S] [--jobs J]

Fetches the selected tracks (storage.py caps the data directory), runs the service on a
30-second clip of each, prints coverage and accuracy per estimator (over all n clips and over
the answered ones, with 95 % intervals), and writes evals/reports/audio-<date>.md and .json.
The golden suite runs the service on the golden set's Deezer previews (agreement with Deezer's
bpm and the sheet-music labels, style hit@k against Discogs); the cost suite measures each
tempo estimator's memory, time and install size.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import platform
import shlex
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import zipfile
from collections import Counter
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import httpx

from . import beatthis, clips, costs, datasets, golden, report, runner, service
from .metrics import (
    BINARY_METRICS,
    acc1,
    coverage_curve,
    ranking_auc,
    summarize,
)
from .storage import (
    DataCapExceeded,
    DataDirBusy,
    DiskBudget,
    SettingError,
    cap_bytes,
    check_outside,
    data_dir,
    disk_usage,
    exclusive,
    human,
)

DEFAULT_SEED = 1
REPORT_DIR = service.REPO_ROOT / "evals" / "reports"

logger = logging.getLogger("evals_audio")


def parse_args(argv: list[str]) -> argparse.Namespace:
    # No abbreviated options: a prefix of --data-dir or --report-dir would slip past the
    # filter that keeps local paths out of the recorded command.
    p = argparse.ArgumentParser(
        prog="python -m evals_audio", description=__doc__.split("\n\n")[1], allow_abbrev=False
    )
    p.add_argument("--suite", choices=sorted(datasets.SUITE_DATASETS))
    p.add_argument("--dataset", choices=sorted([*datasets.DATASETS, "golden"]))
    p.add_argument("--limit", type=int, help="tracks to draw at the seed (default: all usable)")
    p.add_argument("--estimator", default="all", choices=[*service.ESTIMATOR_NAMES, "all"])
    p.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help="default for the three seeds below (default: %(default)s)",
    )
    p.add_argument("--selection-seed", type=int, help="which tracks are drawn")
    p.add_argument("--clip-seed", type=int, help="where each 30 s window starts")
    p.add_argument("--bootstrap-seed", type=int, help="the bootstrap draws (MIREX intervals)")
    p.add_argument("--jobs", type=int, default=runner.MAX_JOBS, help="worker processes (max 4)")
    p.add_argument(
        "--data-dir", help="dataset directory (default: $LINER_NOTES_DATA or ~/liner-notes-data)"
    )
    p.add_argument("--report-dir", type=Path, default=REPORT_DIR)
    p.add_argument("--no-report", action="store_true", help="print only; write no report")
    p.add_argument("--verbose", action="store_true")
    p.add_argument(
        "--lookup",
        metavar="ID",
        help="print the dataset's own track id for an id in the results (needs --dataset and "
        "the local annotations)",
    )
    p.add_argument(
        "--render",
        type=Path,
        metavar="JSON",
        help="only render the Markdown report again from an audio-<date>.json results file",
    )
    args = p.parse_args(argv)
    if args.render is not None:
        return args
    if args.lookup is not None:
        if args.dataset is None or args.dataset not in datasets.DATASETS:
            p.error("--lookup needs --dataset with an annotated dataset")
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
    if args.estimator != "all" and args.estimator not in service.SUITE_ESTIMATORS[args.suite]:
        p.error(f"the {args.suite} suite does not run {args.estimator}")
    for name in ("selection_seed", "clip_seed", "bootstrap_seed"):
        if getattr(args, name) is None:
            setattr(args, name, args.seed)
    return args


def lookup(args) -> int:
    """Map an id from the results back to the dataset's track id, from the local index."""
    spec = datasets.DATASETS[args.dataset]
    home = data_dir(args.data_dir) / spec.mirdata_name
    if not (home / ".annotations-complete").exists():
        print(f"error: no {spec.name} annotations in {home}; run a suite first", file=sys.stderr)
        return 2
    found = datasets.lookup(spec, datasets.references(spec, home), args.lookup)
    if not found:
        print(f"error: no {spec.name} track has the id {args.lookup}", file=sys.stderr)
        return 1
    print("\n".join(found))
    return 0


# Options whose values are local paths: left out of the command recorded in the report.
LOCAL_PATH_OPTIONS = ("--data-dir", "--report-dir")


def recorded_command(argv: list[str]) -> str:
    """The command line for the report, without options that name local paths."""
    kept: list[str] = []
    skip = False
    for arg in argv:
        if skip:
            skip = False
            continue
        if arg in LOCAL_PATH_OPTIONS:
            skip = True
            continue
        if arg.startswith(tuple(f"{o}=" for o in LOCAL_PATH_OPTIONS)):
            continue
        kept.append(arg)
    return " ".join(["uv run python -m evals_audio", *(shlex.quote(a) for a in kept)])


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
    packages = ["librosa", "numpy", "scipy", "mirdata"]
    if "essentia" in names:
        packages.append("essentia-tensorflow")
    if "beat-this" in names:
        packages += ["beat-this", "torch"]
    for package in packages:
        try:
            env[package] = version(package)
        except PackageNotFoundError:
            env[package] = "not installed"
    return env


def cell(e) -> str:
    """'28/50 56.0% [42.3, 68.8]' (MIREX totals with one decimal)."""
    if e.mean is None:
        return "-"
    total = f"{e.total:g}" if float(e.total).is_integer() else f"{e.total:.1f}"
    interval = "" if e.low is None else f" [{100 * e.low:.1f}, {100 * e.high:.1f}]"
    return f"{total}/{e.n} {100 * e.mean:.1f}%{interval}"


def print_summary(suite: str, dataset: str, summaries: dict) -> None:
    metrics = runner.METRICS[suite]
    print(f"\n{suite} on {dataset}: coverage, then correct / n (withheld = no correct value),")
    print("then correct / answered (how often a returned value is right); 95% intervals")
    for name, s in summaries.items():
        cov = 100 * (s.coverage or 0.0)
        print(
            f"{name:<9} n={s.n} answered={s.answered} ({cov:.0f}%) withheld={s.withheld} "
            f"failed={s.failed}"
        )
        for m in metrics:
            label = runner.METRIC_LABELS[m]
            print(
                f"  {label:<6} over n: {cell(s.over_n[m]):<28} "
                f"over answered: {cell(s.over_answered[m])}"
            )


def source_counts(refs: dict, sources: dict[str, str]) -> dict[str, int]:
    """Where the measured files came from, with each file's own name folded into <file>."""
    counts: Counter = Counter()
    for tid, url in sources.items():
        name = os.path.basename(refs[tid].audio_rel)
        counts[url[: -len(name)] + "<file>" if url.endswith(name) else url] += 1
    return dict(counts)


def reference_stats(spec, by_id: dict, tracks: dict) -> dict | None:
    """GiantSteps Tempo only: how fragile the v2 reference is, and Acc1 against v1 instead."""
    if spec.name != "giantsteps-tempo":
        return None
    measured = list(by_id.values())
    n = len(measured)
    v1 = {tid: r.details.get("v1") for tid, r in by_id.items()}
    differ = sum(
        1 for tid, r in by_id.items() if v1[tid] is not None and not acc1(v1[tid], r.value)
    )
    against_v1 = {}
    for name, rows in tracks.items():
        hits = sum(
            1
            for row in rows
            if not row.get("withheld")
            and not row.get("failed")
            and v1[row["trackId"]] is not None
            and acc1(float(row["estimate"]), v1[row["trackId"]])
        )
        against_v1[name] = hits
    return {
        "n": n,
        "v1Missing": sum(1 for t in v1.values() if t is None),
        "v1DiffersOver4pct": differ,
        "severalCrowdTempi": sum(1 for r in measured if r.details.get("crowdTempi", 1) > 1),
        "nearTies": sum(1 for r in measured if r.details.get("topGap", 1.0) < 0.2),
        "acc1CorrectAgainstV1": against_v1,
    }


def stop_on_sigterm(signum, frame) -> None:
    """SIGTERM unwinds like Ctrl-C, so temporary directories (the previews) are removed."""
    raise SystemExit(143)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    signal.signal(signal.SIGTERM, stop_on_sigterm)
    args = parse_args(argv)
    if args.render is not None:
        print(f"report: {report.rerender(args.render)}")
        return 0
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    if args.lookup is not None:
        return lookup(args)
    if args.estimator == "all":
        names = list(service.SUITE_ESTIMATORS[args.suite])
    else:
        names = [args.estimator]
    try:
        for name in names:
            service.check_estimator(name)
        root = data_dir(args.data_dir)
        check_outside(root, service.REPO_ROOT)
        budget = DiskBudget(root, cap_bytes())
        with exclusive(root):
            if "beat-this" in names:
                os.environ[beatthis.CHECKPOINT_ENV] = str(fetch_checkpoint(root, budget))
            if args.suite == "golden":
                return run_golden(args, argv, names, root, budget)
            if args.suite == "cost":
                return run_cost(args, argv, names, root, budget)
            return run(args, argv, names, root, budget)
    except (
        service.EstimatorUnavailable,
        beatthis.Unavailable,
        golden.ModelsUnavailable,
        SettingError,
        DataCapExceeded,
        DataDirBusy,
        report.OlderResults,
    ) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except DownloadFailed as e:
        print(
            f"error: a download failed ({e}); files already verified are kept, run the same "
            "command again to continue",
            file=sys.stderr,
        )
        return 4
    except OSError as e:
        print(
            f"error: a local file could not be read or written ({type(e).__name__}: {e})",
            file=sys.stderr,
        )
        return 5


class DownloadFailed(RuntimeError):
    """Fetching annotations or audio failed on the network side."""


# What a failed download raises: httpx (the harness's own fetches), urllib (mirdata's), and a
# stream or archive cut short. Local errors (a full disk, a directory that cannot be written)
# are other OSErrors and are reported as such.
DOWNLOAD_ERRORS = (
    httpx.HTTPError,
    datasets.DownloadError,
    urllib.error.URLError,
    ConnectionError,
    TimeoutError,
    tarfile.TarError,
    zipfile.BadZipFile,
    EOFError,
)


def trained_on_dataset(names: list[str], dataset: str) -> list[str]:
    """The estimators of a run whose model was trained on `dataset` (shown, never compared)."""
    return [n for n in names if n == "beat-this" and dataset in beatthis.TRAINED_ON]


def without_training_songs(values: dict) -> dict:
    """Golden values without the songs beat-this was trained on (beatthis.GOLDEN_IN_TRAINING)."""
    return {i: v for i, v in values.items() if i not in beatthis.GOLDEN_IN_TRAINING}


def fetch_checkpoint(root: Path, budget: DiskBudget) -> Path:
    """beat-this's checkpoint in the data directory; network failures as DownloadFailed."""
    try:
        return beatthis.ensure_checkpoint(root, budget)
    except DOWNLOAD_ERRORS as e:
        raise DownloadFailed(f"{type(e).__name__}: {e}") from e


def fetch(spec, home: Path, args, budget: DiskBudget):
    """Annotations, references, the selection and its audio; network failures as DownloadFailed."""
    try:
        datasets.ensure_annotations(spec, home, budget)
        refs = datasets.references(spec, home)
        selected = datasets.select(refs, args.limit, args.selection_seed)
        present, fetched = datasets.ensure_audio(spec, home, selected, budget)
    except DOWNLOAD_ERRORS as e:
        raise DownloadFailed(f"{type(e).__name__}: {e}") from e
    return refs, selected, present, fetched


def run(args, argv: list[str], names: list[str], root: Path, budget: DiskBudget) -> int:
    started = time.monotonic()
    started_at = dt.datetime.now(dt.UTC).replace(microsecond=0)
    if not args.no_report:
        # Refuse an older results file for the date now, not after the analysis.
        report.load(args.report_dir / f"audio-{started_at.date().isoformat()}.json")
    spec = datasets.DATASETS[args.dataset]
    home = root / spec.mirdata_name
    refs, selected, present, fetched = fetch(spec, home, args, budget)
    pid = datasets.public_ids(spec, refs)
    unavailable = [pid[r.track_id] for r in selected if r.track_id not in present]
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
    # From here on tracks go by their public id (datasets.public_id); the clip window still
    # comes from the dataset's own id, so it is the same as before.
    by_id = {pid[r.track_id]: r for r in measured}
    tasks = [
        (spec.name, r.track_id, str(home / r.audio_rel), args.clip_seed, tuple(names))
        for r in measured
    ]

    def progress(k: int, total: int) -> None:
        if k == total or k % 10 == 0:
            print(f"  analysed {k}/{total}", file=sys.stderr)

    analysed = [
        {**a, "trackId": pid[a["trackId"]]} for a in runner.analyze_all(tasks, args.jobs, progress)
    ]
    metric_names = runner.METRICS[args.suite]
    items, summaries, curves, tracks, withheld = {}, {}, {}, {}, {}
    for name in names:
        items[name], tracks[name] = runner.items_for(args.suite, by_id, analysed, name)
        summaries[name] = summarize(items[name], metric_names, args.bootstrap_seed)
        withheld[name] = runner.withheld_cost(tracks[name], metric_names, args.bootstrap_seed)
        points, unranked = coverage_curve(items[name], metric_names, args.bootstrap_seed)
        curves[name] = {
            "points": [
                {
                    "coverage": p.coverage,
                    "answered": p.answered,
                    "minConfidence": p.min_confidence,
                    "accuracy": {m: e.as_dict() for m, e in p.accuracy.items()},
                }
                for p in points
            ],
            "unranked": unranked,
            "ranking": {
                m: ranking_auc(items[name], m, args.bootstrap_seed)
                for m in metric_names
                if m in BINARY_METRICS
            },
        }
    print_summary(args.suite, spec.name, summaries)
    paired = runner.compare_pairs(items, names, metric_names, args.bootstrap_seed)
    trained_on = trained_on_dataset(names, spec.name)
    lifted = (
        runner.lifted_views(tracks, names, metric_names, args.bootstrap_seed)
        if args.suite == "tempo" and len(names) > 1
        else {}
    )

    usage = disk_usage(root)
    print(f"\ndata directory {root}: {human(usage)} (cap {human(budget.cap)})")
    if args.no_report:
        return 0

    windows = {a["trackId"]: a.get("window") for a in analysed}
    excluded = Counter(r.excluded for r in refs if r.excluded)
    command = recorded_command(argv)
    usable = sum(1 for r in refs if r.excluded is None)
    run_doc = {
        "suite": args.suite,
        "command": command,
        "startedAt": started_at.isoformat().replace("+00:00", "Z"),
        "wallSeconds": round(time.monotonic() - started, 1),
        "jobs": max(1, min(args.jobs, runner.MAX_JOBS)),
        "seeds": {
            "selection": args.selection_seed,
            "clips": args.clip_seed,
            "bootstrap": args.bootstrap_seed,
        },
        "limit": args.limit,
        "selection": (
            f"{len(selected)} of {usable} usable tracks drawn with numpy "
            f"default_rng({args.selection_seed})"
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
            "annotationLicence": spec.annotation_licence,
            "audioRights": spec.audio_rights,
            "credits": list(spec.credits),
            "sources": [list(s) for s in spec.sources],
            "referenceNote": spec.reference_note,
            "referenceStats": reference_stats(spec, by_id, tracks),
            "notes": list(spec.notes),
            "tracksInIndex": len(refs),
            "usable": usable,
            "excluded": dict(excluded),
            "selected": len(selected),
            "audioPresent": len(measured),
            "audioUnavailable": unavailable,
            "audioSources": source_counts({r.track_id: r for r in measured}, fetched),
        },
        "estimators": names,
        # Estimators whose model was trained on this dataset: shown, never compared.
        "trainedOn": trained_on,
        "estimatorNotes": [beatthis.TRAINING_DATA_NOTE] if trained_on else [],
        "serviceDefault": service.default_estimator(),
        "estimatorCredits": [beatthis.REFERENCE] if "beat-this" in names else [],
        # The same comparison with withholding rules lifted (calibration, never served).
        "lifted": lifted,
        "summaries": {name: s.as_dict() for name, s in summaries.items()},
        "paired": paired,
        "withheldCost": withheld,
        "coverage": curves,
        # Track ids and where each clip was cut; the reference labels and the audio file
        # names stay in the local data directory.
        "clips": [{"trackId": t, "window": windows.get(t)} for t in by_id],
        "tracks": tracks,
    }
    date = started_at.date().isoformat()
    md_path, json_path = report.write(args.report_dir, date, run_doc)
    print(f"report: {md_path}\nresults: {json_path}")
    return 0


def common_fields(args, argv, names, started, started_at, root, budget) -> dict:
    """The fields every run records: how it was run, on what code, with what libraries."""
    return {
        "suite": args.suite,
        "command": recorded_command(argv),
        "startedAt": started_at.isoformat().replace("+00:00", "Z"),
        "wallSeconds": round(time.monotonic() - started, 1),
        "seeds": {
            "selection": args.selection_seed,
            "clips": args.clip_seed,
            "bootstrap": args.bootstrap_seed,
        },
        "limit": args.limit,
        "gitCommit": git_commit(),
        "analyzerVersion": service.base_version(),
        "estimators": names,
        "environment": environment(names),
        "dataUsageBytes": disk_usage(root),
        "dataCapBytes": budget.cap,
    }


def print_agreement(title: str, block: dict) -> None:
    print(f"\n{title}: n={block['n']}; agrees over n, then over answered (95% Wilson)")
    for name, s in block["summaries"].items():
        parts = []
        for m in ("acc1", "acc2", "exact"):
            if m in s["overN"]:
                over_n, over_answered = s["overN"][m], s["overAnswered"][m]
                parts.append(
                    f"{runner.METRIC_LABELS[m]} {report.frac(over_n)} | {report.frac(over_answered)}"
                )
        print(f"  {name:<9} answered {s['answered']}/{s['n']}: " + "; ".join(parts))


def run_golden(args, argv: list[str], names: list[str], root: Path, budget: DiskBudget) -> int:
    started = time.monotonic()
    started_at = dt.datetime.now(dt.UTC).replace(microsecond=0)
    today = started_at.date().isoformat()
    if not args.no_report:
        report.load(args.report_dir / f"audio-{today}.json")
    rows = golden.read_rows()
    selected = golden.select(rows, args.limit, args.selection_seed)
    try:
        models = golden.ensure_models(root, budget)
        labels = golden.ensure_labels(
            selected, root / "golden", lambda: golden.Paced(golden.client()), today
        )
    except DOWNLOAD_ERRORS as e:
        raise DownloadFailed(f"{type(e).__name__}: {e}") from e
    if not service.load_models(str(models)):
        raise golden.ModelsUnavailable(f"the fingerprint models in {models} did not load")
    key_names = [n for n in names if n in service.SUITE_ESTIMATORS["key"]]

    def progress(k: int, total: int) -> None:
        if k == total or k % 10 == 0:
            print(f"  analysed {k}/{total}", file=sys.stderr)

    # Previews live only in this temporary directory (the system's, never the data
    # directory), for this run; it is removed on success, error, Ctrl-C and SIGTERM.
    with tempfile.TemporaryDirectory(prefix=PREVIEW_DIR_PREFIX) as tmp:
        if Path(tmp).resolve().is_relative_to(root):
            raise SettingError(f"the temporary directory {tmp} is inside the data directory")
        previews = {}
        try:
            with golden.client() as http:
                paced = golden.Paced(http)
                for row in selected:
                    previews[row.isrc] = golden.fetch_preview(paced, row, Path(tmp))
        except DOWNLOAD_ERRORS as e:
            # The type only: a message can carry a signed preview URL.
            raise DownloadFailed(type(e).__name__) from e
        tasks = [
            ("golden", row.isrc, previews[row.isrc]["path"], 0, tuple(names), GOLDEN_OPTIONS)
            for row in selected
            if previews[row.isrc]["path"]
        ]
        if not tasks:
            print("error: no Deezer preview could be fetched; nothing to measure", file=sys.stderr)
            return 3
        analysed = runner.analyze_all(tasks, args.jobs, progress, models_dir=str(models))
    by_isrc = {row.isrc: row for row in selected}
    deezer_bpm = {isrc: p["bpm"] for isrc, p in previews.items()}
    blocks = {
        "deezer-bpm": golden.agreement("tempo", deezer_bpm, analysed, names, args.bootstrap_seed),
        "sheet-music-bpm": golden.agreement(
            "tempo", {i: r.bpm for i, r in by_isrc.items()}, analysed, names, args.bootstrap_seed
        ),
        "sheet-music-key": golden.agreement(
            "key", {i: r.key for i, r in by_isrc.items()}, analysed, key_names, args.bootstrap_seed
        ),
    }
    # beat-this was trained on some of these songs: the same comparison without them, for
    # every estimator, so the pairs stay on the same tracks.
    seen = {i: v for i, v in beatthis.GOLDEN_IN_TRAINING.items() if i in by_isrc}
    if "beat-this" in names:
        blocks["deezer-bpm-unseen"] = golden.agreement(
            "tempo",
            without_training_songs(deezer_bpm),
            analysed,
            names,
            args.bootstrap_seed,
        )
    service.load()  # services/audio is on sys.path from here
    from model_labels import DISCOGS_STYLES

    styles = golden.styles_table(analysed, labels, DISCOGS_STYLES)
    print_agreement("tempo agreement with Deezer's bpm", blocks["deezer-bpm"])
    if "deezer-bpm-unseen" in blocks:
        print_agreement(
            "the same without the songs beat-this was trained on", blocks["deezer-bpm-unseen"]
        )
    print_agreement("tempo agreement with the sheet-music bpm", blocks["sheet-music-bpm"])
    print_agreement("key agreement with the sheet-music key", blocks["sheet-music-key"])
    print(
        f"\nstyles: n={styles['n']} tracks with Discogs styles, fingerprint for "
        f"{styles['answered']}; "
        + "; ".join(
            f"hit@{k} {report.frac(h['overN'])} (constant baseline "
            f"{report.frac(h['baselineOverN'])})"
            for k, h in styles["hits"].items()
        )
    )
    usage = disk_usage(root)
    print(f"\ndata directory {root}: {human(usage)} (cap {human(budget.cap)})")
    if args.no_report:
        return 0
    unavailable = {i: p["unavailable"] for i, p in previews.items() if p["unavailable"]}
    run_doc = {
        **common_fields(args, argv, names, started, started_at, root, budget),
        "jobs": max(1, min(args.jobs, runner.MAX_JOBS)),
        "selection": (
            f"{len(selected)} of {len(rows)} rows"
            + (
                ""
                if args.limit is None
                else f" drawn with numpy default_rng({args.selection_seed})"
            )
        ),
        "analyzerVersions": service.analyzer_versions(names),
        "dataset": {
            **golden.DATASET,
            "fileSha256": golden.golden_sha256(),
            "rows": len(rows),
            "selected": len(selected),
            "previewsAnalysed": len(tasks),
            "previewUnavailable": dict(sorted(unavailable.items())),
            "deezerBpm": sum(1 for t in tasks if deezer_bpm[t[1]] is not None),
            "labelSource": "<data dir>/golden/discogs.json",
        },
        "clips": [
            {
                "trackId": a["trackId"],
                "stratum": by_isrc[a["trackId"]].stratum,
                "deezerId": previews[a["trackId"]]["deezerId"],
                "deezerBpm": deezer_bpm[a["trackId"]],
                "window": a.get("window"),
            }
            for a in sorted(analysed, key=lambda a: a["trackId"])
        ],
        "agreement": blocks,
        "trainedOn": {"beat-this": seen} if "beat-this" in names else {},
        "trainedOnNote": beatthis.GOLDEN_TRAINING_NOTE if "beat-this" in names else None,
        "estimatorCredits": [beatthis.REFERENCE, beatthis.HARMONIX_REFERENCE]
        if "beat-this" in names
        else [],
        "serviceDefault": service.default_estimator(),
        "styles": {"model": "discogs-effnet-bs64-1", "topK": len(styles["baseline"]), **styles},
        "failed": [
            {"trackId": a["trackId"], "error": a["error"]} for a in analysed if a.get("error")
        ],
    }
    md_path, json_path = report.write(args.report_dir, today, run_doc)
    print(f"report: {md_path}\nresults: {json_path}")
    return 0


PREVIEW_DIR_PREFIX = "evals-audio-previews-"
# Golden previews are analysed whole, as the service gets them, with the fingerprint's styles.
GOLDEN_OPTIONS = {"whole": True, "styles": True}


def content_length(url: str) -> int | None:
    """The size the index reports for a file (a HEAD request), or None."""
    try:
        response = httpx.head(url, follow_redirects=True, timeout=30.0)
        response.raise_for_status()
        return int(response.headers["content-length"])
    except (httpx.HTTPError, KeyError, ValueError):
        return None


def run_cost(args, argv: list[str], names: list[str], root: Path, budget: DiskBudget) -> int:
    started = time.monotonic()
    started_at = dt.datetime.now(dt.UTC).replace(microsecond=0)
    if not args.no_report:
        report.load(args.report_dir / f"audio-{started_at.date().isoformat()}.json")
    spec = datasets.DATASETS[args.dataset]
    home = root / spec.mirdata_name
    refs, selected, present, _ = fetch(spec, home, args, budget)
    pid = datasets.public_ids(spec, refs)
    measured = [r for r in selected if r.track_id in present]
    if not measured:
        print(f"error: no {spec.name} audio to measure on", file=sys.stderr)
        return 3
    tasks = [
        (spec.name, r.track_id, str(home / r.audio_rel), args.clip_seed, pid[r.track_id])
        for r in measured
    ]
    print(f"measuring {', '.join(names)} on {len(tasks)} {spec.name} clips", file=sys.stderr)
    with tempfile.TemporaryDirectory(prefix="evals-audio-numba-") as numba_cache:
        memory = costs.measure(names, tasks, numba_cache)
    install = costs.install_cost(names, content_length)
    model_files = {}
    if "beat-this" in names:
        model_files["beat-this"] = {
            "file": f"{beatthis.CHECKPOINT_NAME}.ckpt",
            "bytes": beatthis.CHECKPOINT_BYTES,
        }
    for name in names:
        m, i = memory[name], install[name]
        first, per = m["firstAnalysed"], m["perClip"]
        print(
            f"{name:<9} RSS service {human(m['rssServiceBytes'])}, ready "
            f"{human(m['rssReadyBytes'])}, peak {human(m['peakRssBytes'])}; tempo median "
            f"{per['medianWallSeconds']} s/clip over {per['n']} (first analysed clip "
            f"{first and first['wallSeconds']} s); adds "
            f"{human(i['serviceImage']['installedBytes'])} to the service image"
        )
    if args.no_report:
        return 0
    run_doc = {
        **common_fields(args, argv, names, started, started_at, root, budget),
        "jobs": 1,
        "selection": (
            f"{len(selected)} {spec.name} tracks drawn with numpy default_rng("
            f"{args.selection_seed}), 30 s windows at clip seed {args.clip_seed}"
        ),
        "analyzerVersions": service.analyzer_versions(names),
        "machine": {**costs.machine(), "threads": costs.thread_settings()},
        "estimatorCredits": [beatthis.REFERENCE] if "beat-this" in names else [],
        "serviceDefault": service.default_estimator(),
        "dataset": {"name": spec.name, "title": spec.title},
        "clips": [{"trackId": pid[r.track_id]} for r in measured],
        "memory": memory,
        "install": install,
        "modelFiles": model_files,
    }
    md_path, json_path = report.write(args.report_dir, started_at.date().isoformat(), run_doc)
    print(f"report: {md_path}\nresults: {json_path}")
    return 0

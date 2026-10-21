"""
The dated report: `evals/reports/audio-<date>.json` holds every run of that date (one per
suite and dataset, the latest replacing an earlier one) with the per-track results, and
`audio-<date>.md` is rendered from it alone, so the tables can be re-derived from the JSON.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from .runner import METRIC_LABELS, METRICS
from .storage import human

SCHEMA_VERSION = 1


def load(path: Path) -> dict:
    if path.exists():
        doc = json.loads(path.read_text())
        if doc.get("schemaVersion") == SCHEMA_VERSION:
            return doc
    return {"schemaVersion": SCHEMA_VERSION, "runs": []}


def add_run(doc: dict, run: dict) -> dict:
    key = (run["suite"], run["dataset"]["name"])
    runs = [r for r in doc["runs"] if (r["suite"], r["dataset"]["name"]) != key]
    runs.append(run)
    runs.sort(key=lambda r: (r["suite"] != "tempo", r["suite"], r["dataset"]["name"]))
    return {**doc, "runs": runs}


def rerender(json_path: Path) -> Path:
    """Render the Markdown report again from its JSON results file alone."""
    md_path = json_path.with_suffix(".md")
    md_path.write_text(render(json.loads(json_path.read_text())))
    return md_path


def write(report_dir: Path, date: str, run: dict) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / f"audio-{date}.json"
    md_path = report_dir / f"audio-{date}.md"
    doc = add_run(load(json_path), run)
    doc["date"] = date
    json_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    md_path.write_text(render(doc))
    return md_path, json_path


def pct(x: float | None) -> str:
    return "–" if x is None else f"{100 * x:.1f} %"


def ci(m: dict) -> str:
    if m["mean"] is None:
        return "–"
    return f"{100 * m['mean']:.1f} % [{100 * m['ciLow']:.1f}, {100 * m['ciHigh']:.1f}]"


def summary_table(run: dict) -> list[str]:
    metrics = METRICS[run["suite"]]
    head = ["estimator", "n", "answered", "withheld", "failed", "coverage"]
    head += [f"{METRIC_LABELS[m]} [95 % CI]" for m in metrics]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for name, s in run["summaries"].items():
        cells = [
            f"`{name}`",
            str(s["n"]),
            str(s["answered"]),
            str(s["withheld"]),
            str(s["failed"]),
            pct(s["coverage"]),
        ]
        cells += [ci(s["metrics"][m]) for m in metrics]
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def coverage_table(run: dict, name: str) -> list[str]:
    metrics = METRICS[run["suite"]]
    head = ["coverage", "answered", "min. confidence"] + [METRIC_LABELS[m] for m in metrics]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for p in run["coverage"][name]:
        cells = [pct(p["coverage"]), str(p["answered"]), f"{p['minConfidence']:.3f}"]
        cells += [pct(p["accuracy"][m]) for m in metrics]
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def withheld_section(run: dict) -> list[str]:
    """Why answers were withheld, from the per-track rows."""
    rows_by_name = {
        name: [r for r in rows if r.get("withheld")] for name, rows in run["tracks"].items()
    }
    if not any(rows_by_name.values()):
        return []
    out = ["### Withheld", ""]
    for name, rows in rows_by_name.items():
        if not rows:
            continue
        reasons = Counter(r.get("withheldReason", "unknown") for r in rows)
        out.append(
            f"`{name}`: "
            + "; ".join(
                f"{reason}: {n}" for reason, n in sorted(reasons.items(), key=lambda x: -x[1])
            )
            + "."
        )
        unreturned = [r["unreturned"] for r in rows if r.get("unreturned")]
        if unreturned:
            hits1 = sum(u["acc1"] for u in unreturned)
            hits2 = sum(u["acc2"] for u in unreturned)
            out.append(
                f"Tempos withheld because they did not hold over the window: {len(unreturned)}; "
                f"within 4 % of the reference (Acc1): {hits1:.0f}; within 4 % up to an octave "
                f"or meter factor (Acc2): {hits2:.0f}. The service did not return these; they "
                "are listed to calibrate the steadiness check and are not scored above."
            )
        out.append("")
    return out


def render(doc: dict) -> str:
    runs = doc["runs"]
    out = [
        f"# Audio accuracy, {doc['date']}",
        "",
        "Tempo and key accuracy of the audio service (`services/audio`) on annotated datasets, "
        "measured by `evals/audio` (`uv run python -m evals_audio`). The harness imports the "
        "service and calls its own `analyze_signals` on 30-second clips, so the numbers are "
        "what the service returns, gate and withholding rules included. Rendered from "
        f"`audio-{doc['date']}.json`, which holds the per-track results.",
        "",
        "This report covers the tempo and key suites with the librosa and Essentia estimators. "
        "The estimator bake-off with beat-this, style hit@k against Discogs styles and the "
        "agreement with Deezer's `bpm` come in the next part of this work and are not here.",
        "",
        "## How to read it",
        "",
        "- **n** is every selected track with verified audio and a usable reference.",
        "- **Withheld**: the service returned no tempo (or no key) for the clip. Withheld "
        "tracks are counted on their own: they are not scored as wrong and they stay in n. "
        "Accuracy is over the answered tracks; coverage is answered / n.",
        "- **Failed**: the analysis raised an error (listed per run). None is expected.",
        "- **Acc1**: the tempo is within 4 % of the reference. **Acc2**: within 4 % of the "
        "reference times 1, 2, 3, 1/2 or 1/3 (octave and meter errors forgiven).",
        "- **MIREX** key score: 1 same key, 0.5 a perfect fifth above in the same mode, 0.3 "
        "relative, 0.2 parallel, 0 otherwise. **exact**: the same key only.",
        "- **95 % CI**: percentile bootstrap over the answered tracks (10,000 resamples, "
        "fixed seed). With n = 50 the intervals are wide; read them before the means.",
        "- **Coverage curve**: answered tracks sorted by the service's own confidence (tempo "
        "`confidence`, key `strength`), and the accuracy of the most confident ones at each "
        "share of n. A useful confidence makes accuracy fall as coverage grows.",
        "",
    ]
    for run in runs:
        ds = run["dataset"]
        out += [
            f"## {run['suite'].capitalize()}: {ds['title']}",
            "",
            "```sh",
            f"cd evals/audio && {run['command']}",
            "```",
            "",
            f"- Run {run['startedAt']} on commit `{run['gitCommit']}`; "
            f"{run['wallSeconds']:.0f} s wall with {run['jobs']} worker processes.",
            f"- Analyzer: `ANALYZER_VERSION` {run['analyzerVersion']} "
            + ", ".join(f"`{v}`" for v in run["analyzerVersions"].values())
            + " (the fingerprint models were not loaded; tempo and key do not use them).",
            f"- Environment: {', '.join(f'{k} {v}' for k, v in run['environment'].items())}.",
            f"- Clips: {run['clipSeconds']:g} s, start fixed by seed {run['seed']} and the "
            "track id (SHA-256), whole recording when it is 30 s or shorter. "
            f"Selection: {run['selection']}.",
            "",
            "### Dataset",
            "",
            "| | |",
            "|---|---|",
            f"| licence | {ds['licence']} |",
            f"| licence recorded by | {ds['licenceSource']} |",
        ]
        out += [f"| source: {what} | {url} |" for what, url in ds["sources"]]
        out += [
            f"| reference | {ds['referenceNote']} |",
            f"| tracks in the index | {ds['tracksInIndex']} |",
            f"| usable references | {ds['usable']} |",
        ]
        if ds["excluded"]:
            excluded = ", ".join(f"{k}: {v}" for k, v in sorted(ds["excluded"].items()))
            out.append(f"| not scored (whole dataset) | {excluded} |")
        out += [
            f"| selected | {ds['selected']} |",
            f"| audio verified (MD5) | {ds['audioPresent']} |",
            f"| audio unavailable | {len(ds['audioUnavailable'])}"
            + (f" ({', '.join(ds['audioUnavailable'])})" if ds["audioUnavailable"] else "")
            + " |",
        ]
        if ds.get("audioSources"):
            got = ", ".join(f"{v} from {k}" for k, v in ds["audioSources"].items())
            out.append(f"| audio fetched from | {got} |")
        out += [
            f"| data directory | {human(run['dataUsageBytes'])} (cap {human(run['dataCapBytes'])}) |"
        ]
        out += [""] + [f"- {note}" for note in ds["notes"]] + [""]
        out += ["### Accuracy", ""] + summary_table(run) + [""]
        failed = [
            f"`{name}` {r['trackId']}: {r['error']}"
            for name, rows in run["tracks"].items()
            for r in rows
            if r.get("failed")
        ]
        if failed:
            out += ["Failed analyses:", ""] + [f"- {f}" for f in failed] + [""]
        out += withheld_section(run)
        out += ["### Accuracy vs coverage", ""]
        for name in run["summaries"]:
            out += [f"`{name}`:", ""] + coverage_table(run, name) + [""]
    out += [
        "## Reproducing",
        "",
        "Datasets are fetched into `~/liner-notes-data` (or `LINER_NOTES_DATA`), outside the "
        "repository, and never exceed `LINER_NOTES_DATA_CAP_BYTES` (2 GB by default). Only the "
        "selected tracks' audio is downloaded, each checked against mirdata's MD5. See "
        "`evals/audio/README.md`.",
        "",
    ]
    return "\n".join(out)

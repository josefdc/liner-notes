"""
The dated report: `evals/reports/audio-<date>.json` holds the runs of that date with the
per-track results, and `audio-<date>.md` is rendered from it alone, so the tables can be
re-derived from the JSON. A run replaces an earlier one only when suite, dataset, seeds and
limit are all the same; otherwise both are kept.

The JSON carries track ids, where each clip was cut, the service's estimates, confidences,
per-track scores and withheld reasons. Reference labels and audio file names (which carry
artist and title) stay in the local data directory.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from .metrics import MIN_CURVE_ANSWERED
from .runner import METRIC_LABELS, METRICS
from .storage import human

SCHEMA_VERSION = 2


def load(path: Path) -> dict:
    if path.exists():
        doc = json.loads(path.read_text())
        if doc.get("schemaVersion") == SCHEMA_VERSION:
            return doc
    return {"schemaVersion": SCHEMA_VERSION, "runs": []}


def run_key(run: dict) -> tuple:
    seeds = run["seeds"]
    return (
        run["suite"],
        run["dataset"]["name"],
        seeds["selection"],
        seeds["clips"],
        seeds["bootstrap"],
        run["limit"],
    )


def add_run(doc: dict, run: dict) -> dict:
    key = run_key(run)
    runs = [r for r in doc["runs"] if run_key(r) != key]
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
    json_path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    md_path.write_text(render(doc))
    return md_path, json_path


# --- cells -----------------------------------------------------------------------------------


def pct(x: float | None) -> str:
    return "–" if x is None else f"{100 * x:.1f} %"


def total(x: float) -> str:
    return f"{x:g}" if float(x).is_integer() else f"{x:.1f}"


def interval(e: dict) -> str:
    if e["mean"] is None:
        return ""
    if e["ciLow"] is None:
        return f" (no interval: {e['note']})" if e.get("note") else ""
    return f" [{100 * e['ciLow']:.1f}, {100 * e['ciHigh']:.1f}]"


def frac(e: dict) -> str:
    """'28/50 = 56.0 % [42.3, 68.8]': the count, the denominator, the share and its interval."""
    if e["mean"] is None:
        return f"–/{e['n']}"
    return f"{total(e['total'])}/{e['n']} = {pct(e['mean'])}{interval(e)}"


def table(head: list[str], rows: list[list[str]]) -> list[str]:
    return [
        "| " + " | ".join(head) + " |",
        "|" + "---|" * len(head),
        *("| " + " | ".join(r) + " |" for r in rows),
    ]


# --- sections --------------------------------------------------------------------------------


def verdicts(run: dict) -> list[str]:
    """One line per estimator that names the coverage next to the over-n figure."""
    what = "tempo" if run["suite"] == "tempo" else "key"
    main = "acc1" if run["suite"] == "tempo" else "exact"
    right = "within 4 % of the reference" if main == "acc1" else "the reference key"
    out = []
    for name, s in run["summaries"].items():
        cov, hit = s["coverage"], s["overN"][main]
        out.append(
            f"- `{name}` returns a {what} for {cov['total']:g} of {s['n']} clips "
            f"({pct(cov['mean'])}); the {what} it returns is {right} for {total(hit['total'])} "
            f"of all {s['n']} clips ({pct(hit['mean'])})."
        )
    return out


def summary_table(run: dict) -> list[str]:
    metrics = METRICS[run["suite"]]
    head = ["estimator", "n", "answered (coverage)", "withheld", "failed"]
    for m in metrics:
        head += [f"{METRIC_LABELS[m]}: correct / n", f"{METRIC_LABELS[m]}: correct / answered"]
    rows = []
    for name, s in run["summaries"].items():
        row = [f"`{name}`", str(s["n"]), frac(s["coverage"]), str(s["withheld"]), str(s["failed"])]
        for m in metrics:
            row += [frac(s["overN"][m]), frac(s["overAnswered"][m])]
        rows.append(row)
    return table(head, rows)


def paired_section(run: dict) -> list[str]:
    paired = run.get("paired")
    if not paired:
        return []
    first, second = paired["first"], paired["second"]
    out = [
        "### Paired comparison",
        "",
        f"`{first}` and `{second}` on the same clips: the clips both answered, and all n clips "
        "with a withheld answer counted as not correct. The columns above are not comparable "
        "between estimators that answer different clips; compare them here.",
        "",
    ]
    rows = []
    for m in METRICS[run["suite"]]:
        for label, key in (("both answered", "bothAnswered"), ("all n", "allN")):
            block = paired[key]
            r = block["metrics"][m]
            if "mcnemarP" in r:
                rows.append(
                    [
                        METRIC_LABELS[m],
                        f"{label} (n = {block['n']})",
                        f"{r['firstCorrect']}",
                        f"{r['secondCorrect']}",
                        f"{r['onlyFirst']} / {r['onlySecond']}",
                        f"McNemar exact p = {r['mcnemarP']:.3f}",
                    ]
                )
            else:
                d = r["difference"]
                diff = (
                    "–"
                    if d["mean"] is None
                    else f"{100 * d['mean']:+.1f} points{interval(d)} (BCa)"
                )
                rows.append(
                    [
                        METRIC_LABELS[m],
                        f"{label} (n = {block['n']})",
                        pct(r["firstMean"]),
                        pct(r["secondMean"]),
                        "–",
                        f"mean difference {diff}",
                    ]
                )
    head = [
        "metric",
        "clips",
        f"`{first}`",
        f"`{second}`",
        f"right only for `{first}` / only for `{second}`",
        "test",
    ]
    return out + table(head, rows) + [""]


def withheld_section(run: dict) -> list[str]:
    """Why answers were withheld, and what withholding costs (the unreturned estimates scored)."""
    rows_by_name = {
        name: [r for r in rows if r.get("withheld")] for name, rows in run["tracks"].items()
    }
    if not any(rows_by_name.values()):
        return []
    metrics = METRICS[run["suite"]]
    what = (
        "a tempo that did not hold over the window"
        if run["suite"] == "tempo"
        else "a key stopped by the evidence rule"
    )
    out = ["### Withheld", ""]
    for name, rows in rows_by_name.items():
        if not rows:
            continue
        reasons = Counter(r.get("withheldReason", "unknown") for r in rows)
        out.append(
            f"`{name}`, withheld {len(rows)}: "
            + "; ".join(
                f"{reason}: {n}" for reason, n in sorted(reasons.items(), key=lambda x: -x[1])
            )
            + "."
        )
    out += [
        "",
        f"For {what}, the estimator had an estimate that the service did not return. Scored "
        "against the reference, it shows what withholding costs: a rule that helps withholds "
        "estimates that are right less often than the ones it returns. These estimates never "
        "reach a user and are not counted in the tables above; the last column is what correct "
        "/ n would be if they were returned too.",
        "",
    ]
    rows = []
    for name, cost in (run.get("withheldCost") or {}).items():
        summary = run["summaries"][name]
        for m in metrics:
            c = cost["metrics"][m]
            rows.append(
                [
                    f"`{name}`",
                    METRIC_LABELS[m],
                    frac(c["unreturned"]),
                    frac(summary["overAnswered"][m]),
                    frac(summary["overN"][m]),
                    frac(c["ifReturnedOverN"]),
                ]
            )
    head = [
        "estimator",
        "metric",
        "withheld estimates: correct",
        "returned: correct",
        "correct / n as served",
        "correct / n if returned too",
    ]
    return out + table(head, rows) + [""]


def coverage_section(run: dict) -> list[str]:
    metrics = METRICS[run["suite"]]
    out = [
        "### Accuracy vs coverage",
        "",
        "Answered clips ranked by the service's confidence, highest first; each row keeps the "
        "top k (coverage = k / n) and gives correct / k with its interval. Rows with fewer "
        f"than {MIN_CURVE_ANSWERED} clips are left out, except the last row (every answered "
        "clip). Neighbouring rows share most of their clips and their intervals overlap, so "
        "a rise or fall between rows is not evidence on its own. Whether the confidence ranks "
        "answers at all is the AUC line under each table: the chance that a correct answer has "
        "a higher confidence than a wrong one (0.5 is random order), with a one-sided "
        "Mann-Whitney p-value against random order.",
        "",
    ]
    for name, curve in run["coverage"].items():
        head = ["coverage", "k", "min. confidence"] + [METRIC_LABELS[m] for m in metrics]
        rows = []
        for p in curve["points"]:
            conf = (
                "unranked included" if p["minConfidence"] is None else f"{p['minConfidence']:.3f}"
            )
            rows.append(
                [pct(p["coverage"]), str(p["answered"]), conf]
                + [frac(p["accuracy"][m]) for m in metrics]
            )
        out += [f"`{name}`:", ""] + table(head, rows)
        ranking = curve.get("ranking") or {}
        if ranking:
            parts = []
            for m, r in ranking.items():
                if r["auc"] is None:
                    parts.append(
                        f"{METRIC_LABELS[m]} no AUC ({r['correct']} correct, {r['wrong']} wrong)"
                    )
                else:
                    parts.append(
                        f"{METRIC_LABELS[m]} AUC {r['auc']:.2f} ({r['correct']} correct, "
                        f"{r['wrong']} wrong; p = {r['p']:.3f})"
                    )
            out += ["", "Confidence ranking: " + "; ".join(parts) + "."]
        if curve["unranked"]:
            out += [
                "",
                f"Answered without a confidence (ranked last): {', '.join(curve['unranked'])}.",
            ]
        out.append("")
    return out


def dataset_section(run: dict) -> list[str]:
    ds = run["dataset"]
    rows = [
        ["licence (annotations)", ds["annotationLicence"]],
        ["audio", ds["audioRights"]],
        *[[f"source: {what}", url] for what, url in ds["sources"]],
        ["reference", ds["referenceNote"]],
        ["tracks in the index", str(ds["tracksInIndex"])],
        ["usable references", str(ds["usable"])],
    ]
    if ds["excluded"]:
        excluded = ", ".join(f"{k}: {v}" for k, v in sorted(ds["excluded"].items()))
        rows.append(["not scored (whole dataset)", excluded])
    unavailable = ds["audioUnavailable"]
    rows += [
        ["selected", str(ds["selected"])],
        ["audio verified (MD5)", str(ds["audioPresent"])],
        [
            "audio unavailable",
            str(len(unavailable)) + (f" ({', '.join(unavailable)})" if unavailable else ""),
        ],
    ]
    if ds.get("audioSources"):
        got = ", ".join(f"{v} from {k}" for k, v in ds["audioSources"].items())
        rows.append(["audio fetched from", got])
    rows.append(
        ["data directory", f"{human(run['dataUsageBytes'])} (cap {human(run['dataCapBytes'])})"]
    )
    out = ["### Dataset", ""] + table(["", ""], rows) + [""]
    out += [f"- {note}" for note in ds["notes"]]
    stats = ds.get("referenceStats")
    if stats:
        v1 = ", ".join(f"`{k}` {v}/{stats['n']}" for k, v in stats["acc1CorrectAgainstV1"].items())
        out.append(
            f"- The v2 reference is the crowd tempo with the highest share. {stats['severalCrowdTempi']} "
            f"of the {stats['n']} clips have more than one crowd tempo and {stats['nearTies']} have "
            "a top two within 0.2 of each other, so the reference is fragile there. The v1 "
            f"reference (Knees et al. 2015) differs by more than 4 % on "
            f"{stats['v1DiffersOver4pct']} of {stats['n']} clips; against v1, Acc1 correct / n "
            f"would be {v1}."
        )
    out += ["", "Credits (cite these when using the data):", ""]
    out += [f"- {c}" for c in ds["credits"]] + [""]
    return out


def decode_section(run: dict) -> list[str]:
    noisy = [c for c in run["clips"] if (c.get("window") or {}).get("decodeWarnings")]
    if not noisy:
        return []
    out = ["Decoder warnings (the clip was still decoded and analysed):", ""]
    for c in noisy:
        out.append(f"- {c['trackId']}: {'; '.join(c['window']['decodeWarnings'])}")
    return out + [""]


GUIDE = [
    "## How to read it",
    "",
    "- **n** is every selected clip with verified audio and a usable reference. **Answered** "
    "clips got a value from the service; **withheld** clips got none; **failed** clips raised "
    "an error (none is expected). Coverage is answered / n.",
    "- **correct / n** counts a withheld clip as no correct value. It answers *how often does "
    "a user get a right value*. **correct / answered** is the share of returned values that are "
    "right. It answers *how often is a value the service shows right*, and it depends on which "
    "clips the service chose to answer: two estimators that answer different clips are compared "
    "in the paired table, not by this column.",
    "- **Acc1**: the tempo is within 4 % of the reference. **Acc2**: within 4 % of the "
    "reference times 1, 2, 3, 1/2 or 1/3 (octave and meter errors forgiven).",
    "- **MIREX** key score: 1 same key, 0.5 a perfect fifth above in the same mode, 0.3 "
    "relative, 0.2 parallel, 0 otherwise; shown as the summed score over the denominator. "
    "**exact**: the same key only.",
    "- **Intervals** are 95 %: Wilson score intervals for Acc1, Acc2 and exact; a BCa bootstrap "
    "(10,000 resamples, fixed seed) for MIREX, with no interval when every score is equal. Each "
    "interval rests on the denominator printed next to it, which for correct / answered can be "
    "far below n.",
    "- **Comparability**: one 30 s window per clip and the excluded labels make these numbers "
    "incomparable with published figures for the same datasets (computed on full excerpts, "
    "usually on every labelled track).",
    "",
]


def render(doc: dict) -> str:
    out = [
        f"# Audio accuracy, {doc['date']}",
        "",
        "Tempo and key accuracy of the audio service (`services/audio`) on annotated datasets, "
        "measured by `evals/audio` (`uv run python -m evals_audio`). The harness imports the "
        "service and calls its own `analyze_signals` on 30-second clips, so the numbers are "
        "what the service returns, gate and withholding rules included. Rendered from "
        f"`audio-{doc['date']}.json`, which holds the per-clip results (track ids, estimates, "
        "scores; no reference labels or file names).",
        "",
        "This report covers the tempo and key suites with the librosa and Essentia estimators. "
        "The estimator bake-off with beat-this, style hit@k against Discogs styles and the "
        "agreement with Deezer's `bpm` come in the next part of this work and are not here.",
        "",
        *GUIDE,
    ]
    for run in doc["runs"]:
        seeds = run["seeds"]
        out += [
            f"## {run['suite'].capitalize()}: {run['dataset']['title']}",
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
            f"- Seeds: selection {seeds['selection']}, clip windows {seeds['clips']}, bootstrap "
            f"{seeds['bootstrap']}. Selection: {run['selection']}. Clips: "
            f"{run['clipSeconds']:g} s, the start fixed by the clip seed and the track id "
            "(SHA-256); a recording of 30 s or less is used whole.",
            "",
        ]
        out += dataset_section(run)
        out += ["### Accuracy", ""] + verdicts(run) + [""] + summary_table(run) + [""]
        failed = [
            f"`{name}` {r['trackId']}: {r['error']}"
            for name, rows in run["tracks"].items()
            for r in rows
            if r.get("failed")
        ]
        if failed:
            out += ["Failed analyses:", ""] + [f"- {f}" for f in failed] + [""]
        out += decode_section(run)
        out += paired_section(run)
        out += withheld_section(run)
        out += coverage_section(run)
    out += [
        "## Reproducing",
        "",
        "Datasets are fetched into `~/liner-notes-data` (or `LINER_NOTES_DATA`), outside the "
        "repository, under a cap (`LINER_NOTES_DATA_CAP_BYTES`, 2 GB by default). Only the "
        "selected tracks' audio is written, each checked against mirdata's MD5. See "
        "`evals/audio/README.md`.",
        "",
    ]
    return "\n".join(out)

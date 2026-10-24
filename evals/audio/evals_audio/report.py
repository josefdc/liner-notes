"""
The dated report: `evals/reports/audio-<date>.json` holds the runs of that date with the
per-track results, and `audio-<date>.md` is rendered from it alone, so the tables can be
re-derived from the JSON. A run replaces an earlier one only when suite, dataset, seeds,
limit and estimators are all the same; otherwise both are kept.

The JSON carries track ids (a short hash for datasets whose ids are file names), where each
clip was cut, the service's estimates, confidences, per-track scores and withheld reasons. It
stores no reference labels and no audio file names, but an estimate with its score often
gives the reference away (a MIREX score fixes the key; an Acc1 hit pins the tempo within
4 %), so the per-track results are treated as derived from the annotations and credited.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from .metrics import MIN_CURVE_ANSWERED
from .runner import METRIC_LABELS, METRICS, SEVERAL_RULES
from .storage import human

SCHEMA_VERSION = 4


class OlderResults(RuntimeError):
    """The dated results file was written by an older harness and cannot be merged into."""


def load(path: Path) -> dict:
    """
    The dated results file, or a new one. A file from an older harness (another
    schemaVersion) is refused rather than dropped: its runs would be lost without a word.
    """
    if not path.exists():
        return {"schemaVersion": SCHEMA_VERSION, "runs": []}
    doc = json.loads(path.read_text())
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        raise OlderResults(
            f"{path} was written by another version of the harness (schemaVersion "
            f"{doc.get('schemaVersion')}, now {SCHEMA_VERSION}); move or delete it to start "
            "that date's report afresh, or pass --report-dir"
        )
    return doc


def run_key(run: dict) -> tuple:
    """A run replaces another only with the same suite, dataset, seeds, limit and estimators."""
    seeds = run["seeds"]
    return (
        run["suite"],
        run["dataset"]["name"],
        seeds["selection"],
        seeds["clips"],
        seeds["bootstrap"],
        run["limit"],
        tuple(sorted(run["summaries"])),
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
                    else f"{100 * d['mean']:+.1f} points{interval(d)} ({d['method']})"
                )
                rows.append(
                    [
                        METRIC_LABELS[m],
                        f"{label} (n = {block['n']})",
                        pct(r["firstMean"]),
                        pct(r["secondMean"]),
                        f"{r['firstHigher']} / {r['secondHigher']}",
                        f"mean difference {diff}; sign-flip p = {r['signFlipP']:.3f} "
                        f"({r['signFlipMethod']})" + coverage_note(r.get("differenceCoverage")),
                    ]
                )
    head = [
        "metric",
        "clips",
        f"`{first}`",
        f"`{second}`",
        f"pairs better for `{first}` / for `{second}`",
        "test",
    ]
    return out + table(head, rows) + [""]


def source_lengths(run: dict) -> str:
    """The range of the measured recordings' lengths, from the clip windows."""
    windows = [c["window"] for c in run["clips"] if c.get("window")]
    if not windows:
        return ""
    lengths = [w["sourceSeconds"] for w in windows]
    whole = sum(1 for w in windows if w["durationSeconds"] >= w["sourceSeconds"])
    return (
        f" The {len(windows)} recordings measured are {min(lengths):.1f}-{max(lengths):.1f} s "
        f"long (used whole: {whole})."
    )


def coverage_note(check: dict | None) -> str:
    if not check or check.get("coverage") is None:
        return ""
    return (
        f"; the interval covers the mean in {pct(check['coverage'])} of {check['draws']:,} "
        "resamples of these differences"
    )


def withheld_section(run: dict) -> list[str]:
    """Why answers were withheld, and what withholding costs (the unreturned estimates scored)."""
    rows_by_name = {
        name: [r for r in rows if r.get("withheld")] for name, rows in run["tracks"].items()
    }
    if not any(rows_by_name.values()):
        return []
    metrics = METRICS[run["suite"]]
    out = ["### Withheld", ""]
    for name, rows in rows_by_name.items():
        if not rows:
            continue
        reasons = Counter(r.get("withheldReason", "unknown") for r in rows)
        scored = sum(1 for r in rows if r.get("unreturned"))
        out.append(
            f"`{name}`, withheld {len(rows)}: "
            + "; ".join(
                f"{reason}: {n}"
                for reason, n in sorted(reasons.items(), key=lambda x: (-x[1], x[0]))
            )
            + f". The estimator still had an estimate for {scored} of them."
        )
    rules = (
        "onsets that do not repeat enough (the periodicity minimum), a confidence under the "
        "estimator's minimum or a tempo that does not hold over the window"
        if run["suite"] == "tempo"
        else "the evidence rule or a strength under the minimum"
    )
    out += [
        "",
        f"When {rules} withholds an answer, the estimator usually still has an estimate: the "
        "harness recomputes it with the rule lifted and scores it against the reference, which "
        "shows what each rule costs. A rule that helps withholds estimates that are right less "
        "often than the ones it returns. These estimates never reach a user and are not counted "
        "in the tables above. The first row per estimator is what the service returned, as "
        "served. A rule's row counts the clips that this rule alone withholds, so its last "
        "column is what correct / n would be with that rule alone lifted; clips that several "
        "rules withhold have their own row, and the last row lifts every rule. Clips with no "
        "estimate even with every rule lifted (the gate, no estimate) stay at no correct value.",
        "",
    ]
    rows = []
    for name, cost in (run.get("withheldCost") or {}).items():
        summary = run["summaries"][name]
        served = [f"`{name}`", f"returned ({summary['answered']})"]
        for m in metrics:
            served += [frac(summary["overAnswered"][m]), frac(summary["overN"][m])]
        rows.append(served)
        for group in cost["rules"]:
            label = {
                "all": "every rule lifted",
                SEVERAL_RULES: "withheld by several rules",
            }.get(group["rule"], f"only: {group['rule']}")
            row = [f"`{name}`", f"{label} ({group['count']})"]
            for m in metrics:
                c = group["metrics"][m]
                row += [frac(c["unreturned"]), frac(c["ifReturnedOverN"])]
            rows.append(row)
    head = ["estimator", "answers"]
    for m in metrics:
        head += [f"{METRIC_LABELS[m]}: correct", f"{METRIC_LABELS[m]}: correct / n with these too"]
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
                        f"{r['wrong']} wrong; p = {r['p']:.3f}, {r['pMethod']})"
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


P_VALUES = object()  # where the p-value bullet goes; it needs the count from the document


def count_p_values(doc: dict) -> int:
    """How many p-values the report prints: McNemar and sign-flip rows, and AUC lines."""
    count = 0
    for run in doc["runs"]:
        paired = run.get("paired") or {}
        for key in ("bothAnswered", "allN"):
            count += len((paired.get(key) or {}).get("metrics", {}))
        for curve in run["coverage"].values():
            count += sum(1 for r in (curve.get("ranking") or {}).values() if r["p"] is not None)
    return count


def p_value_note(doc: dict) -> str:
    n = count_p_values(doc)
    return (
        "- **p-values** are exact where it is cheap (McNemar; sign-flip; the AUC's permutation "
        "test up to 200,000 orderings) and Monte Carlo at a fixed seed otherwise, as labelled, "
        "computed as (hits + 1) / (resamples + 1). Each is for one comparison. This report "
        f"prints {n}; about {0.05 * n:.1f} of them are expected under 0.05 by chance alone, so "
        "none should be read as a finding without a correction for the number of tests."
    )


def guide(doc: dict) -> list[str]:
    return [p_value_note(doc) if line is P_VALUES else line for line in GUIDE]


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
    "- **Paired MIREX difference**: most paired key differences are zero, and a bootstrap "
    "interval can then cover far less than 95 %. The interval here is a paired t interval whose "
    "spread includes two pseudo-differences at -1 and +1, the ends of the range, so it never "
    "collapses to zero width. Each row says how often it covered the mean when that row's own "
    "differences were resampled. It is wide at small n and is not conservative in general: on "
    "dense differences it can cover less than 95 % (`evals/audio/scripts/paired_coverage.py` "
    'simulates both). The sign-flip p-value tests "no difference" over every sign pattern of '
    "the nonzero differences (exact up to 16 of them).",
    P_VALUES,
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
        f"`audio-{doc['date']}.json`, which holds the per-clip results: track ids, estimates "
        "and scores. It stores no reference labels and no audio file names, but an estimate "
        "with its score often gives the reference away (a MIREX score of 1, 0.5, 0.3 or 0.2 "
        "fixes the key; an Acc1 hit pins the tempo within 4 %), so those results are derived "
        "from the annotations: the licence and credits under each dataset apply to them.",
        "",
        "This report covers the tempo and key suites with the librosa and Essentia estimators. "
        "The estimator bake-off with beat-this, style hit@k against Discogs styles and the "
        "agreement with Deezer's `bpm` come in the next part of this work and are not here.",
        "",
        *guide(doc),
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
            "(SHA-256); a recording of 30 s or less is used whole." + source_lengths(run),
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

"""
The dated report: `evals/reports/audio-<date>.json` holds the runs of that date with the
per-track results, and `audio-<date>.md` is rendered from it alone, so the tables can be
re-derived from the JSON. A run replaces an earlier one only when suite, dataset, seeds,
limit and estimators are all the same; otherwise both are kept. Results files of schema 4
(tempo and key with two estimators) still render exactly as they were written.

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

SCHEMA_VERSION = 6
# The last schema before the bake-off, the golden suite and the cost suite; its reports keep
# their original wording. (Schema 5 was a draft of 6 and was never merged.)
LEGACY_SCHEMA = 4
SUITE_ORDER = {"tempo": 0, "key": 1, "golden": 2, "cost": 3}


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
        tuple(sorted(run.get("estimators") or run["summaries"])),
    )


def add_run(doc: dict, run: dict) -> dict:
    key = run_key(run)
    runs = [r for r in doc["runs"] if run_key(r) != key]
    runs.append(run)
    runs.sort(key=lambda r: (SUITE_ORDER.get(r["suite"], 9), r["suite"], r["dataset"]["name"]))
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


def pval(p: float) -> str:
    """A p-value with three decimals; one under 0.001 is shown as "< 0.001", never 0.000."""
    return "< 0.001" if p < 0.001 else f"= {p:.3f}"


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


def label(run: dict, name: str) -> str:
    """The estimator's name, marked when its model was trained on the run's dataset."""
    return (
        f"`{name}` (trained on this dataset)" if name in run.get("trainedOn", []) else f"`{name}`"
    )


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
        row = [
            label(run, name),
            str(s["n"]),
            frac(s["coverage"]),
            str(s["withheld"]),
            str(s["failed"]),
        ]
        for m in metrics:
            row += [frac(s["overN"][m]), frac(s["overAnswered"][m])]
        rows.append(row)
    return table(head, rows)


def pair_list(paired) -> list[dict]:
    """Schema 4 holds one pair (a dict), later schemas a list of pairs."""
    if not paired:
        return []
    return [paired] if isinstance(paired, dict) else list(paired)


def paired_section(run: dict) -> list[str]:
    pairs = pair_list(run.get("paired"))
    if not pairs:
        return []
    if len(pairs) == 1:
        first, second = pairs[0]["first"], pairs[0]["second"]
        out = [
            "### Paired comparison",
            "",
            f"`{first}` and `{second}` on the same clips: the clips both answered, and all n "
            "clips with a withheld answer counted as not correct. The columns above are not "
            "comparable between estimators that answer different clips; compare them here.",
            "",
        ]
        return out + pair_table(run["suite"], pairs[0])
    out = [
        "### Paired comparisons",
        "",
        "Each pair of estimators on the same clips: the clips both answered, and all n clips "
        "with a withheld answer counted as not correct. The columns above are not comparable "
        "between estimators that answer different clips; compare them here.",
        "",
    ]
    skipped = []
    for pair in pairs:
        trained = [n for n in (pair["first"], pair["second"]) if n in run.get("trainedOn", [])]
        if trained:
            skipped.append(pair)
            continue
        out += [f"`{pair['first']}` and `{pair['second']}`:", ""] + pair_table(run["suite"], pair)
    if skipped:
        names = sorted(
            {n for p in skipped for n in (p["first"], p["second"])} & set(run["trainedOn"])
        )
        out += [
            "Pairs with "
            + ", ".join(f"`{n}`" for n in names)
            + " are not shown: it was trained on this dataset, so a comparison here says "
            "nothing about new music.",
            "",
        ]
    return out


def shown_pairs(run: dict) -> list[dict]:
    """The pairs a run prints (pairs with an estimator trained on the dataset are not)."""
    trained = set(run.get("trainedOn") or [])
    return [p for p in pair_list(run.get("paired")) if not ({p["first"], p["second"]} & trained)]


def pair_table(suite: str, paired: dict) -> list[str]:
    first, second = paired["first"], paired["second"]
    rows = []
    for m in METRICS[suite]:
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
                        f"McNemar exact p {pval(r['mcnemarP'])}",
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
                        f"mean difference {diff}; sign-flip p {pval(r['signFlipP'])} "
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
    return table(head, rows) + [""]


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
        points = curve["points"]
        if points and all(p["minConfidence"] is None for p in points):
            out += [
                f"`{name}` gives no confidence: its {points[-1]['answered']} answered clips "
                "cannot be ranked, so it has no curve.",
                "",
            ]
            continue
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
                        f"{r['wrong']} wrong; p {pval(r['p'])}, {r['pMethod']})"
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
    out += [f"- {c}" for c in ds["credits"] + run.get("estimatorCredits", [])] + [""]
    return out


def decode_section(run: dict) -> list[str]:
    noisy = [c for c in run["clips"] if (c.get("window") or {}).get("decodeWarnings")]
    if not noisy:
        return []
    out = ["Decoder warnings (the clip was still decoded and analysed):", ""]
    for c in noisy:
        out.append(f"- {c['trackId']}: {'; '.join(c['window']['decodeWarnings'])}")
    return out + [""]


def grouped_decode_section(run: dict) -> list[str]:
    """Decoder warnings with the previews that gave each (the same few repeat on many)."""
    by_warning: dict[str, list[str]] = {}
    for c in run["clips"]:
        for warning in (c.get("window") or {}).get("decodeWarnings") or []:
            by_warning.setdefault(warning, []).append(c["trackId"])
    if not by_warning:
        return []
    out = ["Decoder warnings (the previews were still decoded and analysed):", ""]
    for warning, ids in sorted(by_warning.items()):
        out.append(f"- {warning}: {len(ids)} previews ({', '.join(ids)})")
    return out + [""]


P_VALUES = object()  # where the p-value bullet goes; it needs the count from the document


def count_p_values(doc: dict) -> int:
    """How many p-values the report prints: McNemar and sign-flip rows, and AUC lines."""
    count = 0
    for run in doc["runs"]:
        pairs = shown_pairs(run)
        for block in (run.get("agreement") or {}).values():
            if block["n"] and block["summaries"]:  # an empty table prints no pairs
                pairs += pair_list(block.get("paired"))
        for paired in pairs:
            for key in ("bothAnswered", "allN"):
                count += len((paired.get(key) or {}).get("metrics", {}))
        for curve in (run.get("coverage") or {}).values():
            count += sum(1 for r in (curve.get("ranking") or {}).values() if r["p"] is not None)
        count += len((run.get("styles") or {}).get("versusBaseline") or {})
    return count + lifted_test_count(doc)


def lifted_test_count(doc: dict) -> int:
    """The p-values the default-estimator table adds: its lifted-rule comparisons."""
    if is_legacy(doc):
        return 0
    tempo = [r for r in doc["runs"] if r["suite"] == "tempo" and r.get("serviceDefault")]
    if not tempo:
        return 0
    default = tempo[0]["serviceDefault"]
    count = 0
    for run in tempo:
        for name in run["summaries"]:
            if name == default or name in run.get("trainedOn", []):
                continue
            for key in ("steadinessOnly", "everyRule"):
                view = (run.get("lifted") or {}).get(key) or {}
                count += versus(view.get("paired", []), name, default, "acc1") is not None
    return count


def p_value_note(doc: dict) -> str:
    n = count_p_values(doc)
    return (
        "- **p-values** are exact where it is cheap (McNemar; sign-flip; the AUC's permutation "
        "test up to 200,000 orderings) and Monte Carlo at a fixed seed otherwise, as labelled, "
        "computed as (hits + 1) / (resamples + 1). Each is for one comparison. This report "
        + (
            f"prints {n}"
            if is_legacy(doc)
            else f"gives {n} distinct ones (the default-estimator table repeats some of them)"
        )
        + f"; about {0.05 * n:.1f} of them are expected under 0.05 by chance alone, so "
        "none should be read as a finding without a correction for the number of tests."
    )


def guide(doc: dict) -> list[str]:
    lines = GUIDE if is_legacy(doc) else GUIDE[:-2] + GUIDE_BAKEOFF + GUIDE[-2:]
    return [p_value_note(doc) if line is P_VALUES else line for line in lines]


def is_legacy(doc: dict) -> bool:
    return doc.get("schemaVersion", SCHEMA_VERSION) <= LEGACY_SCHEMA


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

GUIDE_BAKEOFF = [
    "- **beat-this** (checkpoint `final0`, CPU, no DBN) is not part of the service; the harness "
    "runs it behind the service's estimator interface, so its tempo goes through the service's "
    "own rules: the onset-periodicity minimum, 40-208 BPM, the tempo refined from the beats on "
    "onsets, and the steadiness check. It gives no confidence (so no curve and no confidence "
    "minimum) and no key. Its authors trained `final0` on every dataset they used except GTZAN, "
    "Ballroom included: an estimator marked *trained on this dataset* is shown on its own "
    "training data: those cells are not evidence about new music and its pair tables there "
    "are not printed.",
    "- **Agreement** (golden set) is not accuracy. Deezer's `bpm` is Deezer's own estimate, a "
    "sourced hint; the set's tempo and key labels are nominal sheet-music markings. A "
    "disagreement can be either side's error. The tolerances are Acc1/Acc2's (within 4 %; up to "
    "octave and meter) and MIREX/exact's.",
    "- **hit@k**: the fingerprint's k strongest styles (`Genre---Style`) include one whose genre "
    "and style are both on the Discogs master (or release) of the earliest single, EP or album "
    "the recording is on. The constant baseline gives every track the same k styles, the "
    "model's average output (the highest summed score over the top-10 lists of the scored "
    "previews), so it uses no label; it is not the strongest constant. The best constant found "
    "with the labels (greedy cover) is printed as an optimistic reference. The style "
    "model was trained on Discogs styles (Discogs-4M, about 3.3 million tracks), possibly of "
    "these very releases: a hit can be recall rather than judgement.",
    "- **Costs** are measured on one machine, each estimator in its own fresh process with one "
    "thread (forced); times vary from run to run. The image cost is what an estimator adds to "
    "the service's image as it ships (which already holds Essentia, for the fingerprint): "
    "installed bytes, as an image layer holds them uncompressed, and wheel bytes, plus model "
    "files; no image was built. Peak memory includes one-time compilation (numba for librosa); "
    "the memory after the first analysed clip is shown next to it.",
    "- **Lifted rules**: the service withholds a tempo under its rules (the periodicity and "
    "confidence minimums, the steadiness check). The estimate it computed is kept apart and "
    "scored, so a comparison can be made with a rule lifted. That is calibration, never what a "
    "user gets. The steadiness check compares each third of the window with librosa's own "
    "tempo estimate on that third.",
]


LEGACY_SCOPE = (
    "This report covers the tempo and key suites with the librosa and Essentia estimators. "
    "The estimator bake-off with beat-this, style hit@k against Discogs styles and the "
    "agreement with Deezer's `bpm` come in the next part of this work and are not here."
)


def intro(doc: dict) -> list[str]:
    results = (
        f"Rendered from `audio-{doc['date']}.json`, which holds the per-clip results: track ids, "
        "estimates and scores. It stores no reference labels and no audio file names, but an "
        "estimate with its score often gives the reference away (a MIREX score of 1, 0.5, 0.3 "
        "or 0.2 fixes the key; an Acc1 hit pins the tempo within 4 %), so those results are "
        "derived from the annotations: the licence and credits under each dataset apply to them."
    )
    if is_legacy(doc):
        return [
            "Tempo and key accuracy of the audio service (`services/audio`) on annotated "
            "datasets, measured by `evals/audio` (`uv run python -m evals_audio`). The harness "
            "imports the service and calls its own `analyze_signals` on 30-second clips, so the "
            "numbers are what the service returns, gate and withholding rules included. " + results,
            "",
            LEGACY_SCOPE,
            "",
        ]
    return [
        "Tempo and key accuracy of the audio service (`services/audio`) on annotated datasets, "
        "its agreement with sourced tempo and key values on the golden set's Deezer previews, "
        "its style fingerprint against Discogs styles, and what each tempo estimator costs, "
        "measured by `evals/audio` (`uv run python -m evals_audio`). The harness imports the "
        "service and calls its own `analyze_signals`, so the numbers are what the service "
        "returns, gate and withholding rules included. " + results,
        "",
        scope(doc),
        "",
    ]


def scope(doc: dict) -> str:
    parts = []
    for run in doc["runs"]:
        names = ", ".join(run.get("estimators") or run.get("summaries") or [])
        what = {
            "tempo": f"tempo on {run['dataset']['title']}",
            "key": f"key on {run['dataset']['title']}",
            "golden": "the golden set's Deezer previews",
            "cost": f"costs on {run['dataset']['title']} clips",
        }[run["suite"]]
        parts.append(f"{what} ({names})")
    return (
        "Runs in this report: " + "; ".join(parts) + ". beat-this is measured here only: the "
        "service does not ship it, and the service's default estimator is not changed by this "
        "report."
    )


def run_header(run: dict, models_note: str) -> list[str]:
    return [
        "```sh",
        f"cd evals/audio && {run['command']}",
        "```",
        "",
        f"- Run {run['startedAt']} on commit `{run['gitCommit']}`; "
        f"{run['wallSeconds']:.0f} s wall"
        + ("." if run["suite"] == "cost" else f" with {run['jobs']} worker processes."),
        f"- Analyzer: `ANALYZER_VERSION` {run['analyzerVersion']} "
        + ", ".join(f"`{v}`" for v in run["analyzerVersions"].values())
        + f" ({models_note}).",
        f"- Environment: {', '.join(f'{k} {v}' for k, v in run['environment'].items())}.",
        f"- Seeds: {used_seeds(run)}. Selection: {run['selection']}.",
    ]


def used_seeds(run: dict) -> str:
    """The seeds a golden or cost run uses: previews are whole, costs draw no bootstrap."""
    seeds = run["seeds"]
    if run["suite"] == "golden":
        return (
            f"selection {seeds['selection']}, bootstrap {seeds['bootstrap']} (previews are whole)"
        )
    return f"selection {seeds['selection']}, clip windows {seeds['clips']}"


def bakeoff_section(doc: dict) -> list[str]:
    """Every tempo estimator's figures side by side, taken from the runs below."""
    tempo = [r for r in doc["runs"] if r["suite"] == "tempo"]
    golden = next((r for r in doc["runs"] if r["suite"] == "golden"), None)
    cost = next((r for r in doc["runs"] if r["suite"] == "cost"), None)
    names: list[str] = []
    for run in [*tempo, *([golden] if golden else []), *([cost] if cost else [])]:
        names += [n for n in run.get("estimators") or run["summaries"] if n not in names]
    if len(names) < 2:
        return []
    head, columns = ["estimator"], []
    for run in tempo:
        for m in ("acc1", "acc2"):
            head.append(f"{run['dataset']['name']}: {METRIC_LABELS[m]} correct / n")
            columns.append(("tempo", run, m))
    if golden:
        for m, what in (("acc1", "within 4 %"), ("acc2", "up to octave/meter")):
            unseen = "deezer-bpm-unseen" in golden["agreement"]
            head.append(
                f"golden previews{' beat-this was not trained on' if unseen else ''}: agrees "
                f"with Deezer `bpm` {what} / n"
            )
            columns.append(("golden", golden, m))
    if cost:
        head += ["peak RSS", "tempo per clip (median wall)", "adds to the service image"]
        columns += [("cost", cost, "rss"), ("cost", cost, "time"), ("cost", cost, "image")]
    rows = []
    for name in names:
        row = [f"`{name}`"]
        for kind, run, m in columns:
            row.append(bakeoff_cell(kind, run, m, name))
        rows.append(row)
    return [
        "## Tempo estimator bake-off",
        "",
        "Each estimator's figures from the runs below, side by side: correct / n counts a "
        "withheld tempo as not correct, so estimators that answer different clips stay "
        "comparable; the paired tests on the same clips are in each run. A cell for an "
        "estimator trained on that dataset is marked and is not evidence about new music. The "
        "golden-set columns are agreement with Deezer's own estimate, not accuracy.",
        "",
        *table(head, rows),
        "",
        *lifted_lines(tempo),
    ]


def lifted_lines(tempo_runs: list[dict]) -> list[str]:
    """What the same runs give with the withholding rules lifted, from their `lifted` blocks."""
    out = []
    for run in tempo_runs:
        for key, what in (
            ("steadinessOnly", "with only the steadiness check lifted"),
            ("everyRule", "with every withholding rule lifted"),
        ):
            view = (run.get("lifted") or {}).get(key)
            if not view:
                continue
            cells = []
            for name, summary in view["summaries"].items():
                mark = " (trained on this dataset)" if name in run.get("trainedOn", []) else ""
                cells.append(f"`{name}` {frac(summary['overN']['acc1'])}{mark}")
            out.append(
                f"- {run['dataset']['name']}, {what} (calibration, not served): Acc1 correct / n "
                + "; ".join(cells)
                + "."
            )
    if out:
        out = [
            "The figures above are as the service serves them. The withholding rules cost the "
            "estimators unequally (see each run's Withheld table):",
            "",
            *out,
            "",
        ]
    return out


def bakeoff_cell(kind: str, run: dict, metric: str, name: str) -> str:
    if kind == "tempo":
        s = run["summaries"].get(name)
        if s is None:
            return "not run"
        cell = frac(s["overN"][metric])
        return cell + " (trained on this dataset)" if name in run.get("trainedOn", []) else cell
    if kind == "golden":
        block = run["agreement"].get("deezer-bpm-unseen") or run["agreement"]["deezer-bpm"]
        s = block["summaries"].get(name)
        return "not run" if s is None else frac(s["overN"][metric])
    m = run["memory"].get(name)
    if m is None:
        return "not run"
    if metric == "rss":
        return human(m["peakRssBytes"])
    if metric == "time":
        median = m["perClip"]["medianWallSeconds"]
        return "–" if median is None else f"{median:.2f} s"
    return image_cost(run, name)


def image_cost(run: dict, name: str) -> str:
    image = run["install"][name]["serviceImage"]
    models = (run.get("modelFiles") or {}).get(name)
    if not image["packages"] and not models:
        return "nothing (already in the image)"
    extra = f" + {human(models['bytes'])} model" if models else ""
    return f"{human(image['installedBytes'])} installed{extra}"


# --- the default estimator -------------------------------------------------------------------

CRITERION = (
    "an estimator replaces the default when, on data it was not trained on, it gives more "
    "correct tempos (Acc1: within 4 %) over n than the default as the service serves them "
    "(withholding rules included), with an exact McNemar p under 0.05 on the same clips, and its cost to the "
    "image, the memory and the analysis time is worth that gain. The cost is weighed, not "
    "thresholded."
)


def find_pair(pairs: list[dict], a: str, b: str) -> tuple[dict, bool] | None:
    """The pair of `a` and `b` and whether it is stored as (b, a)."""
    for pair in pairs:
        if (pair["first"], pair["second"]) == (a, b):
            return pair, False
        if (pair["first"], pair["second"]) == (b, a):
            return pair, True
    return None


def versus(pairs: list[dict], candidate: str, default: str, metric: str) -> dict | None:
    """Candidate and default correct over all n, their discordant pairs and the McNemar p."""
    found = find_pair(pairs, candidate, default)
    if found is None:
        return None
    pair, flipped = found
    r = pair["allN"]["metrics"][metric]
    c, d = (
        (r["secondCorrect"], r["firstCorrect"])
        if flipped
        else (r["firstCorrect"], r["secondCorrect"])
    )
    return {"candidate": c, "default": d, "n": pair["allN"]["n"], "p": r["mcnemarP"]}


def versus_cell(v: dict | None) -> str:
    if v is None:
        return "–"
    return f"{v['candidate']} vs {v['default']} of {v['n']}, p {pval(v['p'])}"


def default_section(doc: dict) -> list[str]:
    tempo = [r for r in doc["runs"] if r["suite"] == "tempo" and r.get("serviceDefault")]
    if not tempo:
        return []
    default = tempo[0]["serviceDefault"]
    candidates = [n for r in tempo for n in r["summaries"] if n != default]
    candidates = list(dict.fromkeys(candidates))
    if not candidates:
        return []
    golden = next((r for r in doc["runs"] if r["suite"] == "golden"), None)
    cost = next((r for r in doc["runs"] if r["suite"] == "cost"), None)
    rows, served_wins, lifted_wins = [], [], []
    for name in candidates:
        for run in tempo:
            if name not in run["summaries"] or name in run.get("trainedOn", []):
                continue
            lifted = run.get("lifted") or {}
            served = [versus(run["paired"], name, default, m) for m in ("acc1", "acc2")]
            steady = versus(
                (lifted.get("steadinessOnly") or {}).get("paired", []), name, default, "acc1"
            )
            every = versus((lifted.get("everyRule") or {}).get("paired", []), name, default, "acc1")
            rows.append(
                [f"`{name}`", run["dataset"]["name"]]
                + [versus_cell(v) for v in (*served, steady, every)]
            )
            # The criterion is Acc1; Acc2 (octave and meter errors forgiven) is context.
            served_wins += [
                (name, run, v)
                for v in served[:1]
                if v and v["p"] < 0.05 and v["candidate"] > v["default"]
            ]
            lifted_wins += [
                (name, run, v)
                for v in (steady, every)
                if v and v["p"] < 0.05 and v["candidate"] > v["default"]
            ]
        if golden:
            block = (
                golden["agreement"].get("deezer-bpm-unseen") or golden["agreement"]["deezer-bpm"]
            )
            agree = [versus(block["paired"], name, default, m) for m in ("acc1", "acc2")]
            if name in block["summaries"] and any(agree):
                rows.append(
                    [f"`{name}`", "golden previews, agreement with Deezer `bpm`"]
                    + [versus_cell(v) for v in agree]
                    + ["–", "–"]
                )
    head = [
        "candidate",
        f"data (against `{default}`)",
        "as served: Acc1",
        "as served: Acc2",
        "steadiness check lifted: Acc1",
        "every rule lifted: Acc1",
    ]
    out = [
        "## Default estimator",
        "",
        f"The service's default tempo and key estimator is `{default}` (what "
        "`estimators.select_estimator()` picks when `AUDIO_ESTIMATOR` is not set, with Essentia "
        "installed as in the service's image).",
        "",
        f"Criterion: {CRITERION}",
        "",
        f"Evidence in this report, each candidate against `{default}` on the same clips "
        "(correct / n of each, exact McNemar p), on data the candidate was not trained on:",
        "",
        *table(head, rows),
        "",
    ]
    if cost:
        out += cost_lines(cost, default, candidates) + [""]
    out += decision_lines(default, candidates, served_wins, lifted_wins, cost)
    return out


def cost_lines(cost: dict, default: str, candidates: list[str]) -> list[str]:
    out = []
    base = cost["memory"].get(default)
    for name in candidates:
        m = cost["memory"].get(name)
        if m is None or base is None:
            continue
        a, b = m["perClip"]["medianCpuSeconds"], base["perClip"]["medianCpuSeconds"]
        ratio = f" ({a / b:.2g} times as much)" if a and b else ""
        out.append(
            f"- Cost of `{name}` against `{default}`: {a} s against {b} s of CPU per analysed "
            f"clip{ratio}; peak RSS {human(m['peakRssBytes'])} against "
            f"{human(base['peakRssBytes'])}; it adds {image_cost(cost, name)} to the service "
            f"image, where `{default}` adds {image_cost(cost, default)}."
        )
    return out


def decision_lines(default, candidates, served_wins, lifted_wins, cost) -> list[str]:
    if served_wins:
        names = ", ".join(sorted({f"`{n}`" for n, _, _ in served_wins}))
        return [
            f"As served, {names} meets the accuracy part of the criterion on data it was not "
            "trained on; whether its cost is worth it is the open decision.",
            "",
        ]
    out = [
        f"Decision: the service keeps `{default}` under the current withholding rules. As "
        "served, no candidate gives significantly more correct tempos on data it was not "
        "trained on",
    ]
    if cost:
        out[0] += ", and the cost weighs against a change"
    no_key = [n for n in candidates if n == "beat-this"]
    if no_key:
        out[0] += (
            " (beat-this also has no key: the service would need it for tempo and another estimator for key)"
        )
    out[0] += "."
    if lifted_wins:
        name, run, v = lifted_wins[0]
        out[0] += (
            f" With the withholding rules lifted, `{name}` is ahead on {run['dataset']['name']} "
            f"({v['candidate']} vs {v['default']} of {v['n']}, p {pval(v['p'])}), so the "
            "default is to be revisited once those rules, the steadiness check first, are "
            "recalibrated."
        )
    return out + [""]


def agreement_table(suite: str, block: dict) -> list[str]:
    metrics = METRICS[suite]
    head = ["estimator", "n", "answered (coverage)"]
    for m in metrics:
        head += [f"{METRIC_LABELS[m]}: agrees / n", f"{METRIC_LABELS[m]}: agrees / answered"]
    rows = []
    for name, s in block["summaries"].items():
        row = [f"`{name}`", str(s["n"]), frac(s["coverage"])]
        for m in metrics:
            row += [frac(s["overN"][m]), frac(s["overAnswered"][m])]
        rows.append(row)
    return table(head, rows) + [""]


AGREEMENT_SECTIONS = (
    (
        "deezer-bpm",
        "tempo",
        "Tempo agreement with Deezer's `bpm`",
        "On the previews whose Deezer entry carries a `bpm` (0 counts as missing). Deezer does "
        "not say how its value is made; it is a sourced hint, not a reference.",
    ),
    (
        "deezer-bpm-unseen",
        "tempo",
        "Tempo agreement with Deezer's `bpm`, without the songs beat-this was trained on",
        "The same, on the previews whose song is not in beat-this's training data (listed "
        "under Data), for every estimator, so the pairs stay on the same tracks.",
    ),
    (
        "sheet-music-bpm",
        "tempo",
        "Tempo agreement with the sheet-music tempo",
        "On the golden rows with a tempo label: the metronome marking of the published sheet "
        "music (nominal, not measured from the recording; `evals/golden.jsonl` names each "
        "source).",
    ),
    (
        "sheet-music-key",
        "key",
        "Key agreement with the sheet-music key",
        "On the golden rows with a key label: the published sheet music's key (nominal). "
        "beat-this has no key.",
    ),
)


def golden_sections(run: dict) -> list[str]:
    ds = run["dataset"]
    out = [f"## {ds['title']}", ""]
    out += run_header(
        run, "the fingerprint models were loaded: the styles below come from them"
    ) + [""]
    unavailable = ds["previewUnavailable"]
    rows = [
        ["golden file", f"`{ds['file']}`, {ds['rows']} rows, SHA-256 `{ds['fileSha256']}`"],
        ["selected", str(ds["selected"])],
        ["previews analysed", str(ds["previewsAnalysed"])],
        [
            "no preview",
            str(len(unavailable))
            + (
                " (" + "; ".join(f"{k}: {v}" for k, v in unavailable.items()) + ")"
                if unavailable
                else ""
            ),
        ],
        ["previews with a Deezer `bpm`", str(ds["deezerBpm"])],
        *[[f"source: {what}", url] for what, url in ds["sources"]],
        ["audio", ds["audioRights"]],
        ["labels", ds["labelRights"]],
        ["Discogs labels cached in", f"`{ds['labelSource']}` (outside the repository)"],
    ]
    for name, songs in (run.get("trainedOn") or {}).items():
        if songs:
            rows.append(
                [
                    f"selected songs found in `{name}`'s training data (a lower bound)",
                    f"{len(songs)}: " + "; ".join(f"{k} ({v})" for k, v in songs.items()),
                ]
            )
    out += ["### Data", ""] + table(["", ""], rows) + [""]
    out += [
        "- Deezer's previews come and go (by day and by the country of the request): a run on "
        "another day can analyse a different set, so every n below belongs to this run's date.",
    ]
    if run.get("trainedOnNote"):
        out.append(f"- {run['trainedOnNote']}")
    out += [""]
    credits = ds["credits"] + run.get("estimatorCredits", [])
    out += ["Credits:", ""] + [f"- {c}" for c in credits] + [""]
    if run.get("failed"):
        out += ["Failed analyses:", ""]
        out += [f"- {f['trackId']}: {f['error']}" for f in run["failed"]] + [""]
    out += grouped_decode_section(run)
    for key, suite, title, note in AGREEMENT_SECTIONS:
        if key not in run["agreement"]:
            continue
        block = run["agreement"][key]
        out += [f"### {title}", "", note + f" n = {block['n']}.", ""]
        if not block["n"] or not block["summaries"]:
            out += ["Nothing to compare.", ""]
            continue
        out += agreement_table(suite, block)
        out += training_songs_note(run, block) + octave_note(run, key, block)
        for pair in pair_list(block.get("paired")):
            out += [f"`{pair['first']}` and `{pair['second']}` on the same tracks:", ""]
            out += pair_table(suite, pair)
    out += styles_section(run["styles"])
    return out


def training_songs_note(run: dict, block: dict) -> list[str]:
    """Which tracks of an agreement table an estimator was trained on."""
    tracks = {r["trackId"] for rows in block["tracks"].values() for r in rows}
    out = []
    for name, songs in (run.get("trainedOn") or {}).items():
        inside = sorted(t for t in songs if t in tracks)
        if inside and name in block["summaries"]:
            out.append(
                f"This table includes {len(inside)} song(s) `{name}` was trained on: "
                + ", ".join(inside)
                + "."
            )
    return out + [""] if out else []


def octave_note(run: dict, key: str, block: dict) -> list[str]:
    """Deezer tables: the answers that agree only up to octave or meter, with both values."""
    if not key.startswith("deezer-bpm"):
        return []
    deezer = {c["trackId"]: c.get("deezerBpm") for c in run["clips"]}
    parts = []
    for name, rows in block["tracks"].items():
        for r in rows:
            scores = r.get("scores") or {}
            if scores.get("acc1") == 0.0 and scores.get("acc2") == 1.0:
                parts.append(
                    f"`{name}` {r['trackId']} {r['estimate']} against {deezer.get(r['trackId'])}"
                )
    if not parts:
        return []
    return [
        "Answers that agree with Deezer only up to octave or meter (Acc2, not Acc1), which "
        "can be Deezer's octave as well as the estimator's: " + "; ".join(parts) + ".",
        "",
    ]


def styles_section(st: dict) -> list[str]:
    out = [
        "### Styles: hit@k against Discogs",
        "",
        f"`{st['model']}`'s styles on {st['n']} previews whose release has Discogs styles; "
        f"the service returned a fingerprint for {frac(st['coverage'])}. Over n, a preview "
        "without a fingerprint counts as no hit.",
        "",
    ]
    if st["noLabel"]:
        out += [
            "Previews left out (no Discogs styles): "
            + "; ".join(f"{k}: {v}" for k, v in st["noLabel"].items())
            + ".",
            "",
        ]
    if not st["n"]:
        return out + ["Nothing to score.", ""]
    head = [
        "k",
        "hit@k over n",
        "hit@k over answered",
        "constant baseline over n",
        "tracks only the model / only the baseline hits",
        "test",
        "best constant, chosen with the labels (reference)",
    ]
    rows = []
    for k, h in st["hits"].items():
        v = st["versusBaseline"][k]
        rows.append(
            [
                k,
                frac(h["overN"]),
                frac(h["overAnswered"]),
                frac(h["baselineOverN"]),
                f"{v['onlyModel']} / {v['onlyBaseline']}",
                f"McNemar exact p {pval(v['mcnemarP'])}",
                frac(h["bestConstantOverN"]),
            ]
        )
    out += table(head, rows) + [""]
    out += [
        "- The constant baseline (the model's average output over the top-10 lists of these "
        "previews; it uses no label and is not the strongest constant), strongest first: "
        + ", ".join(f"`{s}`" for s in st["baseline"])
        + ".",
        "- The best constant, chosen by greedy cover with the labels of these very previews, so "
        "an optimistic reference rather than a baseline: "
        + ", ".join(f"`{s}`" for s in st["bestConstant"])
        + ".",
        f"- {st['outsideTaxonomy']} of the {st['n']} releases have no genre and style pair "
        "among the model's 400 styles, so no top-k can hit them.",
    ]
    differ = sum(1 for t in st["tracks"] if t["stylesDiffer"])
    if differ:
        out.append(f"- The fingerprint differed between estimator runs on {differ} previews.")
    return out + [""]


def cost_section(run: dict) -> list[str]:
    ds = run["dataset"]
    machine = run["machine"]
    threads = ", ".join(f"{k}={v}" for k, v in (machine.get("threads") or {}).items())
    out = [f"## Cost: tempo estimators on {ds['title']} clips", ""]
    out += run_header(run, "the fingerprint models were not loaded") + [
        f"- Machine: {machine['cpu']}, {machine['cpus']} CPUs, {machine['system']}; each "
        f"estimator in its own fresh process, one after the other, with {threads}.",
        "",
    ]
    head = [
        "estimator",
        "RSS, service imported",
        "RSS, estimator ready",
        "RSS after the first analysed clip",
        "peak RSS",
        "ready in",
        "first analysed clip (wall / CPU)",
        "later analysed clips: median wall / CPU, max wall",
        "clips the periodicity minimum stopped",
    ]
    rows = []
    for name, m in run["memory"].items():
        first, later = m["firstAnalysed"], m["perClip"]
        rows.append(
            [
                f"`{name}`",
                human(m["rssServiceBytes"]),
                human(m["rssReadyBytes"]),
                "–" if m["rssAfterFirstBytes"] is None else human(m["rssAfterFirstBytes"]),
                human(m["peakRssBytes"]),
                f"{m['readySeconds']:.2f} s",
                "–"
                if first is None
                else f"{first['wallSeconds']:.2f} / {first['cpuSeconds']:.2f} s ({first['trackId']})",
                "–"
                if later["n"] == 0
                else f"{later['medianWallSeconds']:.2f} / {later['medianCpuSeconds']:.2f} s, "
                f"max {later['maxWallSeconds']:.2f} s (n = {later['n']})",
                str(m["stoppedByPeriodicity"]),
            ]
        )
    out += table(head, rows) + [""]
    install_head = [
        "estimator",
        "adds to the service image: packages",
        "installed",
        "wheels",
        "model files",
        "adds to the harness's base install",
    ]
    install_rows = []
    for name, i in run["install"].items():
        image = i["serviceImage"]
        models = (run.get("modelFiles") or {}).get(name)
        install_rows.append(
            [
                f"`{name}`",
                str(len(image["packages"])),
                human(image["installedBytes"]),
                "unknown" if image["wheelBytes"] is None else human(image["wheelBytes"]),
                f"{models['file']}, {human(models['bytes'])}" if models else "none",
                human(i["installedBytes"]),
            ]
        )
    out += table(install_head, install_rows) + [""]
    out += [
        f"Measured on {len(run['clips'])} clips ({run['selection']}). Each clip's tempo is "
        "computed on freshly decoded signals, so a call includes what the estimator needs (the "
        "onset envelope, its model). A clip the onset-periodicity minimum stops never reaches "
        "the estimator's own work (as in the service); those clips are counted and not timed. "
        "The first clip that does reach it pays the one-time costs (numba compilation for "
        "librosa, the first pass through a model) and is shown apart, with its id and the "
        "memory right after it; the peak includes that one-time memory. The service's own "
        "process also holds the fingerprint models and computes the gate, loudness and "
        "sections, which are not counted here. RSS is the resident memory of the process; the "
        "service figure includes Essentia's libraries when they are installed.",
        "",
        "The service image installs the `models` extra (essentia-tensorflow, for the "
        "fingerprint) whatever the estimator, so Essentia adds nothing to it; an estimator's "
        "image cost is the packages its extra needs that the service's lock does not have.",
        "",
    ]
    for name, i in run["install"].items():
        if i["serviceImage"]["packages"]:
            out.append(
                f"- `{name}` (extra `{i['extra']}`) adds to the service image: "
                + ", ".join(
                    f"{p['name']} {p['version']} ({human(p['installedBytes'])})"
                    for p in i["serviceImage"]["packages"]
                )
                + "."
            )
    credits = run.get("estimatorCredits") or []
    if credits:
        out += ["", "Credits:", ""] + [f"- {c}" for c in credits]
    return out + [""]


def tempo_key_sections(run: dict, legacy: bool) -> list[str]:
    seeds = run["seeds"]
    out = [
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
    out += ["### Accuracy", ""] + verdicts(run) + [""]
    if run.get("estimatorNotes"):
        out += [f"- {note}" for note in run["estimatorNotes"]] + [""]
    out += summary_table(run) + [""]
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
    return out


def render(doc: dict) -> str:
    legacy = is_legacy(doc)
    out = [f"# Audio accuracy, {doc['date']}", "", *intro(doc), *guide(doc)]
    if not legacy:
        out += bakeoff_section(doc) + default_section(doc)
    for run in doc["runs"]:
        if run["suite"] == "golden":
            out += golden_sections(run)
        elif run["suite"] == "cost":
            out += cost_section(run)
        else:
            out += tempo_key_sections(run, legacy)
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

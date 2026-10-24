"""
The report's calibration section, rendered from the calibration and controls runs alone: the
choice is made again from the recorded clips (calibration.select), so every number in the
section can be re-derived from the JSON.
"""

from __future__ import annotations

from . import calibration as cal
from .metrics import wilson

KIND_RIGHT = {"tempo": "Acc1", "key": "exact"}
KIND_GROSS = {
    "tempo": "wrong even forgiving octave and meter (Acc2)",
    "key": "unrelated to the reference key (MIREX 0)",
}
SEED = 1  # the AUC's Monte Carlo permutations, when not exact


def runs_of(doc: dict) -> tuple[list[dict], dict | None]:
    runs = [r for r in doc["runs"] if r["suite"] == "calibration"]
    controls = next((r for r in doc["runs"] if r["suite"] == "controls"), None)
    return runs, controls


def pval(p: float) -> str:
    return "< 0.001" if p < 0.001 else f"= {p:.3f}"


def share(k: int, n: int) -> str:
    """'29/37 = 78.4 % [62.8, 88.6]' (Wilson 95 %), or '–' for nothing."""
    if not n:
        return "–"
    w = wilson(k, n)
    return f"{k}/{n} = {100 * k / n:.1f} % [{100 * w.low:.1f}, {100 * w.high:.1f}]"


def table(head: list[str], rows: list[list[str]]) -> list[str]:
    return [
        "| " + " | ".join(head) + " |",
        "|" + "---|" * len(head),
        *("| " + " | ".join(r) + " |" for r in rows),
    ]


def value_label(family: str, value) -> str:
    if family == "onset":
        return "on" if value else "off"
    if family == "lines":
        return "on" if value else "off (the key strength decides)"
    if family == "drift":
        return "none" if value is None else f"{value[0]:g} s windows, {value[1]:g}"
    if family == "classes":
        return f"{value[0]}, {value[1]:g}"
    if family == "confidence" and abs(value - 1.5 / 5.32) < 1e-9:
        return "1.5/5.32 (0.282)"
    return f"{value:g}"


def count_p_values(doc: dict) -> int:
    """The p-values this section prints: one McNemar per evaluation row, one per AUC line."""
    runs, controls = runs_of(doc)
    if not runs:
        return 0
    rules = after_rules(runs)
    rows = cal.evaluate(runs, cal.BASELINE, rules)
    aucs = [
        a
        for split in ("calibration", "evaluation")
        for a in cal.octave_ranking(runs, rules, split, SEED)
        if a["p"] is not None
    ]
    return len(rows) + len(aucs)


def after_rules(runs: list[dict]) -> cal.Rules:
    """The service's values the runs were made with (the first run's; the others must agree)."""
    return cal.Rules.from_dict(runs[0]["rules"])


def section(doc: dict) -> list[str]:
    runs, controls = runs_of(doc)
    if not runs or controls is None:
        return []
    after = after_rules(runs)
    agree = all(r["rules"] == runs[0]["rules"] for r in [*runs, controls])
    commits = sorted({r["gitCommit"] for r in [*runs, controls]})
    choice = cal.select(runs, controls["controls"])
    confirmation = cal.confirm(runs, controls["controls"], choice)
    selected = cal.Rules.from_dict(choice["rules"])
    confirmed = cal.Rules.from_dict(confirmation["rules"])
    kinds = {r["kind"] for r in runs}
    out = [
        "## Calibration of the withholding rules",
        "",
        "The service withholds a tempo or a key when its rules say the evidence is too weak "
        "(the steadiness check, the confidence and periodicity minimums, the key evidence rule "
        "and the key strength minimum). This section sets those rules from measured results: on "
        "the annotated clips of the calibration runs below and on generated controls whose "
        "truth is known by construction. Each selected clip is a **calibration** clip or an "
        "**evaluation** clip, fixed by a SHA-256 of the dataset and its track id (about half "
        "each). Values were chosen on the calibration clips only; the evaluation clips are "
        "scored once, below, and took no part in a choice. The choice is made again here from "
        "the recorded clips (`evals_audio.calibration.select`), so it can be checked against "
        "the values the service has.",
        "",
        f"- Acceptance, fixed before any evaluation clip was scored. A **loosening** (answers "
        f"the old value withheld) is kept only when its extra answers are right ({KIND_RIGHT['tempo']} "
        f"for tempo, exact for key) with a Wilson 95 % lower bound of at least "
        f"{100 * cal.L1_MIN_LOWER:g} % (L1), at most {100 * cal.L2_MAX_DROP:g} points less often "
        f"than the old answers (L2), and wrong even forgiving octave and meter (key: unrelated) "
        f"at most {100 * cal.L3_MAX_GROSS_RISE:g} points more often (L3). A **tightening** is "
        f"kept only when it removes a value a control shows wrongly (T1), lowers correct / n by "
        f"at most {100 * cal.T2_MAX_DROP:g} points on each dataset and withholds answers that "
        "are right less often than those it keeps (T2). Either way no control may go from right "
        "to wrong. Among accepted loosenings the one answering most clips is taken; among "
        "accepted tightenings the one fixing most controls, then withholding fewest answers, "
        "then the least strict. Rules the service keeps per estimator are decided on that "
        "estimator's clips; a shared rule must pass for both; beat-this is shown under the "
        "service's rules and decides nothing.",
        "- Each change chosen this way is then judged again, with the same criteria, on the "
        "evaluation clips and the controls; a change that fails there is reverted to the value "
        "before it, and the service is to hold what remains.",
        "- The families are taken in turn, each with the earlier choices in place: "
        + "; ".join(f"{f['title']}" for f in choice["families"])
        + ".",
        "- Before means the service's values at commit `ec7d24b`; after means the values the "
        f"runs were made with (commit {', '.join(f'`{c}`' for c in commits)})."
        + ("" if agree else " The runs were not all made with the same values: see each run."),
        "",
    ]
    out += clips_table(runs, controls)
    out += mismatch_lines(runs, controls)
    out += choice_section(choice)
    out += confirmation_section(confirmation)
    out += agreement_table(selected, confirmed, after, kinds)
    out += evaluation_section(runs, after)
    out += controls_section(controls, after)
    out += octave_section(runs, after)
    out += gate_section(runs, controls)
    return out


def clips_table(runs: list[dict], controls: dict) -> list[str]:
    rows = []
    for run in runs:
        splits = run["splits"]
        rows.append(
            [
                run["dataset"]["title"],
                run["kind"],
                ", ".join(f"`{n}`" for n in run["estimators"]),
                str(splits.get("calibration", 0)),
                str(splits.get("evaluation", 0)),
                f"`{run['command']}`",
            ]
        )
    rows.append(
        [
            "generated controls",
            "tempo, key, gate",
            ", ".join(f"`{n}`" for n in controls["estimators"]),
            str(len(controls["controls"])),
            "–",
            f"`{controls['command']}`",
        ]
    )
    return [
        "### Clips",
        "",
        *table(["data", "rules", "estimators", "calibration", "evaluation", "command"], rows),
        "",
        "Each calibration run records, per clip and estimator, what the service served and the "
        "estimate with every rule lifted, with the measurements each rule compares (the "
        "confidence, onset periodicity, each third's beat and onset tempo, the beat drift; the "
        "key strength, the share of energy in spectral lines, the pitch classes they spell and "
        "the pitch track's verdicts). Its scores against the reference are kept; the reference "
        "is not.",
        "",
    ]


def mismatch_lines(runs: list[dict], controls: dict) -> list[str]:
    """The derivation check: decisions re-derived at the service's values against the served."""
    parts, total, pairs = [], 0, 0
    for run in runs:
        rules = cal.Rules.from_dict(run["rules"])
        bad = cal.mismatches(run["clips"], run["estimators"], run["kind"], rules)
        for name, ids in bad.items():
            total += len(ids)
            pairs += sum(1 for c in run["clips"] if cal.usable(c, name, run["kind"]))
            if ids:
                parts.append(f"{run['dataset']['name']} `{name}`: {', '.join(ids)}")
    rules = cal.Rules.from_dict(controls["rules"])
    items = [{**c, "trackId": c["name"]} for c in controls["controls"]]
    for kind in ("tempo", "key"):
        for name, ids in cal.mismatches(items, controls["estimators"], kind, rules).items():
            total += len(ids)
            pairs += sum(1 for c in items if cal.usable(c, name, kind))
            if ids:
                parts.append(f"controls {kind} `{name}`: {', '.join(ids)}")
    line = (
        "Derivation check: re-derived from the recorded measurements at the service's own "
        f"values, the decision differs from what the service served on {total} of {pairs} "
        "clip and estimator pairs"
    )
    return [line + (": " + "; ".join(parts) if parts else "."), ""]


def candidate_cells(family: str, kind: str, row: dict) -> list[str]:
    p = row["pooled"]
    verdict = row["verdict"]
    changes = row["controls"]
    if not (p["extra"] or p["lost"] or changes["fixed"] or changes["broken"]):
        status = "no change"
    elif verdict["accepted"]:
        status = "passes"
    else:
        status = "fails " + ", ".join(verdict["failed"])
    return [
        str(p["new"]),
        f"{p['newRight']} (before {p['oldRight']})",
        share(p["extraRight"], p["extra"]),
        f"{p['extraGross']}" if p["extra"] else "–",
        f"{p['lost']} ({p['lostRight']} right)" if p["lost"] else "–",
        ", ".join(changes["fixed"]) or "–",
        ", ".join(changes["broken"]) or "–",
        status,
    ]


def choice_section(choice: dict) -> list[str]:
    out = ["### The choice, rule by rule (calibration clips and controls)", ""]
    for fam in choice["families"]:
        family, kind = fam["family"], fam["kind"]
        out += [f"#### {fam['title'][0].upper()}{fam['title'][1:]}", ""]
        for group in fam["groups"]:
            name = group["estimator"]
            head = [
                "value",
                "answered",
                f"{KIND_RIGHT[kind]} correct",
                f"extra answers: {KIND_RIGHT[kind]} right",
                "extra answers: gross errors",
                "answers withheld",
                "controls fixed",
                "controls broken",
                "verdict",
            ]
            rows = []
            for cand in group["candidates"]:
                if name is None:
                    for est, row in cand["rows"].items():
                        rows.append(
                            [f"{value_label(family, cand['value'])} (`{est}`)"]
                            + candidate_cells(family, kind, row)
                        )
                else:
                    rows.append(
                        [value_label(family, cand["value"])] + candidate_cells(family, kind, cand)
                    )
            who = "shared by both estimators" if name is None else f"`{name}`"
            if group.get("shown"):
                who += " (shown under the service's rules; it decides nothing)"
            out += [f"{who}:", "", *table(head, rows), ""]
            if group.get("shown"):
                continue
            before, chosen = group["before"], group["chosen"]
            if chosen == before:
                out += [f"Kept: {value_label(family, before)}.", ""]
            else:
                out += [
                    f"Chosen: {value_label(family, chosen)} (before: "
                    f"{value_label(family, before)}).",
                    "",
                ]
    out += [
        "In each table *answered* and *correct* are over all calibration clips of the rule's "
        "datasets, with the value in place; *extra answers* are those the value gives and the "
        "previous one withheld, *answers withheld* the reverse. Gross errors: "
        f"tempo {KIND_GROSS['tempo']}, key {KIND_GROSS['key']}.",
        "",
    ]
    return out


BOTH = ("librosa", "essentia")
FIELDS = (
    ("onset_check", "steadiness check: onset-tempo part", BOTH, "tempo"),
    ("steady_tolerance", "steadiness check: tolerance", None, "tempo"),
    ("drift", "steadiness check: beat drift", BOTH, "tempo"),
    ("min_confidence", "tempo confidence minimum", BOTH, "tempo"),
    ("min_periodicity", "onset periodicity minimum", None, "tempo"),
    ("min_strength", "key strength minimum", BOTH, "key"),
    ("line_rules_with_beat", "key evidence over a beat: spectral-line rules", BOTH, "key"),
    ("min_tonal_ratio", "key evidence: spectral-line share", None, "key"),
    ("class_vector", "key evidence: pitch classes from", None, "key"),
    ("class_level", "key evidence: pitch-class level", None, "key"),
)
FIELD_FAMILY = {
    "onset_check": "onset",
    "drift": "drift",
    "line_rules_with_beat": "lines",
    "min_confidence": "confidence",
}


def field_value(rules: cal.Rules, field: str, name: str | None) -> str:
    value = rules.get(field, name)
    family = FIELD_FAMILY.get(field, "")
    if family:
        return value_label(family, value)
    return str(value) if isinstance(value, str) else f"{value:g}"


def confirmation_section(confirmation: dict) -> list[str]:
    head = [
        "rule",
        "estimator",
        "change",
        "extra answers right",
        "extra answers: gross errors",
        "answers withheld",
        "controls fixed",
        "controls broken",
        "verdict",
    ]
    rows = []
    for change in confirmation["changes"]:
        family = change["family"]
        for name, row in change["rows"].items():
            p, c = row["pooled"], row["controls"]
            failed = row["verdict"]["failed"]
            withheld = (
                f"{p['lost']} ({p['lostRight']} right; kept: {share(p['keptRight'], p['kept'])})"
                if p["lost"]
                else "–"
            )
            rows.append(
                [
                    change["title"],
                    f"`{name}`",
                    f"{value_label(family, change['before'])} → "
                    f"{value_label(family, change['chosen'])}",
                    share(p["extraRight"], p["extra"]),
                    str(p["extraGross"]) if p["extra"] else "–",
                    withheld,
                    ", ".join(c["fixed"]) or "–",
                    ", ".join(c["broken"]) or "–",
                    ("passes" if not failed else "fails " + ", ".join(failed))
                    + ("" if change["confirmed"] else "; reverted"),
                ]
            )
    return [
        "### Each change on the evaluation clips",
        "",
        f"Each change judged again on the evaluation clips ({KIND_RIGHT['tempo']} for tempo, "
        "exact for key), pooled over the rule's datasets, with the same criteria and controls.",
        "",
        *table(head, rows),
        "",
    ]


def agreement_table(
    selected: cal.Rules, confirmed: cal.Rules, after: cal.Rules, kinds: set
) -> list[str]:
    rows, differ = [], 0
    for field, title, names, kind in FIELDS:
        for name in names or (None,):
            label = title + (f" (`{name}`)" if name else "")
            b = field_value(cal.BASELINE, field, name)
            a = field_value(after, field, name)
            if kind not in kinds:
                rows.append([label, b, "–", "–", a, "–"])
                continue
            s = field_value(selected, field, name)
            c = field_value(confirmed, field, name)
            differ += c != a
            rows.append([label, b, s, c, a, "yes" if c == a else "**no**"])
    note = (
        "The service holds the values that remain after the evaluation check."
        if not differ
        else f"The service's values differ from those that remain in {differ} rows: the "
        "choice was not applied as made, or the runs predate a change."
    )
    if kinds != {"tempo", "key"}:
        note += " Rules of a kind without a calibration run here are not judged (–)."
    head = [
        "rule",
        "before",
        "chosen on the calibration clips",
        "after the evaluation check",
        "in the service",
        "same",
    ]
    return ["### Chosen values and the service's values", "", *table(head, rows), "", note, ""]


def evaluation_section(runs: list[dict], after: cal.Rules) -> list[str]:
    rows = []
    for r in cal.evaluate(runs, cal.BASELINE, after):
        trained = any(
            r["estimator"] in run.get("trainedOn", [])
            for run in runs
            if run["dataset"]["name"] == r["dataset"]
        )
        rows.append(
            [
                r["dataset"],
                f"`{r['estimator']}`" + (" (trained on this dataset)" if trained else ""),
                str(r["n"]),
                share(r["oldRight"], r["n"]),
                share(r["newRight"], r["n"]),
                f"{r['discordantNew']} / {r['discordantOld']}, McNemar exact p {pval(r['mcnemarP'])}",
                share(r["extraRight"], r["extra"]),
                f"{r['extraGross']} of {r['extra']}" if r["extra"] else "–",
                share(r["lostRight"], r["lost"]),
                share(r["keptRight"], r["kept"]),
            ]
        )
    head = [
        "data",
        "estimator",
        "evaluation clips",
        "correct / n before",
        "correct / n after",
        "clips right only after / only before",
        "extra answers right",
        "extra answers: gross errors",
        "answers withheld that were right",
        "answers kept that are right",
    ]
    return [
        "### Held-out evaluation (evaluation clips)",
        "",
        "The rules before against the rules after, on the same evaluation clips: correct / n "
        "(tempo Acc1, key exact; a withheld clip counts as not correct), the paired exact "
        "McNemar test on the clips only one side gets right, and the answers the change adds "
        "or withholds with how often they are right. Gross errors as above.",
        "",
        *table(head, rows),
        "",
    ]


def truth_label(value, kind: str) -> str:
    from .controls import ANY, NOT_SCORED

    if value == NOT_SCORED:
        return "not scored"
    if value is None:
        return "none"
    if value == ANY:
        return "a key"
    return f"{value:g}" if kind == "tempo" else f"{value[0]} {value[1]}"


def shown(value, kind: str) -> str:
    if value is None:
        return "–"
    return f"{value:.1f}" if kind == "tempo" else f"{value[0]} {value[1]}"


def controls_section(controls: dict, after: cal.Rules) -> list[str]:
    from .controls import GROUPS

    names = controls["estimators"]
    table_rows = cal.controls_table(controls["controls"], names, cal.BASELINE, after)
    counts = []
    for name in names:
        for kind in ("tempo", "key"):
            cells = [
                r["estimators"][name][kind]
                for r in table_rows
                if kind in r["estimators"].get(name, {})
            ]
            scored = [c for c in cells if c["okAfter"] is not None]
            if not scored:
                continue
            counts.append(
                [
                    f"`{name}`",
                    kind,
                    str(len(scored)),
                    str(sum(bool(c["okBefore"]) for c in scored)),
                    str(sum(bool(c["okAfter"]) for c in scored)),
                ]
            )
    head = ["control", "group", "truth: tempo", "truth: key", "truth: gate"]
    for name in names:
        head += [f"`{name}` tempo", f"`{name}` key"] if name != "beat-this" else [f"`{name}` tempo"]
    rows = []
    for r in table_rows:
        truth = r["truth"]
        row = [
            r["name"],
            r["group"],
            truth_label(truth["tempo"], "tempo"),
            truth_label(truth["key"], "key"),
            truth["gate"],
        ]
        for name in names:
            cells = r["estimators"].get(name, {})
            for kind in ("tempo", "key"):
                if name == "beat-this" and kind == "key":
                    continue
                c = cells.get(kind)
                if c is None:
                    row.append("–")
                    continue
                mark = "" if c["okAfter"] is None else (" ✓" if c["okAfter"] else " ✗")
                text = (
                    shown(c["after"], kind)
                    if c["before"] == c["after"]
                    else f"{shown(c['before'], kind)} → {shown(c['after'], kind)}"
                )
                row.append(text + mark)
        rows.append(row)
    groups = "; ".join(f"**{k}**: {v}" for k, v in GROUPS.items())
    return [
        "### Controls",
        "",
        "Generated signals whose truth is known by construction: the issue's lists of defects "
        "found with generated probes, and the probe sets of the service's own tests "
        "(`services/audio/tests`). Groups: " + groups + ". A truth of *none* means there is "
        "nothing to measure; *a key* means music in more than one key (any key is right, none "
        "is wrong). The values are derived before and after from the recorded measurements, as "
        "for the annotated clips.",
        "",
        *table(["estimator", "field", "scored controls", "right before", "right after"], counts),
        "",
        *table(head, rows),
        "",
        "✓ the value matches the truth, ✗ it does not; a → b is the value before and after; "
        "– is no value.",
        "",
    ]


def octave_section(runs: list[dict], after: cal.Rules) -> list[str]:
    rows = []
    for split in ("calibration", "evaluation"):
        for a in cal.octave_ranking(runs, after, split, SEED):
            if a["auc"] is None:
                continue
            rows.append(
                [
                    split,
                    a["dataset"],
                    f"`{a['estimator']}`",
                    f"{a['correct']} / {a['wrong']}",
                    f"{a['auc']:.2f}",
                    f"p {pval(a['p'])} ({a['pMethod']})" if a["p"] is not None else "–",
                ]
            )
    return [
        "### Octave and meter errors and the confidence",
        "",
        "Among the served tempos that are right forgiving octave and meter (Acc2), whether the "
        "confidence ranks the ones within 4 % (Acc1) above the octave and meter errors: the AUC "
        "is the chance that an Acc1-right tempo has the higher confidence (0.5 is no ranking), "
        "with a one-sided permutation p-value. A minimum on the confidence can only remove "
        "octave errors where it ranks them.",
        "",
        *table(
            ["clips", "data", "estimator", "Acc1 right / octave or meter error", "AUC", "test"],
            rows,
        ),
        "",
    ]


def gate_section(runs: list[dict], controls: dict) -> list[str]:
    rows = []
    for run in runs:
        gated = [
            clip["trackId"]
            for clip in run["clips"]
            if any(not e.get("error") and not e["gatePassed"] for e in clip["estimators"].values())
        ]
        rows.append([run["dataset"]["name"], str(len(run["clips"])), str(len(gated))])
    noise = [c for c in controls["controls"] if c["truth"]["gate"] == "noise"]
    gated = [
        c["name"]
        for c in noise
        if any(g and not g["passed"] for g in (c.get("servedGate") or {}).values())
    ]
    passed = [c["name"] for c in noise if c["name"] not in gated]
    return [
        "### The noise gate",
        "",
        *table(["data", "clips", "gated as noise or silence"], rows),
        "",
        f"Noise controls gated: {len(gated)} of {len(noise)} ({', '.join(gated) or 'none'}); "
        f"passed: {', '.join(passed) or 'none'}. Those that pass get no tempo and no key in the "
        "table above. Nothing here measures what a stricter gate would cost on speech, a "
        "cappella or solo instruments (the annotated sets hold none), so the gate's values are "
        "not changed by this calibration.",
        "",
    ]

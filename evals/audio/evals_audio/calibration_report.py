"""
The report's calibration section, rendered from the calibration and controls runs alone: the
choice is made again from the recorded clips (calibration.select), so every number in the
section can be re-derived from the JSON.
"""

from __future__ import annotations

from . import calibration as cal
from .metrics import mcnemar_exact, wilson

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
    if family == "tonal":
        return f"{value[0]}, {value[1]:g}"
    if family == "drift":
        return "none" if value is None else f"{value[0]:g} s windows, {value[1]:g}"
    if family == "classes":
        return f"{value[0]}, {value[1]:g}"
    if family == "confidence" and abs(value - 1.5 / 5.32) < 1e-9:
        return "1.5/5.32 (0.282)"
    return f"{value:g}"


# How this calibration's values came about, beyond the procedure (the plan the procedure was
# written in is not part of the repository).
PROTOCOL_NOTES = (
    "The procedure is applied as written before the calibration runs. After a first sweep of "
    "the calibration clips, revisions were proposed and used in a first version of this "
    "calibration: judging the key strength before the key evidence rules, a family that drops "
    "the spectral-line rules over a beat for Essentia, choosing the tightening that fixes most "
    "controls, and requiring a tightening to break no control. They were made after "
    "calibration results had been seen; the line-rule family decided that version's main "
    "result and let Essentia key a pitchless drum track (the service's own drum kit at 128 "
    "BPM, kit seed 3). None of them is used here.",
    'A second version read the plan\'s "librosa checked" as librosa shown only, where the '
    "first had read it as a veto; the change was made after the numbers had been seen. It let "
    "through a pitch-class level of 0.1, which gave keys to one pitched source (a one-note "
    "bass over drums, a church bell, a tabla), and a tolerance of 0.04 that librosa's clips "
    "reject. The veto is restored here, and no loosening is shipped.",
    "The evaluation clips were scored in each version: the first time from measurements "
    "rounded to six decimals, which made a 0.04 tolerance look as if it fixed a librosa control "
    "(one third was 0.96 of the tempo to the last bit). The values here follow from the "
    "written procedure on the full-precision recording, applying only changes that withhold "
    "more; none was chosen or changed in response to an evaluation score.",
    "Before the plan was written, earlier reports had shown why 39 of 50 GiantSteps+ keys were "
    "withheld, some of them on clips that are now evaluation clips; that is what drew "
    "attention to the key evidence rules.",
    "The pitchless controls drawn at 30 seeds each (two drum kits, noise with a beat, a siren "
    "over drums, clicks) were added after the drum track above was found, and the "
    "one-pitch-class ones (a one-note bass, octave riffs, bells alone and over drums, tabla, "
    "toms, a cowbell, a held synth note) after the level of 0.1 was. No value had been set on "
    "them; the choice sees them like the other controls.",
)

# Shown when the runs were made with the single-source rule (Rules.one_source).
ONE_SOURCE_NOTE = (
    "The single-source rule (no key for one pitched source, whose spectral lines keep their "
    "proportions over the window and rise and fall together: a cowbell, a bell, one note "
    "repeated on a bass) was added after this calibration, from the one-pitch-class controls "
    "and the GiantSteps+ keys the service gave without it. The procedure does not vary it: "
    "before is without it, after with it, and the choice below is made without it."
)


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
        "each). Values are chosen on the calibration clips and the controls; the evaluation "
        "clips judge each change once more. The choice is made again here from the recorded "
        "clips (`evals_audio.calibration.select`), so it can be checked against the values the "
        "service has.",
        "",
        f"- The procedure was written down before the calibration runs. A **loosening** (a "
        f"value under which a clip or a control gets a value it did not have) is accepted when "
        f"its extra answers on the annotated clips are right "
        f"({KIND_RIGHT['tempo']} for tempo, exact for key) with a Wilson 95 % lower bound of at "
        f"least {100 * cal.L1_MIN_LOWER:g} % (L1), at most {100 * cal.L2_MAX_DROP:g} points less "
        f"often than the old answers (L2), wrong even forgiving octave and meter (key: "
        f"unrelated) at most {100 * cal.L3_MAX_GROSS_RISE:g} points more often (L3); the "
        f"loosest value that passes is taken. A **tightening** is accepted when it removes a "
        f"value a control shows wrongly (T1), "
        f"lowers correct / n by at most {100 * cal.T2_MAX_DROP:g} points on each dataset and "
        "withholds answers that are right less often than those it keeps (T2); the least "
        "strict value that passes is taken. Either way, no control may go from right to wrong "
        "(L4). A rule the service keeps per estimator (the "
        "confidence and strength minimums) is decided on that estimator's clips; a shared rule "
        "on Essentia's (the default) and checked on librosa's: a change librosa's clips reject "
        "is not made. beat-this is shown under the service's rules and decides nothing.",
        "- Only changes that withhold more are shipped. A loosening the procedure picks is shown "
        "but not shipped: it rests on these clips alone, and two loosenings chosen this way in "
        "earlier versions of this calibration gave keys to material with no key.",
        "- Each change is then judged on the evaluation clips: a loosening that fails L1-L3 or "
        "a tightening that fails T2 there is reverted to the value before it. The controls are "
        "the ones the choice saw, so a change made for a control is not tested on new controls "
        "there; a change that alters no evaluation clip stays.",
        *(f"- {note}" for note in PROTOCOL_NOTES),
        *([f"- {ONE_SOURCE_NOTE}"] if after.one_source else []),
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
    out += gate_section(runs, controls, after)
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
    failed = [
        f"{run['dataset']['name']} {clip.get('trackId') or clip.get('name')} `{name}`"
        for run in [*runs, controls]
        for clip in run.get("clips") or run.get("controls") or []
        for name, entry in clip["estimators"].items()
        if entry.get("error")
    ]
    out = line + (": " + "; ".join(parts) if parts else ".")
    out += f" Records that failed and are left out of every table: {len(failed)}" + (
        f" ({'; '.join(failed)})." if failed else "."
    )
    return [out, ""]


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
            rows = [
                [value_label(family, cand["value"])] + candidate_cells(family, kind, cand)
                for cand in group["candidates"]
            ]
            if group.get("shown") and group.get("shared"):
                who = f"`{name}` (the check on a shared value: a change rejected here is not made)"
            elif group.get("shown"):
                who = f"`{name}` (shown under the service's rules; it decides nothing)"
            elif group.get("shared"):
                who = f"`{name}` decides (one value for every estimator)"
            else:
                who = f"`{name}`"
            out += [f"{who}:", "", *table(head, rows), ""]
            if group.get("shown"):
                continue
            before, chosen = group["before"], group["chosen"]
            if group.get("notShipped"):
                out += [
                    f"The procedure picks {value_label(family, group['proposed'])}, a loosening: "
                    "not shipped (a loosening needs data independent of these clips). Kept: "
                    f"{value_label(family, before)}.",
                    "",
                ]
            elif chosen == before:
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
        "previous one withheld, *answers withheld* the reverse; a control broken fails any "
        "value (L4). Gross errors: "
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
    ("tonal_source", "key evidence: spectral-line share of", None, "key"),
    ("min_tonal_ratio", "key evidence: spectral-line share", None, "key"),
    ("class_vector", "key evidence: pitch classes from", None, "key"),
    ("class_level", "key evidence: pitch-class level", None, "key"),
)
FIELD_FAMILY = {
    "onset_check": "onset",
    "drift": "drift",
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
        "verdict",
    ]
    rows = []
    for change in confirmation["changes"]:
        family = change["family"]
        for name, row in change["rows"].items():
            p, verdict = row["pooled"], row["verdict"]
            withheld = (
                f"{p['lost']} ({p['lostRight']} right; kept: {share(p['keptRight'], p['kept'])})"
                if p["lost"]
                else "–"
            )
            if name != change["estimator"]:
                status = "librosa's check: " + (
                    "no evaluation clip changed"
                    if not verdict["changed"]
                    else (
                        "fails " + ", ".join(verdict["failed"]) if verdict["failed"] else "passes"
                    )
                )
            elif not verdict["changed"]:
                status = "no evaluation clip changed: kept"
            elif verdict["failed"]:
                status = "fails " + ", ".join(verdict["failed"]) + ": reverted"
            else:
                status = "passes"
            rows.append(
                [
                    change["title"],
                    f"`{name}`",
                    f"{value_label(family, change['before'])} → "
                    f"{value_label(family, change['chosen'])}",
                    share(p["extraRight"], p["extra"]),
                    str(p["extraGross"]) if p["extra"] else "–",
                    withheld,
                    status,
                ]
            )
    return [
        "### Each change on the evaluation clips",
        "",
        f"Each change judged again on the evaluation clips ({KIND_RIGHT['tempo']} for tempo, "
        "exact for key), pooled over the rule's datasets: L1-L3 for a loosening, T2 for a "
        "tightening; a shared change is reverted when either estimator's clips reject it.",
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


def gate_section(runs: list[dict], controls: dict, after: cal.Rules) -> list[str]:
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
    passed = [c for c in noise if c["name"] not in gated]
    valued = sorted(
        {
            f"{c['name']} (`{name}` {kind})"
            for c in passed
            for name in controls["estimators"]
            for kind in ("tempo", "key")
            if cal.usable(c, name, kind) and cal.derived(c, name, kind, after) is not None
        }
    )
    then = (
        "None of those that pass gets a tempo or a key."
        if not valued
        else f"Of those that pass, these get a value: {', '.join(valued)}."
    )
    passed_names = ", ".join(c["name"] for c in passed) or "none"
    return [
        "### The noise gate",
        "",
        *table(["data", "clips", "gated as noise or silence"], rows),
        "",
        f"Noise controls gated: {len(gated)} of {len(noise)} ({', '.join(gated) or 'none'}); "
        f"passed: {passed_names}. {then} Nothing here measures what a stricter gate would cost on speech, a "
        "cappella or solo instruments (the annotated sets hold none), so the gate's values are "
        "not changed by this calibration.",
        "",
    ]


def default_halves(doc: dict, default: str, candidates: list[str]) -> list[dict]:
    """
    Each candidate against the default tempo estimator as served, from the tempo calibration
    runs: on the calibration clips, the evaluation clips and all of them (none of the tempo
    rules these estimators use changed, so both halves are as valid for this comparison).
    Datasets a candidate was trained on are left out.
    """
    runs, _ = runs_of(doc)
    out = []
    for run in runs:
        if run["kind"] != "tempo" or default not in run["estimators"]:
            continue
        rules = cal.Rules.from_dict(run["rules"])
        for name in candidates:
            if name not in run["estimators"] or name in run.get("trainedOn", []):
                continue
            for split in ("calibration", "evaluation", None):
                clips = [c for c in run["clips"] if split is None or c["split"] == split]
                pairs = [
                    (cal.outcome(c, name, "tempo", rules), cal.outcome(c, default, "tempo", rules))
                    for c in clips
                    if cal.usable(c, name, "tempo") and cal.usable(c, default, "tempo")
                ]
                a = [bool(x and x["acc1"]) for x, _ in pairs]
                b = [bool(y and y["acc1"]) for _, y in pairs]
                only_a = sum(x and not y for x, y in zip(a, b, strict=True))
                only_b = sum(y and not x for x, y in zip(a, b, strict=True))
                out.append(
                    {
                        "data": run["dataset"]["name"],
                        "clips": split or "all",
                        "name": name,
                        "n": len(pairs),
                        "candidate": sum(a),
                        "default": sum(b),
                        "onlyCandidate": only_a,
                        "onlyDefault": only_b,
                        "p": mcnemar_exact(only_a, only_b),
                    }
                )
    return out


TEMPO_FIELDS = (
    "min_periodicity",
    "min_confidence",
    "steady_tolerance",
    "steady_lag_frames",
    "onset_check",
    "drift",
)


def tempo_rules_unchanged(doc: dict, names: list[str]) -> bool:
    """Whether every tempo calibration run was made with the tempo rules before calibration."""
    runs, _ = runs_of(doc)
    for run in runs:
        if run["kind"] != "tempo":
            continue
        rules = cal.Rules.from_dict(run["rules"])
        for field in TEMPO_FIELDS:
            value = getattr(rules, field)
            if isinstance(value, dict):
                if any(rules.get(field, n) != cal.BASELINE.get(field, n) for n in names):
                    return False
            elif value != getattr(cal.BASELINE, field):
                return False
    return True

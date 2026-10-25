"""
The calibration: the split, the derivation of the service's decisions from recorded
measurements, the acceptance criteria, the choice and the report section, on hand-built
records (no audio). The real service's agreement with the derivation is in test_service_smoke.
"""

import json
import re

import pytest

from evals_audio import calibration as cal
from evals_audio import calibration_report
from evals_audio.controls import ANY, NOT_SCORED, controls
from evals_audio.datasets import DATASETS, split_of
from evals_audio.metrics import mcnemar_exact
from evals_audio.report import SCHEMA_VERSION, count_p_values, decision_lines, render

FRAMES_PER_MINUTE = 60.0 * 22050 / 512


def tempo_raw(
    bpm=120.0, confidence=0.6, onset_off=False, drift=0.0, acc1=1.0, acc2=1.0, beats_off=False
):
    """
    A recorded estimate: steady in all three thirds unless the onset tempo (or the beats' own
    tempo) is off by 30 %.
    """
    period = FRAMES_PER_MINUTE / bpm
    onset = period * (1.3 if onset_off else 1.0)
    beat_bpm = bpm * (1.3 if beats_off else 1.0)
    return {
        "bpm": bpm,
        "confidence": confidence,
        "steadiness": {
            "enoughBeats": True,
            "period": period,
            "byCount": False,
            "parts": [[0.5, beat_bpm, onset]] * 3,
        },
        "drift": {"4": [drift] * 3, "6": [drift] * 3},
        "scores": {"acc1": acc1, "acc2": acc2},
    }


def tempo_clip(tid, split="calibration", periodicity=0.5, served=120.0, raw=None, name="essentia"):
    raw = tempo_raw() if raw is None else raw
    return {
        "trackId": tid,
        "split": split,
        "gate": {"periodicity": periodicity},
        "estimators": {name: {"gatePassed": True, "tempo": {"served": served, "raw": raw}}},
    }


def evidence(periodicity=0.5, ratio=0.5, classes=(0, 4, 7), voice=None):
    vector = [1.0 if i in classes else 0.0 for i in range(12)]
    return {
        "periodicity": periodicity,
        "tonalRatio": ratio,
        "harmonicTonalRatio": ratio,
        "series": False,
        "movement": 0.3,
        "classes": {
            "lines": vector,
            "fundamental": vector,
            "upper130": vector,
            "upper260": vector,
        },
        "voice": voice,
    }


def key_clip(tid, ev, strength=0.8, exact=1.0, served=None, split="calibration", name="essentia"):
    raw = {
        "tonic": "C",
        "mode": "major",
        "strength": strength,
        "scores": {"mirex": exact, "exact": exact},
    }
    return {
        "trackId": tid,
        "split": split,
        "gate": {"periodicity": ev["periodicity"]},
        "evidence": ev,
        "estimators": {name: {"gatePassed": True, "key": {"served": served, "raw": raw}}},
    }


# --- the split ---------------------------------------------------------------------------------


def test_the_split_is_fixed_by_dataset_and_track_id_and_about_half_each():
    spec = DATASETS["giantsteps-tempo"]
    ids = [str(i) for i in range(2000)]
    splits = [split_of(spec, i) for i in ids]
    assert set(splits) == {"calibration", "evaluation"}
    assert 0.45 < splits.count("calibration") / len(ids) < 0.55
    assert splits == [split_of(spec, i) for i in ids]  # the same every time
    other = [split_of(DATASETS["ballroom"], i) for i in ids]
    assert other != splits  # each dataset has its own


# --- the derivation --------------------------------------------------------------------------------


def test_the_tempo_rules_are_applied_to_the_recorded_estimate():
    rules = cal.BASELINE
    name = "essentia"
    assert cal.derive_tempo(True, 0.5, tempo_raw(), name, rules) == 120.0
    assert cal.derive_tempo(False, 0.5, tempo_raw(), name, rules) is None  # gated
    assert cal.derive_tempo(True, 0.19, tempo_raw(), name, rules) is None  # periodicity
    assert cal.derive_tempo(True, 0.5, tempo_raw(confidence=0.2), name, rules) is None
    assert cal.derive_tempo(True, 0.5, None, name, rules) is None
    # The onset-tempo part of the steadiness check, on and off.
    off = tempo_raw(onset_off=True)
    assert cal.derive_tempo(True, 0.5, off, name, rules) is None
    assert cal.derive_tempo(True, 0.5, off, name, rules.set("onset_check", False, name)) == 120.0
    # The drift check, for one estimator only.
    drifting = tempo_raw(drift=0.13)
    with_drift = rules.set("drift", [6.0, 0.12], name)
    assert cal.derive_tempo(True, 0.5, drifting, name, rules) == 120.0
    assert cal.derive_tempo(True, 0.5, drifting, name, with_drift) is None
    assert cal.derive_tempo(True, 0.5, drifting, "librosa", with_drift) == 120.0


def test_the_key_evidence_and_strength_are_applied_to_the_recorded_key():
    rules = cal.BASELINE
    name = "essentia"
    stats = {"tonic": "C", "mode": "major", "strength": 0.8}
    assert cal.derive_key(True, evidence(), stats, name, rules) == ["C", "major"]
    # No sustained pitch over a beat: withheld at the minimum share of the mix's (or the
    # harmonic part's) line energy.
    weak = evidence(ratio=0.01)
    assert cal.evidence_withheld(weak, rules, name) == "no sustained pitch"
    assert cal.derive_key(True, weak, stats, name, rules) is None
    assert cal.derive_key(True, weak, stats, name, rules.set("min_tonal_ratio", 0.0)) is not None
    harmonic = {**weak, "harmonicTonalRatio": 0.5}
    assert cal.evidence_withheld(harmonic, rules.set("tonal_source", "harmonic"), name) is None
    # Fewer than three pitch classes, at the level and with the vector chosen.
    two = evidence(classes=(0, 7))
    assert cal.evidence_withheld(two, rules, name) == "fewer than three pitch classes"
    # The minimum strength, per estimator.
    strict = rules.set("min_strength", 0.9, name)
    assert cal.derive_key(True, evidence(), stats, name, strict) is None
    assert cal.derive_key(True, evidence(), stats, "librosa", strict) == ["C", "major"]


def test_one_pitched_source_is_withheld_under_the_rules_that_have_the_rule():
    """The single-source rule at the service's values, applied after the other key rules."""
    stats = {"tonic": "C", "mode": "major", "strength": 0.8}
    single = {"bins": 12, "movement": 0.01, "shared": 0.9, "depth": 0.4}
    ev = {**evidence(), "source": single}
    with_rule = cal.BASELINE.set("one_source", True)
    _, est = cal.service.load()
    assert cal.evidence_withheld(ev, with_rule, "essentia") == est.ONE_SOURCE
    assert cal.derive_key(True, ev, stats, "librosa", with_rule) is None
    # Before the rule, and for runs recorded without its measurements: the key stays.
    assert not cal.BASELINE.one_source
    assert cal.derive_key(True, ev, stats, "essentia", cal.BASELINE) == ["C", "major"]
    assert cal.derive_key(True, evidence(), stats, "essentia", with_rule) == ["C", "major"]
    # Each measurement on its own side of the service's value keeps the key.
    for field, value in (
        ("bins", est.SOURCE_MIN_BINS - 1),
        ("movement", est.SOURCE_MAX_MOVEMENT * 1.01),
        ("shared", est.SOURCE_MIN_SHARED * 0.99),
        ("depth", est.SOURCE_MIN_DEPTH * 0.99),
    ):
        apart = {**ev, "source": {**single, field: value}}
        assert cal.evidence_withheld(apart, with_rule, "essentia") is None, field
    # Another rule's reason comes first.
    weak = {**evidence(ratio=0.01), "source": single}
    assert cal.evidence_withheld(weak, with_rule, "essentia") == "no sustained pitch"
    # The service's values have the rule; rules recorded before it load without it.
    assert cal.service_rules().one_source
    recorded = cal.BASELINE.as_dict()
    del recorded["one_source"]
    assert cal.Rules.from_dict(recorded) == cal.BASELINE


def test_a_derivation_that_disagrees_with_the_service_is_reported():
    clips = [tempo_clip("a"), tempo_clip("b", served=None)]
    bad = cal.mismatches(clips, ["essentia"], "tempo", cal.BASELINE)
    assert bad == {"essentia": ["b"]}


# --- the criteria and the choice ---------------------------------------------------------------------


def comparison(**counts):
    base = {k: 0 for k in ("n", "old", "new", "oldRight", "newRight", "oldGross", "extra")}
    base |= {k: 0 for k in ("extraRight", "extraGross", "lost", "lostRight", "kept", "keptRight")}
    return base | counts


NO_CHANGE = {"fixed": [], "broken": []}


def test_a_loosening_needs_right_extra_answers_at_every_criterion():
    old = {"n": 100, "old": 40, "oldRight": 32, "oldGross": 2}  # 80 % right, 5 % gross
    passing = comparison(**old, extra=37, extraRight=29, extraGross=4)  # 78.4 % [62.8, 88.6]
    verdict = cal.judge(passing, {"d": passing}, NO_CHANGE)
    assert verdict["accepted"] and verdict["loosens"]
    few = comparison(**old, extra=1, extraRight=1)
    assert cal.judge(few, {"d": few}, NO_CHANGE)["failed"] == ["L1"]
    diluting = comparison(**old, extra=200, extraRight=130)  # 65 %: 15 points under 80 %
    assert cal.judge(diluting, {"d": diluting}, NO_CHANGE)["failed"] == ["L2"]
    gross = comparison(**old, extra=40, extraRight=32, extraGross=8)  # 20 % against 5 %
    assert cal.judge(gross, {"d": gross}, NO_CHANGE)["failed"] == ["L3"]
    broken = {"fixed": [], "broken": ["a control"]}
    assert cal.judge(passing, {"d": passing}, broken)["failed"] == ["L4"]
    # On the evaluation clips only L1-L3 count (the controls are the ones the choice saw).
    assert cal.judge(passing, {"d": passing}, broken, held_out=True)["accepted"]


def test_a_tightening_needs_a_fixed_control_and_a_small_cost():
    old = {"n": 100, "old": 40, "oldRight": 30}
    cheap = comparison(**old, newRight=30, lost=1, lostRight=0, kept=39, keptRight=30)
    fixed = {"fixed": ["random-notes"], "broken": []}
    assert cal.judge(cheap, {"d": cheap}, fixed)["accepted"]
    assert cal.judge(cheap, {"d": cheap}, NO_CHANGE)["failed"] == ["T1"]
    costly = comparison(**old, newRight=27, lost=3, lostRight=3, kept=37, keptRight=27)
    assert cal.judge(costly, {"d": costly}, fixed)["failed"] == ["T2"]
    # Withholding only right answers fails even when correct / n hardly moves.
    right_only = comparison(**old, newRight=29, lost=1, lostRight=1, kept=39, keptRight=29)
    assert cal.judge(right_only, {"d": right_only}, fixed)["failed"] == ["T2"]
    # A change on the controls only, at no cost on the clips, is a tightening that passes.
    free = comparison(**old, newRight=30, kept=40, keptRight=30)
    assert cal.judge(free, {"d": free}, fixed)["accepted"]


def row(new, accepted=True, loosens=False, fixed=0, lost=0, value=0.5):
    return {
        "value": value,
        "verdict": {"accepted": accepted, "loosens": loosens},
        "pooled": {"new": new, "lost": lost},
        "controls": {"fixed": ["c"] * fixed},
    }


def test_the_choice_takes_the_loosest_loosening_or_the_least_strict_tightening():
    assert cal.choose([row(10, False), row(12, loosens=True), row(15, loosens=True)]) == 2
    # Tightenings: the least strict that passes (a lower minimum, a higher tolerance),
    # whatever the controls it fixes and the order of the grid.
    rows = [row(9, fixed=3, lost=1, value=0.6), row(10, fixed=1, value=0.4)]
    assert cal.choose([*rows, row(10, False, value=0.3)], "strength") == 1
    drifts = [row(10, fixed=1, value=[6.0, 0.12]), row(10, fixed=2, value=[6.0, 0.1])]
    assert cal.choose(drifts, "drift") == 0
    tolerances = [row(10, fixed=1, value=0.04), row(10, False, value=0.05)]
    assert cal.choose(tolerances, "tolerance") == 0
    assert cal.choose([row(10, False), row(9, False)]) is None


def test_the_baseline_holds_the_values_before_this_calibration():
    """Pinned: the values of commit ec7d24b, against which "before" is reported."""
    b = cal.BASELINE
    assert b.min_periodicity == 0.2
    assert b.min_confidence == {"librosa": 0.3, "essentia": 1.5 / 5.32, "beat-this": 0.0}
    assert (b.steady_tolerance, b.steady_lag_frames) == (0.05, 2.0)
    assert set(b.onset_check.values()) == {True}
    assert set(b.drift.values()) == {None}
    assert (b.min_tonal_ratio, b.class_vector, b.class_level, b.min_classes) == (
        0.1,
        "lines",
        0.28,
        3,
    )
    assert b.min_strength == {"librosa": 0.3, "essentia": 0.3}


def test_the_service_values_are_read_from_the_service():
    """Pinned: the values this calibration chose, as the service holds them."""
    rules = cal.service_rules()
    assert rules.min_strength == {"librosa": 0.4, "essentia": 0.4}
    assert rules.drift == {"librosa": None, "essentia": None, "beat-this": None}
    assert rules.onset_check == {"librosa": True, "essentia": True, "beat-this": True}
    unchanged = ("min_periodicity", "min_confidence", "steady_tolerance", "steady_lag_frames")
    unchanged += ("min_tonal_ratio", "tonal_source", "class_vector", "class_level")
    for field in (*unchanged, "min_classes"):
        assert getattr(rules, field) == getattr(cal.BASELINE, field), field


# --- the choice on recorded runs, and the report section -----------------------------------------------


def tempo_run(clips, estimators=("essentia",)):
    return {
        "suite": "calibration",
        "kind": "tempo",
        "command": "uv run python -m evals_audio --suite calibration --dataset ballroom",
        "gitCommit": "abc1234",
        "dataset": {"name": "ballroom", "title": "Ballroom"},
        "estimators": list(estimators),
        "seeds": {"selection": 1, "clips": 1, "bootstrap": 1},
        "limit": None,
        "splits": {"calibration": sum(c["split"] == "calibration" for c in clips)}
        | {"evaluation": sum(c["split"] == "evaluation" for c in clips)},
        "rules": cal.BASELINE.as_dict(),
        "baseline": cal.BASELINE.as_dict(),
        "clips": clips,
    }


def controls_run(items, estimators=("essentia",)):
    return {
        "suite": "controls",
        "command": "uv run python -m evals_audio --suite controls",
        "gitCommit": "abc1234",
        "dataset": {"name": "controls", "title": "generated controls"},
        "estimators": list(estimators),
        "seeds": {"selection": 1, "clips": 1, "bootstrap": 1},
        "limit": None,
        "rules": cal.BASELINE.as_dict(),
        "controls": items,
    }


def as_control(clip, name, tempo=None):
    clip = {**clip, "name": name, "group": "no-tempo"}
    clip["truth"] = {"tempo": tempo, "key": NOT_SCORED, "gate": "pass"}
    clip["servedGate"] = {n: {"passed": True, "reason": None} for n in clip["estimators"]}
    return clip


def onset_runs(control_raw=None):
    """
    Essentia withholds 40 tempos for the onset-tempo part alone, 36 of them right: lifting the
    part passes every criterion (a loosening). One control changes tempo (truth: none).
    """
    clips = []
    for split in ("calibration", "evaluation"):
        for k in range(50):
            clips.append(tempo_clip(f"{split}-steady-{k}", split, served=120.0))
        for k in range(40):
            raw = tempo_raw(onset_off=True, acc1=float(k < 36), acc2=1.0)
            clips.append(tempo_clip(f"{split}-onset-{k}", split, served=None, raw=raw))
    raw = control_raw or tempo_raw(onset_off=True, beats_off=True)
    return [tempo_run(clips)], controls_run([as_control(tempo_clip("swing", raw=raw), "swing")])


def both(tid, split, essentia, librosa):
    clip = tempo_clip(tid, split, raw=essentia)
    clip["estimators"]["librosa"] = tempo_clip(tid, split, raw=librosa, name="librosa")[
        "estimators"
    ]["librosa"]
    return clip


def drift_runs(librosa_drift=0.0, evaluation_drift=0.0):
    """
    A swing control whose beats drift 0.2 within a third (truth: no tempo), and 100 steady clips
    per half: a drift check is a tightening that fixes the control at no cost, unless librosa's
    clips (or Essentia's evaluation clips) drift too and are right.
    """
    clips = []
    for split in ("calibration", "evaluation"):
        for k in range(100):
            e = tempo_raw(drift=evaluation_drift if split == "evaluation" and k < 20 else 0.0)
            lib = tempo_raw(drift=librosa_drift if k < 20 else 0.0)
            clips.append(both(f"{split}-{k}", split, e, lib))
    swing = both("swing", "calibration", tempo_raw(drift=0.2), tempo_raw(drift=0.2))
    names = ("essentia", "librosa")
    return [tempo_run(clips, names)], controls_run([as_control(swing, "swing")], names)


def family(choice, key):
    return next(f for f in choice["families"] if f["family"] == key)


def test_a_loosening_the_procedure_picks_is_reported_but_not_shipped():
    runs, ctl = onset_runs()
    choice = cal.select(runs, ctl["controls"])
    group = family(choice, "onset")["groups"][0]
    assert group["estimator"] == "essentia"
    assert (group["before"], group["proposed"], group["chosen"]) == (True, False, True)
    assert group["notShipped"]
    lifted = group["candidates"][1]
    assert lifted["pooled"]["extra"] == 40 and lifted["pooled"]["extraRight"] == 36
    assert lifted["verdict"]["accepted"]
    assert cal.Rules.from_dict(choice["rules"]).onset_check["essentia"] is True
    doc = {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-24", "runs": [*runs, ctl]}
    assert "The procedure picks off, a loosening: not shipped" in render(doc)


def test_a_change_that_gives_a_control_a_value_it_should_not_have_is_refused():
    runs, ctl = onset_runs(control_raw=tempo_raw(onset_off=True))  # only the onset part stops it
    group = family(cal.select(runs, ctl["controls"]), "onset")["groups"][0]
    assert group["candidates"][1]["controls"]["broken"] == ["swing"]
    assert group["candidates"][1]["verdict"]["failed"] == ["L4"]
    assert group["proposed"] is True and not group["notShipped"]


def test_a_tightening_is_shipped_at_its_least_strict_passing_value():
    runs, ctl = drift_runs()
    choice = cal.select(runs, ctl["controls"])
    group = family(choice, "drift")["groups"][0]
    assert group["chosen"] == [6.0, 0.15] and not group["notShipped"]
    assert cal.Rules.from_dict(choice["rules"]).drift["librosa"] == [6.0, 0.15]


def test_librosa_s_clips_veto_a_shared_change():
    runs, ctl = drift_runs(librosa_drift=0.16)  # 20 right librosa tempos drift 0.16
    group = family(cal.select(runs, ctl["controls"]), "drift")["groups"][0]
    assert group["chosen"] is None
    assert all("librosa's check" in c["verdict"]["failed"] for c in group["candidates"][1:])


def test_a_change_that_fails_on_the_evaluation_clips_is_reverted():
    runs, ctl = drift_runs()
    kept = cal.confirm(runs, ctl["controls"], cal.select(runs, ctl["controls"]))
    (change,) = kept["changes"]
    assert change["confirmed"] and kept["rules"]["drift"]["essentia"] == [6.0, 0.15]
    runs, ctl = drift_runs(evaluation_drift=0.2)  # 20 right evaluation tempos drift 0.2
    reverted = cal.confirm(runs, ctl["controls"], cal.select(runs, ctl["controls"]))
    (change,) = reverted["changes"]
    assert not change["confirmed"]
    assert change["rows"]["essentia"]["verdict"]["failed"] == ["T2"]
    assert reverted["rules"]["drift"]["essentia"] is None
    doc = {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-24", "runs": [*runs, ctl]}
    assert "fails T2: reverted" in render(doc)


def test_the_held_out_comparison_uses_only_the_evaluation_clips():
    runs, _ = onset_runs()
    after = cal.BASELINE.set("onset_check", False, "essentia")
    (row_,) = cal.evaluate(runs, cal.BASELINE, after)
    assert row_["n"] == 90
    assert (row_["oldRight"], row_["newRight"]) == (50, 86)
    assert (row_["extra"], row_["extraRight"]) == (40, 36)
    assert row_["discordantNew"] == 36 and row_["mcnemarP"] < 0.001


def calibration_doc(shipped=True):
    runs, ctl = drift_runs()
    after = cal.BASELINE.set("drift", {n: [6.0, 0.15] for n in cal.BASELINE.drift})
    for run in [*runs, ctl]:
        run["rules"] = (after if shipped else cal.BASELINE).as_dict()
    return {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-24", "runs": [*runs, ctl]}


def test_the_section_renders_the_choice_the_evaluation_and_the_controls():
    text = render(calibration_doc())
    assert "## Calibration of the withholding rules" in text
    assert "Derivation check: " in text
    assert "Chosen: 6 s windows, 0.15 (before: none)." in text
    assert "The service holds the values that remain after the evaluation check." in text
    assert "### Held-out evaluation (evaluation clips)" in text
    assert "| ballroom | `essentia` | 100 | 100/100 = 100.0 %" in text
    assert "| swing | no-tempo | none |" in text


def test_a_service_value_that_differs_from_the_choice_is_flagged():
    text = render(calibration_doc(shipped=False))
    assert "**no**" in text
    assert "The service's values differ from those that remain in 2 rows" in text


def test_the_section_counts_every_p_value_it_prints():
    doc = calibration_doc()
    text = render(doc)
    section = text.split("## Calibration of the withholding rules", 1)[1]
    printed = len(re.findall(r"p [=<] ", section))
    assert calibration_report.count_p_values(doc) == printed
    assert count_p_values(doc) == printed


def test_the_section_is_rendered_from_the_json_alone():
    doc = calibration_doc()
    assert render(json.loads(json.dumps(doc))) == render(doc)


# --- controls --------------------------------------------------------------------------------------


def test_controls_have_unique_names_known_groups_and_truths():
    from evals_audio.controls import GROUPS

    items = controls()
    names = [c.name for c in items]
    assert len(names) == len(set(names))
    assert {c.group for c in items} <= set(GROUPS)
    for c in items:
        assert c.gate in ("pass", "noise")
        assert c.tempo is None or c.tempo == NOT_SCORED or isinstance(c.tempo, float)
        assert c.key in (None, NOT_SCORED, ANY) or len(c.key) == 2


@pytest.mark.parametrize(
    ("truth", "value", "kind", "ok"),
    [
        (None, None, "tempo", True),
        (None, 120.0, "tempo", False),
        (120.0, 121.0, "tempo", True),
        (120.0, 60.0, "tempo", False),
        (120.0, None, "tempo", False),
        (["C", "major"], ["C", "major"], "key", True),
        (["C", "major"], ["A", "minor"], "key", False),
        (ANY, ["A", "minor"], "key", True),
        (ANY, None, "key", False),
        (NOT_SCORED, 120.0, "tempo", None),
    ],
)
def test_a_control_value_is_judged_against_its_truth(truth, value, kind, ok):
    assert cal.control_ok(truth, value, kind) == ok


def vector(third: float) -> list[float]:
    """C, G strong and E at `third` of the strongest: three classes only at a level <= third."""
    v = [0.0] * 12
    v[0], v[7], v[4] = 1.0, 0.9, third
    return v


def key_evidence(third: float) -> dict:
    ev = evidence()
    ev["classes"] = {k: vector(third) for k in ("lines", "fundamental", "upper130", "upper260")}
    return ev


def key_control(name: str, truth, third: float) -> dict:
    clip = key_clip(name, key_evidence(third))
    clip["estimators"]["librosa"] = key_clip(name, key_evidence(third), name="librosa")[
        "estimators"
    ]["librosa"]
    clip |= {"name": name, "group": "key"}
    clip["truth"] = {"tempo": NOT_SCORED, "key": truth, "gate": "pass"}
    clip["servedGate"] = {n: {"passed": True, "reason": None} for n in clip["estimators"]}
    return clip


def key_runs():
    """
    40 tonal clips per half that no pitch-class level changes, a bass-heavy band whose third
    class is at 0.25 of the strongest (truth C major) and a one-note bass whose overtone sits at
    0.12 (truth: no key): a lower level keys the band, and at 0.1 the bass too.
    """
    clips = []
    for split in ("calibration", "evaluation"):
        for k in range(40):
            clip = key_clip(f"{split}-{k}", evidence(), split=split, served=["C", "major"])
            clip["estimators"]["librosa"] = key_clip(
                f"{split}-{k}", evidence(), split=split, served=["C", "major"], name="librosa"
            )["estimators"]["librosa"]
            clips.append(clip)
    run = {**tempo_run(clips, ("essentia", "librosa")), "kind": "key"}
    run["dataset"] = {"name": "giantsteps-key", "title": "GiantSteps Key"}
    controls = [
        key_control("band-bass+10", ["C", "major"], 0.25),
        key_control("one-note-bass", None, 0.12),
    ]
    return [run], controls_run(controls, ("essentia", "librosa"))


def test_a_value_that_gives_a_control_a_key_is_a_loosening_even_with_no_annotated_change():
    runs, ctl = key_runs()
    group = family(cal.select(runs, ctl["controls"]), "classes")["groups"][0]
    rows = {tuple(c["value"]): c for c in group["candidates"]}
    # 0.2 keys the band (right) and nothing else: a loosening with no annotated evidence.
    assert rows[("lines", 0.2)]["verdict"]["loosens"]
    assert not rows[("lines", 0.2)]["verdict"]["accepted"]
    # 0.1 also keys the one-note bass: a loosening that breaks a control.
    assert rows[("lines", 0.1)]["verdict"]["loosens"]
    assert "L4" in rows[("lines", 0.1)]["verdict"]["failed"]
    assert group["chosen"] == ["lines", 0.28]


def test_the_key_evidence_uses_the_candidate_s_periodicity_minimum():
    ev = evidence(periodicity=0.25)  # a beat at 0.2, none at 0.3
    stats = {"tonic": "C", "mode": "major", "strength": 0.8}
    assert cal.derive_key(True, ev, stats, "essentia", cal.BASELINE) == ["C", "major"]
    stricter = cal.BASELINE.set("min_periodicity", 0.3)
    # Without a beat and without a pitch track, the service gives no key.
    assert cal.evidence_withheld(ev, stricter, "essentia") == "no pitch track"


def halves_rows(calibration, evaluation, pooled):
    """beat-this against essentia, (candidate, default, only candidate, only default) per half."""
    rows = []
    for clips, (a, b, x, y) in zip(
        ("calibration", "evaluation", "all"), (calibration, evaluation, pooled), strict=True
    ):
        rows.append(
            {
                "data": "giantsteps-tempo",
                "clips": clips,
                "name": "beat-this",
                "n": 200,
                "candidate": a,
                "default": b,
                "onlyCandidate": x,
                "onlyDefault": y,
                "p": mcnemar_exact(x, y),
            }
        )
    return rows


EVIDENCE = {"default": "essentia", "cost": None, "rows": [], "candidates": ["beat-this"]}


def test_a_gain_the_halves_disagree_on_keeps_the_default():
    unstable = halves_rows((49, 54, 10, 15), (60, 39, 23, 2), (109, 93, 33, 17))
    (text, _) = decision_lines(EVIDENCE, calibrated=True, halves=unstable)
    assert text.startswith("Decision: the service keeps `essentia`.")
    assert "not stable across the halves" in text
    assert "49 vs 54 of 200 on the calibration clips (p = 0.424)" in text
    assert "open decision" not in text


def test_a_gain_both_halves_show_leaves_the_decision_open():
    stable = halves_rows((60, 40, 25, 5), (58, 39, 24, 5), (118, 79, 49, 10))
    (text, _) = decision_lines(EVIDENCE, calibrated=True, halves=stable)
    assert "both halves agree" in text and "open decision" in text
    assert "keeps `essentia`" not in text


def test_the_halves_sentence_says_whether_the_tempo_rules_changed():
    runs, ctl = drift_runs()
    doc = {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-24", "runs": [*runs, ctl]}
    assert calibration_report.tempo_rules_unchanged(doc, ["essentia", "librosa"])
    changed = cal.BASELINE.set("steady_tolerance", 0.04).as_dict()
    doc["runs"][0]["rules"] = changed
    assert not calibration_report.tempo_rules_unchanged(doc, ["essentia", "librosa"])


def test_the_gate_section_names_noise_controls_that_get_a_value():
    runs, ctl = key_runs()
    for c in ctl["controls"]:
        c["truth"]["gate"] = "noise"
    text = "\n".join(calibration_report.gate_section(runs, ctl, cal.BASELINE))
    # Under the baseline neither control gets a key.
    assert "None of those that pass gets a tempo or a key." in text
    lower = cal.BASELINE.set("class_level", 0.1)
    text = "\n".join(calibration_report.gate_section(runs, ctl, lower))
    assert "these get a value: band-bass+10 (`essentia` key)" in text

"""Scoring of the service's answers, with made-up v2 blocks (the service is not run here)."""

import os

import pytest

from evals_audio.datasets import Reference
from evals_audio.metrics import Key, summarize
from evals_audio.runner import (
    CALIBRATION_UNAVAILABLE,
    KEY_WEAK,
    LIFTED_VIEWS,
    NO_ESTIMATE,
    SEVERAL_RULES,
    TEMPO_LOW_CONFIDENCE,
    TEMPO_LOW_PERIODICITY,
    TEMPO_UNSTEADY,
    captured_stderr,
    items_for,
    key_withheld,
    lifted_items,
    lifted_views,
    tempo_withheld,
    withheld_cost,
)

PASS = {"passed": True, "reason": None}


def ref(tid, value):
    return Reference(tid, value, None, f"a/{tid}.wav", "0" * 32)


def tempo_analysed():
    return [
        {
            "trackId": "a",
            "results": {"x": {"gate": PASS, "tempo": {"bpm": 121.0, "confidence": 0.9}}},
        },
        {
            "trackId": "b",
            "results": {"x": {"gate": PASS, "tempo": {"bpm": 60.0, "confidence": 0.8}}},
        },
        {
            "trackId": "c",
            "results": {
                "x": {
                    "gate": PASS,
                    "tempo": None,
                    "tempoWithheld": {
                        "reason": "tempo does not hold over the window",
                        "bpm": 119.0,
                        "confidence": 0.4,
                    },
                }
            },
        },
        {
            "trackId": "d",
            "results": {
                "x": {"gate": PASS, "tempo": None, "tempoWithheld": {"reason": "no estimate"}}
            },
        },
        {
            "trackId": "e",
            "results": {"x": {"gate": {"passed": False, "reason": "silent"}, "tempo": None}},
        },
        {"trackId": "f", "error": "InvalidAudioError: bad file"},
    ]


def test_tempo_withheld_and_failed_tracks_are_counted_apart():
    refs = {t: ref(t, 120.0) for t in "abcdef"}
    items, rows = items_for("tempo", refs, tempo_analysed(), "x")
    s = summarize(items, ["acc1", "acc2"], seed=1)
    assert (s.n, s.answered, s.withheld, s.failed) == (6, 2, 3, 1)
    # a right, b an octave off; c, d, e withheld and f failed give no correct value over n.
    assert (s.over_answered["acc1"].total, s.over_answered["acc1"].n) == (1.0, 2)
    assert (s.over_answered["acc2"].total, s.over_answered["acc2"].n) == (2.0, 2)
    assert (s.over_n["acc1"].total, s.over_n["acc1"].n) == (1.0, 6)
    by_id = {r["trackId"]: r for r in rows}
    assert by_id["c"]["withheldReason"] == "tempo does not hold over the window"
    assert by_id["c"]["unreturned"] == {
        "estimate": "119",
        "confidence": 0.4,
        "steady": None,
        "rules": ["tempo does not hold over the window"],
        "scores": {"acc1": 1.0, "acc2": 1.0},
    }
    assert by_id["d"]["withheldReason"] == "no estimate" and "unreturned" not in by_id["d"]
    assert by_id["e"]["withheldReason"] == "gate: silent"
    assert by_id["f"]["failed"] is True


def test_rows_carry_no_reference_or_file_name():
    refs = {t: ref(t, 120.0) for t in "abcdef"}
    _, rows = items_for("tempo", refs, tempo_analysed(), "x")
    text = repr(rows)
    assert "reference" not in text and "a/a.wav" not in text and "120" not in text


def test_withheld_cost_scores_what_the_service_did_not_return():
    refs = {t: ref(t, 120.0) for t in "abcdef"}
    _, rows = items_for("tempo", refs, tempo_analysed(), "x")
    cost = withheld_cost(rows, ["acc1", "acc2"], seed=1)
    assert (cost["n"], cost["returned"], cost["unreturned"]) == (6, 2, 1)
    [group] = cost["rules"]  # one rule withheld an estimate: no "all" row
    assert (group["rule"], group["count"]) == ("tempo does not hold over the window", 1)
    acc1 = group["metrics"]["acc1"]
    # c's unreturned 119 was right.
    assert (acc1["unreturned"]["total"], acc1["unreturned"]["n"]) == (1.0, 1)
    # Returned too: a and c right out of all 6 clips.
    assert (acc1["ifReturnedOverN"]["total"], acc1["ifReturnedOverN"]["n"]) == (2.0, 6)


def test_withheld_cost_has_a_row_per_rule_and_one_for_all():
    refs = {t: ref(t, 120.0) for t in "abcdefg"}
    analysed = tempo_analysed() + [
        {
            "trackId": "g",
            "results": {
                "x": {
                    "gate": PASS,
                    "tempo": None,
                    "tempoWithheld": {
                        "reason": TEMPO_LOW_CONFIDENCE,
                        "bpm": 60.0,
                        "confidence": 0.1,
                        "steady": True,
                    },
                }
            },
        }
    ]
    _, rows = items_for("tempo", refs, analysed, "x")
    cost = withheld_cost(rows, ["acc1", "acc2"], seed=1)
    by_rule = {g["rule"]: g for g in cost["rules"]}
    assert set(by_rule) == {TEMPO_UNSTEADY, TEMPO_LOW_CONFIDENCE, "all"}
    low = by_rule[TEMPO_LOW_CONFIDENCE]["metrics"]
    assert low["acc1"]["unreturned"]["total"] == 0.0  # 60 is half the reference
    assert low["acc2"]["unreturned"]["total"] == 1.0
    everything = by_rule["all"]["metrics"]["acc2"]["ifReturnedOverN"]
    assert (everything["total"], everything["n"]) == (4.0, 7)  # a, b returned; c, g withheld


class FakeTempo:
    def __init__(self, bpm, confidence, steady=True):
        self.bpm, self.confidence, self.steady = bpm, confidence, steady


class FakeEstimator:
    """
    Like the service's estimators: no tempo when the onsets do not repeat enough (`periodic`
    False, standing in for estimators.MIN_TEMPO_PERIODICITY) or when the confidence is under
    min_tempo_confidence.
    """

    min_tempo_confidence = 0.3

    def __init__(self, tempo, periodic=True):
        self._tempo, self.periodic = tempo, periodic

    def tempo(self, signals, periodicity_lifted=False):
        if self._tempo is None or not (self.periodic or periodicity_lifted):
            return None
        if self._tempo.confidence < self.min_tempo_confidence:
            return None
        return self._tempo


@pytest.fixture
def fake_minimums(monkeypatch):
    """service.tempo_without_minimums for FakeEstimator (the real one patches the service)."""
    from evals_audio import service

    def lifted(signals, est):
        est.min_tempo_confidence = 0.0
        try:
            tempo = est.tempo(signals, periodicity_lifted=True)
        finally:
            del est.min_tempo_confidence
        # The steadiness check uses the periodicity minimum too: without repeating onsets no
        # part of the window counts, so the tempo does not hold.
        return (None, False) if tempo is None else (tempo, tempo.steady and est.periodic)

    monkeypatch.setattr(service, "tempo_without_minimums", lifted)


def test_a_tempo_under_the_confidence_minimum_is_withheld_not_missing(fake_minimums):
    est = FakeEstimator(FakeTempo(128.0, 0.12, steady=False))
    assert tempo_withheld(None, est) == {
        "reason": TEMPO_LOW_CONFIDENCE,
        "rules": [TEMPO_LOW_CONFIDENCE, TEMPO_UNSTEADY],
        "bpm": 128.0,
        "confidence": 0.12,
        "steady": False,
    }
    assert est.min_tempo_confidence == 0.3  # the minimum is restored
    assert tempo_withheld(None, FakeEstimator(None)) == {"reason": NO_ESTIMATE, "rules": []}
    unsteady = tempo_withheld(None, FakeEstimator(FakeTempo(90.0, 0.8, steady=False)))
    assert unsteady["rules"] == [TEMPO_UNSTEADY]


def test_a_tempo_under_the_periodicity_minimum_is_withheld_not_missing(fake_minimums):
    out = tempo_withheld(None, FakeEstimator(FakeTempo(143.0, 0.5), periodic=False))
    assert out["reason"] == TEMPO_LOW_PERIODICITY and out["bpm"] == 143.0
    # Without repeating onsets the steadiness check fails too.
    assert out["rules"] == [TEMPO_LOW_PERIODICITY, TEMPO_UNSTEADY]
    weak = tempo_withheld(None, FakeEstimator(FakeTempo(143.0, 0.1), periodic=False))
    assert weak["rules"] == [TEMPO_LOW_PERIODICITY, TEMPO_LOW_CONFIDENCE, TEMPO_UNSTEADY]


def test_withheld_cost_counts_a_clip_under_a_rule_only_when_that_rule_alone_withholds_it():
    refs = {t: ref(t, 120.0) for t in "abc"}

    def withheld(tid, bpm, rules):
        return {
            "trackId": tid,
            "results": {
                "x": {
                    "gate": PASS,
                    "tempo": None,
                    "tempoWithheld": {"reason": rules[0], "rules": rules, "bpm": bpm},
                }
            },
        }

    analysed = [
        withheld("a", 120.0, [TEMPO_LOW_CONFIDENCE]),
        withheld("b", 121.0, [TEMPO_LOW_CONFIDENCE, TEMPO_UNSTEADY]),
        withheld("c", 60.0, [TEMPO_UNSTEADY]),
    ]
    _, rows = items_for("tempo", refs, analysed, "x")
    groups = {g["rule"]: g for g in withheld_cost(rows, ["acc1"], seed=1)["rules"]}
    assert {k: g["count"] for k, g in groups.items()} == {
        TEMPO_LOW_CONFIDENCE: 1,
        TEMPO_UNSTEADY: 1,
        SEVERAL_RULES: 1,
        "all": 3,
    }
    # Lifting the confidence minimum alone returns a only: b would still not hold.
    assert groups[TEMPO_LOW_CONFIDENCE]["metrics"]["acc1"]["ifReturnedOverN"]["total"] == 1.0
    assert groups["all"]["metrics"]["acc1"]["ifReturnedOverN"]["total"] == 2.0


def test_a_failed_calibration_call_keeps_the_served_answer(monkeypatch, tmp_path):
    from evals_audio import clips, runner, service

    class Est:
        def tempo(self, signals):
            raise RuntimeError("estimator broke on the second call")

        def key(self, signals):
            raise RuntimeError("key broke")

    served = {
        "gate": PASS,
        "tempo": None,
        "key": {"tonic": "C", "mode": "major", "strength": 0.9},
    }
    monkeypatch.setattr(clips, "read_clip", lambda *a: (b"", {"offsetSeconds": 0.0}))
    monkeypatch.setattr(service, "decode", lambda wav: object())
    monkeypatch.setattr(service, "analyze", lambda signals, est: dict(served))
    monkeypatch.setattr(runner, "_estimators", lambda names: {"x": Est()})
    record = runner.analyze_track(("d", "t1", "unused", 1, ("x",)))
    result = record["results"]["x"]
    assert "error" not in result and result["key"] == served["key"]
    assert result["tempoWithheld"]["reason"] == CALIBRATION_UNAVAILABLE
    assert "estimator broke" in result["tempoWithheld"]["error"]
    _, rows = items_for("tempo", {"t1": ref("t1", 120.0)}, [record], "x")
    assert rows[0]["withheldReason"] == CALIBRATION_UNAVAILABLE and not rows[0].get("failed")


class FakeKey:
    def __init__(self, strength):
        self.tonic, self.mode, self.strength = "A", "minor", strength


class FakeSignals:
    def __init__(self, reason):
        self._reason = reason

    def key_withheld(self, lines_with_beat=True):
        return self._reason


def test_key_withholding_records_the_key_under_both_rules(monkeypatch):
    from evals_audio import service

    monkeypatch.setattr(service, "key_min_strength", lambda est: 0.3)
    monkeypatch.setattr(service, "key_without_withholding", lambda s, e: FakeKey(0.2))
    # Under the minimum strength only.
    out = key_withheld(FakeSignals(None), None)
    assert out["keyWithheld"] == KEY_WEAK
    assert out["keyUnreturned"] == {"tonic": "A", "mode": "minor", "strength": 0.2}
    # Stopped by the evidence rule (and weak too): the rule is named, the key still recorded.
    out = key_withheld(FakeSignals("no sustained pitch"), None)
    assert out["keyWithheld"] == "no sustained pitch" and out["keyUnreturned"] is not None
    monkeypatch.setattr(service, "key_without_withholding", lambda s, e: None)
    assert key_withheld(FakeSignals(None), None)["keyWithheld"] == "the estimator returned no key"


def key_analysed():
    return [
        {
            "trackId": "a",
            "results": {
                "x": {"gate": PASS, "key": {"tonic": "G", "mode": "major", "strength": 0.7}}
            },
        },
        {
            "trackId": "b",
            "results": {
                "x": {"gate": PASS, "key": {"tonic": "A", "mode": "minor", "strength": 0.8}}
            },
        },
        {
            "trackId": "c",
            "results": {
                "x": {
                    "gate": PASS,
                    "key": None,
                    "keyWithheld": "no sustained pitch",
                    "keyUnreturned": {"tonic": "C", "mode": "major", "strength": 0.55},
                }
            },
        },
        {
            "trackId": "d",
            "results": {"x": {"gate": PASS, "key": None, "keyWithheld": None}},
        },
    ]


def test_key_answers_are_scored_with_the_mirex_weights():
    refs = {
        "a": ref("a", Key(0, "major")),
        "b": ref("b", Key(9, "minor")),
        "c": ref("c", Key(0, "major")),
        "d": ref("d", Key(0, "major")),
    }
    items, rows = items_for("key", refs, key_analysed(), "x")
    s = summarize(items, ["mirex", "exact"], seed=1)
    assert (s.n, s.answered, s.withheld) == (4, 2, 2)
    assert s.over_answered["mirex"].mean == 0.75  # a fifth above (0.5), b right (1)
    assert s.over_answered["exact"].mean == 0.5
    assert s.over_n["exact"].mean == 0.25
    assert rows[2]["withheldReason"] == "no sustained pitch"
    # The key the evidence rule stopped is scored apart: it was right.
    assert rows[2]["unreturned"]["scores"] == {"mirex": 1.0, "exact": 1.0}
    assert rows[2]["unreturned"]["confidence"] == 0.55
    assert rows[3]["withheldReason"] == "the estimator returned no key"
    assert "unreturned" not in rows[3]
    assert [i.confidence for i in items] == [0.7, 0.8, None, None]
    cost = withheld_cost(rows, ["mirex", "exact"], seed=1)
    assert cost["rules"][0]["metrics"]["exact"]["ifReturnedOverN"]["total"] == 2.0


@pytest.mark.parametrize("lines", [1, 3])
def test_decoder_messages_on_stderr_are_recorded(lines):
    with captured_stderr() as warnings:
        for _ in range(lines):
            os.write(2, b"[mpg123] dequantization failed!\n")
    expected = "[mpg123] dequantization failed!" + (f" (x{lines})" if lines > 1 else "")
    assert warnings == [expected]


# --- lifted views (the default-estimator evidence) ------------------------------------------


def lifted_row(tid, scores=None, rules=None, unreturned_hit=None, failed=False, reason=None):
    row = {"trackId": tid, "scores": scores, "withheld": scores is None}
    if failed:
        return {"trackId": tid, "failed": True, "error": "x"}
    if reason:
        row["withheldReason"] = reason
    if rules is not None:
        row["withheldReason"] = rules[0]
        row["unreturned"] = {
            "rules": rules,
            "scores": {"acc1": unreturned_hit, "acc2": unreturned_hit},
            "confidence": None,
        }
    return row


LIFT_ROWS = [
    lifted_row("served", scores={"acc1": 1.0, "acc2": 1.0}),
    lifted_row("unsteady", rules=[TEMPO_UNSTEADY], unreturned_hit=1.0),
    lifted_row("both", rules=[TEMPO_LOW_CONFIDENCE, TEMPO_UNSTEADY], unreturned_hit=1.0),
    lifted_row("confidence", rules=[TEMPO_LOW_CONFIDENCE], unreturned_hit=1.0),
    lifted_row("gate", reason="gate: silent"),
    lifted_row("none", reason=NO_ESTIMATE),
    lifted_row("broken", failed=True),
]


def correct(items):
    return sorted(i.track_id for i in items if i.answered and i.scores["acc1"] == 1.0)


def test_the_steadiness_view_lifts_only_clips_that_rule_alone_withholds():
    items = lifted_items(LIFT_ROWS, TEMPO_UNSTEADY)
    assert correct(items) == ["served", "unsteady"]
    assert [i.failed for i in items if i.track_id == "broken"] == [True]


def test_the_every_rule_view_lifts_every_unreturned_estimate_and_nothing_else():
    items = lifted_items(LIFT_ROWS, None)
    assert correct(items) == ["both", "confidence", "served", "unsteady"]
    assert not any(i.answered for i in items if i.track_id in ("gate", "none", "broken"))


def test_the_lifted_views_are_named_for_what_they_lift():
    assert LIFTED_VIEWS == {"everyRule": None, "steadinessOnly": TEMPO_UNSTEADY}
    other = [lifted_row(r["trackId"], scores={"acc1": 0.0, "acc2": 0.0}) for r in LIFT_ROWS]
    views = lifted_views({"x": LIFT_ROWS, "y": other}, ["x", "y"], ["acc1", "acc2"], 1)
    assert views["steadinessOnly"]["rule"] == TEMPO_UNSTEADY
    assert views["steadinessOnly"]["summaries"]["x"]["overN"]["acc1"]["total"] == 2
    assert views["everyRule"]["summaries"]["x"]["overN"]["acc1"]["total"] == 4
    assert views["everyRule"]["paired"][0]["allN"]["metrics"]["acc1"]["onlyFirst"] == 4

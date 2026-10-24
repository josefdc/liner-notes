"""Scoring of the service's answers, with made-up v2 blocks (the service is not run here)."""

import os

import pytest

from evals_audio.datasets import Reference
from evals_audio.metrics import Key, summarize
from evals_audio.runner import captured_stderr, items_for, withheld_cost

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
    acc1 = cost["metrics"]["acc1"]
    # c's unreturned 119 was right.
    assert (acc1["unreturned"]["total"], acc1["unreturned"]["n"]) == (1.0, 1)
    # Returned too: a and c right out of all 6 clips.
    assert (acc1["ifReturnedOverN"]["total"], acc1["ifReturnedOverN"]["n"]) == (2.0, 6)


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
    assert cost["metrics"]["exact"]["ifReturnedOverN"]["total"] == 2.0


@pytest.mark.parametrize("lines", [1, 3])
def test_decoder_messages_on_stderr_are_recorded(lines):
    with captured_stderr() as warnings:
        for _ in range(lines):
            os.write(2, b"[mpg123] dequantization failed!\n")
    expected = "[mpg123] dequantization failed!" + (f" (x{lines})" if lines > 1 else "")
    assert warnings == [expected]

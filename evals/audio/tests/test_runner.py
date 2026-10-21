"""Scoring of the service's answers, with made-up v2 blocks (the service is not run here)."""

from evals_audio.datasets import Reference
from evals_audio.metrics import Key, summarize
from evals_audio.runner import items_for

PASS = {"passed": True, "reason": None}


def ref(tid, value):
    return Reference(tid, value, None, f"a/{tid}.wav", "0" * 32)


def test_tempo_withheld_and_failed_tracks_are_counted_apart():
    refs = {t: ref(t, 120.0) for t in "abcdef"}
    analysed = [
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
    items, rows = items_for("tempo", refs, analysed, "x")
    s = summarize(items, ["acc1", "acc2"], seed=1)
    assert (s.n, s.answered, s.withheld, s.failed) == (6, 2, 3, 1)
    assert s.metrics["acc1"].mean == 0.5  # a right, b an octave off; c, d, e not scored
    assert s.metrics["acc2"].mean == 1.0
    by_id = {r["trackId"]: r for r in rows}
    assert by_id["c"]["withheldReason"] == "tempo does not hold over the window"
    assert by_id["c"]["unreturned"] == {"bpm": 119.0, "confidence": 0.4, "acc1": 1.0, "acc2": 1.0}
    assert by_id["d"]["withheldReason"] == "no estimate" and "unreturned" not in by_id["d"]
    assert by_id["e"]["withheldReason"] == "gate: silent"
    assert by_id["f"]["failed"] is True


def test_key_answers_are_scored_with_the_mirex_weights():
    refs = {
        "a": ref("a", Key(0, "major")),
        "b": ref("b", Key(9, "minor")),
        "c": ref("c", Key(0, "major")),
    }
    analysed = [
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
            "results": {"x": {"gate": PASS, "key": None, "keyWithheld": "no sustained pitch"}},
        },
    ]
    items, rows = items_for("key", refs, analysed, "x")
    s = summarize(items, ["mirex", "exact"], seed=1)
    assert (s.n, s.answered, s.withheld) == (3, 2, 1)
    assert s.metrics["mirex"].mean == 0.75
    assert s.metrics["exact"].mean == 0.5
    assert rows[2]["withheldReason"] == "no sustained pitch"
    assert [i.confidence for i in items] == [0.7, 0.8, None]

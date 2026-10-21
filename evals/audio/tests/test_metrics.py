import math

import pytest

from evals_audio.metrics import (
    Item,
    Key,
    acc1,
    acc2,
    bootstrap_mean,
    coverage_curve,
    mirex_key_score,
    parse_key,
    summarize,
)


@pytest.mark.parametrize(
    ("estimate", "reference", "one", "two"),
    [
        (120.0, 120.0, True, True),
        (124.8, 120.0, True, True),  # exactly 4 %
        (124.9, 120.0, False, False),
        (115.2, 120.0, True, True),
        (60.0, 120.0, False, True),  # half
        (240.0, 120.0, False, True),  # double
        (40.0, 120.0, False, True),  # third
        (360.0, 120.0, False, True),  # three times
        (180.0, 120.0, False, False),  # 3/2 is not forgiven
        (80.0, 120.0, False, False),  # 2/3 is not forgiven
        (172.0, 85.0, False, True),  # 85 read as 172: 1.2 % off double
    ],
)
def test_tempo_accuracy(estimate, reference, one, two):
    assert acc1(estimate, reference) is one
    assert acc2(estimate, reference) is two


def k(text):
    tonic, mode = text.split()
    return parse_key(tonic, mode)


@pytest.mark.parametrize(
    ("estimate", "reference", "score"),
    [
        ("C major", "C major", 1.0),
        ("Db major", "C# major", 1.0),  # enharmonic spelling
        ("G major", "C major", 0.5),  # fifth above
        ("F major", "C major", 0.0),  # fifth below is not credited
        ("E minor", "A minor", 0.5),
        ("A minor", "C major", 0.3),  # relative minor
        ("C major", "A minor", 0.3),  # relative major
        ("C minor", "C major", 0.2),  # parallel
        ("C major", "C minor", 0.2),
        ("G minor", "C major", 0.0),
        ("E minor", "C major", 0.0),
        ("F# major", "C major", 0.0),
    ],
)
def test_mirex_key_score(estimate, reference, score):
    assert mirex_key_score(k(estimate), k(reference)) == score


def test_parse_key_rejects_nonsense():
    with pytest.raises(ValueError):
        parse_key("H", "major")
    with pytest.raises(ValueError):
        parse_key("C", "dorian")
    assert parse_key("Bb", "Minor") == Key(10, "minor")


def test_bootstrap_is_deterministic_for_a_seed():
    values = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1]
    a = bootstrap_mean(values, seed=7)
    b = bootstrap_mean(values, seed=7)
    assert a == b
    # Binary scores give few distinct quantiles; continuous ones show the seed matters.
    scores = [0.1, 0.5, 0.3, 1.0, 0.2, 0.9, 0.0, 0.5, 0.3, 0.7, 0.2, 0.6]
    assert bootstrap_mean(scores, seed=7) == bootstrap_mean(scores, seed=7)
    assert bootstrap_mean(scores, seed=7) != bootstrap_mean(scores, seed=8)
    assert a.mean == pytest.approx(8 / 12)
    assert a.low < a.mean < a.high
    assert a.n == 12


def test_bootstrap_edges():
    assert bootstrap_mean([], seed=1).mean is None
    same = bootstrap_mean([1, 1, 1, 1], seed=1)
    assert (same.mean, same.low, same.high) == (1.0, 1.0, 1.0)


def test_withheld_is_counted_apart_never_as_wrong():
    items = [
        Item("a", 0.9, {"acc1": 1.0}),
        Item("b", 0.5, {"acc1": 0.0}),
        Item("c", None, None),  # withheld
        Item("d", None, None),  # withheld
        Item("e", None, None, failed=True),
    ]
    s = summarize(items, ["acc1"], seed=1)
    assert (s.n, s.answered, s.withheld, s.failed) == (5, 2, 2, 1)
    assert s.coverage == pytest.approx(2 / 5)
    # Accuracy over the answered items only: withheld ones are neither right nor wrong.
    assert s.metrics["acc1"].mean == pytest.approx(0.5)
    assert s.metrics["acc1"].n == 2


def test_all_withheld_has_no_accuracy():
    s = summarize([Item("a", None, None), Item("b", None, None)], ["mirex"], seed=1)
    assert (s.n, s.answered, s.withheld) == (2, 0, 2)
    assert s.metrics["mirex"].mean is None


def test_coverage_curve_ranks_by_confidence():
    # 10 items: 8 answered, 2 withheld. Correct answers have the higher confidences,
    # except "h" (confidence 0.95, wrong).
    conf = {"a": 0.9, "b": 0.8, "c": 0.7, "d": 0.6, "e": 0.5, "f": 0.4, "g": 0.3, "h": 0.95}
    right = {"a", "b", "c", "d", "e"}
    items = [Item(t, c, {"acc1": float(t in right)}) for t, c in conf.items()]
    items += [Item("w1", None, None), Item("w2", None, None)]
    points = coverage_curve(items, ["acc1"])
    by_k = {p.answered: p for p in points}
    # Coverage is a share of all 10 items; 80 % is the most the service answered.
    assert sorted(by_k) == [1, 2, 3, 4, 5, 6, 7, 8]
    assert by_k[1].accuracy["acc1"] == 0.0  # h first
    assert by_k[1].min_confidence == 0.95
    assert by_k[2].accuracy["acc1"] == 0.5
    assert by_k[6].accuracy["acc1"] == pytest.approx(5 / 6)
    assert by_k[8].accuracy["acc1"] == pytest.approx(5 / 8)
    assert by_k[8].coverage == pytest.approx(0.8)
    assert math.isclose(by_k[8].min_confidence, 0.3)


def test_coverage_curve_ties_break_by_track_id():
    items = [Item("b", 0.5, {"m": 0.0}), Item("a", 0.5, {"m": 1.0})]
    first = coverage_curve(items, ["m"], levels=(0.5,))[0]
    assert first.answered == 1 and first.accuracy["m"] == 1.0

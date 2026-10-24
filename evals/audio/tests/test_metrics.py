import math

import pytest

from evals_audio.metrics import (
    Item,
    Key,
    acc1,
    acc2,
    bca_mean,
    compare,
    coverage_curve,
    estimate,
    mcnemar_exact,
    mirex_key_score,
    parse_key,
    ranking_auc,
    summarize,
    wilson,
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


def test_wilson_matches_published_values():
    # 8/11 and 28/50: values checked against statsmodels' proportion_confint(method="wilson").
    e = wilson(8, 11)
    assert (e.total, e.n, e.mean) == (8.0, 11, pytest.approx(8 / 11))
    assert (e.low, e.high) == (pytest.approx(0.4344, abs=1e-4), pytest.approx(0.9025, abs=1e-4))
    e = wilson(28, 50)
    assert (e.low, e.high) == (pytest.approx(0.4231, abs=1e-4), pytest.approx(0.6884, abs=1e-4))


def test_wilson_never_collapses_at_the_edges():
    all_right = wilson(5, 5)
    assert all_right.mean == 1.0 and all_right.high == 1.0
    assert all_right.low == pytest.approx(0.5655, abs=1e-4)  # not [100, 100]
    none_right = wilson(0, 11)
    assert none_right.low == 0.0 and none_right.high > 0.2
    assert wilson(0, 0).mean is None


def test_bca_is_deterministic_and_brackets_the_mean():
    scores = [0.1, 0.5, 0.3, 1.0, 0.2, 0.9, 0.0, 0.5, 0.3, 0.7, 0.2, 0.6]
    a = bca_mean(scores, seed=7)
    assert a == bca_mean(scores, seed=7)
    assert a != bca_mean(scores, seed=8)
    assert a.low < a.mean < a.high
    assert a.method == "BCa bootstrap"


def test_bca_gives_no_interval_when_every_score_is_equal():
    e = bca_mean([1.0, 1.0, 1.0, 1.0], seed=1)
    assert (e.mean, e.low, e.high, e.note) == (1.0, None, None, "all scores equal")
    assert bca_mean([], seed=1).mean is None


def test_binary_metrics_use_wilson_and_mirex_uses_bca():
    assert estimate("acc1", [1, 0, 1], seed=1).method == "Wilson"
    assert estimate("exact", [1, 0, 1], seed=1).method == "Wilson"
    assert estimate("mirex", [1, 0.5, 0.3], seed=1).method == "BCa bootstrap"


def test_withheld_is_counted_apart_and_as_no_correct_value_over_n():
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
    # Over answered: 1 of 2. Over n: 1 of 5, the withheld and failed clips give no correct value.
    assert (s.over_answered["acc1"].total, s.over_answered["acc1"].n) == (1.0, 2)
    assert (s.over_n["acc1"].total, s.over_n["acc1"].n) == (1.0, 5)
    assert s.over_n["acc1"].mean == pytest.approx(0.2)
    assert s.as_dict()["coverage"]["total"] == 2.0


def test_all_withheld_has_no_answered_accuracy():
    s = summarize([Item("a", None, None), Item("b", None, None)], ["mirex"], seed=1)
    assert (s.n, s.answered, s.withheld) == (2, 0, 2)
    assert s.over_answered["mirex"].mean is None
    assert s.over_n["mirex"].mean == 0.0


def curve_items():
    # 10 clips: 8 answered, 2 withheld. Right answers have the higher confidences, except "h"
    # (confidence 0.95, wrong).
    conf = {"a": 0.9, "b": 0.8, "c": 0.7, "d": 0.6, "e": 0.5, "f": 0.4, "g": 0.3, "h": 0.95}
    right = {"a", "b", "c", "d", "e"}
    items = [Item(t, c, {"acc1": float(t in right)}) for t, c in conf.items()]
    return items + [Item("w1", None, None), Item("w2", None, None)]


def test_coverage_curve_ranks_by_confidence_with_intervals():
    points, unranked = coverage_curve(curve_items(), ["acc1"], min_answered=1)
    by_k = {p.answered: p for p in points}
    assert unranked == []
    # Coverage is a share of all 10 clips; 80 % is the most the service answered.
    assert sorted(by_k) == [1, 2, 3, 4, 5, 6, 7, 8]
    assert by_k[1].accuracy["acc1"].mean == 0.0  # h first
    assert by_k[1].min_confidence == 0.95
    assert by_k[6].accuracy["acc1"].total == 5.0
    assert by_k[8].accuracy["acc1"].mean == pytest.approx(5 / 8)
    assert by_k[8].accuracy["acc1"].method == "Wilson"
    assert by_k[8].coverage == pytest.approx(0.8)
    assert math.isclose(by_k[8].min_confidence, 0.3)


def test_coverage_curve_leaves_out_small_k_but_keeps_the_last_point():
    points, _ = coverage_curve(curve_items(), ["acc1"], min_answered=6)
    assert [p.answered for p in points] == [6, 7, 8]
    points, _ = coverage_curve(curve_items(), ["acc1"], min_answered=10)
    assert [p.answered for p in points] == [8]


def test_answered_clips_without_confidence_are_ranked_last_and_listed():
    items = curve_items() + [Item("z", None, {"acc1": 1.0})]
    points, unranked = coverage_curve(items, ["acc1"], min_answered=1)
    assert unranked == ["z"]
    last = points[-1]
    assert last.answered == 9 and last.min_confidence is None
    assert last.accuracy["acc1"].total == 6.0


def test_coverage_curve_ties_break_by_track_id():
    items = [Item("b", 0.5, {"m": 0.0}), Item("a", 0.5, {"m": 1.0})]
    first = coverage_curve(items, ["m"], levels=(0.5,), min_answered=1)[0][0]
    assert first.answered == 1 and first.accuracy["m"].mean == 1.0


def test_mcnemar_exact():
    assert mcnemar_exact(0, 0) == 1.0
    # 0 vs 6 discordant: 2 * 0.5**6
    assert mcnemar_exact(0, 6) == pytest.approx(2 * 0.5**6)
    assert mcnemar_exact(3, 3) == 1.0


def test_paired_comparison_on_both_answered_and_all_n():
    first = [
        Item("a", 0.9, {"acc1": 1.0}),
        Item("b", 0.9, {"acc1": 1.0}),
        Item("c", 0.9, {"acc1": 0.0}),
        Item("d", None, None),
    ]
    second = [
        Item("a", 0.9, {"acc1": 1.0}),
        Item("b", None, None),
        Item("c", 0.9, {"acc1": 1.0}),
        Item("d", 0.9, {"acc1": 1.0}),
    ]
    out = compare(first, second, ["acc1"], seed=1)
    both = out["bothAnswered"]
    assert both["n"] == 2  # a and c
    assert both["metrics"]["acc1"] == {
        "firstCorrect": 1,
        "secondCorrect": 2,
        "onlyFirst": 0,
        "onlySecond": 1,
        "mcnemarP": 1.0,
    }
    all_n = out["allN"]
    assert all_n["n"] == 4
    assert all_n["metrics"]["acc1"]["firstCorrect"] == 2
    assert all_n["metrics"]["acc1"]["secondCorrect"] == 3
    assert (all_n["metrics"]["acc1"]["onlyFirst"], all_n["metrics"]["acc1"]["onlySecond"]) == (1, 2)


def test_paired_mirex_reports_the_mean_difference():
    first = [Item(t, 0.5, {"mirex": v}) for t, v in zip("abc", (1.0, 0.5, 0.0), strict=True)]
    second = [Item(t, 0.5, {"mirex": v}) for t, v in zip("abc", (1.0, 0.0, 0.0), strict=True)]
    m = compare(first, second, ["mirex"], seed=1)["allN"]["metrics"]["mirex"]
    assert m["firstMean"] == pytest.approx(0.5) and m["secondMean"] == pytest.approx(1 / 3)
    assert m["difference"]["mean"] == pytest.approx(1 / 6)


def test_comparison_needs_the_same_clips():
    with pytest.raises(ValueError):
        compare([Item("a", 1, {"acc1": 1.0})], [Item("b", 1, {"acc1": 1.0})], ["acc1"], seed=1)


def test_ranking_auc_says_whether_the_confidence_puts_right_answers_first():
    r = ranking_auc(curve_items(), "acc1")
    # 5 right, 3 wrong; "h" (wrong) outranks all 5 right ones, "f" and "g" are below them.
    assert (r["correct"], r["wrong"]) == (5, 3)
    assert r["auc"] == pytest.approx(10 / 15)
    assert 0 < r["p"] < 1
    perfect = [
        Item(t, c, {"acc1": float(c > 0.5)})
        for t, c in zip("abcd", (0.9, 0.8, 0.2, 0.1), strict=True)
    ]
    assert ranking_auc(perfect, "acc1")["auc"] == 1.0
    one_sided = ranking_auc([Item("a", 0.9, {"acc1": 1.0})], "acc1")
    assert (one_sided["auc"], one_sided["p"]) == (None, None)


def test_the_last_curve_point_is_the_summary_over_answered_clips():
    items = [
        Item(t, c, {"mirex": v})
        for t, c, v in zip("abcd", (0.9, 0.8, 0.7, 0.6), (1, 0.5, 0, 0.3), strict=True)
    ]
    points, _ = coverage_curve(items, ["mirex"], seed=5, min_answered=1)
    assert (
        points[-1].accuracy["mirex"] == summarize(items, ["mirex"], seed=5).over_answered["mirex"]
    )

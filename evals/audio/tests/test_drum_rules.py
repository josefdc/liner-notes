"""
The drum counts services/audio/README.md quotes, read by scripts/drum_rules.py from the
2026-10-29 report; its measurements on generated hits whose answer is known; its check against
the report; and how it counts gains and costs, on a small table. The script's full run (every
served control and clip analysed again) is made by hand.
"""

import importlib.util

import numpy as np
import pytest

from evals_audio import service
from evals_audio.service import REPO_ROOT

SCRIPT = REPO_ROOT / "evals" / "audio" / "scripts" / "drum_rules.py"
REPORT = REPO_ROOT / "evals" / "reports" / "audio-2026-10-29.json"
SR = 22050


def load_script():
    spec = importlib.util.spec_from_file_location("drum_rules", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def served():
    script = load_script()
    _, controls_run, key_run, calibration_run = script.newest(REPORT)
    assert controls_run["gitCommit"] == "9682a4a"
    assert key_run["gitCommit"] == calibration_run["gitCommit"] == "2901b7f"
    return script, controls_run, script.served_rows(controls_run, key_run, calibration_run)


def test_the_served_drum_keys_are_the_reports(served):
    script, _, rows = served
    keyed = {
        est: {
            (family, span): sum(r["drum"] == (family, span) and r["keys"][est][0] for r in rows)
            for family in script.DRUMS
            for span in script.SPANS
        }
        for est in script.ESTIMATORS
    }
    assert keyed == {
        "essentia": {
            ("toms", "pinned"): 9,
            ("toms", "held out"): 8,
            ("kit-toms", "pinned"): 7,
            ("kit-toms", "held out"): 15,
            ("tabla", "pinned"): 11,
            ("tabla", "held out"): 12,
        },
        "librosa": {
            ("toms", "pinned"): 7,
            ("toms", "held out"): 4,
            ("kit-toms", "pinned"): 6,
            ("kit-toms", "held out"): 17,
            ("tabla", "pinned"): 10,
            ("tabla", "held out"): 8,
        },
    }
    clips = [r for r in rows if r["kind"] == "clip"]
    assert len(clips) == 48
    for est in script.ESTIMATORS:
        assert sum(r["keys"][est][0] for r in clips) == 48


def test_the_served_drums_fail_the_time_test_on_shared_variance(served):
    """What the README says keeps the drums' keys: their lines do not rise and fall together."""
    script, controls_run, rows = served
    failing = script.time_test(rows, controls_run["rules"]["one_source"])
    assert failing == {
        ("toms", "pinned"): {"shared": 8, "movement+shared": 2},
        ("toms", "held out"): {"shared": 7, "bins+shared": 1},
        ("kit-toms", "pinned"): {"shared": 6, "movement+shared": 1},
        ("kit-toms", "held out"): {"shared": 15, "movement+shared": 3},
        ("tabla", "pinned"): {
            "shared": 5,
            "movement+shared": 3,
            "movement": 2,
            "still, spell a chord": 2,
        },
        ("tabla", "held out"): {
            "shared": 6,
            "movement+shared": 3,
            "movement": 2,
            "still, spell a chord": 1,
        },
    }


def hits(pitches_of, seconds: float = 8.0, period: float = 0.25, decay: float = 0.1):
    """
    A hit every `period` s, cut at the next: one sine per function in `pitches_of` (Hz over the
    hit's own time), dying away with the time constant `decay`.
    """
    t = np.arange(int(period * SR)) / SR
    tone = sum(np.sin(2 * np.pi * np.cumsum(pitch_of(t)) / SR) for pitch_of in pitches_of)
    hit = tone * np.exp(-t / decay) * np.minimum(1, t / 0.002)
    y = np.zeros(int(seconds * SR))
    for start in range(0, y.size - hit.size, hit.size):
        y[start : start + hit.size] += hit
    return (0.5 * y / np.abs(y).max()).astype(np.float32)


def steady(hz: float):
    return lambda t: np.full(t.size, hz)


def measured_on(function, *args, **kwargs) -> float:
    _, E = service.load()
    return function(E.Signals(hits(*args, **kwargs), SR))


def test_gliding_partials_tell_a_falling_drum_from_a_struck_note():
    script = load_script()
    glide = script.gliding_partials
    assert measured_on(glide, [lambda t: 180.0 * (1 + 0.15 * np.exp(-t / 0.05))]) > 0.9
    # A 5 % drop falls some 20 cents between the frames, near GLIDE_CENTS: part of it counts.
    assert measured_on(glide, [lambda t: 180.0 * (1 + 0.05 * np.exp(-t / 0.06))]) > 0.5
    assert abs(measured_on(glide, [steady(180.0)])) < 0.05
    assert measured_on(glide, [lambda t: 180.0 * (1 - 0.15 * np.exp(-t / 0.05))]) < -0.9


@pytest.mark.parametrize("triad", [(261.63, 329.63, 392.0), (110.0, 138.59, 164.81)])
def test_a_struck_triad_cut_while_it_rings_does_not_glide(triad):
    """Its partials start again with a new phase at each hit; they hold their pitch."""
    script = load_script()
    shown = measured_on(script.gliding_partials, [steady(f) for f in triad], decay=0.4)
    assert abs(shown) < 0.05


@pytest.mark.parametrize("decay, low, high", [(0.03, 0.0, 0.03), (0.1, 0.15, 0.3)])
def test_decaying_lines_reads_the_energy_left_after_70_ms(decay, low, high):
    """
    A hit dying away with a time constant of 30 ms keeps 0.9 % of its energy after 70 ms, one
    of 100 ms (cut at 250 ms) 24 %; the frames' 93 ms windows blur it a little.
    """
    script = load_script()
    assert low <= measured_on(script.decaying_lines, [steady(220.0)], decay=decay) <= high


def test_hit_spans_start_at_the_quiet_frame_before_each_hit_and_split_between_them():
    script = load_script()
    energy = np.array([0, 0, 1, 9, 4, 1, 0.5, 0.2, 2, 8, 3, 1, 0.1, 0.0])
    # onset_detect marks each hit a frame or two after its loudest frame.
    assert script.hit_spans(energy, np.array([4, 10])) == [(0, 3, 7), (7, 9, 14)]
    assert script.hit_spans(energy, np.array([3, 4, 10])) == [(0, 3, 7), (7, 9, 14)]
    assert script.hit_spans(energy, np.array([], dtype=int)) == []


def recorded_row(rows, name):
    row = next(r for r in rows if r["name"] == name)
    source = row["source"]
    got = {
        "withheld": None,
        "source": [source["bins"], source["movement"], source["shared"], source["depth"]],
        "keys": {est: row["estimates"][est] if row["served"][est] else None for est in row["keys"]},
    }
    return row, got


@pytest.mark.parametrize("name", ["toms-s502", "16"])
def test_reproduce_refuses_any_difference_from_the_report(served, name):
    """A control and a clip (its evidence from the GiantSteps+ calibration run)."""
    script, _, rows = served
    row, got = recorded_row(rows, name)
    assert row["kind"] == ("clip" if name == "16" else "control")
    assert script.reproduce([row], {name: got}) == 1
    tonic, mode, strength = got["keys"]["essentia"]
    other = "C" if tonic != "C" else "D"
    bins, movement, shared, depth = got["source"]

    def source(i, value):
        changed = list(got["source"])
        changed[i] = value
        return {**got, "source": changed}

    changes = {
        "withheld": {**got, "withheld": "one_held_pitch"},
        "bins": source(0, bins + 1),
        "movement": source(1, movement + 0.01),
        "shared": source(2, shared * (1 + 1e-4)),
        "depth": source(3, depth * (1 - 1e-4)),
        "tonic, same strength": {
            **got,
            "keys": {**got["keys"], "essentia": (other, mode, strength)},
        },
        "mode": {
            **got,
            "keys": {
                **got["keys"],
                "essentia": (tonic, "minor" if mode == "major" else "major", strength),
            },
        },
        "strength 1e-4": {
            **got,
            "keys": {**got["keys"], "essentia": (tonic, mode, strength * (1 + 1e-4))},
        },
        "withheld key": {**got, "keys": {**got["keys"], "librosa": None}},
    }
    for what, changed in changes.items():
        with pytest.raises(SystemExit, match=name):
            script.reproduce([row], {name: changed})
        assert what
    # The recorded estimate disagrees with the key served: refused too.
    wrong = {**row, "estimates": {**row["estimates"], "essentia": (other, mode, strength)}}
    with pytest.raises(SystemExit, match=name):
        script.reproduce([wrong], {name: got})
    # Within the tolerances (a float32 round trip), the same evidence and key.
    close = {
        **got,
        "source": [bins, movement * (1 + 1e-8), shared, depth],
        "keys": {**got["keys"], "essentia": (tonic, mode, strength * (1 + 1e-7))},
    }
    assert script.reproduce([row], {name: close}) == 1


def test_membrane_modes_tell_a_drum_head_from_a_string():
    script = load_script()
    head = [steady(180.0 * r) for r in (1.0, *script.MEMBRANE_RATIOS)]
    string = [steady(180.0 * k) for k in (1, 2, 3, 4, 5)]
    assert measured_on(script.membrane_modes, head) > 0.5
    assert measured_on(script.membrane_modes, string) < -0.5


def test_membrane_modes_weigh_each_hit_by_its_energy():
    """A loud drum-head hit and two quiet string hits: the loud one carries the mean."""
    script = load_script()
    _, E = service.load()
    head = [(steady(180.0 * r), 1.0) for r in (1.0, *script.MEMBRANE_RATIOS)]
    string = [(steady(180.0 * k), 0.25) for k in (1, 2, 3, 4, 5)]
    y = cycled_hits([head, string, string])
    assert script.membrane_modes(E.Signals(y, SR)) > 0.5


def test_a_falling_strongest_partial_reads_a_drum_falling_in_pitch():
    script = load_script()
    falling = measured_on(
        script.falling_partial, [lambda t: 180.0 * (1 + 0.15 * np.exp(-t / 0.05))]
    )
    assert falling < -35
    assert abs(measured_on(script.falling_partial, [steady(180.0)])) < 5


def cycled_hits(kinds, seconds: float = 8.0, period: float = 0.25, decay: float = 0.1):
    """
    A hit every `period` s, cut at the next, cycling through `kinds`: each a list of (pitch
    function, amplitude) sines, dying away with the time constant `decay`.
    """
    t = np.arange(int(period * SR)) / SR
    envelope = np.exp(-t / decay) * np.minimum(1, t / 0.002)
    tones = [
        sum(a * np.sin(2 * np.pi * np.cumsum(pitch_of(t)) / SR) for pitch_of, a in kind)
        for kind in kinds
    ]
    y = np.zeros(int(seconds * SR))
    for i, start in enumerate(range(0, y.size - t.size, t.size)):
        y[start : start + t.size] += tones[i % len(tones)] * envelope
    return (0.5 * y / np.abs(y).max()).astype(np.float32)


def test_a_falling_strongest_partial_follows_the_strongest_over_uneven_hits():
    """
    The strongest of three partials falls 15 % in two hits of three and rises as much in the
    third; two weaker ones hold still. The median over hits follows the falls.
    """
    script = load_script()
    _, E = service.load()
    held = [(steady(470.0), 0.3), (steady(730.0), 0.2)]
    fall = [(lambda t: 180.0 * (1 + 0.15 * np.exp(-t / 0.05)), 1.0), *held]
    rise = [(lambda t: 180.0 * (1 - 0.15 * np.exp(-t / 0.05)), 1.0), *held]
    shown = script.falling_partial(E.Signals(cycled_hits([fall, fall, rise]), SR))
    assert -150 < shown < -35


def stabs(notes, partials, bpm: float = 120.0, decay: float = 0.3, seconds: float = 30.0):
    """A chord struck on every beat, each note with `partials` (amplitudes of harmonics 1, 2...)."""
    period = 60.0 / bpm
    t = np.arange(int(period * SR)) / SR
    tone = sum(
        a * np.sin(2 * np.pi * f * (k + 1) * t) for f in notes for k, a in enumerate(partials)
    )
    hit = tone * np.exp(-t / decay) * np.minimum(1, t / 0.004) * np.minimum(1, (period - t) / 0.01)
    y = np.zeros(int(seconds * SR))
    for start in range(0, y.size - hit.size, hit.size):
        y[start : start + hit.size] += hit
    return (0.5 * y / np.abs(y).max()).astype(np.float32)


TRIANGLE = (1, 0, 1 / 9, 0, 1 / 25)
# The membrane-mode threshold the 2026-10-29 run chose on the training half.
MEMBRANE_THRESHOLD = 0.0206


def test_an_inverted_triad_reads_as_membrane_modes_and_would_lose_its_right_key():
    """
    A known cost of the membrane-mode rule: three of MEMBRANE_RATIOS lie 7-14 cents from a
    minor sixth, a minor ninth and an eleventh, the intervals of an inverted triad. A minor
    struck as E4-A4-C5 in a triangle timbre gets its right key from both estimators, and reads
    far above the threshold; the same timbre in root position (C4-E4-G4) reads below it.
    """
    script = load_script()
    _, E = service.load()
    inverted = E.Signals(stabs((329.63, 440.0, 523.25), TRIANGLE), SR)
    assert inverted.key_withheld() is None
    for est in ("essentia", "librosa"):
        key = E.select_estimator(est).key(inverted)
        assert (key.tonic, key.mode) == ("A", "minor"), est
    assert script.membrane_modes(inverted) > 10 * MEMBRANE_THRESHOLD
    root = E.Signals(stabs((261.63, 329.63, 392.0), TRIANGLE), SR)
    assert script.membrane_modes(root) < MEMBRANE_THRESHOLD


def test_without_a_hit_there_is_nothing_to_measure():
    script = load_script()
    _, E = service.load()
    signals = E.Signals(np.zeros(4 * SR, dtype=np.float32), SR)
    assert script.onsets(signals).size == 0
    for measure in ("gliding_partials", "decaying_lines", "membrane_modes", "falling_partial"):
        assert getattr(script, measure)(signals) is None


def table():
    """
    Drums, right and wrong control keys and a clip, with two measurements. Training: toms-s500,
    pad-s700 and the clip "7" (the first unseeded name); held out: the rest.
    """

    def row(name, drum_, group, keys, kind="control"):
        return {"name": name, "kind": kind, "drum": drum_, "group": group, "keys": keys}

    both = {"essentia": (True, False), "librosa": (True, False)}
    right = {"essentia": (True, True), "librosa": (True, True)}
    rows = [
        row("toms-s500", ("toms", "pinned"), "toms", both),
        row("toms-s600", ("toms", "held out"), "toms", both),
        row("tabla-s600", ("tabla", "held out"), "tabla", {**both, "librosa": (False, False)}),
        row("pad-s700", None, "faded-pad", right),
        row("pad-s800", None, "faded-pad", right),
        row("cowbell", None, "cowbell", both),
        row("7", None, "GiantSteps+", {**right, "librosa": (True, False)}, kind="clip"),
    ]
    values = {
        "toms-s500": (0.9, 0.8),
        "toms-s600": (0.5, 0.9),
        "tabla-s600": (0.2, 0.9),
        "pad-s700": (0.3, 0.9),
        "pad-s800": (0.65, 0.1),
        "cowbell": (0.95, 0.1),
        "7": (0.1, 0.1),
    }
    return rows, {name: {"r": r, "q": q} for name, (r, q) in values.items()}


def test_halves_split_seeded_rows_by_seed_and_the_rest_alternately():
    script = load_script()
    rows, _ = table()
    assert script.halves(rows) == {
        "toms-s500": "training",
        "toms-s600": "held out",
        "tabla-s600": "held out",
        "pad-s700": "training",
        "pad-s800": "held out",
        "7": "training",
        "cowbell": "held out",
    }


def test_drum_counts_and_costs_on_a_small_table():
    script = load_script()
    rows, measured = table()
    rule = ("any", {"r": 0.6})
    counts = script._drum_counts(rows, measured, rule)
    assert counts["essentia"][("toms", "pinned")] == (1, 1)
    assert counts["essentia"][("toms", "held out")] == (0, 1)
    assert counts["essentia"][("tabla", "held out")] == (0, 1)
    assert counts["librosa"][("tabla", "held out")] == (0, 0)
    assert script._costs(rows, measured, rule) == {
        "essentia": {"faded-pad": (1, 1), "cowbell": (0, 1)},
        "librosa": {"faded-pad": (1, 1), "cowbell": (0, 1)},
    }
    # "all" needs each measurement; the clip's right Essentia key and wrong librosa one.
    assert script._costs(rows, measured, ("all", {"r": 0.05, "q": 0.05}))["essentia"] == {
        "faded-pad": (2, 2),
        "cowbell": (0, 1),
        "GiantSteps+": (1, 1),
    }
    assert script._costs(rows, measured, ("all", {"r": 0.05, "q": 0.05}))["librosa"][
        "GiantSteps+"
    ] == (0, 1)
    assert script._costs(rows, measured, ("all", {"r": 0.05, "q": 0.95})) == {
        "essentia": {},
        "librosa": {},
    }


def test_candidates_choose_on_the_training_half_and_judge_both(monkeypatch):
    script = load_script()
    rows, measured = table()
    monkeypatch.setattr(script, "CANDIDATES", {"one": ("any", ("r",), None)})
    got = script.candidates(rows, measured)["one"]
    # The training half's most drum-like right key is pad-s700 (0.3), its drum toms-s500 (0.9).
    ((threshold, top),) = got["free"].values()
    assert top == 0.3 and threshold == pytest.approx(0.6)
    assert got["freeDrums"]["essentia"][("toms", "pinned")] == (1, 1)
    assert got["freeDrums"]["essentia"][("toms", "held out")] == (0, 1)
    assert got["freeCosts"]["training"] == {"essentia": {}, "librosa": {}}
    # Held out, it takes pad-s800's right key (0.65) and the cowbell's wrong one.
    assert got["freeCosts"]["held out"]["essentia"] == {"faded-pad": (1, 1), "cowbell": (0, 1)}
    # The one training drum key is more than half of them at its own value.
    assert got["most"] == 0.9
    assert got["mostCosts"]["held out"]["librosa"] == {"cowbell": (0, 1)}


def test_a_pair_of_measurements_is_placed_in_both_gaps(monkeypatch):
    script = load_script()
    rows, measured = table()
    monkeypatch.setattr(script, "CANDIDATES", {"two": ("all", ("r", "q"), None)})
    got = script.candidates(rows, measured)["two"]
    # r from toms-s500 (0.9) halfway down to pad-s700 (0.3); no right key of the training half
    # reaches it, so q is placed just under the drum's 0.8.
    assert got["free"]["r"] == (pytest.approx(0.6), None)
    assert got["free"]["q"][0] == pytest.approx(0.8) and got["free"]["q"][1] == -np.inf
    assert got["most"] is None
    assert got["freeCosts"]["held out"] == {"essentia": {}, "librosa": {}}
    # Aimed at the tabla, which has no training key, it finds nothing.
    monkeypatch.setattr(script, "CANDIDATES", {"two": ("all", ("r", "q"), ("tabla",))})
    assert script.candidates(rows, measured)["two"]["free"] is None


def search_table():
    """
    Six training toms (0.9 down to 0.4): Essentia served the first four, librosa all six. One
    unseeded control (training: it is the only one) with a right key from Essentia only.
    """
    rows, measured = [], {}
    for i, value in enumerate((0.9, 0.8, 0.7, 0.6, 0.5, 0.4)):
        name = f"toms-s50{i}"
        rows.append(
            {
                "name": name,
                "kind": "control",
                "drum": ("toms", "pinned"),
                "group": "toms",
                "keys": {"essentia": (i < 4, False), "librosa": (True, False)},
            }
        )
        measured[name] = {"r": value, "q": 0.8}
    rows.append(
        {
            "name": "melody",
            "kind": "control",
            "drum": None,
            "group": "music",
            "keys": {"essentia": (True, True), "librosa": (True, False)},
        }
    )
    measured["melody"] = {"r": 0.55, "q": 0.9}
    return rows, measured


def test_more_than_half_is_the_strictest_threshold_for_both_estimators(monkeypatch):
    """
    From the top: at 0.8 Essentia has 2 of 4 (half, not more); at 0.7 it has 3 of 4 but
    librosa 3 of 6; at 0.6, 4 of 6. Not the weakest threshold either (0.4 takes all).
    """
    script = load_script()
    rows, measured = search_table()
    monkeypatch.setattr(script, "CANDIDATES", {"one": ("any", ("r",), None)})
    got = script.candidates(rows, measured)["one"]
    assert got["most"] == 0.6
    assert got["mostDrums"]["essentia"][("toms", "pinned")] == (4, 4)
    assert got["mostDrums"]["librosa"][("toms", "pinned")] == (4, 6)


def test_a_key_right_with_one_estimator_counts_as_right(monkeypatch):
    """The melody's key is right with Essentia only; the free threshold must stay above it."""
    script = load_script()
    rows, measured = search_table()
    monkeypatch.setattr(script, "CANDIDATES", {"one": ("any", ("r",), None)})
    got = script.candidates(rows, measured)["one"]
    ((threshold, top),) = got["free"].values()
    assert top == 0.55 and threshold == pytest.approx(0.575)
    assert got["freeCosts"]["training"] == {"essentia": {}, "librosa": {}}


def test_a_pair_keeps_the_first_threshold_that_withholds_most_drums(monkeypatch):
    """
    With r from 0.6 down to the melody's 0.55, q has no right key to clear: four toms go. From
    0.7 or 0.8 fewer go; from 0.5 the melody's q (0.9) is above every tom's.
    """
    script = load_script()
    rows, measured = search_table()
    monkeypatch.setattr(script, "CANDIDATES", {"two": ("all", ("r", "q"), None)})
    got = script.candidates(rows, measured)["two"]
    assert got["free"]["r"] == (pytest.approx(0.575), None)
    assert got["freeDrums"]["librosa"][("toms", "pinned")] == (4, 6)

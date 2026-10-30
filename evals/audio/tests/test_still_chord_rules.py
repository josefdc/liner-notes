"""
The keys services/audio/README.md says the cowbell, the one-note bass and the church bell
(alone and over drums) keep, read by scripts/still_chord_rules.py from the 2026-10-29 report;
why they are kept; the script's measurements on lines and signals whose answer is known; its
check against the report; and a chord whose right key one of its rules would take. The
script's full run (every served control and clip analysed again) is made by hand.
"""

import importlib.util

import numpy as np
import pytest

from evals_audio import controls as C
from evals_audio import service
from evals_audio.service import REPO_ROOT

SCRIPT = REPO_ROOT / "evals" / "audio" / "scripts" / "still_chord_rules.py"
# Without the models extra the service answers for Essentia with librosa, so Essentia's own
# keys are checked only where it is installed.
HAS_ESSENTIA = importlib.util.find_spec("essentia") is not None
REPORT = REPO_ROOT / "evals" / "reports" / "audio-2026-10-29.json"
SR = 22050


def load_script():
    spec = importlib.util.spec_from_file_location("still_chord_rules", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def served():
    script = load_script()
    _, controls_run, key_run, calibration_run = script.D.newest(REPORT)
    assert controls_run["gitCommit"] == "9682a4a"
    rows = script.D.served_rows(controls_run, key_run, calibration_run, script.FAMILIES)
    return script, controls_run, rows


def test_the_served_keys_of_the_four_families_are_the_reports(served):
    """The counts #83 lists, Essentia / librosa: pinned seeds 500-529, held out 600-629."""
    script, _, rows = served
    keyed = {
        est: {
            (family, span): sum(r["drum"] == (family, span) and r["keys"][est][0] for r in rows)
            for family in script.FAMILIES
            for span in ("pinned", "held out")
        }
        for est in ("essentia", "librosa")
    }
    assert keyed == {
        "essentia": {
            ("cowbell", "pinned"): 3,
            ("cowbell", "held out"): 3,
            ("one-note-bass", "pinned"): 2,
            ("one-note-bass", "held out"): 5,
            ("bell", "pinned"): 7,
            ("bell", "held out"): 4,
            ("bell-over-drums", "pinned"): 4,
            ("bell-over-drums", "held out"): 2,
        },
        "librosa": {
            ("cowbell", "pinned"): 2,
            ("cowbell", "held out"): 2,
            ("one-note-bass", "pinned"): 0,
            ("one-note-bass", "held out"): 2,
            ("bell", "pinned"): 7,
            ("bell", "held out"): 4,
            ("bell-over-drums", "pinned"): 4,
            ("bell-over-drums", "held out"): 2,
        },
    }
    # No served key of these families is right: their truth is no key.
    assert not any(ok for r in rows if r["drum"] for _, ok in r["keys"].values())


def classes(notes) -> int:
    return len({int(round(69 + 12 * np.log2(f / 440.0))) % 12 for f in notes})


def cents(high: float, low: float) -> float:
    return 1200 * np.log2(high / low)


def test_every_kept_key_of_the_four_families_comes_from_still_lines_that_spell_a_chord(served):
    """
    What the README says keeps them: the single-source rule asks what their lines spell, and
    the recorded notes are a chord. Every bell's second note is its tierce, a minor tenth over
    the hum. Four cowbells' oscillators lie a minor sixth apart (one with a drum's line under
    them); in the other two the third harmonic of one oscillator is a note. The one-note
    basses spell three pitch classes or more (why: test_each_keyed_one_note_bass_keeps_its_notes_
    for_the_causes_the_readme_gives). No GiantSteps+ clip with a served key has still lines.
    """
    script, controls_run, rows = served
    _, E = service.load()
    still = script.still_rows(rows, controls_run["rules"]["one_source"])
    targets = {r["name"]: r for r in rows if r["drum"]}
    assert len(targets) == 30 and all(r in still for r in targets.values())
    for name, r in targets.items():
        notes = r["source"]["notes"]
        assert r["source"]["chord"] and E.spells_chord(tuple(notes)), name
        family = r["drum"][0]
        if family in ("bell", "bell-over-drums"):
            assert abs(cents(notes[1], notes[0]) - 1500) <= E.SOURCE_THIRD_CENTS, name
        elif family == "one-note-bass":
            assert classes(notes) >= 3, name
    sixths = {"cowbell-s508", "cowbell-s515", "cowbell-s600", "cowbell-s601"}
    for name in sixths:
        low, high = [f for f in targets[name]["source"]["notes"] if f > 400]
        assert abs(cents(high, low) - 800) <= E.SOURCE_THIRD_CENTS, name
    for name in ("cowbell-s528", "cowbell-s606"):
        *lower, top = targets[name]["source"]["notes"]
        assert any(abs(top - 3 * f) <= E.SOURCE_NOTE_TOLERANCE * top for f in lower), name
    cowbells = {n for n in targets if n.startswith("cowbell")}
    assert cowbells == sixths | {"cowbell-s528", "cowbell-s606"}
    assert not any(r["kind"] == "clip" for r in still)


def measured_lines(name: str):
    """A control's lines and the script's notes, measured again."""
    script = load_script()
    signals = script.D.signals_of(("control", name, 1, ""))
    lines = script.note_lines(signals.harmonic_stft, signals.sr, signals.hop)
    return script, signals, lines


def test_the_script_spells_the_services_notes_on_a_cowbell_and_a_bass():
    """Its copy of source_notes gives the service's own notes (and the recorded ones)."""
    for name in ("cowbell-s528", "one-note-bass-s501"):
        script, signals, lines = measured_lines(name)
        evidence = signals.source_evidence
        assert evidence.still
        assert script.spelled(lines) == evidence.notes


def test_a_cowbells_third_harmonic_over_half_its_oscillator_is_a_note():
    """
    cowbell-s528: 2423 Hz is three times the weaker oscillator (808 Hz) but its line reads 0.53
    of that oscillator's level, over SOURCE_OVERTONE_RATIO, so it stays a third pitch class; folded at 0.54 the
    notes are a fourth apart, no chord.
    """
    script, _, lines = measured_lines("cowbell-s528")
    _, E = service.load()
    level = dict(lines)
    low, mid, high = script.spelled(lines)
    assert abs(high - 3 * mid) <= E.SOURCE_NOTE_TOLERANCE * high
    assert E.SOURCE_OVERTONE_RATIO < level[high] / level[mid] < 0.54
    assert script.overtone_ratio(lines) == 0.54
    assert script.spelled(lines, 0.54) == (low, mid)


def test_a_one_note_bass_keeps_harmonics_off_its_fundamental_line():
    """
    one-note-bass-s501 (G2, 98 Hz): a line at 90.9 Hz next to the note pulls the fundamental
    line to 97.4 Hz, so its third harmonic (293.6 Hz) lies 0.46 % off, beyond
    SOURCE_NOTE_TOLERANCE, and counts as a note.
    """
    script, _, lines = measured_lines("one-note-bass-s501")
    _, E = service.load()
    notes = script.spelled(lines)
    assert 90 < notes[0] < 92 and 97 < notes[1] < 98
    third = next(f for f in notes if 280 < f < 300)
    # 0.46 % off in the run; under 2 tolerances, so it is the line's harmonic and not a note.
    off = abs(third - 3 * notes[1]) / third
    assert E.SOURCE_NOTE_TOLERANCE < off < 2 * E.SOURCE_NOTE_TOLERANCE


# Why each keyed one-note bass's notes are not one note (kept_because, from its lines measured
# again; the run prints the same): {cause: (notes kept for it, whether the other notes still spell
# a chord)}. The generator stretches the harmonics of seeds 500, 611, 617 and 626 (seed % 3 ==
# 2, B = 0.0008) and not those of 501, 612 and 615 (B = 0).
OFF, LOUD = "a harmonic off its line", "a harmonic too loud to fold"
UNDER, BESIDE = "under the note", "beside the note"
BASS_CAUSES = {
    500: {OFF: (9, True), BESIDE: (2, True), UNDER: (5, True)},
    501: {OFF: (5, True), UNDER: (1, True)},
    611: {OFF: (9, True), LOUD: (1, True), UNDER: (1, True)},
    612: {LOUD: (2, True), BESIDE: (1, True), UNDER: (3, True)},
    615: {LOUD: (1, True), BESIDE: (1, False)},
    617: {OFF: (10, False)},
    626: {OFF: (10, True), BESIDE: (1, True)},
}


@pytest.mark.parametrize("seed", sorted(BASS_CAUSES))
def test_each_keyed_one_note_bass_keeps_its_notes_for_the_causes_the_readme_gives(seed, served):
    script, _, rows = served
    name = f"one-note-bass-s{seed}"
    assert any(r["name"] == name and r["drum"] and r["keys"]["essentia"][0] for r in rows)
    _, _, lines = measured_lines(name)
    assert script.bass_causes(lines) == BASS_CAUSES[seed]


def test_kept_because_reads_each_cause_on_lines_whose_answer_is_known():
    script = load_script()
    _, E = service.load()
    f0 = 100.0
    off = 3 * f0 * (1 + 2 * E.SOURCE_NOTE_TOLERANCE)
    lines = [(95.0, 0.3), (f0, 1.0), (104.0, 0.3), (200.0, 0.4), (off, 0.3), (500.0, 0.6)]
    assert script.kept_because(lines) == {
        95.0: script.UNDER,
        104.0: script.BESIDE,
        off: script.OFF,
        500.0: script.LOUD,
    }
    # The octave folds at any level within SOURCE_OCTAVE_TOLERANCE; a fifth harmonic at no more
    # than SOURCE_OVERTONE_RATIO of the note folds too.
    assert script.kept_because([(f0, 1.0), (200.0, 0.9), (500.0, 0.5)]) == {}
    # Loudness is over the note's own level: here the strongest line folds into the note an
    # octave under it (0.5), and a fifth harmonic at 0.3 is more than half of that.
    assert script.kept_because([(f0, 0.5), (200.0, 1.0), (500.0, 0.3)]) == {500.0: script.LOUD}
    assert script.kept_because([]) == {}


def test_overtone_ratio_on_lines_whose_answer_is_known():
    script = load_script()
    # A fourth (A4, D5) with the lower note's third harmonic (E6) at 0.71 of it: three pitch
    # classes, a fourth when it folds, from 0.71.
    lines = [(440.0, 0.6), (587.3, 1.0), (1320.0, 0.426)]
    assert script.overtone_ratio(lines) == 0.71
    assert script.spelled(lines, 0.7) == (440.0, 587.3, 1320.0)
    # A minor sixth is a chord whatever folds.
    assert script.overtone_ratio([(500.0, 1.0), (793.7, 0.8)]) is None


def test_series_share_finds_a_stiff_strings_stretched_harmonics():
    script = load_script()
    f0, stiffness = 98.0, 0.0008
    stretched = [(f0 * k * np.sqrt(1 + stiffness * k * k), 1.0 / k) for k in range(1, 11)]
    assert script.series_share(stretched) == pytest.approx(1.0)
    # The stiffest string the series is sought for (B = 0.002), its tenth harmonic 9.5 % sharp.
    stiffest = [(f0 * k * np.sqrt(1 + 0.002 * k * k), 1.0 / k) for k in range(1, 11)]
    assert script.series_share(stiffest) == pytest.approx(1.0)
    # The same lines without a stretch to fit: from the fourth harmonic up they are off.
    stiff = script.STIFFNESS
    try:
        script.STIFFNESS = np.zeros(1)
        assert script.series_share(stretched) < 0.75
    finally:
        script.STIFFNESS = stiff
    # A triad over its root doubled an octave down: the fifth is the low root's third
    # harmonic, but the third is no harmonic of it, and its level is left out.
    triad = [(65.41, 1.0), (130.81, 1.0), (164.81, 0.5), (196.0, 1.0)]
    assert script.series_share(triad) == pytest.approx(3.0 / 3.5)
    # Without the doubled root, only the root's octave is on its series.
    assert script.series_share([(130.81, 1.0), (164.81, 0.5), (196.0, 1.0), (261.63, 0.5)]) == (
        pytest.approx(0.5)
    )
    assert script.series_share([]) is None


def test_merged_adds_a_line_into_a_stronger_one_within_close_cents():
    script = load_script()
    lines = [(90.9, 0.3), (97.4, 1.0), (105.0, 0.1), (196.0, 0.7)]
    assert script.merged(lines, 150.0) == [(97.4, pytest.approx(1.4)), (196.0, 0.7)]
    # 90.9 Hz lies 120 cents under 97.4 Hz, 105 Hz 130 cents over it.
    assert script.merged(lines, 125.0) == [(97.4, pytest.approx(1.3)), (105.0, 0.1), (196.0, 0.7)]
    assert script.merged(lines, 100.0) == lines


def test_third_off_grid_reads_a_dyad_and_nothing_else():
    script = load_script()
    sixth = 500.0 * 2 ** (822 / 1200)
    assert script.third_off_grid((500.0, sixth)) == 22.0
    assert script.third_off_grid((500.0, 500.0 * 2 ** (1500 / 1200))) == 0.0
    # The least of several: the sixth is 22 cents off, the third over the octave 12.
    pair = (500.0, sixth, 500.0 * 2 ** (1210 / 1200))
    assert script.third_off_grid(pair) == 12.0
    # Three pitch classes, a second, or a fifth (no chord interval): nothing to read.
    assert script.third_off_grid((261.6, 329.6, 392.0)) is None
    assert script.third_off_grid((261.6, 293.7, 523.3)) is None
    assert script.third_off_grid((261.6, 392.0)) is None


def test_both_thirds_over_one_note():
    script = load_script()
    hum = 146.8
    # A bell's hum, tierce (a minor tenth), quint and upper third (a major seventeenth).
    bell = (hum, hum * 2.366, hum * 3.012, hum * 5.028)
    assert script.both_thirds(bell) == 1.0
    assert script.both_thirds((hum, hum * 2.366, hum * 3.012)) == 0.0
    # A major and a minor third over different notes do not count.
    assert script.both_thirds((261.6, 329.6, 392.0, 466.2)) == 0.0


def struck(partials, period: float = 2.0, seconds: float = 20.0) -> np.ndarray:
    """A strike every `period` s of sines (Hz, amplitude, decay time constant in s)."""
    t = np.arange(int(period * SR)) / SR
    sound = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / d) for f, a, d in partials)
    sound = sound * np.minimum(1, t / 0.002)
    y = np.zeros(int(seconds * SR))
    for start in range(0, y.size - t.size + 1, t.size):
        y[start : start + t.size] += sound
    return (0.5 * y / np.abs(y).max()).astype(np.float32)


def test_decay_spread_tells_partials_that_die_at_their_own_rate():
    """
    Two partials decaying with time constants of 2 s and 0.5 s lose 4.3 and 17.4 dB a second:
    four times as fast. Struck together with one time constant they decay as one.
    """
    script = load_script()
    _, E = service.load()
    notes = (220.0, 523.3)
    apart = E.Signals(struck([(220.0, 1.0, 2.0), (523.3, 0.8, 0.5)]), SR)
    together = E.Signals(struck([(220.0, 1.0, 0.5), (523.3, 0.8, 0.5)]), SR)
    assert 3.0 < script.decay_spread(apart, notes) < 5.0
    assert 0.9 < script.decay_spread(together, notes) < 1.2
    assert script.decay_spread(apart, (220.0,)) is None
    # A partial 40 dB down, dying fast, is left out (under DECAY_LEVEL of the loudest note):
    # with one note left there is no spread to read.
    quiet = E.Signals(struck([(220.0, 1.0, 0.5), (523.3, 0.8, 0.5), (900.0, 0.01, 0.1)]), SR)
    assert 0.9 < script.decay_spread(quiet, (220.0, 523.3, 900.0)) < 1.2
    assert script.decay_spread(quiet, (220.0, 900.0)) is None


def test_reproduce_refuses_notes_that_differ_from_the_report(served):
    script, _, rows = served
    row = next(r for r in rows if r["name"] == "bell-s509")
    source = row["source"]
    got = {
        "withheld": None,
        "source": [source["bins"], source["movement"], source["shared"], source["depth"]],
        "keys": {est: row["estimates"][est] for est in row["keys"]},
        "notes": list(source["notes"]),
    }
    assert script.reproduce([row], {row["name"]: got}) == 1
    close = {**got, "notes": [f * (1 + 1e-8) for f in source["notes"]]}
    assert script.reproduce([row], {row["name"]: close}) == 1
    for notes in (
        [*source["notes"][:-1], source["notes"][-1] * (1 + 1e-4)],
        source["notes"][:-1],
        None,
    ):
        with pytest.raises(SystemExit, match="bell-s509"):
            script.reproduce([row], {row["name"]: {**got, "notes": notes}})


def test_measure_reads_nothing_from_lines_that_do_not_hold_still():
    script = load_script()
    got = script.analyse(("control", "toms-s502", 1, ""))
    assert got["notes"] is None
    assert all(got[m] is None for m in script.MEASURES)


# The stretched-series thresholds the run on the 2026-10-29 report chose on the training half
# ("no right key of the training half taken at ..."), without and with the close lines merged.
SERIES_THRESHOLD = 0.9048
MERGED_THRESHOLD = 0.9461


def test_a_chord_with_a_softer_third_reads_as_one_stretched_series():
    """
    A known cost of the stretched-series rule: an F major triad in a saw timbre with its root
    doubled an octave down, the third 7.5 dB softer and with tremolo, gets its right key (from
    librosa, and from Essentia where it is installed), yet its lines read as one series over
    the threshold, as a one-note bass's do. With the close lines merged it stays under it.
    """
    script = load_script()
    _, E = service.load()
    sig = C.signals()
    triad = sig._triad(5, "major")

    def y_of(t):
        doubled = sig._chord_tone([triad[0], triad[2], triad[0] - 12], t, "saw")
        return doubled + 10 ** (-7.5 / 20) * sig._chord_tone([triad[1]], t, "saw")

    s = E.Signals(np.asarray(sig._shaped(y_of, "tremolo"), dtype=np.float32), SR)
    assert s.key_withheld() is None and s.source_evidence.still
    for est in ("essentia", "librosa") if HAS_ESSENTIA else ("librosa",):
        key = E.select_estimator(est).key(s)
        assert (key.tonic, key.mode) == ("F", "major"), est
    lines = script.note_lines(s.harmonic_stft, s.sr, s.hop)
    assert script.series_share(lines) > SERIES_THRESHOLD
    assert script.series_share(script.merged(lines, script.CLOSE_CENTS)) < MERGED_THRESHOLD


# Each measurement on four keyed controls, from this script's own analysis (the run on the
# 2026-10-29 report printed the same counts): a cowbell whose oscillators lie a sixth apart, one
# with an unfolded third harmonic, a one-note bass and a church bell. None: not read.
PINNED = {
    "cowbell-s508": {
        "a higher overtone ratio": None,
        "one stretched harmonic series": 0.563975,
        "one stretched series, close lines merged": 0.573493,
        "a third or sixth off the grid": 4.0,
        "lines dying away after each hit": 0.095413,
        "both thirds over one note": 0.0,
        "notes decaying at different rates": 1.043334,
        "note pairs off the grid": 0.0,
        "the lowest note": 524.957662,
        "pitch classes": 2.0,
        "the two lowest notes' interval": 804.0,
    },
    "cowbell-s528": {
        "a higher overtone ratio": 0.54,
        "one stretched harmonic series": 0.589531,
        "one stretched series, close lines merged": 0.517668,
        "a third or sixth off the grid": None,
        "lines dying away after each hit": 0.039950,
        "both thirds over one note": 0.0,
        "notes decaying at different rates": 1.060654,
        "note pairs off the grid": 2 / 3,
        "the lowest note": 527.389095,
        "pitch classes": 3.0,
        "the two lowest notes' interval": 738.0,
    },
    "one-note-bass-s501": {
        "a higher overtone ratio": None,
        "one stretched harmonic series": 0.913713,
        "one stretched series, close lines merged": 0.982829,
        "a third or sixth off the grid": None,
        "lines dying away after each hit": 0.286824,
        "both thirds over one note": 0.0,
        "notes decaying at different rates": 5.410950,
        "note pairs off the grid": 11 / 21,
        "the lowest note": 90.890478,
        "pitch classes": 7.0,
        "the two lowest notes' interval": 120.0,
    },
    "bell-s503": {
        "a higher overtone ratio": None,
        "one stretched harmonic series": 0.770579,
        "one stretched series, close lines merged": 0.806782,
        "a third or sixth off the grid": None,
        "lines dying away after each hit": 0.793168,
        "both thirds over one note": 1.0,
        "notes decaying at different rates": 5.028902,
        "note pairs off the grid": 0.0,
        "the lowest note": 146.801605,
        "pitch classes": 4.0,
        "the two lowest notes' interval": 1492.0,
    },
}


@pytest.mark.parametrize("name", sorted(PINNED))
def test_analyse_reads_each_measurement_of_a_keyed_control(name):
    script = load_script()
    got = script.analyse(("control", name, 1, ""))
    assert set(PINNED[name]) == set(script.MEASURES)
    for measure, value in PINNED[name].items():
        if value is None:
            assert got[measure] is None, measure
        else:
            assert got[measure] == pytest.approx(value, abs=1e-5), measure


# The side each rule withholds on, as services/audio/README.md states it: an overtone that
# folds at a lower ratio, lines that die away sooner and two lowest notes closer together are
# more like the families aimed at; for the rest, higher values are.
WITHHELD_AT_OR_UNDER = {
    "a higher overtone ratio",
    "lines dying away after each hit",
    "the two lowest notes' interval",
}


@pytest.mark.parametrize("measure", sorted(load_script().MEASURES))
def test_each_rule_withholds_on_its_side_of_the_threshold(measure):
    script = load_script()
    threshold = script.signed({"t": {measure: 0.5}})["t"][measure]
    values = script.signed({"low": {measure: 0.4}, "high": {measure: 0.6}, "none": {}})
    rule = ("any", {measure: threshold})
    under = measure in WITHHELD_AT_OR_UNDER
    assert script.D.withholds(values, "low", rule) is under
    assert script.D.withholds(values, "high", rule) is not under
    assert not script.D.withholds(values, "none", rule)


def test_the_measurement_names_are_not_drum_rules_own():
    """drum_rules signs its own measurements again: a shared name would be signed twice."""
    script = load_script()
    assert not set(script.MEASURES) & set(script.D.MEASURES)


def test_each_rule_is_aimed_at_the_families_the_readme_names():
    script = load_script()
    bass, cowbell, bells = ("one-note-bass",), ("cowbell",), ("bell", "bell-over-drums")
    assert {name: aimed for name, (_, _, aimed) in script.CANDIDATES.items()} == {
        "a higher overtone ratio": cowbell + bass,
        "a third or sixth off the grid": cowbell,
        "lines dying away after each hit": cowbell,
        "one stretched harmonic series": bass,
        "one stretched series, close lines merged": bass,
        "both thirds over one note": bells,
        "notes decaying at different rates": bells,
        "note pairs off the grid": bells,
        "the lowest note": cowbell,
        "pitch classes": bass,
        "the two lowest notes' interval": bass,
    }


DYING = "lines dying away after each hit"


def dying_table():
    """
    Training cowbells at 0.02 and 0.05 (Essentia served both, librosa neither), a held-out one
    at 0.03, a training one-note bass at 0.035 (not aimed at) and a training chord at 0.04 with
    a right key from both. The rule withholds at or under its threshold.
    """
    rows, measured = [], {}

    def add(name, family, span, value, keys, group):
        rows.append(
            {
                "name": name,
                "kind": "control",
                "drum": None if family is None else (family, span),
                "group": group,
                "keys": keys,
            }
        )
        measured[name] = {DYING: value}

    keyed = {"essentia": (True, False), "librosa": (False, False)}
    add("cowbell-s500", "cowbell", "pinned", 0.02, keyed, "cowbell")
    add("cowbell-s501", "cowbell", "pinned", 0.05, keyed, "cowbell")
    add("cowbell-s600", "cowbell", "held out", 0.03, keyed, "cowbell")
    add("one-note-bass-s502", "one-note-bass", "pinned", 0.035, keyed, "one-note-bass")
    right = {"essentia": (True, True), "librosa": (True, True)}
    add("chord-s700", None, None, 0.04, right, "chords")
    return rows, measured


def test_candidates_choose_a_threshold_under_which_a_rule_withholds():
    """
    The chord's 0.04 is the most cowbell-like right key; the next cowbell under it reads 0.02,
    so no right key is taken at 0.03 or under. The bass's 0.035 is not aimed at: it neither
    sets that gap nor counts towards "more than half", which needs both training cowbells
    (0.05 or under). Only Essentia served one, so librosa does not count.
    """
    script = load_script()
    rows, measured = dying_table()
    table = {"dying": ("any", (DYING,), ("cowbell",))}
    got = script.D.candidates(rows, script.signed(measured), table, script.FAMILIES)["dying"]
    (threshold, top) = got["free"][DYING]
    assert -threshold == pytest.approx(0.03) and -top == pytest.approx(0.04)
    drums = got["freeDrums"]["essentia"]
    assert drums[("cowbell", "pinned")] == (1, 2) and drums[("cowbell", "held out")] == (1, 1)
    assert drums[("one-note-bass", "pinned")] == (0, 1)
    assert got["freeCosts"]["training"]["essentia"] == {}
    assert -got["most"] == pytest.approx(0.05)
    assert got["mostDrums"]["essentia"][("cowbell", "pinned")] == (2, 2)


def test_report_counts_the_four_families(capsys, monkeypatch):
    script = load_script()
    rows, measured = dying_table()
    monkeypatch.setattr(script, "CANDIDATES", {DYING: script.CANDIDATES[DYING]})
    entries = script.report(rows, measured)
    out = capsys.readouterr().out
    assert set(entries[DYING]["freeDrums"]["essentia"]) == {
        (family, span) for family in script.FAMILIES for span in ("pinned", "held out")
    }
    assert "cowbell pinned 1/2" in out and "lines dying away after each hit at or under 0.03" in out
    assert "(the most family-like right key there, lines dying away after each hit: 0.04, " in out
    assert "chord-s700" in out


def test_probe_chords_lie_just_outside_the_controls():
    script = load_script()
    chords = script.probe_chords()
    groups = [group for group, *_ in chords.values()]
    assert len(chords) == 276
    assert {g: groups.count(g) for g in set(groups)} == {
        "triads C5-G#5": 60,
        "ninths": 144,
        "add2": 72,
    }
    assert chords["flute C5 minor, pumped"][1:] == (
        [72, 75, 79],
        "flute",
        "pumped",
        ("C", "minor"),
    )
    assert chords["organ C#add9, tremolo"][1] == [49, 53, 56, 63, 37]
    assert chords["saw Dm9, tremolo"][1] == [50, 53, 57, 60, 64, 38]
    assert chords["pad C major add2 20 c flat, tremolo"][1] == [48, 49.8, 52, 55]


# The thresholds the run on the 2026-10-29 report chose on the training half for the three plain
# readings ("no right key of the training half taken at ..."): no right key of any control or
# clip lies on their side.
LOWEST_NOTE_THRESHOLD = 505.8  # Hz, at or above
PITCH_CLASS_THRESHOLD = 6.5  # at or above
LOWEST_INTERVAL_THRESHOLD = 193.0  # cents, at or under


@pytest.mark.parametrize(
    "chord, measure, crosses",
    [
        ("pad C5 major, tremolo", "the lowest note", lambda v: v >= LOWEST_NOTE_THRESHOLD),
        ("organ C#add9, tremolo", "pitch classes", lambda v: v >= PITCH_CLASS_THRESHOLD),
        (
            "pad C major add2 20 c flat, pumped",
            "the two lowest notes' interval",
            lambda v: v <= LOWEST_INTERVAL_THRESHOLD,
        ),
    ],
)
def test_a_chord_outside_the_controls_with_its_right_key_crosses_a_plain_reading(
    chord, measure, crosses
):
    """
    Each plain reading takes no right key among the controls, yet a chord a little outside them
    reads on its side: a C major triad from C5 (the cowbells' range), an add9 chord with seven
    pitch classes, an add2 chord whose second lies next to its root (a one-note bass's line
    beside its note). Both estimators serve each its right key.
    """
    script = load_script()
    got = script.probe_analyse(chord)
    truth = script.probe_chords()[chord][-1]
    assert got["withheld"] is None
    for est in ("essentia", "librosa") if HAS_ESSENTIA else ("librosa",):
        assert tuple(got["keys"][est][:2]) == truth, est
    assert crosses(got[measure]), got[measure]

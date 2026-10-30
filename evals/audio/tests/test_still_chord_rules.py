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
    basses spell three pitch classes or more. No GiantSteps+ clip with a served key has still
    lines.
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
            assert abs(cents(notes[1], notes[0]) - 1500) <= 30, name
        elif family == "one-note-bass":
            assert classes(notes) >= 3, name
    sixths = {"cowbell-s508", "cowbell-s515", "cowbell-s600", "cowbell-s601"}
    for name in sixths:
        low, high = [f for f in targets[name]["source"]["notes"] if f > 400]
        assert abs(cents(high, low) - 800) <= 30, name
    for name in ("cowbell-s528", "cowbell-s606"):
        *lower, top = targets[name]["source"]["notes"]
        assert any(abs(top - 3 * f) <= 0.003 * top for f in lower), name
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
    cowbell-s528: 2423 Hz is three times the weaker oscillator (808 Hz) but reaches 0.53 of
    its level, over SOURCE_OVERTONE_RATIO, so it stays a third pitch class; folded at 0.54 the
    notes are a fourth apart, no chord.
    """
    script, _, lines = measured_lines("cowbell-s528")
    level = dict(lines)
    low, mid, high = script.spelled(lines)
    assert abs(high - 3 * mid) <= 0.003 * high
    assert 0.5 < level[high] / level[mid] < 0.54
    assert script.overtone_ratio(lines) == 0.54
    assert script.spelled(lines, 0.54) == (low, mid)


def test_a_one_note_bass_keeps_harmonics_off_its_fundamental_line():
    """
    one-note-bass-s501 (G2, 98 Hz): a line at 90.9 Hz next to the note pulls the fundamental
    line to 97.4 Hz, so its third harmonic (293.6 Hz) lies 0.46 % off, beyond
    SOURCE_NOTE_TOLERANCE, and counts as a note.
    """
    script, _, lines = measured_lines("one-note-bass-s501")
    notes = script.spelled(lines)
    assert 90 < notes[0] < 92 and 97 < notes[1] < 98
    third = next(f for f in notes if 280 < f < 300)
    assert 0.003 < abs(third - 3 * notes[1]) / third < 0.006


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


# The stretched-series threshold the 2026-10-29 run chose on the training half, without and
# with the close lines merged.
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

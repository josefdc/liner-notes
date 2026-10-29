"""
Two rules that could withhold a tubular bell's key, measured on the newest committed controls
run: what each would separate, and which served keys each would withhold. Neither is shipped
(services/audio/README.md states the tubular bell as a limit).

- **Off the grid**: the share of note pairs, among the notes a still control spells, whose
  interval is more than 20 cents off the equal-tempered semitones. Read from the run's
  recorded evidence (`evidence.source.notes`); no audio is analysed. As a rule: one pitched
  source when a still control spells a chord and the share is at least OFF_GRID_RULE.
- **Few harmonics** (tried for 2.3.5): the share of the level of the lines from
  SOURCE_NOTE_FLOOR up that are overtones of the notes they spell. The service no longer
  records it, so it is measured again here on each still control that spells a chord, from
  the control's signal, by the service's own line histogram and overtone test. 2.3.5 took one
  pitched source when the share was at most 0.1, so a control whose served key was right
  loses it then.

    uv run python scripts/source_rules.py [evals/reports/audio-<date>.json] [--jobs J]

Prints one line per family and seed range, then the off-grid rule on every other control that
would lose a key to it; nothing is written. Deterministic: the controls are
drawn from their seeds.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

import numpy as np

REPORTS = Path(__file__).resolve().parents[2] / "reports"
FEW_HARMONICS = 0.1  # the 2.3.5 value (SOURCE_MAX_HARMONICS, not shipped)
OFF_GRID_CENTS = 20.0
OFF_GRID_RULE = 0.65  # above the bar triads' 0.60, under the tubular bells' 0.67
FAMILIES = re.compile(r"^(?P<family>.+)-s(?P<seed>\d+)$")


def newest_controls(path: Path | None) -> tuple[str, dict]:
    paths = [path] if path else sorted(REPORTS.glob("audio-*.json"))
    runs = [
        (p.name, run)
        for p in paths
        for run in json.loads(p.read_text())["runs"]
        if run["suite"] == "controls"
    ]
    return max(runs, key=lambda item: item[1]["startedAt"])


def still(source: dict, values: dict) -> bool:
    return (
        source["bins"] >= values["minBins"]
        and source["movement"] <= values["maxMovement"]
        and source["shared"] >= values["minShared"]
        and source["depth"] >= values["minDepth"]
    )


def off_grid(notes: list[float]) -> float:
    """The share of note pairs more than OFF_GRID_CENTS off the equal-tempered semitones."""
    pairs = [(a, b) for i, a in enumerate(notes) for b in notes[i + 1 :]]
    off = [abs((1200 * math.log2(b / a)) % 100 - 50) < 50 - OFF_GRID_CENTS for a, b in pairs]
    return sum(off) / len(off)


def harmonics_share(name: str) -> float:
    """The 2.3.5 share for one control: overtones' level over the level of the lines."""
    from evals_audio import controls as C
    from evals_audio import service

    _, E = service.load()
    control = next(c for c in C.controls() if c.name == name)
    s = E.Signals(np.asarray(control.make(), dtype=np.float32), 22050)
    stft, sr, hop = s.harmonic_stft, s.sr, s.hop
    lo, hi = E.SERIES_LOW_HZ, E.HARMONIC_MAX_HZ
    n_fft = 2 * (stft.shape[0] - 1)
    rows = int(min(stft.shape[0], np.ceil(hi * n_fft / sr) + 2))
    spectrum = stft[:rows]
    k = np.arange(rows)[:, None]
    advance = np.angle(spectrum[:, 1:]) - np.angle(spectrum[:, :-1]) - 2 * np.pi * k * hop / n_fft
    advance = (advance + np.pi) % (2 * np.pi) - np.pi
    freqs = (k + advance * n_fft / (2 * np.pi * hop)) * sr / n_fft
    magnitude = np.abs(spectrum)
    weight = np.sqrt(magnitude[:, 1:] * magnitude[:, :-1])
    vote = (weight > 1e-3 * weight.max()) & (freqs >= lo) & (freqs <= hi)
    position = 1200 * np.log2(freqs[vote] / lo) / E.SOURCE_NOTE_CENTS_BIN
    size = int(1200 * np.log2(hi / lo) / E.SOURCE_NOTE_CENTS_BIN) + 1
    histogram = np.bincount(position.astype(int), weights=weight[vote], minlength=size)
    import scipy.ndimage
    import scipy.signal

    smooth = scipy.ndimage.gaussian_filter1d(histogram, 2.0)
    found, _ = scipy.signal.find_peaks(smooth, prominence=0.01 * smooth.max())
    lines = [
        (
            lo * 2 ** ((i + 0.5) * E.SOURCE_NOTE_CENTS_BIN / 1200),
            float(histogram[max(0, i - 7) : i + 8].sum()),
        )
        for i in found
    ]
    kept: list[tuple[float, float]] = []
    for f, a in sorted(lines, key=lambda line: -line[1]):
        if all(E._cents(f, g) > E.SOURCE_NOTE_MERGE_CENTS for g, _ in kept):
            kept.append((f, a))
    strongest = kept[0][1]
    notes: list[tuple[float, float]] = []
    level = folded = 0.0
    for f, a in sorted(kept):
        if a < E.SOURCE_NOTE_FLOOR * strongest:
            continue
        level += a
        if any(E._overtone(f, a, f0, a0, strongest) for f0, a0 in notes):
            folded += a
        else:
            notes.append((f, a))
    return folded / level


def _cap_threads() -> None:
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(var, "1")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("results", nargs="?", type=Path)
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument("--only", default="", help="a regular expression on the family names")
    args = p.parse_args()
    name, run = newest_controls(args.results)
    values = run["rules"]["one_source"]
    print(f"{name}: controls run of {run['startedAt']}, analyzer {run['analyzerVersion']}")
    rows = []
    for c in run["controls"]:
        source = c["evidence"].get("source") or {}
        if not source.get("notes") or not still(source, values):
            continue
        m = FAMILIES.match(c["name"])
        if m:
            family, seed = m["family"], int(m["seed"])
        else:  # one line for the detuned thirds, one per group for the other controls
            third = c["name"].startswith("detuned-third-")
            family = "detuned thirds" if third else f"the other {c['group']} controls"
            seed = None
        if not re.search(args.only, family):
            continue
        truth = c["truth"]["key"]
        served = {
            est: (c["estimators"][est]["key"] or {}).get("served")
            for est in ("essentia", "librosa")
        }
        keys = {
            est: (
                served[est] is not None,
                isinstance(truth, list) and list(served[est] or ()) == truth,
            )
            for est in served
        }
        rows.append((family, seed, c["name"], source, keys))
    chords = [r[2] for r in rows if r[1] is not None and r[3].get("chord")]
    # The workers inherit the thread caps: set here, they hold before a worker imports numpy.
    _cap_threads()
    with ProcessPoolExecutor(args.jobs, mp_context=get_context("spawn")) as pool:
        share = dict(zip(chords, pool.map(harmonics_share, chords, chunksize=2), strict=True))

    def spread(values: list[float]) -> str:
        if not values:
            return "-"
        return f"{min(values):.2f}-{max(values):.2f} (median {statistics.median(values):.2f})"

    def withholds(taken: list) -> str:
        return " / ".join(
            f"{sum(r[4][est][0] for r in taken)} (right {sum(r[4][est][1] for r in taken)})"
            for est in ("essentia", "librosa")
        )

    def off_rule(group: list) -> list:
        return [r for r in group if r[3].get("chord") and off_grid(r[3]["notes"]) >= OFF_GRID_RULE]

    print(
        f"\nfamily, seeds: still controls with notes; off the grid (>{OFF_GRID_CENTS:g} c); "
        f"harmonics share of those that spell a chord; the served keys each rule would withhold "
        f"(harmonics share <= {FEW_HARMONICS}; still chord off the grid >= {OFF_GRID_RULE}), and "
        "how many of them are right (Essentia / librosa)"
    )
    spans = sorted({(r[0], r[1] // 100) for r in rows if r[1] is not None})
    for family, hundred in spans:
        group = [r for r in rows if r[0] == family and r[1] is not None and r[1] // 100 == hundred]
        seeds = [r[1] for r in group]
        offs = [off_grid(r[3]["notes"]) for r in group if len(r[3]["notes"]) > 1]
        shares = [share[r[2]] for r in group if r[2] in share]
        taken = [r for r in group if r[2] in share and share[r[2]] <= FEW_HARMONICS]
        print(
            f"{family}, seeds {min(seeds)}-{max(seeds)}: {len(group)}; off the grid "
            f"{spread(offs)}; harmonics {spread(shares)}; withheld by the harmonics rule "
            f"{withholds(taken)}, by the off-grid rule {withholds(off_rule(group))}"
        )
    for family in sorted({r[0] for r in rows if r[1] is None}):
        group = [r for r in rows if r[0] == family and r[1] is None]
        offs = {r[2]: off_grid(r[3]["notes"]) for r in group if len(r[3]["notes"]) > 1}
        line = f"{family}: {len(group)}; off the grid {spread(list(offs.values()))}"
        if family == "detuned thirds":
            at25 = [v for n, v in offs.items() if n.endswith("25")]
            line += f", at 25 c {spread(at25)}"
        print(f"{line}; withheld by the off-grid rule {withholds(off_rule(group))}")


if __name__ == "__main__":
    main()

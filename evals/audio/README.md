# Audio accuracy harness

Measures the audio service's tempo and key estimates (`services/audio`) against annotated
datasets and writes a dated report to `evals/reports/audio-<date>.md`, with the per-track
results next to it in `audio-<date>.json`.

```sh
cd evals/audio
uv sync                         # ~0.6 GB: enough for --estimator librosa and the tests
uv sync --extra models          # adds ~0.6 GB: essentia-tensorflow, for the Essentia estimator
uv run python -m evals_audio --suite tempo --dataset ballroom --limit 50
uv run python -m evals_audio --suite tempo --dataset giantsteps-tempo --limit 50
uv run python -m evals_audio --suite key --dataset giantsteps-key --limit 50
uv run pytest                   # unit tests, no network
uv run ruff check . && uv run ruff format --check .
```

Options: `--estimator librosa|essentia|all` (default `all`, which needs `--extra models`),
`--seed S` (default 1), `--jobs J` (worker processes, at most 4), `--data-dir`, `--report-dir`,
`--no-report`, and `--render <audio-date>.json` (renders the Markdown again from a results
file alone). `--seed` sets three seeds at once; `--selection-seed` (which tracks are drawn),
`--clip-seed` (where each window starts) and `--bootstrap-seed` (the MIREX intervals) override
one each, so the spread between seeds can be traced to one of them. Without `--limit` every
usable track is measured, which downloads far more audio (see the cap below). Running another
suite, dataset, seed or limit on the same day adds it to that day's report; running the same
one again replaces it.

The unit tests, ruff and the service-pin check run in CI (`.github/workflows/evals-audio.yml`)
when `evals/audio` or `services/audio` changes. The suites themselves download data and are run
by hand.

## How the service is called

`services/audio` is not an installable package (its modules are top-level), so
`evals_audio/service.py` puts that directory first on `sys.path` and calls the service's own
`decode` and `analyze_signals` in-process, not over HTTP. What is scored is exactly the `v2`
tempo and key the service would return, with its gate and withholding rules. This project
pins every package the service's lock resolves at the service's version
(`constraint-dependencies` in `pyproject.toml`); `tests/test_service_pins.py` fails when any
package both locks share differs. The fingerprint models are not loaded: tempo and key do not
use them.

## Data

Datasets live in `~/liner-notes-data` (`LINER_NOTES_DATA`), outside the repository (a data
directory inside it is refused), under a cap of `LINER_NOTES_DATA_CAP_BYTES` bytes (2 GB by
default; a positive whole number). Each audio file asks the budget before it is written and is
refused when it would take the directory past the cap; a download of unknown size is stopped
while streaming, as soon as it would. The annotations are checked once, against an upper bound
on their size, and mirdata's own download and extraction are not metered file by file. mirdata
keeps its indexes in this project's environment (`.venv`), not in the data directory. One run
at a time holds the directory (`.lock`); partial files left by a killed run are removed at the
start of the next.

mirdata 1.0.0 supplies the indexes, the annotations and the per-file MD5s; it does not fetch
the audio. The full audio archives would not fit under the cap together (Ballroom's tar.gz is
1.45 GB, GiantSteps+'s zip 0.86 GB), so the harness writes only the tracks a run selects:

| dataset | suite | audio |
|---|---|---|
| `ballroom` | tempo | streamed from the MTG tar.gz; only the selected members are kept. The archive is read until the last selected member arrives, so a 50-track draw reads most of the 1.45 GB over the network, and a run missing any Ballroom track reads it again |
| `giantsteps-tempo` | tempo | mirdata cannot fetch it; the JKU Linz copy first, then the Beatport preview URL, the order of the dataset's current `audio_dl.sh` |
| `giantsteps-key` | key | read member by member from the Zenodo zip with HTTP range requests |

Every file is checked against the MD5 in mirdata's index and discarded on a mismatch.
`.audio-sources.json` in each dataset directory records the URL each file was fetched from,
written as soon as the file is verified, so an interrupted fetch keeps the record of what it
got.

The annotations are under Creative Commons licences (each report says which, and where that
is stated). The audio is commercial excerpts (BallroomDancers.com, Beatport previews) with no
licence: it is fetched for evaluation only and never redistributed. The committed results hold
track ids, clip windows, the service's estimates and per-track scores, never reference labels
or audio file names (which carry artist and title); each report credits the datasets.

## Clips and scores

Each track is cut to one 30-second window (the service analyses 30 s previews), whose start
is fixed by the clip seed, the dataset and the track id; a recording of 30 s or less is used
whole. Tempo: Acc1 (within 4 %) and Acc2 (within 4 % of 1, 2, 3, 1/2 or 1/3 times the
reference). Key: the MIREX score (1 / 0.5 fifth above / 0.3 relative / 0.2 parallel) and exact
accuracy.

A track the service answered nothing for is *withheld*. Every metric is given two ways:
**correct / n**, where a withheld track counts as no correct value (how often a user gets a
right value), and **correct / answered** (how often a value the service shows is right), next
to the coverage (answered / n). Two estimators that answer different tracks are compared in a
paired table on the same tracks, not by the over-answered column. Intervals are 95 %: Wilson
score intervals for the binary metrics, a BCa bootstrap at a fixed seed for the MIREX score.
For withheld tracks where the estimator still had an estimate (a tempo that did not hold, a key
the evidence rule stopped), that estimate is scored apart to show what withholding costs.

The accuracy-vs-coverage table ranks the answered tracks by the service's own confidence;
answered tracks without a confidence are ranked last and listed. Each row carries its
interval, rows on fewer than 10 tracks are left out, and an AUC with a Mann-Whitney p-value
says whether the confidence puts correct answers first at all.

One random 30 s window per track, a sample of n tracks and the labels left out make these
numbers incomparable with published figures for the same datasets.

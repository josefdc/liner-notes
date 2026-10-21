# Audio accuracy harness

Measures the audio service's tempo and key estimates (`services/audio`) against annotated
datasets and writes a dated report to `evals/reports/audio-<date>.md`, with the per-track
results next to it in `audio-<date>.json`.

```sh
cd evals/audio
uv sync --extra models          # the Essentia estimator needs essentia-tensorflow
uv run python -m evals_audio --suite tempo --dataset ballroom --limit 50
uv run python -m evals_audio --suite tempo --dataset giantsteps-tempo --limit 50
uv run python -m evals_audio --suite key --dataset giantsteps-key --limit 50
uv run pytest                   # unit tests, no network
uv run ruff check . && uv run ruff format --check .
```

Options: `--estimator librosa|essentia|all` (default `all`), `--seed S` (default 1; picks the
tracks and the clip windows), `--jobs J` (worker processes, at most 4), `--data-dir`,
`--report-dir`, `--no-report`, and `--render <audio-date>.json` (renders the Markdown again
from a results file alone). Without `--limit` every usable track is measured, which downloads
far more audio (see the cap below). Running another suite or dataset on the same day adds it to
that day's report; running the same one again replaces it.

## How the service is called

`services/audio` is not an installable package (its modules are top-level), so
`evals_audio/service.py` puts that directory first on `sys.path` and calls the service's own
`decode` and `analyze_signals` in-process, not over HTTP. What is scored is exactly the `v2`
tempo and key the service would return, with its gate and withholding rules. This project
pins the service's runtime dependencies at the versions in `services/audio/uv.lock`
(`constraint-dependencies` in `pyproject.toml`); `tests/test_service_pins.py` fails when the
two locks drift apart. The fingerprint models are not loaded: tempo and key do not use them.

## Data

Datasets live in `~/liner-notes-data` (`LINER_NOTES_DATA`), outside the repository, and the
directory never grows past `LINER_NOTES_DATA_CAP_BYTES` (2 GB by default): every write asks
first and is refused past the cap. mirdata 1.0.0 supplies the indexes, the annotations and the
per-file MD5s. The full audio archives would not fit under the cap together (Ballroom's
tar.gz is 1.45 GB, GiantSteps+'s zip 0.86 GB), so only the tracks a run selects are written:

| dataset | suite | audio |
|---|---|---|
| `ballroom` | tempo | streamed from the MTG tar.gz; only the selected members are kept |
| `giantsteps-tempo` | tempo | mirdata cannot fetch it; the Beatport preview URL, then the JKU backup named in the dataset's `audio_dl.sh` |
| `giantsteps-key` | key | read member by member from the Zenodo zip with HTTP range requests |

Every file is checked against the MD5 in mirdata's index and discarded on a mismatch.
`.audio-sources.json` in each dataset directory records where each file came from. Licences
and source URLs are written into each report.

## Clips and scores

Each track is cut to one 30-second window (the service analyses 30 s previews), whose start
is fixed by the seed, the dataset and the track id; a recording of 30 s or less is used whole.
Tempo: Acc1 (within 4 %) and Acc2 (within 4 % of 1, 2, 3, 1/2 or 1/3 times the reference).
Key: the MIREX score (1 / 0.5 fifth above / 0.3 relative / 0.2 parallel) and exact accuracy.
Every figure carries n and a 95 % percentile-bootstrap interval at a fixed seed. A track the
service answered nothing for is *withheld*: counted on its own, never scored as wrong and
never dropped; accuracy is over the answered tracks and coverage is answered / n. The
accuracy-vs-coverage table ranks the answers by the service's own confidence.

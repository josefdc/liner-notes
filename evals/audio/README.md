# Audio accuracy harness

Measures the audio service's tempo and key estimates (`services/audio`) against annotated
datasets, compares its tempo estimators with beat-this, checks its agreement with sourced
values and its style fingerprint on the golden set's Deezer previews, measures what each tempo
estimator costs, and writes a dated report to `evals/reports/audio-<date>.md`, with the
per-track results next to it in `audio-<date>.json`.

```sh
cd evals/audio
uv sync                         # ~0.6 GB: enough for --estimator librosa and the tests
uv sync --extra models          # adds ~0.6 GB: essentia-tensorflow, for the Essentia estimator
uv sync --extra models --extra beat-this   # adds torch (CPU) and beat-this; the cost suite measures it
uv run python -m evals_audio --suite tempo --dataset ballroom --limit 50
uv run python -m evals_audio --suite tempo --dataset giantsteps-tempo --limit 50
uv run python -m evals_audio --suite key --dataset giantsteps-key --limit 50
uv run python -m evals_audio --suite golden
uv run python -m evals_audio --suite cost --dataset giantsteps-tempo --limit 20
uv run python -m evals_audio --suite controls
uv run python -m evals_audio --suite calibration --dataset ballroom --limit 200
uv run pytest                   # unit tests, no network
uv run ruff check . && uv run ruff format --check .
```

Options: `--estimator librosa|essentia|beat-this|all` (default `all`: every estimator the suite
runs, which needs `--extra models`, and `--extra beat-this` for the tempo, golden and cost
suites),
`--seed S` (default 1), `--jobs J` (worker processes, at most 4), `--data-dir`, `--report-dir`,
`--no-report`, `--split calibration|evaluation|all` (tempo and key suites: only one half of
the selection, see Calibration; default `all`), `--render <audio-date>.json` (renders the Markdown again from a results file
alone) and `--lookup ID --dataset NAME` (the dataset's own track id for an id in the results;
see below). `--data-dir` and `--report-dir` are left out of the command a report records.
`--seed` sets three seeds at once; `--selection-seed` (which tracks are drawn),
`--clip-seed` (where each window starts) and `--bootstrap-seed` (the MIREX intervals) override
one each, so the spread between seeds can be traced to one of them. Without `--limit` every
usable track is measured, which downloads far more audio (see the cap below). Running another
suite, dataset, seed or limit on the same day adds it to that day's report; running the same
one again replaces it.

The unit tests, ruff and the service-pin check run in CI (`.github/workflows/evals-audio.yml`)
when `evals/audio` or `services/audio` changes. The suites themselves download data and are run
by hand.

Before analyzer 2.3.1, an Essentia tempo could depend on the clips its worker had analysed
before it (#121). Reports name the analyzer version of each run.

## Suites

| suite | data | what it reports |
|---|---|---|
| `tempo` | Ballroom, GiantSteps Tempo (30 s windows) | Acc1/Acc2 per estimator (librosa, Essentia, beat-this), paired tests, withheld cost, accuracy vs coverage |
| `key` | GiantSteps+ Key (30 s windows) | MIREX score and exact key (librosa, Essentia) |
| `golden` | `evals/golden.jsonl`, each row's Deezer preview | tempo agreement with Deezer's `bpm` and with the set's sheet-music tempo; key agreement with its sheet-music key; style hit@1/5/10 against Discogs, next to a constant baseline and the best constant found with the labels |
| `cost` | clips of a tempo dataset | per tempo estimator: resident memory, seconds per analysed clip, and what it adds to the service image |
| `calibration` | Ballroom, GiantSteps Tempo or GiantSteps+ Key (30 s windows) | per clip and estimator: what the service served, the estimate with every withholding rule lifted and what each rule compares |
| `controls` | generated signals (`evals_audio/controls.py`) | the same, on controls whose truth is known by construction |

The report opens with a bake-off table that puts every tempo estimator's figures side by side
(correct / n per dataset, agreement with Deezer's `bpm`, peak memory, time, what it adds to
the service image), with the same runs' figures when the withholding rules are lifted. A
"Default estimator" section follows: the service's default (read from the service), the
criterion for changing it, each candidate against the default on data it was not trained on
(as served and with the rules lifted, exact McNemar), the tempos each shows that are wrong
(strict 4 % and forgiving octave and meter, exact McNemar on the same clips), the cost per
candidate, and the decision those numbers support. With the calibration runs in the report, a
candidate ahead on all their clips leaves the decision open only when both halves agree; when
the halves disagree, the report keeps the current default and says why, with the numbers.
Everything in it is derived from the results file at render time. Pair tables of an estimator
on its own training data are not printed. The bake-off evidence is the GiantSteps Tempo run
(`--limit 400`: 400 of the usable tracks, both halves), and, when the report holds the
calibration runs, the same comparison on each half of their clips and on all of them.

### Calibration

The service withholds a tempo or a key when its rules find the evidence too weak. The
`calibration` and `controls` suites record, per clip and estimator, what each rule compares
(`evals_audio/calibration.py`), so that the report's calibration section can apply any value
of a rule to the recorded clips without analysing the audio again. Every clip of a selection
is either a calibration clip or an evaluation clip (`datasets.split_of`: a SHA-256 of the
dataset name and the dataset's own track id, about half each, independent of the selection's
size and order). The rules' values are chosen on the calibration clips and the controls only,
under acceptance criteria written before the calibration runs (the module docstring and the
report state them, and how the procedure was applied); the evaluation clips judge each change
once more, and only changes that withhold more are shipped. The report also says how often the
evaluation clips were scored. The
section makes the choice again from the recorded clips and says whether the service holds the
values chosen. A derivation check re-derives every served decision from the recorded
measurements at the service's own values and reports any difference.

The controls (`evals_audio/controls.py`) come from the issue's lists of defects found with
generated probes (random chromatic notes, twelve-tone rows, a slow tempo swing, 12/8 at 60
BPM, a bass-heavy band, noise carrying a siren, several talkers at once, and so on) and from the
probe sets of the service's own tests, whose generators they reuse
(`services/audio/tests/signals.py` and `music.py`, loaded by path). They include pitchless
material drawn at 30 seeds each (two drum kits, noise with a beat, a siren over drums, clicks),
on which no value was set beforehand: none of it may get a key. One-pitch-class material (a
one-note bass, octave riffs, bells, tabla, toms, a cowbell, a held synth note, two rack toms
and a floor tom over a kit, a tubular bell) is drawn the same way. The service's single-source
rule, added after this calibration, withholds the keys analyzer 2.1.0 gave most cowbells: 16
of 19 (Essentia) and 7 of 9 (librosa) at the pinned seeds 500-529, 13 of 16 and 10 of 12 at
the held-out seeds 600-629. Of the one-note basses it withholds 4 of 6 (Essentia) at the
pinned seeds and none at the held-out seeds (0 of 5 Essentia, 0 of 2 librosa): that part does
not generalise. Bells, toms and tabla still get a key: at the held-out seeds, Essentia keys 4
church bells, 2 church bells over drums, 27 tubular bells, 8 toms, 10 kit toms and 12 tabla,
librosa 4, 2, 24, 4, 10 and 8 (the 2026-10-28 report's controls table). A tubular bell's
modes hold still and spell a chord, and none is a harmonic of another; the notes of a chord
in a soft timbre or struck on bars have as few harmonics among the lines, and they keep
their key. `scripts/source_rules.py` measures two rules that could tell them apart, on the
newest report's controls (`uv run python scripts/source_rules.py`; neither is shipped). The
share of note pairs more than 20 cents off the equal-tempered grid is 0.67-0.83 on the still
tubular bells and 0.00 on the soft chords, but reaches 0.60 on the chords struck on bars and
0.67-1.00 on a third 25 cents off over its root, a chord control. The rule tried for analyzer
2.3.5 (one source when at most a tenth of the lines' level is overtones of the notes they
spell) withholds 19 tubular bells' keys at the pinned seeds and 24 (Essentia) and 23
(librosa) at the held-out ones, none right, and right keys with either estimator: 1 soft
chord at seeds 700-729 and 9 at 800-829, 6 and 9 chords struck on bars. Chord controls drawn
at 30 seeds each (held chords faded, swelling, getting louder, with tremolo or a sidechain
pump, C major stabs, a bass and chord riff on one chord, one-bar riffs, triads in a soft
timbre: an electric piano, a flute, an FM electric piano or a triangle wave, and triads
struck on bars: a marimba-like bar or a glockenspiel) carry their key as truth: that rule
must not take it. The
calibration records what the rule measures and the values the run was made with
(`Rules.one_source`), and derives each run at its own values; it does not vary them. The
`held-out-seeded` group (the same families at seeds 600-629 and 800-829) is evaluation only:
the choice does not see it and no test pins it. A report whose runs were made with different
analyzer versions says so at the top. The 2026-10-28 report holds the controls and the
Ballroom tempo and calibration runs, at analyzer 2.3.4; key accuracy (GiantSteps+), GiantSteps
Tempo, the GiantSteps calibrations, the golden set and the costs were not run for it, and
were last measured for the 2026-10-25 report, at analyzer 2.1.0. The single-source rule came
in 2.2.0, so no committed report measures what it costs on annotated keys.

To compare estimators on held-out clips only, run the tempo and key suites with
`--split evaluation` and a larger `--limit` (the selection at a limit includes every smaller
one at the same seed):

```sh
uv run python -m evals_audio --suite tempo --dataset giantsteps-tempo --limit 400 --split evaluation
```

### beat-this

beat-this (Foscarin, Schlüter and Widmer, ISMIR 2024; `evals_audio/beatthis.py`) is a beat
tracker the service does not ship. The harness runs it behind the service's estimator
interface, so its tempo goes through the service's rules: the onset-periodicity minimum, 40-208
BPM, the tempo refined from the beats on onsets (from the median beat interval), and the
steadiness check. It gives no confidence and no key. The checkpoint (`final0`, about 81 MB) is
fetched into `<data dir>/models/beat-this/` and checked against its SHA-256; torch comes from
the PyTorch CPU index. The authors trained `final0` on every dataset they used except GTZAN,
Ballroom included, so its Ballroom figures are on its own training data: the report marks
them and they are not evidence about new music. GiantSteps Tempo is not in its training data.
Some golden songs are in the Harmonix Set, another of its training sets
(`beatthis.GOLDEN_IN_TRAINING`, matched by title and artist; a lower bound, since some
training sets publish numbers or video ids rather than names); the golden suite repeats the
Deezer comparison without them, for every estimator, and the bake-off table uses that one.

### Golden set

`--suite golden` reads `evals/golden.jsonl` and, without any key or token:

- asks Deezer (`api.deezer.com/track/<deezerId>`) for each row's preview and `bpm`. The preview
  is downloaded at once into a temporary directory outside the data directory, analysed whole
  as the service would analyse it, and deleted at the end of the run (on an error, Ctrl-C or
  SIGTERM too). Preview URLs (signed, short-lived) are never written down: httpx's request
  log, which prints full URLs, is kept at WARNING, and a network error is recorded by its type
  only. A row whose lookup fails is marked unavailable; the others go on. Previews come and go
  by day and country, so n belongs to the run's date. Deezer's `bpm` is a sourced hint, not a
  measurement: the report calls the comparison *agreement*.
- finds each recording's Discogs styles: MusicBrainz release groups of the recording (official
  singles, EPs and albums with no secondary type, earliest first), their Discogs master or
  release link, and the genres and styles Discogs gives for it. They are cached with their
  source and date in `<data dir>/golden/discogs.json`; delete it to fetch them afresh. Only a
  definitive miss is cached (no link, a Discogs 404, no styles); a 429 or 5xx after the
  retries leaves the row out of the cache, so the next run asks again. Requests keep the
  services' pace (MusicBrainz one a second, Discogs 25 a minute) and send a User-Agent that
  names the project and its owner's GitHub noreply identity (an identifier, not a monitored
  mailbox).
- loads the service's fingerprint models (its own `download_models.py`, into
  `<data dir>/models/essentia/`) and scores hit@k: a top-k style hits when its genre and style
  are both on the Discogs release. The constant baseline gives every track the same k styles
  (the model's average output) and uses no label; the best constant chosen with the labels
  (greedy cover) is printed next to it as an optimistic reference.

The results keep ISRCs, Deezer ids and Deezer's `bpm` (already in the preview coverage
report), Discogs and MusicBrainz ids, the model's hit ranks and the scores; not the model's
top lists or the releases' style lists (together with a hit rank they would name a style),
the audio or any URL.

### Cost

`--suite cost` runs each tempo estimator in its own fresh process, on the clips of a fetched
dataset, with every thread variable forced to 1: resident memory once the service is
imported, once the estimator is ready, after the first analysed clip and at its peak, and the
wall and CPU seconds of its `tempo()` per clip. Clips the onset-periodicity minimum stops never
reach the estimator's own work and are counted, not timed; the first clip that does reach it
pays the one-time costs (numba compilation, the first pass through a model) and is reported
apart. The image cost is what the estimator adds to the service image as it ships: the
packages its extra needs that `services/audio/uv.lock` (runtime and `models` extra, as the
Dockerfile installs) does not have, with installed and wheel bytes, plus model files; Essentia
adds nothing, the image already has it for the fingerprint. What the extra adds to this
harness's install is shown too. No image is built; the installed bytes are what an image
layer would hold.

## How the service is called

`services/audio` is not an installable package (its modules are top-level), so
`evals_audio/service.py` puts that directory first on `sys.path` and calls the service's own
`decode` and `analyze_signals` in-process, not over HTTP. What is scored is exactly the `v2`
tempo and key the service would return, with its gate and withholding rules. This project
pins every package the service's lock resolves at the service's version
(`constraint-dependencies` in `pyproject.toml`); `tests/test_service_pins.py` fails when any
package both locks share differs. The fingerprint models are loaded only by the golden suite
(tempo and key do not use them). The beat-this extra adds torch and its dependencies, which the
service's lock does not have, so the pin check does not cover them.

## Data

Datasets live in `~/liner-notes-data` (`LINER_NOTES_DATA`), outside the repository (a data
directory inside it is refused), under a cap of `LINER_NOTES_DATA_CAP_BYTES` bytes (2 GB by
default; a positive whole number). Each audio file asks the budget before it is written and is
refused when it would take the directory past the cap; a download of unknown size is stopped
while streaming, as soon as it would. The annotations are checked once, against an upper bound
on their size, and mirdata's own download and extraction are not metered file by file. mirdata
keeps its indexes in this project's environment (`.venv`), not in the data directory. One run
at a time holds the directory (`.lock`); partial files left by a killed run are removed at the
start of the next. Besides the datasets it holds the model files (`models/beat-this/`,
`models/essentia/`, each asked of the budget and checked by SHA-256) and
the golden set's Discogs labels (`golden/discogs.json`); never the Deezer previews.

mirdata 1.0.0 supplies the indexes, the annotations and the per-file MD5s; it does not fetch
the audio. The full audio archives would not fit under the cap together (Ballroom's tar.gz is
1.45 GB, GiantSteps+'s zip 0.86 GB), so the harness writes only the tracks a run selects:

| dataset | suite | audio |
|---|---|---|
| `ballroom` | tempo | streamed from the MTG tar.gz; only the selected members are kept. The archive is read until the last selected member arrives, so a 50-track draw reads most of the 1.45 GB over the network, and a run missing any Ballroom track reads it again |
| `giantsteps-tempo` | tempo | mirdata cannot fetch it; the JKU Linz copy first, then the Beatport preview URL, the order of the dataset's current `audio_dl.sh` |
| `giantsteps-key` | key | read member by member from the Zenodo zip with HTTP range requests |

The selections the calibration section rests on (seed 1: Ballroom 200, GiantSteps Tempo 400,
GiantSteps+ 250) take about 1.45 GB of audio; with the model files the data directory holds
about 1.6 GB, under the cap.

Every file is checked against the MD5 in mirdata's index and discarded on a mismatch.
`.audio-sources.json` in each dataset directory records the URL each file was fetched from,
written as soon as the file is verified, so an interrupted fetch keeps the record of what it
got.

The annotations are under Creative Commons licences (each report says which, and where that
is stated). The audio is commercial excerpts (BallroomDancers.com, Beatport previews) with no
licence: it is fetched for evaluation only and never redistributed. The committed results hold
track ids, clip windows, the service's estimates and per-track scores. They store no reference
labels and no audio file names, but they do not hide the labels: an estimate with its score
often gives the reference away (a MIREX score of 1, 0.5, 0.3 or 0.2 fixes the key; an Acc1 hit
pins the tempo within 4 %). The per-track results are therefore derived from the annotations,
and each report's licence rows and credits apply to them. Ballroom's track ids are its audio
file names, which carry album names, so its results use the first 10 hex digits of the SHA-256
of the dataset and the id instead; `--lookup` maps one back from the local index.

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
paired table on the same tracks, not by the over-answered column: exact McNemar for the binary
metrics; for MIREX a paired t interval whose spread includes two pseudo-differences at -1 and +1,
and an exact sign-flip p-value. Paired key differences are mostly zero, where a bootstrap
interval covers far less than 95 %; this interval does not collapse there, but it is not
conservative in general. Each paired row reports how often it covered the mean on resamples of
its own differences, and `scripts/paired_coverage.py` simulates it next to a BCa bootstrap on a
results file and on random sparse and dense differences (`uv run python
scripts/paired_coverage.py ../reports/audio-<date>.json`). Other intervals are 95 %: Wilson
score intervals for the binary metrics, a BCa bootstrap at a fixed seed for the MIREX score.

The service withholds an answer for several reasons: the gate; for tempo, onsets that do not
repeat enough (the onset-periodicity minimum), a confidence under the estimator's minimum, or a
tempo that does not hold over the window; for key, the evidence rule or a strength under the
minimum. For all but the gate the estimator usually still has an estimate. The harness
recomputes it with the rules lifted (never as the service's answer), records every rule that
withholds it, and scores it. A rule's row in the withheld table counts the clips that this
rule alone withholds, so it shows what lifting that rule alone would give; clips withheld by
several rules have their own row, and a last row lifts every rule. "No estimate" means the
estimator has no value even with every rule lifted (a tempo out of range, too few beats).
`tests/test_service_smoke.py` runs the real service on a synthesized clip and checks that each
rule is really lifted.

The accuracy-vs-coverage table ranks the answered tracks by the service's own confidence;
answered tracks without a confidence are ranked last and listed. Each row carries its
interval, rows on fewer than 10 tracks are left out, and an AUC with a permutation p-value
(exact when there are at most 200,000 orderings, Monte Carlo at a fixed seed otherwise) says
whether the confidence puts correct answers first at all. Monte Carlo p-values are
(hits + 1) / (resamples + 1). Every p-value is for one comparison; each report says how many
it prints and how many of them chance alone would put under 0.05.

One random 30 s window per track, a sample of n tracks and the labels left out make these
numbers incomparable with published figures for the same datasets.

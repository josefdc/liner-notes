# Audio accuracy, 2026-10-24

Tempo and key accuracy of the audio service (`services/audio`) on annotated datasets, measured by `evals/audio` (`uv run python -m evals_audio`). The harness imports the service and calls its own `analyze_signals` on 30-second clips, so the numbers are what the service returns, gate and withholding rules included. Rendered from `audio-2026-10-24.json`, which holds the per-clip results: track ids, estimates and scores. It stores no reference labels and no audio file names, but an estimate with its score often gives the reference away (a MIREX score of 1, 0.5, 0.3 or 0.2 fixes the key; an Acc1 hit pins the tempo within 4 %), so those results are derived from the annotations: the licence and credits under each dataset apply to them.

This report covers the tempo and key suites with the librosa and Essentia estimators. The estimator bake-off with beat-this, style hit@k against Discogs styles and the agreement with Deezer's `bpm` come in the next part of this work and are not here.

## How to read it

- **n** is every selected clip with verified audio and a usable reference. **Answered** clips got a value from the service; **withheld** clips got none; **failed** clips raised an error (none is expected). Coverage is answered / n.
- **correct / n** counts a withheld clip as no correct value. It answers *how often does a user get a right value*. **correct / answered** is the share of returned values that are right. It answers *how often is a value the service shows right*, and it depends on which clips the service chose to answer: two estimators that answer different clips are compared in the paired table, not by this column.
- **Acc1**: the tempo is within 4 % of the reference. **Acc2**: within 4 % of the reference times 1, 2, 3, 1/2 or 1/3 (octave and meter errors forgiven).
- **MIREX** key score: 1 same key, 0.5 a perfect fifth above in the same mode, 0.3 relative, 0.2 parallel, 0 otherwise; shown as the summed score over the denominator. **exact**: the same key only.
- **Intervals** are 95 %: Wilson score intervals for Acc1, Acc2 and exact; a BCa bootstrap (10,000 resamples, fixed seed) for MIREX, with no interval when every score is equal. Each interval rests on the denominator printed next to it, which for correct / answered can be far below n.
- **Paired MIREX difference**: most paired key differences are zero, and a bootstrap interval can then cover far less than 95 %. The interval here is a paired t interval whose spread includes two pseudo-differences at -1 and +1, the ends of the range, so it never collapses to zero width. Each row says how often it covered the mean when that row's own differences were resampled. It is wide at small n and is not conservative in general: on dense differences it can cover less than 95 % (`evals/audio/scripts/paired_coverage.py` simulates both). The sign-flip p-value tests "no difference" over every sign pattern of the nonzero differences (exact up to 16 of them).
- **p-values** are exact where it is cheap (McNemar; sign-flip; the AUC's permutation test up to 200,000 orderings) and Monte Carlo at a fixed seed otherwise, as labelled, computed as (hits + 1) / (resamples + 1). Each is for one comparison. This report prints 14; about 0.7 of them are expected under 0.05 by chance alone, so none should be read as a finding without a correction for the number of tests.
- **Comparability**: one 30 s window per clip and the excluded labels make these numbers incomparable with published figures for the same datasets (computed on full excerpts, usually on every labelled track).

## Tempo: Ballroom (ISMIR 2004 tempo induction contest)

```sh
cd evals/audio && uv run python -m evals_audio --suite tempo --dataset ballroom --limit 50 --seed 1
```

- Run 2026-10-24T14:53:41Z on commit `1c0cfd2`; 33 s wall with 4 worker processes.
- Analyzer: `ANALYZER_VERSION` 2.0.0 `2.0.0+librosa`, `2.0.0+essentia` (the fingerprint models were not loaded; tempo and key do not use them).
- Environment: python 3.12.3, librosa 1.0.0, numpy 2.3.5, scipy 1.16.3, mirdata 1.0.0, essentia-tensorflow 2.1b6.dev1389.
- Seeds: selection 1, clip windows 1, bootstrap 1. Selection: 50 of 698 usable tracks drawn with numpy default_rng(1). Clips: 30 s, the start fixed by the clip seed and the track id (SHA-256); a recording of 30 s or less is used whole. The 6 recordings measured are 30.1-31.8 s long (used whole: 0).

### Dataset

|  |  |
|---|---|
| licence (annotations) | CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/), per mirdata 1.0.0 (ballroom.LICENSE_INFO); not stated by the dataset: the contest page states no licence |
| audio | commercial excerpts (BallroomDancers.com, credited on the contest page); no licence is stated for the audio. Fetched into the local data directory for evaluation only and never redistributed: the repository holds no audio and no audio file names. |
| source: audio | https://mtg.upf.edu/ismir2004/contest/tempoContest/data1.tar.gz |
| source: tempo | https://mtg.upf.edu/ismir2004/contest/tempoContest/data2.tar.gz |
| source: index | https://zenodo.org/records/13993346 (mirdata index 1.0) |
| reference | the contest's ground-truth tempo (one value per excerpt) |
| tracks in the index | 698 |
| usable references | 698 |
| selected | 50 |
| audio verified (MD5) | 50 |
| audio unavailable | 0 |
| audio fetched from | 50 from https://mtg.upf.edu/ismir2004/contest/tempoContest/data1.tar.gz |
| data directory | 315.7 MB (cap 2.0 GB) |

- 698 excerpts of about 30 s from BallroomDancers.com, eight dance styles, so the 30 s window covers nearly all of each excerpt.
- Published Ballroom figures use all 698 excerpts; a sample of n clips is only comparable within its interval.
- Ballroom's track ids are its file names (album names included), so the results use the first 10 hex digits of a SHA-256 of the dataset name and the id; `uv run python -m evals_audio --lookup ID --dataset ballroom` maps one back from the local index.

Credits (cite these when using the data):

- Gouyon, F., Klapuri, A., Dixon, S., Alonso, M., Tzanetakis, G., Uhle, C., Cano, P. (2006). An experimental comparison of audio tempo induction algorithms. IEEE Transactions on Audio, Speech, and Language Processing 14(5), 1832-1844. doi:10.1109/TSA.2005.858509

### Accuracy

- `librosa` returns a tempo for 37 of 50 clips (74.0 %); the tempo it returns is within 4 % of the reference for 28 of all 50 clips (56.0 %).
- `essentia` returns a tempo for 30 of 50 clips (60.0 %); the tempo it returns is within 4 % of the reference for 26 of all 50 clips (52.0 %).

| estimator | n | answered (coverage) | withheld | failed | Acc1: correct / n | Acc1: correct / answered | Acc2: correct / n | Acc2: correct / answered |
|---|---|---|---|---|---|---|---|---|
| `librosa` | 50 | 37/50 = 74.0 % [60.4, 84.1] | 13 | 0 | 28/50 = 56.0 % [42.3, 68.8] | 28/37 = 75.7 % [59.9, 86.6] | 36/50 = 72.0 % [58.3, 82.5] | 36/37 = 97.3 % [86.2, 99.5] |
| `essentia` | 50 | 30/50 = 60.0 % [46.2, 72.4] | 20 | 0 | 26/50 = 52.0 % [38.5, 65.2] | 26/30 = 86.7 % [70.3, 94.7] | 29/50 = 58.0 % [44.2, 70.6] | 29/30 = 96.7 % [83.3, 99.4] |

### Paired comparison

`librosa` and `essentia` on the same clips: the clips both answered, and all n clips with a withheld answer counted as not correct. The columns above are not comparable between estimators that answer different clips; compare them here.

| metric | clips | `librosa` | `essentia` | pairs better for `librosa` / for `essentia` | test |
|---|---|---|---|---|---|
| Acc1 | both answered (n = 29) | 25 | 25 | 0 / 0 | McNemar exact p = 1.000 |
| Acc1 | all n (n = 50) | 28 | 26 | 3 / 1 | McNemar exact p = 0.625 |
| Acc2 | both answered (n = 29) | 28 | 28 | 0 / 0 | McNemar exact p = 1.000 |
| Acc2 | all n (n = 50) | 36 | 29 | 8 / 1 | McNemar exact p = 0.039 |

### Withheld

`librosa`, withheld 1: tempo does not hold over the window: 1. The estimator still had an estimate for 1 of them.
`essentia`, withheld 1: tempo does not hold over the window: 1. The estimator still had an estimate for 1 of them.

When onsets that do not repeat enough (the periodicity minimum), a confidence under the estimator's minimum or a tempo that does not hold over the window withholds an answer, the estimator usually still has an estimate: the harness recomputes it with the rule lifted and scores it against the reference, which shows what each rule costs. A rule that helps withholds estimates that are right less often than the ones it returns. These estimates never reach a user and are not counted in the tables above. The first row per estimator is what the service returned, as served. A rule's row counts the clips that this rule alone withholds, so its last column is what correct / n would be with that rule alone lifted; clips that several rules withhold have their own row, and the last row lifts every rule. Clips with no estimate even with every rule lifted (the gate, no estimate) stay at no correct value.

| estimator | answers | Acc1: correct | Acc1: correct / n with these too | Acc2: correct | Acc2: correct / n with these too |
|---|---|---|---|---|---|
| `librosa` | returned (37) | 28/37 = 75.7 % [59.9, 86.6] | 28/50 = 56.0 % [42.3, 68.8] | 36/37 = 97.3 % [86.2, 99.5] | 36/50 = 72.0 % [58.3, 82.5] |
| `librosa` | withheld by several rules (5) | 1/5 = 20.0 % [3.6, 62.4] | 29/50 = 58.0 % [44.2, 70.6] | 3/5 = 60.0 % [23.1, 88.2] | 39/50 = 78.0 % [64.8, 87.2] |
| `librosa` | only: confidence under the estimator's minimum (4) | 3/4 = 75.0 % [30.1, 95.4] | 31/50 = 62.0 % [48.2, 74.1] | 3/4 = 75.0 % [30.1, 95.4] | 39/50 = 78.0 % [64.8, 87.2] |
| `librosa` | only: tempo does not hold over the window (4) | 3/4 = 75.0 % [30.1, 95.4] | 31/50 = 62.0 % [48.2, 74.1] | 3/4 = 75.0 % [30.1, 95.4] | 39/50 = 78.0 % [64.8, 87.2] |
| `librosa` | every rule lifted (13) | 7/13 = 53.8 % [29.1, 76.8] | 35/50 = 70.0 % [56.2, 80.9] | 9/13 = 69.2 % [42.4, 87.3] | 45/50 = 90.0 % [78.6, 95.7] |
| `essentia` | returned (30) | 26/30 = 86.7 % [70.3, 94.7] | 26/50 = 52.0 % [38.5, 65.2] | 29/30 = 96.7 % [83.3, 99.4] | 29/50 = 58.0 % [44.2, 70.6] |
| `essentia` | only: confidence under the estimator's minimum (11) | 8/11 = 72.7 % [43.4, 90.3] | 34/50 = 68.0 % [54.2, 79.2] | 11/11 = 100.0 % [74.1, 100.0] | 40/50 = 80.0 % [67.0, 88.8] |
| `essentia` | withheld by several rules (5) | 1/5 = 20.0 % [3.6, 62.4] | 27/50 = 54.0 % [40.4, 67.0] | 2/5 = 40.0 % [11.8, 76.9] | 31/50 = 62.0 % [48.2, 74.1] |
| `essentia` | only: tempo does not hold over the window (4) | 4/4 = 100.0 % [51.0, 100.0] | 30/50 = 60.0 % [46.2, 72.4] | 4/4 = 100.0 % [51.0, 100.0] | 33/50 = 66.0 % [52.2, 77.6] |
| `essentia` | every rule lifted (20) | 13/20 = 65.0 % [43.3, 81.9] | 39/50 = 78.0 % [64.8, 87.2] | 17/20 = 85.0 % [64.0, 94.8] | 46/50 = 92.0 % [81.2, 96.8] |

### Accuracy vs coverage

Answered clips ranked by the service's confidence, highest first; each row keeps the top k (coverage = k / n) and gives correct / k with its interval. Rows with fewer than 10 clips are left out, except the last row (every answered clip). Neighbouring rows share most of their clips and their intervals overlap, so a rise or fall between rows is not evidence on its own. Whether the confidence ranks answers at all is the AUC line under each table: the chance that a correct answer has a higher confidence than a wrong one (0.5 is random order), with a one-sided Mann-Whitney p-value against random order.

`librosa`:

| coverage | k | min. confidence | Acc1 | Acc2 |
|---|---|---|---|---|
| 20.0 % | 10 | 0.655 | 9/10 = 90.0 % [59.6, 98.2] | 10/10 = 100.0 % [72.2, 100.0] |
| 30.0 % | 15 | 0.596 | 13/15 = 86.7 % [62.1, 96.3] | 15/15 = 100.0 % [79.6, 100.0] |
| 40.0 % | 20 | 0.565 | 16/20 = 80.0 % [58.4, 91.9] | 20/20 = 100.0 % [83.9, 100.0] |
| 50.0 % | 25 | 0.452 | 20/25 = 80.0 % [60.9, 91.1] | 25/25 = 100.0 % [86.7, 100.0] |
| 60.0 % | 30 | 0.402 | 25/30 = 83.3 % [66.4, 92.7] | 30/30 = 100.0 % [88.6, 100.0] |
| 70.0 % | 35 | 0.343 | 28/35 = 80.0 % [64.1, 90.0] | 34/35 = 97.1 % [85.5, 99.5] |
| 74.0 % | 37 | 0.337 | 28/37 = 75.7 % [59.9, 86.6] | 36/37 = 97.3 % [86.2, 99.5] |

Confidence ranking: Acc1 AUC 0.68 (28 correct, 9 wrong; p = 0.057, Monte Carlo, 100,000 permutations); Acc2 AUC 0.86 (36 correct, 1 wrong; p = 0.162, exact permutation).

`essentia`:

| coverage | k | min. confidence | Acc1 | Acc2 |
|---|---|---|---|---|
| 20.0 % | 10 | 0.646 | 9/10 = 90.0 % [59.6, 98.2] | 10/10 = 100.0 % [72.2, 100.0] |
| 30.0 % | 15 | 0.609 | 14/15 = 93.3 % [70.2, 98.8] | 15/15 = 100.0 % [79.6, 100.0] |
| 40.0 % | 20 | 0.533 | 18/20 = 90.0 % [69.9, 97.2] | 20/20 = 100.0 % [83.9, 100.0] |
| 50.0 % | 25 | 0.424 | 22/25 = 88.0 % [70.0, 95.8] | 25/25 = 100.0 % [86.7, 100.0] |
| 60.0 % | 30 | 0.343 | 26/30 = 86.7 % [70.3, 94.7] | 29/30 = 96.7 % [83.3, 99.4] |

Confidence ranking: Acc1 AUC 0.66 (26 correct, 4 wrong; p = 0.164, exact permutation); Acc2 AUC 0.90 (29 correct, 1 wrong; p = 0.133, exact permutation).

## Key: GiantSteps Key, as GiantSteps+ (Faraldo 2017 revision)

```sh
cd evals/audio && uv run python -m evals_audio --suite key --dataset giantsteps-key --limit 50 --seed 1
```

- Run 2026-10-24T14:54:49Z on commit `1c0cfd2`; 30 s wall with 4 worker processes.
- Analyzer: `ANALYZER_VERSION` 2.0.0 `2.0.0+librosa`, `2.0.0+essentia` (the fingerprint models were not loaded; tempo and key do not use them).
- Environment: python 3.12.3, librosa 1.0.0, numpy 2.3.5, scipy 1.16.3, mirdata 1.0.0, essentia-tensorflow 2.1b6.dev1389.
- Seeds: selection 1, clip windows 1, bootstrap 1. Selection: 50 of 476 usable tracks drawn with numpy default_rng(1). Clips: 30 s, the start fixed by the clip seed and the track id (SHA-256); a recording of 30 s or less is used whole. The 6 recordings measured are 120.1-120.1 s long (used whole: 0).

### Dataset

|  |  |
|---|---|
| licence (annotations) | CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), stated in the Zenodo record (10.5281/zenodo.1095691); mirdata 1.0.0 agrees |
| audio | commercial excerpts (Beatport two-minute previews; the record says the audio belongs to Beatport); no licence is stated for the audio. Fetched into the local data directory for evaluation only and never redistributed: the repository holds no audio and no audio file names. |
| source: audio | https://zenodo.org/records/1095691/files/audio.zip |
| source: keys | https://zenodo.org/records/1095691/files/keys.zip |
| source: metadata | https://zenodo.org/records/1095691/files/original_metadata.zip |
| source: index | https://zenodo.org/records/13993357 (mirdata index '+') |
| reference | the GiantSteps+ single-key label (keys_gs+), tonic and major/minor |
| tracks in the index | 600 |
| usable references | 476 |
| not scored (whole dataset) | mode other than major/minor: 26, no mode: 3, two keys: 93, unparseable: 2 |
| selected | 50 |
| audio verified (MD5) | 50 |
| audio unavailable | 0 |
| audio fetched from | 50 from https://zenodo.org/records/1095691/files/audio.zip |
| data directory | 315.7 MB (cap 2.0 GB) |

- 600 two-minute Beatport previews of electronic dance music. mirdata's giantsteps_key loader is the GiantSteps+ revision of the original GiantSteps Key labels, with the audio published on Zenodo.
- Labels with two keys ('E major | E minor'), 'other' modes, 'X' or a misspelt tonic are not scored and are counted as unusable; modal labels keep their major/minor word ('F minor dorian' is scored as F minor).
- Published GiantSteps Key figures are computed on the whole two-minute previews, mostly against the original 2015 labels; here one 30 s window per preview is scored against GiantSteps+ with the ambiguous labels left out. Not comparable.

Credits (cite these when using the data):

- Faraldo, Á. (2017). GiantSteps+ EDM Key Dataset. Zenodo. doi:10.5281/zenodo.1095691
- Faraldo, Á. (2017). Tonality Estimation in Electronic Dance Music: A Computational and Musically Informed Examination. PhD thesis, Universitat Pompeu Fabra, Barcelona
- Knees, P., Faraldo, Á., Herrera, P., Vogl, R., Böck, S., Hörschläger, F., Le Goff, M. (2015). Two data sets for tempo estimation and key detection in electronic dance music annotated from user corrections. Proc. ISMIR 2015, 364-370. doi:10.5281/zenodo.1414996 (the original GiantSteps Key dataset)
- The record's description asks for 10.5281/zenodo.1101082, but that DOI resolves to a different record (the Beatport EDM Key Dataset, 1,486 excerpts); the record used here is cited above

### Accuracy

- `librosa` returns a key for 11 of 50 clips (22.0 %); the key it returns is the reference key for 7 of all 50 clips (14.0 %).
- `essentia` returns a key for 11 of 50 clips (22.0 %); the key it returns is the reference key for 8 of all 50 clips (16.0 %).

| estimator | n | answered (coverage) | withheld | failed | MIREX: correct / n | MIREX: correct / answered | exact: correct / n | exact: correct / answered |
|---|---|---|---|---|---|---|---|---|
| `librosa` | 50 | 11/50 = 22.0 % [12.8, 35.2] | 39 | 0 | 8.3/50 = 16.6 % [8.6, 28.2] | 8.3/11 = 75.5 % [50.0, 90.9] | 7/50 = 14.0 % [7.0, 26.2] | 7/11 = 63.6 % [35.4, 84.8] |
| `essentia` | 50 | 11/50 = 22.0 % [12.8, 35.2] | 39 | 0 | 8.5/50 = 17.0 % [8.6, 29.2] | 8.5/11 = 77.3 % [48.2, 93.6] | 8/50 = 16.0 % [8.3, 28.5] | 8/11 = 72.7 % [43.4, 90.3] |

### Paired comparison

`librosa` and `essentia` on the same clips: the clips both answered, and all n clips with a withheld answer counted as not correct. The columns above are not comparable between estimators that answer different clips; compare them here.

| metric | clips | `librosa` | `essentia` | pairs better for `librosa` / for `essentia` | test |
|---|---|---|---|---|---|
| MIREX | both answered (n = 11) | 75.5 % | 77.3 % | 1 / 3 | mean difference -1.8 points [-38.3, 34.7] (paired t, ±1 pseudo-differences); sign-flip p = 1.000 (exact); the interval covers the mean in 99.8 % of 2,000 resamples of these differences |
| MIREX | all n (n = 50) | 16.6 % | 17.0 % | 1 / 3 | mean difference -0.4 points [-7.9, 7.1] (paired t, ±1 pseudo-differences); sign-flip p = 1.000 (exact); the interval covers the mean in 100.0 % of 2,000 resamples of these differences |
| exact | both answered (n = 11) | 7 | 8 | 1 / 2 | McNemar exact p = 1.000 |
| exact | all n (n = 50) | 7 | 8 | 1 / 2 | McNemar exact p = 1.000 |

### Withheld

`librosa`, withheld 4: no sustained pitch: 2; one held pitch over the beat (a drone or one bass note): 1; one voice without stable notes (speech-like): 1. The estimator still had an estimate for 4 of them.
`essentia`, withheld 4: no sustained pitch: 2; one held pitch over the beat (a drone or one bass note): 1; one voice without stable notes (speech-like): 1. The estimator still had an estimate for 4 of them.

When the evidence rule or a strength under the minimum withholds an answer, the estimator usually still has an estimate: the harness recomputes it with the rule lifted and scores it against the reference, which shows what each rule costs. A rule that helps withholds estimates that are right less often than the ones it returns. These estimates never reach a user and are not counted in the tables above. The first row per estimator is what the service returned, as served. A rule's row counts the clips that this rule alone withholds, so its last column is what correct / n would be with that rule alone lifted; clips that several rules withhold have their own row, and the last row lifts every rule. Clips with no estimate even with every rule lifted (the gate, no estimate) stay at no correct value.

| estimator | answers | MIREX: correct | MIREX: correct / n with these too | exact: correct | exact: correct / n with these too |
|---|---|---|---|---|---|
| `librosa` | returned (11) | 8.3/11 = 75.5 % [50.0, 90.9] | 8.3/50 = 16.6 % [8.6, 28.2] | 7/11 = 63.6 % [35.4, 84.8] | 7/50 = 14.0 % [7.0, 26.2] |
| `librosa` | only: no sustained pitch (26) | 12.3/26 = 47.3 % [30.8, 65.0] | 20.6/50 = 41.2 % [29.2, 53.8] | 10/26 = 38.5 % [22.4, 57.5] | 17/50 = 34.0 % [22.4, 47.8] |
| `librosa` | only: fewer than three pitch classes (5) | 2.6/5 = 52.0 % [20.0, 84.0] | 10.9/50 = 21.8 % [12.4, 33.8] | 2/5 = 40.0 % [11.8, 76.9] | 9/50 = 18.0 % [9.8, 30.8] |
| `librosa` | only: one voice without stable notes (speech-like) (5) | 2.6/5 = 52.0 % [24.0, 86.0] | 10.9/50 = 21.8 % [12.6, 34.8] | 2/5 = 40.0 % [11.8, 76.9] | 9/50 = 18.0 % [9.8, 30.8] |
| `librosa` | withheld by several rules (2) | 0/2 = 0.0 % (no interval: all scores equal) | 8.3/50 = 16.6 % [8.2, 28.0] | 0/2 = 0.0 % [0.0, 65.8] | 7/50 = 14.0 % [7.0, 26.2] |
| `librosa` | only: one held pitch over the beat (a drone or one bass note) (1) | 0/1 = 0.0 % (no interval: all scores equal) | 8.3/50 = 16.6 % [8.5, 28.2] | 0/1 = 0.0 % [0.0, 79.3] | 7/50 = 14.0 % [7.0, 26.2] |
| `librosa` | every rule lifted (39) | 17.5/39 = 44.9 % [31.5, 58.7] | 25.8/50 = 51.6 % [39.4, 63.4] | 14/39 = 35.9 % [22.7, 51.6] | 21/50 = 42.0 % [29.4, 55.8] |
| `essentia` | returned (11) | 8.5/11 = 77.3 % [48.2, 93.6] | 8.5/50 = 17.0 % [8.6, 29.2] | 8/11 = 72.7 % [43.4, 90.3] | 8/50 = 16.0 % [8.3, 28.5] |
| `essentia` | only: no sustained pitch (28) | 20.9/28 = 74.6 % [58.2, 86.8] | 29.4/50 = 58.8 % [45.8, 71.0] | 19/28 = 67.9 % [49.3, 82.1] | 27/50 = 54.0 % [40.4, 67.0] |
| `essentia` | only: fewer than three pitch classes (5) | 5/5 = 100.0 % (no interval: all scores equal) | 13.5/50 = 27.0 % [16.0, 40.6] | 5/5 = 100.0 % [56.6, 100.0] | 13/50 = 26.0 % [15.9, 39.6] |
| `essentia` | only: one voice without stable notes (speech-like) (5) | 2.1/5 = 42.0 % [18.0, 76.0] | 10.6/50 = 21.2 % [12.0, 33.8] | 1/5 = 20.0 % [3.6, 62.4] | 9/50 = 18.0 % [9.8, 30.8] |
| `essentia` | only: one held pitch over the beat (a drone or one bass note) (1) | 0/1 = 0.0 % (no interval: all scores equal) | 8.5/50 = 17.0 % [8.5, 29.3] | 0/1 = 0.0 % [0.0, 79.3] | 8/50 = 16.0 % [8.3, 28.5] |
| `essentia` | every rule lifted (39) | 28/39 = 71.8 % [58.0, 83.1] | 36.5/50 = 73.0 % [61.4, 83.2] | 25/39 = 64.1 % [48.4, 77.3] | 33/50 = 66.0 % [52.2, 77.6] |

### Accuracy vs coverage

Answered clips ranked by the service's confidence, highest first; each row keeps the top k (coverage = k / n) and gives correct / k with its interval. Rows with fewer than 10 clips are left out, except the last row (every answered clip). Neighbouring rows share most of their clips and their intervals overlap, so a rise or fall between rows is not evidence on its own. Whether the confidence ranks answers at all is the AUC line under each table: the chance that a correct answer has a higher confidence than a wrong one (0.5 is random order), with a one-sided Mann-Whitney p-value against random order.

`librosa`:

| coverage | k | min. confidence | MIREX | exact |
|---|---|---|---|---|
| 20.0 % | 10 | 0.431 | 7.3/10 = 73.0 % [46.0, 90.0] | 6/10 = 60.0 % [31.3, 83.2] |
| 22.0 % | 11 | 0.415 | 8.3/11 = 75.5 % [50.0, 90.9] | 7/11 = 63.6 % [35.4, 84.8] |

Confidence ranking: exact AUC 0.75 (7 correct, 4 wrong; p = 0.115, exact permutation).

`essentia`:

| coverage | k | min. confidence | MIREX | exact |
|---|---|---|---|---|
| 20.0 % | 10 | 0.812 | 7.5/10 = 75.0 % [44.0, 93.0] | 7/10 = 70.0 % [39.7, 89.2] |
| 22.0 % | 11 | 0.793 | 8.5/11 = 77.3 % [48.2, 93.6] | 8/11 = 72.7 % [43.4, 90.3] |

Confidence ranking: exact AUC 0.54 (8 correct, 3 wrong; p = 0.461, exact permutation).

## Reproducing

Datasets are fetched into `~/liner-notes-data` (or `LINER_NOTES_DATA`), outside the repository, under a cap (`LINER_NOTES_DATA_CAP_BYTES`, 2 GB by default). Only the selected tracks' audio is written, each checked against mirdata's MD5. See `evals/audio/README.md`.

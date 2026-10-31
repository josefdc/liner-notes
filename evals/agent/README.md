# Agent evals

How the agent itself is measured: whether it finds the samples gold documents, how often it
invents them, and whether the verifier catches false statements. This directory holds the
offline half: the scorer, the report and its checker, the perturbation set and its checks. None
of it makes a model call or a network request.

```
evals/agent/
  eval.mjs            npm run eval -- --suite agent --mode replay|live --subset ci|all
  report.mjs          npm run eval:table -- --runs <dir>: the report from run records
  check-report.mjs    checks a report has what #33 asks of it
  make-perturb.mjs    writes evals/perturb.jsonl from fixtures/replays at a fixed seed
  perturb-check.mjs   runs evals/perturb.jsonl through the app's numeric check
  export-labels.mjs   CSV of claims for blind human labelling, without verdicts
  lib/golden.mjs      golden set: rows, sha256, subsets, gold targets, sites
  lib/score.mjs       edge matching, held-out exclusion, hallucination, pipeline metrics
  lib/support.mjs     the deterministic support check (claim text against cited excerpts)
  lib/stats.mjs       Wilson intervals, seeded bootstrap, Jaccard
  testdata/           synthetic runs and reports for the tests (make-testdata.mjs writes them)
  *.test.mjs          node --test 'evals/**/*.test.mjs'
```

## Scoring

`lib/score.mjs` implements `evals/README.md` ("Scoring edges", "Held-out gold"). The run record
it reads is documented at the top of that file. In short:

- **Edges** are scored per distinct gold target, forward relations only. A target is found when
  a proposed edge names the same recording (ISRC, MusicBrainz id, or title and artist after the
  same normalisation as the coverage check) with the gold relation or one of its
  `relationAlternatives`. Precision is strict: on exhaustive rows every other proposal is a false
  positive; a proposal matching `otherDocumentedTargets` is left out; on rows that are not
  exhaustive, a proposal the run's evidence names is left out and one nothing names is a false
  positive. Unmatched proposals are listed in the report.
- **Held-out recall** is decided per run. A gold target counts as held-out in a run only while
  one of its held-out sources (`sourceQueriedByPipeline: false`) is on a site the run's evidence
  does not cite. Sites are registrable domains (`en.wikipedia.org` and `de.wikipedia.org` are both
  `wikipedia.org`), so the rule errs towards excluding. The report gives held-out n before and
  after the exclusion.
- **Hallucinated-sample rate**: the share of no-sample controls with at least one forward sample,
  interpolation or cover edge, and the mean number of such edges per control.
- **Identity** is scored at recording level (the row's MusicBrainz recording, else its ISRC).
- **Ablations**: (a) model only, no tools or evidence; (b) deterministic only, no model; (c) the
  pipeline before the verifier; (d) after it, which is what the UI shows. Each run record names
  its row.
- **Intervals**: 95 % Wilson for proportions; a percentile bootstrap over tracks (10,000
  resamples, seed 33) for means, medians and p95. A stratum with n < 10 is shown as counts.

## The report

```sh
npm run eval:table -- --runs <dir>                      # print the report
node evals/agent/report.mjs --runs <dir> --out evals/reports
                                                        # agent-<date>.md, agent-<date>.json, agent-latest.md
node evals/agent/check-report.mjs evals/reports/agent-latest.md
```

The report states the dataset and the golden file's sha256, the date, the commit, n and a 95 %
interval for every value, the clarification rate, ablation rows a-d, and held-out n after the
exclusion. Gold is described by its sources and their retrieval dates, never as human-labelled.
A report rendered from records marked `"synthetic": true` says so at the top.

`check-report.mjs` exits 1 and names each missing part: a table without n or a CI column, a row
without an interval, a small stratum shown as a rate, a missing ablation row, no clarification
rate, held-out numbers that do not add up, or a results file (`agent-<date>.json`) whose
per-run detail counts a target whose held-out sources are all on cited sites. The broken reports
in `testdata/` exercise each of these.

`npm run eval -- --suite agent --mode replay --subset ci|all` scores the records in
`evals/agent/runs` on the CI subset (six rows, `CI_SUBSET` in `lib/golden.mjs`) or the whole live
subset; `--runs <dir>` scores another directory. `--mode live` is refused.

## The perturbation set

`evals/perturb.jsonl` is generated, not written by hand:

```sh
node evals/agent/make-perturb.mjs        # rewrite it (same bytes every time)
node evals/agent/perturb-check.mjs       # numeric part through checkNumbers; judge part pending
node evals/agent/export-labels.mjs --out labels.csv   # blind labelling sheet
```

- **Claim cases.** Positives are code-built sourced claims (supported by construction) or model
  claims that pass the deterministic support check in `lib/support.mjs` (every sentence's quoted
  titles, names, years and relation verbs appear in the excerpts it cites). The judge's verdict
  is never read. Each positive gets two mutations its excerpts do not support: another real title
  or artist, another year, the roles swapped, another relation (sample to cover), or a real
  excerpt from another recording.
- **Numeric cases.** Tempos at the measured value, at octave equivalents (x2, x1/2) and at false
  values (x1.25, x0.8), on each recording's measured tempo; keys at the key, its relative key and
  false keys. No committed recording has a measured key, so the key cases carry a synthetic key
  block (`"keySource": "synthetic"`).
- `perturb-check.mjs` loads the app's own `checkNumbers` from
  `apps/api/src/agent/verifier/numeric.ts` with tsx (build `packages/contract` first). It prints
  how many equivalents were rejected (must be 0) and how many false values were caught (must be
  all), with catch and false-positive rates, and exits 1 otherwise.
- The CSV from `export-labels.mjs` has no verdict, label or mutation column, opaque ids
  (`label_id`, a sha256 prefix of the case id) and a shuffled order.

## Pending until the live golden run

- Recorded run records (`evals/agent/runs/`) and the cassettes `--mode replay` re-runs the
  pipeline from; until then replay exits 1 with "no recorded runs".
- `--mode live`, the model-only baseline (a) and the variance re-runs.
- The judge's part of `perturb-check.mjs` (a judge recording of the claim cases), and the
  verifier-as-classifier table with false-positive rates per positive source.
- The human-agreement table: no human labels exist.
- A committed `evals/reports/agent-*.md`; only test data is committed today.

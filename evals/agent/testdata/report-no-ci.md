# Agent evals, 2026-10-31

> **Synthetic test data.** These runs were generated for the scorer's tests
> (`evals/agent/testdata/make-testdata.mjs`). No number below measures the app.

- **Dataset**: `evals/golden.jsonl`, sha256 `8dd2049c03fa6a53fc74d353f765871cc9aa95f7ff6a8f2a081f341e29f49442`; 45 rows, 24 in the live subset.
- **Runs scored**: 102 run records over 24 tracks (subset: all).
- **Date**: 2026-10-31
- **Commit**: `synthetic` (runs recorded at `synthetic`)
- **Results**: `report-good.json`
- **Gold** is described by its sources, each read on the date given in the golden file: musicbrainz.org (20 references, read 2026-10-16); wikipedia.org (20 references, read 2026-10-16); rollingstone.com (3 references, read 2026-10-16); theguardian.com (2 references, read 2026-10-16); bbc.co.uk (1 reference, read 2026-10-16); billboard.com (1 reference, read 2026-10-16); ft.com (1 reference, read 2026-10-16); kexp.org (1 reference, read 2026-10-16); latimes.com (1 reference, read 2026-10-16); loudwire.com (1 reference, read 2026-10-16); npr.org (1 reference, read 2026-10-16); seattletimes.com (1 reference, read 2026-10-16). No gold label in this version was made by a person listening; none is human-labelled.

## How to read it

- **n** is printed next to every value. Proportions carry a 95 % Wilson score interval; means, medians and p95 carry a 95 % percentile bootstrap over tracks (10,000 resamples, seed 33). Edges and claims of one track are not independent, so pooled intervals are narrower than they should be.
- A stratum with n < 10 is shown as counts, not as a rate.
- **Edges** are scored per distinct gold target, forward relations only, strictly against gold (`evals/README.md`, "Scoring edges"). A proposal that matches an `otherDocumentedTargets` entry is left out of precision; on rows whose gold is not exhaustive, a proposal the run's evidence names is left out too.
- **Held-out recall** counts a gold target as held-out in a run only while one of its held-out sources is on a site the run's evidence does not cite. The held-out table gives n before and after that exclusion.
- **Clarification**: the harness answers the clarification step with the top-ranked candidate, never the gold ISRC; the clarification rate is how often the step fired.
- **Ablations**: (a) model only, no tools or evidence; (b) deterministic only, no model; (c) pipeline before the verifier; (d) pipeline after the verifier (what the UI shows).

## Pipeline (row d, after the verifier)

| metric | value | n | interval |
| --- | --- | --- | --- |
| preview coverage | 95.8 % (23/24) | 24 | Wilson |
| identity accuracy (recording level) | 95.8 % (23/24) | 24 | Wilson |
| clarification rate | 12.5 % (3/24) | 24 | Wilson |
| code-built edge coverage | 68.8 % (11/16) | 16 | Wilson |
| model edge precision | 66.7 % (4/6) | 6 | Wilson |
| pre-verifier support rate (model claims) | 87.5 % (42/48) | 48 | Wilson |
| schema-valid rate | 95.8 % (23/24) | 24 | Wilson |
| fallback rate | 4.2 % (1/24) | 24 | Wilson |
| latency p50 | 49.4 s | 24 | bootstrap |
| latency p95 | 58.1 s | 24 | bootstrap |
| tokens per analysis (mean) | 19069 | 24 | bootstrap |
| USD per analysis (mean) | USD 0.0129 | 24 | bootstrap |

## Ablations

| row | what it runs | metric | value | n | 95 % CI |
| --- | --- | --- | --- | --- | --- |
| a | model only, no tools or evidence | edge recall | 62.5 % (10/16) | 16 | [38.6 %, 81.5 %] |
| a | model only, no tools or evidence | edge precision (all proposed edges) | 66.7 % (10/15) | 15 | [41.7 %, 84.8 %] |
| a | model only, no tools or evidence | held-out edge recall | 60.0 % (9/15) | 15 | [35.7 %, 80.2 %] |
| a | model only, no tools or evidence | hallucinated-sample rate | 20.0 % (1/5) | 5 | [3.6 %, 62.4 %] |
| a | model only, no tools or evidence | edges per no-sample track (mean) | 0.20 | 5 | [0.00, 0.60] |
| b | deterministic only, no model | edge recall | 68.8 % (11/16) | 16 | [44.4 %, 85.8 %] |
| b | deterministic only, no model | edge precision (all proposed edges) | 100.0 % (11/11) | 11 | [74.1 %, 100.0 %] |
| b | deterministic only, no model | held-out edge recall | 71.4 % (10/14) | 14 | [45.4 %, 88.3 %] |
| b | deterministic only, no model | hallucinated-sample rate | 0.0 % (0/5) | 5 | [0.0 %, 43.4 %] |
| b | deterministic only, no model | edges per no-sample track (mean) | 0.00 | 5 | [0.00, 0.00] |
| c | pipeline before the verifier | edge recall | 93.8 % (15/16) | 16 | [71.7 %, 98.9 %] |
| c | pipeline before the verifier | edge precision (all proposed edges) | 75.0 % (15/20) | 20 | [53.1 %, 88.8 %] |
| c | pipeline before the verifier | held-out edge recall | 92.9 % (13/14) | 14 | [68.5 %, 98.7 %] |
| c | pipeline before the verifier | hallucinated-sample rate | 20.0 % (1/5) | 5 | [3.6 %, 62.4 %] |
| c | pipeline before the verifier | edges per no-sample track (mean) | 0.20 | 5 | [0.00, 0.60] |
| d | pipeline after the verifier (what the UI shows) | edge recall | 93.8 % (15/16) | 16 | [71.7 %, 98.9 %] |
| d | pipeline after the verifier (what the UI shows) | edge precision (all proposed edges) | 88.2 % (15/17) | 17 | [65.7 %, 96.7 %] |
| d | pipeline after the verifier (what the UI shows) | held-out edge recall | 92.9 % (13/14) | 14 | [68.5 %, 98.7 %] |
| d | pipeline after the verifier (what the UI shows) | hallucinated-sample rate | 20.0 % (1/5) | 5 | [3.6 %, 62.4 %] |
| d | pipeline after the verifier (what the UI shows) | edges per no-sample track (mean) | 0.20 | 5 | [0.00, 0.60] |

## Held-out recall after the per-run domain exclusion

| row | held-out gold targets | excluded (run cites the source's site) | n after exclusion | found | recall | 95 % CI |
| --- | --- | --- | --- | --- | --- | --- |
| a | 15 | 0 | 15 | 9 | 60.0 % | [35.7 %, 80.2 %] |
| b | 15 | 1 | 14 | 10 | 71.4 % | [45.4 %, 88.3 %] |
| c | 15 | 1 | 14 | 13 | 92.9 % | [68.5 %, 98.7 %] |
| d | 15 | 1 | 14 | 13 | 92.9 % | [68.5 %, 98.7 %] |

## Per stratum (row d)

| stratum | metric | value | n | 95 % CI |
| --- | --- | --- | --- | --- |
| documented-samples | identity accuracy | 100.0 % (13/13) | 13 | [77.2 %, 100.0 %] |
| documented-samples | edge recall | 92.9 % (13/14) | 14 | [68.5 %, 98.7 %] |
| no-sample-controls | identity accuracy | 5/5 | 5 | counts only (n < 10) |
| no-sample-controls | edge recall | no data | 0 | none (n = 0) |
| no-sample-controls | hallucinated-sample rate | 1/5 | 5 | counts only (n < 10) |
| ambiguous-titles | identity accuracy | 1/2 | 2 | counts only (n < 10) |
| ambiguous-titles | edge recall | 2/2 | 2 | counts only (n < 10) |
| non-english | identity accuracy | 2/2 | 2 | counts only (n < 10) |
| non-english | edge recall | no data | 0 | none (n = 0) |
| obscure | identity accuracy | 2/2 | 2 | counts only (n < 10) |
| obscure | edge recall | no data | 0 | none (n = 0) |

## Run-to-run variance (row d, tracks run twice)

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| Jaccard index of claims (mean) | 1.00 | 6 | [1.00, 1.00] |
| Jaccard index of edges (mean) | 0.94 | 6 | [0.83, 1.00] |

## Verifier as a classifier

Pending: no judge recording of `evals/perturb.jsonl`. The numeric check's catch and false-positive rates on the same set are printed by `node evals/agent/perturb-check.mjs`.

## Agreement with human labels

Pending: no human labels. `node evals/agent/export-labels.mjs` writes the claims to label, without verdicts.

## Unmatched proposed edges (row d)

- `USBB40000359`: "Invented Break" by Nobody In Particular, sample, model: false positive
- `AUUM71500303`: "Invented Break" by Nobody In Particular, sample, model: false positive

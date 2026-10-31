# Agent evals, 2026-10-31

> **Synthetic test data.** These runs were generated for the scorer's tests
> (`evals/agent/testdata/make-testdata.mjs`). No number below measures the app.

- **Dataset**: `evals/golden.jsonl`, sha256 `8dd2049c03fa6a53fc74d353f765871cc9aa95f7ff6a8f2a081f341e29f49442`; 45 rows, 24 in the live subset.
- **Run records**: `evals/agent/testdata/runs`, sha256 `b03b2f0bdb22445390902f322b7828162f6ee9bc6520671440fe2e29ce1741d9`; 102 records over 24 tracks (subset: all).
- **Date**: 2026-10-31
- **Commit**: `synthetic` (runs recorded at `synthetic`)
- **Results**: `report-good.json`
- **Gold** is described by its sources, each read on the date given in the golden file: musicbrainz.org (20 references, read 2026-10-16); wikipedia.org (20 references, read 2026-10-16); rollingstone.com (3 references, read 2026-10-16); theguardian.com (2 references, read 2026-10-16); bbc.co.uk (1 reference, read 2026-10-16); billboard.com (1 reference, read 2026-10-16); ft.com (1 reference, read 2026-10-16); kexp.org (1 reference, read 2026-10-16); latimes.com (1 reference, read 2026-10-16); loudwire.com (1 reference, read 2026-10-16); npr.org (1 reference, read 2026-10-16); seattletimes.com (1 reference, read 2026-10-16). Every gold label cites one of these sources; none comes from listening.

## How to read it

- **n** is printed next to every value. Proportions carry a 95 % Wilson score interval; means, medians and p95 carry a 95 % percentile bootstrap over tracks (10,000 resamples, seed 33). Edges and claims of one track are not independent, so pooled intervals are narrower than they should be.
- Any row with n < 10, in any table, is shown as counts (or the values themselves), with no rate and no interval.
- **Edges** are scored per distinct gold target, forward relations only, strictly against gold (`evals/README.md`, "Scoring edges"). One gold target gives one true positive however many spellings propose it; a gold target with a relation gold does not accept is a false positive. A proposal that matches an `otherDocumentedTargets` entry is left out of precision; on rows whose gold is not exhaustive, so is a proposal that one evidence sentence states this track uses, by that relation, naming its title and artist. **Model edge precision** covers only the edges the code did not also build.
- **Held-out recall**: a gold target is held-out only when none of its sources is one the pipeline queries (a target MusicBrainz also documents can be found by echoing MusicBrainz), and it stops counting in a run whose evidence cites the site of any of its sources; an archived, translated or mirrored copy counts as its original, and a page whose site cannot be placed counts as citing every site. The held-out table gives n before and after that exclusion, and which sites removed targets.
- **Pre-verifier support rate**: of the model's claims before the verifier (row c), the share the judge marked supported; a claim the judge did not reach counts as not supported.
- **Clarification**: the harness answers the clarification step with the top-ranked candidate, never the gold ISRC; the clarification rate is how often the step fired.
- **Ablations**: (a) model only, no tools or evidence; (b) deterministic only, no model; (c) pipeline before the verifier; (d) pipeline after the verifier (what the UI shows).

## Pipeline (row d, after the verifier)

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| preview coverage | 95.8 % (23/24) | 24 | [79.8 %, 99.3 %] |
| identity accuracy (recording level) | 95.8 % (23/24) | 24 | [79.8 %, 99.3 %] |
| clarification rate | 12.5 % (3/24) | 24 | [4.3 %, 31.0 %] |
| code-built edge coverage | 68.8 % (11/16) | 16 | [44.4 %, 85.8 %] |
| model edge precision | 4/6 | 6 | counts only (n < 10) |
| pre-verifier support rate (row c model claims, 0 not judged) | 87.5 % (42/48) | 48 | [75.3 %, 94.1 %] |
| schema-valid rate | 95.8 % (23/24) | 24 | [79.8 %, 99.3 %] |
| fallback rate | 4.2 % (1/24) | 24 | [0.7 %, 20.2 %] |
| latency p50 | 49.4 s | 24 | [44.4 s, 51.3 s] |
| latency p95 | 58.1 s | 24 | [55.0 s, 58.4 s] |
| tokens per analysis (mean) | 19069 | 24 | [18610, 19514] |
| USD per analysis (mean) | USD 0.0129 | 24 | [USD 0.0122, USD 0.0136] |

## Ablations

| row | what it runs | metric | value | n | 95 % CI |
| --- | --- | --- | --- | --- | --- |
| a | model only, no tools or evidence | edge recall | 62.5 % (10/16) | 16 | [38.6 %, 81.5 %] |
| a | model only, no tools or evidence | edge precision (all proposed edges) | 66.7 % (10/15) | 15 | [41.7 %, 84.8 %] |
| a | model only, no tools or evidence | held-out edge recall | 1/1 | 1 | counts only (n < 10) |
| a | model only, no tools or evidence | hallucinated-sample rate | 1/5 | 5 | counts only (n < 10) |
| a | model only, no tools or evidence | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 1.00, 0.00 | 5 | counts only (n < 10) |
| b | deterministic only, no model | edge recall | 68.8 % (11/16) | 16 | [44.4 %, 85.8 %] |
| b | deterministic only, no model | edge precision (all proposed edges) | 100.0 % (11/11) | 11 | [74.1 %, 100.0 %] |
| b | deterministic only, no model | held-out edge recall | 0/1 | 1 | counts only (n < 10) |
| b | deterministic only, no model | hallucinated-sample rate | 0/5 | 5 | counts only (n < 10) |
| b | deterministic only, no model | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 0.00, 0.00 | 5 | counts only (n < 10) |
| c | pipeline before the verifier | edge recall | 93.8 % (15/16) | 16 | [71.7 %, 98.9 %] |
| c | pipeline before the verifier | edge precision (all proposed edges) | 75.0 % (15/20) | 20 | [53.1 %, 88.8 %] |
| c | pipeline before the verifier | held-out edge recall | 1/1 | 1 | counts only (n < 10) |
| c | pipeline before the verifier | hallucinated-sample rate | 1/5 | 5 | counts only (n < 10) |
| c | pipeline before the verifier | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 1.00, 0.00 | 5 | counts only (n < 10) |
| d | pipeline after the verifier (what the UI shows) | edge recall | 93.8 % (15/16) | 16 | [71.7 %, 98.9 %] |
| d | pipeline after the verifier (what the UI shows) | edge precision (all proposed edges) | 100.0 % (17/17) | 17 | [99.5 %, 100.0 %] |
| d | pipeline after the verifier (what the UI shows) | held-out edge recall | no data | 0 | none (n = 0) |
| d | pipeline after the verifier (what the UI shows) | hallucinated-sample rate | 0.0 % (0/5) | 5 | [0.0 %, 0.1 %] |
| d | pipeline after the verifier (what the UI shows) | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 1.00, 0.00 | 5 | counts only (n < 10) |

False positives with the right target and the wrong relation, included in precision: (a) 0; (b) 0; (c) 0; (d) 0. Left out of precision: (a) 0 duplicate, 0 other documented, 0 unresolved; (b) 0 duplicate, 0 other documented, 0 unresolved; (c) 0 duplicate, 0 other documented, 0 unresolved; (d) 0 duplicate, 0 other documented, 0 unresolved.

## Held-out recall after the per-run domain exclusion

| row | held-out gold targets | excluded (run cites a site of its sources) | recall (found/n) | n after exclusion | 95 % CI |
| --- | --- | --- | --- | --- | --- |
| a | 1 | 0 | 1/1 | 1 | counts only (n < 10) |
| b | 1 | 0 | 0/1 | 1 | counts only (n < 10) |
| c | 1 | 0 | 1/1 | 1 | counts only (n < 10) |
| d | 1 | 1 | no data | 0 | none (n = 0) |

Targets excluded, by the cited site: (d) wikipedia.org 1.

Few held-out targets ((a) 1 of 1; (b) 1 of 1; (c) 1 of 1; (d) 0 of 1): only gold targets that no queried source documents are held-out, and runs that cite their sources' sites lose them, so held-out recall rests on these few and is shown as counts.

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
| Jaccard index of claims (mean) | values 1.00, 1.00, 1.00, 1.00, 1.00, 1.00 | 6 | counts only (n < 10) |
| Jaccard index of edges (mean) | values 1.00, 1.00, 0.67, 1.00, 1.00, 1.00 | 6 | counts only (n < 10) |

## Verifier as a classifier

Pending: no judge recording of `evals/perturb.jsonl`. The numeric check's catch and false-positive rates on the same set are printed by `node evals/agent/perturb-check.mjs`.

## Agreement with human labels

Pending: no labels from people exist. `node evals/agent/export-labels.mjs` writes the claims to label, without verdicts.

## Unmatched proposed edges (row d)

- `USBB40000359`: "Invented Break" by Nobody In Particular, sample, model: false positive (not in gold)
- `AUUM71500303`: "Invented Break" by Nobody In Particular, sample, model: false positive (not in gold)

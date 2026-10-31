# Agent evals, 2026-10-31

- **Dataset**: `evals/golden.jsonl`, sha256 `8dd2049c03fa6a53fc74d353f765871cc9aa95f7ff6a8f2a081f341e29f49442`; 45 rows, 24 in the live subset.
- **Run records**: `evals/agent/runs/2026-10-31`, sha256 `6abd4c278c2a1049277bdb9aa841f1a834d6b4977b4135652ce49a57d202250a`; 102 records over 24 tracks (subset: all).
- **Date**: 2026-10-31
- **Commit**: `5fd193fa7a64` (runs recorded at `5fd193fa7a64`)
- **Results**: `agent-2026-10-31.json`
- **Gold** is described by its sources, each read on the date given in the golden file: musicbrainz.org (20 references, read 2026-10-16); wikipedia.org (20 references, read 2026-10-16); rollingstone.com (3 references, read 2026-10-16); theguardian.com (2 references, read 2026-10-16); bbc.co.uk (1 reference, read 2026-10-16); billboard.com (1 reference, read 2026-10-16); ft.com (1 reference, read 2026-10-16); kexp.org (1 reference, read 2026-10-16); latimes.com (1 reference, read 2026-10-16); loudwire.com (1 reference, read 2026-10-16); npr.org (1 reference, read 2026-10-16); seattletimes.com (1 reference, read 2026-10-16). Every gold label cites one of these sources; none comes from listening.
- **Models**: the pipeline writes on `fast gpt-6-luna`, `main gpt-6-luna` and judges on `gpt-6-sol`; the judge's model writes nothing the judge reads. The model-only baseline (row a) runs on `gpt-6-sol`, the judge's model, so it is never judged: none of its claims is shown as sourced. All of this is read from the spend lines the run records keep.
- **Second judge**: none. A judge from another model family (Gemini) is unavailable: the app's Gemini provider is not implemented and refuses every call (`LLM_PROVIDER=gemini`, `apps/api/src/llm/factory.ts`), so every verdict here comes from one judge model.

## How to read it

- **n** is printed next to every value. Proportions carry a 95 % Wilson score interval; means, medians and p95 carry a 95 % percentile bootstrap over tracks (10,000 resamples, seed 33). Edges and claims of one track are not independent, so pooled intervals are narrower than they should be.
- Any row with n < 10, in any table, is shown as counts (or the values themselves), with no rate and no interval.
- **Edges** are scored per distinct gold target, forward relations only, strictly against gold (`evals/README.md`, "Scoring edges"). One gold target gives one true positive however many spellings propose it; a gold target with a relation gold does not accept is a false positive. A proposal that matches an `otherDocumentedTargets` entry is left out of precision; on rows whose gold is not exhaustive, so is a proposal that one evidence sentence states this track uses, by that relation, naming its title and artist. **Model edge precision** covers only the edges the code did not also build.
- **Held-out recall**: a gold target is held-out only when none of its sources is one the pipeline queries (a target MusicBrainz also documents can be found by echoing MusicBrainz), and it stops counting in a run whose evidence cites the site of any of its sources; an archived, translated or mirrored copy counts as its original, and a page whose site cannot be placed counts as citing every site. The held-out table gives n before and after that exclusion, and which sites removed targets.
- **Pre-verifier support rate**: of the model's claims before the verifier (row c), the share the judge marked supported; a claim the judge did not reach counts as not supported.
- **Clarification**: the harness answers the clarification step with the top-ranked candidate, never the gold ISRC; the clarification rate is how often the step fired.
- **Rows b, c and d come from the same runs.** Row d counts the relations the result shows as documented (sourced links: code-built ones, and model ones whose own claim the judge found supported); a model link the verifier did not source is shown as a possible relation, labelled model inference, and counts in row c only. Row c is every relation the run proposed and every claim it wrote, before the verifier's verdicts take effect. Row b is the code-built links and claims of the same runs. Row a is a separate call per track: the composer's prompt with only the title and artist, no tools and no evidence.
- **Ablations**: (a) model only, no tools or evidence; (b) deterministic only, no model; (c) pipeline before the verifier; (d) pipeline after the verifier (what the UI shows).

## Pipeline (row d, after the verifier)

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| preview coverage | 95.8 % (23/24) | 24 | [79.8 %, 99.3 %] |
| identity accuracy (recording level) | 70.8 % (17/24) | 24 | [50.8 %, 85.1 %] |
| clarification rate | 58.3 % (14/24) | 24 | [38.8 %, 75.5 %] |
| code-built edge coverage | 43.8 % (7/16) | 16 | [23.1 %, 66.8 %] |
| model edge precision | 1/2 | 2 | counts only (n < 10) |
| pre-verifier support rate (row c model claims, 14 not judged) | 51.8 % (58/112) | 112 | [42.6 %, 60.8 %] |
| schema-valid rate | 100.0 % (24/24) | 24 | [86.2 %, 100.0 %] |
| fallback rate | 0.0 % (0/24) | 24 | [0.0 %, 13.8 %] |
| latency p50 | 23.4 s | 24 | [21.4 s, 25.0 s] |
| latency p95 | 28.5 s | 24 | [26.3 s, 31.0 s] |
| tokens per analysis (mean) | 15421 | 24 | [13960, 16792] |
| USD per analysis (mean) | USD 0.0102 | 24 | [USD 0.0092, USD 0.0113] |

## Cost per model tier (row d)

From the spend lines of each run (the app's own accounting: input and output tokens as the provider reported them, reasoning included in output, at the prices in `apps/api/src/llm/prices.ts`).

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| fast (gpt-6-luna): calls per analysis (mean) | 2.00 | 24 | [2.00, 2.00] (all resamples equal) |
| fast (gpt-6-luna): tokens per analysis (mean) | 3723 | 24 | [3558, 3879] |
| fast (gpt-6-luna): USD per analysis (mean) | USD 0.0005 | 24 | [USD 0.0005, USD 0.0006] |
| judge (gpt-6-sol): calls per analysis (mean) | 1.00 | 24 | [1.00, 1.00] (all resamples equal) |
| judge (gpt-6-sol): tokens per analysis (mean) | 2012 | 24 | [1822, 2227] |
| judge (gpt-6-sol): USD per analysis (mean) | USD 0.0081 | 24 | [USD 0.0072, USD 0.0092] |
| main (gpt-6-luna): calls per analysis (mean) | 1.00 | 24 | [1.00, 1.00] (all resamples equal) |
| main (gpt-6-luna): tokens per analysis (mean) | 9685 | 24 | [8441, 10839] |
| main (gpt-6-luna): USD per analysis (mean) | USD 0.0015 | 24 | [USD 0.0014, USD 0.0017] |

## Sources the runs could not read (row d)

Every run is kept and counted whatever its sources answered; no run was repeated to get a better answer. A source with no credential configured is not an error of the run and is listed apart.

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| runs with at least one source error (source-error rate) | 58.3 % (14/24) | 24 | [38.8 %, 75.5 %] |
| runs where genius: unavailable | 8.3 % (2/24) | 24 | [2.3 %, 25.8 %] |
| runs where listenbrainz: unavailable | 4.2 % (1/24) | 24 | [0.7 %, 20.2 %] |
| runs where musicbrainz: unavailable | 8.3 % (2/24) | 24 | [2.3 %, 25.8 %] |
| runs where secondhandsongs: unavailable | 58.3 % (14/24) | 24 | [38.8 %, 75.5 %] |

Not configured in these runs: discogs. Runs with no result: none.

## Ablations

| row | what it runs | metric | value | n | 95 % CI |
| --- | --- | --- | --- | --- | --- |
| a | model only, no tools or evidence | edge recall | 68.8 % (11/16) | 16 | [44.4 %, 85.8 %] |
| a | model only, no tools or evidence | edge precision (all proposed edges) | 91.7 % (11/12) | 12 | [64.6 %, 98.5 %] |
| a | model only, no tools or evidence | held-out edge recall | 0/1 | 1 | counts only (n < 10) |
| a | model only, no tools or evidence | hallucinated-sample rate | 0/5 | 5 | counts only (n < 10) |
| a | model only, no tools or evidence | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 0.00, 0.00 | 5 | counts only (n < 10) |
| b | deterministic only, no model | edge recall | 43.8 % (7/16) | 16 | [23.1 %, 66.8 %] |
| b | deterministic only, no model | edge precision (all proposed edges) | 7/8 | 8 | counts only (n < 10) |
| b | deterministic only, no model | held-out edge recall | no data | 0 | none (n = 0) |
| b | deterministic only, no model | hallucinated-sample rate | 0/5 | 5 | counts only (n < 10) |
| b | deterministic only, no model | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 0.00, 0.00 | 5 | counts only (n < 10) |
| c | pipeline before the verifier | edge recall | 87.5 % (14/16) | 16 | [64.0 %, 96.5 %] |
| c | pipeline before the verifier | edge precision (all proposed edges) | 70.0 % (14/20) | 20 | [48.1 %, 85.5 %] |
| c | pipeline before the verifier | held-out edge recall | no data | 0 | none (n = 0) |
| c | pipeline before the verifier | hallucinated-sample rate | 0/5 | 5 | counts only (n < 10) |
| c | pipeline before the verifier | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 0.00, 0.00 | 5 | counts only (n < 10) |
| d | pipeline after the verifier (what the UI shows) | edge recall | 50.0 % (8/16) | 16 | [28.0 %, 72.0 %] |
| d | pipeline after the verifier (what the UI shows) | edge precision (all proposed edges) | 80.0 % (8/10) | 10 | [49.0 %, 94.3 %] |
| d | pipeline after the verifier (what the UI shows) | held-out edge recall | no data | 0 | none (n = 0) |
| d | pipeline after the verifier (what the UI shows) | hallucinated-sample rate | 0/5 | 5 | counts only (n < 10) |
| d | pipeline after the verifier (what the UI shows) | edges per no-sample track (mean) | values 0.00, 0.00, 0.00, 0.00, 0.00 | 5 | counts only (n < 10) |

False positives with the right target and the wrong relation, included in precision: (a) 0; (b) 0; (c) 0; (d) 0. Left out of precision: (a) 0 duplicate, 0 other documented, 0 unresolved; (b) 0 duplicate, 0 other documented, 0 unresolved; (c) 0 duplicate, 0 other documented, 0 unresolved; (d) 0 duplicate, 0 other documented, 0 unresolved.

| row | what it runs | claims shown as sourced | value | n | 95 % CI |
| --- | --- | --- | --- | --- | --- |
| a | model only, no tools or evidence | 0 by construction (no evidence, never judged) | 0.0 % (0/70) | 70 | [0.0 %, 5.2 %] |
| b | deterministic only, no model | kind sourced | 100.0 % (164/164) | 164 | [97.7 %, 100.0 %] |
| d | pipeline after the verifier (what the UI shows) | kind sourced | 84.1 % (232/276) | 276 | [79.3 %, 87.9 %] |

## Held-out recall after the per-run domain exclusion

| row | held-out gold targets | excluded (run cites a site of its sources) | recall (found/n) | n after exclusion | 95 % CI |
| --- | --- | --- | --- | --- | --- |
| a | 1 | 0 | 0/1 | 1 | counts only (n < 10) |
| b | 1 | 1 | no data | 0 | none (n = 0) |
| c | 1 | 1 | no data | 0 | none (n = 0) |
| d | 1 | 1 | no data | 0 | none (n = 0) |

Targets excluded, by the cited site: (b) wikipedia.org 1; (c) wikipedia.org 1; (d) wikipedia.org 1.

Few held-out targets ((a) 1 of 1; (b) 0 of 1; (c) 0 of 1; (d) 0 of 1): only gold targets that no queried source documents are held-out, and runs that cite their sources' sites lose them, so held-out recall rests on these few and is shown as counts.

## Per stratum (row d)

| stratum | metric | value | n | 95 % CI |
| --- | --- | --- | --- | --- |
| documented-samples | identity accuracy | 61.5 % (8/13) | 13 | [35.5 %, 82.3 %] |
| documented-samples | edge recall | 50.0 % (7/14) | 14 | [26.8 %, 73.2 %] |
| no-sample-controls | identity accuracy | 4/5 | 5 | counts only (n < 10) |
| no-sample-controls | edge recall | no data | 0 | none (n = 0) |
| no-sample-controls | hallucinated-sample rate | 0/5 | 5 | counts only (n < 10) |
| ambiguous-titles | identity accuracy | 1/2 | 2 | counts only (n < 10) |
| ambiguous-titles | edge recall | 1/2 | 2 | counts only (n < 10) |
| non-english | identity accuracy | 2/2 | 2 | counts only (n < 10) |
| non-english | edge recall | no data | 0 | none (n = 0) |
| obscure | identity accuracy | 2/2 | 2 | counts only (n < 10) |
| obscure | edge recall | no data | 0 | none (n = 0) |

## Run-to-run variance (row d, tracks run twice)

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| Jaccard index of claims (mean) | values 0.70, 0.77, 0.33, 0.50, 0.44, 0.00 | 6 | counts only (n < 10) |
| Jaccard index of edges (mean) | values 1.00, 1.00, 1.00, 1.00, 0.50, 1.00 | 6 | counts only (n < 10) |

## Verifier as a classifier

The app's judge (`judgeClaims`, on `gpt-6-sol`) on the 81 claim cases of `evals/perturb.jsonl` (sha256 `06f81e6ce1f83bfe9f40aa4f38ad22e4378fe0ef90a4854aa3d4e01008626d4c`), recorded at `5fd193fa7a64`: `evals/agent/runs/2026-10-31/perturb/judge.json`, replayed at no cost from `fixtures/cassettes/llm/perturb`. A statement is never judged beside its own mutation. A case is rejected when its verdict would not show it as sourced (the app's rule: `supported`, or `partial` for a statement that asserts no relation); a case the judge did not reach counts as rejected. Verdicts: contradicted 29, partial 9, supported 27, unsupported 16.

Positives never come from a verdict: they are code-built sourced claims (supported by construction) or model claims that pass the deterministic support check (`evals/agent/lib/support.mjs`). Mutations are unsupported by their cited excerpts, which is not the same as false. A mutation counts under its positive's source.

| metric | value | n | 95 % CI |
| --- | --- | --- | --- |
| all positives rejected (false-positive rate) | 0.0 % (0/27) | 27 | [0.0 %, 12.5 %] |
| all mutations rejected (catch rate) | 98.1 % (53/54) | 54 | [90.2 %, 99.7 %] |
| code positives rejected (false-positive rate) | 0.0 % (0/20) | 20 | [0.0 %, 16.1 %] |
| mutations of code positives rejected (catch rate) | 97.5 % (39/40) | 40 | [87.1 %, 99.6 %] |
| model-support-check positives rejected (false-positive rate) | 0/7 | 7 | counts only (n < 10) |
| mutations of model-support-check positives rejected (catch rate) | 100.0 % (14/14) | 14 | [78.5 %, 100.0 %] |
| mutation "artist-or-title" rejected | 92.3 % (12/13) | 13 | [66.7 %, 98.6 %] |
| mutation "irrelevant-excerpt" rejected | 100.0 % (15/15) | 15 | [79.6 %, 100.0 %] |
| mutation "relation" rejected | 100.0 % (12/12) | 12 | [75.8 %, 100.0 %] |
| mutation "role" rejected | 9/9 | 9 | counts only (n < 10) |
| mutation "year" rejected | 5/5 | 5 | counts only (n < 10) |

Model-positive pool: 12 model claims of the recordings cite evidence; 7 pass the support check and are the model positives, 5 are refused. The check is a conservative heuristic over English sentences, so the model positives lean towards simple sentences.

### Audit of the model positives

Each model claim of the recordings that cites evidence was read against the excerpts it cites, before the judge was run on the set. 'stated' means every part of the claim is in a cited excerpt; nothing else was consulted. Positives stated by their excerpts: 7 of 7. Refused claims stated by their excerpts (correct claims the check refused): 4 of 5.

- positive `bitter-sweet-symphony-the-verve:179574d5`: stated. "June 1, 1997" is the excerpt's first release date 1997-06-01.
- positive `bitter-sweet-symphony-the-verve:f67d7102`: stated. The excerpt says the work is covered by Coldplay feat. Richard Ashcroft.
- positive `juicy-the-notorious-big:1901e816`: stated. "September 13, 1994" is the excerpt's first release date 1994-09-13.
- positive `juicy-the-notorious-big:49a56b45`: stated. The excerpt says Juicy samples "Rappin' Duke (vocal)" by The Rappin' Duke.
- positive `juicy-the-notorious-big:f3a2ae6f`: stated. The excerpt says Juicy samples "Juicy Fruit" by Mtume.
- positive `one-more-time-daft-punk:3cbb3e61`: stated. The excerpt gives the first release as 2000.
- positive `one-more-time-daft-punk:78acfe08`: stated. The excerpt says One More Time samples "More Spell on You" by Eddie Johns.
- refused `bitter-sweet-symphony-the-verve:71a2da2e`: not stated. The first sentence is in the excerpt; the second (the arrangement "described in the source material") is not in any cited excerpt.
- refused `bitter-sweet-symphony-the-verve:824ae39c`: stated (a correct claim the check refused). The excerpt says the work is covered by Coldplay feat. Richard Ashcroft; the claim says so as "a version of the song … as a cover" and names no quoted title, which the check needs.
- refused `hung-up-madonna:e6b2b34e`: stated (a correct claim the check refused). Each remixer is named in a cited remix title; the check reads a name inside a quoted title as part of the title, and one sentence spans three excerpts.
- refused `juicy-the-notorious-big:117ba937`: stated (a correct claim the check refused). Each of the four recordings is in a cited excerpt; one sentence lists them across four excerpts, in a possessive form ("Jay-Z's 'A Dream'").
- refused `juicy-the-notorious-big:5ed3b846`: stated (a correct claim the check refused). Each of the three recordings is in a cited excerpt; one sentence lists them across three excerpts, in a possessive form.

## Agreement with human labels

Pending: no labels from people exist. `node evals/agent/export-labels.mjs` writes the claims to label, without verdicts.

## Unmatched proposed edges (row d)

- `USDJ20200650`: "Hurt (the song)" with no artist, cover, code: false positive (not in gold)
- `GBAHT0600202`: "Stop and Check Yourself" by Garnet Mimms, sample, model: false positive (not in gold)

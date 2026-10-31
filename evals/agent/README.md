# Agent evals

How the agent itself is measured: whether it finds the samples gold documents, how often it
invents them, and whether the verifier catches false statements. This directory holds the
scorer, the report and its checker, the perturbation set and its checks, which make no model
call and no network request, and the harnesses that record the golden run through the app
(`run.mjs`, `baseline.mjs`, `perturb-judge.mjs`), which do, and replay it from cassettes, which
do not.

```
evals/agent/
  eval.mjs            npm run eval -- --suite agent --mode replay|live --subset ci|all
  run.mjs             the pipeline through the API: live (record), replay, rebuild records
  baseline.mjs        ablation (a): the composer's prompt alone, live or replayed
  perturb-judge.mjs   the app's judge on the claim cases of evals/perturb.jsonl
  assemble.mjs        gathers a live run's per-track files into one run-record directory
  spend.mjs           the spend log by purpose, against the caps, and what the records name
  report.mjs          npm run eval:table -- --runs <dir>: the report from run records
  check-report.mjs    renders a report again from its run records and checks it
  make-perturb.mjs    writes evals/perturb.jsonl from fixtures/replays at a fixed seed
  perturb-check.mjs   runs evals/perturb.jsonl through the app's numeric check
  export-labels.mjs   CSV of claims to label blind, without verdicts; its key apart
  lib/golden.mjs      golden set: rows, sha256, subsets, gold targets, sites
  lib/score.mjs       edge matching, held-out exclusion, hallucination, pipeline metrics
  lib/support.mjs     the deterministic support check (claim text against cited excerpts)
  lib/stats.mjs       Wilson intervals, seeded bootstrap, Jaccard
  lib/extras.mjs      models, cost per tier, source errors, sourced claims, the verifier as a classifier
  lib/record.mjs      run records from the API's event stream (rows b, c and d of one run)
  lib/api.mjs         starts the API with pinned settings and runs one analysis
  lib/app.mjs         loads the app's TypeScript modules (tsx), one namespace
  lib/inproc.mjs      the app's model layer in this process (baseline, judge)
  runs/<date>/        the committed run records of a golden run (a-d, d-repeat, perturb/)
  testdata/           synthetic runs and reports for the tests (make-testdata.mjs writes them)
  *.test.mjs          node --test 'evals/**/*.test.mjs'
```

## Scoring

`lib/score.mjs` implements `evals/README.md` ("Scoring edges", "Held-out gold"). The run record
it reads is documented at the top of that file. In short:

- **Run records** are checked on reading: an unknown ablation, edge direction (`uses`,
  `usedBy`), relation (`sample`, `interpolation`, `cover`, `remix`) or origin (`code`, `model`),
  a `synthetic` flag that is not a boolean, or a control character in a proposed title is an
  error naming the file and field, never a silently dropped edge. So is a second record for the
  same row, ablation and repeat (a pilot left beside the full run would count twice): the error
  names both files. With `--subset`, every subset row needs a first run in row d and in every
  other row that was run; the error names the rows that have none.
- **Edges** are scored per distinct gold target, forward relations only. A target is found when
  a proposed edge names the same recording (ISRC, MusicBrainz id, or title and artist after the
  same normalisation as the coverage check) with the gold relation or one of its
  `relationAlternatives`. Precision is strict:
  - one true positive per gold target; other spellings of it (a remaster title, an ISRC-only
    match) are duplicates, left out. The code's copy is credited first, so **model edge
    precision** covers only the edges the code did not also build;
  - a gold target with a relation gold does not accept is a false positive, counted apart as
    "right target, wrong relation"; so is the track itself;
  - a proposal matching `otherDocumentedTargets` is left out;
  - on exhaustive rows every other proposal is a false positive; on rows that are not
    exhaustive, a proposal is left out ("unresolved") only when one sentence of the run's
    evidence states that the row's own track uses it by that relation, in one clause, naming
    its title (quoted) and its artist. "Love" or "Time" somewhere in an excerpt is not enough,
    and neither is a sentence about another song's relation.
  Unmatched proposals are listed in the report, with why each counts as it does.
- **Held-out recall.** A gold target is held-out only when **none** of its sources is one the
  pipeline queries (`sourceQueriedByPipeline: true`, MusicBrainz above all): a target that
  MusicBrainz also documents can be found by echoing MusicBrainz, which is what held-out gold
  exists to rule out. It then stops counting as held-out in a run whose evidence cites the site
  of any of its sources. Sites are registrable domains (`en.wikipedia.org` and
  `de.wikipedia.org` are both `wikipedia.org`); a Wayback Machine, archive.today, Google cache,
  Google Translate or AMP copy counts as the page it carries, and a Wikipedia mirror (Wikiwand
  and the like) as Wikipedia; a page whose site cannot be placed (a link shortener, a host
  without a dot, an unparseable URL, any other URL that carries another URL) counts as citing
  every site. The rule errs towards excluding. Of the 16 gold targets in the live subset, 15
  also have a MusicBrainz source, so **one** target is held-out (Crazy's "Last Men Standing",
  documented by Wikipedia only) and it is lost in any run that cites Wikipedia, as each of the
  four committed recordings does. Held-out recall is therefore shown as counts, the report says
  why, and it gives n before and after the exclusion and the sites that removed targets.
- **Hallucinated-sample rate**: the share of no-sample controls with at least one forward sample,
  interpolation or cover edge, and the mean number of such edges per control.
- **Identity** is scored at recording level: the row's MusicBrainz recording when both the row
  and the run know it, else the ISRC (another ISRC of the same recording is correct; the same
  ISRC with another recording is not).
- **Pre-verifier support rate**: of the model's claims in the before-verifier runs (row c), the
  share the judge marked supported. A claim the judge did not reach counts as not supported, and
  the report says how many there were. It measures the judge's verdicts, not truth.
- **Ablations**: (a) model only, no tools or evidence; (b) deterministic only, no model; (c) the
  pipeline before the verifier; (d) after it, which is what the UI shows. Each run record names
  its row.
- **Intervals**: 95 % Wilson for proportions; a percentile bootstrap over tracks (10,000
  resamples, seed 33) for means, medians and p95. Any row with n < 10, in any table, is shown
  as counts ("k/n") or as its per-track values, with no rate and no interval.

## The report

```sh
npm run eval:table -- --runs <dir>                      # print the report
node evals/agent/report.mjs --runs <dir> --subset all --out evals/reports
                                                        # agent-<date>.md, agent-<date>.json, agent-latest.md
node evals/agent/check-report.mjs evals/reports/agent-latest.md
```

The report states the dataset and the golden file's sha256, the run records it was rendered
from, the date, the commit, n and a 95 % interval for every value, the clarification rate,
ablation rows a-d, and held-out n after the exclusion. From records of the live harness (they
carry their spend lines) it also states the models that wrote and judged and that no second
judge exists, the cost per model tier, the source-error rate and each source's errors, the
claims each row shows as sourced (row a: 0 by construction), and, from the judge record in
`<runs>/perturb/`, the verifier as a classifier: false-positive and catch rates overall, per
positive source and per mutation, the model-positive pool and the audit of the model positives. Gold is described by its sources and
their retrieval dates; no label is described as made by people, because none was. A report
rendered from records marked `"synthetic": true` says so at the top.

`check-report.mjs` exits 1 and names each problem. It renders the report again from the run
records and golden file its header names (with its date, commit and subset) and requires the
Markdown and the results file (`agent-<date>.json`) to match byte for byte; the held-out
exclusion is re-derived from the runs' evidence, never read from the results file. The header
carries the sha256 of the run-record directory (its records, `perturb/` and `results/`), so
records that changed since the report are named as such (keep each golden run's records in a
directory of its own). It also checks the
structure on its own: a header with the dataset (its sha256 must still match), run records,
date, commit and results file; Markdown tables at the start of the line (no HTML, no indent)
with value, n and "95 % CI" columns; every rate's "(k/n)" against its n and its Wilson interval
recomputed; statistics with a numeric interval, low before high (marked "all resamples equal"
only when every track's value is equal, and only on an interval with no width); counts only below n = 10; "no data" only at n = 0; ablation rows a-d;
the clarification rate; held-out numbers that add up; no "human-labelled", "annotators" or the
like, in any case; the synthetic banner when the records are synthetic. A report under
`evals/reports` must also score `evals/golden.jsonl` with the sha256 that file had at the
report's commit, name a header commit and run commits that exist in git, be rendered with
`--subset ci` or `--subset all` (so a track whose run crashed is named, never left out), and come
from records that are neither synthetic nor under a `testdata` directory (`report.mjs` refuses
to write those there). The broken reports in `testdata/` exercise each of these, and the tests show
which ones only re-rendering catches.

What `check-report.mjs` cannot tell: whether the run records came from real runs. It proves a
report is what the named records and dataset give. For a published report it refuses records
marked synthetic, records under a `testdata` path, commits that are not in the repository and a
dataset other than `evals/golden.jsonl` at the report's commit; nothing more. Records edited
together with their report still pass, and so does the test data copied out of `testdata/`
with its `synthetic` flag removed and a real commit set. Where
the records come from is shown by the golden run's own trail (its cassettes and spend log), not
by this check.

`npm run eval -- --suite agent --mode replay --subset ci|all` replays the subset (seven rows,
`CI_SUBSET` in `lib/golden.mjs`, or the whole live subset) through the API: one API process per
row, with dummy keys, the recorded answers of `fixtures/cassettes/llm/golden/<isrc>` and
`fixtures/cassettes/sources/golden/<isrc>` (the audio block is `audio.json` there), and
`tests/deny-network.mjs` loaded in each. Two things of every replayed run must equal what the
newest directory under `evals/agent/runs` keeps, with 0 outbound attempts and 0 spend lines:

- rows b, c and d, the scored part (identity, clarification, the measured audio fields,
  evidence, the current track's edges, claims, source errors, schema and fallback);
- the whole result the run showed, normalised (`results/<ISRC>.json`, written by
  `assemble.mjs` from the run's event stream): every claim, factoid, genealogy node and link
  (links between two related recordings included), the audio block, energy and the other
  features, key moments, segments, release year, preview match, the verifier's counts and the
  source errors.

The normalisation (`RESULT_MASKS` in `lib/record.mjs`) masks only what changes between two runs
of the same code on the same answers, and nothing else:

- the run's id, and the ids of claims, factoids and factoid entities, each replaced by its order
  of first appearance (new random ids every run; references to them keep pointing the same way);
- `run.mode`, `run.replayed`, `run.recordedAt`, `run.commit` and `run.usage.usd`, left out (how
  and when the run was made; a replay spends nothing);
- `previewUrl`, anywhere, left out (a signed link that expires; the cassettes keep none);
- `coverUrl`, kept as present or absent, and a genealogy node's `img`, left out (CDN image
  links, kept out of the committed files);
- evidence `retrievedAt` (the time the run read the source).

A difference exits 1, prints the first differing paths of the result
(`.genealogy.links[1].value: recorded 2, replayed 3`), writes the replayed records and result to
the scratch directory, and says how to record again (a change to a prompt, a schema, a tier or
an output cap makes the recorded answers misses). A missing committed record or result of a
replayed row is an error. A source the recorded run had no credential for is replayed as not
configured (the cassette directory's `credentials.json`). Only the CI subset's cassettes are
committed, so `--subset all` fails on the other rows, naming each. `--runs <dir>` uses another
directory; `--score-only` scores the records with no replay (the synthetic test data has no
cassettes). The CI subset holds Stronger (`USUM70741299`), whose result links two related
recordings (second-hop samples) and whose preview gave no measurement.

CI runs, with every outbound connection refused and no spending: the CI subset's replay;
`check-report.mjs evals/reports/agent-latest.md` (which needs the whole history, so that the
commit the runs were recorded at and `evals/golden.jsonl` as it was there can be read); and
`perturb-check.mjs`. `node --test 'evals/**/*.test.mjs'` also scans every committed file under
`fixtures/cassettes` and `evals/agent/runs` for credential shapes (keys in their services'
formats, api-key and Authorization headers, bearer tokens and token fields that are not
`[redacted]`, credentials in a query), preview hosts with or without a scheme, and signed links'
parameters (`lib/scan.mjs`, `scan.test.mjs`).

## Recording the golden run

Live runs call the model and the sources, so they spend: each call is a line of the spend log,
under its purpose, within the app's caps (`BUDGET_*`). Run them from a clean commit (the
harnesses refuse uncommitted changes; the records carry the commit) with the audio service up,
and write outside the checkout:

```sh
node evals/agent/run.mjs --mode live --suite golden --subset all \
  --out <dir> --cassettes <dir> --db <file> --spend-log <file>          # eval:golden
node evals/agent/run.mjs --mode live --suite variance --subset ci \
  --out <dir> --cassettes <dir> --db <file> --spend-log <file>          # eval:variance, repeat 1
node evals/agent/baseline.mjs --mode live --subset all \
  --out <dir> --cassettes <dir> --spend-log <file>                      # eval:baseline, row a
node evals/agent/perturb-judge.mjs --mode live \
  --cassettes <dir> --spend-log <file> --out <file>                     # eval:perturb
node evals/agent/assemble.mjs --golden <out>/golden --variance <out>/variance \
  --baseline <out>/baseline --to evals/agent/runs/<date>
node evals/agent/spend.mjs --log <file>                                  # spend by purpose
```

Then copy the judge record to `evals/agent/runs/<date>/perturb/judge.json` with the audit of
its model positives beside it (`audit.json`), the cassettes of the CI subset to
`fixtures/cassettes/{llm,sources}/golden/<isrc>`, the baseline's to
`fixtures/cassettes/llm/baseline` and the judge's to `fixtures/cassettes/llm/perturb`, and
render the report. Each run answers the clarification step with the top-ranked candidate. A run
with source errors is kept and counted (the report gives the source-error rate); a run is
repeated only after an infrastructure failure of the harness, at most once, and the repeat is
logged. `--mode rebuild` re-derives a directory's records from the event streams the live run
kept, with no call. The baseline is never judged: its model is the judge's. `docs/failures.md`
describes the unmatched edges of the committed run.

## The perturbation set

`evals/perturb.jsonl` is generated, not written by hand:

```sh
node evals/agent/make-perturb.mjs        # rewrite it (same bytes every time)
node evals/agent/perturb-check.mjs       # numeric part through checkNumbers; the judge replayed
node evals/agent/export-labels.mjs --out labels.csv --key ~/labels-key.json
                                         # blind labelling sheet; the key kept apart
```

- **Claim cases.** Positives are code-built sourced claims (supported by construction) or model
  claims that pass the deterministic support check in `lib/support.mjs`. The judge's verdict is
  never read. The check passes a claim only when, for each of its sentences, one sentence of a
  cited excerpt holds all of it: every quoted title and name as a whole entity, every year as a
  standalone token (not inside an ISRC such as `USUM71920161`), every decade as a decade, and
  the same relation with each entity in the same role ("A samples B" and "B is sampled in A"
  agree; "B samples A" does not). The words after a verb reach only to the next verb or clause
  word (and, which, that…), a year must sit in a clause with an entity the claim gives it to,
  and a month and day, when the claim gives them, must be the excerpt's. A negated or hedged
  sentence (not, never, wrongly, supposedly, planned, going to…), or one that names nothing,
  states no year and no relation, or names nothing after its relation, is not supported. The
  check is a conservative heuristic over English sentences, not a reader: it refuses some
  supported claims. Every model claim that cites evidence was read against its excerpts before
  the judge ran on the set (`runs/<date>/perturb/audit.json`, in the report), the refused ones
  included. Each positive gets
  two mutations that its excerpts do not support (unsupported by the cited excerpts, which is
  not the same as false): another real title or artist (from a MusicBrainz excerpt or another
  recording's own title and artist), another year, the roles swapped, another relation (sample
  to cover), or a real excerpt from another recording. Every positive passes the check and
  every mutation fails it; the tests check both.
- **Numeric cases.** Each states the exact result the app's check must give (`consistent`,
  `conflict` or `contradicted`), in four categories:
  - *equivalent*: the measured value restated (exact, within the band, a range around it, a
    flat spelling of the key, the key with no mode) is consistent; an octave (x2, x1/2, x1/4,
    x4 under 400 BPM) or the relative key is a conflict, both values shown;
  - *estimator-error*: x1.5, x2/3, +3 %, the parallel key, a fifth either way: a conflict;
  - *false-caught*: a false value given as the track's own against a confident measurement
    (x1.25, x0.8; a whole tone or a tritone away; at and above each estimator's confidence
    floor): contradicted;
  - *false-shown-both*: a false value the check shows next to the measurement instead of
    rejecting, by design: the claim is not marked as giving the track's own value, or the
    measurement is below its floor (librosa 0.3, Essentia 1.5/5.32, an unknown method the
    higher; key strength 0.4) or has no confidence.
  Tempo cases use each recording's measured tempo block unchanged, except the floor cases,
  which set its confidence and method (`"synthetic": ["tempo.confidence", "tempo.method"]`). No
  committed recording has a measured key, so every key case carries a synthetic key block
  (`"synthetic": ["key"]`, `"basis": "synthetic"`) with a sharp tonic, so a flat spelling exists.
- `perturb-check.mjs` loads the app's own `checkNumbers` from
  `apps/api/src/agent/verifier/numeric.ts` with tsx (build `packages/contract` first), and
  exits 1 when any case gives another result than it expects. It prints, separately for the
  measured tempo blocks and the synthetic ones, how many equivalents and estimator errors were
  rejected (0), how many false values were rejected, and how many were shown both by design.
  It then replays the app's judge on the claim cases from `fixtures/cassettes/llm/perturb` and
  exits 1 unless every case (its verdict, whether it is shown as sourced, and each other field)
  is the committed record's, no spend line is written and the
  record was made on this perturbation set; it prints the false-positive rate (positives
  rejected) and the catch rate (mutations rejected) overall, per positive source and per
  mutation. A case is rejected when its verdict would not show it as sourced, by the app's rule.
- The CSV from `export-labels.mjs` has no verdict, label or mutation column and a shuffled
  order. Each row's `label_id` is an HMAC-SHA256 of the case id under a salt (random unless
  `--salt` is given), so ids and order cannot be recomputed from the committed set. The salt
  and the map from label ids to cases go to the `--key` file, which must not sit next to the
  CSV or anywhere in the repository (the CLI refuses both); keep it away from whoever labels.
- The generator sorts by code point, so its output is the same bytes in every locale.

## Pending

- The agreement table: no labels from people exist yet.
- A second judge from another model family: the app's Gemini provider refuses every call, so
  every verdict comes from one judge model.

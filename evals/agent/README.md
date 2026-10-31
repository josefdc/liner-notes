# Agent evals

How the agent itself is measured: whether it finds the samples gold documents, how often it
invents them, and whether the verifier catches false statements. This directory holds the
offline half: the scorer, the report and its checker, the perturbation set and its checks. None
of it makes a model call or a network request.

```
evals/agent/
  eval.mjs            npm run eval -- --suite agent --mode replay|live --subset ci|all
  report.mjs          npm run eval:table -- --runs <dir>: the report from run records
  check-report.mjs    renders a report again from its run records and checks it
  make-perturb.mjs    writes evals/perturb.jsonl from fixtures/replays at a fixed seed
  perturb-check.mjs   runs evals/perturb.jsonl through the app's numeric check
  export-labels.mjs   CSV of claims to label blind, without verdicts; its key apart
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
node evals/agent/report.mjs --runs <dir> --out evals/reports
                                                        # agent-<date>.md, agent-<date>.json, agent-latest.md
node evals/agent/check-report.mjs evals/reports/agent-latest.md
```

The report states the dataset and the golden file's sha256, the run records it was rendered
from, the date, the commit, n and a 95 % interval for every value, the clarification rate,
ablation rows a-d, and held-out n after the exclusion. Gold is described by its sources and
their retrieval dates; no label is described as made by people, because none was. A report
rendered from records marked `"synthetic": true` says so at the top.

`check-report.mjs` exits 1 and names each problem. It renders the report again from the run
records and golden file its header names (with its date, commit and subset) and requires the
Markdown and the results file (`agent-<date>.json`) to match byte for byte; the held-out
exclusion is re-derived from the runs' evidence, never read from the results file. The header
carries the sha256 of the run-record directory, so records that changed since the report are
named as such (keep each golden run's records in a directory of its own). It also checks the
structure on its own: a header with the dataset (its sha256 must still match), run records,
date, commit and results file; Markdown tables at the start of the line (no HTML, no indent)
with value, n and "95 % CI" columns; every rate's "(k/n)" against its n and its Wilson interval
recomputed; statistics with a numeric interval, low before high (marked "all resamples equal"
when it has no width); counts only below n = 10; "no data" only at n = 0; ablation rows a-d;
the clarification rate; held-out numbers that add up; no "human-labelled", "annotators" or the
like, in any case; the synthetic banner when the records are synthetic. A report under
`evals/reports` must also score `evals/golden.jsonl` with the sha256 that file had at the
report's commit, name a header commit and run commits that exist in git, and come from records
that are neither synthetic nor under a `testdata` directory (`report.mjs` refuses to write
those there). The broken reports in `testdata/` exercise each of these, and the tests show
which ones only re-rendering catches.

What `check-report.mjs` cannot tell: whether the run records came from real runs. It proves a
report is what the named records and dataset give, and refuses what only test data or a
substituted dataset would give; records edited together with their report still pass. Where
the records come from is shown by the golden run's own trail (its cassettes and spend log), not
by this check.

`npm run eval -- --suite agent --mode replay --subset ci|all` scores the records in
`evals/agent/runs` on the CI subset (six rows, `CI_SUBSET` in `lib/golden.mjs`) or the whole live
subset; `--runs <dir>` scores another directory. `--mode live` is refused.

## The perturbation set

`evals/perturb.jsonl` is generated, not written by hand:

```sh
node evals/agent/make-perturb.mjs        # rewrite it (same bytes every time)
node evals/agent/perturb-check.mjs       # numeric part through checkNumbers; judge part pending
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
  supported claims, and the golden run reads every model positive by hand before a report built
  on the set is published. Each positive gets
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
- The CSV from `export-labels.mjs` has no verdict, label or mutation column and a shuffled
  order. Each row's `label_id` is an HMAC-SHA256 of the case id under a salt (random unless
  `--salt` is given), so ids and order cannot be recomputed from the committed set. The salt
  and the map from label ids to cases go to the `--key` file, which must not sit next to the
  CSV or anywhere in the repository (the CLI refuses both); keep it away from whoever labels.
- The generator sorts by code point, so its output is the same bytes in every locale.

## Pending until the live golden run

- Recorded run records (`evals/agent/runs/`) and the cassettes `--mode replay` re-runs the
  pipeline from; until then replay exits 1 with "no recorded runs".
- `--mode live`, the model-only baseline (a) and the variance re-runs.
- The judge's part of `perturb-check.mjs` (a judge recording of the claim cases), and the
  verifier-as-classifier table with false-positive rates per positive source.
- The agreement table: no labels from people exist yet.
- A committed `evals/reports/agent-*.md`; only test data is committed today.

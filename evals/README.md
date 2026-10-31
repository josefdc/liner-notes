# Evals: golden track set

`golden.jsonl` is the reference set the app is measured against: real
recordings, each with labels that say where they came from. It is small on
purpose. Every value in it can be traced to a lookup or a page, and a label
that could not be sourced is left `null`.

```
evals/
  golden.jsonl                  one JSON object per line (the set)
  perturb.jsonl                 the verifier's perturbation set, generated from the
                                recorded runs (agent/make-perturb.mjs)
  agent/                        agent evals: scorer, report and its checker, perturbation
                                checks (Node; no network, no model); see agent/README.md
  scripts/summary.mjs           prints the counts that describe the set
  scripts/coverage.mjs          Deezer preview coverage check (Node >= 20, no dependencies)
  scripts/coverage.test.mjs     tests for the coverage matcher and input checks
  reports/                      dated reports: preview coverage, audio accuracy
  audio/                        audio accuracy harness (Python, uv): tempo and key
                                on annotated datasets, the estimator bake-off, and
                                agreement and style hit@k on this set's Deezer
                                previews; see audio/README.md
```

Counts (rows, strata sizes, live subset, edges, held-out domains) change as
the set changes, so they are not repeated here: run
`node evals/scripts/summary.mjs`.

## Row schema

```jsonc
{
  "isrc": "GBDUW0000053",          // required, unique, ^[A-Z]{2}[A-Z0-9]{3}\d{7}$
  "mbid": "60fa767a-…",            // MusicBrainz recording the row means
  "spotifyId": null,               // Spotify track id, or null (see below)
  "deezerId": 3135553,             // Deezer track the audio eval uses (carries this ISRC)
  "title": "One More Time",
  "artist": "Daft Punk",
  "stratum": "documented-samples", // one of the five strata below
  "liveSubset": true,              // part of the live end-to-end subset (see below)
  "labels": {
    "bpm": null,                   // number or null
    "bpmLabelSource": null,        // { sourceUrl, kind, retrieved } when bpm is set, else null
    "key": null,                   // e.g. "C# minor", "Db major", or null
    "keyLabelSource": null,        // { sourceUrl, kind, retrieved } when key is set, else null
    "edges": [
      {
        "target": { "isrc": "FR10F1200080", "mbid": "cd6c8d5c-…", "title": "More Spell on You", "artist": "Eddie Johns" },
        "relation": "sample",      // "sample" | "interpolation" | "cover"
        "relationAlternatives": [],// other relations the sources also support, e.g. ["interpolation"]
        "sourceUrl": "https://en.wikipedia.org/wiki/One_More_Time_(Daft_Punk_song)",
        "revisionUrl": "https://en.wikipedia.org/w/index.php?title=…&oldid=…", // Wikipedia sources only
        "sourceQueriedByPipeline": false,
        "retrieved": "2026-10-16"  // UTC date the source was read
      }
    ],
    "edgesExhaustive": true,       // gold lists every forward relation the cited sources state
    "otherDocumentedTargets": [],  // relations the sources state that gold does not score
    "noSample": false,             // true only for checked no-sample controls
    "noSampleSources": []          // controls: [{ sourceUrl, kind, retrieved, revisionUrl? }]
  },
  "notes": "free text: why this ISRC, caveats, how a control was checked"
}
```

Field rules:

- **mbid** is the MusicBrainz recording the row means. **Identity is scored at
  recording level**: the row's ISRC is one of several codes for that
  recording (album, single, compilation and reissue registrations), and an
  answer that resolves to the same MusicBrainz recording through another of
  its codes is correct. MusicBrainz sometimes attaches one ISRC to several
  recordings (a radio edit, a live take, a duplicate); `notes` names those
  and `mbid` says which one is meant.
- **isrc** comes from a lookup that was actually run, never from memory. For
  each row, every ISRC on the row's MusicBrainz recording(s) was resolved on
  Deezer, and the code with the **earliest year** that resolves to the same
  studio recording (not live, instrumental, remix, edit, or an edited "clean"
  version) was chosen. Ties within a year go to the entry on the original
  album, then to a playable entry. A code is kept even if its Deezer entry is
  not playable; the coverage report shows that. When no MusicBrainz recording
  carries a usable code, the ISRC from the Deezer search is kept. `notes`
  says which case applies and why.
- **deezerId** is a playable Deezer entry that carries the row's ISRC when one
  was found (Deezer search followed by `GET /track/<id>`), otherwise the entry
  `GET /track/isrc:<ISRC>` returns. Deezer often has several entries for one
  ISRC (album, single, compilations) and the ISRC endpoint returns only one of
  them, sometimes an unplayable one or a different take (for "Stronger" it
  returns an unreadable instrumental). **The audio eval uses the row's
  `deezerId` entry.** The gap between the two is a known Deezer issue that the
  app's resolver must handle (fall back from the ISRC endpoint to search or a
  known id); the coverage report measures both.
- **spotifyId** is set only when it could be obtained without credentials: the
  ISRC maps to exactly one MusicBrainz recording and that recording links to
  exactly one Spotify track. Otherwise it is `null`.
- **edges** point from the row to the material it uses. `relation` is `sample`
  (part of a recording reused), `interpolation` (melody or lyrics re-performed)
  or `cover` (a new recording of the whole song). When sources disagree, or
  one source supports two readings, the edge keeps the relation its own
  source states and lists the others in `relationAlternatives`; a scorer
  should accept any of them. `target` is as precise as the source allows: an
  `isrc` (looked up the same way as row ISRCs) and/or an `mbid` (the
  MusicBrainz recording the source names), and always `title` + `artist`.
- **Borrowings described without a named type.** Some sources describe a
  borrowing without calling it a sample, interpolation or cover ("took
  elements from", "incorporates elements of"). When the description clearly
  fits one type, the edge uses it and `notes` quotes the source; "Creep" is
  recorded as an interpolation of "The Air That I Breathe" because the source
  describes shared chord progression and melody, with co-writing credit, and
  no reused recording. When no type fits, the borrowing goes into
  `otherDocumentedTargets` with `relation: null`.
- **Several edges with the same target** are one gold relation backed by
  several sources (for example Wikipedia, a newspaper and MusicBrainz). Score
  per distinct target, not per edge; the extra edges record every source that
  documents the target (see "Held-out gold" for what they mean there).
- **edgesExhaustive / otherDocumentedTargets.** Gold edges are not always
  every relation the sources mention. `otherDocumentedTargets` lists
  relations the cited sources state that gold deliberately does not score
  (secondary samples, indirect samples, contested findings, borrowings with
  no type or no identifiable recording), each as `{ target, relation,
  sourceUrl, revisionUrl?, retrieved }`, with the reason in `notes`.
  `edgesExhaustive` is `true` only where the cited sources were checked and
  gold lists every forward relation they state; it is always `true` for
  no-sample controls and `false` for rows whose sources were not checked for
  this purpose.
- **key** is written as tonic plus mode, with `#` and `b` as accidentals.
- **noSample** is `true` only in the no-sample-controls stratum, after the
  check listed in `noSampleSources`. `false` means "no claim either way", not
  "known to contain samples".

## Scoring edges

- Recall: a gold target counts as found when a proposed edge points to the
  same recording (by ISRC or MusicBrainz id) or to the same title and artist,
  with the gold relation or one of its `relationAlternatives`.
- Precision: a gold target gives **one** true positive, however many proposed
  edges name it (another spelling, a remaster title, an ISRC match); the
  others are duplicates, left out. When the code and the model both propose
  it, the code's edge is the one credited, so model precision covers only the
  edges the code did not also build. A gold target proposed with a relation
  gold does not accept is a false positive ("right target, wrong relation"),
  and so is the track proposed as its own sample. A proposed edge that matches
  an `otherDocumentedTargets` entry is **neither a true nor a false
  positive**; it is left out of precision. On rows with `edgesExhaustive:
  true`, every other proposed edge is a false positive. On rows with
  `edgesExhaustive: false`, the sources may know relations gold does not list,
  so a proposal is left out only when one sentence of the run's evidence states
  that the row's track uses it by that relation, naming its title and artist;
  any other is a false positive.
- On no-sample controls any proposed sample, interpolation or cover is a
  hallucinated relation.
- The pre-verifier support rate is the share of the model's claims, before the
  verifier runs, that the judge marks supported; a claim the judge did not
  reach counts as not supported. It is a rate of the judge's verdicts, not of
  truth.

## Strata

| stratum | what it is for |
|---|---|
| `documented-samples` | tracks whose samples or interpolations are well documented; the main test of edge recall and precision |
| `no-sample-controls` | original compositions with no known samples or interpolations; any edge the app reports here is a hallucination |
| `ambiguous-titles` | titles shared by several well-known songs ("Hurt", "Creep", "Crazy", "Angel"…); tests that the app resolves the right recording |
| `non-english` | titles that are not in English (Japanese, Korean, Spanish, French, German); tests search and metadata outside English |
| `obscure` | small-audience but real and documented releases, several of them sample sources for the first stratum |

A no-sample control is checked against two sources, both listed in
`noSampleSources`: its MusicBrainz recording has no forward "samples material"
relationship, and its English Wikipedia article (the revision linked) describes
no sample or interpolation of another recording. WhoSampled could not be
consulted for this version of the set because it refuses automated requests.

## Live subset

Rows with `"liveSubset": true` are the ones the live end-to-end eval runs
through the real pipeline with real network calls. The subset contains every
documented-samples row, at least five no-sample controls, and rows from the
ambiguous-title, non-English and obscure strata; every row with a held-out
edge is in it. Rows outside the subset are not run by the live eval: they are
covered by the preview coverage check below and by the schema checks run on
this file, and can be run live on demand. Ambiguous-title rows outside the
subset keep only MusicBrainz edges as gold; their Wikipedia or press
statements are listed in `otherDocumentedTargets`.

Live rows per metric in this version (`node evals/scripts/summary.mjs`
prints the current values):

| metric | live rows it uses | n |
|---|---|---:|
| edge recall | live rows with at least one gold edge | 15 |
| edge precision | all live rows (controls included) | 24 |
| held-out recall | live rows with a target no queried source documents (see "Held-out gold") | 1 |
| hallucinated-sample rate | live no-sample controls | 5 |
| identity accuracy | all live rows | 24 |

Changing the subset needs a recorded reason, like any other change to the set.

## What counts as a source

Every non-null label carries a source:

- An edge's `sourceUrl` is a page that was fetched and that states the
  relation; `retrieved` is the UTC date it was read.
  - MusicBrainz: the web-service URL of the recording
    (`/ws/2/recording/<mbid>?inc=recording-rels…`), because the HTML page sits
    behind a browser check. Covers are recorded by MusicBrainz as a
    performance of the work, so those targets carry no recording id.
  - Wikipedia: the article URL plus `revisionUrl`, the permanent link to the
    revision that was read.
  - Other pages (newspapers, magazines, broadcasters): the page URL.
- `bpmLabelSource` / `keyLabelSource` say honestly what kind of source it is,
  in `kind`, and when it was read, in `retrieved`. Kinds used so far:
  - *published sheet music (Musicnotes listing)*: the "original published
    key" and the metronome marking on the publisher's product page.
  - *Wikipedia article citing published sheet music*: used where the sheet
    music itself could not be fetched; the kind names what the article cites.
- **Sheet-music tempos are nominal.** A metronome marking is written on the
  score, not measured from the recording; it can differ from the recording by
  a few BPM, be written at half or double time, and a song can change tempo
  ("bad guy" moves from about 135 to about 120). Use these labels with a
  tolerance and octave-equivalence; they are not suitable for strict
  Acc1-style scoring (within 4% of the exact tempo).
- Algorithmic estimates (Deezer's `bpm` field, key-finder sites, Spotify audio
  features) are not used as labels. If one ever is, its `kind` must say
  "algorithmic estimate (site)".
- When sources disagree, the label is `null` and `notes` records the
  disagreement (for example the key of "Hung Up").

Labels are described by their source. A label is called "human-labelled" only
if a person actually listened and labelled it; none in this version are.

## Held-out gold

Some edges come from material the pipeline does not read, so the app cannot
score well on them by echoing a database it already queries.

`sourceQueriedByPipeline` means "the source is one the pipeline queries or is
planned to query":

- queried today: MusicBrainz, ListenBrainz, Last.fm, the Genius API, Spotify,
  Deezer, pages returned by Tavily web search, and WhoSampled (the
  pipeline's sample search asks the web search for WhoSampled pages);
- planned (they arrive with a later issue): Discogs and SecondHandSongs.

Edges from those sources are `true`. Everything else is `false`, i.e.
held-out: Wikipedia articles, newspapers and magazines, broadcasters,
interviews, label press releases, liner notes.

A gold **target** is held-out only when none of its sources is one the
pipeline queries: a target that MusicBrainz also documents can be found by
echoing MusicBrainz, which held-out gold exists to rule out. Most targets in
this version have a MusicBrainz source as well as held-out ones; in the live
subset only one target (Crazy's "Last Men Standing", documented by Wikipedia
only) is held-out, so held-out recall is reported as counts.

Held-out status is also decided **per run**. Web search can surface any
domain, so a held-out target stops counting as held-out for a given run if
that run's evidence cites the site of any of its sources (for example, a run
whose evidence includes an `en.wikipedia.org` page loses held-out credit for
every target Wikipedia documents). Sites are registrable domains
(`de.wikipedia.org` is `wikipedia.org`); an archived, cached, translated or
AMP copy counts as the page it carries, a Wikipedia mirror counts as
Wikipedia, and a cited page whose site cannot be placed (a link shortener, an
unparseable URL, a URL that carries another URL) counts as citing every
site. The flags in the file are the default; the scorer applies both rules.
`summary.mjs` lists the held-out domains.

## Changing the set

Rows may be added, replaced or relabelled later, but each change needs a
recorded reason in the commit message or pull request (new source found,
recording withdrawn from Deezer, label shown to be wrong). Keep the stratum
sizes roughly balanced, at least 10 documented-samples rows with held-out
edges, and every held-out row in the live subset.

## Preview coverage

`scripts/coverage.mjs` checks every row twice with keyless Deezer requests,
sequentially and at least 300 ms apart (10 s timeout, one retry):

- `https://api.deezer.com/track/isrc:<ISRC>`: whether the ISRC is found,
  whether title and artist match the row, whether there is a preview, the
  duration, and Deezer's own `bpm` field;
- `https://api.deezer.com/track/<deezerId>`: whether the entry the audio eval
  uses has a preview.

Title and artist must be equal after normalisation (NFKC, case, Latin
accents, punctuation, whitespace, featured-artist credits); a Deezer title
with instrumental/live/remix/karaoke/acoustic/demo/edit/version that the row
lacks counts as different, remaster notes are ignored however they are
worded, and a bracketed non-Latin title matches either part (e.g. "Gangnam
Style (강남스타일)" and "강남스타일"). Preview URLs are signed and expire, so
they are never stored or printed.

```sh
node evals/scripts/coverage.mjs --dry-run                       # lookups + table, writes nothing
node evals/scripts/coverage.mjs --report evals/reports/coverage-$(date -u +%F).md
node --test 'evals/scripts/*.test.mjs'                          # matcher and input tests, no network
```

When every lookup got an answer, the output ends with
`deezerId preview: N/M (P%)` followed by `coverage: N/M (P%)`; the last line
counts previews via the ISRC endpoint. A failed lookup (network, timeout,
non-JSON body, quota) is never counted as "no preview": the failures are
listed, both lines read `… unavailable (K lookups failed)`, no report is
written and the script exits 1. It also exits 1 on an invalid golden file
(bad JSON, missing or duplicate ISRC, unknown stratum), bad arguments, or
repeated quota errors (it stops after three in a row); otherwise it exits 0
whatever the coverage. The report records the generation date, the golden
file's path and sha256, and that preview availability depends on the country
of the requesting IP address.

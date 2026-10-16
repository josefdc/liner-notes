# Evals: golden track set

`golden.jsonl` is the reference set the app is measured against: 45 real
recordings, each with labels that say where they came from. It is small on
purpose. Every value in it can be traced to a lookup or a page, and a label
that could not be sourced is left `null`.

```
evals/
  golden.jsonl            one JSON object per line (the set)
  scripts/coverage.mjs    Deezer preview coverage check (Node >= 20, no dependencies)
  reports/                dated coverage reports produced by the script
```

## Row schema

```jsonc
{
  "isrc": "GBDUW0000053",          // required, unique, ^[A-Z]{2}[A-Z0-9]{3}\d{7}$
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
    "noSample": false,             // true only for checked no-sample controls
    "noSampleSources": []          // controls: [{ sourceUrl, kind, retrieved, revisionUrl? }]
  },
  "notes": "free text: why this ISRC, caveats, how a control was checked"
}
```

Field rules:

- **isrc** comes from a lookup that was actually run, never from memory. For
  each row, every ISRC on the row's MusicBrainz recording(s) was resolved on
  Deezer, and the code with the **earliest year** that resolves to the same
  studio recording (not live, instrumental, remix or edit) was chosen. Ties
  within a year go to the entry on the original album, then to a playable
  entry. A code is kept even if its Deezer entry is not playable; the
  coverage report shows that. When no MusicBrainz recording carries any
  usable code, the ISRC from the Deezer search is kept. `notes` says which
  case applies and why.
- **deezerId** is a playable Deezer entry that carries the row's ISRC when one
  was found (Deezer search followed by `GET /track/<id>`), otherwise the entry
  `GET /track/isrc:<ISRC>` returns. Deezer often has several entries for one
  ISRC (album, single, compilations) and the ISRC endpoint returns only one of
  them, sometimes an unplayable one. **The audio eval uses the row's
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
- **Several edges with the same target** are one gold relation backed by
  several sources (for example Wikipedia, a newspaper and MusicBrainz). Score
  per distinct target, not per edge; the extra edges exist so that held-out
  credit survives when one source domain is excluded (see below).
- **key** is written as tonic plus mode, with `#` and `b` as accidentals.
- **noSample** is `true` only in the no-sample-controls stratum, after the
  check listed in `noSampleSources`. `false` means "no claim either way", not
  "known to contain samples".

## Strata

| stratum | rows | what it is for |
|---|---:|---|
| `documented-samples` | 13 | tracks whose samples or interpolations are well documented; the main test of edge recall and precision |
| `no-sample-controls` | 8 | original compositions with no known samples or interpolations; any edge the app reports here is a false positive |
| `ambiguous-titles` | 8 | titles shared by several well-known songs ("Hurt", "Creep", "Crazy", "Angel"…); tests that the app resolves the right recording |
| `non-english` | 8 | titles that are not in English (Japanese, Korean, Spanish, French, German); tests search and metadata outside English |
| `obscure` | 8 | small-audience but real and documented releases, several of them sample sources for the first stratum |

A no-sample control is checked against two sources, both listed in
`noSampleSources`: its MusicBrainz recording has no forward "samples material"
relationship, and its English Wikipedia article (the revision linked) describes
no sample or interpolation of another recording. WhoSampled could not be
consulted for this version of the set because it refuses automated requests.

## Live subset

Rows with `"liveSubset": true` (24 of 45) are the ones the live end-to-end
eval runs through the real pipeline with real network calls; the rest are
scored offline. The subset contains every row with a held-out edge plus at
least two rows from each stratum, so every stratum is represented in live runs.
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
    key" and the metronome marking on the publisher's product page. A
    metronome marking is a nominal tempo written on the score, not a
    measurement of the recording, so compare it with a tolerance and expect
    half/double-time readings.
  - *Wikipedia article citing published sheet music*: used where the sheet
    music itself could not be fetched; the kind names what the article cites.
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
  Deezer, and pages returned by Tavily web search;
- planned (they arrive with a later issue): Discogs and SecondHandSongs.

Edges from those sources are `true`. Everything else is `false`, i.e.
held-out: Wikipedia articles, newspapers and magazines, broadcasters,
interviews, label press releases, liner notes, WhoSampled.

Held-out status is decided **per run**, not once. Web search can surface any
domain, so an edge stops counting as held-out for a given run if that run's
evidence cites the edge's source domain (for example, a run whose evidence
includes an `en.wikipedia.org` page loses held-out credit for every
Wikipedia-sourced edge it finds). The flag in the file is the default; the
scorer applies the per-run rule. To keep one cited domain from wiping out all
held-out credit, every documented-samples row has held-out edges from at least
two different domains: Wikipedia and one of ten other publications
(latimes.com, theguardian.com, loudwire.com, rollingstone.com, billboard.com,
ig.ft.com, news.bbc.co.uk, archive.seattletimes.com, npr.org, kexp.org).

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
lacks counts as different, and a bracketed non-Latin title matches either
part (e.g. "Gangnam Style (강남스타일)" and "강남스타일"). Preview URLs are
signed and expire, so they are never stored or printed.

```sh
node evals/scripts/coverage.mjs --dry-run                       # lookups + table, writes nothing
node evals/scripts/coverage.mjs --report evals/reports/coverage-$(date -u +%F).md
```

The output ends with `deezerId preview: N/M (P%)` followed by
`coverage: N/M (P%)`, where the last line counts previews via the ISRC
endpoint. Failed lookups (network, timeout, non-JSON, quota) are listed and
never counted as "no preview". The script exits 0 when every lookup got an
answer, whatever the coverage, and 1 on an invalid golden file (bad JSON,
missing or duplicate ISRC, unknown stratum), bad arguments, any failed
lookup, or repeated quota errors (it stops after three in a row). The report
records the golden file's path and sha256, the git commit, and that preview
availability depends on the country of the requesting IP address.

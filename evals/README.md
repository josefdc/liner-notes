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
  "deezerId": 3135553,             // Deezer track id the ISRC was read from
  "title": "One More Time",
  "artist": "Daft Punk",
  "stratum": "documented-samples", // one of the five strata below
  "labels": {
    "bpm": null,                   // number or null
    "bpmLabelSource": null,        // { sourceUrl, kind, retrieved } when bpm is set, else null
    "key": null,                   // e.g. "C# minor", "Db major", or null
    "keyLabelSource": null,        // { sourceUrl, kind, retrieved } when key is set, else null
    "edges": [
      {
        "target": { "isrc": "FR10F1200080", "title": "More Spell on You", "artist": "Eddie Johns" },
        "relation": "sample",      // "sample" | "interpolation" | "cover"
        "sourceUrl": "https://en.wikipedia.org/wiki/One_More_Time_(Daft_Punk_song)",
        "sourceQueriedByPipeline": false
      }
    ],
    "noSample": false              // true only for checked no-sample controls
  },
  "notes": "free text: release choice, caveats, how a control was checked"
}
```

Field rules:

- **isrc** was read from a lookup that was actually run (Deezer search followed
  by `GET /track/<id>`, cross-checked against MusicBrainz where it had the
  recording). ISRCs are never typed from memory. The original release is
  preferred; when only a remaster, reissue or compilation registration
  resolved, `notes` says so.
- **deezerId** is the track the ISRC was read from. Deezer often has several
  tracks with the same ISRC (album, compilation, reissue), and
  `/track/isrc:<ISRC>` may return a different one; the coverage report shows
  when that happens.
- **spotifyId** is set only when it could be obtained without credentials: the
  ISRC maps to exactly one MusicBrainz recording and that recording links to
  exactly one Spotify track. Otherwise it is `null`.
- **edges** point from the row to the material it uses. `target` is as precise
  as the source allows: an `isrc` (looked up the same way as row ISRCs) or an
  `mbid` when known, and always `title` + `artist` for readability.
  `relation` is `sample` (part of a recording reused), `interpolation`
  (melody/lyrics re-performed) or `cover` (a new recording of the whole song).
- **key** is written as tonic plus mode, with `#` and `b` as accidentals.
- **noSample** is `true` only in the no-sample-controls stratum, after the
  check described in `notes`. `false` means "no claim either way", not
  "known to contain samples".

## Strata

| stratum | rows | what it is for |
|---|---:|---|
| `documented-samples` | 13 | tracks whose samples or interpolations are well documented; the main test of edge recall and precision |
| `no-sample-controls` | 8 | original compositions with no known samples or interpolations; any edge the app reports here is a false positive |
| `ambiguous-titles` | 8 | titles shared by several well-known songs ("Hurt", "Creep", "Crazy", "Angel"…); tests that the app resolves the right recording |
| `non-english` | 8 | Japanese, Spanish, Korean and French titles and artists; tests search and metadata outside English |
| `obscure` | 8 | small-audience but real and documented releases, several of them sample sources for the first stratum |

A no-sample control is checked by: no forward "samples material" relationship
on its MusicBrainz recording, and nothing in its English Wikipedia article
describing a sample or interpolation of another recording. WhoSampled could not
be consulted for this version of the set because it refuses automated requests.

## What counts as a source

Every non-null label carries a source:

- An edge's `sourceUrl` is a page that was fetched and that states the
  relation. For MusicBrainz this is the web-service URL of the recording
  (`/ws/2/recording/<mbid>?inc=recording-rels`), because the HTML page sits
  behind a browser check. For Wikipedia it is the article URL; the statement
  was read from the article's source text.
- `bpmLabelSource` / `keyLabelSource` say honestly what kind of source it is,
  in `kind`, and when it was read, in `retrieved` (UTC date). Kinds used so
  far:
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

Some edges come from material the pipeline never queries, so the app cannot
score well on them by echoing a database it already reads.

- `sourceQueriedByPipeline: true`: the source is something the pipeline
  queries: MusicBrainz, Discogs, SecondHandSongs, ListenBrainz, Last.fm, the
  Genius API, Spotify, Deezer, or Tavily web search results.
- `sourceQueriedByPipeline: false`: anything else, e.g. Wikipedia articles,
  WhoSampled pages, album liner notes, label press releases, interviews.

At least 10 tracks in `documented-samples` must have at least one held-out
edge (currently 11, plus 4 in `ambiguous-titles`).

Held-out status is decided **per run**, not once. Web search can surface any
domain, so an edge stops counting as held-out for a given run if that run's
evidence cites the gold source's domain (for example a run whose evidence
includes an `en.wikipedia.org` page loses held-out credit for every
Wikipedia-sourced edge it finds). The flag in the file is the default; the
scorer applies the per-run rule.

## Changing the set

Rows may be added, replaced or relabelled later, but each change needs a
recorded reason in the commit message or pull request (new source found,
recording withdrawn from Deezer, label shown to be wrong). Keep the stratum
sizes roughly balanced and the held-out minimum intact.

## Preview coverage

`scripts/coverage.mjs` resolves every ISRC with the keyless Deezer endpoint
`https://api.deezer.com/track/isrc:<ISRC>` (sequential, at least 300 ms apart,
10 s timeout, one retry) and records whether the track was found, whether
title and artist match the row, whether a preview is present, the duration,
and Deezer's own `bpm` field. Preview URLs are signed and expire, so they are
never stored or printed.

```sh
node evals/scripts/coverage.mjs --dry-run                       # lookups + table, writes nothing
node evals/scripts/coverage.mjs --report evals/reports/coverage-$(date -u +%F).md
```

The last line of output is `coverage: N/M (P%)`, where N is the number of rows
with a non-empty preview. The script exits 0 whatever the coverage and 1 only
on its own errors (unreadable golden file, bad arguments, every request
failing). Preview availability depends on the country of the requesting IP, so
a report is one observation from one place.

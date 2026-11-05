# Known limitations

Each is a known behaviour, not a planned fix. [`docs/failures.md`](failures.md) shows the
ones marked "case" from a committed replay or run record.

**What a page shows**

- **A fact can be stated twice** (case). The reader that drops a model claim restating a record
  recognises a fixed set of phrasings; a claim worded "MusicBrainz lists X as a recording
  sampled in Y", or "draws on X", is kept beside the record's own claim. In the showcase this is
  One More Time's sample card, and its album; Gangsta's Paradise is left out of the showcase for
  this reason.
- **Tempo octave errors** (case). The analyzer can report double the felt tempo: Bitter Sweet
  Symphony is measured at 171.15 BPM, while the song is usually given as about 86 BPM. The value
  is shown as measured, because it is the analyzer's output; from 150 BPM up, the Dashboard adds
  that it may be double the felt tempo, and what half is.
- **A verifier reason can misstate its excerpt** (case). On Praise You a production claim is
  shown as partly supported, and the judge's reason says the excerpt does not name "Balance &
  Rehearsal", although it does.
- **Identity can miss the original recording** (case). In the evaluation, 7 of 24 rows did not
  resolve the row's own MusicBrainz recording (identity accuracy 17/24, [50.8 %, 85.1 %], in
  [the agent table](evaluation.md#the-agent)): 3 took a later reissue (Juicy, Ice Ice Baby, I'll Be Missing
  You), 2 had the right ISRC but reached another MusicBrainz recording (U Can't Touch This, Take
  On Me), and 2 reached no MusicBrainz recording at all (Levels, Crazy). None of the 7 pages has
  a sample link built from a record.
- **Keys are rarely served.** The service withholds a key unless the clip has clear, steady
  pitch. It answered a key for 48 of 250 GiantSteps+ clips (19.2 % [14.8, 24.5], MIREX 80.8 %
  [69.6, 89.2] on those; [the audio table](evaluation.md#the-audio-service)) and for none of the 23
  golden-run previews it analysed ([by kind](evaluation.md#what-the-results-hold-by-kind)).
- **The flat `audioSource` field reads "unavailable" whenever no key is measured**, even beside
  a measured tempo, in the API's payload. The page reads the audio block, which says what was
  measured.
- **No Deezer preview, no clip.** A track with no Deezer preview has no clip in the Player, and
  nothing is measured for it. Spotify's preview is never used in its place.
- **Map buttons that do nothing when pressed.** On the song-relations map, the link stops, the
  analysed track's card and the timeline markers are buttons that do nothing when pressed:
  focusing one shows its details.
- **The full-size map credits no provider.** The full-size map view (`/t/<id>/map`) plays
  related tracks' clips, Spotify's among them, without a list of data providers; the Player
  credits them.

**Sources and audio**

- **SecondHandSongs needs its key** (case). Without `SHS_API_KEY` every request is refused
  (HTTP 403), and the evaluation report counts it apart from source errors.
- **A cut copy declared complete is measured.** The audio service refuses a preview whose
  transfer cannot be checked, or that ends short of its `Content-Length` or its last chunk. A
  transfer that is complete but whose content is a cut copy of the file is still measured short,
  for example when a CDN edge re-chunks a cut origin response: framing proves only the last hop
  (#290, `services/audio/README.md`).
- **A failed download reads as a failed analysis.** When the preview cannot be downloaded
  (timeout, cut transfer, size cap, unchecked length), the page shows "The audio analysis
  failed." Nothing is stored, and the next run tries again (#291).
- **A failed download's detail can hold the clip link.** For some 502 answers from the preview
  host, the API keeps the response's percent-encoded clip link in the analysis's
  `unavailableDetail`, a field of the run's state that its checkpoint keeps. The link is a
  short-lived signed CDN URL (about 15 minutes) and is never recorded in a cassette.
- **Old runs measured on Spotify's clip.** A direct run link (`/api/runs/:id`) still serves a
  run that was measured on Spotify's clip before Spotify's audio stopped being analysed, as
  recorded and labelled `preview.provider: "spotify"`, until retention removes it (30 days by
  default). `/api/runs/by-track/:id` no longer serves it as the track's run.

**Recordings and checks**

- **A link without a scheme in a source's error body is kept.** The shared scrub for recorded
  source answers masks links that start with a scheme. A link written without one (for example
  `cdnt-preview.dzcdn.net/...`) inside a source's error body is kept in that source's cassette.
  The audio step's entry masks it, and committed cassettes are checked for preview hosts before
  they land.
- **The contract check reads one step.** `npm run contract:check` compares the "Contract
  compatibility" step, its job's settings and the workflow's own settings, and refuses a
  `ci.yml` written outside the YAML subset it reads. It does not notice an earlier step in the
  same job that changes what the check reads (an `npm` shim on `PATH`, a write to
  `packages/contract/BREAKING-CHANGES`, older sources checked out first), or a change to the root
  `package.json` `contract:check` script (#288).

**Licence and distribution**

- **The source offer holds only once the repository is public.** `NOTICE` offers the source to
  network users through the footer's "Source" link; until the repository is public, the site
  stays private (`deploy/RUNBOOK.md`).
- **The published images do not carry `LICENSE` or `NOTICE`.** The audio image's build context
  is `services/audio`, and the web and API images allowlist their files.
- **Bundled library licences are as stated upstream.** TensorFlow and the libraries linked into
  Essentia carry no licence text in the wheel; their licences in `NOTICE` are as their projects
  state them, some versions are not stated in the binary, and the lists may not be complete.

# Changelog

All notable changes to Liner Notes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The relaunch of the prototype as Liner Notes, to be released as v0.1.0. Given a song, the app
traces its samples, credits, history and sound, and marks each value as measured, sourced or
inferred, or as missing with its reason.

### Honest data

- Removed made-up audio values, placeholders and lyric scraping; a missing value is shown as
  missing, with its reason (#46, #47).
- An honesty guard counts placeholder and prototype patterns in CI, and the counts only go down
  (#42, #109).
- Spotify is a search and metadata source only: its previews are never analysed.

### Agent and API

- npm workspaces for the web app, the API, the audio service and a shared contract package;
  Express 5, LangGraph 1.5 and Node 24 (#40, #55, #271).
- A shared zod contract for the analysis payload, audio features, evidence, claims and server
  events, with an additive-only compatibility check in CI (#53, #64, #289).
- Typed server-sent events with run ids, sequence numbers and time since the run started
  (#69, #185); one run per thread, with resume, abort on disconnect and heartbeats (#50).
- An identity chain from the track's ISRC to its MusicBrainz recording, with primary records
  from MusicBrainz, Discogs, SecondHandSongs, Genius, ListenBrainz and Last.fm (#57, #72, #98).
- An evidence pack stored with each run, and sourced claims and song-family links built from
  primary records in code (#87, #148, #170).
- A verifier checks every claim against its evidence, scope and the measured values, with a
  judge, before a result is final (#144, #188, #191).
- A model provider layer with a shared budget guard; live analysis pauses when the budget is
  spent (#63, #65, #78).
- Completed runs are stored and served by run or by track, and expire under a retention policy
  (#48, #71, #79).
- A song-relations map dated from MusicBrainz, with a second hop, capped at 16 nodes
  (#226, #245).
- More facts by run and round, asking again only for the angles that failed (#179, #280).
- Single-use run tokens issued after a Cloudflare Turnstile check (#192).
- Structured JSON logs with run ids and redaction of secrets and preview links; readiness checks
  and a run report (#88, #90, #91, #204, #222, #233, #243, #258, #264, #287).
- Hardened HTTP layer and source clients: validation, CORS allowlist, rate limits, timeouts
  (#51, #52).

### Audio analysis

- Python 3.12, librosa 1.0 and pinned Essentia, with an analyzer version on every result (#54).
- The AudioFeatures v2 block: tempo and key with confidences, gating of silence and noise, a
  style fingerprint, and the reason for each withheld value (#58, #89, #122).
- Bounded preview downloads from the preview CDNs only; refusal of bodies whose length cannot be
  checked, and of MP4 (M4A) and AAC files (#45, #176, #286, #292).
- Measured key rules and their documented limits; deterministic tempo, beat grids that leave out
  silence and beatless intros, and VBR MP3 decoded to its real length (#102, #153, #160, #171,
  #197, #256, #263, #274, #277).

### Web app

- React 19, Vite 8 and Tailwind 4.3; one token file for colour, type and motion, with a contrast
  check; self-hosted Inter and IBM Plex Mono (#62, #112, #119, #123).
- Each measured value with its confidence and basis, or as missing with its reason (#101, #228).
- Where each claim comes from, its verifier status, and the claims that were rejected
  (#105, #138, #182).
- Credits, samples, covers and history as liner notes, naming every data provider (#210).
- The song-relations map as a lineage on a year axis, with selection, A/B listening, filters and
  a full-size view (#106, #231, #234, #236).
- The measured beat grid, energy and sections on the preview timeline (#190, #223).
- A shareable address per result and a footer link to the source (#165).
- Accessibility: a labelled search combobox, visible focus in forced-colors mode, one main
  landmark and axe checks on every view (#155, #265, #276, #297).

### Replays and evaluation

- Replays of recorded runs (`REPLAY_MODE`), offline and labelled as replays, with a credited
  Cover Art Archive cover (#73, #113).
- Recordings are refused when they hold secrets or text the readers leave out (#164, #254).
- A curated golden track set with Deezer preview coverage (#43).
- An audio accuracy harness for tempo and key, with reports on Ballroom and GiantSteps
  (#70, #75).
- Scored agent runs, a perturbation set for the verifier, and the recorded golden run, whose CI
  subset is replayed in CI (#283, #293, #294).
- The showcase, rebuilt from the golden run and chosen by rule (#295).

### Deployment

- One production compose file behind Caddy, with a content security policy and Cloudflare-only
  client addresses (#200).
- A two-stage audio image without ffmpeg or wget, image size budgets, and a runbook with backup
  and restore scripts (#169, #212, #267).

### Tooling and CI

- Biome, ruff, Vitest and Playwright, run in CI (#42, #44, #117).
- A release-age check for changed npm lock entries (#275).
- Visual baselines from 768 to 1680 px, rendered in a pinned Playwright container (#298).

### Licence

- Licensed under AGPL-3.0-only (`LICENSE`), with third-party notices, model weight and dataset
  licences, and the source offer for network users in `NOTICE`.

[Unreleased]: https://github.com/josefdc/liner-notes/commits/main

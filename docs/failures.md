# Failure cases

Cases where the app shows something wrong or less than it could, each with the committed
recording or run record that shows it and a command that prints it from the repository, with no
network and no model call. Run the commands from the repository root. The replays
(`fixtures/replays`) are the showcase runs the app serves; the run records
(`evals/agent/runs/2026-10-31`) are the golden run's, recorded at the commit kept by the tag
`golden-run-2026-10-31`. The `showcase.mjs` commands need `npm ci` and the contract package
built (`npm run build -w packages/contract`). Every known limitation, including those with no case here, is listed in
the [known limitations](limitations.md).

The second part of this page, "Unmatched edges in the agent eval", is written for the agent
evaluation: its report links here for each proposal the scorer did not match to gold. Its last
section, [Bitter Sweet Symphony's tempo](#a-measured-tempo-to-read-with-care-bitter-sweet-symphony-gbaaa9700049),
is also the tempo octave error case in the [known limitations](limitations.md); the showcase replay holds the same value:

```bash
node -p 'require("./fixtures/replays/the-verve-bitter-sweet-symphony.json").analysis.audio.tempo'
```

## One fact stated twice: One More Time

- **What shows**: the Player's notes state that One More Time samples "More Spell on You" by
  Eddie Johns twice: once as the code-built claim from the MusicBrainz record, and once as a
  model claim, "MusicBrainz lists Eddie Johns's "More Spell on You" as a recording sampled in
  "One More Time."", which the judge found supported. The album, Discovery, is likewise stated by
  its record and by two model claims.
- **Why**: one claim per fact (`apps/api/src/agent/restatements.ts`) leaves out a model claim
  that restates a record only when the claim matches one of a fixed set of phrasings
  (`apps/api/src/agent/relationText.ts`). "MusicBrainz lists X as a recording sampled in Y" and
  "draws on X" are not among them, so the claim is kept as one that may add information.
- **Also**: Gangsta's Paradise is left out of the showcase for the same reason: its page would
  show "Possible sample" next to the documented sample ([Evaluation, "The showcase"](evaluation.md#the-showcase)).
- **Record**: `fixtures/replays/one-more-time-daft-punk.json`, claims `5f2d565f…` (model) and
  `a2e538c5…` (code); `evals/agent/runs/2026-10-31/results/USTB10250016.json` for Gangsta's
  Paradise.

```bash
node -e 'for (const c of require("./fixtures/replays/one-more-time-daft-punk.json").analysis.claims)
  if (/More Spell on You|Discovery/.test(c.text)) console.log(c.origin, c.kind, c.verdict, "|", c.text)'
node evals/agent/showcase.mjs | grep -E "Gangsta's|One More Time"
```

## Verifier reason misstates its excerpt: Praise You

- **What shows**: the claim "The piano progression is drawn from "Balance & Rehearsal," a track
  on the JBL Sessions educational album …" is shown as partly supported, with the judge's
  reason: "The Roland excerpt names JBL Sessions and Hoyt Axton, but not "Balance &
  Rehearsal."" The cited excerpt does name it: "… including the track "Balance & Rehearsal,"
  from which those magic piano chords originate".
- **Why**: the judge is a model reading the claim and its excerpts; its verdict and its reason
  can be wrong. Here the error made the verdict weaker, not stronger. "Sourced" means
  support-checked against the cited excerpt by that judge, not checked by a person.
- **Record**: `fixtures/replays/praise-you-fatboy-slim.json`, claim `e9f81441…`, evidence
  `tavily:https://articles.roland.com/praise-you-fatboy-slim`.

```bash
node -e 'const a = require("./fixtures/replays/praise-you-fatboy-slim.json").analysis;
  const c = a.claims.find((c) => c.id.startsWith("e9f81441")); console.log(c.verdict, "|", c.verdictReason);
  const e = a.evidence.find((e) => e.id === c.evidenceIds[0]); console.log(e.excerpt.match(/[^.]*Balance[^.]*/)[0])'
```

## Identity resolves a later reissue: Juicy

- **What shows**: the golden row is "Juicy" by The Notorious B.I.G. (`USBB40000359`); the run
  analysed `USBB40706422`, the track on the 2007 "Greatest Hits", a different MusicBrainz
  recording of the same song. That recording carries none of the original's MusicBrainz
  relations, so the page has no code-built sample links.
- **How often**: identity is right on 17 of 24 rows (70.8 %, 95 % CI [50.8, 85.1],
  `evals/reports/agent-2026-10-31.md`). Of the 7 misses, 3 took a later reissue (Juicy, Ice Ice
  Baby, I'll Be Missing You), 2 had the row's ISRC but reached another MusicBrainz recording
  (U Can't Touch This, Take On Me), and 2 reached no MusicBrainz recording (Levels, Crazy). None
  of the 7 has a code-built link.
- **Why**: the track the run went on with was the reissue: the evaluation answers the
  clarification step with its top-ranked candidate, and the identity chain follows the chosen
  track's ISRC to its MusicBrainz recording.
- **Record**: `evals/agent/runs/2026-10-31/results/USBB40000359.json` and the row's entry in
  `evals/agent/runs/2026-10-31/d.json`.

```bash
node -p 'const r = require("./evals/agent/runs/2026-10-31/results/USBB40000359.json"); [r.isrc, r.album, r.releaseYear]'
node evals/agent/showcase.mjs | grep Juicy
```

## SecondHandSongs without its key

- **What shows**: no SecondHandSongs relations in any of the golden run's 24 runs. The 12 runs
  that asked SecondHandSongs were refused with HTTP 403; the other 12 did not ask it. The report
  counts SecondHandSongs unavailable on 14 of 24 (58.3 % [38.8, 75.5]; `sourceErrors` in the
  run's `d.json`): the 12 refused runs, and 2 runs that sent it no request but report it
  unavailable, as they report MusicBrainz (`FR10F1200080`, `USIR10001280`).
- **Why**: the runs had no `SHS_API_KEY`, and SecondHandSongs refused the anonymous requests.
  The report counts it apart from source errors ("Sources the runs could not read" in
  `evals/reports/agent-2026-10-31.md`).
- **Record**: `evals/agent/runs/2026-10-31/sources/*.json` (`unset` and `statuses`).

```bash
node -e 'const fs = require("fs"), d = "evals/agent/runs/2026-10-31/sources/";
  for (const f of fs.readdirSync(d)) { const s = JSON.parse(fs.readFileSync(d + f));
    if (s.statuses.secondhandsongs) console.log(f, JSON.stringify(s.statuses.secondhandsongs), s.unset.join(",")) }'
```

# Unmatched edges in the agent eval

What the agent proposed that the scorer did not match to gold, in the golden run of 2026-10-31
(`evals/agent/runs/2026-10-31`, report `evals/reports/agent-2026-10-31.md`). The runs proposed
10 such edges across rows a to d; all of them are here, grouped by what was proposed. Each entry
gives what the run proposed, what gold says, and what the run's own evidence says. Nothing here
changes a score: the report counts each of these as a false positive, as the scoring rules
(`evals/README.md`, "Scoring edges") say.

## "Last Men Standing", Crazy (Gnarls Barkley), `GBAHT0600202`

- **Rows**: a (model only) and c (before the verifier), both as a sample, from the model.
- **Proposed**: "Last Men Standing" by "Gianfranco Reverberi & Gian Piero Reverberi" (row a) and
  by "Gianfranco Reverberi and Gian Piero Reverberi" (row c).
- **Gold**: "Last Men Standing" by "Gian Piero Reverberi & Gian Franco Reverberi", a sample
  (interpolation accepted), from Wikipedia.
- **Evidence**: two WhoSampled excerpts, through Tavily, name the target as "Last Men Standing"
  by "Gianfranco Reverberi and Gian Piero Reverberi". The run's Wikipedia excerpt, also through
  Tavily, names it with gold's spelling, "Last Men Standing" by "Gian Piero Reverberi and Gian
  Franco Reverberi".
- **Account**: the title matches. The model's artist credit is WhoSampled's, which differs from
  gold's in spelling ("Gianfranco" and "Gian Franco") and in order, and the scorer matches an
  artist by its normalised text, so the proposal is not joined to the gold target. Row d does
  not count it (it is shown as a possible relation, labelled model inference): the verifier did
  not source the model's link. This is the only held-out
  gold target of the run: row a counts it as missed (0 of 1), and rows b to d leave it out,
  because those runs cite wikipedia.org, the site of its source.

## "Stop and Check Yourself", Crazy (Gnarls Barkley), `GBAHT0600202`

- **Rows**: c and d, as a sample, from the model; row d shows it as sourced.
- **Gold**: one edge, "Last Men Standing"; `edgesExhaustive` is true, so any other proposal
  is a false positive.
- **Evidence**: two WhoSampled excerpts, through Tavily, say "Crazy" contains a sample of "Stop
  and Check Yourself" by Garnet Mimms; the judge found the claim behind the link supported.
- **Account**: the edge is stated by the run's evidence and not listed by gold's source. Gold
  is not edited after a run, so the edge stays a false positive here.

## "Hurt (the song)", Hurt (Johnny Cash), `USDJ20200650`

- **Rows**: b, c and d, as a cover, built by code from MusicBrainz.
- **Proposed**: the MusicBrainz work `ca56bd56-0e88-35f3-aec2-12eb8e9c739e`, which the app
  labels "Hurt (the song)" and gives no artist, since a work has no performer.
- **Gold**: "Hurt" by Nine Inch Nails, a cover, from Wikipedia and MusicBrainz.
- **Evidence**: MusicBrainz: "Hurt" by Johnny Cash is a cover of "Hurt" (the work).
- **Account**: MusicBrainz records the cover as a performance of the work, not of the Nine Inch
  Nails recording, so the code-built link points at the work. Its label and empty artist do not
  match the gold target's title and artist. The same run's model link, "Hurt" by Nine Inch
  Nails, is matched and counted as the true positive in rows c and d.

## "Rappin' Duke", Juicy (The Notorious B.I.G.), `USBB40000359`

- **Rows**: c, as a sample, from the model.
- **Proposed**: "Rappin' Duke" by "Rappin' Duke".
- **Gold**: "Rappin' Duke (vocal)" by "The Rappin' Duke", from MusicBrainz.
- **Account**: the scorer drops a leading article from an artist, so the artists match; the
  titles differ by the "(vocal)" suffix MusicBrainz gives the recording, and the proposal is
  not joined to the gold target. Row d does not count it (it is shown as a possible relation,
  labelled model inference).

## "My Name Is" and "Thunder - Thunder Clap and Rumble, Weather 01", Stan (Eminem feat. Dido), `USIR10001280`

- **Rows**: c, both as samples, from the model.
- **Gold**: one edge, "Thank You" by Dido; `edgesExhaustive` is true.
- **Evidence**: in this run MusicBrainz was unavailable (the record's source errors list
  `musicbrainz: unavailable`, and with it genius and secondhandsongs), so the run had no
  MusicBrainz relations. WhoSampled, through Tavily, says "Stan" contains samples of "Thank
  You" by Dido, "My Name Is" by Eminem and "Thunder - Thunder Clap and Rumble, Weather 01" by
  Sound Ideas.
- **Account**: both proposals repeat that excerpt; neither is in gold's sources. Row d counts
  neither (each is shown as a possible relation, labelled model inference).

## A measured tempo to read with care: Bitter Sweet Symphony, `GBAAA9700049`

Not an edge, but a value of the same runs. The audio service measured the preview at 171.15 BPM
(`essentia.RhythmExtractor2013+beat-regression`, confidence 0.617, raw 3.284 of 5.32), and the
app shows it as measured, as it was. The song is commonly described at about 86 BPM, half of
that, so the measurement may be the analyzer counting twice per beat (an octave error). Nothing
here corrects it: a measured value is never replaced by a described one.

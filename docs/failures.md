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

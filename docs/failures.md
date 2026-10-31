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
- **Evidence**: WhoSampled, through Tavily, names the target as "Last Men Standing" by
  "Gianfranco Reverberi and Gian Piero Reverberi".
- **Account**: the title matches. The artist credit differs in spelling ("Gianfranco" and
  "Gian Franco") and in order, and the scorer matches an artist by its normalised text, so the
  proposal is not joined to the gold target. Row d does not show this edge: the verifier did
  not source the model's link.

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
  not joined to the gold target. Row d does not show this edge.

## "My Name Is" and "Thunder - Thunder Clap and Rumble, Weather 01", Stan (Eminem feat. Dido), `USIR10001280`

- **Rows**: c, both as samples, from the model.
- **Gold**: one edge, "Thank You" by Dido; `edgesExhaustive` is true.
- **Evidence**: in this run the MusicBrainz request failed ("fetch failed"), so the run had no
  MusicBrainz relations. WhoSampled, through Tavily, says "Stan" contains samples of "Thank
  You" by Dido, "My Name Is" by Eminem and "Thunder - Thunder Clap and Rumble, Weather 01" by
  Sound Ideas.
- **Account**: both proposals repeat that excerpt; neither is in gold's sources. Row d shows
  neither edge.

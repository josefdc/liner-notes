# Design notes

How Liner Notes decides what it may show about a song, and how it labels each value. The
[README](../README.md) describes the app and its evaluation; this page is the reasoning behind
it.

## The evidence model

Every value on a page is one of four kinds, and the page says which, in words and with an icon
as well as a colour (`apps/web/src/components/provenance/ProvenanceChip.tsx`):

| kind | what it means | where it comes from |
| --- | --- | --- |
| **measured** | computed from the audio of the track's 30 s Deezer preview | the audio service (`services/audio`), as the contract's `AudioFeatures` v2 block |
| **sourced** | stated by a record or an excerpt the result cites | a claim built by code from a primary record, or a model claim the verifier found supported by the excerpt it cites |
| **inferred** | written or estimated by a model, not backed by what it cites | model claims the verifier did not source; the audio service's classifier scores (style, mood) |
| **missing** | not known, with the reason | a value the audio service withheld (`audio.withheld`, with its code), a track with no preview, a source that did not answer |

The contract (`packages/contract`) holds these rules in one place for the API and the web app:
a `Claim` carries its `kind`, `origin` (code or model), the evidence it cites and the
verifier's verdict; an `Evidence` item carries its source, tier, scope, record reference and
the time it was retrieved; each audio value carries its `basis` (`signal` for DSP, `model` for a
classifier score). A missing value is `null` with its reason, never a placeholder: the honesty
guard (`scripts/guard-honest.mjs`) counts placeholder patterns in CI, and the counts may only go
down.

How often each kind appears over the golden run is in
[`evals/reports/agent-kinds.md`](../evals/reports/agent-kinds.md).

## Measured fields never come from the model

Tempo, key, loudness and the audio-model scores exist only in the `AudioFeatures` block, which
code writes. No schema a model fills has a field for any of them
(`packages/contract/src/llm.ts`, `MEASURED_FIELDS`; checked at every depth by
`packages/contract/src/measuredFields.test.ts`). After the composer, one step
(`apps/api/src/agent/finalize.ts`) writes the measurement into the result and derives the flat
copies the web app reads (`bpm`, `key`, `energy` …) from the block alone; whatever a draft held in
those fields is replaced.

The reason is the prototype: it showed a tempo and a key that came from model output, and a
prompt telling the model not to invent them did not stop it. A field that does not exist cannot
be filled, and a schema test can check that; a prompt rule cannot be checked. When a model's
text states a tempo or key, the verifier compares it with the measurement (below) and shows both
when they differ; it never moves the model's number into a measured field.

A measured value is shown as the analyzer gave it, even when it is likely wrong: Bitter Sweet
Symphony is measured at 171.15 BPM, about twice its usual tempo
([failure cases](failures.md#tempo-octave-error-bitter-sweet-symphony)). Correcting it from a
description would make a described value look measured.

## The verifier

The verifier (`apps/api/src/agent/verifier/index.ts`) runs after the composer on every run with a
draft, and is the only node that completes a composed run. It has three tiers:

1. **Deterministic checks**, pure code: a cited id that is not in the run's evidence is dropped;
   so is a cited item whose scope does not match the claim's (a credit of the whole release does
   not support a claim about this recording). A claim left citing nothing cannot be sourced.
2. **The numeric check** (`numeric.ts`): a model claim that states this track's tempo or key is
   compared with the measured value. It is marked consistent, in conflict (both values shown) or
   contradicted; it is never dropped.
3. **One judge call** (`judge.ts`) on the model claims that still cite evidence. The judge reads
   each claim with the excerpts it cites, and only those, and answers supported, partial,
   unsupported or contradicted, with a reason. It runs on a different deployment from the
   composer (in the golden run: judge `gpt-6-sol`, composer `gpt-6-luna`).

A model claim is then **sourced** when the judge found it supported by its excerpts (or partly
supported, for a claim that asserts no relation); otherwise it is **inferred**. A claim that
asserts a relation (a sample, a cover, a remix) is sourced only when fully supported. Code-built
claims restate a primary record and are sourced by construction; they are not judged. A
contradicted claim stays in the result and is shown in the rejected panel. Last, one claim per
fact (`restatements.ts`): a model claim that restates a code-built claim on the same record is
left out and counted.

"Sourced" therefore means **support-checked against the cited excerpt**: one model read the
excerpt and the claim together. It is not a check of the claim against the world. A wrong
excerpt supports a wrong claim, and the judge can misread an excerpt
([Praise You](failures.md#verifier-reason-misstates-its-excerpt-praise-you)). The judge's error
rates on a perturbed set are in the README ("Evaluation").

## Retrieved and proposed edges

The song-relations map draws two kinds of link:

- **retrieved** edges are built by code from a primary record that states the relation
  (`apps/api/src/agent/codeClaims.ts`), and cite that record;
- **proposed** edges come from the model. A proposed edge is drawn as a sample, cover or remix
  only when its own claim was found supported. Otherwise it is drawn as an inferred influence
  ("possible relation"), labelled model inference, with its stated type kept.

The evaluation scores both against the golden set separately (rows b, c and d of the ablation
table), because a model's proposal can be right and still not be documented by any source the
run read.

## Replays

The showcase tracks are served from recorded runs (`fixtures/replays`) when live analysis is off
or unavailable (`REPLAY_MODE`), and the page says so: "Recorded run", with the date and commit
the run was recorded at. A replay asks no model, source or audio service anything. The showcase
is chosen by a rule from the golden run (`evals/agent/showcase.mjs`), not by hand; the README's
"The showcase" section gives the rule.

## Alternatives that were rejected

- **A prompt rule for measured values.** The prototype had one and still showed model-written
  tempos and keys. Replaced by schemas without those fields (above).
- **Provider-native grounding** (a model provider's own citations of web pages). Not every
  provider has it, and its citations are not records the app can scope or check. Every source is
  a tool result the app fetched itself, as an `Evidence` item.
- **A model that fills gaps.** A missing value stays missing with its reason; no source, model
  or default is used in its place.
- **beat-this as the default tempo estimator.** On GiantSteps Tempo it gave more correct tempos
  than Essentia (Acc1 109/400 against 93/400, analyzer 2.1.0,
  [`evals/reports/audio-2026-10-25.md`](../evals/reports/audio-2026-10-25.md)), but it has no
  key estimate, would add 745.0 MB installed plus an 81.1 MB model to the audio image, took
  3.39 s per clip against Essentia's 0.29 s, and its Ballroom figures are on its own training
  data. Essentia stays the default, librosa the fallback.
- **Analysing Spotify's previews.** Spotify's terms restrict using its content for machine
  learning. Only Deezer previews are measured; Spotify supplies search, track metadata, cover
  images and the preview clips the map plays, with attribution (see [NOTICE](../NOTICE)).
- **Lyrics.** Not shown and not sent to a model: publishers' rights apply to the text, and the
  app's claims do not need it. Genius is read for song relationships only.
- **A second judge from another model family.** Not rejected but unavailable: the Gemini
  provider is not implemented and refuses every call, so every verdict comes from one judge model
  (`evals/reports/agent-2026-10-31.md`).

## Known limits

The known limitations are listed once, in the [README](../README.md#known-limitations). The
cases with a replay or a run record to show them are in [failures.md](failures.md).

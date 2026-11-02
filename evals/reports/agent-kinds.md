# What the pages show, by kind (golden run 2026-10-31)

- **Dataset**: the live subset of `evals/golden.jsonl` (24 of its 45 rows), as the golden run analysed it.
- **Run records**: `evals/agent/runs/2026-10-31/results`, 24 normalised results (row d, the result each page shows, first run); sha256 of the files in name order `b0cb20035a9cfbd314267fc1ef5f380844eba14a994c8647c5b5dcb365bd6b56`.
- **Date**: 2026-10-31
- **Commit**: `5fd193fa7a64`, the commit the run was recorded at, kept by the tag `golden-run-2026-10-31` (it is not in main's history; `evals/reports/agent-2026-10-31.md` says why).
- **Written by**: `node evals/agent/kinds.mjs`, with no network and no model call; `evals/agent/kinds.test.mjs` pins these counts to the committed records.
- **Intervals**: 95 % Wilson score intervals; a row with n < 10 would be shown as counts only. Claims and links of one track are not independent, so their intervals are narrower than they should be.

## How to read it

- **Measured**: a value the audio service measured from the track's 30 s Deezer preview. Only tempo, key and loudness are counted; the style and mood scores (classifier outputs, which the app shows as inferred) are not.
- **Sourced**: a claim or link backed by what it cites: built by code from a primary record, or written by the model and support-checked against the cited excerpt by the verifier's judge (`supported`; or `partial` for a claim that asserts no relation).
- **Inferred**: a claim or link the verifier did not source. It is shown, labelled as model inference.
- **Missing**: a value the page shows as missing, with its reason: withheld by the audio service's checks, or not measured because there was no preview.
- **never**: a kind the row cannot have. A claim or link is never measured; an audio value is never sourced or inferred.

## Counts

| what | n | measured | sourced | inferred | missing |
| --- | --- | --- | --- | --- | --- |
| Claims | 276 claims | never | 232/276 = 84.1 % [79.3, 87.9] | 44/276 = 15.9 % [12.1, 20.7] | never |
| Song-relation links | 102 links | never | 86/102 = 84.3 % [76.0, 90.1] | 16/102 = 15.7 % [9.9, 24.0] | never |
| Tempo | 24 tracks | 22/24 = 91.7 % [74.2, 97.7] | never | never | 2/24 = 8.3 % [2.3, 25.8] |
| Key | 24 tracks | 0/24 = 0.0 % [0.0, 13.8] | never | never | 24/24 = 100.0 % [86.2, 100.0] |
| Loudness | 24 tracks | 23/24 = 95.8 % [79.8, 99.3] | never | never | 1/24 = 4.2 % [0.7, 20.2] |

Sourced claims by origin: built by code from a record 164, written by the model and supported by its excerpt 68.

Why each missing audio value is missing (the audio block's `withheld` code, or the result's reason for having no block):

- Tempo: `no_preview` 1, `unsteady_tempo` 1.
- Key: `no_sustained_pitch` 19, `speech_like` 2, `few_pitch_classes` 1, `no_preview` 1, `one_harmonic_series` 1.
- Loudness: `no_preview` 1.

No key is served on this set: the key is measured on 0 of 24 tracks. On GiantSteps+ Key the service withholds the key of 202 of 250 clips (`evals/reports/audio-2026-10-29.md`), so a missing key is the usual outcome, not a fault of this run.

The chart `docs/images/agent-kinds.svg` draws the table above.

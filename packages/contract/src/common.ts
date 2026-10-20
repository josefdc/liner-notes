/**
 * Small schemas shared by the rest of the contract.
 *
 * Every schema is built with `zod/v4`, which zod 3.25 and zod 4 both provide, so the web app and
 * the API can import the contract before and after their own move to zod 4.
 */

import { z } from "zod/v4";

/** An ISO 8601 date-time in UTC, as `Date.prototype.toISOString()` writes it. */
export const Timestamp = z.iso.datetime();

/** A score from 0 to 1. Not a probability unless the field says so. */
export const UnitInterval = z.number().min(0).max(1);

/**
 * The external sources the API reads. Evidence always names one of them; no
 * value here stands for a language model, so model-written text cannot be cited as evidence.
 */
export const SourceId = z.enum([
  "spotify",
  "deezer",
  "musicbrainz",
  "discogs",
  "secondhandsongs",
  "listenbrainz",
  "lastfm",
  "genius",
  "tavily",
]);
export type SourceId = z.infer<typeof SourceId>;

/** The model behind a `basis: "model"` value: its id and the licence its weights are under. */
export const ModelRef = z.object({
  id: z.string().min(1).describe("Model id, e.g. 'discogs-effnet-bs64-1'"),
  licence: z.string().min(1).describe("Licence of the model weights, e.g. 'CC BY-NC-SA 4.0'"),
});
export type ModelRef = z.infer<typeof ModelRef>;

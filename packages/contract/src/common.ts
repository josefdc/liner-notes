/**
 * Small schemas shared by the rest of the contract.
 *
 * Every schema is built with zod 4 (`import { z } from "zod"`), the same zod the API uses, so a
 * schema from here can be extended, composed and converted to JSON Schema there.
 */

import { z } from "zod";

/**
 * An RFC 3339 date-time in UTC ending in `Z`, with optional seconds and fraction: the pattern
 * zod 3.25 gave `z.iso.datetime()`. zod 4.6 requires seconds there, which would reject values
 * the contract has always accepted ("2026-01-01T12:00Z"), so the contract keeps its pattern.
 */
const UTC_DATE_TIME =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;

/** An ISO 8601 date-time in UTC, as `Date.prototype.toISOString()` writes it. */
export const Timestamp = new z.ZodISODateTime({
  type: "string",
  format: "datetime",
  check: "string_format",
  offset: false,
  local: false,
  precision: null,
  pattern: UTC_DATE_TIME,
});

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

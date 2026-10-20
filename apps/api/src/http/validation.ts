/**
 * Shared input rules for the routes: bounded text (in code points, after trimming, without
 * control characters or unpaired surrogates) and bounded ids.
 *
 * Text a person types (a search) is refused when too long. Data the app itself produces (track
 * metadata, factoid ids chosen by the model, the list of factoids already shown) is accepted
 * and bounded instead: long metadata is truncated and only the newest ids are used.
 */

import { z } from "zod";

/** Longest accepted title, artist or query, in characters (code points). */
export const MAX_TEXT_LENGTH = 200;

/** Most factoid ids used from the list a client sends as already seen (the newest ones). */
export const MAX_EXISTING_IDS = 50;

/** Longest accepted factoid id, in code points. */
export const MAX_FACTOID_ID_LENGTH = 64;

const CONTROL_CHARACTER = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Whitespace and format characters (bidi controls, zero-width spaces): invisible on their own.
const INVISIBLE = /[\s\p{Cf}]/gu;

const codePoints = (value: string) => [...value].length;

const printable = (value: string) => !CONTROL_CHARACTER.test(value) && !LONE_SURROGATE.test(value);
const visible = (value: string) => value.replace(INVISIBLE, "") !== "";

/** The first `max` code points of `value` (never splits a surrogate pair). */
const firstCodePoints = (value: string, max: number) =>
  codePoints(value) <= max ? value : [...value].slice(0, max).join("");

/**
 * Text of `min` to MAX_TEXT_LENGTH code points after trimming. Text that is not empty must have
 * a visible character: a value of only format characters is refused, as the analyze route does.
 * With `truncate`, longer text is cut to MAX_TEXT_LENGTH code points instead of refused.
 */
export function boundedText(min: number, { truncate = false }: { truncate?: boolean } = {}) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine(printable, { message: "must not contain control characters" })
    .transform((value) => (truncate ? firstCodePoints(value, MAX_TEXT_LENGTH).trim() : value))
    .refine((value) => value === "" || visible(value), {
      message: "must contain a visible character",
    })
    .refine((value) => codePoints(value) >= min, {
      message: min === 1 ? "is required" : `must be at least ${min} characters`,
    })
    .refine((value) => codePoints(value) <= MAX_TEXT_LENGTH, {
      message: `must be at most ${MAX_TEXT_LENGTH} characters`,
    });
}

/** A Spotify or internal track id: 1-100 letters, digits, '-' or '_'. */
export const trackId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, "must be 1-100 letters, digits, '-' or '_'");

/**
 * A factoid id, as the model chose it ("f3", "prod-2", ...): 1 to MAX_FACTOID_ID_LENGTH code
 * points with a visible character and no control characters.
 */
export const factoidId = z
  .string()
  .refine((value) => printable(value) && visible(value), {
    message: "must be printable text",
  })
  .refine((value) => codePoints(value) <= MAX_FACTOID_ID_LENGTH, {
    message: `must be at most ${MAX_FACTOID_ID_LENGTH} characters`,
  });

/** The newest MAX_EXISTING_IDS ids of a list ordered oldest first. */
export const newestIds = (ids: string[]) => ids.slice(-MAX_EXISTING_IDS);

/** Field names and messages of a failed parse, for the 400 body (no values are echoed). */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "body";
    return `${field}: ${issue.message}`;
  });
}

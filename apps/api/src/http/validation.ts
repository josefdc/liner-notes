/**
 * Shared input rules for the routes: bounded text (in code points, after trimming, without
 * control characters or unpaired surrogates) and bounded ids.
 */

import { z } from "zod";

/** Longest accepted title, artist or query, in characters (code points). */
export const MAX_TEXT_LENGTH = 200;

/** Most factoid ids a client may send as already seen. */
export const MAX_EXISTING_IDS = 50;

const CONTROL_CHARACTER = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Whitespace and format characters (bidi controls, zero-width spaces): invisible on their own.
const INVISIBLE = /[\s\p{Cf}]/gu;

const codePoints = (value: string) => [...value].length;

/**
 * Text of `min` to MAX_TEXT_LENGTH code points after trimming. Text that is not empty must have
 * a visible character: a value of only format characters is refused, as the analyze route does.
 */
export function boundedText(min: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine((value) => !CONTROL_CHARACTER.test(value) && !LONE_SURROGATE.test(value), {
      message: "must not contain control characters",
    })
    .refine((value) => value === "" || value.replace(INVISIBLE, "") !== "", {
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

/** A factoid id such as "f3": 1-64 letters, digits, '-' or '_'. */
export const factoidId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, '-' or '_'");

/** Field names and messages of a failed parse, for the 400 body (no values are echoed). */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "body";
    return `${field}: ${issue.message}`;
  });
}

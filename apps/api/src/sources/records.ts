/**
 * What the primary-record sources (MusicBrainz, Discogs, SecondHandSongs, Genius) share: the
 * identity checks a record must pass before it is used, the result type and the Evidence items
 * built from a record.
 *
 * A record is used only when it is the track: same title (without featured-artist and remaster
 * suffixes), exactly the same credited artists, and, when both sides know it, the same duration
 * within a tolerance. There is no "closest match": a record that fails a check is omitted with
 * the reason, and the source reports how many records it matched, rejected or could not find.
 */

import {
  EVIDENCE_EXCERPT_MAX,
  type Evidence,
  mapRecordKind,
  type SourceError as SourceErrorRecord,
  type SourceId,
} from "@liner-notes/contract";
import { type SourceName, SourceError } from "./http.js";
import { PaceRefused } from "./pacing.js";
import { normalizeName, withoutFeatured } from "./musicbrainz.js";
import { failureMessage, sourceErrorCode } from "./toolResult.js";

// =============================================================================
// The track
// =============================================================================

/** The track whose records are looked up, as the scout resolved it (e.g. from Spotify). */
export interface TrackRef {
  isrc: string;
  title: string;
  /** The credited artists one by one. */
  artists: string[];
  durationMs: number | null;
  /** The album the track is shown with (Spotify's), when known: its cover release is preferred. */
  album?: string | null;
}

// =============================================================================
// Identity checks
// =============================================================================

/**
 * Durations of one recording at two sources differ by rounding (MusicBrainz and Discogs keep
 * whole seconds) and by a second or two of lead-in or trailing silence. An edit or a mix of the
 * same title is usually tens of seconds apart: the five MusicBrainz recordings that share the
 * ISRC of "Ice Ice Baby" are 271.0, 268.3, 232.0, 231.8 and 226.7 s long. A relative tolerance
 * grows too loose on long tracks (2 % of ten minutes is 12 s), so the tolerance is absolute.
 */
export const DURATION_TOLERANCE_MS = 3000;

/**
 * Discogs durations are printed ones, copied from sleeves and labels in whole seconds, and are
 * often a few seconds off the audio; they get a wider tolerance.
 */
export const PRINTED_DURATION_TOLERANCE_MS = 5000;

const REMASTER = String.raw`(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|edition))?(?:\s+\d{4})?`;
/**
 * A remaster label in brackets or after " - ", with the whitespace before it. That whitespace is
 * read from the start of its run only, so a long run of it is read once: the same matches as
 * with `\s*` (bracketed) or `\s+` (dashed) in front.
 */
export const REMASTER_BRACKETED = new RegExp(
  String.raw`(?:(?<!\s)\s+)?[([]\s*${REMASTER}\s*[)\]]`,
  "gi",
);
export const REMASTER_DASHED = new RegExp(String.raw`(?<!\s)\s+-\s+${REMASTER}\s*$`, "i");

/**
 * A title without featured-artist and remaster suffixes: "Under Pressure - Remastered 2011".
 * `artists` are the credited artists, for the notes that name them ("Song (with X)").
 */
export function bareTitle(title: string, artists: readonly string[] = []): string {
  return withoutFeatured(title, artists)
    .replace(REMASTER_BRACKETED, "")
    .replace(REMASTER_DASHED, "")
    .trim();
}

/** A title for comparison: bare, lowercase, no punctuation, "&" read as "and". */
export function normalizeTitle(title: string, artists: readonly string[] = []): string {
  return normalizeName(bareTitle(title, artists));
}

export function titlesMatch(a: string, b: string, artists: readonly string[] = []): boolean {
  const left = normalizeTitle(a, artists);
  return left !== "" && left === normalizeTitle(b, artists);
}

/**
 * Discogs' disambiguation number at the end of a name ("Nirvana (2)"), with the whitespace before
 * it. The whitespace is matched from the start of its run only, so a long run of it is read once.
 */
export const DISAMBIGUATION_NUMBER = /(?<!\s)\s+\(\d+\)$/;

/**
 * An artist name for comparison. Besides `normalizeName`, Discogs' disambiguation number
 * ("Nirvana (2)") and variation mark ("*") are dropped and its inverted article ("Persuader,
 * The") put back in front.
 */
export function normalizeArtist(name: string): string {
  // Discogs marks a name variation with a trailing "*" ("Persuader, The*", "Nirvana (2)*").
  const trimmed = name.trim().replace(/\*+$/, "").trim().replace(DISAMBIGUATION_NUMBER, "");
  const inverted = trimmed.match(/^(.*),\s*(the|a|an)$/i);
  return normalizeName(inverted ? `${inverted[2]} ${inverted[1]}` : trimmed);
}

/** One credited artist at a source, with every name it may be credited under. */
export interface CreditedArtist {
  names: string[];
}

/**
 * True when the credited artists are exactly the expected ones: as many, each credit matching
 * one expected artist by any of its names, and each expected artist credited. A partial credit
 * ("Queen" for "Queen, David Bowie") or an extra one never matches.
 */
export function artistsMatch(expected: string[], credited: CreditedArtist[]): boolean {
  const wanted = [...new Set(expected.map(normalizeArtist))].filter(Boolean);
  const credits = credited
    .map((c) => [...new Set(c.names.map(normalizeArtist))].filter(Boolean))
    .filter((names) => names.length > 0);
  if (wanted.length === 0 || credits.length !== wanted.length) return false;
  return (
    credits.every((names) => names.some((n) => wanted.includes(n))) &&
    wanted.every((w) => credits.some((names) => names.includes(w)))
  );
}

/**
 * The joins between the artists of a credit. Whitespace before a join is read from the start of
 * its run only, so a long run of spaces is read once (the same splits as with `\s*` in front).
 */
export const CREDIT_SEPARATOR =
  /(?:(?<!\s)\s+)?(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;

/**
 * True when a credit written as one string ("Queen & David Bowie", "A feat. B") names exactly
 * the expected artists. A single expected artist whose name contains a separator ("Earth, Wind &
 * Fire") matches the whole string only.
 */
export function creditStringMatches(credit: string, expected: string[]): boolean {
  const whole = normalizeArtist(credit);
  if (!whole) return false;
  const wanted = [...new Set(expected.map(normalizeArtist))].filter(Boolean);
  if (wanted.length === 1 && wanted[0] === whole) return true;
  const parts = credit
    .split(CREDIT_SEPARATOR)
    .filter((p) => p.trim() !== "")
    .map((p) => ({ names: [p] }));
  return artistsMatch(expected, parts);
}

export type DurationCheck = "match" | "mismatch" | "unknown";

export function durationCheck(
  expectedMs: number | null | undefined,
  actualMs: number | null | undefined,
  toleranceMs = DURATION_TOLERANCE_MS,
): DurationCheck {
  const known = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!known(expectedMs) || !known(actualMs)) return "unknown";
  return Math.abs(expectedMs - actualMs) <= toleranceMs ? "match" : "mismatch";
}

/** "4:31" or "1:02:03" in milliseconds; null when absent or not a duration. */
export function parseClockDuration(text: string | null | undefined): number | null {
  const match = text?.trim().match(/^(?:(\d+):)?(\d{1,3}):(\d{2})$/);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  const ms = ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return ms > 0 ? ms : null;
}

/** A record as a source describes it, for the identity checks. */
export interface Candidate {
  title: string;
  /** Separate credited artists, or one credit string when the source has only that. */
  artists: CreditedArtist[] | string;
  durationMs?: number | null;
}

export type IdentityCheck =
  | { ok: true; duration: DurationCheck }
  | { ok: false; failed: "title" | "artist" | "duration"; reason: string };

/**
 * The checks every record passes before it is used: title, credited artists and, when both sides
 * know it, duration.
 */
export function checkIdentity(
  track: Pick<TrackRef, "title" | "artists" | "durationMs">,
  candidate: Candidate,
  toleranceMs = DURATION_TOLERANCE_MS,
): IdentityCheck {
  if (!titlesMatch(track.title, candidate.title, track.artists)) {
    return {
      ok: false,
      failed: "title",
      reason: `title "${candidate.title}" is not "${track.title}"`,
    };
  }
  const credited =
    typeof candidate.artists === "string"
      ? creditStringMatches(candidate.artists, track.artists)
      : artistsMatch(track.artists, candidate.artists);
  if (!credited) {
    const names =
      typeof candidate.artists === "string"
        ? candidate.artists
        : candidate.artists.map((a) => a.names[0]).join(", ");
    return {
      ok: false,
      failed: "artist",
      reason: `credited to "${names}", not "${track.artists.join(", ")}"`,
    };
  }
  const duration = durationCheck(track.durationMs, candidate.durationMs, toleranceMs);
  if (duration === "mismatch") {
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    return {
      ok: false,
      failed: "duration",
      reason: `duration ${seconds(candidate.durationMs as number)} is more than ${seconds(
        toleranceMs,
      )} from ${seconds(track.durationMs as number)}`,
    };
  }
  return { ok: true, duration };
}

// =============================================================================
// Results
// =============================================================================

/**
 * How many records a source matched, rejected (failed a check) or could not find, and how many
 * times it could not be asked at all (not configured, an error, a timeout). Only the first three
 * measure identity accuracy.
 */
export interface IdentityCounts {
  matched: number;
  rejected: number;
  missing: number;
  unavailable: number;
}

/** A record left out, and why. */
export interface Omission {
  ref: string;
  reason: string;
}

interface ResultBase {
  source: SourceId;
  identity: IdentityCounts;
  omitted: Omission[];
}

/**
 * A source's answer: records that passed the identity checks, with their Evidence, or "missing"
 * with the reason (not configured, nothing linked, nothing matched, or the source failed).
 */
export type SourceResult<T> =
  | (ResultBase & {
      status: "found";
      records: T[];
      evidence: Evidence[];
      /** Set when part of the record could not be read (e.g. a second request failed). */
      incomplete: string | null;
      /**
       * Set when records were lost because a request failed (not for a note such as "3 more
       * not listed"): the run's source error, so the result is not kept as complete.
       */
      error?: SourceErrorRecord;
    })
  | (ResultBase & {
      status: "missing";
      reason: string;
      /** Set when the source could not be read, for the run's source errors. */
      error: SourceErrorRecord | null;
      /**
       * Set only by a reader whose source answered JSON of a shape it does not know
       * (`unexpectedShape`): a retry gets the same answer until the reader changes, so the error
       * does not keep a result from being stored (it is stored and reported with it).
       */
      lasting?: true;
      /**
       * Set when a request was not sent, so the source was not asked, which is no source error:
       * "pace", our own pacing of its requests (sources/pacing.ts) left no slot in time;
       * "deadline", the run's time for the primary sources ran out before it could start. The
       * run's evidence says so, and a cached research is read again for it.
       */
      notAsked?: "pace" | "deadline";
    });

/**
 * Records that passed the checks. `identity.matched` counts matched source records (a recording,
 * a release, a song), which is not the number of relationships or credits read from them.
 */
export function found<T>(
  source: SourceId,
  records: T[],
  evidence: Evidence[],
  options: {
    omitted?: Omission[];
    matched?: number;
    incomplete?: string | null;
    error?: SourceErrorRecord | null;
  } = {},
): SourceResult<T> {
  const omitted = options.omitted ?? [];
  return {
    status: "found",
    source,
    records,
    evidence,
    omitted,
    incomplete: options.incomplete ?? null,
    ...(options.error ? { error: options.error } : {}),
    identity: {
      matched: options.matched ?? 1,
      rejected: omitted.length,
      missing: 0,
      unavailable: 0,
    },
  };
}

/**
 * Nothing to show from a source. With an `error` the source could not be asked (counted as
 * unavailable); without omissions the record was not there to check (counted as missing); with
 * them, every candidate failed a check (counted as rejected). `matched` is set when the record
 * was identified but holds nothing for the track.
 */
export function missing<T>(
  source: SourceId,
  reason: string,
  options: {
    omitted?: Omission[];
    error?: SourceErrorRecord | null;
    matched?: number;
    lasting?: boolean;
  } = {},
): SourceResult<T> {
  const omitted = options.omitted ?? [];
  const matched = options.matched ?? 0;
  const unavailable = options.error ? 1 : 0;
  return {
    status: "missing",
    source,
    reason,
    error: options.error ?? null,
    ...(options.lasting && options.error ? { lasting: true as const } : {}),
    omitted,
    identity: {
      matched,
      rejected: omitted.length,
      missing: !unavailable && omitted.length === 0 && matched === 0 ? 1 : 0,
      unavailable,
    },
  };
}

/** A source without its credential: nothing is requested. */
export function notConfigured<T>(source: SourceId, variable: string): SourceResult<T> {
  const reason = `${variable} is not set`;
  return missing(source, reason, {
    error: { source, code: "not_configured", message: reason },
  });
}

/**
 * A failure as the run's source error. A deadline is a timeout; a request the caller cancelled
 * is "unavailable", not a timeout; a bug in our own reader (a TypeError past the shape checks)
 * is "unavailable" with an internal-error message, never the source's answer.
 */
export function errorRecord(source: SourceId, error: unknown): SourceErrorRecord {
  return { source, code: sourceErrorCode(error), message: failureMessage(error) };
}

/**
 * Any failure while reading a source, as "missing" with a typed error; never a throw. Only an
 * `unexpectedShape` failure is marked lasting. A request that was not sent (PaceRefused) is
 * "missing" without an error, marked `notAsked`: the source was not asked.
 */
export function failed<T>(
  source: SourceId,
  error: unknown,
  omitted: Omission[] = [],
  matched = 0,
): SourceResult<T> {
  if (error instanceof PaceRefused) {
    const reason =
      error.why === "pace"
        ? `not asked: our own pacing of its requests left no slot in time (${error.message})`
        : "not asked: the run's time for the primary sources ran out before its request";
    const result = missing<T>(source, reason, { omitted, matched });
    return result.status === "missing" ? { ...result, notAsked: error.why } : result;
  }
  const record = errorRecord(source, error);
  return missing<T>(source, record.message ?? "", {
    omitted,
    error: record,
    matched,
    lasting: isShapeFailure(error),
  });
}

/** The errors `unexpectedShape` made; no other error is a shape failure. */
const shapeFailures = new WeakSet<object>();

const LIMIT_WORDING = /\b(?:rate|limit(?:ed)?|too many|slow down|throttl\w*|quota)\b/i;
const ERROR_WORDING =
  /\b(?:error|fail(?:ed|ure)?|unavailable|maintenance|forbidden|denied|invalid|not found|status|limit(?:ed)?|too many)\b/i;

/**
 * How a JSON answer reads as an error envelope rather than a payload of another shape: an
 * `error` or `errors` field, a numeric status of 400 or more in the body, or a `message` worded
 * as an error or a limit. Null when it reads as neither.
 */
function errorEnvelope(answer: unknown): "rate_limited" | "error" | null {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return null;
  const body = answer as Record<string, unknown>;
  const texts = [body.error, body.errors, body.message, body.detail, body.title]
    .map((v) => (typeof v === "string" ? v : v !== undefined ? JSON.stringify(v) : ""))
    .join(" ");
  const status = [body.status, body.statusCode, body.code].find(
    (v) => typeof v === "number" || (typeof v === "string" && /^\d{3}$/.test(v)),
  );
  const failing =
    body.error !== undefined ||
    body.errors !== undefined ||
    (status !== undefined && Number(status) >= 400) ||
    (typeof body.message === "string" && ERROR_WORDING.test(body.message));
  if (!failing) return null;
  return LIMIT_WORDING.test(texts) || Number(status) === 429 ? "rate_limited" : "error";
}

/**
 * A JSON payload that is not the shape the source documents, found by a primary-record reader
 * (`answer`: what it answered). An answer that reads as an error envelope ("too many requests",
 * a maintenance notice, a CDN's JSON error) is the source failing for now: `rate_limited` when it
 * says so, else unavailable; it blocks caching as any passing failure does. Any other JSON
 * object is an invalid response, the one failure marked lasting (see `failed`): a retry gets the
 * same answer until the reader changes.
 */
export function unexpectedShape(source: SourceName, what: string, answer?: unknown): SourceError {
  const envelope = errorEnvelope(answer);
  if (envelope === "rate_limited") {
    return new SourceError(source, "rate_limited", `answered an error instead of ${what}`);
  }
  if (envelope === "error") {
    return new SourceError(source, "http", `answered an error instead of ${what}`);
  }
  const error = new SourceError(source, "parse", `unexpected answer: ${what}`);
  shapeFailures.add(error);
  return error;
}

/** True for an error `unexpectedShape` made. */
export function isShapeFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && shapeFailures.has(error);
}

/** Per-source identity counts summed over results, for the run's identity accuracy report. */
export function identityAccuracy(
  results: ReadonlyArray<{ source: SourceId; identity: IdentityCounts }>,
): Partial<Record<SourceId, IdentityCounts>> {
  const totals: Partial<Record<SourceId, IdentityCounts>> = {};
  for (const { source, identity } of results) {
    const total = totals[source] ?? { matched: 0, rejected: 0, missing: 0, unavailable: 0 };
    totals[source] = total;
    total.matched += identity.matched;
    total.rejected += identity.rejected;
    total.missing += identity.missing;
    total.unavailable += identity.unavailable;
  }
  return totals;
}

// =============================================================================
// Evidence
// =============================================================================

export interface EvidenceInput {
  source: SourceId;
  /** Unique within the source: names the record and, for a relationship, both ends. */
  recordRef: string;
  /** The public page of the record. */
  url: string | null;
  title: string;
  excerpt: string;
  retrievedAt: string;
}

/**
 * What an Evidence item states a fact about, read from the first segment of its recordRef:
 * "track" the matched recording; "work" the song (a fact about the work, such as its covers, not
 * claimed for this recording); "release" a whole release the track is on. Consumers keep "work"
 * items out of claims about the recording without matching records to evidence by position.
 */
export type EvidenceScope = "track" | "work" | "release";

/** A recordRef that carries its scope: `${scope}/${ref}`. */
export const scopedRef = (scope: EvidenceScope, ref: string) => `${scope}/${ref}`;

/** The scope an Evidence item's recordRef carries, or null for one without a scope. */
export function evidenceScope(evidence: Pick<Evidence, "recordRef">): EvidenceScope | null {
  const scope = evidence.recordRef?.split("/", 1)[0];
  return scope === "track" || scope === "work" || scope === "release" ? scope : null;
}

/**
 * True for an item of the relations map (sources/identity.ts): a MusicBrainz primary record of a
 * relationship between two other recordings (the second hop), or of another recording's first
 * release date, whose recordRef has no scope (the contract's `mapRecordKind`). It is about
 * neither this recording, its song nor a release, so it supports no claim and the model is never
 * shown it; a code-built link or a node's year rests on it.
 */
export function isMapRecord(evidence: Pick<Evidence, "source" | "sourceTier" | "recordRef">) {
  return (
    evidence.source === "musicbrainz" &&
    evidence.sourceTier === "primary-record" &&
    mapRecordKind(evidence.recordRef) !== null
  );
}

/**
 * The items `primaryEvidence` built. Each source module builds its items from the payload it
 * read, so an item in this set came from a source's answer; a copy, an object parsed from text
 * or one written by hand is not in it.
 */
const builtFromPayload = new WeakSet<object>();

/**
 * An Evidence item for a primary record, frozen; the excerpt is cut to the contract's limit.
 * Called by the source modules only, with what they read from the source's payload.
 */
export function primaryEvidence(input: EvidenceInput): Evidence {
  const excerpt =
    input.excerpt.length > EVIDENCE_EXCERPT_MAX
      ? `${input.excerpt.slice(0, EVIDENCE_EXCERPT_MAX - 1)}…`
      : input.excerpt;
  const item: Evidence = Object.freeze({
    id: `${input.source}:${input.recordRef}`,
    source: input.source,
    sourceTier: "primary-record",
    url: input.url,
    title: input.title,
    retrievedAt: input.retrievedAt,
    excerpt,
    recordRef: input.recordRef,
  });
  builtFromPayload.add(item);
  return item;
}

/** True for an item `primaryEvidence` built (that very object, not a copy of it). */
export function isPrimaryRecordEvidence(item: unknown): item is Evidence {
  return typeof item === "object" && item !== null && builtFromPayload.has(item);
}

/** "Title" by Artist, for excerpts. */
export const quoted = (title: string, artist?: string | null) =>
  artist ? `"${title}" by ${artist}` : `"${title}"`;

/**
 * How a recording's own MusicBrainz item states its first release date, the page that shows it:
 * ", first released 1981-10-26" (nothing when MusicBrainz has none). A node's year is taken only
 * from a date such an item states.
 */
export const firstReleased = (date: string | null | undefined) =>
  date ? `, first released ${date}` : "";

/** True when a recording's own item states `date` as its first release date. */
export const statesFirstRelease = (item: Pick<Evidence, "excerpt">, date: string) =>
  item.excerpt.endsWith(`${firstReleased(date)}.`);

/** Relationship kinds the sources share, read from the track's side. */
export type RelationKind =
  | "samples"
  | "sampled-by"
  | "interpolates"
  | "interpolated-by"
  | "cover-of"
  | "covered-by"
  | "remix-of"
  | "remixed-by";

/** How an excerpt states a relationship: `${track} ${phrase} ${other}`. */
export const RELATION_PHRASE: Record<RelationKind, string> = {
  samples: "samples",
  "sampled-by": "is sampled in",
  interpolates: "interpolates",
  "interpolated-by": "is interpolated in",
  "cover-of": "is a cover of",
  "covered-by": "is covered by",
  "remix-of": "is a remix of",
  "remixed-by": "is remixed in",
};

/** The most records one source contributes to a run; the rest are counted, not listed. */
export const MAX_RECORDS = 25;

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

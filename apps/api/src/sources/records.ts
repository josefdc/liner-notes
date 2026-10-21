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
  type SourceError as SourceErrorRecord,
  type SourceId,
} from "@liner-notes/contract";
import { describeError, isSourceError } from "./http.js";
import { normalizeName, withoutFeatured } from "./musicbrainz.js";

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
const REMASTER_BRACKETED = new RegExp(String.raw`\s*[([]\s*${REMASTER}\s*[)\]]`, "gi");
const REMASTER_DASHED = new RegExp(String.raw`\s+-\s+${REMASTER}\s*$`, "i");

/** A title without featured-artist and remaster suffixes: "Under Pressure - Remastered 2011". */
export function bareTitle(title: string): string {
  return withoutFeatured(title).replace(REMASTER_BRACKETED, "").replace(REMASTER_DASHED, "").trim();
}

/** A title for comparison: bare, lowercase, no punctuation, "&" read as "and". */
export function normalizeTitle(title: string): string {
  return normalizeName(bareTitle(title));
}

export function titlesMatch(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  return left !== "" && left === normalizeTitle(b);
}

/**
 * An artist name for comparison. Besides `normalizeName`, Discogs' disambiguation number
 * ("Nirvana (2)") is dropped and its inverted article ("Persuader, The") put back in front.
 */
export function normalizeArtist(name: string): string {
  const trimmed = name
    .trim()
    .replace(/\s+\(\d+\)$/, "")
    .replace(/\*$/, "");
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

const CREDIT_SEPARATOR = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;

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
  if (!titlesMatch(track.title, candidate.title)) {
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

/** How many records a source matched, rejected (failed a check) or could not find. */
export interface IdentityCounts {
  matched: number;
  rejected: number;
  missing: number;
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
    })
  | (ResultBase & {
      status: "missing";
      reason: string;
      /** Set when the source could not be read, for the run's source errors. */
      error: SourceErrorRecord | null;
    });

/**
 * Records that passed the checks. `identity.matched` counts matched source records (a recording,
 * a release, a song), which is not the number of relationships or credits read from them.
 */
export function found<T>(
  source: SourceId,
  records: T[],
  evidence: Evidence[],
  options: { omitted?: Omission[]; matched?: number; incomplete?: string | null } = {},
): SourceResult<T> {
  const omitted = options.omitted ?? [];
  return {
    status: "found",
    source,
    records,
    evidence,
    omitted,
    incomplete: options.incomplete ?? null,
    identity: { matched: options.matched ?? 1, rejected: omitted.length, missing: 0 },
  };
}

/**
 * Nothing to show from a source. Without omissions the record was not there to check (counted
 * as missing); with them, every candidate failed a check (counted as rejected). `matched` is set
 * when the record was identified but holds nothing for the track.
 */
export function missing<T>(
  source: SourceId,
  reason: string,
  options: { omitted?: Omission[]; error?: SourceErrorRecord | null; matched?: number } = {},
): SourceResult<T> {
  const omitted = options.omitted ?? [];
  const matched = options.matched ?? 0;
  return {
    status: "missing",
    source,
    reason,
    error: options.error ?? null,
    omitted,
    identity: {
      matched,
      rejected: omitted.length,
      missing: omitted.length === 0 && matched === 0 ? 1 : 0,
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

/** Any failure while reading a source, as "missing" with a typed error; never a throw. */
export function failed<T>(
  source: SourceId,
  error: unknown,
  omitted: Omission[] = [],
): SourceResult<T> {
  const message = describeError(error);
  let code: SourceErrorRecord["code"] = "unavailable";
  if (isSourceError(error)) {
    if (error.kind === "timeout") code = "timeout";
    else if (error.kind === "rate_limited") code = "rate_limited";
    else if (error.kind === "parse" || error.kind === "content_type") code = "invalid_response";
    else if (error.kind === "unavailable") code = "not_configured";
  }
  return missing(source, message, { omitted, error: { source, code, message } });
}

/** Per-source identity counts summed over results, for the run's identity accuracy report. */
export function identityAccuracy(
  results: ReadonlyArray<{ source: SourceId; identity: IdentityCounts }>,
): Partial<Record<SourceId, IdentityCounts>> {
  const totals: Partial<Record<SourceId, IdentityCounts>> = {};
  for (const { source, identity } of results) {
    const total = totals[source] ?? { matched: 0, rejected: 0, missing: 0 };
    totals[source] = total;
    total.matched += identity.matched;
    total.rejected += identity.rejected;
    total.missing += identity.missing;
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

/** An Evidence item for a primary record; the excerpt is cut to the contract's limit. */
export function primaryEvidence(input: EvidenceInput): Evidence {
  const excerpt =
    input.excerpt.length > EVIDENCE_EXCERPT_MAX
      ? `${input.excerpt.slice(0, EVIDENCE_EXCERPT_MAX - 1)}…`
      : input.excerpt;
  return {
    id: `${input.source}:${input.recordRef}`,
    source: input.source,
    sourceTier: "primary-record",
    url: input.url,
    title: input.title,
    retrievedAt: input.retrievedAt,
    excerpt,
    recordRef: input.recordRef,
  };
}

/** "Title" by Artist, for excerpts. */
export const quoted = (title: string, artist?: string | null) =>
  artist ? `"${title}" by ${artist}` : `"${title}"`;

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

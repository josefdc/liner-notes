/**
 * Composed results kept in the long-term store (TRACKS_NAMESPACE), keyed by the track they are
 * about (see cacheKeys.ts).
 *
 * A result is stored without what belongs to the run that composed it: its run information, its
 * preview URLs (handed out for one run, and they expire) and how that run's search text matched
 * the track. It is served for 24 hours (a result whose claims the verifier could not check, for
 * an hour: UNCHECKED_RESULT_TTL_MS), only for the track it is about and only while the contract
 * accepts it; the run that serves it adds how its own search text matched the track.
 *
 * It is stored with the sources its run could not read without that blocking storage (a source
 * not configured, a primary-record answer of a shape its reader does not know), and the run
 * that serves it reports them again: in its source errors and a status line per source, so a
 * source that was not read is never served as one that had nothing.
 *
 * A result whose web evidence holds a page the web tier now leaves out (a social platform page,
 * a handle, profile boilerplate or a comment thread: webPageIssue), or whose source errors hold
 * text an error message no longer keeps (markup, a stack trace, a token parameter or a link:
 * reasonIssue), stored by older code, is not served: it is composed again (heldTextIssue, which
 * the run routes also apply). A result is stored with its source errors' messages as plain lines
 * (plainSourceError), so one stored now is never refused.
 */

import type { BaseStore } from "@langchain/langgraph";
import {
  type QueryMatch,
  type SourceError,
  SourceError as SourceErrorSchema,
  TrackAnalysis,
  VerifierSummary,
} from "@liner-notes/contract";
import type { z } from "zod";
import { sourceErrorLine } from "./statusText.js";
import { reasonIssue } from "../sources/http.js";
import { webPageIssue } from "../sources/search.js";
import { plainSourceError } from "../sources/toolResult.js";
import { withoutPreviewUrls } from "../store/runs.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "./cacheKeys.js";
import { oneClaimPerFact } from "./restatements.js";
import type { TrackData } from "./schema.js";
import { logger } from "../logger.js";

const log = logger("Store");

/** How long a stored result is served. */
export const STORED_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a result is served whose claims the verifier's judge could not check (the call
 * failed, ran out of time or left claims out): its claims read as not checked, which is honest,
 * and serving it spares repeat visits a second composition, while a run an hour later checks
 * them again.
 */
export const UNCHECKED_RESULT_TTL_MS = 60 * 60 * 1000;
/** How far ahead of the clock a stored result's time may be (clocks of other hosts drift). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface StoredValue {
  trackData?: unknown;
  timestamp?: unknown;
  sourceErrors?: unknown;
  /** How long it is served, when shorter than STORED_RESULT_TTL_MS. */
  ttlMs?: unknown;
  /** What the verifier did, kept when its check did not complete (the run info is not). */
  verifier?: unknown;
}

type Verifier = z.infer<typeof VerifierSummary>;

/** A stored result, with the sources its run could not read. */
export interface StoredResult {
  trackData: TrackData;
  sourceErrors: SourceError[];
  /**
   * What the verifier did, when its check did not complete (`failed`): the result is provisional
   * and the run that serves it says so. null for a checked result.
   */
  verifier: Verifier | null;
}

/** The stored source errors the contract reads; an unreadable entry is dropped. */
function storedErrors(value: unknown): SourceError[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const parsed = SourceErrorSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The result stored for a track (by its Spotify id) for the sources configured now, as the
 * contract reads it, or null: none, expired, dated in the future, refused by the contract, about
 * another track, or the store could not be read.
 */
export async function readStoredResult(
  store: BaseStore | undefined,
  trackId: string,
  now: Date,
): Promise<StoredResult | null> {
  if (!store) return null;
  try {
    const item = await store.get(TRACKS_NAMESPACE, resultCacheKey(trackId, configuredSources()));
    const value = (item?.value ?? null) as StoredValue | null;
    if (!value?.trackData || typeof value.timestamp !== "number") return null;
    const age = now.getTime() - value.timestamp;
    const ttl =
      typeof value.ttlMs === "number" && value.ttlMs > 0
        ? Math.min(value.ttlMs, STORED_RESULT_TTL_MS)
        : STORED_RESULT_TTL_MS;
    // A result dated ahead of the clock (a clock set back, a database from another host) would
    // be served past its time.
    if (age >= ttl || age < -CLOCK_SKEW_MS) return null;
    // A stored result the contract no longer accepts would be refused on every run until it
    // expires: it is composed again instead.
    const checked = TrackAnalysis.safeParse(value.trackData);
    if (!checked.success) {
      log.warn("Stored result does not fit the contract; composing again");
      return null;
    }
    if (checked.data.id !== trackId) {
      log.warn(`Stored result for ${trackId} is about another track; ignored`);
      return null;
    }
    const sourceErrors = storedErrors(value.sourceErrors);
    const issue = heldTextIssue(checked.data, sourceErrors);
    if (issue) {
      log.warn(`Stored result holds text the readers now refuse (${issue}); composing again`);
      return null;
    }
    const verifier = VerifierSummary.safeParse(value.verifier);
    return {
      trackData: checked.data as TrackData,
      sourceErrors,
      verifier: verifier.success ? verifier.data : null,
    };
  } catch (error) {
    log.warn("Stored result could not be read", { err: error });
    return null;
  }
}

/** What heldTextIssue reads of a result: its evidence and its run's source errors. */
export interface HeldText {
  evidence?: ReadonlyArray<{
    sourceTier: string;
    url?: string | null;
    title: string;
    excerpt: string;
  }> | null;
  run?: { sourceErrors?: ReadonlyArray<{ message?: string }> | null } | null;
}

/**
 * Why a stored result holds text the readers of stored evidence now refuse, or null. The reason
 * names where (e.g. "evidence[2]: a comment thread"), never the text:
 * - a web-tier evidence item the web tier no longer keeps, by what is stored of it: a social
 *   platform page, or a title or excerpt with a private @handle, profile boilerplate or a comment
 *   thread (webPageIssue);
 * - a source error's message that an error message no longer keeps (reasonIssue: markup, also
 *   entity-escaped, a stack trace, a signature or token parameter, or a link), in the result's
 *   run information or in `sourceErrors` stored beside it. Results composed now write their
 *   messages as plain lines (plainSourceError), so they never fail this.
 * Code older than these checks stored such text. Other text (model prose, claims, primary
 * records) is not the web tier's and is not checked here, as the research cache and the recorder
 * do not check it either; a claim's cited ids are not checked against the evidence. Run by the
 * stored results here and by the run routes (GET /api/runs/:id and /api/runs/by-track).
 */
export function heldTextIssue(
  result: HeldText,
  sourceErrors: ReadonlyArray<{ message?: string }> = [],
): string | null {
  for (const [i, item] of (result.evidence ?? []).entries()) {
    if (item.sourceTier !== "web") continue;
    const issue = webPageIssue({ url: item.url, title: item.title, text: item.excerpt });
    if (issue) return `evidence[${i}]: ${issue}`;
  }
  const errors: Array<[string, ReadonlyArray<{ message?: string }>]> = [
    ["run.sourceErrors", result.run?.sourceErrors ?? []],
    ["sourceErrors", sourceErrors],
  ];
  for (const [where, list] of errors) {
    for (const [i, error] of list.entries()) {
      const issue = reasonIssue(error.message ?? "");
      if (issue) return `${where}[${i}].message: ${issue}`;
    }
  }
  return null;
}

/**
 * The search match a result shows: how the run's search text matched the track, unless the user
 * chose the track themselves with a click (in the picker or on a suggestion). Then the text no
 * longer decided which song is analysed, and the result does not warn about it. A pick by the
 * picker's countdown, or by a client that does not say how it picked, keeps the match.
 */
export function shownQueryMatch(state: {
  queryMatch?: QueryMatch | null;
  pickedBy?: "click" | "countdown" | null;
}): QueryMatch | null {
  return state.pickedBy === "click" ? null : (state.queryMatch ?? null);
}

/**
 * A stored result as this run serves it: with how this run's search text matched the track, and
 * each fact stated once (restatements.ts: a result stored before that step loses the model's
 * restatements and their cards). The store keeps no run information, so the claims left out are
 * counted in the log.
 */
export function servedResult(stored: TrackData, queryMatch: QueryMatch | null): TrackData {
  const { queryMatch: _stored, ...rest } = stored;
  const { result, restated } = oneClaimPerFact(rest);
  if (restated > 0) log.info(`Stored result: left out ${restated} claim(s) that restate another`);
  return queryMatch ? { ...result, queryMatch } : result;
}

/** What is stored of a result: everything but this run's information, preview URLs and match. */
export function storableResult(trackData: TrackData): unknown {
  const { run: _run, queryMatch: _match, ...kept } = trackData;
  return withoutPreviewUrls(kept);
}

/**
 * Stores a result under its track for the sources configured now, with the sources its run
 * could not read (none of them blocked storing it), served for `ttlMs` when that is shorter than
 * STORED_RESULT_TTL_MS. A result whose verifier check did not complete (`run.verifier.failed`)
 * keeps that summary, so the copy served says it is provisional. The source errors' messages
 * are stored as plain lines (plainSourceError). Throws on a store error.
 */
export async function storeResult(
  store: BaseStore,
  trackData: TrackData,
  now: Date,
  sourceErrors: readonly SourceError[] = [],
  ttlMs?: number,
): Promise<void> {
  const verifier = trackData.run?.verifier;
  await store.put(TRACKS_NAMESPACE, resultCacheKey(trackData.id, configuredSources()), {
    trackData: storableResult(trackData),
    timestamp: now.getTime(),
    ...(sourceErrors.length > 0 ? { sourceErrors: sourceErrors.map(plainSourceError) } : {}),
    ...(ttlMs !== undefined && ttlMs < STORED_RESULT_TTL_MS ? { ttlMs } : {}),
    ...(verifier?.failed ? { verifier } : {}),
  });
}

/** The status line of a result served from the store instead of composed again. */
export const STORED_LINE = "Serving the analysis stored for this track";

/** The status line of a served result whose notes the verifier could not check. */
export const STORED_UNCHECKED_LINE =
  "Stored analysis: the notes were not checked against their sources; they are shown as model inference";

/**
 * The status lines of a served result: one per source its run could not read, so the reader
 * knows that data is missing, not empty, and one when its notes were not checked.
 */
export function storedStatus(stored: StoredResult): string[] {
  return [
    ...storedErrorStatus(stored.sourceErrors),
    ...(stored.verifier?.failed ? [STORED_UNCHECKED_LINE] : []),
  ];
}

/**
 * The status lines of the sources a served result's run could not read, so the reader knows
 * that data is missing, not empty.
 */
export function storedErrorStatus(errors: readonly SourceError[]): string[] {
  const seen = new Set<string>();
  return errors.flatMap((e) => {
    const key = `${e.source}:${e.code}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [`Stored analysis: ${sourceErrorLine(e)}`];
  });
}

/**
 * The research plan of a run. The track's identifiers decide it, not a model:
 *
 *   1. the primary sources, from the track's ISRC: the MusicBrainz identity chain (one ISRC
 *      lookup per run; the recording it identifies is passed to the researcher and the composer),
 *      then SecondHandSongs, and Discogs and Genius when they are configured;
 *   2. Last.fm, once: the track's tags, the artist's tags and the similar tracks;
 *   3. the web search for the track's sample history.
 *
 * Then at most MAX_FOLLOW_UPS steps chosen by the research planner (a model call on the
 * FOLLOW_UP_TIER), each one a step that has not run: a step runs at most once per run, and the
 * MusicBrainz name search is not offered when the ISRC identified the recording (its
 * relationships are read from it). Without an ISRC, or when it identifies no recording, the
 * research is asked by name, as before, bounded the same way.
 *
 * Research holds only what a source answered: a placeholder (a step's "no result", an empty
 * text, Last.fm's bio that is only its "Read more" link) is never kept as research or evidence.
 */

import type { ResearchAction } from "@liner-notes/contract";
import type { LlmTier } from "../../config/settings.js";

/** Steps the research planner may add after the fixed plan. */
export const MAX_FOLLOW_UPS = 2;
/** The tier of the research planner's calls. */
export const FOLLOW_UP_TIER: LlmTier = "fast";

/** A research step that already ran this run (or was read another way), and why. */
export interface RanStep {
  action: Exclude<ResearchAction, "done">;
  why: string;
}

/**
 * The steps of the fixed plan that run before the researcher's own first step: Last.fm (the
 * track's and the artist's tags, the similar tracks), and, when the ISRC identified the
 * recording, its MusicBrainz relationships. None of them is offered as a follow-up.
 */
export function fixedSteps(input: { recordingIdentified: boolean }): RanStep[] {
  return [
    { action: "search_lastfm_tags", why: "read once at the start of the research" },
    { action: "search_lastfm_similar_tracks", why: "read once at the start of the research" },
    ...(input.recordingIdentified
      ? [
          {
            action: "search_musicbrainz" as const,
            why: "read from the recording the ISRC identified, with the primary sources",
          },
        ]
      : []),
  ];
}

/** The research's own first step: the web search for the track's sample history. */
export const FIRST_STEP = "search_samples" satisfies ResearchAction;

/** Why a step that ran in the research is not offered again. */
export const RAN_IN_RESEARCH = "already ran in this research";

/** The steps not yet run, in `all`'s order; "done" is always left. */
export function followUpChoices(
  all: readonly ResearchAction[],
  ran: readonly RanStep[],
): ResearchAction[] {
  const taken = new Set<ResearchAction>(ran.map((step) => step.action));
  return all.filter((action) => action === "done" || !taken.has(action));
}

/** Each step once, the first reason kept. */
export function uniqueSteps(steps: readonly RanStep[]): RanStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => !seen.has(step.action) && seen.add(step.action));
}

// =============================================================================
// Placeholders
// =============================================================================

/** Texts that say nothing was found or is available, said as a whole. */
const NOTHING =
  /^(?:no(?:thing)?\b.{0,40}\b(?:found|available|results?|data|information)|not (?:found|available)|n\/?a|none|unknown|null|undefined|empty|-+|\.+|\[\]|\{\})[.!]?$/i;
/** A label with nothing after it: "[MusicBrainz Samples] []". */
const EMPTY_LABEL = /^\[[^\]]+\]\s*(?:\[\]|\{\}|null|undefined)?$/;
/** The link Last.fm ends a bio with; alone, the bio is empty. */
const LASTFM_READ_MORE = /\s*Read more on Last\.fm\.?\s*$/i;
/** The longest text read as a "nothing found" sentence. */
const SHORT = 80;

/**
 * True for a text that holds no answer: empty, or a placeholder ("No results found", "N/A",
 * "Web search is not available", "[MusicBrainz Samples] []").
 */
export function isPlaceholder(text: unknown): boolean {
  if (typeof text !== "string") return true;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return true;
  if (/^web search is not available\b/i.test(flat)) return true;
  if (EMPTY_LABEL.test(flat)) return true;
  return flat.length <= SHORT && NOTHING.test(flat);
}

/** A Last.fm bio without its trailing "Read more on Last.fm" link; null when nothing is left. */
export function lastfmBio(bio: unknown): string | null {
  if (typeof bio !== "string") return null;
  const text = bio.replace(LASTFM_READ_MORE, "").trim();
  return isPlaceholder(text) ? null : text;
}

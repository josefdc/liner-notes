/**
 * The research plan of a run. The track's identifiers decide it, not a model:
 *
 *   1. the primary sources, from the track's ISRC: the MusicBrainz identity chain (one ISRC
 *      lookup per run; the recording it identifies is passed to the researcher and the composer),
 *      then SecondHandSongs, and Discogs and Genius when they are configured;
 *   2. Last.fm, each request at most once: the track's tags, the artist's tags (by the artist's
 *      MusicBrainz id when the recording was identified) and the similar tracks;
 *   3. the researcher's fixed steps (`researcherSteps`), run together without a model: the web
 *      search for the track's sample history and, when the ISRC identified the recording, the
 *      production-history search and the credited artist's ListenBrainz similar artists and
 *      MusicBrainz collaborators, by its MusicBrainz id.
 *
 * Then at most MAX_FOLLOW_UPS steps chosen by the research planner (a model call on the
 * FOLLOW_UP_TIER), each one a step that has not run: every step runs at most once per run, and
 * the MusicBrainz name search is not offered when the ISRC identified the recording (its
 * relationships are read from it). Without an ISRC, or when it identifies no recording, the
 * research is asked by name, as before, bounded the same way.
 *
 * Research holds only what a source answered: a placeholder (an empty text, one of our own
 * tools' "nothing found" texts, an empty label, Last.fm's bio that is only its "Read more" link)
 * is never kept as research, and a web result that is an error page is never kept as research
 * or evidence.
 */

import type { ResearchAction } from "@liner-notes/contract";
import type { LlmTier } from "../../config/settings.js";

/** Steps the research planner may add after the fixed plan. */
export const MAX_FOLLOW_UPS = 2;
/** The tier of the research planner's calls. */
export const FOLLOW_UP_TIER: LlmTier = "fast";

type Step = Exclude<ResearchAction, "done">;

/** A research step that already ran this run (or was read another way), and why. */
export interface RanStep {
  action: Step;
  why: string;
}

/** What the historian read before the researcher starts. */
export interface HistorianOutcome {
  recordingIdentified: boolean;
  /** Last.fm requests of the start of the research that could not be read. */
  lastfmUnread: { tags: boolean; similarTracks: boolean };
}

const ASKED_AT_START = "asked once at the start of the research";
const UNREAD_AT_START = "asked at the start of the research; Last.fm could not be read";

/**
 * The steps the historian ran before the researcher: Last.fm (the track's and the artist's tags,
 * the similar tracks), and, when the ISRC identified the recording, its MusicBrainz
 * relationships. None of them is offered as a follow-up; each says how it went.
 */
export function fixedSteps(outcome: HistorianOutcome): RanStep[] {
  const lastfm = (unread: boolean) => (unread ? UNREAD_AT_START : ASKED_AT_START);
  return [
    { action: "search_lastfm_tags", why: lastfm(outcome.lastfmUnread.tags) },
    { action: "search_lastfm_similar_tracks", why: lastfm(outcome.lastfmUnread.similarTracks) },
    ...(outcome.recordingIdentified
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

/**
 * The researcher's fixed steps, run together before any follow-up: the sample-history search,
 * and, once the ISRC identified the recording (so its credited artist has a MusicBrainz id), the
 * production-history search, ListenBrainz similar artists and MusicBrainz collaborators.
 */
export function researcherSteps(input: { recordingIdentified: boolean }): Step[] {
  return input.recordingIdentified
    ? [
        FIRST_STEP,
        "search_production",
        "search_listenbrainz_similar",
        "search_artist_collaborators",
      ]
    : [FIRST_STEP];
}

/** Why a step that ran in the research is not offered again. */
export const RAN_IN_RESEARCH = "already ran in this research";
/** Why a step whose source could not be read is not offered again. */
export const UNREAD_IN_RESEARCH = "already asked in this research; its source could not be read";

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

/**
 * The "nothing" texts our own tools wrote before their results were typed (and that research
 * cached then may still hold): "Web search is not available…", "No results found for …",
 * "No production history found for …", "Error searching: …".
 */
const OWN_SENTINEL =
  /^(?:web search is not available\b|nothing found\b|no (?:results|sample history|production history|song meaning analysis|recording|lyrics|tracks?|track data|top tracks|deezer track) (?:found|available)\b|error(?::|\s+(?:searching|getting)\b))/i;
/** A label with an empty value after it: "[MusicBrainz Samples] []". */
const EMPTY_LABEL = /^\[[^\]]+\]\s*(?:\[\]|\{\}|null|undefined)$/;
/** The link Last.fm ends a bio with; alone, the bio is empty. */
const LASTFM_READ_MORE = /\s*Read more on Last\.fm\.?\s*$/i;

/**
 * True for a text that holds no answer: empty, one of our own tools' "nothing" texts, or an
 * empty label. Any other text is a source's answer, however short.
 */
export function isPlaceholder(text: unknown): boolean {
  if (typeof text !== "string") return true;
  const flat = text.replace(/\s+/g, " ").trim();
  return !flat || OWN_SENTINEL.test(flat) || EMPTY_LABEL.test(flat);
}

/** An HTTP error status as a page titles it: "404 Not Found", "Error 503: Service Unavailable". */
const HTTP_STATUS =
  /^(?:error\s*)?[45]\d\d\b[\s:–-]*(?:error|not found|forbidden|unauthori[sz]ed|gone|bad gateway|service unavailable|internal server error|gateway time-?out|page)/i;
/** What an error page, a bot wall or an empty search page says of itself. */
const ERROR_PAGE =
  /^(?:page not found|not found|access denied|just a moment|attention required|no results found)\b|\b(?:page not found|404 not found|403 forbidden|internal server error|bad gateway|service unavailable|please enable javascript|enable javascript and cookies|the page you (?:are looking for|requested) (?:could not be found|does not exist|cannot be found))\b/i;
/** The longest page text read as an error page's own message. */
const ERROR_TEXT_MAX = 200;

/**
 * True for a web result that is an error page (a 404 or 5xx page, a bot wall, an empty search
 * page) rather than a page about the track: by its title, or by a short text that only says so.
 */
export function isErrorPage(result: { title?: unknown; content?: unknown }): boolean {
  const title = typeof result?.title === "string" ? result.title.trim() : "";
  const text =
    typeof result?.content === "string" ? result.content.replace(/\s+/g, " ").trim() : "";
  if (title && (HTTP_STATUS.test(title) || ERROR_PAGE.test(title))) return true;
  return text.length <= ERROR_TEXT_MAX && (HTTP_STATUS.test(text) || ERROR_PAGE.test(text));
}

/** A Last.fm bio without its trailing "Read more on Last.fm" link; null when nothing is left. */
export function lastfmBio(bio: unknown): string | null {
  if (typeof bio !== "string") return null;
  const text = bio.replace(LASTFM_READ_MORE, "").trim();
  return isPlaceholder(text) ? null : text;
}

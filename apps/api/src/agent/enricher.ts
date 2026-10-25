/**
 * Genealogy Enricher for The Sonic Agent
 *
 * This module enriches genealogy data with real album artwork from Spotify.
 *
 * Problem: The LLM generates genealogy nodes with song names but can't provide
 *          real album artwork URLs because it doesn't have access to Spotify.
 *
 * Solution: After the Composer generates the genealogy, we search Spotify
 *           for each referenced song and fetch the actual album artwork.
 *
 * The search goes through the Spotify source (sources/spotify.ts): every request has a timeout
 * and fails with a typed error, and a failed search leaves the node without artwork. A node gets
 * the cover of the track found; its Spotify id only when that track is strictly the one the
 * model named (see `strictlyMatches`: not on a release named as a live, unplugged, re-recorded,
 * karaoke, tribute or covers one), so a click on a node whose search found a cover, a remix, a
 * live album or another song searches the node's text instead. A preview needs more: the
 * release must also date from within a year of the year the node's label names, if it names
 * one (see `releaseYearFits`). The search's answer is cached for a week by the node's label
 * (without the track's identity when its release names another recording); a preview is never
 * cached. The cached answer keeps what the preview is decided on (the track's ISRC, duration,
 * album and release date; none of them a link), so a node served from the cache is judged as a
 * fresh one is and gets the same Deezer lookup (Spotify's own clip is not cached, so a cached
 * node has only Deezer's).
 *
 * A strictly matched node's preview is Spotify's own clip of the track found, when it has one
 * the player may load (sources/audio.ts isAllowedPreviewUrl); else the Deezer entry for that
 * track's ISRC (or the readable alternative Deezer names for it), checked as the analysed
 * track's is (sources/deezer.ts deezerPreviewByIsrc: the same lead artist, title and version,
 * and a duration within 3 s). There is no Deezer search for a node, so a node gets no preview of
 * another recording. A preview is optional, so its cost is bounded (see deezerPreviews): one
 * lookup per strictly matched node without a Spotify clip, a few at once, at most
 * MAX_DEEZER_LOOKUPS per run, a time budget for the Deezer lookups after which the remaining
 * nodes simply get none (the run goes on), and none after Deezer failed (see `stops`); a node
 * served from the cache counts as a fresh one does. A row older code cached with a Spotify id but
 * no track details is not served (see `servable`): its release cannot be checked, so the node is
 * searched again and the row written with the details. Preview links are signed and expire: they
 * are returned for this run's player only, never cached or logged.
 *
 * Features:
 * - Parallel batch search for performance
 * - Caching to avoid repeated API calls
 * - Graceful fallback when songs aren't found
 */

import type { SourceError } from "@liner-notes/contract";
import { isAllowedPreviewUrl } from "../sources/audio.js";
import { deezerPreviewByIsrc, type PreviewRequest } from "../sources/deezer.js";
import { PaceRefused, pacingClock } from "../sources/pacing.js";
import { describeError, isSourceError } from "../sources/http.js";
import { sourceErrorCode } from "../sources/toolResult.js";
import { searchTracks, type SpotifyTrackSummary } from "../sources/spotify.js";
import { type CachedTrackDetails, getCache, type SpotifySearchResult } from "../store/cache.js";
import { isAbortError } from "./errors.js";
import type { Genealogy, GenealogyNode } from "./schema.js";
import { recordingTitleDifference, sameArtistName } from "./trackMatch.js";
import { logger } from "../logger.js";

const log = logger("Enricher");

// =============================================================================
// Persistent Artwork Cache (backed by SQLite)
// =============================================================================

function getCacheKey(label: string): string {
  return label.toLowerCase().trim();
}

function getCachedArtwork(label: string): SpotifySearchResult | undefined {
  try {
    return getCache().getArtwork(getCacheKey(label)) ?? undefined;
  } catch {
    return undefined;
  }
}

function setCachedArtwork(label: string, result: SpotifySearchResult): void {
  try {
    getCache().putArtwork(getCacheKey(label), {
      coverUrl: result.coverUrl,
      spotifyUrl: result.spotifyUrl,
      spotifyId: result.spotifyId,
      trackTitle: result.trackTitle,
      trackArtist: result.trackArtist,
      trackArtists: result.trackArtists ?? null,
      trackDetails: result.trackDetails ?? null,
    });
  } catch {
    // Non-critical
  }
}

// =============================================================================
// Spotify search
// =============================================================================

const NO_ARTWORK: SpotifySearchResult = {
  coverUrl: null,
  spotifyUrl: null,
  spotifyId: null,
  trackTitle: null,
  trackArtist: null,
};

/**
 * What a node gets from Spotify: the artwork of the track found, and only when that track is
 * strictly the one the model named its Spotify id (a click analyses that id) and its preview:
 * Spotify's own clip, or else (`byIsrc`) the track to look up on Deezer by its ISRC.
 */
interface NodeLookup {
  artwork: SpotifySearchResult;
  previewUrl: string | null;
  byIsrc: PreviewRequest | null;
}

/** At most this many Deezer lookups of one enrichment run at once. */
const DEEZER_CONCURRENCY = 2;
/** At most this many nodes of one enrichment are looked up on Deezer. */
export const MAX_DEEZER_LOOKUPS = 20;
/**
 * How long the Deezer lookups of one enrichment may take in all: the time while at least one of
 * them is under way (the Spotify searches between them do not count).
 */
export const PREVIEW_BUDGET_MS = 8_000;
/** How long one node's lookup (its ISRC entry, and that entry's alternative) may take. */
export const LOOKUP_TIMEOUT_MS = 4_000;
/**
 * The least time a lookup's request must have left, of its own time and the budget's, when it
 * starts: a later slot of Deezer's pace is refused, and the node gets no preview.
 */
const START_MARGIN_MS = 1_000;
/** Failures of other kinds than those in `stops` after which no more lookups are made. */
const MAX_FAILURES = 2;

/**
 * The strictly matched track, as deezerPreviewByIsrc checks a Deezer entry against it: from a
 * fresh search, or from the cache (cachedTrack), which gives the same request for the same track.
 */
function isrcRequest(
  found: Pick<SpotifyTrackSummary, "title" | "artist" | "artistNames" | "isrc"> & {
    album?: string | null;
    durationMs?: number | null;
  },
): PreviewRequest | null {
  if (!found.isrc) return null;
  return {
    title: found.title,
    artist: found.artist,
    ...(found.artistNames.length > 0 ? { artistNames: found.artistNames } : {}),
    ...(found.album ? { album: found.album } : {}),
    isrc: found.isrc,
    durationMs: found.durationMs || null,
  };
}

/** What the cache keeps of the found track to decide its preview later; none of it a link. */
function detailsOf(found: SpotifyTrackSummary): CachedTrackDetails {
  return {
    isrc: found.isrc,
    durationMs: found.durationMs || null,
    album: found.album || null,
    releaseDate: found.releaseDate || null,
  };
}

/**
 * Runs at most `limit` tasks at once; the others wait their turn, in order. A task that throws
 * frees its slot as one that returns does.
 */
export function limiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // A finished task hands its slot to the next one waiting.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * A signal that aborts as a deadline (a TimeoutError, which the sources report as a timeout,
 * never as a cancelled run) after `ms`. Timers, not AbortSignal.timeout, so tests can run the
 * clock.
 */
function deadline(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`no answer within ${ms} ms`, "TimeoutError")),
    ms,
  );
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * A time budget that runs only while a lookup is under way (`begin` and `end` around each
 * one): its signal aborts as a deadline once `ms` of such time is spent.
 */
function lookupBudget(ms: number) {
  const controller = new AbortController();
  let left = ms;
  let since = 0;
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spend = () =>
    controller.abort(new DOMException(`preview budget of ${ms} ms spent`, "TimeoutError"));
  return {
    signal: controller.signal,
    begin() {
      if (active++ > 0) return;
      since = Date.now();
      timer = setTimeout(spend, Math.max(0, left));
      timer.unref?.();
    },
    end() {
      if (--active > 0) return;
      clearTimeout(timer);
      left -= Date.now() - since;
      if (left <= 0 && !controller.signal.aborted) spend();
    },
    /** The budget's time left now. */
    remaining: () => (active > 0 ? left - (Date.now() - since) : left),
    clear: () => clearTimeout(timer),
  };
}

/**
 * Whether a failure ends the lookups at once: a rate limit (Deezer's quota is per address, and
 * the analysed track's own lookup needs it), a timeout (the next would most likely wait as
 * long), or a request a replay has no answer for.
 */
const stops = (error: unknown) =>
  isSourceError(error) &&
  (error.kind === "rate_limited" || error.kind === "timeout" || error.kind === "cassette_miss");

/** An error's text for a log or a source error, without any link it may echo. */
const withoutLinks = (text: string) => text.replace(/\bhttps?:\/\/\S+/gi, "[link]");

/**
 * Deezer previews by ISRC for one enrichment. A preview is optional, so its cost is bounded:
 * - at most DEEZER_CONCURRENCY lookups at once and MAX_DEEZER_LOOKUPS in all;
 * - each lookup within LOOKUP_TIMEOUT_MS, and all of them within PREVIEW_BUDGET_MS of lookup
 *   time; a node whose turn comes after that gets no preview, and the run goes on. A spent
 *   budget is said once in the log; it is not a Deezer failure;
 * - none after a rate limit or a timeout of Deezer's, nor after MAX_FAILURES other failures. A
 *   lookup that finds no usable entry is not a failure;
 * - their requests take Deezer's pace for the whole process, within the share left to node
 *   previews (sources/deezer.ts DEEZER_NODE_PACE), so that concurrent runs stay under Deezer's
 *   quota and an analysed track's lookup still gets a slot. A lookup whose slot would come too
 *   late for its own time or the budget (less START_MARGIN_MS) is skipped: that request is not
 *   sent, it is not a failure, and it does not count against MAX_DEEZER_LOOKUPS. Skips are said
 *   once in the log.
 * A lookup gives the preview only of an entry deezerPreviewByIsrc accepts and the player may
 * load; anything else is no preview. The first Deezer failure is reported (`report`) as a
 * source error of the run. A cancelled run rejects. `done` clears the budget's timer.
 */
function deezerPreviews(signal: AbortSignal | undefined, report?: (error: SourceError) => void) {
  const run = limiter(DEEZER_CONCURRENCY);
  const budget = lookupBudget(PREVIEW_BUDGET_MS);
  let budgetSaid = false;
  let started = 0;
  let failures = 0;
  let stopped = false;
  let reported = false;
  let skipsSaid = false;

  const failed = (error: unknown, timedOut: boolean) => {
    failures++;
    if (timedOut || stops(error) || failures >= MAX_FAILURES) stopped = true;
    const text = withoutLinks(describeError(error));
    log.warn(`Deezer lookup for a genealogy preview failed: ${text}`);
    if (reported) return;
    reported = true;
    report?.({
      source: "deezer",
      code: timedOut ? "timeout" : sourceErrorCode(error),
      message: `Genealogy previews: ${text}`,
    });
  };

  /** The budget is spent: said once, and no more lookups are made. */
  const budgetSpent = () => {
    stopped = true;
    if (budgetSaid) return;
    budgetSaid = true;
    log.info(
      `Genealogy previews: the ${PREVIEW_BUDGET_MS / 1000} s budget for Deezer lookups is ` +
        "spent; the remaining nodes get none",
    );
  };

  /** A lookup Deezer's pace had no slot for in time: said once; it counts against nothing. */
  const skipped = () => {
    started--;
    if (skipsSaid) return;
    skipsSaid = true;
    log.info("Genealogy previews: Deezer's pace has no slot in time; those nodes get none");
  };

  const lookUp = (request: PreviewRequest): Promise<string | null> =>
    run(async () => {
      signal?.throwIfAborted();
      if (budget.signal.aborted) budgetSpent();
      if (stopped || started >= MAX_DEEZER_LOOKUPS) return null;
      started++;
      const own = deadline(LOOKUP_TIMEOUT_MS);
      const signals = [budget.signal, own.signal, ...(signal ? [signal] : [])];
      budget.begin();
      const left = Math.min(budget.remaining(), LOOKUP_TIMEOUT_MS) - START_MARGIN_MS;
      try {
        const result = await deezerPreviewByIsrc(request, AbortSignal.any(signals), {
          lane: "nodes",
          notAfter: pacingClock() + Math.max(0, left),
        });
        return result.found && isAllowedPreviewUrl(result.previewUrl) ? result.previewUrl : null;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof PaceRefused) {
          skipped();
          return null;
        }
        if (budget.signal.aborted) {
          budgetSpent();
          return null;
        }
        const timedOut = own.signal.aborted;
        if (!timedOut && isAbortError(error)) throw error;
        failed(error, timedOut);
        return null;
      } finally {
        budget.end();
        own.clear();
      }
    });

  return { lookUp, done: () => budget.clear() };
}

/** The artists a credit names: "Queen & David Bowie", "Daft Punk feat. Pharrell Williams". */
function creditParts(credit: string): string[] {
  return credit
    .split(/\s*(?:,|&|\/|\s(?:and|x|with|feat\.?|ft\.?|featuring)\s)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Whether the node's artist credit is the found track's: the same name as its lead artist or as
 * its whole credit, or a credit of several artists ("Queen & David Bowie") whose first is the
 * lead and every one of which is credited on the track. A name that contains a separator
 * ("Earth, Wind & Fire") matches by its whole name.
 */
function sameCredit(nodeArtist: string, lead: string, credited: readonly string[]): boolean {
  if (sameArtistName(nodeArtist, lead)) return true;
  if (credited.length > 1 && sameArtistName(nodeArtist, credited.join(", "))) return true;
  const parts = creditParts(nodeArtist);
  if (parts.length < 2 || !sameArtistName(parts[0], lead)) return false;
  return parts.every((part) => credited.some((name) => sameArtistName(part, name)));
}

/**
 * Whether the track found is strictly the one the model named: the node names both a title and
 * an artist, the node's credit is the track's (sameCredit), nothing in the titles tells them
 * apart as recordings (no other title, version or take; a featured-artist note is not a
 * difference; see trackMatch.ts), and its album, when known, is not named as another recording
 * (marksOtherRecording). A label alone is never enough: a search for it can find a cover, a
 * remix or another song.
 */
export function strictlyMatches(
  node: Pick<GenealogyNode, "trackTitle" | "trackArtist">,
  found: Pick<SpotifyTrackSummary, "title" | "artist" | "artistNames"> & { album?: string },
): boolean {
  const title = node.trackTitle?.trim();
  const artist = node.trackArtist?.trim();
  if (!title || !artist) return false;
  const credited = found.artistNames.length > 0 ? found.artistNames : [found.artist];
  const lead = credited[0] ?? found.artist;
  return (
    sameCredit(artist, lead, credited) &&
    recordingTitleDifference({ title }, { title: found.title }) === null &&
    !marksOtherRecording(found.album, found.title)
  );
}

/**
 * Phrases that name a release as one of other recordings: live, unplugged, in concert,
 * re-recorded, karaoke, tribute, covers. A bare "live" or "sessions" inside a name is not one
 * ("Long Live the Kane", "Live Through This", "The Sun Sessions" are studio albums).
 */
const OTHER_RECORDING_PHRASES = [
  /\blive (?:at|in|from|on)\b/,
  /\(live\b/,
  /\s[-–—]\s*live\b/,
  /\bunplugged\b/,
  /\bin concert\b/,
  /\bre-?recorded\b/,
  /\bkaraoke\b/,
  /\btribute\b/,
  /\bcovers?\b/,
];

/**
 * Whether an album's name says its tracks are other recordings than the studio one (see
 * OTHER_RECORDING_PHRASES); a phrase the track's own title carries does not count.
 */
export function marksOtherRecording(album: string | undefined, title: string): boolean {
  const name = (album ?? "").toLowerCase();
  const own = title.toLowerCase();
  return OTHER_RECORDING_PHRASES.some((phrase) => phrase.test(name) && !phrase.test(own));
}

/** The last year in parentheses a node's label names ("Respect - Aretha Franklin (1967)"). */
function labelYear(label: string): number | null {
  const years = [...label.matchAll(/\((\d{4})\)/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1900 && year <= 2100);
  return years.at(-1) ?? null;
}

/**
 * Whether a release dates from within a year of the year a node's label names (always, when it
 * names none). This decides the preview only: a release from years later may be the recording
 * reissued (a compilation) or another recording whose album name says nothing of it ("Aretha at
 * Fillmore West" for a 1967 "Respect"), so it keeps its Spotify id (a click analyses that track,
 * which shows its own album and date) but plays no clip, as missing is better than another
 * recording. A label without a year cannot tell such a live album apart.
 */
export function releaseYearFits(label: string, releaseDate: string | undefined): boolean {
  const named = labelYear(label);
  if (named === null) return true;
  const released = Number.parseInt(releaseDate?.slice(0, 4) ?? "", 10);
  return released > 0 && Math.abs(released - named) <= 1;
}

/**
 * The cached track, for strictlyMatches and isrcRequest: every credited artist when the row keeps
 * them, else (rows written before the cache kept them) the lead artist only; its album, ISRC,
 * duration and release date when the row keeps them (rows written before have none).
 */
function cachedTrack(cached: SpotifySearchResult) {
  const names = cached.trackArtists?.length
    ? cached.trackArtists
    : cached.trackArtist
      ? [cached.trackArtist]
      : [];
  const details = cached.trackDetails ?? null;
  return {
    title: cached.trackTitle ?? "",
    artist: names.join(", "),
    artistNames: names,
    ...(details?.album ? { album: details.album } : {}),
    isrc: details?.isrc ?? null,
    durationMs: details?.durationMs ?? null,
    releaseDate: details?.releaseDate ?? undefined,
  };
}

/** The cover alone, without the track's identity: for a track that is not strictly the node's. */
const withoutId = (artwork: SpotifySearchResult): SpotifySearchResult => ({
  ...artwork,
  spotifyId: null,
  trackTitle: null,
  trackArtist: null,
  trackArtists: null,
  trackDetails: null,
});

/**
 * Whether a cached row may be served: a row with the track's details, or one without its
 * identity (the cover only). A row with a Spotify id but no details (older code's, or details
 * that were not valid) is a miss: without its album the release cannot be checked, and code from
 * before the album check cached the ids of live and re-recorded releases.
 */
const servable = (cached: SpotifySearchResult) => !cached.spotifyId || !!cached.trackDetails;

/**
 * A node served from the cache, under the rules of a fresh search: the Spotify id only for a
 * strict match (its album is checked as a fresh one's is: a row cached for a release that names
 * other recordings gives the cover only), and a Deezer lookup by ISRC only when the release's
 * year also fits the label. A row without the track's identity gives the cover only, and so does
 * one whose details keep no album (unknown, or a name the cache would not keep): its release
 * cannot be checked. The cache keeps no Spotify clip, so none is offered.
 */
function fromCache(node: GenealogyNode, cached: SpotifySearchResult): NodeLookup {
  const track = cachedTrack(cached);
  if (!cached.spotifyId || !track.album || !strictlyMatches(node, track)) {
    return { artwork: withoutId(cached), previewUrl: null, byIsrc: null };
  }
  if (!cached.trackDetails || !releaseYearFits(node.label, track.releaseDate)) {
    return { artwork: cached, previewUrl: null, byIsrc: null };
  }
  return { artwork: cached, previewUrl: null, byIsrc: isrcRequest(track) };
}

/**
 * Artwork for a node, from the cache or a Spotify search, with the Spotify id and a preview of
 * the track found only when that track strictly matches the node: a loose match still gives the
 * cover, but a click on the node then searches its text, and nothing plays. The preview is
 * Spotify's own clip when the player may load it, else the track is to be looked up on Deezer
 * by its ISRC (`byIsrc`, when it has one). A cached entry that may be served (servable) is
 * judged the same way (fromCache), with the Deezer lookup only: no preview is stored. A failed
 * search gives nothing and caches nothing, so a later run tries again; a cancelled run rejects.
 * A row that may not be served (older code's, with an id) is searched again; when that search
 * fails or finds nothing, the node keeps the row's cover (without its id) and the row is kept.
 */
async function lookUpNode(node: GenealogyNode, signal?: AbortSignal): Promise<NodeLookup> {
  const cached = getCachedArtwork(node.label);
  if (cached && servable(cached)) return fromCache(node, cached);
  /** What the node gets when the search gives nothing: the old row's cover, or nothing. */
  const nothing: NodeLookup = {
    artwork: cached ? withoutId(cached) : NO_ARTWORK,
    previewUrl: null,
    byIsrc: null,
  };

  let found: SpotifyTrackSummary | undefined;
  try {
    [found] = await searchTracks(node.label, 1, signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    log.warn(`Spotify search for "${node.label}" failed: ${describeError(error)}`);
    return nothing;
  }
  if (!found && cached) {
    // Searched again for an old row and found nothing: the row stays until it expires.
    signal?.throwIfAborted();
    return nothing;
  }

  const artwork: SpotifySearchResult = found
    ? {
        coverUrl: found.coverUrl || null,
        spotifyUrl: found.spotifyUrl || null,
        spotifyId: found.id || null,
        trackTitle: found.title || null,
        trackArtist: found.artistNames[0] || found.artist || null,
        trackArtists: found.artistNames.length > 0 ? found.artistNames : null,
        trackDetails: detailsOf(found),
      }
    : NO_ARTWORK;
  signal?.throwIfAborted();
  // A track on a release named as other recordings is never the node's, whatever the node
  // names: its row keeps the cover only, so a later run cannot take its id from the cache.
  const other = !!found && marksOtherRecording(found.album, found.title);
  setCachedArtwork(node.label, other ? withoutId(artwork) : artwork);
  if (!found) return { artwork: NO_ARTWORK, previewUrl: null, byIsrc: null };
  if (!strictlyMatches(node, found)) {
    return { artwork: withoutId(artwork), previewUrl: null, byIsrc: null };
  }
  if (!releaseYearFits(node.label, found.releaseDate)) {
    return { artwork, previewUrl: null, byIsrc: null };
  }
  if (found.previewUrl && isAllowedPreviewUrl(found.previewUrl)) {
    return { artwork, previewUrl: found.previewUrl, byIsrc: null };
  }
  return { artwork, previewUrl: null, byIsrc: isrcRequest(found) };
}

// =============================================================================
// Main Enrichment Function
// =============================================================================

/**
 * Enrich genealogy nodes with real Spotify album artwork.
 *
 * @param genealogy - The genealogy object from the Composer (may have optional fields)
 * @param currentTrackCoverUrl - The cover URL of the main track (already known)
 * @param signal - The run's abort signal: a cancelled run stops the Spotify and Deezer requests
 *   and rejects
 * @param report - Told once when Deezer could not be read for the node previews, for the run's
 *   source errors
 * @returns Enriched genealogy with real artwork URLs
 */
export async function enrichGenealogyWithArtwork(
  genealogy: Partial<Genealogy> | undefined,
  currentTrackCoverUrl: string,
  signal?: AbortSignal,
  report?: (error: SourceError) => void,
): Promise<Genealogy> {
  // Handle undefined or malformed genealogy
  if (!genealogy?.nodes || !Array.isArray(genealogy.nodes) || genealogy.nodes.length === 0) {
    return {
      nodes: [
        {
          id: "current",
          group: 1,
          label: "Current Track",
          img: currentTrackCoverUrl,
          size: 40,
        },
      ],
      links: [],
    };
  }

  log.info(`Enriching ${genealogy.nodes.length} genealogy nodes with artwork`);

  const deezer = deezerPreviews(signal, report);
  try {
    // Process nodes in parallel (with concurrency limit to avoid rate limits)
    const BATCH_SIZE = 5;
    const enrichedNodes: GenealogyNode[] = [];

    for (let i = 0; i < genealogy.nodes.length; i += BATCH_SIZE) {
      const batch = genealogy.nodes.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (node) => {
          // Ensure node has required fields
          const safeNode: GenealogyNode = {
            id: node.id || `node-${i}`,
            group: node.group || 4,
            label: node.label || "Unknown",
            img: node.img,
            size: node.size || 25,
          };

          // Skip if it's the current song (group 1) - we already have its cover
          if (safeNode.group === 1) {
            return {
              ...safeNode,
              img: currentTrackCoverUrl,
            };
          }

          // Skip if already has a valid image URL
          if (safeNode.img && isValidImageUrl(safeNode.img)) {
            return safeNode;
          }

          // Search Spotify for this song; the model's title and artist decide the preview
          const { artwork, previewUrl, byIsrc } = await lookUpNode(
            { ...safeNode, trackTitle: node.trackTitle, trackArtist: node.trackArtist },
            signal,
          );
          const preview = previewUrl ?? (byIsrc ? await deezer.lookUp(byIsrc) : null);

          return {
            ...safeNode,
            img: artwork.coverUrl || undefined,
            previewUrl: preview || undefined,
            spotifyId: artwork.spotifyId || undefined,
            trackTitle: artwork.trackTitle || undefined,
            trackArtist: artwork.trackArtist || undefined,
          };
        }),
      );

      enrichedNodes.push(...batchResults);

      // Small delay between batches to be nice to Spotify API
      if (i + BATCH_SIZE < genealogy.nodes.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const nodesWithImages = enrichedNodes.filter((n) => n.img).length;
    log.info(`Found artwork for ${nodesWithImages}/${enrichedNodes.length} nodes`);

    // Ensure links have required fields
    const safeLinks = (genealogy.links || [])
      .map((link) => ({
        source: link.source || "",
        target: link.target || "",
        value: link.value || 1,
      }))
      .filter((link) => link.source && link.target);

    return {
      nodes: enrichedNodes,
      links: safeLinks,
    };
  } catch (error) {
    // A cancelled run stops here: it reports nothing.
    if (signal?.aborted || isAbortError(error)) throw error;
    log.error("Could not enrich the genealogy", { err: error });
    // Return safe fallback if enrichment fails
    return {
      nodes: [
        {
          id: "current",
          group: 1,
          label: "Current Track",
          img: currentTrackCoverUrl,
          size: 40,
        },
      ],
      links: [],
    };
  } finally {
    deezer.done();
  }
}

/**
 * Check if a URL looks like a valid image URL
 */
function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;

  try {
    const parsed = new URL(url);
    // Accept common image hosting domains
    const validDomains = [
      "i.scdn.co", // Spotify
      "mosaic.scdn.co", // Spotify mosaic
      "picsum.photos", // Placeholder service
      "placehold.co", // Placeholder
      "images.unsplash.com", // Unsplash
    ];
    return validDomains.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
}

/**
 * Generate a consistent placeholder color based on the label
 * This creates a deterministic gradient for nodes without images
 */
export function generatePlaceholderGradient(label: string, group: number): string {
  // Generate a hash from the label
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    const char = label.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Generate HSL colors based on hash and group
  const hue = Math.abs(hash) % 360;

  // Different saturation/lightness based on group for visual hierarchy
  const groupStyles: Record<number, { s: number; l: number }> = {
    1: { s: 80, l: 50 }, // Current: vibrant
    2: { s: 70, l: 45 }, // Sampled: warm
    3: { s: 60, l: 40 }, // Sampler: cooler
    4: { s: 50, l: 35 }, // Influence: subtle
  };

  const style = groupStyles[group] || { s: 60, l: 40 };

  return `hsl(${hue}, ${style.s}%, ${style.l}%)`;
}

// =============================================================================
// Export utilities
// =============================================================================

export { isValidImageUrl, getCachedArtwork };

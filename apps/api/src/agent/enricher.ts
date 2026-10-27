/**
 * Artwork for the genealogy nodes: a cover, a Spotify id and a preview, each only for the
 * recording a node names. Nodes, labels and links are the composer's; the answer holds one entry
 * per node id with what was found for it (composerNode.ts merges it by id), never a node or a
 * link of its own.
 *
 * The search goes through the Spotify source (sources/spotify.ts): every request has a timeout
 * and fails with a typed error, and a failed search leaves the node without artwork. A node gets
 * the cover and the Spotify id of the track found only when that track is strictly the one the
 * model named (see `strictlyMatches`: the same title, case and accents aside; the same
 * artists, every one the track credits named by the node and every guest the node names
 * credited on the track; the same edit labels; and not on a release named as a live, acoustic,
 * remix, orchestral, re-recorded, karaoke, tribute or covers one). A cover, a remix, a live
 * album, a duet or another song gives nothing, so no node shows the art of another record; a
 * node that names no title or no artist is not searched, since nothing could be checked. A preview needs more: the release must
 * also date from within a year of the year the node's label (or else the model) names, if any (see
 * `releaseYearFits`). The search's answer is cached for a week under the node's label, title and
 * artist (see `artworkCacheKey`; without the track's identity when its release names another
 * recording); a preview is never cached. The cached answer keeps what the preview is decided on
 * (the track's ISRC, duration, album and release date; none of them a link), so a node served
 * from the cache is judged as a fresh one is and gets the same Deezer lookup (Spotify's own clip
 * is not cached, so a cached node has only Deezer's).
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
 * served from the cache counts as a fresh one does. A row with a Spotify id but no track details
 * is not served (see `servable`): its release cannot be checked, so the node is searched again
 * and the row written with the details. Preview links are signed and expire: they are returned
 * for this run's player only, never cached or logged.
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
import type { GenealogyNode } from "./schema.js";
import { recordingTitleDifference, sameArtistName, words } from "./trackMatch.js";
import { logger } from "../logger.js";

const log = logger("Enricher");

// =============================================================================
// Persistent Artwork Cache (backed by SQLite)
// =============================================================================

/**
 * A genealogy node as the composer hands it over: with the year the model gave for it, when it
 * gave one (the result's nodes do not carry it).
 */
export type ArtworkNode = GenealogyNode & { year?: string | null };

/** A node as the artwork lookup reads it: what it searches for and what it checks the hit on. */
type NamedNode = Pick<ArtworkNode, "label" | "trackTitle" | "trackArtist" | "year">;

/**
 * The artwork row of a node: its label (what is searched for), title and artist (what the hit is
 * checked on), each normalised as trackMatch.ts `words` does (case, accents, punctuation). The
 * title and artist give two nodes with one label (a song and its cover) a row each, so neither
 * evicts the other's; correctness does not rest on the key, since every served row is judged
 * against the node reading it (fromCache). The `v2` prefix sets these rows apart from those
 * older code keyed by the label alone, which are never read and expire with the cache's TTL.
 */
function artworkCacheKey(node: NamedNode): string {
  const part = (text: string | undefined) => words(text ?? "").join(" ");
  return ["v2", part(node.label), part(node.trackTitle), part(node.trackArtist)].join("|");
}

function getCachedArtwork(node: NamedNode): SpotifySearchResult | undefined {
  try {
    return getCache().getArtwork(artworkCacheKey(node)) ?? undefined;
  } catch {
    return undefined;
  }
}

function setCachedArtwork(node: NamedNode, result: SpotifySearchResult): void {
  try {
    getCache().putArtwork(artworkCacheKey(node), {
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
 * What a node gets from Spotify, only when the track found is strictly the one the model named:
 * its cover, its Spotify id (a click analyses that id) and its preview: Spotify's own clip, or
 * else (`byIsrc`) the track to look up on Deezer by its ISRC. Otherwise NO_ARTWORK and nothing.
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
/**
 * How long one node's lookup (its ISRC entry, and that entry's alternative) may take, from when
 * its first request got its slot of Deezer's pace: the wait for that slot counts against the
 * budget only.
 */
export const LOOKUP_TIMEOUT_MS = 4_000;
/**
 * The least time a request must have left when it starts: of the budget, and once the lookup's
 * own time runs, of that too. A later slot of Deezer's pace is refused.
 */
export const START_MARGIN_MS = 1_000;
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
 * never as a cancelled run) `ms` after `start` (the first call; later ones do nothing). `endsAt`
 * is that time on `pacingClock`, Infinity before the start. Timers, not AbortSignal.timeout, so
 * tests can run the clock.
 */
function deadline(ms: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let endsAt = Number.POSITIVE_INFINITY;
  return {
    signal: controller.signal,
    start() {
      if (timer) return;
      endsAt = pacingClock() + ms;
      timer = setTimeout(
        () => controller.abort(new DOMException(`no answer within ${ms} ms`, "TimeoutError")),
        ms,
      );
      timer.unref?.();
    },
    endsAt: () => endsAt,
    clear: () => clearTimeout(timer),
  };
}

/**
 * A time budget that runs only while a lookup is under way (`begin` and `end` around each
 * one): its signal aborts as a deadline once `ms` of such time is spent. Time is read from
 * `pacingClock`, as `deadline` and the pacers read it, so a step of the wall clock spends none.
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
      since = pacingClock();
      timer = setTimeout(spend, Math.max(0, left));
      timer.unref?.();
    },
    end() {
      if (--active > 0) return;
      clearTimeout(timer);
      left -= pacingClock() - since;
      if (left <= 0 && !controller.signal.aborted) spend();
    },
    /** The budget's time left now. */
    remaining: () => (active > 0 ? left - (pacingClock() - since) : left),
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
 * - each lookup within LOOKUP_TIMEOUT_MS of its first request's slot, and all of them within
 *   PREVIEW_BUDGET_MS of lookup time (waits for a slot included); a node whose turn comes after
 *   that gets no preview, and the run goes on. A spent budget is said once in the log; it is not
 *   a Deezer failure;
 * - none after a rate limit or a timeout of Deezer's, nor after MAX_FAILURES other failures. A
 *   lookup that finds no usable entry is not a failure;
 * - their requests take Deezer's pace for the whole process (sources/deezer.ts DEEZER_PACE), in
 *   the background lane: within the share left to node previews, and after any analysed track's
 *   request, which never waits behind them. So concurrent runs stay under Deezer's quota. A
 *   request whose slot would come too late (START_MARGIN_MS) is refused and not sent. When that
 *   is the lookup's first request, the lookup is skipped: not a failure, not counted against
 *   MAX_DEEZER_LOOKUPS, and said once in the log. When its first request was sent (its
 *   alternative's was refused), it is a lookup like any other, without a preview.
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

  /**
   * A lookup whose first request Deezer's pace had no slot for in time: said once; it counts
   * against nothing.
   */
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
      // The budget runs while this lookup is under way: it ends then at the latest.
      const budgetEndsAt = pacingClock() + budget.remaining();
      let sent = false;
      try {
        const result = await deezerPreviewByIsrc(request, AbortSignal.any(signals), {
          lane: "nodes",
          notAfter: () => Math.min(budgetEndsAt, own.endsAt()) - START_MARGIN_MS,
          onSlot: () => {
            sent = true;
            own.start();
          },
        });
        return result.found && isAllowedPreviewUrl(result.previewUrl) ? result.previewUrl : null;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof PaceRefused) {
          if (!sent) skipped();
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

/**
 * The joins between the artists of a credit. Whitespace before a join is read from the start of
 * its run only, so a long run of spaces is read once: the same splits as with `\s*` in front.
 */
export const CREDIT_JOIN =
  /(?:(?<!\s)\s+)?(?:,|&|\/|\s(?:and|x|with|feat\.?|ft\.?|featuring)\s)\s*/i;

/** The artists a credit names: "Queen & David Bowie", "Daft Punk feat. Pharrell Williams". */
function creditParts(credit: string): string[] {
  return credit
    .split(CREDIT_JOIN)
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

/** The artists a title's featured-artist note names: "Stay With Me (feat. Mary J. Blige)". */
function featuredIn(title: string): string[] {
  const notes = [
    ...title.matchAll(/[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi),
    ...title.matchAll(/(?:^|\s)(?:feat\.|ft\.|featuring)\s+([^()[\]]+)$/gi),
  ];
  return notes.flatMap((note) => creditParts(note[1] ?? ""));
}

/**
 * Whether the node and the found track name the same artists, both ways:
 * - the node names every artist the track credits (its credits and a featured-artist note of
 *   its title), in its artist credit or in a featured-artist note of its own title. A track that
 *   credits someone the node does not name is taken for another recording: a later duet single
 *   ("Stay With Me (feat. Mary J. Blige)" for Sam Smith's "Stay With Me"), or a credit the model
 *   left short;
 * - every guest the node's title names ("Old Town Road (feat. Billy Ray Cyrus)") is credited on
 *   the track: the solo record is another recording.
 * Either way the node gets no cover; a missed cover is better than another record's.
 */
function namesEveryCredit(
  artist: string,
  title: string,
  credited: readonly string[],
  foundTitle: string,
): boolean {
  const names = [artist, ...creditParts(artist), ...featuredIn(title)];
  const named = (name: string) => names.some((own) => sameArtistName(own, name));
  const wholeCredit = credited.length > 1 && sameArtistName(artist, credited.join(", "));
  const onRecord = [...credited, ...featuredIn(foundTitle)];
  const guestCredited = (guest: string) => onRecord.some((name) => sameArtistName(guest, name));
  return (
    (wholeCredit || credited.every(named)) &&
    featuredIn(foundTitle).every(named) &&
    featuredIn(title).every(guestCredited)
  );
}

/**
 * Labels of a title that name another mix or edit than the album recording: a radio or single
 * edit, version or mix, a stereo mix, a mono mix. trackMatch.ts reads them as labels of the same
 * release; a node's cover is held to more, since an edit or mix may sit on a release of its own.
 */
const EDIT_LABEL = /\b(?:radio|single)\s+(?:edit|version|mix)\b|\bstereo\s+mix\b|\bmono\b/gi;

/** The edit labels (EDIT_LABEL) of a title's bracketed and " - " parts, normalised. */
function editLabels(title: string): Set<string> {
  const brackets = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? "");
  const dashed = title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .split(/\s[-–—]\s/)
    .slice(1);
  const labels = [...brackets, ...dashed].flatMap((part) =>
    [...part.matchAll(EDIT_LABEL)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ")),
  );
  return new Set(labels);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

/**
 * Whether the track found is strictly the one the model named:
 * - the node names both a title and an artist;
 * - the node's credit is the track's (sameCredit), and the node names every artist the track
 *   credits (namesEveryCredit);
 * - nothing in the titles or the album tells them apart as recordings (no other title, version or
 *   take; an album that marks other recordings: live, concert, sessions, demos, instrumentals,
 *   re-recorded and the like; see trackMatch.ts recordingTitleDifference). A studio album whose
 *   name carries such a word ("Live Through This", "The Sun Sessions") is refused too: a missed
 *   cover is honest, another recording's is not;
 * - the track and the node's title carry the same edit labels (editLabels: radio or single
 *   edit, version or mix, stereo mix, mono): an edit the node names is not the album take, and
 *   the reverse;
 * - its album, when known, is not named as another recording (marksOtherRecording).
 * A label alone is never enough: a search for it can find a cover, a remix or another song.
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
  const ownEdits = editLabels(title);
  return (
    sameCredit(artist, lead, credited) &&
    namesEveryCredit(artist, title, credited, found.title) &&
    recordingTitleDifference({ title }, { title: found.title, album: found.album }) === null &&
    sameSet(editLabels(found.title), ownEdits) &&
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
 * Words that name an album as one of other recordings, read by this module only (the Deezer
 * comparison in trackMatch.ts has its own list): acoustic, remixed, orchestral, piano and
 * re-recorded releases. A word sequence, compared as trackMatch.ts `words` normalises it.
 */
const OTHER_RECORDING_WORDS = [
  ["acoustic"],
  ["remix"],
  ["remixes"],
  ["remixed"],
  ["orchestral"],
  ["symphonic"],
  ["symphonica"],
  ["piano", "version"],
  ["piano", "versions"],
  ["piano", "renditions"],
  ["piano", "covers"],
  ["solo", "piano"],
  ["newly", "recorded"],
  ["newly", "re", "recorded"],
  ["newly", "rerecorded"],
  ["re", "recordings"],
  ["rerecordings"],
];

/** Where `phrase` starts in `text`, or -1. */
function phraseAt(text: readonly string[], phrase: readonly string[]): number {
  for (let at = 0; at + phrase.length <= text.length; at++) {
    if (phrase.every((word, i) => text[at + i] === word)) return at;
  }
  return -1;
}

/** `text` without any occurrence of `phrase`. */
function withoutPhrase(text: readonly string[], phrase: readonly string[]): string[] {
  let rest = [...text];
  if (phrase.length === 0) return rest;
  for (let at = phraseAt(rest, phrase); at >= 0; at = phraseAt(rest, phrase)) {
    rest = [...rest.slice(0, at), ...rest.slice(at + phrase.length)];
  }
  return rest;
}

/** A title or album name without its bracketed and " - " parts, lower case. */
const nameProper = (text: string) =>
  text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .split(/\s[-–—]\s/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Whether an album's name says its tracks are other recordings than the studio one (see
 * OTHER_RECORDING_PHRASES and OTHER_RECORDING_WORDS). An album named after the track ("Live and
 * Let Die") is read without that name, and the words are read without the title's own ("Piano
 * Man", "Remix to Ignition"), so a title is not taken for a phrase; a title's words never excuse
 * any other part of the album's name ("Covers" for "Cover Me").
 */
export function marksOtherRecording(album: string | undefined, title: string): boolean {
  let name = (album ?? "").toLowerCase().replace(/\s+/g, " ");
  const own = nameProper(title);
  if (own && nameProper(album ?? "") === own) name = name.replace(own, " ");
  if (OTHER_RECORDING_PHRASES.some((phrase) => phrase.test(name))) return true;
  const rest = withoutPhrase(words(album ?? ""), words(own));
  return OTHER_RECORDING_WORDS.some((phrase) => phraseAt(rest, phrase) >= 0);
}

/** A year from 1900 to 2100 in a text, the first one. */
function yearIn(text: string | null | undefined): number | null {
  const year = Number(text?.match(/\b(\d{4})\b/)?.[1]);
  return year >= 1900 && year <= 2100 ? year : null;
}

/**
 * The year a node's label names: the last bracketed part that holds a year ("Respect - Aretha
 * Franklin (1967)", "[1976]", "(1967 single)", "(1967–68)").
 */
function labelYear(label: string): number | null {
  const years = [...label.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g)]
    .map((match) => yearIn(match[1] ?? match[2]))
    .filter((year) => year !== null);
  return years.at(-1) ?? null;
}

/**
 * Whether a release dates from within a year of the year a node's label names, or else of the
 * year the model gave for the node (`year`); always, when neither names one. This decides the
 * preview only: a release from years later may be the recording
 * reissued (a compilation) or another recording whose album name says nothing of it ("Aretha at
 * Fillmore West" for a 1967 "Respect"), so it keeps its Spotify id (a click analyses that track,
 * which shows its own album and date) but plays no clip, as missing is better than another
 * recording. A label without a year cannot tell such a live album apart.
 */
export function releaseYearFits(
  label: string,
  releaseDate: string | null | undefined,
  year?: string | null,
): boolean {
  const named = labelYear(label) ?? yearIn(year);
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

/**
 * The row of a track on a release named as other recordings, without the track's identity: it
 * is never the node's, so a later run serves it as nothing (fromCache) and searches no more.
 */
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
 * identity (served as nothing). A row with a Spotify id but no details (details that were not
 * valid) is a miss: without its album the release cannot be checked.
 */
const servable = (cached: SpotifySearchResult) => !cached.spotifyId || !!cached.trackDetails;

/** What a node gets when no track found is strictly the one it names. */
const NOTHING: NodeLookup = { artwork: NO_ARTWORK, previewUrl: null, byIsrc: null };

/**
 * A node served from the cache, under the rules of a fresh search: the cover and the Spotify id
 * only for a strict match (its album is checked as a fresh one's is: a row cached for a release
 * that names other recordings gives nothing), and a Deezer lookup by ISRC only when the release's
 * year also fits the label. A row without the track's identity gives nothing, and so does one
 * whose details keep no album (unknown, or a name the cache would not keep): its release cannot
 * be checked. The cache keeps no Spotify clip, so none is offered.
 */
function fromCache(node: NamedNode, cached: SpotifySearchResult): NodeLookup {
  const track = cachedTrack(cached);
  if (!cached.spotifyId || !track.album || !strictlyMatches(node, track)) return NOTHING;
  if (!cached.trackDetails || !releaseYearFits(node.label, track.releaseDate, node.year)) {
    return { artwork: cached, previewUrl: null, byIsrc: null };
  }
  return { artwork: cached, previewUrl: null, byIsrc: isrcRequest(track) };
}

/**
 * The Spotify searches of one run. After a rate limit, a timeout or a request a replay has no
 * answer for (`stops`), no more are made: the next would most likely be refused or wait as long,
 * and the run has a deadline. A node not searched gets no artwork, and the pass is cut short
 * (`cutShort`): its answer says it is not complete, so the result is not stored for later runs.
 */
function spotifySearches(signal: AbortSignal | undefined) {
  let stopped = false;
  const search = async (label: string): Promise<SpotifyTrackSummary | undefined | "failed"> => {
    if (stopped) return "failed";
    try {
      const [found] = await searchTracks(label, 1, signal);
      return found;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      log.warn(`Spotify search for "${label}" failed: ${describeError(error)}`);
      if (stops(error) && !stopped) {
        stopped = true;
        log.warn(
          "Genealogy artwork: no more Spotify searches in this run; the other nodes get none",
        );
      }
      return "failed";
    }
  };
  return { search, cutShort: () => stopped };
}

/**
 * Artwork for a node from a Spotify search, only when the track found strictly matches the node:
 * its cover, its Spotify id and its preview. A loose match gives nothing (a click on the node then
 * searches its text). The preview is Spotify's own clip when the player may load it, else the
 * track is to be looked up on Deezer by its ISRC (`byIsrc`, when it has one). A failed search
 * gives nothing and caches nothing, so a later run tries again; a cancelled run rejects. `cached`
 * is a row that may not be served (with an id but no details): when the search fails or finds
 * nothing, it is kept.
 */
async function searchNode(
  node: NamedNode,
  cached: SpotifySearchResult | undefined,
  search: ReturnType<typeof spotifySearches>["search"],
  signal?: AbortSignal,
): Promise<NodeLookup> {
  const found = await search(node.label);
  if (found === "failed") return NOTHING;
  if (!found && cached) {
    // Searched again for a row without details and found nothing: it stays until it expires.
    signal?.throwIfAborted();
    return NOTHING;
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
  // names: its row keeps no identity, so a later run serves it as nothing and does not search.
  const other = !!found && marksOtherRecording(found.album, found.title);
  setCachedArtwork(node, other ? withoutId(artwork) : artwork);
  if (!found || !strictlyMatches(node, found)) return NOTHING;
  if (!releaseYearFits(node.label, found.releaseDate, node.year)) {
    return { artwork, previewUrl: null, byIsrc: null };
  }
  if (found.previewUrl && isAllowedPreviewUrl(found.previewUrl)) {
    return { artwork, previewUrl: found.previewUrl, byIsrc: null };
  }
  return { artwork, previewUrl: null, byIsrc: isrcRequest(found) };
}

// =============================================================================
// Artwork for the genealogy nodes
// =============================================================================

/** What was found for one node, by its id; a field is absent when nothing was found for it. */
export interface NodeArtwork {
  id: string;
  img?: string;
  previewUrl?: string;
  spotifyId?: string;
}

/** The artwork of a genealogy: an entry per node id, and whether every search was made. */
export interface GenealogyArtwork {
  nodes: NodeArtwork[];
  complete: boolean;
}

/** Spotify searches made at once; a short pause between batches keeps clear of its limits. */
const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = 100;

/**
 * Artwork for the genealogy nodes, by node id (see the module comment for what a node gets).
 *
 * The analysed track's node (the id "current") gets `currentTrackCoverUrl`. Every other node is
 * looked up by the title and artist the model named for it, and gets a cover, Spotify id and
 * preview only for that recording. Only the nodes that need a Spotify search take a turn in its
 * batches (a node served from the cache or naming no title or artist makes none). A node without
 * an id, or with an id an earlier node has, gets no entry: the answer is merged by id, so it could
 * not be told apart. A node whose lookup fails gets an entry without artwork; the other nodes keep
 * theirs. The answer holds no links and no node of its own. `complete` is false when the pass was
 * cut short (see spotifySearches): some nodes were not searched, so a later run may do better.
 *
 * @param genealogy - The composed genealogy, its nodes with the model's year when it gave one;
 *   only its nodes are read
 * @param currentTrackCoverUrl - The cover URL of the analysed track (already known)
 * @param signal - The run's abort signal: a cancelled run stops the Spotify and Deezer requests
 *   and rejects
 * @param report - Told once when Deezer could not be read for the node previews, for the run's
 *   source errors
 */
export async function enrichGenealogyWithArtwork(
  genealogy: { nodes?: readonly ArtworkNode[] } | undefined,
  currentTrackCoverUrl: string,
  signal?: AbortSignal,
  report?: (error: SourceError) => void,
): Promise<GenealogyArtwork> {
  const seen = new Set<string>();
  const nodes = (Array.isArray(genealogy?.nodes) ? genealogy.nodes : []).filter((node) => {
    if (!node?.id || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
  if (nodes.length === 0) return { nodes: [], complete: true };

  log.info(`Looking up artwork for ${nodes.length} genealogy nodes`);
  const deezer = deezerPreviews(signal, report);
  const searches = spotifySearches(signal);

  /** The node's entry: what `lookup` found, with the Deezer preview when it names one. */
  const entryOf = async (id: string, lookup: NodeLookup): Promise<NodeArtwork> => {
    const { artwork, previewUrl, byIsrc } = lookup;
    const preview = previewUrl ?? (byIsrc ? await deezer.lookUp(byIsrc) : null);
    return {
      id,
      ...(artwork.coverUrl ? { img: artwork.coverUrl } : {}),
      ...(preview ? { previewUrl: preview } : {}),
      ...(artwork.spotifyId ? { spotifyId: artwork.spotifyId } : {}),
    };
  };
  /**
   * A node whose lookup threw: source failures are handled where they happen, so what reaches
   * here is a bug. It is logged as an error, with its stack, and costs that node its artwork only.
   */
  const failed = (id: string, error: unknown): NodeArtwork => {
    log.error(`Could not look up the artwork of node "${id}"`, { err: error });
    return { id };
  };
  const guarded = async (id: string, task: () => Promise<NodeArtwork>): Promise<NodeArtwork> => {
    try {
      return await task();
    } catch (error) {
      // A cancelled run stops here: it reports nothing.
      if (signal?.aborted || isAbortError(error)) throw error;
      return failed(id, error);
    }
  };

  // Which nodes need a Spotify search is known before the first one: the cache is read at once.
  // A node served from the cache goes on to its Deezer lookup (if any) without waiting for a turn.
  const entries: Array<Promise<NodeArtwork>> = [];
  const toSearch: Array<{ at: number; node: ArtworkNode; cached?: SpotifySearchResult }> = [];
  nodes.forEach((node, at) => {
    const { id } = node;
    try {
      if (id === "current") {
        entries[at] = Promise.resolve(
          currentTrackCoverUrl ? { id, img: currentTrackCoverUrl } : { id },
        );
      } else if (!node.trackTitle?.trim() || !node.trackArtist?.trim()) {
        entries[at] = Promise.resolve({ id });
      } else {
        const cached = getCachedArtwork(node);
        if (cached && servable(cached)) {
          const lookup = fromCache(node, cached);
          entries[at] = guarded(id, () => entryOf(id, lookup));
        } else {
          toSearch.push({ at, node, cached });
        }
      }
    } catch (error) {
      entries[at] = Promise.resolve(failed(id, error));
    }
  });
  // Awaited below; until then a rejection (a cancelled run) must not go unhandled.
  const servedFirst = Promise.all(entries.filter(Boolean));
  servedFirst.catch(() => {});

  try {
    for (let i = 0; i < toSearch.length; i += BATCH_SIZE) {
      const batch = toSearch.slice(i, i + BATCH_SIZE).map(({ at, node, cached }) => {
        entries[at] = guarded(node.id, async () =>
          entryOf(node.id, await searchNode(node, cached, searches.search, signal)),
        );
        return entries[at];
      });
      await Promise.all(batch);
      if (i + BATCH_SIZE < toSearch.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }
    await servedFirst;
    const answer = await Promise.all(entries);
    log.info(`Found artwork for ${answer.filter((n) => n.img).length}/${answer.length} nodes`);
    return { nodes: answer, complete: !searches.cutShort() };
  } finally {
    deezer.done();
  }
}

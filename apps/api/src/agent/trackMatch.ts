/**
 * How well a Spotify search result matches what the user typed, judged on the title and the
 * artists only (Spotify no longer gives this app a popularity score). The scout uses it to order
 * the results, to decide whether a choice is needed and to flag a query that nothing matches.
 *
 * Text is compared after normalisation: compatibility decomposition, accents dropped, case
 * folded, "&" read as "and", and anything that is not a letter or a digit read as a space.
 * Letters of every script are kept, so a title such as "夜に駆ける" compares as itself.
 */

import type { SpotifyData } from "./state.js";

/**
 * - `exact`: the title equals the query, or the query is the title plus one of the credited
 *   artists.
 * - `partial`: every word of the title is in the query, or every word the query has left once a
 *   credited artist is taken out is in the title.
 * - `artist`: only a credited artist is named in the query.
 * - `none`: neither the title nor an artist matches.
 */
export type QueryMatch = "exact" | "partial" | "artist" | "none";

/** A search result with how it matches the query. */
export interface RankedTrack {
  track: SpotifyData;
  match: QueryMatch;
  /** The query names one of the track's credited artists. */
  artistNamed: boolean;
  /** A live take, remix, karaoke, cover or similar that the query did not ask for. */
  otherVersion: boolean;
}

/** The query's words, normalised; [] when nothing is left. */
export function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Words that mark another recording than the original when they appear in a title's bracketed
// or dashed suffix, or in the artist's name.
const VERSION_WORDS = new Set([
  "live",
  "remix",
  "remixed",
  "rmx",
  "mix",
  "acoustic",
  "karaoke",
  "instrumental",
  "cover",
  "covers",
  "demo",
  "unplugged",
  "sped",
  "slowed",
  "nightcore",
  "tribute",
  "rehearsal",
]);
const VERSION_PHRASES = [
  ["originally", "performed"],
  ["made", "famous"],
  ["in", "the", "style", "of"],
];

/** The title without bracketed parts and without a " - …" suffix, and what was removed. */
function splitTitle(title: string): { base: string; suffix: string } {
  const brackets = [...title.matchAll(/\([^)]*\)|\[[^\]]*\]/g)].map((m) => m[0]);
  let base = title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  const dash = base.search(/\s[-–—]\s/);
  let suffix = brackets.join(" ");
  if (dash >= 0) {
    suffix += ` ${base.slice(dash + 3)}`;
    base = base.slice(0, dash);
  }
  // A title made only of brackets keeps them as its base.
  return words(base).length > 0 ? { base, suffix } : { base: title, suffix: "" };
}

function hasSequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => haystack[i + j] === word)) return i;
  }
  return -1;
}

function marksVersion(text: string[], query: string[]): boolean {
  const asked = new Set(query);
  if (text.some((word) => VERSION_WORDS.has(word) && !asked.has(word))) return true;
  return VERSION_PHRASES.some(
    (phrase) => hasSequence(text, phrase) >= 0 && hasSequence(query, phrase) < 0,
  );
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i]);
}

function within(part: string[], whole: string[]): boolean {
  const set = new Set(whole);
  return part.length > 0 && part.every((word) => set.has(word));
}

/** The query's words with the first credited artist it names taken out, or null. */
function withoutArtist(query: string[], artists: string[]): string[] | null {
  for (const artist of artists) {
    const name = words(artist);
    // "The Beatles" is also named by "beatles".
    const forms = name[0] === "the" && name.length > 1 ? [name, name.slice(1)] : [name];
    for (const form of forms) {
      const at = hasSequence(query, form);
      if (at >= 0) {
        const rest = [...query.slice(0, at), ...query.slice(at + form.length)];
        return rest.filter((word, i) => !(word === "by" && (i === 0 || i === rest.length - 1)));
      }
    }
  }
  return null;
}

/** How one result matches the query. */
export function matchTrack(query: string, track: SpotifyData): Omit<RankedTrack, "track"> {
  const q = words(query);
  const artists = track.artistNames?.length ? track.artistNames : [track.artist];
  const { base, suffix } = splitTitle(track.title);
  const title = words(base);
  const fullTitle = words(track.title);
  const rest = withoutArtist(q, artists);
  const artistNamed = rest !== null;

  let match: QueryMatch = "none";
  if (
    sameWords(q, title) ||
    sameWords(q, fullTitle) ||
    (rest !== null && (sameWords(rest, title) || sameWords(rest, fullTitle)))
  ) {
    match = "exact";
  } else if (within(title, q) || within(rest ?? q, title)) {
    match = "partial";
  } else if (artistNamed) {
    match = "artist";
  }

  const otherVersion =
    marksVersion(words(suffix), q) || artists.some((artist) => marksVersion(words(artist), q));
  return { match, artistNamed, otherVersion };
}

const ORDER: Record<QueryMatch, number> = { exact: 0, partial: 1, artist: 2, none: 3 };

/**
 * The results best match first: an exact title before a partial one, a result whose artist the
 * query names before one it does not, and the original recording before another version.
 * Results that compare equal keep Spotify's order.
 */
export function rankTracks(query: string, tracks: SpotifyData[]): RankedTrack[] {
  return tracks
    .map((track, index) => ({ track, index, ...matchTrack(query, track) }))
    .sort(
      (a, b) =>
        ORDER[a.match] - ORDER[b.match] ||
        Number(b.artistNamed) - Number(a.artistNamed) ||
        Number(a.otherVersion) - Number(b.otherVersion) ||
        a.index - b.index,
    )
    .map(({ index: _index, ...ranked }) => ranked);
}

/** The same song: the same title (without its suffix) and at least one shared artist. */
function sameSong(a: SpotifyData, b: SpotifyData): boolean {
  const artists = (track: SpotifyData) =>
    (track.artistNames?.length ? track.artistNames : [track.artist]).map((name) =>
      words(name).join(" "),
    );
  const shared = artists(a).some((name) => artists(b).includes(name));
  return shared && sameWords(words(splitTitle(a.title).base), words(splitTitle(b.title).base));
}

/**
 * Whether the user has to choose among ranked results: nothing matches the query, or another
 * song (another title, or the same title by other artists) matches it as well as the best one.
 * Other versions of a song do not count, and neither does the same song released again.
 */
export function needsChoice(ranked: RankedTrack[]): boolean {
  const [best, ...others] = ranked;
  if (!best) return false;
  if (best.match === "none") return true;
  return others.some(
    (other) =>
      other.match === best.match &&
      other.artistNamed === best.artistNamed &&
      !other.otherVersion &&
      !sameSong(other.track, best.track),
  );
}

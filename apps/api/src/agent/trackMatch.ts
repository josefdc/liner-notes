/**
 * How well a Spotify search result matches what the user typed, judged on the title and the
 * artists only (Spotify no longer gives this app a popularity score). The scout uses it to order
 * the results, to decide whether the user has to choose and to flag a query nothing matches.
 *
 * A track is selected without asking only when the choice is clearly right: one song carries
 * exactly the title the query asks for, by the artist the query names (if it names one), and it
 * is the original recording unless the query asks for a version. Anything less is a choice for
 * the user: asking costs one click, a wrong recording costs a whole analysis of a song the user
 * did not ask for.
 *
 * Text is compared after normalisation: compatibility forms folded, accents of Latin letters
 * dropped, case folded, "&" and "+" read as "and", and anything that is not a letter or a digit
 * read as a space. Letters of every script are kept (and the marks of non-Latin scripts, so
 * "が" stays "が" and "й" stays "й"), and a Latin word written against CJK text is a word of
 * its own.
 */

import type { SpotifyData } from "./state.js";

/**
 * - `exact`: the query is the title (the whole title, the title without its bracketed or dashed
 *   suffix, or a bracketed alternative title such as the Korean one in "Gangnam Style
 *   (강남스타일)"), with any of the credited artists and joining words such as "feat." around it.
 * - `partial`: every word of the title is in the query, or every word the query has left once
 *   the credited artists are taken out is in the title.
 * - `artist`: only a credited artist is named in the query; the title does not match.
 * - `none`: neither the title nor an artist matches.
 */
export type QueryMatch = "exact" | "partial" | "artist" | "none";

/** A search result with how it matches the query. */
export interface RankedTrack {
  track: SpotifyData;
  match: QueryMatch;
  /** The track is credited to an artist the query names. */
  artistNamed: boolean;
  /** A live take, remix, karaoke, cover or similar that the query did not ask for. */
  otherVersion: boolean;
  /** Someone else performing a song: karaoke, a cover, a tribute, a fan edit. */
  coverVersion: boolean;
}

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const LATIN_BEFORE_CJK = new RegExp(`(\\p{Script=Latin})(?=[${CJK}])`, "gu");
const CJK_BEFORE_LATIN = new RegExp(`([${CJK}])(?=\\p{Script=Latin})`, "gu");
// Latin letters that have no decomposition.
const LETTERS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d" };

/** The text's words, normalised; [] when nothing is left. */
export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[øæœßłđ]/g, (letter) => LETTERS[letter] ?? letter)
    .replace(/['’‘`´]/g, "")
    .replace(/[&+]/g, " and ")
    .replace(LATIN_BEFORE_CJK, "$1 ")
    .replace(CJK_BEFORE_LATIN, "$1 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Words that join a title and its artists ("Stay with Justin Bieber", "Hurt by Johnny Cash");
// they are not compared.
const JOINERS = new Set(["feat", "ft", "featuring", "with", "x", "and", "by", "vs", "versus"]);

// Words of a title's suffix that mark another recording than the original.
const VERSION_WORDS = new Set([
  "live",
  "remix",
  "remixed",
  "rmx",
  "mix",
  "acoustic",
  "unplugged",
  "demo",
  "rehearsal",
  "karaoke",
  "instrumental",
  "piano",
  "cover",
  "covers",
  "tribute",
  "nightcore",
  "sped",
  "slowed",
  "reverb",
]);
const VERSION_PHRASES = [
  ["originally", "performed"],
  ["made", "famous"],
  ["in", "the", "style", "of"],
];
// Of those, the ones that mean someone else performs the song (the phrases above too).
const COVER_WORDS = new Set([
  "karaoke",
  "instrumental",
  "piano",
  "cover",
  "covers",
  "tribute",
  "nightcore",
  "sped",
  "slowed",
]);
// Labels of the original recording, not of another version.
const CANONICAL_LABELS = [
  ["original", "mix"],
  ["radio", "mix"],
  ["club", "mix"],
  ["extended", "mix"],
  ["single", "mix"],
  ["album", "mix"],
  ["main", "mix"],
  ["mono", "mix"],
  ["stereo", "mix"],
];
// An artist's name marks a catalogue of other recordings only with these: a band may be called
// "Live" or "Little Mix".
const ARTIST_MARKERS = [
  ["karaoke"],
  ["tribute"],
  ["in", "the", "style", "of"],
  ["originally", "performed"],
];
// Words that make a bracketed part a label ("Remastered 2011", "feat. X") instead of another
// title.
const LABEL_WORDS = new Set([
  ...VERSION_WORDS,
  "feat",
  "ft",
  "featuring",
  "with",
  "from",
  "prod",
  "remaster",
  "remastered",
  "version",
  "edit",
  "mono",
  "stereo",
  "single",
  "album",
  "radio",
  "original",
  "extended",
  "deluxe",
  "bonus",
  "explicit",
  "clean",
  "edition",
  "anniversary",
]);
// A bracket starting with one of these credits people; it never marks a version.
const CREDIT_WORDS = new Set(["feat", "ft", "featuring", "with", "prod", "from"]);

function indexOf(haystack: string[], needle: string[], from = 0): number {
  if (needle.length === 0) return -1;
  for (let i = from; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => haystack[i + j] === word)) return i;
  }
  return -1;
}

/** The words without any occurrence of `phrase`. */
function without(text: string[], phrase: string[]): string[] {
  let rest = text;
  for (let at = indexOf(rest, phrase); at >= 0; at = indexOf(rest, phrase, at)) {
    rest = [...rest.slice(0, at), ...rest.slice(at + phrase.length)];
  }
  return rest;
}

/** The words that are compared: joining words dropped, unless nothing else is left. */
function content(text: string[]): string[] {
  const kept = text.filter((word) => !JOINERS.has(word));
  return kept.length > 0 ? kept : text;
}

function same(a: string[], b: string[]): boolean {
  const x = content(a);
  const y = content(b);
  return a.length > 0 && x.length === y.length && x.every((word, i) => word === y[i]);
}

function within(part: string[], whole: string[]): boolean {
  const set = new Set(whole);
  return part.length > 0 && content(part).every((word) => set.has(word));
}

interface TitleParts {
  /** The title without bracketed parts and without a " - …" suffix. */
  base: string[];
  full: string[];
  /** Bracketed parts that are another title, not a label. */
  alternatives: string[][];
  /** The suffix words that may mark a version; credits such as "(feat. X)" are left out. */
  suffix: string[];
}

function titleParts(title: string): TitleParts {
  const brackets = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) =>
    words(m[1] ?? m[2] ?? ""),
  );
  let base = title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  let dashed: string[] = [];
  const dash = base.search(/\s[-–—]\s/);
  if (dash >= 0) {
    dashed = words(base.slice(dash + 3));
    base = base.slice(0, dash);
  }
  const full = words(title);
  const isLabel = (part: string[]) =>
    part.some((word) => LABEL_WORDS.has(word) || /^\d{4}$/.test(word));
  let suffix = [...brackets.filter((part) => !CREDIT_WORDS.has(part[0] ?? "")).flat(), ...dashed];
  for (const label of CANONICAL_LABELS) suffix = without(suffix, label);
  return {
    // A title made only of brackets keeps them.
    base: words(base).length > 0 ? words(base) : full,
    full,
    alternatives: brackets.filter((part) => part.length > 0 && !isLabel(part)),
    suffix,
  };
}

function artistsOf(track: SpotifyData): string[] {
  return track.artistNames?.length ? track.artistNames : [track.artist];
}

/** The ways a query can name an artist: the name, without a leading "The", run together. */
function nameForms(artist: string): string[][] {
  const name = words(artist);
  if (name.length === 0) return [];
  const forms = [name];
  if (name[0] === "the" && name.length > 1) forms.push(name.slice(1));
  if (name.length > 1) forms.push([name.join("")]);
  return forms;
}

/**
 * Whether the query names the artist: the whole name is in it, or the whole query is part of
 * the name ("Kanye" for Kanye West).
 */
function names(query: string[], artist: string): boolean {
  if (nameForms(artist).some((form) => indexOf(query, form) >= 0)) return true;
  const name = words(artist);
  const kept = content(query);
  return kept.length > 0 && kept.length < name.length && kept.every((w) => name.includes(w));
}

/** The query's words with every occurrence of the given artists taken out. */
function withoutArtists(query: string[], artists: string[]): string[] {
  let rest = query;
  for (const artist of artists) {
    for (const form of nameForms(artist)) rest = without(rest, form);
  }
  return rest;
}

/** How one result matches the query, given the artists the query names. */
function judge(
  query: string[],
  track: SpotifyData,
  named: Set<string>,
): Omit<RankedTrack, "track"> {
  const artists = artistsOf(track);
  const credited = artists.filter((artist) => named.has(artist));
  const artistNamed = credited.length > 0;
  const rest = withoutArtists(query, credited);
  const title = titleParts(track.title);
  const titles = [title.base, title.full, ...title.alternatives];

  // Version words the query asks for ("remix", "live") that are not part of the title itself.
  const titleWords = new Set([...title.base, ...title.alternatives.flat()]);
  const asked = rest.filter((word) => VERSION_WORDS.has(word) && !titleWords.has(word));
  const unasked = (text: string[]) => text.filter((word) => !asked.includes(word));

  let match: QueryMatch = "none";
  if (
    titles.some(
      (t) => same(query, t) || same(rest, t) || same(unasked(rest), t) || same(unasked(query), t),
    )
  ) {
    match = "exact";
  } else if (titles.some((t) => within(t, query) || within(rest, t))) {
    match = "partial";
  } else if (artistNamed) {
    match = "artist";
  }

  const askedWords = new Set(query);
  const artistMarked = artists.some((artist) =>
    ARTIST_MARKERS.some((marker) => indexOf(words(artist), marker) >= 0),
  );
  const marked =
    title.suffix.some((word) => VERSION_WORDS.has(word) && !askedWords.has(word)) ||
    VERSION_PHRASES.some(
      (phrase) => indexOf(title.suffix, phrase) >= 0 && indexOf(query, phrase) < 0,
    ) ||
    (artistMarked && !askedWords.has("karaoke") && !askedWords.has("tribute"));
  // When the query asks for a version, a result without it is another version.
  const lacksAsked = asked.some((word) => !title.suffix.includes(word));
  const coverVersion =
    artistMarked ||
    title.suffix.some((word) => COVER_WORDS.has(word)) ||
    VERSION_PHRASES.some((phrase) => indexOf(title.suffix, phrase) >= 0);
  return { match, artistNamed, otherVersion: marked || lacksAsked, coverVersion };
}

/** The credited artists, over all results, that the query names. */
function namedArtists(query: string[], tracks: SpotifyData[]): Set<string> {
  const named = new Set<string>();
  for (const track of tracks) {
    for (const artist of artistsOf(track)) if (names(query, artist)) named.add(artist);
  }
  return named;
}

/** How one result matches the query, taken alone. */
export function matchTrack(query: string, track: SpotifyData): Omit<RankedTrack, "track"> {
  const q = words(query);
  return judge(q, track, namedArtists(q, [track]));
}

const ORDER: Record<QueryMatch, number> = { exact: 0, partial: 1, artist: 2, none: 3 };

/**
 * The results best match first: a result credited to an artist the query names before any
 * other, then an exact title before a partial one, then the original recording (or the version
 * the query asks for) before other versions. Results that compare equal keep Spotify's order.
 */
export function rankTracks(query: string, tracks: SpotifyData[]): RankedTrack[] {
  const q = words(query);
  const named = namedArtists(q, tracks);
  return tracks
    .map((track, index) => ({ track, index, ...judge(q, track, named) }))
    .sort(
      (a, b) =>
        Number(b.artistNamed) - Number(a.artistNamed) ||
        ORDER[a.match] - ORDER[b.match] ||
        Number(a.otherVersion) - Number(b.otherVersion) ||
        a.index - b.index,
    )
    .map(({ index: _index, ...ranked }) => ranked);
}

/**
 * The same song: the same title (without its suffix), and the lead artist of one is credited
 * on the other (a featured artist on two songs does not make them one).
 */
function sameSong(a: SpotifyData, b: SpotifyData): boolean {
  const credits = (track: SpotifyData) => artistsOf(track).map((name) => words(name).join(" "));
  const [x, y] = [credits(a), credits(b)];
  const shared = y.includes(x[0] ?? "") || x.includes(y[0] ?? "");
  return shared && same(titleParts(a.title).base, titleParts(b.title).base);
}

/**
 * Whether the user has to choose among ranked results. A track is selected without asking only
 * when the best one carries the exact title, is the original recording (or the version the
 * query asks for), is credited to the artist the query names when it names one, and no other
 * song matches as well. Another song with the title is a rival even when it is a live take or a
 * remix, unless the query names the best one's artist and not the other's; karaoke, covers and
 * other recordings of the best one's song are not rivals.
 */
export function needsChoice(ranked: RankedTrack[]): boolean {
  const [best, ...others] = ranked;
  if (!best) return false;
  if (best.match !== "exact" || best.otherVersion) return true;
  if (!best.artistNamed && others.some((other) => other.artistNamed)) return true;
  return others.some(
    (other) =>
      other.match === "exact" &&
      (other.artistNamed || !best.artistNamed) &&
      !other.coverVersion &&
      !sameSong(other.track, best.track),
  );
}

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
  /** Where Spotify listed the result (0 first). */
  position: number;
  /**
   * The title may be the one the query means, spelt another way: most of its words match the
   * query's allowing for a dropped letter or a typo ("Don't Stop Believin'" for "Dont Stop
   * Believing"), or it is written in another script ("夜に駆ける" for "Yoru ni Kakeru").
   */
  similarTitle: boolean;
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
  "stripped",
  "orchestral",
  "symphonic",
  "acapella",
  "cappella",
  "session",
  "sessions",
  "rework",
  "reworked",
  "rerecorded",
  "vip",
  "bootleg",
]);
// Phrases that mean someone else performs the song.
const COVER_PHRASES = [
  ["originally", "performed"],
  ["made", "famous"],
  ["in", "the", "style", "of"],
];
const VERSION_PHRASES = [...COVER_PHRASES, ["re", "recorded"]];
// "Version" marks another recording ("Taylor's Version", "Versión Pop", "Glee Cast Version")
// unless a neighbouring word names the original release.
const ORIGINAL_RELEASE_WORDS = new Set([
  "single",
  "album",
  "radio",
  "original",
  "soundtrack",
  "main",
  "explicit",
  "clean",
  "mono",
  "stereo",
  "extended",
  "short",
  "long",
  "lp",
  "remaster",
  "remastered",
  "edit",
]);
// Of those, the ones that mean someone else performs the song (with COVER_PHRASES).
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
 * Whether the query names the artist: the whole name is in it, outside the part of the query
 * that is a title (so "Killer Queen" does not name Queen, nor "Bennie and the Jets" The Jets),
 * or the whole query is the name or part of it ("Kanye" for Kanye West).
 */
function names(query: string[], artist: string, span: [number, number] | null): boolean {
  for (const form of nameForms(artist)) {
    for (let at = indexOf(query, form); at >= 0; at = indexOf(query, form, at + 1)) {
      const whole = at === 0 && form.length === query.length;
      const inTitle = span !== null && at >= span[0] && at + form.length <= span[1];
      if (whole || !inTitle) return true;
    }
  }
  const name = words(artist);
  const kept = content(query);
  return kept.length > 0 && kept.length < name.length && kept.every((w) => name.includes(w));
}

/** The longest part of the query that is the title of one of the results (earliest on a tie). */
function titleSpan(query: string[], tracks: SpotifyData[]): [number, number] | null {
  let span: [number, number] | null = null;
  for (const track of tracks) {
    const title = titleParts(track.title);
    // The full title is left out: its credits ("(with Justin Bieber)") do name artists.
    for (const t of [title.base, ...title.alternatives]) {
      const at = indexOf(query, t);
      if (at < 0) continue;
      const longer = !span || t.length > span[1] - span[0];
      const earlier = span && t.length === span[1] - span[0] && at < span[0];
      if (longer || earlier) span = [at, at + t.length];
    }
  }
  return span;
}

/** The markers of another recording in a title's suffix. */
function versionMarkers(suffix: string[]): string[][] {
  const found = suffix.filter((word) => VERSION_WORDS.has(word)).map((word) => [word]);
  for (const phrase of VERSION_PHRASES) if (indexOf(suffix, phrase) >= 0) found.push(phrase);
  suffix.forEach((word, i) => {
    const original =
      ORIGINAL_RELEASE_WORDS.has(suffix[i - 1] ?? "") ||
      ORIGINAL_RELEASE_WORDS.has(suffix[i + 1] ?? "");
    if (word === "version" && !original) found.push(["version"]);
  });
  return found;
}

/** The query's words with every occurrence of the given artists taken out. */
function withoutArtists(query: string[], artists: string[]): string[] {
  let rest = query;
  for (const artist of artists) {
    for (const form of nameForms(artist)) rest = without(rest, form);
  }
  return rest;
}

// The scripts a word is written in: "latin", "cyrillic", "cjk" and so on.
const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
];

function scripts(text: string[]): Set<string> {
  const found = new Set<string>();
  for (const word of text) {
    for (const [name, pattern] of SCRIPTS) if (pattern.test(word)) found.add(name);
    if (/\p{L}/u.test(word) && !SCRIPTS.some(([, pattern]) => pattern.test(word))) {
      found.add("other");
    }
  }
  return found;
}

/** Levenshtein distance, stopping early once it exceeds `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Two words that may be one spelt two ways: equal, written for their sound ("2" and "to"), one
 * with an "s" added, one the start of the other ("believin" and "believing", from three
 * letters), or one letter apart in words of five letters or more ("rapsody" and "rhapsody").
 * "o" and "of", or "mine" and "my", are not.
 */
// Words written as letters or digits for their sound ("Nothing Compares 2 U", "thank u, next").
const SOUNDS_LIKE: Record<string, string[]> = {
  "2": ["to", "too", "two"],
  "4": ["for", "four"],
  u: ["you"],
  r: ["are"],
  n: ["and"],
  ur: ["your", "youre"],
};

function nearWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (SOUNDS_LIKE[a]?.includes(b) || SOUNDS_LIKE[b]?.includes(a)) return true;
  // A plural or possessive "s" ("Up" and "Ups").
  if (a === `${b}s` || b === `${a}s`) return true;
  const short = Math.min(a.length, b.length);
  if (short >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return short >= 5 && distance(a, b, 1) <= 1;
}

/** Whether most words of the longer of two titles match words of the other. */
function nearTitle(query: string[], title: string[]): boolean {
  const q = content(query);
  const t = content(title);
  if (q.length === 0 || t.length === 0) return false;
  const unused = [...t];
  let matched = 0;
  for (const word of q) {
    const at = unused.findIndex((other) => nearWord(word, other));
    if (at >= 0) {
      matched++;
      unused.splice(at, 1);
    }
  }
  return matched * 2 > Math.max(q.length, t.length);
}

/**
 * Whether a title may be the one the query means: near in spelling, or written in scripts the
 * query does not use at all (a romanised query cannot be compared with the original script).
 */
function similarTitle(query: string[], titles: string[][]): boolean {
  if (titles.some((t) => nearTitle(query, t))) return true;
  const asked = scripts(query);
  const own = scripts(titles.flat());
  return asked.size > 0 && own.size > 0 && [...own].every((script) => !asked.has(script));
}

/** How one result matches the query, given the artists the query names. */
function judge(
  query: string[],
  track: SpotifyData,
  named: Set<string>,
  position: number,
): Omit<RankedTrack, "track"> {
  const artists = artistsOf(track);
  const title = titleParts(track.title);
  const titles = [title.base, title.full, ...title.alternatives];
  // A query that is this track's title names no artist of it ("Bad Religion" by Bad Religion).
  const isTitle = [title.base, ...title.alternatives].some((t) => same(query, t));
  const credited = isTitle ? [] : artists.filter((artist) => named.has(artist));
  const artistNamed = credited.length > 0;
  const rest = withoutArtists(query, credited);

  // Version words the query asks for ("remix", "live") that are not part of the title itself.
  const titleWords = new Set([...title.base, ...title.alternatives.flat()]);
  const asked = rest.filter(
    (word) => (VERSION_WORDS.has(word) || word === "version") && !titleWords.has(word),
  );
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

  const artistMarked = artists.some((artist) =>
    ARTIST_MARKERS.some((marker) => indexOf(words(artist), marker) >= 0),
  );
  const marked =
    versionMarkers(title.suffix).some((marker) => indexOf(query, marker) < 0) ||
    (artistMarked && !query.includes("karaoke") && !query.includes("tribute"));
  // When the query asks for a version, a result without it is another version.
  const lacksAsked = asked.some((word) => !title.suffix.includes(word));
  const coverVersion =
    artistMarked ||
    title.suffix.some((word) => COVER_WORDS.has(word)) ||
    COVER_PHRASES.some((phrase) => indexOf(title.suffix, phrase) >= 0);
  return {
    match,
    artistNamed,
    otherVersion: marked || lacksAsked,
    coverVersion,
    position,
    similarTitle: similarTitle(query, titles),
  };
}

/** The credited artists, over all results, that the query names. */
function namedArtists(query: string[], tracks: SpotifyData[]): Set<string> {
  const span = titleSpan(query, tracks);
  const named = new Set<string>();
  for (const track of tracks) {
    for (const artist of artistsOf(track)) if (names(query, artist, span)) named.add(artist);
  }
  return named;
}

/** How one result matches the query, taken alone. */
export function matchTrack(query: string, track: SpotifyData): Omit<RankedTrack, "track"> {
  const q = words(query);
  return judge(q, track, namedArtists(q, [track]), 0);
}

const ORDER: Record<QueryMatch, number> = { exact: 0, partial: 1, artist: 2, none: 3 };

/**
 * Where a result goes in the list: a title match by an artist the query names, then any other
 * exact title or unmarked partial title, then the named artist's other songs, then other
 * versions that match the title only in part, then the rest. A marked cover that half matches
 * the title comes after the songs of the artist the query names.
 */
function tier(r: Omit<RankedTrack, "track">): number {
  const titled = r.match === "exact" || r.match === "partial";
  if (titled && r.artistNamed) return 0;
  if (r.match === "exact" || (r.match === "partial" && !r.otherVersion)) return 1;
  if (r.artistNamed) return 2;
  if (titled) return 3;
  return 4;
}

/**
 * The results best match first (see `tier`); within a tier an exact title before a partial
 * one, then the original recording (or the version the query asks for) before other versions.
 * Results that compare equal keep Spotify's order.
 */
export function rankTracks(query: string, tracks: SpotifyData[]): RankedTrack[] {
  const q = words(query);
  const named = namedArtists(q, tracks);
  return tracks
    .map((track, index) => ({ track, ...judge(q, track, named, index) }))
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        ORDER[a.match] - ORDER[b.match] ||
        Number(a.otherVersion) - Number(b.otherVersion) ||
        a.position - b.position,
    );
}

function credits(track: SpotifyData): string[] {
  return artistsOf(track).map((name) => words(name).join(" "));
}

/**
 * The same song: the same title (without its suffix), and the lead artist of one is credited
 * on the other (a featured artist on two songs does not make them one).
 */
function sameSong(a: SpotifyData, b: SpotifyData): boolean {
  const [x, y] = [credits(a), credits(b)];
  const shared = y.includes(x[0] ?? "") || x.includes(y[0] ?? "");
  return shared && same(titleParts(a.title).base, titleParts(b.title).base);
}

/**
 * Whether the user has to choose among ranked results. A track is selected without asking only
 * when the best one carries the exact title, is the original recording (or the version the
 * query asks for), and is credited to the artist the query names when it names one, and when no
 * other result (karaoke and covers aside) speaks against it:
 * - another song with the exact title, unless the query names the best one's artist and not
 *   the other's (a live take or a remix of another song counts);
 * - for a query that names no artist, any result by someone else whose title matches the query
 *   even in part ("...Baby One More Time" for "Hit Me Baby One More Time"), or may be the same
 *   title spelt another way or written in another script, wherever Spotify lists it: a cover
 *   spelt like the query may come before the original;
 * - a result Spotify lists before the best one, by someone else, that is not another version
 *   and that the query does not rule out: the original may be spelt differently from the query
 *   ("Don't Stop Believin'" for "Dont Stop Believing", "夜に駆ける" for "Yoru ni Kakeru").
 */
export function needsChoice(ranked: RankedTrack[]): boolean {
  const [best, ...others] = ranked;
  if (!best) return false;
  if (best.match !== "exact" || best.otherVersion) return true;
  // The query names an artist and the best match is not theirs ("Rihanna" and Yxng Bane's
  // song "Rihanna"): the best match by title ranks above the named artist's songs.
  if (!best.artistNamed && others.some((other) => other.artistNamed)) return true;
  const bestCredits = credits(best.track);
  const sharesArtist = (other: RankedTrack) =>
    credits(other.track).some((name) => bestCredits.includes(name));
  const sharesLead = (other: RankedTrack) => credits(other.track).includes(bestCredits[0] ?? "");
  const notRuledOut = (other: RankedTrack) => other.artistNamed || !best.artistNamed;
  return others.some((other) => {
    if (other.coverVersion) return false;
    if (other.match === "exact" && notRuledOut(other) && !sameSong(other.track, best.track)) {
      return true;
    }
    const titled = other.match === "exact" || other.match === "partial";
    if (!best.artistNamed && titled && !sharesLead(other)) return true;
    if (!best.artistNamed && other.similarTitle && !other.otherVersion && !sharesLead(other)) {
      return true;
    }
    return (
      other.position < best.position &&
      !other.otherVersion &&
      notRuledOut(other) &&
      !sharesArtist(other)
    );
  });
}

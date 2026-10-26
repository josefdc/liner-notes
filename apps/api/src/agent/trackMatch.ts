/**
 * How well a Spotify search result matches what the user typed, judged on the title and the
 * artists only (Spotify no longer gives this app a popularity score). The scout uses it to order
 * the results, to decide whether the user has to choose and to flag a query nothing matches.
 *
 * A track is selected without asking only when the choice is clearly right (see `needsChoice`
 * for exactly what is checked): the query names the artist; the best result by that artist has
 * exactly the title asked for, is not marked as another version, and adds nothing to the title
 * the query does not hold beyond known release labels; and no other take by that artist with the
 * title differs from it in title, ISRC or length, nor another recording with a different lead.
 * A query that names no artist always asks. Anything less is a choice for the user: asking
 * costs one click, a wrong recording costs a whole analysis of a song the user did not ask for.
 * When the user has to choose, the most likely original comes first (see `rankTracks`): the
 * track picker's countdown takes the first candidate.
 *
 * Text is compared after normalisation: compatibility forms folded, accents of Latin letters
 * dropped, case folded, "&" and "+" read as "and", and anything that is not a letter or a digit
 * read as a space. Letters of every script are kept (and the marks of non-Latin scripts, so
 * "が" stays "が" and "й" stays "й"), and a Latin word written against CJK text is a word of
 * its own.
 */

import type { QueryMatch } from "@liner-notes/contract";
import type { SpotifyData } from "./state.js";

/**
 * How a query matches a track; the result carries it (TrackAnalysis.queryMatch).
 * - `exact`: the query is the title (the whole title, the title without its bracketed or dashed
 *   suffix, or a bracketed alternative title such as the Korean one in "Gangnam Style
 *   (강남스타일)"), with any of the credited artists and joining words such as "feat." around it.
 * - `partial`: every word of the title is in the query, or every word the query has left once
 *   the credited artists are taken out is in the title.
 * - `artist`: only a credited artist is named in the query; the title does not match.
 * - `none`: neither the title nor an artist matches.
 */
export type { QueryMatch };

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
   * The title may be the one the query means even when spelt otherwise: a title match, most
   * words of a longer title, or a title in another script than the query.
   */
  near: boolean;
  /**
   * What the full title adds to the title proper once known labels of the original release
   * ("Remastered 2011", "Radio Edit", "Single Version", "Original Mix") and the artists the
   * query names are left out: "(2012)", "Take 7", "(with the Royal Philharmonic Orchestra)".
   */
  extraWords: string[];
  /** Every one of `extraWords` is in the query. */
  extraAsked: boolean;
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
  "take",
  "takes",
  "alternate",
  "outtake",
  "outtakes",
  "rerecord",
  "rerecording",
  "reprise",
  "interlude",
  "singalong",
  "remake",
]);
// Phrases that mean someone else performs the song.
const COVER_PHRASES = [
  ["originally", "performed"],
  ["made", "famous"],
  ["in", "the", "style", "of"],
];
const VERSION_PHRASES = [
  ...COVER_PHRASES,
  ["re", "recorded"],
  ["re", "record"],
  ["re", "recording"],
  ["new", "recording"],
  ["sing", "along"],
  ["en", "vivo"],
  ["ao", "vivo"],
  ["en", "directo"],
];
// An album name marks its tracks as another recording with these ("MTV Unplugged", "Eagles Live").
const ALBUM_MARKERS = [["live"], ["unplugged"], ["en", "vivo"], ["ao", "vivo"], ["en", "directo"]];
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

/** The words of an artist's name that are compared: joining words dropped. */
function content(text: string[]): string[] {
  const kept = text.filter((word) => !JOINERS.has(word));
  return kept.length > 0 ? kept : text;
}

// Titles are compared word for word: "With You" is not "You", nor "X&Y" "Y".
function same(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((word, i) => word === b[i]);
}

function within(part: string[], whole: string[]): boolean {
  const set = new Set(whole);
  return part.length > 0 && part.every((word) => set.has(word));
}

interface TitleParts {
  /** The title without bracketed parts and without a " - …" suffix. */
  base: string[];
  full: string[];
  /** Bracketed parts that are another title, not a label. */
  alternatives: string[][];
  /** The suffix words that may mark a version; credits such as "(feat. X)" are left out. */
  suffix: string[];
  /** Suffix parts naming where the recording comes from ("- From \"Frozen\""). */
  sources: string[][];
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
  // A credit ("(with Justin Bieber)") or a label ("(Remastered 2011)") is not another title; a
  // subtitle may still hold a joining word ("(A Deal With God)").
  const isLabel = (part: string[]) =>
    CREDIT_WORDS.has(part[0] ?? "") ||
    part.some((word) => (LABEL_WORDS.has(word) && !CREDIT_WORDS.has(word)) || /^\d{4}$/.test(word));
  let suffix = [...brackets.filter((part) => !CREDIT_WORDS.has(part[0] ?? "")).flat(), ...dashed];
  for (const label of CANONICAL_LABELS) suffix = without(suffix, label);
  return {
    // A title made only of brackets keeps them.
    base: words(base).length > 0 ? words(base) : full,
    full,
    alternatives: brackets.filter((part) => part.length > 0 && !isLabel(part)),
    suffix,
    sources: [...brackets, dashed].filter((part) => part[0] === "from"),
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
  // "The Beatles" may be "Beatles", but "The The" is never "The".
  const rest = name.slice(1);
  if (name[0] === "the" && rest.length > 0 && rest.join(" ") !== "the") forms.push(rest);
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

/**
 * The words with every occurrence of the given artists taken out, and the joining words next to
 * them ("by" in "Hurt by Johnny Cash", "with" in "Stay with Justin Bieber").
 */
function withoutArtists(text: string[], artists: string[]): string[] {
  const gone = text.map(() => false);
  for (const artist of artists) {
    for (const form of nameForms(artist)) {
      for (let at = indexOf(text, form); at >= 0; at = indexOf(text, form, at + 1)) {
        for (let i = at; i < at + form.length; i++) gone[i] = true;
      }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    text.forEach((word, i) => {
      if (!gone[i] && JOINERS.has(word) && (gone[i - 1] || gone[i + 1])) gone[i] = true;
    });
  }
  return text.filter((_, i) => !gone[i]);
}

// Labels of the original release that a full title may add to the title proper.
const RELEASE_LABELS = [
  ...CANONICAL_LABELS,
  ["radio", "edit"],
  ["single", "edit"],
  ["album", "edit"],
  ["single", "version"],
  ["album", "version"],
  ["radio", "version"],
  ["original", "version"],
  ["soundtrack", "version"],
  ["mono", "version"],
  ["stereo", "version"],
];
const RELEASE_WORDS = new Set(["remaster", "remastered", "explicit", "clean", "mono", "stereo"]);

/** See `RankedTrack.extraWords`. */
function extraWords(title: TitleParts, named: string[]): string[] {
  const sourced = title.sources.reduce((left, part) => without(left, part), title.full);
  let extra = withoutArtists(without(sourced, title.base), named);
  for (const label of RELEASE_LABELS) extra = without(extra, label);
  // A year is a label only next to a remaster ("Remastered 2011"); alone it may date a
  // re-recording ("(2012)").
  const remastered = extra.some((word) => word === "remaster" || word === "remastered");
  return extra.filter(
    (word) =>
      !RELEASE_WORDS.has(word) && !JOINERS.has(word) && !(remastered && /^\d{4}$/.test(word)),
  );
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
  // A marker counts as asked for only outside this track's own title: "Live and Let Die" does
  // not ask for a live take.
  const outside = [title.base, ...title.alternatives].reduce((left, t) => without(left, t), rest);
  // The album's name, without the title it may repeat ("Live And Let Die (album)").
  const album = without(words(track.album ?? ""), title.base);
  const marked =
    versionMarkers(title.suffix).some((marker) => indexOf(outside, marker) < 0) ||
    ALBUM_MARKERS.some((marker) => indexOf(album, marker) >= 0 && indexOf(outside, marker) < 0) ||
    (artistMarked && !query.includes("karaoke") && !query.includes("tribute"));
  // When the query asks for a version, a result without it is another version.
  const lacksAsked = asked.some((word) => !title.suffix.includes(word));
  const coverVersion =
    artistMarked ||
    title.suffix.some((word) => COVER_WORDS.has(word)) ||
    COVER_PHRASES.some((phrase) => indexOf(title.suffix, phrase) >= 0);
  // A title spelt otherwise than the query may still be the one it means: most words of a
  // title of three words or more are in the query, or the title is in another script.
  const latin = (text: string[]) => text.some((word) => /\p{Script=Latin}/u.test(word));
  const shared = title.base.filter((word) => rest.includes(word)).length;
  const near =
    match === "exact" ||
    match === "partial" ||
    (title.base.length >= 3 && shared >= title.base.length - 1) ||
    (latin(rest) && !latin(title.base) && title.base.length > 0);
  const extra = extraWords(title, credited);
  return {
    match,
    artistNamed,
    near,
    otherVersion: marked || lacksAsked,
    coverVersion,
    position,
    extraWords: extra,
    // Featured artists credited on the track may be left out of the query ("Crazy In Love
    // (feat. Jay-Z)"), and a version the query asks for may carry more words ("Live On MTV").
    extraAsked:
      extraWords(title, artists).every((word) => query.includes(word)) ||
      (asked.length > 0 && !lacksAsked),
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
 * exact title or unmarked title that may be the one meant (see `near`; with a named artist,
 * covers spelt like the title are only partial matches and come after it), then the named
 * artist's other songs, then other versions that match the title only in part, then the rest.
 * A marked cover that half matches the title comes after the songs of the artist the query
 * names.
 */
function tier(r: Omit<RankedTrack, "track">): number {
  const titled = r.match === "exact" || r.match === "partial";
  if (titled && r.artistNamed) return 0;
  if (r.match === "exact" || (r.near && !r.otherVersion)) return 1;
  if (r.artistNamed) return 2;
  if (titled) return 3;
  return 4;
}

// Among the other title matches, exact or respelt titles (in Spotify's order) before partial
// ones: the original spelt otherwise keeps its place ahead of covers spelt like the query.
const group = (r: Omit<RankedTrack, "track">) => (r.match === "partial" ? 1 : 0);

/**
 * The results best match first (see `tier`). Within the first tier an exact title comes before
 * a partial one; within the others an exact or respelt title (in Spotify's order) before a
 * partial one. Then the original recording (or the version the query asks for) before other
 * versions. Results that compare equal keep Spotify's order.
 */
export function rankTracks(query: string, tracks: SpotifyData[]): RankedTrack[] {
  const q = words(query);
  const named = namedArtists(q, tracks);
  return tracks
    .map((track, index) => ({ track, ...judge(q, track, named, index) }))
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        (tier(a) === 0 ? ORDER[a.match] - ORDER[b.match] : group(a) - group(b)) ||
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

/** The same take, as far as Spotify tells: ISRCs, and durations within 3 s, where both known. */
function sameTake(a: SpotifyData, b: SpotifyData): boolean {
  if (a.isrc && b.isrc && a.isrc !== b.isrc) return false;
  return !(a.durationMs > 0 && b.durationMs > 0 && Math.abs(a.durationMs - b.durationMs) > 3000);
}

/**
 * The line that asks the user to choose among `count` candidates, true for one candidate as
 * for several: "Spotify found one possible track; confirm it or search again", "Spotify found 3
 * possible tracks; choose one".
 */
export function choiceMessage(count: number): string {
  return count === 1
    ? "Spotify found one possible track; confirm it or search again"
    : `Spotify found ${count} possible tracks; choose one`;
}

/**
 * Whether the user has to choose among ranked results. A query that names no artist always
 * asks. A query that names an artist selects the best result without asking only when:
 * - its title is exactly the one the query asks for, it is credited to the named artist, and it
 *   is not marked as another version (live, remix, acoustic, karaoke, re-recording and the like,
 *   in its title or its album's name) unless the query asks for that version;
 * - everything its full title adds to the title (apart from known labels of the original
 *   release such as "Remastered 2011", "Radio Edit", "Single Version", "Original Mix", and the
 *   named artists) is in the query: "Rayando el Sol - En Vivo" or "Yesterday - Take 1" ask;
 * - no other result by a named artist with the exact title (covers aside) is another song,
 *   another recording with a different lead artist ("Tom's Diner" by DNA featuring Suzanne
 *   Vega), a take whose title adds something else ("(2012)", "(with the Royal Philharmonic
 *   Orchestra)"), or a take with the same title but another ISRC or a duration more than 3 s
 *   apart ("Come As You Are" from MTV Unplugged and from Nevermind).
 */
export function needsChoice(ranked: RankedTrack[]): boolean {
  const [best, ...others] = ranked;
  if (!best) return false;
  if (best.match !== "exact" || best.otherVersion || !best.artistNamed) return true;
  if (!best.extraAsked) return true;
  const bestCredits = credits(best.track);
  const sameLead = (other: RankedTrack) => credits(other.track)[0] === bestCredits[0];
  return others.some((other) => {
    if (other.coverVersion || !other.artistNamed || other.match !== "exact") return false;
    if (!sameSong(other.track, best.track) || !sameLead(other)) return true;
    if (other.otherVersion) return false;
    return (
      other.extraWords.join(" ") !== best.extraWords.join(" ") || !sameTake(other.track, best.track)
    );
  });
}

// Albums that hold other recordings of their songs: live, unplugged, re-recorded, karaoke,
// tribute, instrumental or sing-along releases. Read only when two catalogues are compared.
const RELEASE_MARKERS = [
  ...ALBUM_MARKERS,
  ["rerecorded"],
  ["re", "recorded"],
  ["rerecording"],
  ["re", "recording"],
  ["new", "recording"],
  ["new", "recordings"],
  ["karaoke"],
  ["tribute"],
  ["instrumental"],
  ["instrumentals"],
  ["sing", "along"],
  ["singalong"],
  ["covers"],
  ["in", "the", "style", "of"],
  ["originally", "performed"],
  ["made", "famous"],
  ["demos"],
  ["outtakes"],
  ["sessions"],
  ["concert"],
];
// Words of an album's bracketed or dashed part that name an edition of the same release.
const EDITION_WORDS = new Set([
  "deluxe",
  "super",
  "special",
  "expanded",
  "edition",
  "anniversary",
  "remaster",
  "remastered",
  "version",
  "bonus",
  "track",
  "tracks",
  "explicit",
  "clean",
  "mono",
  "stereo",
  "reissue",
  "collector",
  "collectors",
  "legacy",
]);
// Words of an edition label that make "Version" name an edition of the same release ("Deluxe
// Version"), not another recording ("2023 Version", "Taylor's Version").
const EDITION_VERSION_WORDS = new Set([
  "deluxe",
  "super",
  "special",
  "expanded",
  "anniversary",
  "remaster",
  "remastered",
  "edition",
]);
// Words of a credit part ("(with …)", "(feat. …)") that name an orchestra, strings or another
// ensemble: such a part marks another recording, not just another credit.
const ENSEMBLE_WORDS = new Set([
  "orchestra",
  "philharmonic",
  "philharmonia",
  "symphony",
  "symphonic",
  "sinfonia",
  "strings",
  "string",
  "quartet",
  "ensemble",
  "choir",
  "chorus",
  "orchestral",
]);
// A quoted work a title names as its source: `From "Frozen"`, `from “Encanto”`.
const QUOTED_SOURCE = /\bfrom\s+(?:"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’|«[^»]*»)/giu;

/**
 * How a title tells one recording from another, for comparing entries of two catalogues (a
 * Spotify track and a Deezer entry):
 * - `titles`: the title proper and the bracketed parts that read as another title (no label,
 *   version or credit word in them: "(강남스타일)", but also "(Part One)" or "(Reprise)");
 * - `extra`: the words of every other bracketed or " - " part, once credits, the quoted work a
 *   title comes from (`From "Frozen"`) and labels of the original release ("Remastered 2011",
 *   "Radio Edit", "Single Version") are left out. A "From …" part keeps its other words: "From
 *   "Frozen" / Instrumental" still says instrumental.
 */
interface RecordingTitle {
  base: string[];
  alternatives: string[][];
  extra: string[];
}

function recordingTitle(title: string): RecordingTitle {
  // A quoted work is left out only from the parts after the title proper (in brackets or after
  // " - "): in `Theme From "Jurassic Park"` it is the title itself.
  const starts = [title.search(/[([]/), title.search(/\s[-–—]\s/)].filter((at) => at >= 0);
  const properEnd = starts.length > 0 ? Math.min(...starts) : title.length;
  const unsourced = title.replace(QUOTED_SOURCE, (source, at: number) =>
    at < properEnd ? source : " ",
  );
  const brackets = [...unsourced.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  let rest = unsourced.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  const parts = [...brackets];
  const dash = rest.search(/\s[-–—]\s/);
  if (dash >= 0) {
    parts.push(rest.slice(dash + 3));
    rest = rest.slice(0, dash);
  }
  const base = words(rest).length > 0 ? words(rest) : words(unsourced);
  const alternatives: string[][] = [];
  const extra: string[] = [];
  for (const text of parts.flatMap((part) => part.split("/"))) {
    let part = words(text);
    if (part.length === 0) continue;
    // A credit is not a version, unless it names an orchestra, strings or an ensemble ("(with
    // the Royal Philharmonic Orchestra)", "- With Strings").
    if (CREDIT_WORDS.has(part[0]) && part[0] !== "from") {
      if (part.some((word) => ENSEMBLE_WORDS.has(word))) {
        extra.push(...part.filter((word) => !JOINERS.has(word) && !CREDIT_WORDS.has(word)));
      }
      continue;
    }
    // An unquoted "From …" may name a work or a session ("From The Basement"): all its words
    // count. Only a quoted work (`From "Frozen"`) was left out above.
    if (part[0] === "from") {
      extra.push(...part.slice(1));
      continue;
    }
    for (const label of RELEASE_LABELS) part = without(part, label);
    const remastered = part.some((word) => word === "remaster" || word === "remastered");
    part = part.filter((word) => !RELEASE_WORDS.has(word) && !(remastered && /^\d{4}$/.test(word)));
    if (part.length === 0) continue;
    const marked =
      part.some((word) => LABEL_WORDS.has(word) || /^\d{4}$/.test(word)) ||
      VERSION_PHRASES.some((phrase) => indexOf(part, phrase) >= 0);
    if (marked) extra.push(...part.filter((word) => !JOINERS.has(word)));
    else alternatives.push(part);
  }
  return { base, alternatives, extra };
}

/** The release markers of an album's name (see RELEASE_MARKERS), its own title left out. */
function releaseMarkers(album: string, base: string[]): string[] {
  const name = without(words(album), base);
  return RELEASE_MARKERS.filter((marker) => indexOf(name, marker) >= 0).map((m) => m.join(" "));
}

/** An album's name without the parts that name an edition ("(2011 Remaster)", "- Deluxe"). */
function albumName(album: string): string[] {
  const parts = [...album.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((m) => m[1] ?? m[2] ?? "");
  let rest = album.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  const dash = rest.search(/\s[-–—]\s/);
  if (dash >= 0) {
    parts.push(rest.slice(dash + 3));
    rest = rest.slice(0, dash);
  }
  const edition = (part: string) => {
    const label = words(part);
    const known = label.every(
      (word) => EDITION_WORDS.has(word) || /^\d+(?:st|nd|rd|th)?$/.test(word),
    );
    // "Version" alone with a year names another recording ("2023 Version").
    const version = !label.includes("version") || label.some((w) => EDITION_VERSION_WORDS.has(w));
    return known && version;
  };
  return [...words(rest), ...parts.filter((part) => !edition(part)).flatMap(words)];
}

/**
 * How two catalogue entries differ as recordings, judged on their titles and albums:
 * - `title`: no title of one is a title of the other;
 * - `version`: the titles agree but one is another version or take: it adds words the other
 *   lacks ("Live Aid 1985", "Alternate Take", "Re-Recorded", "Instrumental", "(2012)"), a part
 *   only one of them has ("(Part Two)", "(Reprise)"), or an album name that marks other
 *   recordings (live, re-recorded, karaoke, tribute, sing-along) that the other's lacks;
 * - null: nothing in the titles or album names tells them apart.
 * The comparison is strict on purpose: a version neither entry names can only be told apart by
 * other means (the album, the duration, the ISRC).
 */
export function recordingTitleDifference(
  a: { title: string; album?: string },
  b: { title: string; album?: string },
): "title" | "version" | null {
  const x = recordingTitle(a.title);
  const y = recordingTitle(b.title);
  const xTitles = [x.base, ...x.alternatives];
  const yTitles = [y.base, ...y.alternatives];
  if (!xTitles.some((t) => yTitles.some((u) => same(t, u)))) return "title";
  // A part read as another title must be a title of the other entry too.
  const shared = (own: string[][], other: string[][]) =>
    own.every((part) => other.some((t) => same(part, t)));
  if (!shared(x.alternatives, yTitles) || !shared(y.alternatives, xTitles)) return "version";
  return markedApart(a, x, b, y) ? "version" : null;
}

const sortedKey = (list: string[]) => [...list].sort().join(" ");

function markedApart(
  a: { album?: string },
  x: RecordingTitle,
  b: { album?: string },
  y: RecordingTitle,
): boolean {
  if (sortedKey(x.extra) !== sortedKey(y.extra)) return true;
  const xMarkers = releaseMarkers(a.album ?? "", x.base);
  const yMarkers = releaseMarkers(b.album ?? "", y.base);
  return sortedKey(xMarkers) !== sortedKey(yMarkers);
}

/**
 * Whether one entry is marked as another version than the other (see recordingTitleDifference),
 * whatever their titles: for two entries that share an ISRC, whose titles may be written in
 * different scripts but whose versions must still agree.
 */
export function markedAsOtherVersion(
  a: { title: string; album?: string },
  b: { title: string; album?: string },
): boolean {
  return markedApart(a, recordingTitle(a.title), b, recordingTitle(b.title));
}

/**
 * Whether both entries carry part titles ("(Part One)", "- II. Allegretto") and none of them is
 * shared: two parts of one work, or two movements. A part title on one side only ("Gangnam
 * Style (강남스타일)") does not tell them apart.
 */
export function partTitlesDiffer(a: { title: string }, b: { title: string }): boolean {
  const x = recordingTitle(a.title).alternatives;
  const y = recordingTitle(b.title).alternatives;
  return x.length > 0 && y.length > 0 && !x.some((part) => y.some((other) => same(part, other)));
}

const SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u,
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Devanagari}/u,
];

/**
 * Whether two titles are written in a common script (Japanese kana and kanji count as one). Two
 * titles in different scripts ("夜に駆ける" and "Yoru ni Kakeru") cannot be compared word for
 * word.
 */
export function shareScript(a: string, b: string): boolean {
  return SCRIPTS.some((script) => script.test(a) && script.test(b));
}

/**
 * Whether two titles can be compared word for word: they share a script, or one of them has no
 * letters at all ("505", "1999"), so its digits are the same in any script.
 */
export function comparableTitles(a: string, b: string): boolean {
  return shareScript(a, b) || !/\p{L}/u.test(a) || !/\p{L}/u.test(b);
}

/**
 * Whether two album names are the same release once edition labels are left out ("A Night At
 * The Opera (2011 Remaster)" and "A Night At The Opera (Deluxe Edition)"). Unknown names never
 * match.
 */
export function sameAlbumName(a: string | undefined, b: string | undefined): boolean {
  return same(albumName(a ?? ""), albumName(b ?? ""));
}

/** Whether two artist names are the same name once normalised (a leading "The" may be left out). */
export function sameArtistName(a: string, b: string): boolean {
  const x = nameForms(a);
  const y = nameForms(b);
  return x.some((form) => y.some((other) => same(form, other)));
}

/**
 * What a claim says of a relation between two records (a sample, a cover, a remix, an
 * interpolation), read from its words by a few strict templates. A claim's relation is known only
 * when the whole claim is one of them, once the records' names, the analysed track's names and a
 * short list of words that name nothing are taken out:
 *
 * - `<one> samples|covers|remixes|interpolates <other>`: the first draws on the second (also
 *   "sampled", "is sampling", "does sample", "is a cover of", "is a remix of", "is an
 *   interpolation of");
 * - `<one> is sampled|covered|remixed|interpolated by|in <other>`: the second draws on the
 *   first, "by" or "in" coming right after the verb;
 * - either of them with "also" once before the verb or among its auxiliaries ("also samples",
 *   "is also sampled in");
 * - `<source> documents|lists|credits|records <one> as a sample in|on <other>`: the second
 *   draws on the first; `… <one> as a cover|remix of <other>`: the first draws on the second;
 *   `… <one> as [a source] sampled|covered|remixed|interpolated in|by <other>`: the second draws
 *   on the first; `… <one> with|as sampling|covering|remixing|interpolating <other>`: the first
 *   draws on the second; `… a version of <one> by <other> as a cover|remix`: the second draws on
 *   the first. The source is the cited record's own (MusicBrainz, Discogs, Genius,
 *   SecondHandSongs), or "the record" or "a record" for any; the preposition alone gives the
 *   direction ("a sample of", which reads either way, is not one).
 * - `<one> contains|features|uses|is built on|is based on a sample of|samples of|a cover of|a
 *   remix of <other>`: the first draws on the second ("was built on", "was based on" too).
 *
 * Any of them may end "according to <source>", the source the cited records' own as above.
 *
 * One side is the analysed track (its title, its artist, "this recording", "this track", "the
 * song", "the song's work", "this recording of <its title>"); the other names one or more of the
 * records the claim cites ("A and B", a list "A, B and C" or "A, B, and C"), each by its title,
 * with or without its artist ("Mtume's Juicy Fruit", "Juicy Fruit by Mtume"), or by its artist
 * alone when no other record of the result has that artist; a cover by its artist alone only
 * when the track is named by more than its artist ("Daft Punk is covered by …" says which artist
 * is covered, not which song). An artist is its whole credit (its featured artist joined by
 * "feat.", "ft." or "featuring"), or the main or a featured artist of one ("Drake" in "Drake
 * feat. 21 Savage"), never a part joined by "&", "and" or a comma ("Simon" in "Simon &
 * Garfunkel": `artistNames`). A list is read with its commas (`readRelations`): a name holding a
 * comma ("Earth, Wind & Fire") is then not read in a list. Anything else is unknown: a word of its own, a relative
 * clause ("the track that Juicy samples"), an adverb ("sampled heavily by"), "sampled on", "has
 * X sampled in it", a hedge or a negation, a second relation word, a name the claim does not
 * cite. A relation word or a negation inside a name is part of the name ("Cover Me", "No
 * Scrubs"). An unknown claim is read as stating nothing: doubt keeps it as it is.
 *
 * A claim on records of the song may add sentences that only say the relation is the song's ("This
 * relationship is attached to the song's work, not specifically to this recording":
 * `readStatedRelations`), as its records do.
 *
 * To mark a claim (and only to mark it), `readMarkedRelations` also reads it a sentence at a
 * time: one sentence states its records' relations, whole or before a comma, and the others and
 * what follows that comma only add detail (no "?", no relation word but one that refers back to
 * the relation stated, "around that sample", no hedge, doubting word or unknown capitalised
 * name). A sentence that disputes the
 * relation in words none of those lists holds can still let a partly supported claim be marked;
 * the mark then names only the relation its record documents, and the claim's own verdict shows
 * beside it.
 */

import { normalizeName } from "../sources/musicbrainz.js";
import { normalizeArtist, normalizeTitle, type RelationKind } from "../sources/records.js";

/** The map's link type of a relation kind. */
export type LinkType = "sample" | "interpolation" | "cover" | "remix";

export const LINK_TYPE: Record<RelationKind, LinkType> = {
  samples: "sample",
  "sampled-by": "sample",
  interpolates: "interpolation",
  "interpolated-by": "interpolation",
  "cover-of": "cover",
  "covered-by": "cover",
  "remix-of": "remix",
  "remixed-by": "remix",
};

/** True for a kind whose other record draws on this one (it samples, covers … this one). */
export const otherDrawsOn = (kind: RelationKind) => kind.endsWith("-by");

/**
 * Each relation's verb: its active forms ("samples"), its base form (after "does"), its past
 * participle (passive before "by" or "in") and its noun ("a cover of"), if it has one a
 * statement uses so.
 */
const VERBS: Record<
  LinkType,
  { active: string[]; base: string; participle: string; noun?: string }
> = {
  sample: { active: ["samples", "sampled", "sampling"], base: "sample", participle: "sampled" },
  interpolation: {
    active: ["interpolates", "interpolated", "interpolating"],
    base: "interpolate",
    participle: "interpolated",
    noun: "interpolation",
  },
  cover: {
    active: ["covers", "covered", "covering"],
    base: "cover",
    participle: "covered",
    noun: "cover",
  },
  remix: {
    active: ["remixes", "remixed", "remixing"],
    base: "remix",
    participle: "remixed",
    noun: "remix",
  },
};
/** Every relation word, in every form, with the link type it names. */
const RELATION_WORDS = new Map<string, LinkType>();
for (const [type, verb] of Object.entries(VERBS) as [LinkType, (typeof VERBS)[LinkType]][]) {
  for (const word of [...verb.active, verb.base, verb.participle, verb.noun ?? ""]) {
    if (word !== "") RELATION_WORDS.set(word, type);
  }
}
/** The words that make a past participle passive when they come right after it. */
const PASSIVE_MARKERS: ReadonlySet<string> = new Set(["by", "in"]);
/** Auxiliaries before a relation's verb. */
const AUXILIARIES: ReadonlySet<string> = new Set(
  "is was are were has have had been be does did do".split(" "),
);
const DO: ReadonlySet<string> = new Set(["do", "does", "did"]);
/** Words before a name that name nothing ("the", "this"). */
const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an", "this"]);
/** Words that name the analysed track, or stand before a title ("the song …"). */
const NOUNS: ReadonlySet<string> = new Set(["recording", "track", "song", "work"]);

/**
 * Words that deny or hedge what a statement says: it is never read as stating its relation, nor
 * as restating a record. Whole words, outside the names the statement holds; "n't" too.
 */
export const HEDGES: ReadonlySet<string> = new Set(
  (
    "nothing none neither nor without never not no cannot allegedly reportedly rumoured rumored " +
    "supposedly wrongly falsely mistakenly claimed disputed"
  ).split(" "),
);

/** Words that name nothing on their own: a name made only of them cannot tell a record apart. */
const NAMELESS: ReadonlySet<string> = new Set(
  (
    "a an the it its this that these those in on at by of and as for to with from his her " +
    "their our s is was song recording track work"
  ).split(" "),
);

/**
 * `text` with the marks that do not change a letter dropped, as names are compared: the accents
 * of Latin letters ("Beyoncé" reads "Beyonce") and Greek tonos ("Ρόδα" reads "Ροδα"); "ß" reads
 * "ss" and the dotless "ı" reads "i". In another script a combining mark changes the letter
 * (the dakuten of バ is not decoration on ハ, "Й" is not "И"), and is kept.
 */
export const foldText = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/(\p{Script=Latin}|\p{Script=Greek})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/ß/gu, "ss")
    .replace(/ẞ/gu, "SS")
    .replace(/ı/gu, "i");

/** A statement's words as names are compared (`normalizeName`, after `foldText`). */
export const nameWords = (text: string) => normalizeName(foldText(text)).split(" ").filter(Boolean);

/**
 * True when a name can be told apart in a statement: two letters or more ("U2", "MØ"), and not
 * only words that name nothing on their own ("It", "The") or a relation's word ("Sample").
 */
export const telling = (name: readonly string[]) =>
  name.join("").length >= 2 &&
  !name.every((word) => NAMELESS.has(word) || RELATION_WORDS.has(word));

/** A title without a bracketed subtitle at its end ("Are You My Woman? (Tell Me So)"). */
const SUBTITLE = /\s*[([][^()[\]]*[)\]]\s*$/u;

/**
 * The ways a statement may name a title: as `normalizeTitle` reads it (without featured-artist
 * and remaster suffixes), and without its bracketed subtitle; each one that can be told apart.
 */
export function titleNames(title: string): string[][] {
  return distinctNames([
    normalizeTitle(foldText(title)),
    normalizeTitle(foldText(title.replace(SUBTITLE, ""))),
  ]);
}

/** Where a credit names the artists it features ("A feat. B", "A ft. B", "A featuring B"). */
const FEATURING = /\s+(?:feat\.?|ft\.?|featuring)\s+/iu;
/** The words a credit may join a featured artist with, as a statement may write it. */
const FEATURING_WORDS = ["feat.", "ft.", "featuring"];

/**
 * The ways a statement may name an artist: the whole credit (`normalizeArtist`), written with
 * any of the words for a featured artist ("Coldplay featuring Richard Ashcroft" for "Coldplay
 * feat. Richard Ashcroft"), its main artist before a featured one ("Drake" for "Drake feat. 21
 * Savage"), and each featured artist (a list split on commas). "&", "and" and a comma in the main
 * credit stay: an excerpt does not tell "Simon & Garfunkel" or "Earth, Wind & Fire" (one artist)
 * from "Drake & 21 Savage" (two), so a part of such a credit names nothing on its own and a claim
 * naming one stays. Each name that can be told apart.
 */
export function artistNames(artist: string): string[][] {
  const [main, ...featured] = artist.split(FEATURING);
  const parts = [main, ...featured.flatMap((list) => list.split(/\s*,\s*/u))];
  const credits =
    featured.length === 0
      ? [artist]
      : [artist, ...FEATURING_WORDS.map((word) => [main, ...featured].join(` ${word} `))];
  return distinctNames([
    ...credits.map((credit) => normalizeArtist(foldText(credit))),
    ...parts.map((part) => normalizeArtist(foldText(part))),
  ]);
}

function distinctNames(names: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const name of names) {
    if (name === "" || out.some((each) => each.join(" ") === name)) continue;
    const words = name.split(" ");
    if (telling(words)) out.push(words);
  }
  return out;
}

/** A record a claim cites, as the reader names it. */
export interface NamedRecord {
  id: string;
  kind: RelationKind;
  title: string;
  /** The record's other side, as one key (title and artist), to tell two records apart. */
  key: string;
  titles: string[][];
  artists: string[][];
  /** The source of the record (`Evidence.source`), when known. */
  source?: string;
  /** A record of the song (`work/…`), not of this recording alone. */
  ofSong?: boolean;
}

/** The analysed track's names. */
export interface TrackNames {
  titles: string[][];
  artists: string[][];
}

/** What a run of a statement's words names: the analysed track, cited records, or both. */
interface Span {
  trackTitle: boolean;
  trackArtist: boolean;
  /** The cited records whose title it is. */
  titleOf: Set<string>;
  /** The cited records whose artist (or one of whose credited artists) it is. */
  artistOf: Set<string>;
  /** The words, as an artist name is looked up (`artistIndex`). */
  words: string;
  /** A name of another record of the result (`readMarkedRelations`). */
  other: boolean;
}
type Item = { span: Span } | { word: string };

interface Name {
  words: string[];
  role: "trackTitle" | "trackArtist" | "title" | "artist" | "other";
  id?: string;
}

/**
 * A statement's words with each name taken as one item: at each word the longest name that
 * starts there (every name of that length counts for the item), else the word.
 */
function itemsOf(words: readonly string[], names: readonly Name[]): Item[] {
  const byFirst = new Map<string, Name[]>();
  for (const name of names) {
    const first = name.words[0];
    byFirst.set(first, [...(byFirst.get(first) ?? []), name]);
  }
  const items: Item[] = [];
  let at = 0;
  while (at < words.length) {
    let longest = 0;
    let found: Name[] = [];
    for (const name of byFirst.get(words[at]) ?? []) {
      const length = name.words.length;
      if (length < longest || at + length > words.length) continue;
      if (!name.words.every((word, i) => words[at + i] === word)) continue;
      if (length > longest) {
        longest = length;
        found = [];
      }
      found.push(name);
    }
    if (longest === 0) {
      items.push({ word: words[at] });
      at++;
      continue;
    }
    const span: Span = {
      trackTitle: false,
      trackArtist: false,
      titleOf: new Set(),
      artistOf: new Set(),
      words: words.slice(at, at + longest).join(" "),
      other: false,
    };
    for (const name of found) {
      if (name.role === "trackTitle") span.trackTitle = true;
      else if (name.role === "trackArtist") span.trackArtist = true;
      else if (name.role === "other") span.other = true;
      else if (name.role === "title") span.titleOf.add(name.id as string);
      else span.artistOf.add(name.id as string);
    }
    items.push({ span });
    at += longest;
  }
  return items;
}

const wordOf = (item: Item | undefined) => (item && "word" in item ? item.word : undefined);
const spanOf = (item: Item | undefined) => (item && "span" in item ? item.span : undefined);

/** True when a statement's words, outside its names, deny or hedge what it says. */
function hedgedItems(items: readonly Item[]): boolean {
  return items.some((item, i) => {
    const word = wordOf(item);
    if (word === undefined) return false;
    if (HEDGES.has(word)) return true;
    // "isn't", "doesn't", "ain't": the apostrophe splits off a "t".
    if (word === "t" && (wordOf(items[i - 1]) ?? "").endsWith("n")) return true;
    return word === "said" && wordOf(items[i - 1]) === "often";
  });
}

/**
 * True when `text` denies or hedges what it says (`HEDGES`), outside `names` (each written as a
 * statement may write it): a negation inside a name ("No Scrubs") is part of the name.
 */
export function hedged(text: string, names: readonly string[]): boolean {
  const known: Name[] = names.flatMap((name) => {
    const words = nameWords(name);
    return words.length > 0 ? [{ words, role: "title" as const, id: "" }] : [];
  });
  return hedgedItems(itemsOf(nameWords(text), known));
}

/**
 * One side of a statement's relation: the analysed track (`byArtist` when only its artist names
 * it), or the cited records it names.
 */
type Side = { track: true; byArtist: boolean } | { records: string[] };

/** What reading a statement needs beyond its words. */
export interface ReadingContext {
  track: TrackNames;
  /** The records the statement cites, by id. */
  cited: ReadonlyMap<string, NamedRecord>;
  /**
   * The other sides of the result's records (its relation records and its map's tracks) by each
   * artist name they credit: an artist names one record alone only when it credits one.
   */
  artistIndex: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The cited records a group of items names: a title, with its artist before it ("Mtume's") or
 * after it ("by Mtume", or written next to it), or an artist alone; or the analysed track (its
 * names, "this recording"). Null when it cannot be told.
 */
function resolveGroup(
  artists: Span[],
  title: Span | undefined,
  noun: boolean,
  context: ReadingContext,
): Side | null {
  const one = (ids: Iterable<string>): Side | null => {
    const records = [...ids];
    const keys = new Set(records.map((id) => context.cited.get(id)?.key));
    return records.length > 0 && keys.size === 1 ? { records } : null;
  };
  if (title && (title.titleOf.size > 0 || title.trackTitle)) {
    // A title the analysed track shares (a cover's), named alone, is the analysed track's; a
    // title of under three letters ("Up") names a record only with its artist.
    const short = title.words.replace(/ /gu, "").length < 3;
    const others =
      (title.trackTitle || short) && artists.length === 0
        ? []
        : [...title.titleOf].filter((id) => artists.every((artist) => artist.artistOf.has(id)));
    const track = title.trackTitle && artists.every((artist) => artist.trackArtist);
    if (others.length > 0 && track) return null;
    if (others.length > 0) return one(others);
    return track ? { track: true, byArtist: false } : null;
  }
  // An artist alone (the title span may be an artist's name).
  const named = title ? [...artists, title] : artists;
  if (named.length === 0) return noun ? { track: true, byArtist: false } : null;
  if (named.length > 1) return null;
  const [artist] = named;
  if (artist.trackArtist && artist.artistOf.size === 0) return { track: true, byArtist: !noun };
  if (artist.trackArtist || artist.artistOf.size === 0) return null;
  // Only when no other record of the result credits this artist.
  if ((context.artistIndex.get(artist.words)?.size ?? 0) > 1) return null;
  return one(artist.artistOf);
}

/** The item a comma between two names of a list reads as (`listWords`). */
const LIST_COMMA = ",";

/**
 * A side of a statement: the analysed track once, or one or more cited records ("A and B", "A,
 * B and C", "A, B, and C"). The track may be named by a noun ("this recording", "the song", "the
 * song's work"), and a noun may name its title ("this recording of One More Time"). Null when any
 * of its words is not a name, an article, a noun that names the track, the possessive "s", "of"
 * between a noun and a title, "by" between a title and its artist, or "and" or a comma between
 * two records.
 */
function readSide(items: readonly Item[], context: ReadingContext): Side | null {
  const records: string[] = [];
  let track = false;
  let byArtist = true;
  let at = 0;
  while (at < items.length) {
    if (records.length > 0) {
      if (wordOf(items[at]) === LIST_COMMA) at++;
      if (wordOf(items[at]) === "and") at++;
    }
    while (ARTICLES.has(wordOf(items[at]) ?? "")) at++;
    const artists: Span[] = [];
    let noun = false;
    const possessive = spanOf(items[at]);
    if (possessive && wordOf(items[at + 1]) === "s") {
      artists.push(possessive);
      at += 2;
    }
    while (NOUNS.has(wordOf(items[at]) ?? "")) {
      noun = true;
      at++;
      // "the song's work".
      if (wordOf(items[at]) === "s" && NOUNS.has(wordOf(items[at + 1]) ?? "")) at++;
    }
    const named = spanOf(items[at + 1]);
    if (
      noun &&
      wordOf(items[at]) === "of" &&
      named &&
      (named.titleOf.size > 0 || named.trackTitle)
    ) {
      at++;
    }
    const title = spanOf(items[at]);
    if (title) {
      at++;
      const after = wordOf(items[at]) === "by" ? spanOf(items[at + 1]) : spanOf(items[at]);
      if (after && (after.artistOf.size > 0 || after.trackArtist)) {
        artists.push(after);
        at += wordOf(items[at]) === "by" ? 2 : 1;
      }
    }
    if (!title && artists.length === 0 && !noun) return null;
    const side = resolveGroup(artists, title, noun, context);
    if (side === null) return null;
    if ("track" in side) {
      track = true;
      byArtist &&= side.byArtist;
    } else records.push(...side.records);
  }
  if (track && records.length > 0) return null;
  if (track) return { track: true, byArtist };
  return records.length > 0 ? { records } : null;
}

/**
 * The cited records whose relation `text` states, as each record documents it (its link type
 * and its direction); null when the statement is not one of the templates (see the module
 * comment), denies or hedges, names a record its citations do not, or states another relation
 * or the other direction for a record it names. A cover is stated only with its title named, or
 * with the analysed track named by more than its artist ("the song's work").
 *
 * A statement is read as `nameWords` splits it, and when that reads nothing, again with its
 * commas kept (`listWords`): a list ("sampled in A, B and C") names its records one by one, each
 * name between two commas whole.
 */
export function readRelations(text: string, context: ReadingContext): Set<string> | null {
  const read = readRelationItems(nameWords(text), context);
  if (read !== null || !text.includes(",")) return read;
  return readRelationItems(listWords(text), context);
}

/**
 * A statement's words as `nameWords` splits them, with a comma item (`LIST_COMMA`) where the
 * statement has a comma: a name never runs across one.
 */
const listWords = (text: string) =>
  text
    .split(",")
    .flatMap((part, i) => (i === 0 ? nameWords(part) : [LIST_COMMA, ...nameWords(part)]));

/** `readRelations` on a statement's words. */
function readRelationItems(words: readonly string[], context: ReadingContext): Set<string> | null {
  const all = itemsOf(words, namesOf(context));
  if (hedgedItems(all)) return null;
  // "…, according to MusicBrainz": the source it names must be each record's own.
  const according = accordingTo(all);
  const items = according ? according.items : all;

  // The one relation word outside the names, and the verb it makes.
  const verbs = items.flatMap((item, i) => (RELATION_WORDS.has(wordOf(item) ?? "") ? [i] : []));
  if (verbs.length !== 1) return null;
  const [at] = verbs;
  const word = wordOf(items[at]) as string;
  const type = RELATION_WORDS.get(word) as LinkType;
  const verb = VERBS[type];
  // The words before and after the relation, and whether the first side draws on the second.
  let first: readonly Item[];
  let second: readonly Item[];
  let firstDraws: boolean;
  const documented =
    documentedForm(items, at, word, type) ??
    containsForm(items, at, word, type) ??
    versionForm(items, at, word, type);
  if (documented) {
    ({ first, second, firstDraws } = documented);
  } else {
    let start = at;
    let end = at + 1;
    let passive = false;
    const article = wordOf(items[at - 1]);
    if (
      word === verb.noun &&
      (article === "a" || article === "an") &&
      wordOf(items[at + 1]) === "of"
    ) {
      start = at - 1;
      end = at + 2;
    } else if (word === verb.participle && PASSIVE_MARKERS.has(wordOf(items[at + 1]) ?? "")) {
      passive = true;
      end = at + 2;
    } else if (
      word === verb.base
        ? !DO.has(article === "also" ? (wordOf(items[at - 2]) ?? "") : (article ?? ""))
        : !verb.active.includes(word)
    ) {
      return null;
    }
    // The auxiliaries before the verb, and "also" once among them ("is also sampled in").
    let also = false;
    for (;;) {
      const before = wordOf(items[start - 1]) ?? "";
      if (AUXILIARIES.has(before)) start--;
      else if (before === "also" && !also) {
        also = true;
        start--;
      } else break;
    }
    first = items.slice(0, start);
    second = items.slice(end);
    // Active: the left side draws on the right; passive: the right on the left.
    firstDraws = !passive;
  }

  const left = readSide(first, context);
  const right = readSide(second, context);
  if (left === null || right === null) return null;
  const [one, other] = "track" in left ? [left, right] : [right, left];
  if (!("track" in one) || !("records" in other)) return null;
  const trackDraws = one === left ? firstDraws : !firstDraws;
  const stated = new Set<string>();
  for (const id of other.records) {
    const record = context.cited.get(id) as NamedRecord;
    if (LINK_TYPE[record.kind] !== type || otherDrawsOn(record.kind) === trackDraws) return null;
    // A source the statement names must be the record's own.
    if (documented?.source != null && documented.source !== record.source) return null;
    if (according?.source != null && according.source !== record.source) return null;
    // "Daft Punk is covered by …" says an artist is covered, not which song.
    const titled = items.some((item) => spanOf(item)?.titleOf.has(id));
    if (type === "cover" && one.byArtist && !titled) return null;
    stated.add(id);
  }
  return stated;
}

/** The names a statement may hold: the analysed track's and the cited records'. */
function namesOf(context: ReadingContext): Name[] {
  const names: Name[] = [
    ...context.track.titles.map((words) => ({ words, role: "trackTitle" as const })),
    ...context.track.artists.map((words) => ({ words, role: "trackArtist" as const })),
  ];
  for (const record of context.cited.values()) {
    for (const words of record.titles) names.push({ words, role: "title", id: record.id });
    for (const words of record.artists) names.push({ words, role: "artist", id: record.id });
  }
  return names;
}

/**
 * The sources a "record documents" statement starts with ("MusicBrainz lists …"), each with the
 * `Evidence.source` it must match; "the record" and "a record" match any.
 */
const SOURCES: readonly { words: readonly string[]; source: string | null }[] = [
  { words: ["musicbrainz"], source: "musicbrainz" },
  { words: ["discogs"], source: "discogs" },
  { words: ["genius"], source: "genius" },
  { words: ["secondhandsongs"], source: "secondhandsongs" },
  // No record of the result comes from WhoSampled: a statement naming it reads as unknown.
  { words: ["whosampled"], source: "whosampled" },
  { words: ["the", "record"], source: null },
  { words: ["a", "record"], source: null },
];
/** The source names a statement may write capitalised ("MusicBrainz"). */
const SOURCE_NAMES: ReadonlySet<string> = new Set(
  SOURCES.filter((each) => each.source !== null).map((each) => each.words.join(" ")),
);
/** The verbs of a "record documents" statement. */
const DOCUMENTS: ReadonlySet<string> = new Set(["documents", "lists", "credits", "records"]);
/**
 * The words after "as a sample|cover|remix" that join it to the second side, and whether the
 * first side draws on the second: "<one> as a sample in|on <two>" (two samples one), "<one> as a
 * cover|remix of <two>" (one covers or remixes two). The preposition alone gives the direction;
 * "a sample of" reads either way ("material sampled in", "material taken from"), so it is not one.
 */
const AS_A: Partial<Record<LinkType, { joins: ReadonlySet<string>; firstDraws: boolean }>> = {
  sample: { joins: new Set(["in", "on"]), firstDraws: false },
  cover: { joins: new Set(["of"]), firstDraws: true },
  remix: { joins: new Set(["of"]), firstDraws: true },
};

/** The two sides of a statement's relation, as a form other than the plain verb reads them. */
interface FormSides {
  first: readonly Item[];
  second: readonly Item[];
  firstDraws: boolean;
  source: string | null;
}

/**
 * The source a "record documents" statement starts with, and where the words after its verb
 * ("documents", "lists", "credits", "records") start; null for a statement that starts otherwise.
 */
function documentingSource(items: readonly Item[]): { source: string | null; from: number } | null {
  const named = SOURCES.find(({ words }) => words.every((each, i) => wordOf(items[i]) === each));
  if (!named || !DOCUMENTS.has(wordOf(items[named.words.length]) ?? "")) return null;
  return { source: named.source, from: named.words.length + 1 };
}

/**
 * The two sides of a "record documents" statement, its relation word at `at`; null for another
 * form. `<source> documents|lists|credits|records`, then:
 * - `<one> as a sample|cover|remix <join> <two>` (`AS_A`);
 * - `<one> as [a source] sampled|covered|remixed|interpolated in|by <two>`: two draws on one;
 * - `<one> with|as sampling|covering|remixing|interpolating <two>`: one draws on two.
 */
function documentedForm(
  items: readonly Item[],
  at: number,
  word: string,
  type: LinkType,
): FormSides | null {
  const documenting = documentingSource(items);
  if (!documenting) return null;
  const { source, from } = documenting;
  const verb = VERBS[type];
  const before = (n: number) => wordOf(items[at - n]);
  const next = wordOf(items[at + 1]) ?? "";
  const form = AS_A[type];
  if (form && word === verb.base) {
    if (before(1) !== "a" || before(2) !== "as" || !form.joins.has(next)) return null;
    return {
      first: items.slice(from, at - 2),
      second: items.slice(at + 2),
      firstDraws: form.firstDraws,
      source,
    };
  }
  if (word === verb.participle && PASSIVE_MARKERS.has(next)) {
    const as =
      before(1) === "as"
        ? at - 1
        : before(1) === "source" && before(2) === "a" && before(3) === "as"
          ? at - 3
          : -1;
    if (as === -1) return null;
    return { first: items.slice(from, as), second: items.slice(at + 2), firstDraws: false, source };
  }
  if (verb.active.includes(word) && word.endsWith("ing")) {
    if (before(1) !== "with" && before(1) !== "as") return null;
    return {
      first: items.slice(from, at - 1),
      second: items.slice(at + 1),
      firstDraws: true,
      source,
    };
  }
  return null;
}

/**
 * The two sides of `<source> documents|lists|credits|records a version of <one> by <two> as a
 * cover|remix`, its relation word last: two (named by what follows the first "by") covers or
 * remixes one. Null for another form.
 */
function versionForm(
  items: readonly Item[],
  at: number,
  word: string,
  type: LinkType,
): FormSides | null {
  if ((type !== "cover" && type !== "remix") || word !== VERBS[type].noun) return null;
  if (at !== items.length - 1 || wordOf(items[at - 1]) !== "a" || wordOf(items[at - 2]) !== "as")
    return null;
  const documenting = documentingSource(items);
  if (!documenting) return null;
  const { source, from } = documenting;
  const opening = ["a", "version", "of"];
  if (!opening.every((each, i) => wordOf(items[from + i]) === each)) return null;
  const of = from + opening.length;
  const by = items.findIndex((item, i) => i > of && i < at - 2 && wordOf(item) === "by");
  if (by === -1) return null;
  return {
    first: items.slice(by + 1, at - 2),
    second: items.slice(of, by),
    firstDraws: true,
    source,
  };
}

/** The verbs of a "<one> contains a sample of <other>" statement. */
const CONTAINS: readonly (readonly string[])[] = [
  "contains",
  "features",
  "uses",
  "is built on",
  "is based on",
  "was built on",
  "was based on",
].map((phrase) => phrase.split(" "));

/**
 * The two sides of `<one> contains|features|uses|is built on|is based on a sample of|samples
 * of|a cover of|a remix of <other>`, its relation word at `at`: the first draws on the second
 * (the track that contains a sample of another samples it). Null for another form.
 */
function containsForm(
  items: readonly Item[],
  at: number,
  word: string,
  type: LinkType,
): FormSides | null {
  if (wordOf(items[at + 1]) !== "of") return null;
  let start: number;
  if (type === "sample" && word === "samples") start = at;
  else if (
    (word === "sample" && type === "sample") ||
    ((type === "cover" || type === "remix") && word === VERBS[type].noun)
  ) {
    if (wordOf(items[at - 1]) !== "a") return null;
    start = at - 1;
  } else return null;
  const verb = CONTAINS.find(
    (words) =>
      start >= words.length &&
      words.every((each, i) => wordOf(items[start - words.length + i]) === each),
  );
  if (!verb) return null;
  return {
    first: items.slice(0, start - verb.length),
    second: items.slice(at + 2),
    firstDraws: true,
    source: null,
  };
}

/**
 * A statement that ends "according to <source>": its words before that, and the source it names
 * (null for "the record"). Null for a statement that does not end so.
 */
function accordingTo(items: readonly Item[]): { items: Item[]; source: string | null } | null {
  for (const { words, source } of SOURCES) {
    const at = items.length - words.length - 2;
    if (at < 1) continue;
    if (wordOf(items[at]) !== "according" || wordOf(items[at + 1]) !== "to") continue;
    if (!words.every((each, i) => wordOf(items[at + 2 + i]) === each)) continue;
    // The comma before it, as a list is read (`listWords`).
    const end = wordOf(items[at - 1]) === LIST_COMMA ? at - 1 : at;
    return { items: items.slice(0, end), source };
  }
  return null;
}

/** Words after which a full stop ends no sentence ("feat.", "Mr."), as a single initial does. */
const ABBREVIATIONS: ReadonlySet<string> = new Set(
  "feat ft mr dr no vol jr sr st mt vs e.g i.e etc".split(" "),
);

/**
 * A statement's sentences: split after ".", ";" or "!" followed by a space, but not after an
 * abbreviation (`ABBREVIATIONS`) or a single capital letter ("Ben E. King", "B.I.G."), and not
 * inside a quoted title ("…" or “…”). Its cost grows with the square of a run of stops that end no
 * sentence; it reads only claims the judge checked, which are at most 1,000 characters long.
 */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let curly = 0;
  let straight = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\u201c") curly++;
    else if (char === "\u201d") curly = Math.max(0, curly - 1);
    else if (char === '"') straight = !straight;
    else if (
      (char === "." || char === ";" || char === "!") &&
      curly === 0 &&
      !straight &&
      /\s/u.test(text[i + 1] ?? "")
    ) {
      if (char === ".") {
        const before = text.slice(start, i);
        const word = /([\p{L}.]+)$/u.exec(before)?.[1]?.toLowerCase() ?? "";
        const last = /(\p{L}+)$/u.exec(before)?.[1] ?? "";
        if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(last.toLowerCase())) continue;
        if (/^\p{Lu}$/u.test(last)) continue;
      }
      sentences.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest !== "") sentences.push(rest);
  return sentences;
}

/**
 * Stems of words that hedge, dispute or deny what a statement says ("a myth", "denies it",
 * "may be"): a word that starts with one, outside the names, makes a sentence more than detail.
 * "According" too: whom a statement holds to say it is no detail the reader can check.
 */
const DOUBTS: readonly string[] = (
  "myth untrue wrong false mistak disput deni deny doubt unconfirm unverif rumor rumour alleg " +
  "reported supposed claim contest withdraw retract opposite revers may might perhaps possibl " +
  "probabl unclear uncertain incorrect inaccura otherwise instead could likely unlikely unsure " +
  "questionab contradict according"
).split(" ");
/** Phrases that do the same. */
const DOUBTING_PHRASES: readonly string[][] = [
  "other way round",
  "other way around",
  "or so",
  "fans say",
].map((phrase) => phrase.split(" "));

/** Words that start a tail which goes on with the relation's names rather than adding detail. */
const TAIL_CONTINUES: ReadonlySet<string> = new Set(["by", "of", "from", "and", "with", "plus"]);

/** A statement's words as `nameWords` splits them, with their case kept. */
const casedWords = (text: string) =>
  foldText(text)
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** The words that refer back to the relation a claim states ("that sample", "this cover"). */
const BACK_REFERENCES: ReadonlySet<string> = new Set(["the", "this", "that"]);
/** Words after a back-reference that would tie it to something else ("the sample of …"). */
const TIES: ReadonlySet<string> = new Set(["of", "from", "by", "in", "on", "into", "at", "with"]);

/**
 * True when the relation word at `at` refers back to a relation the claim states (of `types`):
 * its noun ("sample", "cover", "remix", "interpolation") after "the" or "this", or after "that"
 * at the end of the sentence ("around that sample"; "chords that sample …" relates), and not
 * followed by a name or a word that ties it to something else ("the sample of …", "the sample
 * from …").
 */
function refersBack(items: readonly Item[], at: number, types: ReadonlySet<LinkType>): boolean {
  const word = wordOf(items[at]) ?? "";
  const type = RELATION_WORDS.get(word);
  if (type === undefined || !types.has(type)) return false;
  if (word !== (VERBS[type].noun ?? VERBS[type].base)) return false;
  const opening = wordOf(items[at - 1]) ?? "";
  if (!BACK_REFERENCES.has(opening)) return false;
  const after = items[at + 1];
  if (after === undefined) return true;
  if (opening === "that" || spanOf(after)) return false;
  return !TIES.has(wordOf(after) ?? "");
}

/**
 * True when a sentence beside the one that states a claim's relation adds only detail: no "?",
 * no relation word but one that refers back to the relation it states (`refersBack`: "around
 * that sample"), no hedge or negation (`HEDGES`), no word starting with a doubting stem
 * (`DOUBTS`) or doubting phrase, and no capitalised word outside the names it knows (`names`:
 * the analysed track's, the cited records' and the result's other records') but its first word
 * and the name of the cited records' source ("MusicBrainz"), so no name of a record the result does not hold
 * ("Between the Sheets by The Isley Brothers") or of a person ("Dr. Dre disputes this"). A
 * `tail` (what follows the comma after a stated relation) gets no exception for its first word,
 * and may not start with a word that goes on naming records ("by", "and", "with" …).
 */
function onlyDetail(
  sentence: string,
  names: readonly Name[],
  sources: ReadonlySet<string>,
  types: ReadonlySet<LinkType>,
  tail = false,
): boolean {
  if (sentence.includes("?")) return false;
  const words = nameWords(sentence);
  // A tail that goes on with the relation's names ("…, by Mtume's rival") is not detail.
  if (tail && TAIL_CONTINUES.has(words[0] ?? "")) return false;
  const cased = casedWords(sentence);
  if (cased.length !== words.length) return false;
  const items = itemsOf(words, names);
  if (hedgedItems(items)) return false;
  const plain = items.flatMap((item) =>
    wordOf(item) === undefined ? [] : [wordOf(item) as string],
  );
  const relates = items.some(
    (item, i) => RELATION_WORDS.has(wordOf(item) ?? "") && !refersBack(items, i, types),
  );
  if (relates) return false;
  if (plain.some((word) => DOUBTS.some((stem) => word.startsWith(stem)))) return false;
  const doubting = (phrase: readonly string[]) =>
    items.some((_, i) => phrase.every((word, j) => wordOf(items[i + j]) === word));
  if (DOUBTING_PHRASES.some(doubting)) return false;
  // Another record's name, and a capitalised word no name holds.
  let at = 0;
  for (const item of items) {
    const span = spanOf(item);
    if (span) {
      const another =
        span.other &&
        !span.trackTitle &&
        !span.trackArtist &&
        span.titleOf.size === 0 &&
        span.artistOf.size === 0;
      if (another) return false;
      at += span.words.split(" ").length;
      continue;
    }
    const word = cased[at];
    const first = at === 0 && !tail;
    if (!first && /^\p{Lu}/u.test(word) && !sources.has(word.toLowerCase())) return false;
    at++;
  }
  return true;
}

/**
 * A sentence that says only that a relation is the song's, not this recording's ("This
 * relationship is attached to the song's work, not specifically to this recording"), as
 * `nameWords` splits it. It restates only where a record of the song (`work/…`) puts the relation.
 */
const SONG_SCOPE =
  /^(?:this|the) (?:relationship|relation|link|connection) (?:is|was) (?:attached|linked|tied) to the (?:song s )?work(?: not (?:specifically |directly )?to (?:this|the) recording)?$/u;

/**
 * The cited records whose relation a statement states and nothing else: the whole of it as
 * `readRelations` reads it; or, when each record it cites is of the song (`ofSong`), exactly one
 * of its sentences reading each cited record's relation while every other sentence only says
 * that the relation is the song's (`SONG_SCOPE`), which the records say too. Null otherwise.
 */
export function readStatedRelations(text: string, context: ReadingContext): Set<string> | null {
  const whole = readRelations(text, context);
  if (whole !== null) return whole;
  const records = [...context.cited.values()];
  if (records.length === 0 || !records.every((record) => record.ofSong)) return null;
  let stated: Set<string> | null = null;
  for (const sentence of sentencesOf(text)) {
    const read = readRelations(sentence, context);
    if (read !== null && read.size === context.cited.size && stated === null) stated = read;
    else if (!SONG_SCOPE.test(nameWords(sentence).join(" "))) return null;
  }
  return stated;
}

/**
 * How a sentence states each cited record's relation: whole (`readRelations`), or as a template
 * followed by a comma and a tail ("…, bringing the earlier song into Madonna's dance track"),
 * the tail to be read as detail. Each comma outside a quoted title is tried in turn, so a comma
 * inside a name ("Tyler, The Creator") only ever ends a part that does not read. Null when no
 * part of it states them.
 */
function statingPart(
  sentence: string,
  context: ReadingContext,
): { stated: Set<string>; tail: string | null } | null {
  const reads = (part: string) => {
    const read = readRelations(part, context);
    return read !== null && read.size === context.cited.size ? read : null;
  };
  const whole = reads(sentence);
  if (whole !== null) return { stated: whole, tail: null };
  let curly = 0;
  let straight = false;
  for (let i = 0; i < sentence.length; i++) {
    const char = sentence[i];
    if (char === "\u201c") curly++;
    else if (char === "\u201d") curly = Math.max(0, curly - 1);
    else if (char === '"') straight = !straight;
    else if (char === "," && curly === 0 && !straight) {
      const read = reads(sentence.slice(0, i));
      if (read !== null) return { stated: read, tail: sentence.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * The cited records whose relation a statement states, for marking it: the whole statement as
 * `readRelations` reads it, or exactly one of its sentences reading each cited record's relation
 * (whole, or before a comma and a tail: `statingPart`) while every other sentence, and the tail,
 * only adds detail (`onlyDetail`). Null otherwise. Leaving a claim out, or letting it stand for
 * another, still needs the whole statement to be read.
 *
 * What is left: a sentence that disputes the relation in words none of these lists holds ("the
 * band replayed the riff") still lets a claim be marked. The mark names only the relation its
 * record documents, which is true of the record, and the claim's own verdict ("Partly supported")
 * and kind still show beside it.
 */
export function readMarkedRelations(
  text: string,
  context: ReadingContext,
  others: readonly (readonly string[])[],
): Set<string> | null {
  const whole = readStatedRelations(text, context);
  if (whole !== null) return whole;
  let stated: Set<string> | null = null;
  const rest: string[] = [];
  const tails: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const read = statingPart(sentence, context);
    if (read !== null) {
      if (stated !== null) return null;
      stated = read.stated;
      if (read.tail !== null) tails.push(read.tail);
    } else {
      rest.push(sentence);
    }
  }
  if (stated === null) return null;
  const names: Name[] = [
    ...namesOf(context),
    ...others.map((words) => ({ words: [...words], role: "other" as const })),
  ];
  // The source the cited records come from may be named; another is no record's word for it.
  const sourceOf = [...context.cited.values()].map((record) => record.source);
  const sources = new Set(
    [...SOURCE_NAMES].filter((name) => sourceOf.every((source) => source === name)),
  );
  const types = new Set([...context.cited.values()].map((record) => LINK_TYPE[record.kind]));
  const detail =
    rest.every((sentence) => onlyDetail(sentence, names, sources, types)) &&
    tails.every((tail) => onlyDetail(tail, names, sources, types, true));
  return detail ? stated : null;
}

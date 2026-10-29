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
 *   first, "by" or "in" coming right after the verb.
 *
 * One side is the analysed track (its title, its artist, "this recording", "the song"); the other
 * names one or more of the records the claim cites, each by its title, with or without its
 * artist ("Mtume's Juicy Fruit", "Juicy Fruit by Mtume"), or by its artist alone when no other
 * record of the result has that artist. Anything else is unknown: a word of its own, a relative
 * clause ("the track that Juicy samples"), an adverb ("sampled heavily by"), "sampled on", "has
 * X sampled in it", a hedge or a negation, a second relation word, a name the claim does not
 * cite. A relation word or a negation inside a name is part of the name ("Cover Me", "No
 * Scrubs"). An unknown claim is read as stating nothing: doubt keeps it as it is.
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

/** The credits an artist name joins ("Drake & 21 Savage", "A feat. B", "A, B and C"). */
const CREDIT_JOINS = /\s*(?:&|,|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\band\b)\s*/iu;

/**
 * The ways a statement may name an artist: the whole credit (`normalizeArtist`), and each artist
 * it credits on its own ("Drake" for "Drake & 21 Savage"); each one that can be told apart.
 */
export function artistNames(artist: string): string[][] {
  return distinctNames([
    normalizeArtist(foldText(artist)),
    ...artist.split(CREDIT_JOINS).map((part) => normalizeArtist(foldText(part))),
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
}
type Item = { span: Span } | { word: string };

interface Name {
  words: string[];
  role: "trackTitle" | "trackArtist" | "title" | "artist";
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
    };
    for (const name of found) {
      if (name.role === "trackTitle") span.trackTitle = true;
      else if (name.role === "trackArtist") span.trackArtist = true;
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

/** One side of a statement's relation: the analysed track, or the cited records it names. */
type Side = { track: true } | { records: string[] };

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
    // A title the analysed track shares (a cover's), named alone, is the analysed track's.
    const others =
      title.trackTitle && artists.length === 0
        ? []
        : [...title.titleOf].filter((id) => artists.every((artist) => artist.artistOf.has(id)));
    const track = title.trackTitle && artists.every((artist) => artist.trackArtist);
    if (others.length > 0 && track) return null;
    if (others.length > 0) return one(others);
    return track ? { track: true } : null;
  }
  // An artist alone (the title span may be an artist's name).
  const named = title ? [...artists, title] : artists;
  if (named.length === 0) return noun ? { track: true } : null;
  if (named.length > 1) return null;
  const [artist] = named;
  if (artist.trackArtist && artist.artistOf.size === 0) return { track: true };
  if (artist.trackArtist || artist.artistOf.size === 0) return null;
  // Only when no other record of the result credits this artist.
  if ((context.artistIndex.get(artist.words)?.size ?? 0) > 1) return null;
  return one(artist.artistOf);
}

/**
 * A side of a statement: the analysed track once, or one or more cited records ("A and B").
 * Null when any of its words is not a name, an article, a noun that names the track, the
 * possessive "s", "by" between a title and its artist, or "and" between two records.
 */
function readSide(items: readonly Item[], context: ReadingContext): Side | null {
  const records: string[] = [];
  let track = false;
  let at = 0;
  while (at < items.length) {
    if (records.length > 0 && wordOf(items[at]) === "and") at++;
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
    if ("track" in side) track = true;
    else records.push(...side.records);
  }
  if (track && records.length > 0) return null;
  if (track) return { track: true };
  return records.length > 0 ? { records } : null;
}

/**
 * The cited records whose relation `text` states, as each record documents it (its link type
 * and its direction); null when the statement is not one of the templates (see the module
 * comment), denies or hedges, names a record its citations do not, or states another relation
 * or the other direction for a record it names. A cover is stated only with its title named.
 */
export function readRelations(text: string, context: ReadingContext): Set<string> | null {
  const names: Name[] = [
    ...context.track.titles.map((words) => ({ words, role: "trackTitle" as const })),
    ...context.track.artists.map((words) => ({ words, role: "trackArtist" as const })),
  ];
  for (const record of context.cited.values()) {
    for (const words of record.titles) names.push({ words, role: "title", id: record.id });
    for (const words of record.artists) names.push({ words, role: "artist", id: record.id });
  }
  const items = itemsOf(nameWords(text), names);
  if (hedgedItems(items)) return null;

  // The one relation word outside the names, and the verb it makes.
  const verbs = items.flatMap((item, i) => (RELATION_WORDS.has(wordOf(item) ?? "") ? [i] : []));
  if (verbs.length !== 1) return null;
  const [at] = verbs;
  const word = wordOf(items[at]) as string;
  const type = RELATION_WORDS.get(word) as LinkType;
  const verb = VERBS[type];
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
  } else if (word === verb.base ? !DO.has(article ?? "") : !verb.active.includes(word)) {
    return null;
  }
  while (AUXILIARIES.has(wordOf(items[start - 1]) ?? "")) start--;

  const left = readSide(items.slice(0, start), context);
  const right = readSide(items.slice(end), context);
  if (left === null || right === null) return null;
  const [one, other] = "track" in left ? [left, right] : [right, left];
  if (!("track" in one) || !("records" in other)) return null;
  // Active: the left side draws on the right; passive: the right on the left.
  const trackDraws = passive ? one === right : one === left;
  const stated = new Set<string>();
  for (const id of other.records) {
    const record = context.cited.get(id) as NamedRecord;
    if (LINK_TYPE[record.kind] !== type || otherDrawsOn(record.kind) === trackDraws) return null;
    if (type === "cover" && !items.some((item) => spanOf(item)?.titleOf.has(id))) return null;
    stated.add(id);
  }
  return stated;
}

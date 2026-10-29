/**
 * One claim per fact. Once the model's claims and the code-built ones (codeClaims.ts) are judged
 * side by side, some state the same fact twice: the model restates a record a code claim already
 * states, or states one fact twice, in the same words or in others. `withoutRestatements` keeps
 * one claim of each such fact and leaves the others out of the result, in this order:
 *
 * 1. A model claim that restates code-built claims goes, and the code claims stay (each is
 *    sourced on its record by construction; the model's claim is never made sourced in its
 *    place). A restatement cites only items code claims cite, at the same scope, and states
 *    nothing beyond them:
 *    - its text is a code claim's (`statementKey`), citing only that claim's items, whatever the
 *      judge said;
 *    - or it is about a relation (a sample or a cover), the judge found it supported or partly
 *      supported, and it states only the relations its records document
 *      (`statesOnlyItsRelations`), each record cited by a code claim about the same relation, at
 *      the same scope. The same fact is the same relation between the same two records, read the
 *      same way: the record gives the pair, the relation's kind and its direction
 *      (`documentedRelation`: its recordRef and excerpt, MusicBrainz, Genius or
 *      SecondHandSongs). The claim must say the relation by its word ("samples", "a cover of"),
 *      name the other record (its artist, or a title that tells it apart: `namesOf`) on the
 *      record's side of that word (`statesRelationIn`), never deny it, name nothing its records
 *      or the analysed track do not, and use no word of its own: each of its words is its
 *      records', the analysed track's, a form of the relation's word, or a connective. A relation
 *      record says only that one record draws on another, so a claim that says how ("the bass
 *      line") says more, whatever the judge found;
 *    - or, about anything else, the judge found it wholly supported by one code claim's items
 *      and it names nothing they do not (`namesOnlyWhatItCites`: every capitalised word and
 *      every number it holds is in their excerpts, a month read as its number). Here the analysed
 *      track's names count as names like any other: a credit may add its artist.
 *    A link the model drew on the map that states such a claim goes with it, and so does a node
 *    only those links drew, when the link draws the record's relation (its type and direction)
 *    and the map draws it already (a code link on the record) or never does (a relation of the
 *    song: codeClaims.ts draws no link for one). Otherwise the link, and its claim, stay.
 * 2. Then, of the model claims left:
 *    a. a claim that states only its records' relations goes when another model claim states
 *       each of them too (in the record's direction), about the same relation, at the same
 *       scope, as the same kind, with as good a verdict, not rejected, and either says more or
 *       is the better copy (`compare`). Each is decided against all the others, so the claims'
 *       order never counts;
 *    b. copies of one text (`statementKey`), best copy first: a copy goes when it repeats one
 *       kept before it that is not rejected, reads as the same kind (a stricter copy is never
 *       dropped for a lenient one), states a relation or not as that one does, is about the same
 *       scope (or one of the two cites nothing), and cites nothing that one does not.
 *    The better copy: the one whose citations fit its scope (`scopeSupports`), then the better
 *    verdict (supported, partial, unsupported, then none: a copy the judge checked, and what it
 *    said of it, is never dropped for one it did not check), then the one on a fact card, then
 *    the one citing more records, then the smaller id.
 * 3. A model claim kept that states the relations its records document (as in 1, words of its
 *    own allowed) is marked with the code claims that document them (`documentedBy`): the page
 *    names its relation as theirs. Its kind and verdict stay; a mark it came with is read again.
 *
 * Nothing that adds information goes: a claim that cites another item, or more items, one that
 * names what its records do not, adds a word of its own, states another relation than its
 * record's or reads it the other way round, or is about another scope, stays, judged as it was.
 * So does every claim a timeline sample or a code-built link states, every claim the verifier
 * rejected (it belongs in the rejected panel), every claim the judge did not judge or found
 * unsupported (but a copy of a code claim's text), and every claim compared with a measured
 * value (its `field`, or a numeric check other than "n/a"). A claim left out takes its fact card
 * with it, so it is shown nowhere, and is counted (`restated`, for `run.verifier`).
 *
 * The step is idempotent: run on its own output it leaves out nothing more, and the result does
 * not depend on the order of the claims. The verifier applies it to every result it builds and
 * always counts it (`run.verifier.restated`, 0 included); `oneClaimPerFact` applies it again to
 * every result read back (a replay, a stored result), adding to that count. Pure.
 */

import {
  type Claim,
  type ClaimAbout,
  claimIsRejected,
  type Evidence,
  LINK_CLAIM_ABOUT,
  scopeSupports,
  type Verdict,
} from "@liner-notes/contract";
import { normalizeName } from "../sources/musicbrainz.js";
import {
  normalizeArtist,
  normalizeTitle,
  RELATION_PHRASE,
  type RelationKind,
} from "../sources/records.js";

/** The subjects of a claim that states a relation between two records: a sample or a cover. */
const RELATION_SUBJECTS: ReadonlySet<ClaimAbout> = new Set([
  ...LINK_CLAIM_ABOUT.sample,
  ...LINK_CLAIM_ABOUT.interpolation,
  ...LINK_CLAIM_ABOUT.remix,
  ...LINK_CLAIM_ABOUT.cover,
]);
const statesRelation = (claim: Claim) => RELATION_SUBJECTS.has(claim.about);

/** How a verdict ranks when two copies of one statement compete: higher stays. */
const VERDICT_RANK: Record<Verdict, number> = {
  supported: 4,
  partial: 3,
  unsupported: 1,
  contradicted: 0,
};
/**
 * A claim the judge did not judge (past its batch, or the check failed) ranks below every verdict
 * that may go: a copy found unsupported keeps its objection over an unjudged copy. (A
 * contradicted copy never goes.)
 */
const UNJUDGED_RANK = 0.5;

// =============================================================================
// Statements
// =============================================================================

/** Quotes and apostrophes, straight or typographic: they never change a statement. */
const QUOTES = /['"‘’‚‛“”„‟«»‹›`´′″]/gu;
/** Placeholders (private-use characters) for what the punctuation pass must keep. */
const POINT = String.fromCharCode(0xe000);
const COMMA = String.fromCharCode(0xe001);
const PLUS = String.fromCharCode(0xe002);
const MINUS = String.fromCharCode(0xe003);
/** Everything but letters, digits, what changes a fact (%, #, ♭, ♯) and the placeholders. */
const SENTENCE_MARKS = new RegExp(`[^\\p{L}\\p{N}%#♭♯${POINT}${COMMA}${PLUS}${MINUS}]+`, "gu");

/**
 * A note or key name: a letter A-G with an accidental, a minor or major mark, or both ("C#m",
 * "Bb", "Am", "C#M"). Its case is its meaning ("C#m" is minor, "C#M" major; "Bb" is B-flat).
 */
const NOTE_NAME = /(?<![\p{L}\p{N}])([A-G](?:[#♯♭b][mM]?|[mM]))(?![\p{L}\p{N}])/u;

/** `text` in lower case, but for its note and key names (NOTE_NAME), which keep theirs. */
const lowerButNoteNames = (text: string) =>
  text
    .split(NOTE_NAME)
    .map((part, i) => (i % 2 === 1 ? part : part.toLowerCase()))
    .join("");

/**
 * A statement as it is compared: its case, quotes, apostrophes and sentence punctuation do not
 * count, nor compatibility forms (NFKC: "ﬁ" is "fi"). What changes a fact does: an accidental
 * ("B♭", "C#", "C♯"), the case of a note or key name ("C#m", "C#M"; "Bb", "BB"), a percent
 * sign, a sign before a number ("-3 dB") and a decimal or thousands separator between digits
 * ("1.5", "1,500").
 */
export function statementKey(text: string): string {
  return lowerButNoteNames(text.normalize("NFKC"))
    .replace(QUOTES, "")
    .replace(/(\d)([.,])(?=\d)/gu, (_, digit: string, mark: string) =>
      mark === "." ? `${digit}${POINT}` : `${digit}${COMMA}`,
    )
    .replace(/(^|[^\p{L}\p{N}])([-+\u2212])(?=\d)/gu, (_, before: string, sign: string) =>
      sign === "+" ? `${before} ${PLUS}` : `${before} ${MINUS}`,
    )
    .replace(SENTENCE_MARKS, " ")
    .trim()
    .replaceAll(POINT, ".")
    .replaceAll(COMMA, ",")
    .replaceAll(PLUS, "+")
    .replaceAll(MINUS, "-");
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
/** The number of a month named in full or by its first three letters ("Feb"); else null. */
function monthOf(word: string): number | null {
  const lower = word.toLowerCase();
  const index = MONTHS.findIndex(
    (month) => month === lower || (lower.length === 3 && month.startsWith(lower)),
  );
  return index === -1 ? null : index + 1;
}

/**
 * `text` without the accents of its Latin letters ("Beyoncé" reads "Beyonce"), as `normalizeName`
 * reads names: in another script a combining mark changes the letter, and is kept.
 */
const foldLatin = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC");

/** Words that open a sentence capitalised and name nothing. */
const FUNCTION_WORDS = new Set(
  "a an the it its this that these those in on at by of and as for to with from his her their our".split(
    " ",
  ),
);

/**
 * Whether every capitalised word and every number of `text` is in `excerpts`: it names no
 * person, label, place, title or date they do not. Words are compared without case; a number by
 * its value ("02" is 2); a month also by its number ("February" is in "2001-02-26"). A word in a
 * script without case (Chinese, Japanese, Arabic, Hebrew, Thai: `\p{Lo}`) may be a name too, and
 * must be found in the excerpts as it is written (such a script may write no spaces between
 * words). A Latin letter's accents do not count ("Beyonce" is "Beyoncé"), as `normalizeName`
 * compares names; another script's marks do. A capitalised word that names nothing ("The",
 * "It") is not counted.
 */
export function namesOnlyWhatItCites(text: string, excerpts: readonly string[]): boolean {
  const tokens = (from: string) =>
    foldLatin(from.normalize("NFKC"))
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const words = new Set<string>();
  const numbers = new Set<number>();
  const written = excerpts.map((excerpt) => excerpt.normalize("NFKC")).join("\n");
  for (const token of excerpts.flatMap(tokens)) {
    words.add(token.toLowerCase());
    if (/^[0-9]+$/.test(token)) numbers.add(Number(token));
  }
  return tokens(text).every((token) => {
    if (/^[0-9]+$/.test(token)) return numbers.has(Number(token));
    if (/\p{Lo}/u.test(token)) return written.includes(token);
    const month = monthOf(token);
    if (month !== null && /^\p{Lu}/u.test(token)) {
      return words.has(token.toLowerCase()) || numbers.has(month);
    }
    if (!/^\p{Lu}/u.test(token) && !/\p{N}/u.test(token)) return true;
    return FUNCTION_WORDS.has(token.toLowerCase()) || words.has(token.toLowerCase());
  });
}

// =============================================================================
// The relation a record documents
// =============================================================================

/**
 * The relation kinds a primary record's recordRef names, then the other record's id, with or
 * without its entity: MusicBrainz `…/samples/recording/<id>`, `…/covered-by/work/<id>`; Genius
 * `track/song/<id>/samples/<id>`; SecondHandSongs `work/performance/<id>/covered-by/<id>`.
 */
const RECORD_RELATION = new RegExp(
  `/(${Object.keys(RELATION_PHRASE).join("|")})/(?:(?:recording|work|song|performance)/)?[^/]+$`,
);
/** Each relation kind's word, in every form a statement of it uses ("samples", "covered"). */
const FORMS = {
  sample: ["sample", "samples", "sampled", "sampling"],
  interpolation: [
    "interpolate",
    "interpolates",
    "interpolated",
    "interpolating",
    "interpolation",
    "interpolations",
  ],
  cover: ["cover", "covers", "covered", "covering"],
  remix: ["remix", "remixes", "remixed", "remixing"],
};
/** The map's link type of each relation kind, which names its word's forms (`FORMS`). */
const LINK_TYPE: Record<RelationKind, keyof typeof FORMS> = {
  samples: "sample",
  "sampled-by": "sample",
  interpolates: "interpolation",
  "interpolated-by": "interpolation",
  "cover-of": "cover",
  "covered-by": "cover",
  "remix-of": "remix",
  "remixed-by": "remix",
};
/** Every form of every relation's word. */
const ALL_FORMS: ReadonlySet<string> = new Set(Object.values(FORMS).flat());
/** True for a kind whose other record draws on this one (it samples, covers … this one). */
const otherDrawsOn = (kind: RelationKind) => kind.endsWith("-by");

/** A relation a primary record documents: its kind, and the other record's title and artist. */
export interface DocumentedRelation {
  kind: RelationKind;
  title: string;
  artist: string | null;
}

/**
 * The relation an evidence item documents, read from its recordRef (the kind) and its excerpt
 * (`<this record> <RELATION_PHRASE> "<title>" by <artist>.`, the other record last, with the
 * date SecondHandSongs gives it in brackets); null for an item that documents none, whose
 * excerpt is not written so, or holds the relation's phrase twice (a title may hold it, and
 * then which is the record's cannot be told).
 */
export function documentedRelation(
  item: Pick<Evidence, "recordRef" | "excerpt">,
): DocumentedRelation | null {
  const kind = RECORD_RELATION.exec(item.recordRef ?? "")?.[1] as RelationKind | undefined;
  if (!kind) return null;
  const phrase = ` ${RELATION_PHRASE[kind]} `;
  const at = item.excerpt.indexOf(phrase);
  if (at === -1 || at !== item.excerpt.lastIndexOf(phrase)) return null;
  const other = item.excerpt
    .slice(at + phrase.length)
    .replace(/ \(\d{4}(?:-\d{2}){0,2}\)\.$/u, ".");
  const names = /^"([^"]+)" by (.+)\.$/su.exec(other) ?? /^"([^"]+)"\.$/su.exec(other);
  if (!names) return null;
  return { kind, title: names[1], artist: names[2] ?? null };
}

/** The analysed track, as a statement may name it. */
export interface AnalysedTrack {
  title?: string | null;
  artist?: string | null;
}

/** Where the word sequence `part` first starts in `words`; -1 when it is not there. */
function indexOfWords(words: readonly string[], part: readonly string[]): number {
  if (part.length === 0) return -1;
  for (let at = 0; at + part.length <= words.length; at++) {
    if (part.every((word, i) => words[at + i] === word)) return at;
  }
  return -1;
}

/** Words after a relation's word that make its subject the record drawn on ("sampled in"). */
const PASSIVE_AFTER = new Set(["in", "by", "on", "into"]);

/** A statement's words as names are compared (`normalizeName`: no case, accents or marks). */
const nameWords = (text: string) => normalizeName(text).split(" ").filter(Boolean);

/**
 * True when a name can be told apart in a statement: two letters or more, and not only words that
 * name nothing on their own ("It", "The", "A") or a relation's word ("Sample", "Cover").
 */
const telling = (name: readonly string[]) =>
  name.join("").length >= 3 &&
  !name.every((word) => CONNECTIVES.has(word) || FUNCTION_WORDS.has(word) || ALL_FORMS.has(word));

/** A title without a bracketed subtitle at its end ("Are You My Woman? (Tell Me So)"). */
const SUBTITLE = /\s*[([][^()[\]]*[)\]]\s*$/u;

/**
 * The ways a statement may name the other record of `relation`, as word sequences, the artist's
 * first: its artist (`normalizeArtist`), its title (`normalizeTitle`: without featured-artist and
 * remaster suffixes) and that title without its bracketed subtitle. A name the analysed track
 * shares (a cover's title is often the track's own) is left out: it cannot say which record is
 * meant. So is a title that cannot be told apart in a statement (`telling`): a record titled "It"
 * or "Sample" is named by its artist.
 */
function namesOf(relation: DocumentedRelation, track: AnalysedTrack): string[][] {
  const own = new Set(
    [
      track.title ? normalizeTitle(track.title) : "",
      track.artist ? normalizeArtist(track.artist) : "",
    ].filter(Boolean),
  );
  const candidates = [
    relation.artist === null ? "" : normalizeArtist(relation.artist),
    normalizeTitle(relation.title),
    normalizeTitle(relation.title.replace(SUBTITLE, "")),
  ];
  const names: string[][] = [];
  for (const name of candidates) {
    if (name === "" || own.has(name) || names.some((each) => each.join(" ") === name)) continue;
    const words = name.split(" ");
    if (telling(words)) names.push(words);
  }
  return names;
}

/**
 * True when a statement's words (`nameWords`) state `relation` as its record documents it: they
 * say the relation by its word, in any of its forms ("samples", "a cover of", "remixed"), name
 * the other record (`namesOf`), and name it on the record's side of that word. The side: in "A
 * samples B" or "A is a cover of B" the record named first draws on the other; in "A is sampled
 * in B" or "A, as a sample in B" (the word followed by "in", "by", "on" or "into") the one named
 * after it does. A "samples" record must be stated with this track drawing on the other record,
 * a "sampled-by" one the other way round. A statement that names the other record only by a name
 * that cannot tell it apart states nothing here, nor does one that says its title is by another
 * artist than the record's.
 */
function statesRelationIn(
  words: readonly string[],
  relation: DocumentedRelation,
  names: readonly string[][],
): boolean {
  const forms = FORMS[LINK_TYPE[relation.kind]];
  const word = words.findIndex((each) => forms.includes(each));
  if (word === -1) return false;
  const artist = relation.artist === null ? null : normalizeArtist(relation.artist).split(" ");
  for (const name of names) {
    const at = indexOfWords(words, name);
    if (at === -1 || (at <= word && word < at + name.length)) continue;
    // A title said to be by someone else than the record's artist ("Shout by will.i.am").
    const after = at + name.length;
    if (
      artist !== null &&
      words[after] === "by" &&
      after !== word &&
      !artist.every((each, i) => words[after + 1 + i] === each)
    ) {
      return false;
    }
    const passive = PASSIVE_AFTER.has(words[word + 1] ?? "");
    const otherDraws = passive ? at > word : at < word;
    return otherDraws === otherDrawsOn(relation.kind);
  }
  return false;
}

/** True when `text` states `relation` as its record documents it (`statesRelationIn`). */
export function statesRelationOf(
  text: string,
  relation: DocumentedRelation,
  track: AnalysedTrack = {},
): boolean {
  return statesRelationIn(nameWords(text), relation, namesOf(relation, track));
}

/** A statement's words, without case or the accents of Latin letters, as a record's are read. */
const wordsOf = (text: string) =>
  foldLatin(text.normalize("NFKC"))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Words a statement may use beside its records' own when it only restates them: articles,
 * auxiliaries, prepositions and what names a record ("song", "recording", the possessive "s").
 */
const CONNECTIVES: ReadonlySet<string> = new Set(
  "a an the is was are were has have had been be of by and in on to from with this that it its s song track recording work".split(
    " ",
  ),
);

/**
 * A negation: a statement that holds one is never read as stating its record's relation, even
 * when the word is in a name ("Never Gonna Give You Up").
 */
const NEGATION = /\b(?:not|no|never|nor|neither|without)\b|n['’]t\b/iu;

/**
 * Capitalised words that open a sentence and name nothing, beside `namesOnlyWhatItCites`' own
 * ("Other source material describes…"): read as cited, so they are no new name.
 */
const SENTENCE_OPENERS = "Other Another Some Such";

// =============================================================================
// The step
// =============================================================================

/** A link of the result's map, as the step reads it. */
interface MapLink {
  source: string;
  target: string;
  type?: string;
  origin?: string;
  claimId?: string;
  evidenceIds?: readonly string[];
}
/** The result's map, as the step reads it. */
interface MapLike {
  nodes: readonly { id: string }[];
  links: readonly object[];
}

export interface WithoutRestatements<F, G> {
  /**
   * The claims kept, a model claim that states a relation records document marked with the
   * code-built claims that document it (`documentedBy`).
   */
  claims: Claim[];
  factoids: F[];
  /** The map without the model's links (and the nodes only they drew) whose claims went. */
  genealogy: G;
  /** How many claims were left out. */
  restated: number;
}

/** What the step reads of an evidence item. */
type CitedItem = Pick<Evidence, "id" | "sourceTier" | "recordRef" | "excerpt">;

/** What else the step reads of the result. */
export interface RestatementContext<G> {
  /**
   * The result's map. A model link that states a claim restating a code-built one goes with the
   * claim when the link states the record's relation in its type and direction, and the map draws
   * that relation already (a code link on the same record, of the same type) or never draws it (a
   * relation of the song, not of this recording); so does a node of the model's that only such
   * links drew. Otherwise the link stays, and so does its claim. Without the map, a claim any link
   * states stays.
   */
  genealogy?: G;
  /** The analysed track: in a claim about a relation, its title and artist are no new name. */
  track?: AnalysedTrack;
}

/** A relation record a claim cites, with what it documents. */
interface CitedRelation extends DocumentedRelation {
  id: string;
  /** A record of the song (`work/…`): the map draws no link for it (codeClaims.ts). */
  ofSong: boolean;
  /** The ways a statement may name its other record (`namesOf`). */
  names: string[][];
}

/** Whether two lists hold the same ids, in the same order. */
const sameIds = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((id, i) => id === b[i]);

/** `read`, worked out once per claim object. */
function perClaim<T>(read: (claim: Claim) => T): (claim: Claim) => T {
  const known = new Map<Claim, T>();
  return (claim) => {
    if (!known.has(claim)) known.set(claim, read(claim));
    return known.get(claim) as T;
  };
}

/**
 * The claims and fact cards with each restated fact kept once (see the module comment), each
 * kept model claim marked as `documentedBy` the code-built claims whose relation it states, or
 * unmarked. `stating` holds what else may name a claim by its `claimId` (the genealogy's links,
 * the timeline's samples): a claim one of them states is never left out, but for a claim only
 * the model's links of `context.genealogy` state, when each of those links may go with it.
 * `evidence` is the result's pack. The result does not depend on the claims' order.
 */
export function withoutRestatements<
  F extends { claimId?: string },
  G extends MapLike | undefined = undefined,
>(
  claims: readonly Claim[],
  factoids: readonly F[],
  stating: readonly object[],
  evidence: readonly CitedItem[],
  context: RestatementContext<G> = {},
): WithoutRestatements<F, G> {
  const pack = new Map(evidence.map((item) => [item.id, item]));
  const statedBy = new Map<string, MapLink[]>();
  for (const ref of stating) {
    const id = (ref as { claimId?: unknown }).claimId;
    if (typeof id === "string") statedBy.set(id, [...(statedBy.get(id) ?? []), ref as MapLink]);
  }
  const genealogy = context.genealogy;
  const mapLinks = (genealogy?.links ?? []) as readonly MapLink[];
  const onMap = new Set<object>(mapLinks);
  const track = context.track ?? {};
  const trackNames = [track.title, track.artist].filter(
    (name): name is string => typeof name === "string" && name !== "",
  );
  const trackWords = trackNames.flatMap(wordsOf);
  const within = (ids: readonly string[], of: readonly string[]) =>
    ids.every((id) => of.includes(id));
  const sameScope = (a: Claim, b: Claim) => (a.scope ?? "recording") === (b.scope ?? "recording");
  const excerpts = (claim: Claim) => claim.evidenceIds.map((id) => pack.get(id)?.excerpt);
  /** Every name and number of the claim is in what it cites (and `more`). */
  const namesOnlyItsRecord = (claim: Claim, more: readonly string[] = []) => {
    const cited = excerpts(claim);
    return (
      cited.every((excerpt) => excerpt !== undefined) &&
      namesOnlyWhatItCites(claim.text, [...(cited as string[]), ...more])
    );
  };

  /** What each relation record documents, read once. */
  const records = new Map<string, CitedRelation | null>();
  const recordOf = (id: string) => {
    if (!records.has(id)) {
      const item = pack.get(id);
      const relation = item ? documentedRelation(item) : null;
      records.set(
        id,
        item && relation
          ? {
              ...relation,
              id,
              ofSong: (item.recordRef ?? "").startsWith("work/"),
              names: namesOf(relation, track),
            }
          : null,
      );
    }
    return records.get(id) ?? null;
  };
  /** The relation each record a claim cites documents; null when one documents none. */
  const relationsOf = perClaim((claim): CitedRelation[] | null => {
    const relations = claim.evidenceIds.map(recordOf);
    return relations.length > 0 && relations.every((relation) => relation !== null)
      ? (relations as CitedRelation[])
      : null;
  });
  /**
   * Whether a claim may state a relation as its records document it: about a sample or a cover,
   * found supported or partly supported, with no negation, naming nothing its records or the
   * analysed track do not.
   */
  const mayState = perClaim(
    (claim) =>
      statesRelation(claim) &&
      (claim.verdict === "supported" || claim.verdict === "partial") &&
      !NEGATION.test(claim.text) &&
      namesOnlyItsRecord(claim, [...trackNames, SENTENCE_OPENERS]),
  );
  /** The records a claim cites whose relation it states, in their direction (`statesRelationIn`). */
  const statesOf = perClaim((claim) => {
    const stated = new Set<string>();
    if (!mayState(claim)) return stated;
    const words = nameWords(claim.text);
    for (const id of claim.evidenceIds) {
      const relation = recordOf(id);
      if (relation && statesRelationIn(words, relation, relation.names)) stated.add(id);
    }
    return stated;
  });
  /** The relations a claim cites, when it states each of them; null when it does not. */
  const statedRelations = (claim: Claim) => {
    const relations = relationsOf(claim);
    const stated = statesOf(claim);
    return relations?.every((relation) => stated.has(relation.id)) ? relations : null;
  };
  /**
   * Whether a claim states its records' relations and says nothing else: each of its words is
   * one of its records', the analysed track's, a form of a relation's word or a connective
   * (`CONNECTIVES`). A claim with a word of its own ("the bass line", "an extended mix") stays,
   * whatever the judge found: a relation record says only that one record draws on another.
   */
  const statesOnlyItsRelations = perClaim((claim) => {
    const relations = statedRelations(claim);
    if (!relations) return false;
    const forms = new Set(relations.flatMap((relation) => FORMS[LINK_TYPE[relation.kind]]));
    const own = new Set([
      ...CONNECTIVES,
      ...forms,
      ...(excerpts(claim) as string[]).flatMap(wordsOf),
      ...trackWords,
    ]);
    return wordsOf(claim.text).every((word) => own.has(word));
  });

  // 1. A model claim that restates code-built claims.
  const code = claims.filter((claim) => claim.origin === "code" && claim.evidenceIds.length > 0);
  /** The code claim about the same relation, at its scope, citing each record it cites. */
  const documenting = (model: Claim) => {
    const ids: string[] = [];
    for (const id of model.evidenceIds) {
      const built = code.find(
        (each) =>
          each.about === model.about && sameScope(model, each) && each.evidenceIds.includes(id),
      );
      if (!built) return null;
      if (!ids.includes(built.id)) ids.push(built.id);
    }
    return ids.length > 0 ? ids : null;
  };
  /**
   * Whether a model link that states `claim` may go with it: it joins this track in the type
   * and direction each record the claim cites documents, and the map draws that relation
   * already (a code link on the record, of that type) or never does (a relation of the song).
   */
  const linkMayGo = (link: MapLink, claim: Claim) => {
    if (!onMap.has(link) || link.origin === "code") return false;
    const relations = relationsOf(claim) ?? [];
    return (
      relations.length > 0 &&
      relations.every(
        (relation) =>
          link.type === LINK_TYPE[relation.kind] &&
          (otherDrawsOn(relation.kind) ? link.source === "current" : link.target === "current") &&
          (relation.ofSong ||
            mapLinks.some(
              (each) =>
                each.origin === "code" &&
                each.type === link.type &&
                (each.evidenceIds ?? []).includes(relation.id),
            )),
      )
    );
  };
  /**
   * A model claim that may go: it is not rejected, no value is its, and no link or sample states
   * it (`withLinks`: or only the model's links on the map do, each of which may go with it).
   */
  const mayGo = (claim: Claim, withLinks = false) =>
    claim.origin === "model" &&
    (!statedBy.has(claim.id) ||
      (withLinks && (statedBy.get(claim.id) ?? []).every((link) => linkMayGo(link, claim)))) &&
    !claimIsRejected(claim) &&
    claim.field === undefined &&
    (claim.numericCheck ?? "n/a") === "n/a";
  /** A code claim's own text, on its record (or within its records), at its scope: any verdict. */
  const sameText = (model: Claim) =>
    model.evidenceIds.length > 0 &&
    code.some(
      (built) =>
        sameScope(model, built) &&
        within(model.evidenceIds, built.evidenceIds) &&
        statementKey(model.text) === statementKey(built.text),
    );
  const restates = (model: Claim) => {
    if (sameText(model)) return true;
    if (statesRelation(model)) {
      return statesOnlyItsRelations(model) && documenting(model) !== null;
    }
    return (
      model.verdict === "supported" &&
      model.evidenceIds.length > 0 &&
      namesOnlyItsRecord(model) &&
      code.some((built) => sameScope(model, built) && within(model.evidenceIds, built.evidenceIds))
    );
  };
  const gone = new Set<string>();
  for (const claim of claims) {
    if (mayGo(claim, true) && restates(claim)) gone.add(claim.id);
  }

  // 2. One copy of a fact the model stated more than once, of what is left.
  const fits = (claim: Claim) =>
    claim.evidenceIds.length > 0 &&
    claim.evidenceIds.every((id) => {
      const item = pack.get(id);
      return item !== undefined && scopeSupports(claim.scope, item);
    });
  const verdictRank = (claim: Claim) =>
    claim.verdict === null ? UNJUDGED_RANK : VERDICT_RANK[claim.verdict];
  const rank = perClaim((claim) => [
    fits(claim) ? 1 : 0,
    verdictRank(claim),
    claim.factoid !== undefined ? 1 : 0,
    new Set(claim.evidenceIds).size,
  ]);
  /** Negative when `a` is the better copy; then by id, so the claims' order never decides. */
  const compare = (a: Claim, b: Claim) => {
    const [ra, rb] = [rank(a), rank(b)];
    const at = ra.findIndex((value, i) => value !== rb[i]);
    if (at !== -1) return rb[at] - ra[at];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const models = claims.filter((claim) => claim.origin === "model" && !gone.has(claim.id));

  // 2a. A claim that states only its records' relations, when another of the model's claims
  // states each of them too: about the same relation, at the same scope, as the same kind, with
  // as good a verdict, not rejected, and either saying more or the better copy. Each is decided
  // against all the others, so neither the order of the claims nor of the decisions counts; the
  // one that covers a claim that goes stays, or goes for one that covers it in turn.
  const covers = (other: Claim, copy: Claim) =>
    other !== copy &&
    other.about === copy.about &&
    other.kind === copy.kind &&
    sameScope(other, copy) &&
    !claimIsRejected(other) &&
    verdictRank(other) >= verdictRank(copy) &&
    copy.evidenceIds.every((id) => statesOf(other).has(id)) &&
    (!statesOnlyItsRelations(other) || compare(other, copy) < 0);
  const restated = models.filter(
    (claim) =>
      mayGo(claim) && statesOnlyItsRelations(claim) && models.some((other) => covers(other, claim)),
  );
  for (const claim of restated) gone.add(claim.id);

  // 2b. Copies of one text, best first: a copy goes when it repeats one kept before it that is
  // not rejected.
  /** Whether `copy`, with `kept`'s text, repeats it, adding nothing to it. */
  const repeats = (copy: Claim, kept: Claim) =>
    !claimIsRejected(kept) &&
    copy.kind === kept.kind &&
    statesRelation(copy) === statesRelation(kept) &&
    (sameScope(copy, kept) || copy.evidenceIds.length === 0 || kept.evidenceIds.length === 0) &&
    within(copy.evidenceIds, kept.evidenceIds);
  const left = models.filter((claim) => !gone.has(claim.id));
  const keyOf = new Map(left.map((claim) => [claim, statementKey(claim.text)]));
  const kept: Claim[] = [];
  for (const claim of [...left].sort(compare)) {
    const key = keyOf.get(claim);
    const copyOf = (other: Claim) =>
      key !== "" && keyOf.get(other) === key && repeats(claim, other);
    if (mayGo(claim) && kept.some(copyOf)) gone.add(claim.id);
    else kept.push(claim);
  }

  // 3. What is left of the model's claims on a relation records document says so: marked with
  // the code claims that document it (their words name its relation; its own kind and verdict
  // stay). A mark a claim came with is never taken as it is: it is read again.
  const marked = claims
    .filter((claim) => !gone.has(claim.id))
    .map((claim) => {
      if (claim.origin !== "model") return claim;
      const by = statedRelations(claim) ? documenting(claim) : null;
      const before = claim.documentedBy;
      if (by === null ? before === undefined : sameIds(before, by)) return claim;
      const { documentedBy: _before, ...rest } = claim;
      return by ? { ...rest, documentedBy: by } : rest;
    });

  return {
    claims: marked,
    factoids:
      gone.size === 0
        ? [...factoids]
        : factoids.filter((card) => card.claimId === undefined || !gone.has(card.claimId)),
    genealogy: (genealogy === undefined || gone.size === 0
      ? genealogy
      : withoutLinksOf(genealogy, gone)) as G,
    restated: gone.size,
  };
}

/**
 * The map without the model's links whose claims went, and without the nodes (but the analysed
 * track's) that only those links drew.
 */
function withoutLinksOf<M extends MapLike>(genealogy: M, gone: ReadonlySet<string>): M {
  const goes = (link: MapLink) =>
    link.origin !== "code" && link.claimId !== undefined && gone.has(link.claimId);
  const links = genealogy.links as readonly MapLink[];
  if (!links.some(goes)) return genealogy;
  const left = links.filter((link) => !goes(link));
  const drawn = new Set(left.flatMap((link) => [link.source, link.target]));
  const undrawn = new Set(
    links
      .filter(goes)
      .flatMap((link) => [link.source, link.target])
      .filter((id) => id !== "current" && !drawn.has(id)),
  );
  return {
    ...genealogy,
    nodes: genealogy.nodes.filter((node) => !undrawn.has(node.id)),
    links: left,
  } as M;
}

/** The parts of a result the step reads and changes. */
export interface ResultClaims {
  title?: string;
  artist?: string;
  claims?: Claim[];
  factoids?: Array<{ claimId?: string }>;
  genealogy?: { nodes?: readonly { id: string }[]; links?: readonly object[] } | null;
  samples?: readonly object[];
  evidence?: readonly CitedItem[];
  run?: { verifier?: { restated?: number } | null } | null;
}

/**
 * A result read back (a replay, a stored result) with each fact stated once, and how many more
 * claims were left out. The step runs again on every read, whatever ran when the result was made:
 * it is idempotent, so a result it already ran on loses nothing more, and one made before it, or
 * before its rules last changed, is served as the step now reads it. The count is added to the
 * one in the result's verifier summary, when it has one (none counted there is 0); a result
 * without one (a result from the long-term store, which keeps no run information) has nowhere to
 * hold it, and the caller logs it.
 */
export function oneClaimPerFact<T extends ResultClaims>(
  result: T,
): { result: T; restated: number } {
  const verifier = result.run?.verifier;
  const map = result.genealogy
    ? { nodes: result.genealogy.nodes ?? [], links: result.genealogy.links ?? [] }
    : undefined;
  const kept = withoutRestatements(
    result.claims ?? [],
    result.factoids ?? [],
    [...(result.genealogy?.links ?? []), ...(result.samples ?? [])],
    result.evidence ?? [],
    { genealogy: map, track: { title: result.title, artist: result.artist } },
  );
  const mapChanged =
    map !== undefined && kept.genealogy !== undefined && kept.genealogy.links !== map.links;
  const counted = (verifier?.restated ?? 0) + kept.restated;
  return {
    result: {
      ...result,
      ...(result.claims ? { claims: kept.claims } : {}),
      ...(kept.restated > 0 ? { factoids: kept.factoids } : {}),
      ...(mapChanged ? { genealogy: { ...result.genealogy, ...kept.genealogy } } : {}),
      ...(result.run && verifier
        ? { run: { ...result.run, verifier: { ...verifier, restated: counted } } }
        : {}),
    },
    restated: kept.restated,
  };
}

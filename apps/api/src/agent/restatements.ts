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
 *      supported, and it states exactly the relations its records document
 *      (`statesOnlyItsRelations`), each record cited by a code claim about the same relation, at
 *      the same scope. The same fact is the same relation between the same two records, read the
 *      same way: the record gives the pair, the relation's kind and its direction
 *      (`documentedRelation`: a record of this recording or of its song, `track/…` or `work/…`,
 *      from MusicBrainz, Genius or SecondHandSongs; a record of a related track, the map's second
 *      hop, is not one). The claim must be, word for word, one of the strict templates of
 *      relationText.ts (`readRelations`): "<one> samples <other>", "<one> is sampled by|in
 *      <other>" and their forms, one side the analysed track and the other each record it cites,
 *      named by its title (or by an artist no other record of the result shares; a cover always
 *      by its title), in the record's direction. Anything else (a relative clause, an adverb, a
 *      hedge or a negation, a word of its own, a name it does not cite) is unknown, and an
 *      unknown claim states nothing: it stays. A relation record says only that one record draws
 *      on another, so a claim that says how ("the bass line") says more, whatever the judge
 *      found;
 *    - or, about anything else, the judge found it wholly supported by one code claim's items
 *      and it names nothing they do not (`namesOnlyWhatItCites`: every capitalised word and
 *      every number it holds is in their excerpts, a month read as its number). Here the analysed
 *      track's names count as names like any other: a credit may add its artist.
 *    A link the model drew on the map that states such a claim goes with it, and so does a node
 *    only those links drew, when the link draws the record's relation (its type and direction)
 *    between the analysed track and that record's own node (the code link's node, or a node
 *    whose title and artist are the record's), and the map draws it already (a code link on the
 *    record) or never does (a relation of the song: codeClaims.ts draws no link for one).
 *    Otherwise the link, and its claim, stay.
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
 * 3. A model claim kept that states exactly the relations its records document is marked with
 *    the code claims that document them (`documentedBy`): the page names its relation as
 *    theirs. It states them as 1 reads them, or in exactly one of its sentences while each other
 *    sentence only adds detail: no "?", relation word, hedge, negation or doubting word, and no
 *    capitalised name but the track's, its records', the result's and a source's
 *    (`readMarkedRelations`). A claim the templates cannot read is never marked.
 *    Its kind and verdict stay (a partly supported one still shows so); a mark it came with is
 *    read again.
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
import { normalizeTitle, RELATION_PHRASE, type RelationKind } from "../sources/records.js";
import {
  artistNames,
  foldText,
  hedged,
  LINK_TYPE,
  type NamedRecord,
  otherDrawsOn,
  type ReadingContext,
  readMarkedRelations,
  readRelations,
  titleNames,
} from "./relationText.js";

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
 * words). A Latin letter's accents and Greek tonos do not count ("Beyonce" is "Beyoncé"), as
 * `foldText` reads names; another script's marks do. A capitalised word that names nothing ("The",
 * "It") is not counted.
 */
export function namesOnlyWhatItCites(text: string, excerpts: readonly string[]): boolean {
  const tokens = (from: string) =>
    foldText(from.normalize("NFKC"))
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
/** A relation a primary record documents: its kind, and the other record's title and artist. */
export interface DocumentedRelation {
  kind: RelationKind;
  title: string;
  artist: string | null;
}

/**
 * The relation an evidence item documents, read from its recordRef (the kind) and its excerpt
 * (`<this record> <RELATION_PHRASE> "<title>" by <artist>.`, the other record last, with the
 * date SecondHandSongs gives it in brackets); null for an item that documents none, or none of
 * this track or its song (its recordRef's scope is `track/` or `work/`: a relations map's second
 * hop joins two other recordings), whose excerpt is not written so, or holds the relation's
 * phrase twice (a title may hold it, and then which is the record's cannot be told).
 */
export function documentedRelation(
  item: Pick<Evidence, "recordRef" | "excerpt">,
): DocumentedRelation | null {
  const ref = item.recordRef ?? "";
  if (!ref.startsWith("track/") && !ref.startsWith("work/")) return null;
  const kind = RECORD_RELATION.exec(ref)?.[1] as RelationKind | undefined;
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

/**
 * The record's own side of the relation an item documents (`documentedRelation`): its title and
 * artist as its excerpt writes them (`"<title>" by <artist>`, the work's or song's title, a
 * SecondHandSongs performer); this track or its song, which a statement may name so.
 */
export function recordSubject(
  item: Pick<Evidence, "recordRef" | "excerpt">,
): { title: string; artist: string | null } | null {
  const relation = documentedRelation(item);
  if (!relation) return null;
  const phrase = ` ${RELATION_PHRASE[relation.kind]} `;
  const own = item.excerpt.slice(0, item.excerpt.indexOf(phrase));
  const names = /"([^"]+)"(?: by (.+)| \(as performed by (.+)\))?$/su.exec(own) ?? null;
  return names ? { title: names[1], artist: names[2] ?? names[3] ?? null } : null;
}

/** The analysed track, as a statement may name it. */
export interface AnalysedTrack {
  title?: string | null;
  artist?: string | null;
}

/** The analysed track's names, as `readRelations` reads them. */
function trackNamesOf(track: AnalysedTrack) {
  return {
    titles: track.title ? titleNames(track.title) : [],
    artists: track.artist ? artistNames(track.artist) : [],
  };
}

/** A documented relation's other record, as `readRelations` names it. */
function namedRecord(id: string, relation: DocumentedRelation, source?: string): NamedRecord {
  return {
    source,
    id,
    kind: relation.kind,
    title: relation.title,
    key: `${normalizeTitle(foldText(relation.title))}|${relation.artist ?? ""}`,
    titles: titleNames(relation.title),
    artists: relation.artist === null ? [] : artistNames(relation.artist),
  };
}

/**
 * True when `text` states `relation` as its record documents it (`readRelations`), with no other
 * record of the result to tell apart from it. Internal: the tests read single statements with
 * it; the step reads claims in `withoutRestatements`.
 */
export function statesRelationOf(
  text: string,
  relation: DocumentedRelation,
  track: AnalysedTrack = {},
): boolean {
  const record = namedRecord("record", relation);
  const artistIndex = new Map(record.artists.map((name) => [name.join(" "), new Set(["record"])]));
  const stated = readRelations(text, {
    track: trackNamesOf(track),
    cited: new Map([["record", record]]),
    artistIndex,
  });
  return stated?.has("record") ?? false;
}

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

/**
 * The track a map's node draws, by its title and artist (`trackTitle` and `trackArtist`, else
 * its label, "<title> - <artist>"); null for the analysed track's node or one that names none.
 */
function nodeRecord(node: object | undefined): { title: string; artist: string } | null {
  const { id, trackTitle, trackArtist, label } = (node ?? {}) as Record<string, unknown>;
  if (node === undefined || id === "current") return null;
  if (typeof trackTitle === "string" && typeof trackArtist === "string") {
    return { title: trackTitle, artist: trackArtist };
  }
  if (typeof label !== "string") return null;
  const at = label.lastIndexOf(" - ");
  return at === -1 ? null : { title: label.slice(0, at), artist: label.slice(at + 3) };
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
type CitedItem = Pick<Evidence, "id" | "sourceTier" | "recordRef" | "excerpt"> &
  Partial<Pick<Evidence, "source">>;

/** What else the step reads of the result. */
export interface RestatementContext<G> {
  /**
   * The result's map. A model link that states a claim restating a code-built one goes with the
   * claim when the link states the record's relation in its type and direction, its other end is
   * the record's own node (the code link's, or one whose title and artist are the record's), and
   * the map draws that relation already (a code link on the same record, of the same type) or
   * never draws it (a relation of the song, not of this recording); so does a node of the model's
   * that only such links drew. Otherwise the link stays, and so does its claim. Without the map,
   * a claim any link states stays. Its nodes and pack also give the artists of the result: an
   * artist alone names a record only when no other record has it.
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
  /** Its other record, as a statement names it (`readRelations`). */
  named: NamedRecord;
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
  const trackNamed = trackNamesOf(track);
  const within = (ids: readonly string[], of: readonly string[]) =>
    ids.every((id) => of.includes(id));
  const sameScope = (a: Claim, b: Claim) => (a.scope ?? "recording") === (b.scope ?? "recording");
  const excerpts = (claim: Claim) => claim.evidenceIds.map((id) => pack.get(id)?.excerpt);
  /** Every name and number of the claim is in what it cites. */
  const namesOnlyItsRecord = (claim: Claim) => {
    const cited = excerpts(claim);
    return (
      cited.every((excerpt) => excerpt !== undefined) &&
      namesOnlyWhatItCites(claim.text, cited as string[])
    );
  };
  /**
   * Whether a claim denies or hedges what it says (`hedged`), outside the names it may hold: the
   * titles its records quote and the analysed track's title and artist.
   */
  const hedges = (claim: Claim) =>
    hedged(claim.text, [
      ...trackNames,
      ...(excerpts(claim) as (string | undefined)[]).flatMap((excerpt) =>
        [...(excerpt ?? "").matchAll(/"([^"]+)"/gu)].map((quoted) => quoted[1]),
      ),
    ]);

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
              named: namedRecord(id, relation, item.source),
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
   * The other sides of the result's records, by each artist name they credit: its relation
   * records and the tracks its map draws (but the analysed one, and one only the model's links
   * draw). An artist names a record alone only when it credits one of them.
   */
  const artistIndex = new Map<string, Set<string>>();
  const indexArtist = (title: string, artist: string) => {
    const key = normalizeTitle(foldText(title));
    for (const name of artistNames(artist)) {
      const credit = name.join(" ");
      artistIndex.set(credit, new Set([...(artistIndex.get(credit) ?? []), key]));
    }
  };
  /** The names of the result's records (`readMarkedRelations`). */
  const recordNames: string[][] = [];
  for (const item of evidence) {
    const relation = documentedRelation(item);
    if (!relation) continue;
    recordNames.push(...titleNames(relation.title));
    if (relation.artist) {
      indexArtist(relation.title, relation.artist);
      recordNames.push(...artistNames(relation.artist));
    }
  }
  // A node only the model's links draw is left out: those links may go with their claims and
  // take it off the map, and the step must read a map it has run on as it read it first.
  const linksOf = new Map<string, MapLink[]>();
  for (const link of mapLinks) {
    for (const end of [link.source, link.target])
      linksOf.set(end, [...(linksOf.get(end) ?? []), link]);
  }
  const onlyModelDraws = (id: string) => {
    const incident = linksOf.get(id) ?? [];
    return (
      incident.length > 0 &&
      incident.every((link) => link.origin !== "code" && link.claimId !== undefined)
    );
  };
  for (const node of genealogy?.nodes ?? []) {
    const other = nodeRecord(node);
    if (!other || onlyModelDraws(node.id)) continue;
    indexArtist(other.title, other.artist);
    recordNames.push(...titleNames(other.title), ...artistNames(other.artist));
  }
  /**
   * Whether a claim may state a relation as its records document it: about a sample or a cover,
   * found supported or partly supported.
   */
  const mayState = (claim: Claim) =>
    statesRelation(claim) && (claim.verdict === "supported" || claim.verdict === "partial");
  /** How a claim that may state its records' relations is read; null for one that may not. */
  const readingOf = perClaim((claim): ReadingContext | null => {
    const relations = mayState(claim) ? relationsOf(claim) : null;
    if (!relations) return null;
    const subjects = claim.evidenceIds.flatMap((id) => {
      const item = pack.get(id);
      const subject = item ? recordSubject(item) : null;
      return subject ? [subject] : [];
    });
    const reading: ReadingContext = {
      track: {
        titles: [...trackNamed.titles, ...subjects.flatMap((each) => titleNames(each.title))],
        artists: [
          ...trackNamed.artists,
          ...subjects.flatMap((each) => (each.artist ? artistNames(each.artist) : [])),
        ],
      },
      cited: new Map(relations.map((relation) => [relation.id, relation.named])),
      artistIndex,
    };
    return reading;
  });
  /**
   * The records a claim cites whose relation it states, in their direction, and nothing else
   * (`readRelations`): none when it is not one of the templates, so a claim read in doubt
   * states nothing, never goes, is never marked and never covers another.
   */
  const statesOf = perClaim((claim) => {
    const reading = readingOf(claim);
    return (reading && readRelations(claim.text, reading)) ?? new Set<string>();
  });
  /**
   * Whether a kept claim is marked as stating its records' relations: the whole of it does, or
   * one of its sentences does and the others only add detail (`readMarkedRelations`: no relation
   * word, hedge or other record's name). Leaving a claim out still needs the whole of it. A
   * rejected claim (a value checked and found wrong) is never marked.
   */
  const marks = perClaim((claim) => {
    const reading = readingOf(claim);
    if (!reading || claimIsRejected(claim)) return false;
    const read = readMarkedRelations(claim.text, reading, recordNames);
    return [...reading.cited.keys()].every((id) => read?.has(id) ?? false);
  });
  /** The relations a claim cites, when it states each of them; null when it does not. */
  const statedRelations = (claim: Claim) => {
    const relations = relationsOf(claim);
    const stated = statesOf(claim);
    return relations?.every((relation) => stated.has(relation.id)) ? relations : null;
  };
  /**
   * Whether a claim states its records' relations and says nothing else: the templates of
   * `readRelations` hold nothing but names, the relation's verb and words that name nothing. A
   * claim with a word of its own ("the bass line", "an extended mix") is read in doubt, whatever
   * the judge found: a relation record says only that one record draws on another.
   */
  const statesOnlyItsRelations = (claim: Claim) => statedRelations(claim) !== null;

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
  const nodes = new Map((genealogy?.nodes ?? []).map((node) => [node.id, node]));
  /** The other end of a link that joins this track to `relation`'s record in its direction. */
  const otherEnd = (link: MapLink, relation: CitedRelation) =>
    otherDrawsOn(relation.kind)
      ? link.source === "current"
        ? link.target
        : null
      : link.target === "current"
        ? link.source
        : null;
  /** Whether the map's node `id` is the record's own: the node of its code link, or named so. */
  const isRecordNode = (id: string, relation: CitedRelation, type: string | undefined) => {
    const coded = mapLinks.some(
      (each) =>
        each.origin === "code" &&
        each.type === type &&
        (each.evidenceIds ?? []).includes(relation.id) &&
        otherEnd(each, relation) === id,
    );
    if (coded) return true;
    const drawn = nodeRecord(nodes.get(id));
    if (!drawn || relation.artist === null) return false;
    const credits = new Set(relation.named.artists.map((name) => name.join(" ")));
    return (
      titleNames(drawn.title).some((title) =>
        relation.named.titles.some((own) => own.join(" ") === title.join(" ")),
      ) && artistNames(drawn.artist).some((name) => credits.has(name.join(" ")))
    );
  };
  /**
   * Whether a model link that states `claim` may go with it: it joins this track to each record
   * the claim cites, in the type and direction the record documents, its other end the record's
   * own node, and the map draws that relation already (a code link on the record, of that type)
   * or never does (a relation of the song).
   */
  const linkMayGo = (link: MapLink, claim: Claim) => {
    if (!onMap.has(link) || link.origin === "code") return false;
    const relations = relationsOf(claim) ?? [];
    return (
      relations.length > 0 &&
      relations.every((relation) => {
        const end = otherEnd(link, relation);
        return (
          link.type === LINK_TYPE[relation.kind] &&
          end !== null &&
          isRecordNode(end, relation, link.type) &&
          (relation.ofSong ||
            mapLinks.some(
              (each) =>
                each.origin === "code" &&
                each.type === link.type &&
                (each.evidenceIds ?? []).includes(relation.id),
            ))
        );
      })
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
      !hedges(model) &&
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
      const by = marks(claim) ? documenting(claim) : null;
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

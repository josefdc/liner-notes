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
 *    - or it is about a relation (a sample or a cover) and states only the relations its records
 *      document (`statesOnlyItsRelations`), each record cited by a code claim about the same
 *      relation. The same fact is the same relation between the same two records: the record
 *      it cites gives the pair and the relation's kind (`documentedRelation`: its recordRef and
 *      excerpt), and the claim must name the other record (its title or artist, normalised as
 *      `normalizeTitle` and `normalizeArtist` compare them) and nothing its records, or the
 *      analysed track's title and artist, do not. The judge must have found it supported or
 *      partly supported: a claim found partly supported says something its records do not
 *      back, so it restates them only in their words (each of its words is theirs, the analysed
 *      track's, a form of the relation's word, "samples" or "a cover of", or a connective);
 *    - or, about anything else, the judge found it wholly supported by one code claim's items
 *      and it names nothing they (or the analysed track) do not (`namesOnlyWhatItCites`: every
 *      capitalised word and every number it holds is in their excerpts, a month read as its
 *      number).
 *    A link the model drew on the map that states such a claim goes with it, and so does a node
 *    only those links drew: the relation is shown once, by its record.
 * 2. Then, of the model claims left, the best copy of a fact stays: the one whose citations fit
 *    its scope (`scopeSupports`: the deterministic step left it citing evidence), then the one
 *    with the better verdict (supported, partial, unsupported, then none: a copy the judge
 *    checked, and what it said of it, is never dropped for one it did not check), then the one
 *    on a fact card (the card shows the same statement, with its title), then the first. Taken
 *    best first, a copy goes when it repeats one kept before it. It reads as the same kind
 *    (sourced or inferred: a stricter copy is never dropped for a lenient one), and either
 *    - has the same text (`statementKey`), states a relation or not as that one does, is about
 *      the same scope (or one of the two cites nothing), and cites nothing that one does not;
 *    - or states, in other words, only the relations its records document (as in 1), and that
 *      one is about the same relation, at the same scope, and cites each of those records.
 *
 * Nothing that adds information goes: a claim that cites another item, or more items, one that
 * names what its records do not, adds a word of its own when only partly supported, states
 * another relation than its record's, or is about another scope, stays, judged as it was. So
 * does every claim a timeline sample or a code-built link states, every claim the verifier
 * rejected (it belongs in the rejected panel), every claim the judge did not judge or found
 * unsupported (but a copy of a code claim's text), and every claim compared with a measured
 * value (its `field`, or a numeric check other than "n/a"). A claim left out takes its fact card
 * with it, so it is shown nowhere, and is counted (`restated`, for `run.verifier`). A kept claim
 * is unchanged: its verdict, kind and evidence stay as they were.
 *
 * The step is idempotent: run on its own output it leaves out nothing more. The verifier applies
 * it to every result it builds and always counts it (`run.verifier.restated`, 0 included);
 * `oneClaimPerFact` applies it to a result built before it (a replay, a stored result), unless
 * that count says it already ran. Pure.
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
 * words). A capitalised word that names nothing ("The", "It") is not counted.
 */
export function namesOnlyWhatItCites(text: string, excerpts: readonly string[]): boolean {
  const tokens = (from: string) =>
    from
      .normalize("NFKC")
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

/** The relation kinds a primary record's recordRef names (`…/samples/recording/<id>`). */
const RECORD_RELATION = new RegExp(
  `/(${Object.keys(RELATION_PHRASE).join("|")})/(?:recording|work|song)/[^/]+$`,
);
/** The stem of every form of each relation kind's word ("samples", "a cover of", "remixed"). */
const RELATION_STEM: Record<RelationKind, string> = {
  samples: "sampl",
  "sampled-by": "sampl",
  interpolates: "interpolat",
  "interpolated-by": "interpolat",
  "cover-of": "cover",
  "covered-by": "cover",
  "remix-of": "remix",
  "remixed-by": "remix",
};

/** A relation a primary record documents: its kind, and the other record's title and artist. */
interface DocumentedRelation {
  kind: RelationKind;
  title: string;
  artist: string | null;
}

/**
 * The relation an evidence item documents, read from its recordRef (the kind) and its excerpt
 * (`<this record> <RELATION_PHRASE> "<title>" by <artist>.`, the other record last); null for
 * an item that documents none, or whose excerpt is not written so.
 */
export function documentedRelation(
  item: Pick<Evidence, "recordRef" | "excerpt">,
): DocumentedRelation | null {
  const kind = RECORD_RELATION.exec(item.recordRef ?? "")?.[1] as RelationKind | undefined;
  if (!kind) return null;
  const phrase = ` ${RELATION_PHRASE[kind]} `;
  const at = item.excerpt.lastIndexOf(phrase);
  if (at === -1) return null;
  const other = item.excerpt.slice(at + phrase.length);
  const names = /^"(.+)" by (.+)\.$/su.exec(other) ?? /^"(.+)"\.$/su.exec(other);
  if (!names) return null;
  return { kind, title: names[1], artist: names[2] ?? null };
}

/** True when `text` names `name` as whole words, both read as names are compared. */
function namesWhole(text: string, name: string): boolean {
  const wanted = normalizeName(name);
  return wanted !== "" && ` ${normalizeName(text)} `.includes(` ${wanted} `);
}

/**
 * True when a statement names the other record of `relation`: its title, without
 * featured-artist and remaster suffixes (`normalizeTitle`), or its artist (`normalizeArtist`),
 * as whole words.
 */
function namesOther(text: string, relation: DocumentedRelation): boolean {
  const title = normalizeTitle(relation.title);
  const artist = relation.artist === null ? "" : normalizeArtist(relation.artist);
  return (title !== "" && namesWhole(text, title)) || (artist !== "" && namesWhole(text, artist));
}

/** A statement's words, without case: as `CONNECTIVES` and a record's words are read. */
const wordsOf = (text: string) =>
  text
    .normalize("NFKC")
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

// =============================================================================
// The step
// =============================================================================

/** A link of the result's map, as the step reads it. */
interface MapLink {
  source: string;
  target: string;
  origin?: string;
  claimId?: string;
}
/** The result's map, as the step reads it. */
interface MapLike {
  nodes: readonly { id: string }[];
  links: readonly object[];
}

export interface WithoutRestatements<F, G> {
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
   * claim, and so does a node of the model's that only such links drew. Without it, a claim any
   * link states stays.
   */
  genealogy?: G;
  /** The analysed track: its title and artist are no new name in a statement about it. */
  track?: { title?: string | null; artist?: string | null };
}

/**
 * The claims and fact cards with each restated fact kept once (see the module comment).
 * `stating` holds what else may name a claim by its `claimId` (the genealogy's links, the
 * timeline's samples): a claim one of them states is never left out, but for a claim only the
 * model's links of `context.genealogy` state, which may go with them. `evidence` is the result's
 * pack.
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
  const statedBy = new Map<string, object[]>();
  for (const ref of stating) {
    const id = (ref as { claimId?: unknown }).claimId;
    if (typeof id === "string") statedBy.set(id, [...(statedBy.get(id) ?? []), ref]);
  }
  const genealogy = context.genealogy;
  const mapLinks = new Set<object>(genealogy?.links ?? []);
  /** True when only links the model drew on the map state the claim. */
  const onlyModelLinks = (claim: Claim) =>
    (statedBy.get(claim.id) ?? []).every(
      (ref) => mapLinks.has(ref) && (ref as MapLink).origin !== "code",
    );
  /**
   * A model claim that may go: it is not rejected, no value is its, and no link or sample states
   * it (`withLinks`: or only the model's links on the map do, which then go with it).
   */
  const mayGo = (claim: Claim, withLinks = false) =>
    claim.origin === "model" &&
    (!statedBy.has(claim.id) || (withLinks && onlyModelLinks(claim))) &&
    !claimIsRejected(claim) &&
    claim.field === undefined &&
    (claim.numericCheck ?? "n/a") === "n/a";
  const within = (ids: readonly string[], of: readonly string[]) =>
    ids.every((id) => of.includes(id));
  const sameScope = (a: Claim, b: Claim) => (a.scope ?? "recording") === (b.scope ?? "recording");
  const gone = new Set<string>();

  const excerpts = (claim: Claim) => claim.evidenceIds.map((id) => pack.get(id)?.excerpt);
  const trackNames = [context.track?.title, context.track?.artist].filter(
    (name): name is string => typeof name === "string" && name !== "",
  );
  /** Every name and number of the claim is in what it cites, or names the analysed track. */
  const namesOnlyItsRecord = (claim: Claim) => {
    const cited = excerpts(claim);
    return (
      cited.every((excerpt) => excerpt !== undefined) &&
      namesOnlyWhatItCites(claim.text, [...(cited as string[]), ...trackNames])
    );
  };
  /** The relation each record a claim cites documents; null when one documents none. */
  const relationsOf = (claim: Claim) => {
    const relations = claim.evidenceIds.map((id) => {
      const item = pack.get(id);
      return item ? documentedRelation(item) : null;
    });
    return relations.every((relation) => relation !== null) ? relations : null;
  };
  /**
   * A claim that states the relations its records document and nothing else. It is about a
   * sample or a cover, cites only records of a relation, and names each one's other record (its
   * title or its artist). Then, as the judge found it:
   * - supported (by those records alone): it names nothing they or the analysed track do not
   *   (`namesOnlyItsRecord`);
   * - partly supported: some of it is not in its records, so it may restate them only in their
   *   own words. It names each relation by its word ("samples", "a cover of"), and each of its
   *   words is one of its records', the analysed track's, a form of that relation's word or a
   *   connective (`CONNECTIVES`): a claim that adds even a word of its own ("the bass line",
   *   "a beat later", "a dance track") stays, judged as it was.
   * A claim not judged, or found unsupported, never restates a record.
   */
  const statesOnlyItsRelations = (claim: Claim) => {
    if (!statesRelation(claim) || claim.evidenceIds.length === 0) return false;
    const relations = relationsOf(claim);
    if (!relations?.every((relation) => namesOther(claim.text, relation))) return false;
    if (claim.verdict === "supported") return namesOnlyItsRecord(claim);
    if (claim.verdict !== "partial") return false;
    const words = wordsOf(claim.text);
    const stems = relations.map((relation) => RELATION_STEM[relation.kind]);
    if (!stems.every((stem) => words.some((word) => word.startsWith(stem)))) return false;
    const own = new Set([
      ...CONNECTIVES,
      ...[...(excerpts(claim) as string[]), ...trackNames].flatMap(wordsOf),
    ]);
    return words.every((word) => own.has(word) || stems.some((stem) => word.startsWith(stem)));
  };

  // 1. A model claim that restates code-built claims.
  const code = claims.filter((claim) => claim.origin === "code" && claim.evidenceIds.length > 0);
  /** A code claim's own text, on its record (or within its records), at its scope: any verdict. */
  const sameText = (model: Claim) =>
    model.evidenceIds.length > 0 &&
    code.some(
      (built) =>
        sameScope(model, built) &&
        within(model.evidenceIds, built.evidenceIds) &&
        statementKey(model.text) === statementKey(built.text),
    );
  /** Each record it cites is one a code claim about the same relation, at its scope, cites. */
  const documented = (model: Claim) =>
    model.evidenceIds.every((id) =>
      code.some(
        (built) =>
          built.about === model.about && sameScope(model, built) && built.evidenceIds.includes(id),
      ),
    );
  const restates = (model: Claim) => {
    if (sameText(model)) return true;
    if (statesRelation(model)) return statesOnlyItsRelations(model) && documented(model);
    return (
      model.verdict === "supported" &&
      model.evidenceIds.length > 0 &&
      namesOnlyItsRecord(model) &&
      code.some((built) => sameScope(model, built) && within(model.evidenceIds, built.evidenceIds))
    );
  };
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
  const rank = (claim: Claim) => [
    fits(claim) ? 1 : 0,
    claim.verdict === null ? UNJUDGED_RANK : VERDICT_RANK[claim.verdict],
    claim.factoid !== undefined ? 1 : 0,
  ];
  /** Negative when `a` is the better copy. */
  const compare = (a: Claim, b: Claim) => {
    const [ra, rb] = [rank(a), rank(b)];
    const at = ra.findIndex((value, i) => value !== rb[i]);
    return at === -1 ? 0 : rb[at] - ra[at];
  };
  /** Whether `copy`, with `kept`'s text, repeats it, adding nothing to it. */
  const repeats = (copy: Claim, kept: Claim) =>
    copy.kind === kept.kind &&
    statesRelation(copy) === statesRelation(kept) &&
    (sameScope(copy, kept) || copy.evidenceIds.length === 0 || kept.evidenceIds.length === 0) &&
    within(copy.evidenceIds, kept.evidenceIds);
  /**
   * Whether `copy`, in other words, states a relation `kept` states too, and nothing else: it
   * states only the relations its records document, and `kept` is about the same relation, at
   * the same scope, reads as the same kind and cites each of those records.
   */
  const sameFact = (copy: Claim, kept: Claim) =>
    copy.about === kept.about &&
    copy.kind === kept.kind &&
    sameScope(copy, kept) &&
    within(copy.evidenceIds, kept.evidenceIds) &&
    statesOnlyItsRelations(copy);
  const models = claims.filter((claim) => claim.origin === "model" && !gone.has(claim.id));
  const keyOf = new Map(models.map((claim) => [claim.id, statementKey(claim.text)]));
  // Best first; equals in result order (the sort is stable).
  const kept: Claim[] = [];
  for (const claim of [...models].sort(compare)) {
    const key = keyOf.get(claim.id);
    const copyOf = (other: Claim) =>
      (key !== "" && keyOf.get(other.id) === key && repeats(claim, other)) ||
      sameFact(claim, other);
    if (mayGo(claim) && kept.some(copyOf)) gone.add(claim.id);
    else kept.push(claim);
  }

  if (gone.size === 0) {
    return { claims: [...claims], factoids: [...factoids], genealogy: genealogy as G, restated: 0 };
  }
  return {
    claims: claims.filter((claim) => !gone.has(claim.id)),
    factoids: factoids.filter((card) => card.claimId === undefined || !gone.has(card.claimId)),
    genealogy: (genealogy === undefined ? genealogy : withoutLinksOf(genealogy, gone)) as G,
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
 * A result built before the step ran (a replay of an older recording, a stored result) with each
 * fact stated once, and how many claims were left out. A result whose verifier summary counts the
 * step (`run.verifier.restated`) is returned as it is: the step already ran. Otherwise the count
 * is written into its verifier summary, when it has one; a result without one (a result from the
 * long-term store, which keeps no run information) has nowhere to hold it, and the caller logs it.
 */
export function oneClaimPerFact<T extends ResultClaims>(
  result: T,
): { result: T; restated: number } {
  const verifier = result.run?.verifier;
  if (verifier && verifier.restated !== undefined) return { result, restated: 0 };
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
  if (kept.restated === 0 && !verifier) return { result, restated: 0 };
  const mapChanged =
    map !== undefined && kept.genealogy !== undefined && kept.genealogy.links !== map.links;
  return {
    result: {
      ...result,
      ...(kept.restated > 0 ? { claims: kept.claims, factoids: kept.factoids } : {}),
      ...(mapChanged ? { genealogy: { ...result.genealogy, ...kept.genealogy } } : {}),
      ...(result.run && verifier
        ? { run: { ...result.run, verifier: { ...verifier, restated: kept.restated } } }
        : {}),
    },
    restated: kept.restated,
  };
}

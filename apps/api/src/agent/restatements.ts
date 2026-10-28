/**
 * One claim per fact. Once the model's claims and the code-built ones (codeClaims.ts) are judged
 * side by side, some state the same fact twice: the model restates a record a code claim already
 * states, or writes one statement twice under two subjects. `withoutRestatements` keeps one claim
 * of each such fact and leaves the others out of the result, in this order:
 *
 * 1. A model claim that restates a code-built claim goes, and the code claim stays (it is sourced
 *    on its record by construction). A restatement cites only items the code claim cites (the one
 *    primary record it is built from, never another item), at the same scope, and states nothing
 *    beyond that record: its text is the code claim's (`statementKey`), or the judge found it
 *    wholly supported (`supported`) by those items alone and it names nothing they do not
 *    (`namesOnlyWhatItCites`: every capitalised word and every number it holds is in their
 *    excerpts, a month read as its number). One about a sample or a cover must be about the code
 *    claim's relation too.
 * 2. Then, of the model claims left with the same text (`statementKey`), the best copy stays: the
 *    one whose citations fit its scope (`scopeSupports`: the deterministic step left it citing
 *    evidence), then the one with the better verdict (supported, partial, not judged,
 *    unsupported), then the one on a fact card (the card shows the same statement, with its
 *    title), then the first. Taken best first, a copy goes when it repeats one kept before it:
 *    it reads as the same kind (sourced or inferred), states a relation or not as that one does,
 *    is about the same scope (or one of the two cites nothing), and cites nothing that one does
 *    not. A stricter copy (inferred) is never dropped for a lenient one (sourced).
 *
 * Nothing that adds information goes: a claim that cites another item, or more items, a claim
 * the judge found only partly supported, one that names what its record does not, about another
 * relation or another scope, stays. So does every claim a link or a timeline sample states, every
 * claim the verifier rejected (it belongs in the rejected panel), and every claim compared with a
 * measured value (its `field`, or a numeric check other than "n/a"). A claim left out takes its
 * fact card with it, so it is shown nowhere, and is counted (`restated`, for `run.verifier`). A
 * kept claim is unchanged: its verdict, kind and evidence stay as they were.
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
/** A claim the judge did not judge ranks between a partial verdict and an unsupported one. */
const UNJUDGED_RANK = 2;

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
 * A statement as it is compared: its case, quotes, apostrophes and sentence punctuation do not
 * count, nor compatibility forms (NFKC: "ﬁ" is "fi"). What changes a fact does: an accidental
 * ("B♭", "C#", "C♯"), a percent sign, a sign before a number ("-3 dB") and a decimal or thousands
 * separator between digits ("1.5", "1,500").
 */
export function statementKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
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
 * its value ("02" is 2); a month also by its number ("February" is in "2001-02-26"). A
 * capitalised word that names nothing ("The", "It") is not counted.
 */
export function namesOnlyWhatItCites(text: string, excerpts: readonly string[]): boolean {
  const tokens = (from: string) =>
    from
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const words = new Set<string>();
  const numbers = new Set<number>();
  for (const token of excerpts.flatMap(tokens)) {
    words.add(token.toLowerCase());
    if (/^[0-9]+$/.test(token)) numbers.add(Number(token));
  }
  return tokens(text).every((token) => {
    if (/^[0-9]+$/.test(token)) return numbers.has(Number(token));
    const month = monthOf(token);
    if (month !== null && /^\p{Lu}/u.test(token)) {
      return words.has(token.toLowerCase()) || numbers.has(month);
    }
    if (!/^\p{Lu}/u.test(token) && !/\p{N}/u.test(token)) return true;
    return FUNCTION_WORDS.has(token.toLowerCase()) || words.has(token.toLowerCase());
  });
}

// =============================================================================
// The step
// =============================================================================

export interface WithoutRestatements<F> {
  claims: Claim[];
  factoids: F[];
  /** How many claims were left out. */
  restated: number;
}

/** What the step reads of an evidence item. */
type CitedItem = Pick<Evidence, "id" | "sourceTier" | "recordRef" | "excerpt">;

/**
 * The claims and fact cards with each restated fact kept once (see the module comment).
 * `stating` holds what else may name a claim by its `claimId` (the genealogy's links, the
 * timeline's samples): a claim one of them states is never left out. `evidence` is the result's
 * pack.
 */
export function withoutRestatements<F extends { claimId?: string }>(
  claims: readonly Claim[],
  factoids: readonly F[],
  stating: readonly object[],
  evidence: readonly CitedItem[],
): WithoutRestatements<F> {
  const pack = new Map(evidence.map((item) => [item.id, item]));
  const stated = new Set(
    stating.flatMap((ref) => {
      const id = (ref as { claimId?: unknown }).claimId;
      return typeof id === "string" ? [id] : [];
    }),
  );
  /** A model claim that may go: no link or sample states it, it is not rejected, no value is its. */
  const mayGo = (claim: Claim) =>
    claim.origin === "model" &&
    !stated.has(claim.id) &&
    !claimIsRejected(claim) &&
    claim.field === undefined &&
    (claim.numericCheck ?? "n/a") === "n/a";
  const within = (ids: readonly string[], of: readonly string[]) =>
    ids.every((id) => of.includes(id));
  const sameScope = (a: Claim, b: Claim) => (a.scope ?? "recording") === (b.scope ?? "recording");
  const gone = new Set<string>();

  // 1. A model claim that restates a code-built claim.
  const code = claims.filter((claim) => claim.origin === "code" && claim.evidenceIds.length > 0);
  const excerpts = (claim: Claim) => claim.evidenceIds.map((id) => pack.get(id)?.excerpt);
  const namesOnlyItsRecord = (claim: Claim) => {
    const cited = excerpts(claim);
    return (
      cited.every((excerpt) => excerpt !== undefined) &&
      namesOnlyWhatItCites(claim.text, cited as string[])
    );
  };
  const restates = (model: Claim, built: Claim) =>
    sameScope(model, built) &&
    model.evidenceIds.length > 0 &&
    within(model.evidenceIds, built.evidenceIds) &&
    (statementKey(model.text) === statementKey(built.text) ||
      (model.verdict === "supported" &&
        (!statesRelation(model) || model.about === built.about) &&
        namesOnlyItsRecord(model)));
  for (const claim of claims) {
    if (mayGo(claim) && code.some((built) => restates(claim, built))) gone.add(claim.id);
  }

  // 2. One copy of a statement the model wrote more than once, of what is left.
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
  /** Whether `copy` repeats `kept`, adding nothing to it. */
  const repeats = (copy: Claim, kept: Claim) =>
    copy.kind === kept.kind &&
    statesRelation(copy) === statesRelation(kept) &&
    (sameScope(copy, kept) || copy.evidenceIds.length === 0 || kept.evidenceIds.length === 0) &&
    within(copy.evidenceIds, kept.evidenceIds);
  const copies = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (claim.origin !== "model" || gone.has(claim.id)) continue;
    const key = statementKey(claim.text);
    if (key === "") continue;
    copies.set(key, [...(copies.get(key) ?? []), claim]);
  }
  for (const group of copies.values()) {
    if (group.length < 2) continue;
    // Best first; equals in result order (the sort is stable).
    const kept: Claim[] = [];
    for (const claim of [...group].sort(compare)) {
      if (mayGo(claim) && kept.some((other) => repeats(claim, other))) gone.add(claim.id);
      else kept.push(claim);
    }
  }

  if (gone.size === 0) return { claims: [...claims], factoids: [...factoids], restated: 0 };
  return {
    claims: claims.filter((claim) => !gone.has(claim.id)),
    factoids: factoids.filter((card) => card.claimId === undefined || !gone.has(card.claimId)),
    restated: gone.size,
  };
}

/** The parts of a result the step reads and changes. */
export interface ResultClaims {
  claims?: Claim[];
  factoids?: Array<{ claimId?: string }>;
  genealogy?: { links?: readonly object[] } | null;
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
  const kept = withoutRestatements(
    result.claims ?? [],
    result.factoids ?? [],
    [...(result.genealogy?.links ?? []), ...(result.samples ?? [])],
    result.evidence ?? [],
  );
  if (kept.restated === 0 && !verifier) return { result, restated: 0 };
  return {
    result: {
      ...result,
      ...(kept.restated > 0 ? { claims: kept.claims, factoids: kept.factoids } : {}),
      ...(result.run && verifier
        ? { run: { ...result.run, verifier: { ...verifier, restated: kept.restated } } }
        : {}),
    },
    restated: kept.restated,
  };
}

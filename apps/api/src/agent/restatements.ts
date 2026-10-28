/**
 * One claim per fact. Once the model's claims and the code-built ones (codeClaims.ts) are judged
 * side by side, some state the same fact twice: the model restates a record a code claim already
 * states, or writes one statement twice under two subjects. `withoutRestatements` keeps one claim
 * of each such fact and leaves the others out of the result:
 *
 * 1. A model claim that restates a code-built claim goes, and the code claim stays (it is sourced
 *    on its record by construction). A restatement cites only items the code claim cites (the one
 *    primary record it is built from, never another item), at the same scope, and states nothing
 *    beyond that record: its text is the code claim's, word for word, or the judge found it
 *    wholly supported (`supported`) by those items alone. One about a sample or a cover must be
 *    about the code claim's relation too.
 * 2. Of two model claims with the same text, one stays: the one whose citations fit its scope
 *    (`scopeSupports`: the deterministic step left it citing evidence), then the one with the
 *    better verdict (supported, partial, not judged, unsupported, contradicted), then the one on
 *    a fact card (the card shows the same statement, with its title), then the first. The other
 *    goes only when it cites nothing the kept one does not.
 *
 * Nothing that adds information goes: a claim that cites another item, or more items, a claim
 * the judge found only partly supported, about another relation or another scope, stays. So does
 * every claim a link or a timeline sample states, and every claim compared with a measured value
 * (its `field`, or a numeric check other than "n/a"). A claim left out takes its fact card with
 * it, so it is shown nowhere, and is counted (`restated`, for `run.verifier`). A kept claim is
 * unchanged: its verdict, kind and evidence stay as they were.
 *
 * The verifier applies it to every result it builds, and a replay to the result it serves
 * (replay/player.ts), so a recording made before it shows each fact once too. Pure.
 */

import {
  type Claim,
  type ClaimAbout,
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

/** How a verdict ranks when two copies of one statement compete: higher stays. */
const VERDICT_RANK: Record<Verdict, number> = {
  supported: 4,
  partial: 3,
  unsupported: 1,
  contradicted: 0,
};
/** A claim the judge did not judge ranks between a partial verdict and an unsupported one. */
const UNJUDGED_RANK = 2;

/** A statement's words, in order, without case, punctuation or the kind of quotes it uses. */
export function statementKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
}

export interface WithoutRestatements<F> {
  claims: Claim[];
  factoids: F[];
  /** How many claims were left out. */
  restated: number;
}

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
  evidence: readonly Pick<Evidence, "id" | "sourceTier" | "recordRef">[],
): WithoutRestatements<F> {
  const pack = new Map(evidence.map((item) => [item.id, item]));
  const stated = new Set(
    stating.flatMap((ref) => {
      const id = (ref as { claimId?: unknown }).claimId;
      return typeof id === "string" ? [id] : [];
    }),
  );
  /** A model claim that may go: no link or sample states it, and no measured value is its. */
  const mayGo = (claim: Claim) =>
    claim.origin === "model" &&
    !stated.has(claim.id) &&
    claim.field === undefined &&
    (claim.numericCheck ?? "n/a") === "n/a";
  const within = (ids: readonly string[], of: readonly string[]) =>
    ids.every((id) => of.includes(id));
  const sameScope = (a: Claim, b: Claim) => (a.scope ?? "recording") === (b.scope ?? "recording");

  const gone = new Set<string>();

  // 2. One copy of a statement the model wrote twice.
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
  const better = (a: Claim, b: Claim) => {
    const [ra, rb] = [rank(a), rank(b)];
    const at = ra.findIndex((value, i) => value !== rb[i]);
    return at !== -1 && ra[at] > rb[at];
  };
  const copies = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (claim.origin !== "model") continue;
    const key = statementKey(claim.text);
    if (key === "") continue;
    copies.set(key, [...(copies.get(key) ?? []), claim]);
  }
  for (const group of copies.values()) {
    if (group.length < 2) continue;
    // The best copy, the first of equals; then every other copy that adds nothing to it.
    const kept = group.reduce((best, claim) => (better(claim, best) ? claim : best));
    for (const claim of group) {
      if (claim !== kept && mayGo(claim) && within(claim.evidenceIds, kept.evidenceIds)) {
        gone.add(claim.id);
      }
    }
  }

  // 1. A model claim that restates a code-built claim.
  const code = claims.filter((claim) => claim.origin === "code" && claim.evidenceIds.length > 0);
  const restates = (model: Claim, built: Claim) =>
    sameScope(model, built) &&
    model.evidenceIds.length > 0 &&
    within(model.evidenceIds, built.evidenceIds) &&
    (statementKey(model.text) === statementKey(built.text) ||
      (model.verdict === "supported" &&
        (!RELATION_SUBJECTS.has(model.about) || model.about === built.about)));
  for (const claim of claims) {
    if (gone.has(claim.id) || !mayGo(claim)) continue;
    if (code.some((built) => restates(claim, built))) gone.add(claim.id);
  }

  if (gone.size === 0) return { claims: [...claims], factoids: [...factoids], restated: 0 };
  return {
    claims: claims.filter((claim) => !gone.has(claim.id)),
    factoids: factoids.filter((card) => card.claimId === undefined || !gone.has(card.claimId)),
    restated: gone.size,
  };
}

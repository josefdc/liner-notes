import {
  type Claim,
  type ClaimKind,
  type Evidence,
  GenealogyLink,
  type LinkKind,
  type LinkType,
  LINK_CLAIM_ABOUT,
  linkClaimMismatches,
  linkDisplayKind as contractLinkDisplayKind,
  sharedClaimIds,
} from '@liner-notes/contract';
import { readEvidence, type ResultClaims } from '../provenance/claims';
import { sourceLabel } from '../provenance/SourceLink';
import { isRelationSubject, LINK_TYPE_LABEL, relationName } from './relationWords';

export { LINK_TYPE_LABEL } from './relationWords';

/**
 * How the web app reads and names genealogy links. Each link is read with the contract's link
 * schema and shown by the contract's rule (`linkDisplayKind`, given the result's claims:
 * sourced only when it says so, every evidence id it cites is in the result's evidence pack,
 * and a link that states a claim (`claimId`), whatever its origin, is sourced only when no
 * claim with that id is rejected, the claim reads sourced, cites every id the link cites and is
 * about the link's relation, and no other link states it (one relation claim per link, never
 * shared); a model link must state one: citing is not support). This app
 * applies the claim rule itself too, to say why, and adds two rules of its own:
 * - a link whose claim the main view hides (rejected by the verifier, or unreadable: the one
 *   rule of `resultClaims` in provenance/claims.ts) is not shown at all;
 * - a link whose direction contradicts the release years is "related (direction unknown)";
 * - a link whose claim the verifier found only partly supported is not sourced: a relation is
 *   stated whole, as the API's verifier reads it and as a fact's card reads the same claim
 *   (results stored before the API did so may still carry such a claim as sourced).
 *
 * Direction, as the contract states it (`GenealogyLink`): `source` is the earlier record, the
 * one that is sampled, interpolated, covered, remixed or that influenced; `target` is the
 * record that uses it. Every relation is written out as a sentence naming both tracks with
 * their years, and a link whose years say otherwise is not given a direction.
 */

/** Every relation a link may state, in the order the legend lists them. */
export const LINK_TYPES: readonly LinkType[] = [
  'sample',
  'interpolation',
  'cover',
  'remix',
  'producer',
  'influence',
];

/**
 * Relations that state a documented fact about a recording. Without evidence they are not
 * shown as such: a sample that is not sourced is drawn as an inferred influence (the contract's
 * rule, which the API applies to the links the model proposes: grey and dashed, never in a
 * relation's colour), named in words as the possible sample it states (`relationName`), and it
 * marks no track as an origin.
 */
const DOCUMENTED = new Set<LinkType>(['sample', 'interpolation', 'cover', 'remix']);

/** An evidence id a link cites, with the pack's item for it (null when it is not in the pack). */
export interface Citation {
  id: string;
  evidence: Evidence | null;
}

/** A link as the app shows it. */
export interface ShownLink {
  source: string;
  target: string;
  /** Strength 1-3, as sent. */
  value: number;
  /** How the link is shown: by the contract's rule and this app's stricter ones (see above). */
  kind: LinkKind;
  /** The kind the link states (null when it states none: older results). */
  statedKind: LinkKind | null;
  /** Who wrote the link (null when it does not say: older results). */
  origin: 'code' | 'model' | null;
  /** The relation the link states (null when it states none: older results). */
  statedType: LinkType | null;
  /**
   * The relation it is drawn as (its colour): the stated one, except that a sample,
   * interpolation, cover or remix that is not sourced is an influence, and a link that states
   * no relation is an influence.
   */
  type: LinkType;
  /**
   * The relation it is named as: the stated one (an influence when it states none, or when the
   * years contradict its direction), named as known only when the link is sourced: "Sample",
   * else "Possible sample" (`relationLabel`).
   */
  named: LinkType;
  /** False when the release years contradict the link's direction: it is only "related". */
  directionKnown: boolean;
  /** The evidence ids the link cites, in its order. */
  citations: Citation[];
  /** The claim that states the relation (`claimId`), when the result carries it. */
  claim: Claim | null;
  /** Why the link is not shown as sourced, in words (empty when it is sourced). */
  reasons: string[];
}

/** What a link is read against: the result's evidence pack and claims. */
export interface LinkContext {
  /** The pack's items the contract can read, by id. */
  evidence: ReadonlyMap<string, Evidence>;
  /** False when the result carries no evidence pack at all. */
  hasPack: boolean;
  /** The readable claim with this id and how its chip shows it, or null. */
  claimOf: (id: string) => { claim: Claim; kind: ClaimKind } | null;
  /** The readable claims by id (the first with each id), for the contract's link rule. */
  claims: ReadonlyMap<string, Claim>;
  /** The ids any claim was rejected under, whichever copy, for the contract's link rule. */
  rejectedClaimIds: ReadonlySet<string>;
  /**
   * The claim ids more than one of the genealogy's links states, for the contract's link rule
   * (`readGenealogy` sets them from the links it reads; empty otherwise).
   */
  sharedClaimIds: ReadonlySet<string>;
  /** True for a claim id the main view shows nothing for (`ResultClaims.isHidden`). */
  isHidden: (id: string) => boolean;
  /** The analysed track's release year, for its node when the node's label names none. */
  trackYear: number | null;
}

/** A track of the genealogy, as a relation names it. */
export interface NamedNode {
  id: string;
  label: string;
  trackTitle?: string;
  /**
   * Its release year when its label does not end with one: the year of its first release that
   * the API took from MusicBrainz, or else (the analysed track's) the result's release year.
   */
  year?: number;
}

/** A result's evidence pack by id: the items the contract can read (others are left out). */
export function evidencePack(evidence: unknown): ReadonlyMap<string, Evidence> {
  const pack = new Map<string, Evidence>();
  for (const item of readEvidence(evidence)) if (!pack.has(item.id)) pack.set(item.id, item);
  return pack;
}

/**
 * What a result's links are read against: its evidence pack, and its claims as `resultClaims`
 * reads them (null when there are none to read: no link then has a claim).
 */
export function linkContext(
  evidence: unknown,
  claims: ResultClaims | null | undefined,
  { releaseYear }: { releaseYear?: unknown } = {},
): LinkContext {
  return {
    evidence: evidencePack(evidence),
    hasPack: Array.isArray(evidence),
    claimOf: (id) => {
      const shown = claims?.byId.get(id);
      return shown ? { claim: shown.claim, kind: shown.kind } : null;
    },
    claims: new Map([...(claims?.byId ?? [])].map(([id, shown]) => [id, shown.claim])),
    rejectedClaimIds: claims?.rejectedIds ?? new Set(),
    sharedClaimIds: new Set(),
    isHidden: (id) => claims?.isHidden(id) ?? false,
    trackYear: yearFrom(releaseYear),
  };
}

/** A year from a result's `releaseYear` ("2011", "2011-05-02"), or null. */
export function yearFrom(value: unknown): number | null {
  const match =
    typeof value === 'string' || typeof value === 'number'
      ? /^(\d{4})/.exec(String(value).trim())
      : null;
  return match ? Number(match[1]) : null;
}

/**
 * The kind of a link by the contract's `linkDisplayKind`, against the pack's ids, the result's
 * claims and the ids any claim was rejected under (without claims, no link that states one and
 * no model link reads as sourced).
 */
export function linkDisplayKind(
  link: GenealogyLink,
  evidence: ReadonlyMap<string, Evidence>,
  claims: ReadonlyMap<string, Claim> = new Map(),
  rejectedClaimIds: ReadonlySet<string> = new Set(),
  sharedLinkClaimIds: ReadonlySet<string> = new Set(),
): LinkKind {
  return contractLinkDisplayKind(link, {
    evidenceIds: new Set(evidence.keys()),
    audio: null,
    claims,
    rejectedClaimIds,
    sharedLinkClaimIds,
  });
}

/** A year in brackets at the end of a label: "Title - Artist (1984)". */
export const LABEL_YEAR = /\s*\((\d{4})\)\s*$/;

/** The year a label ends with, when it is one a node may carry (as `nodeYear` reads one). */
export function labelYear(label: string): number | null {
  const match = LABEL_YEAR.exec(label);
  return match ? nodeYear(Number(match[1])) : null;
}

/**
 * A node's release year for the direction check (`readLink`): the one the API took from
 * MusicBrainz (`year`; the analysed track's falls back on the result's release year), else the
 * one its label ends with; null otherwise. A track is never named or placed by it: a label's year
 * may be the model's (`recordYear`).
 */
export function yearOf(node: NamedNode | undefined): number | null {
  if (!node) return null;
  return node.year ?? labelYear(node.label);
}

/**
 * A node's year as a record dates it: the one the API took from MusicBrainz (`year`), or, for the
 * analysed track, the result's release year (both set by `nodesById`); null otherwise. Never a
 * year from a label: the model writes its tracks as "Title - Artist (Year)", and a year it wrote
 * is not a record's. The map places a card and prints its year from this alone.
 */
export function recordYear(node: NamedNode | undefined): number | null {
  return node?.year ?? null;
}

/**
 * How a relation names a track: its title and the year a record gives it (`recordYear`; never a
 * year the model wrote in a label), or, with no title of its own, its label as written.
 */
export function nodeName(node: NamedNode | undefined, id: string): string {
  if (!node) return id;
  const year = recordYear(node);
  const title = node.trackTitle?.trim();
  return title ? `${title}${year === null ? '' : ` (${year})`}` : node.label;
}

const list = (items: readonly string[]) => items.join(', ');

/**
 * An evidence id in words, as a claim's chip names the same item (`sourceLabel`): the source,
 * its tier as the contract's rules allow it (only for a sourced link), and what its record is
 * about when that is not this recording.
 */
function citationText(citation: Citation, showTier: boolean): string {
  return citation.evidence
    ? `${citation.id} (${sourceLabel(citation.evidence, showTier)})`
    : citation.id;
}

type Read = { link: ShownLink } | { hidden: true } | null;

/**
 * A link as the app shows it; `{ hidden: true }` when the main view hides its claim (rejected
 * by the verifier, or unreadable); null when the contract's link schema cannot read it.
 */
export function readLink(
  value: unknown,
  context: LinkContext,
  nodes: ReadonlyMap<string, NamedNode> = new Map(),
): Read {
  const parsed = GenealogyLink.safeParse(value);
  if (!parsed.success) return null;
  const link = parsed.data;
  if (link.claimId && context.isHidden(link.claimId)) return { hidden: true };
  const claimed = link.claimId ? context.claimOf(link.claimId) : null;
  const claim = claimed?.claim ?? null;

  const statedType = link.type ?? null;
  const origin = link.origin ?? null;
  const citations = (link.evidenceIds ?? []).map((id) => ({
    id,
    evidence: context.evidence.get(id) ?? null,
  }));
  const reasons: string[] = [];

  // Direction: the record a link starts from must not be newer than the one it points at. A
  // code-built sourced link's direction is documented by the record it is built from (which
  // recording samples which), so years never overrule it; a model's link is checked.
  const [fromYear, toYear] = [yearOf(nodes.get(link.source)), yearOf(nodes.get(link.target))];
  const documented = origin === 'code' && link.kind === 'sourced';
  const directionKnown =
    statedType === 'producer' ||
    documented ||
    fromYear === null ||
    toYear === null ||
    fromYear <= toYear;
  if (!directionKnown) {
    reasons.push(`the years (${fromYear} and ${toYear}) do not fit this direction`);
  }

  // The contract's rule, given the result's claims: a link that states a claim is sourced only
  // through it, whoever wrote the link, and a model link without one is never sourced (citing
  // is not support). The same rule is applied here to say why, with the claim as its chip
  // reads it. The reasons are given only for a link whose evidence alone would make it sourced.
  let kind = linkDisplayKind(
    link,
    context.evidence,
    context.claims,
    context.rejectedClaimIds,
    context.sharedClaimIds,
  );
  const citesPack =
    link.kind === 'sourced' && citations.length > 0 && citations.every((c) => c.evidence !== null);
  if (citesPack && claimed) {
    const mismatches = linkClaimMismatches(link, claimed.claim);
    if (claimed.kind !== 'sourced') {
      kind = 'inferred';
      if (!claim?.verdict) reasons.push('its claim is not sourced');
    } else if (link.claimId && context.sharedClaimIds.has(link.claimId)) {
      kind = 'inferred';
      reasons.push('its claim is also stated by another link');
    } else if (mismatches.length > 0) {
      kind = 'inferred';
      reasons.push(...mismatches.map((mismatch) => `its claim ${mismatch}`));
    }
  } else if (citesPack && origin === 'model') {
    kind = 'inferred';
    reasons.push('proposed by the model; no verifier verdict supports it');
  }
  if (!directionKnown) kind = 'inferred';
  if (kind === 'inferred' && claim?.verdict) {
    reasons.push(
      `the verifier found its claim ${claim.verdict === 'partial' ? 'only partly supported' : claim.verdict}`,
    );
  }

  if (kind === 'inferred') {
    // Without a direction the link is only "related": the reasons say what it was stated as.
    if (!directionKnown && statedType !== null && DOCUMENTED.has(statedType)) {
      reasons.unshift(`stated as ${article(LINK_TYPE_LABEL[statedType])}`);
    }
    const known = citations.filter((c) => c.evidence !== null);
    const unknown = citations.filter((c) => c.evidence === null);
    if (unknown.length > 0) {
      reasons.push(
        context.hasPack
          ? `cites ${list(unknown.map((c) => c.id))}, not in the evidence pack`
          : `cites ${list(unknown.map((c) => c.id))}; this result has no evidence pack`,
      );
    }
    if (known.length > 0) {
      // A code link is sourced on the record it is built from, not on a verifier's verdict.
      const checked =
        origin === 'code'
          ? ', the record it is built from'
          : claim?.verdict
            ? ''
            : ', not checked by a verifier';
      reasons.push(`cites ${list(known.map((c) => citationText(c, false)))}${checked}`);
    }
    if (citations.length === 0) {
      reasons.push(
        link.kind === 'sourced' ? 'says sourced but cites no evidence' : 'no evidence cited',
      );
    }
    if (link.claimId && !claim) reasons.push('its claim is not in this result');
  }

  const type: LinkType =
    statedType === null || (kind !== 'sourced' && DOCUMENTED.has(statedType))
      ? 'influence'
      : statedType;
  const named: LinkType = directionKnown ? (statedType ?? 'influence') : 'influence';
  return {
    link: {
      source: link.source,
      target: link.target,
      value: link.value,
      kind,
      statedKind: link.kind ?? null,
      origin,
      statedType,
      type,
      named,
      directionKnown,
      citations,
      claim,
      reasons,
    },
  };
}

/** What a genealogy shows: its links, and how many were left out. */
export interface GenealogyReading {
  links: ShownLink[];
  /** Links not shown because the main view hides their claim. */
  hidden: number;
}

/** A node's year as the API sets it (from MusicBrainz): a whole number of four digits, or null. */
function nodeYear(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 9999
    ? value
    : null;
}

/**
 * The genealogy's nodes, by id (entries that are not nodes are left out), each with the year
 * the API took from MusicBrainz for it (`year`), when it has one. The analysed track's node
 * (group 1) takes the earlier of that year and `trackYear`, used when its label names no year:
 * the API labels it with the title alone.
 */
export function nodesById(
  nodes: unknown,
  trackYear: number | null = null,
): ReadonlyMap<string, NamedNode> {
  const byId = new Map<string, NamedNode>();
  if (!Array.isArray(nodes)) return byId;
  for (const node of nodes) {
    if (node && typeof node === 'object' && typeof (node as NamedNode).id === 'string') {
      const { id, label, trackTitle } = node as NamedNode;
      const isCurrent = (node as { group?: unknown }).group === 1;
      // The analysed track: the earlier of its MusicBrainz year and the result's release year
      // (a recording is not released after the release that carries it).
      const own = nodeYear((node as { year?: unknown }).year);
      const year = isCurrent && trackYear !== null ? Math.min(own ?? trackYear, trackYear) : own;
      byId.set(id, {
        id,
        label: typeof label === 'string' ? label : id,
        ...(typeof trackTitle === 'string' ? { trackTitle } : {}),
        ...(year !== null ? { year } : {}),
      });
    }
  }
  return byId;
}

/**
 * The links of a genealogy that can be shown: those the contract's schema reads whose source
 * and target are both in the node list, in their order, read against the result's evidence pack
 * and claims (`context`; without them every link is a model inference). Links whose claim the
 * main view hides are counted, not shown.
 */
export function readGenealogy(
  genealogy: { nodes?: unknown; links?: unknown } | null | undefined,
  context: LinkContext = linkContext(undefined, null),
): GenealogyReading {
  const nodes = nodesById(genealogy?.nodes, context.trackYear);
  const values: unknown[] = Array.isArray(genealogy?.links) ? genealogy.links : [];
  // As the contract counts them: over every link its schema reads, drawn or not.
  const readable = values.flatMap((value) => {
    const parsed = GenealogyLink.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const withShared = { ...context, sharedClaimIds: sharedClaimIds(readable) };
  const links: ShownLink[] = [];
  let hidden = 0;
  for (const value of values) {
    const read = readLink(value, withShared, nodes);
    if (read === null) continue;
    if ('hidden' in read) {
      hidden += 1;
      continue;
    }
    if (nodes.has(read.link.source) && nodes.has(read.link.target)) links.push(read.link);
  }
  return { links, hidden };
}

/** The links of a genealogy that can be shown (see `readGenealogy`). */
export function shownLinks(
  genealogy: { nodes?: unknown; links?: unknown } | null | undefined,
  context?: LinkContext,
): ShownLink[] {
  return readGenealogy(genealogy, context).links;
}

function article(label: string): string {
  return `${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label.toLowerCase()}`;
}

/** The kind of a link in words: sourced, a model inference, or not sourced (code-built). */
export function kindLabel(link: ShownLink): string {
  if (link.kind === 'sourced') return 'Sourced';
  // A link built by code, or one that says it is sourced, is not the model's inference.
  return link.origin === 'code' || (link.origin === null && link.statedKind === 'sourced')
    ? 'Not sourced'
    : 'Model inference';
}

/**
 * The provenance chip of a link, by its kind in words (kindLabel): sourced (amber, a book), a
 * model inference (violet, sparkles), or not sourced (neutral: built from records whose evidence
 * does not hold, not the model's).
 */
export function linkProvenanceKind(link: ShownLink): 'sourced' | 'inferred' | 'unconfirmed' {
  const label = kindLabel(link);
  return label === 'Sourced' ? 'sourced' : label === 'Model inference' ? 'inferred' : 'unconfirmed';
}

/** Where a link comes from, in words: its kind, the evidence it cites, and why it is not sourced. */
export function provenanceText(link: ShownLink): string {
  if (link.kind === 'sourced') {
    return `Sourced · cites ${list(link.citations.map((c) => citationText(c, true)))}`;
  }
  return `${kindLabel(link)} · ${link.reasons.join('; ')}`;
}

/** The relation as a sentence naming both tracks, e.g. "Bright Lines (2011) samples X (1984)". */
export function relationSentence(link: ShownLink, nameOf: (id: string) => string): string {
  const from = nameOf(link.source);
  const to = nameOf(link.target);
  if (!link.directionKnown) return `${from} and ${to} are related (direction unknown)`;
  if (link.kind !== 'sourced') {
    switch (link.named) {
      case 'producer':
        return `${from} and ${to} may share a producer`;
      case 'influence':
        return `Possible influence between ${from} and ${to}`;
      default:
        // "Possible sample: Bright Lines (2011) may sample X (1984)", in relationLabel's words.
        return `${relationLabel(link)}: ${to} may ${VERB[link.named]} ${from}`;
    }
  }
  switch (link.type) {
    case 'sample':
      return `${to} samples ${from}`;
    case 'interpolation':
      return `${to} interpolates ${from}`;
    case 'cover':
      return `${to} covers ${from}`;
    case 'remix':
      return `${to} remixes ${from}`;
    case 'producer':
      return `${from} and ${to} share a producer`;
    case 'influence':
      return `${from} influenced ${to}`;
  }
}

/** What the later record of a documented relation does to the earlier one. */
const VERB: Record<'sample' | 'interpolation' | 'cover' | 'remix', string> = {
  sample: 'sample',
  interpolation: 'interpolate',
  cover: 'cover',
  remix: 'remix',
};

/**
 * A short name for the relation, hedged when it is not sourced (a card's badge, a line's label):
 * `relationName`, the words a fact's card uses for the same relation.
 */
export function relationLabel(link: ShownLink): string {
  if (!link.directionKnown) return 'Related, direction unknown';
  return relationName(link.named, link.kind === 'sourced');
}

/**
 * The words of the relation each claim states through a shown link, by claim id: the claim is
 * named as its link is (`relationLabel`), on a fact's card and in the claims list. Only a link
 * that states the claim names it: one whose relation the claim is about (the contract's
 * `LINK_CLAIM_ABOUT`); a claim a link merely cites (a trivia claim on an influence link) keeps
 * its own subject. A claim two links state in different words is named by its subject, hedged:
 * no one link confirms it ("Possible sample").
 */
export function relationLabelsByClaim(links: readonly ShownLink[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  const mixed = new Set<string>();
  for (const link of links) {
    const claim = link.claim;
    if (claim === null || !LINK_CLAIM_ABOUT[link.statedType ?? 'influence'].includes(claim.about)) {
      continue;
    }
    const label = relationLabel(link);
    if (mixed.has(claim.id)) continue;
    const before = labels.get(claim.id);
    if (before !== undefined && before !== label) {
      // The links disagree: the relation the claim's subject names, never as known.
      const subject = isRelationSubject(claim.about)
        ? claim.about
        : (link.statedType ?? 'influence');
      labels.set(claim.id, relationName(subject, false));
      mixed.add(claim.id);
    } else labels.set(claim.id, label);
  }
  return labels;
}

/** A link in one line: the relation as a sentence, then where it comes from. */
export function describeLink(link: ShownLink, nameOf: (id: string) => string): string {
  return `${relationSentence(link, nameOf)}. ${provenanceText(link)}.`;
}

/** How a track is related to the analysed one, as a connected-track card says it. */
export interface TrackRelation {
  /** The link that relates them directly; null when no link joins the two. */
  link: ShownLink | null;
  /** The relation in a few words (the card's badge). */
  text: string;
}

/**
 * How the track `nodeId` is related to the analysed track `currentId`: by the link that joins
 * them, the best known first (see `rank`). A genealogy without the analysed track (no group-1
 * node: `currentId` null) relates a track by its best link to any other track instead.
 */
export function relationToTrack(
  links: readonly ShownLink[],
  nodeId: string,
  currentId: string | null,
): TrackRelation {
  const joins = (link: ShownLink) =>
    currentId === null
      ? link.source === nodeId || link.target === nodeId
      : (link.source === nodeId && link.target === currentId) ||
        (link.source === currentId && link.target === nodeId);
  const link = links.filter(joins).sort((a, b) => rank(b) - rank(a))[0] ?? null;
  if (link !== null) return { link, text: relationLabel(link) };
  return {
    link: null,
    text: currentId === null ? 'No link to another track' : 'No direct link to this track',
  };
}

/**
 * True when the relation says the analysed track uses `nodeId`'s record: a sourced sample,
 * interpolation, cover or remix from it. Only such a track is marked as an origin.
 */
export function isDocumentedSource(relation: TrackRelation, nodeId: string): boolean {
  const link = relation.link;
  return (
    link !== null &&
    link.kind === 'sourced' &&
    link.directionKnown &&
    link.source === nodeId &&
    DOCUMENTED.has(link.type)
  );
}

/** Sourced documented relations first, then other sourced ones, then the strongest. */
export function rank(link: ShownLink): number {
  if (link.kind !== 'sourced') return link.value;
  return (DOCUMENTED.has(link.type) ? 20 : 10) + link.value;
}

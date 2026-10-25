import {
  Claim,
  Evidence,
  GenealogyLink,
  type LinkKind,
  type LinkType,
  linkDisplayKind as contractLinkDisplayKind,
} from '@liner-notes/contract';

/**
 * How the web app reads and names genealogy links. Each link is read with the contract's link
 * schema and shown by the contract's rule (`linkDisplayKind`: sourced only when it says so and
 * every evidence id it cites is in the result's evidence pack), with three stricter rules of
 * this app's own:
 * - a link the model proposed is sourced only when its claim (`claimId`) carries a supported or
 *   partial verdict: citing is not support;
 * - a link whose claim the verifier contradicted is not shown at all;
 * - a link whose direction contradicts the release years is "related (direction unknown)".
 *
 * Direction: `source` is the earlier record, the one that is sampled, interpolated, covered,
 * remixed or that influenced; `target` is the record that uses it. The contract does not state
 * this yet, so every relation is written out as a sentence naming both tracks with their years,
 * and a link whose years say otherwise is not given a direction.
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
 * shown as such: an inferred sample is an inferred influence (the contract's rule, which the
 * API applies to the links the model proposes).
 */
const DOCUMENTED = new Set<LinkType>(['sample', 'interpolation', 'cover', 'remix']);

export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  sample: 'Sample',
  interpolation: 'Interpolation',
  cover: 'Cover',
  remix: 'Remix',
  producer: 'Shared producer',
  influence: 'Influence',
};

const SOURCE_NAME: Record<string, string> = {
  spotify: 'Spotify',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  secondhandsongs: 'SecondHandSongs',
  listenbrainz: 'ListenBrainz',
  lastfm: 'Last.fm',
  genius: 'Genius',
  tavily: 'web search',
};

const TIER_LABEL: Record<Evidence['sourceTier'], string> = {
  'primary-record': 'primary record',
  editorial: 'editorial',
  web: 'web page',
};

/** What a primary record's `recordRef` scope says the item is about. */
const SCOPE_LABEL: Record<string, string> = {
  track: 'this recording',
  release: 'a release',
  work: 'the song',
};

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
   * The relation it is drawn and named as: the stated one, except that a sample,
   * interpolation, cover or remix that is not sourced is an influence, and a link that states
   * no relation is an influence.
   */
  type: LinkType;
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
  /** The claims the contract can read, by id. */
  claims: ReadonlyMap<string, Claim>;
}

/** A track of the genealogy, as a relation names it. */
export interface NamedNode {
  id: string;
  label: string;
  trackTitle?: string;
}

/** A result's evidence pack by id: the items the contract can read (others are left out). */
export function evidencePack(evidence: unknown): ReadonlyMap<string, Evidence> {
  const pack = new Map<string, Evidence>();
  if (!Array.isArray(evidence)) return pack;
  for (const item of evidence) {
    const parsed = Evidence.safeParse(item);
    if (parsed.success) pack.set(parsed.data.id, parsed.data);
  }
  return pack;
}

/** A result's claims by id: the ones the contract can read (others are left out). */
export function claimsById(claims: unknown): ReadonlyMap<string, Claim> {
  const byId = new Map<string, Claim>();
  if (!Array.isArray(claims)) return byId;
  for (const item of claims) {
    const parsed = Claim.safeParse(item);
    if (parsed.success) byId.set(parsed.data.id, parsed.data);
  }
  return byId;
}

/** The context of a genealogy as `normalizeTrack` returns it (with the result's pack and claims). */
export function linkContext(
  genealogy: { evidence?: unknown; claims?: unknown } | null | undefined,
): LinkContext {
  return {
    evidence: evidencePack(genealogy?.evidence),
    hasPack: Array.isArray(genealogy?.evidence),
    claims: claimsById(genealogy?.claims),
  };
}

/**
 * True when the verifier rejected the claim: its verdict, or the numeric check of its numbers
 * against the measurement, is "contradicted". Such a claim, and a link that states it, leave
 * the main view.
 */
export function claimIsRejected(claim: Claim): boolean {
  return claim.verdict === 'contradicted' || claim.numericCheck === 'contradicted';
}

/** The kind of a link by the contract's `linkDisplayKind`, against the pack's ids. */
export function linkDisplayKind(
  link: GenealogyLink,
  evidence: ReadonlyMap<string, Evidence>,
): LinkKind {
  return contractLinkDisplayKind(link, { evidenceIds: new Set(evidence.keys()), audio: null });
}

/** The release year at the end of a node's label ("Title - Artist (1984)"), or null. */
export function yearOf(node: NamedNode | undefined): number | null {
  const match = node ? /\((\d{4})\)\s*$/.exec(node.label) : null;
  return match ? Number(match[1]) : null;
}

/** How a relation names a track: its title and year, or its label (which carries both). */
export function nodeName(node: NamedNode | undefined, id: string): string {
  if (!node) return id;
  const year = yearOf(node);
  const title = node.trackTitle?.trim();
  return title ? `${title}${year === null ? '' : ` (${year})`}` : node.label;
}

const list = (items: readonly string[]) => items.join(', ');

/** An evidence id in words: the source, its tier and, for a record, what it is about. */
function citationText(citation: Citation): string {
  const item = citation.evidence;
  if (!item) return citation.id;
  const scope = item.recordRef ? SCOPE_LABEL[item.recordRef.split('/')[0]] : undefined;
  const parts = [
    `${SOURCE_NAME[item.source] ?? item.source} ${TIER_LABEL[item.sourceTier]}`,
    ...(scope ? [scope] : []),
  ];
  return `${citation.id} (${parts.join(', ')})`;
}

type Read = { link: ShownLink } | { rejected: true } | null;

/**
 * A link as the app shows it; `{ rejected: true }` when the verifier contradicted its claim
 * (it is not shown); null when the contract's link schema cannot read it.
 */
export function readLink(
  value: unknown,
  context: LinkContext,
  nodes: ReadonlyMap<string, NamedNode> = new Map(),
): Read {
  const parsed = GenealogyLink.safeParse(value);
  if (!parsed.success) return null;
  const link = parsed.data;
  const claim = link.claimId ? (context.claims.get(link.claimId) ?? null) : null;
  if (claim && claimIsRejected(claim)) return { rejected: true };

  const statedType = link.type ?? null;
  const origin = link.origin ?? null;
  const citations = (link.evidenceIds ?? []).map((id) => ({
    id,
    evidence: context.evidence.get(id) ?? null,
  }));
  const reasons: string[] = [];

  // Direction: the record a link starts from must not be newer than the one it points at.
  const [fromYear, toYear] = [yearOf(nodes.get(link.source)), yearOf(nodes.get(link.target))];
  const directionKnown =
    statedType === 'producer' || fromYear === null || toYear === null || fromYear <= toYear;
  if (!directionKnown) {
    reasons.push(`its direction contradicts the release years (${fromYear} before ${toYear})`);
  }

  let kind = linkDisplayKind(link, context.evidence);
  if (kind === 'sourced' && origin === 'model') {
    const supported = claim?.verdict === 'supported' || claim?.verdict === 'partial';
    if (!supported) {
      kind = 'inferred';
      if (!claim?.verdict) reasons.push('proposed by the model; no verifier verdict supports it');
    }
  }
  if (!directionKnown) kind = 'inferred';
  if (kind === 'inferred' && claim?.verdict) {
    reasons.push(`the verifier found its claim ${claim.verdict}`);
  }

  if (kind === 'inferred') {
    if (statedType !== null && DOCUMENTED.has(statedType)) {
      reasons.unshift(
        `stated as ${article(LINK_TYPE_LABEL[statedType])}${directionKnown ? ', shown as an influence' : ''}`,
      );
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
      reasons.push(
        `cites ${list(known.map(citationText))}${claim?.verdict ? '' : ', not checked by a verifier'}`,
      );
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
      directionKnown,
      citations,
      claim,
      reasons,
    },
  };
}

/** What a genealogy shows: its links, and how many were left out as rejected. */
export interface GenealogyReading {
  links: ShownLink[];
  /** Links not shown because the verifier contradicted their claim. */
  rejected: number;
}

/** The genealogy's nodes, by id (entries that are not nodes are left out). */
export function nodesById(nodes: unknown): ReadonlyMap<string, NamedNode> {
  const byId = new Map<string, NamedNode>();
  if (!Array.isArray(nodes)) return byId;
  for (const node of nodes) {
    if (node && typeof node === 'object' && typeof (node as NamedNode).id === 'string') {
      const { id, label, trackTitle } = node as NamedNode;
      byId.set(id, {
        id,
        label: typeof label === 'string' ? label : id,
        ...(typeof trackTitle === 'string' ? { trackTitle } : {}),
      });
    }
  }
  return byId;
}

/**
 * The links of a genealogy that can be shown: those the contract's schema reads whose source
 * and target are both in the node list, in their order, read against the result's pack and
 * claims (`evidence` and `claims`, which `normalizeTrack` copies from the result; without them
 * every link is a model inference). Links whose claim the verifier contradicted are counted,
 * not shown.
 */
export function readGenealogy(
  genealogy:
    | { nodes?: unknown; links?: unknown; evidence?: unknown; claims?: unknown }
    | null
    | undefined,
): GenealogyReading {
  const nodes = nodesById(genealogy?.nodes);
  const context = linkContext(genealogy);
  const links: ShownLink[] = [];
  let rejected = 0;
  for (const value of Array.isArray(genealogy?.links) ? genealogy.links : []) {
    const read = readLink(value, context, nodes);
    if (read === null) continue;
    if ('rejected' in read) {
      rejected += 1;
      continue;
    }
    if (nodes.has(read.link.source) && nodes.has(read.link.target)) links.push(read.link);
  }
  return { links, rejected };
}

/** The links of a genealogy that can be shown (see `readGenealogy`). */
export function shownLinks(genealogy: Parameters<typeof readGenealogy>[0]): ShownLink[] {
  return readGenealogy(genealogy).links;
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

/** Where a link comes from, in words: its kind, the evidence it cites, and why it is not sourced. */
export function provenanceText(link: ShownLink): string {
  if (link.kind === 'sourced') {
    return `Sourced · cites ${list(link.citations.map(citationText))}`;
  }
  return `${kindLabel(link)} · ${link.reasons.join('; ')}`;
}

/** The relation as a sentence naming both tracks, e.g. "Bright Lines (2011) samples X (1984)". */
export function relationSentence(link: ShownLink, nameOf: (id: string) => string): string {
  const from = nameOf(link.source);
  const to = nameOf(link.target);
  if (!link.directionKnown) return `${from} and ${to} are related (direction unknown)`;
  if (link.kind !== 'sourced') {
    return link.type === 'producer'
      ? `${from} and ${to} may share a producer`
      : `Possible influence between ${from} and ${to}`;
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

/** A short name for the relation, hedged when it is not sourced (a badge or a line's label). */
export function relationLabel(link: ShownLink): string {
  if (!link.directionKnown) return 'Related, direction unknown';
  if (link.kind === 'sourced') return LINK_TYPE_LABEL[link.type];
  return link.type === 'producer' ? 'Possible shared producer' : 'Possible influence';
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
 * them, the best known first (see `rank`).
 */
export function relationToTrack(
  links: readonly ShownLink[],
  nodeId: string,
  currentId: string | null,
): TrackRelation {
  const direct = links
    .filter(
      (link) =>
        currentId !== null &&
        ((link.source === nodeId && link.target === currentId) ||
          (link.source === currentId && link.target === nodeId)),
    )
    .sort((a, b) => rank(b) - rank(a));
  const link = direct[0] ?? null;
  return link === null
    ? { link: null, text: 'No direct link to this track' }
    : { link, text: relationLabel(link) };
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

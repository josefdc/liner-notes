import {
  Evidence,
  GenealogyLink,
  type LinkKind,
  type LinkType,
  linkDisplayKind as contractLinkDisplayKind,
} from '@liner-notes/contract';

/**
 * How the web app reads and names genealogy links. Each link is read with the contract's link
 * schema and shown by the contract's rule (`linkDisplayKind`): sourced only when it says so and
 * every evidence id it cites is in the result's evidence pack, a model inference otherwise.
 *
 * A link points from the older track to the newer one: `source` is the record that is sampled,
 * interpolated, covered, remixed or that influenced; `target` is the track that uses it.
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

export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  sourced: 'Sourced',
  inferred: 'Model inference',
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
  /** How the link is known, by the contract's rule. */
  kind: LinkKind;
  /** The kind the link states (null when it states none: older results). */
  statedKind: LinkKind | null;
  /** The relation the link states (null when it states none: older results). */
  statedType: LinkType | null;
  /**
   * The relation it is drawn and named as: the stated one, except that a sample,
   * interpolation, cover or remix that is not sourced is an influence, and a link that states
   * no relation is an influence.
   */
  type: LinkType;
  /** The evidence ids the link cites, in its order. */
  citations: Citation[];
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

/** The kind a link is shown with: the contract's `linkDisplayKind` against the pack's ids. */
export function linkDisplayKind(
  link: GenealogyLink,
  pack: ReadonlyMap<string, Evidence>,
): LinkKind {
  return contractLinkDisplayKind(link, { evidenceIds: new Set(pack.keys()), audio: null });
}

/** A link as the app shows it, or null when the contract's link schema cannot read it. */
export function readLink(value: unknown, pack: ReadonlyMap<string, Evidence>): ShownLink | null {
  const parsed = GenealogyLink.safeParse(value);
  if (!parsed.success) return null;
  const link = parsed.data;
  const kind = linkDisplayKind(link, pack);
  const statedType = link.type ?? null;
  const type =
    statedType === null || (kind !== 'sourced' && DOCUMENTED.has(statedType))
      ? 'influence'
      : statedType;
  return {
    source: link.source,
    target: link.target,
    value: link.value,
    kind,
    statedKind: link.kind ?? null,
    statedType,
    type,
    citations: (link.evidenceIds ?? []).map((id) => ({ id, evidence: pack.get(id) ?? null })),
  };
}

/**
 * The links of a genealogy that can be shown: those the contract's schema reads whose source
 * and target are both in the node list, in their order, each shown against the genealogy's
 * evidence pack (`evidence`, which `normalizeTrack` copies from the result; without it every
 * link is a model inference).
 */
export function shownLinks(
  genealogy: { nodes?: unknown; links?: unknown; evidence?: unknown } | null | undefined,
): ShownLink[] {
  const nodes = Array.isArray(genealogy?.nodes) ? genealogy.nodes : [];
  const ids = new Set(
    nodes.flatMap((node) =>
      node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string'
        ? [(node as { id: string }).id]
        : [],
    ),
  );
  const links = Array.isArray(genealogy?.links) ? genealogy.links : [];
  const pack = evidencePack(genealogy?.evidence);
  return links.flatMap((value) => {
    const link = readLink(value, pack);
    return link && ids.has(link.source) && ids.has(link.target) ? [link] : [];
  });
}

const citationText = (citation: Citation) =>
  citation.evidence ? `${citation.id} (${citation.evidence.source})` : citation.id;

const list = (items: readonly string[]) => items.join(', ');

/**
 * Where a link comes from, in words: its kind, the evidence it cites, and why a link is not
 * shown as sourced when it is not.
 */
export function provenanceText(link: ShownLink): string {
  if (link.kind === 'sourced') {
    return `Sourced · cites ${list(link.citations.map(citationText))}`;
  }
  const notes: string[] = [];
  if (link.statedType !== null && link.statedType !== link.type) {
    notes.push(`stated as ${article(LINK_TYPE_LABEL[link.statedType])}, shown as an influence`);
  }
  const known = link.citations.filter((citation) => citation.evidence !== null);
  const unknown = link.citations.filter((citation) => citation.evidence === null);
  if (unknown.length > 0) {
    notes.push(`cites ${list(unknown.map((c) => c.id))}, not in the evidence pack`);
  }
  if (known.length > 0) {
    notes.push(`cites ${list(known.map(citationText))}, not checked by a verifier`);
  }
  if (link.citations.length === 0) {
    notes.push(
      link.statedKind === 'sourced' ? 'says sourced but cites no evidence' : 'no evidence cited',
    );
  }
  return `${LINK_KIND_LABEL.inferred} · ${notes.join('; ')}`;
}

function article(label: string): string {
  return `${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label.toLowerCase()}`;
}

/** A link in one line: "<source> → <target>: <relation>. <provenance>". */
export function describeLink(link: ShownLink, labelOf: (id: string) => string): string {
  return `${labelOf(link.source)} → ${labelOf(link.target)}: ${LINK_TYPE_LABEL[link.type]}. ${provenanceText(link)}.`;
}

/** What a sourced relation makes of a track, seen from the analysed track. */
const SOURCED_RELATION: Record<LinkType, { older: string; newer: string }> = {
  sample: { older: 'Sampled in this track', newer: 'Samples this track' },
  interpolation: { older: 'Interpolated in this track', newer: 'Interpolates this track' },
  cover: { older: 'Covered by this track', newer: 'Covers this track' },
  remix: { older: 'Remixed in this track', newer: 'Remixes this track' },
  producer: { older: 'Shares a producer', newer: 'Shares a producer' },
  influence: { older: 'Influenced this track', newer: 'Influenced by this track' },
};

/** How a track is related to the analysed one, as a connected-track card says it. */
export interface TrackRelation {
  /** The link that relates them directly; null when no link joins the two. */
  link: ShownLink | null;
  /** The relation in words. */
  text: string;
}

/**
 * How the track `nodeId` is related to the analysed track `currentId`: by the link that joins
 * them, the best known first (sourced before inferred, then the strongest). A documented
 * relation (sampled in, covers, …) is named only for a sourced link; an inferred one says so.
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
  if (link === null) return { link: null, text: 'No direct link to this track' };
  if (link.kind === 'inferred') {
    return {
      link,
      text: link.type === 'producer' ? 'Possible shared producer' : 'Possible influence',
    };
  }
  const relation = SOURCED_RELATION[link.type];
  return { link, text: link.source === nodeId ? relation.older : relation.newer };
}

/**
 * True when the relation says the analysed track uses `nodeId`'s record: a sourced sample,
 * interpolation, cover or remix from it. Only such a track is marked as an origin.
 */
export function isDocumentedSource(relation: TrackRelation, nodeId: string): boolean {
  const link = relation.link;
  return (
    link !== null && link.kind === 'sourced' && link.source === nodeId && DOCUMENTED.has(link.type)
  );
}

/** Sourced links first, then the strongest. */
export function rank(link: ShownLink): number {
  return (link.kind === 'sourced' ? 10 : 0) + link.value;
}

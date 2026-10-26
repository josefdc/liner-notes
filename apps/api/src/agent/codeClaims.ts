/**
 * Code-built claims and genealogy links: written by code from the relations the primary records
 * state (research/relations.ts), with no model involved, so a result is evidence-backed even
 * when the model is unavailable (the fallback carries them too).
 *
 * A code claim (`origin: "code"`, `kind: "sourced"`) states only what its record says:
 * - its text is the evidence item's excerpt without its source prefix ("MusicBrainz: "); a
 *   Discogs excerpt names its release by its Discogs number and has no prefix, so it is kept
 *   whole;
 * - it cites exactly that item, and its scope is the item's recordRef scope (a `track/` record
 *   gives a claim about this recording, `work/` one about the song, `release/` one about a
 *   whole release): a track-scoped Discogs credit gives a recording claim, a release-wide credit
 *   a release claim, and the release MusicBrainz names for the recording a release claim;
 * - it is about the relation (`LINK_CLAIM_ABOUT`'s first entry for a link's type), a credit,
 *   or, for the release, the track;
 * - it has no verdict: the verifier does not judge it (it is sourced by construction), but still
 *   checks its citation against the pack and its scope.
 *
 * A code link (`origin: "code"`, `kind: "sourced"`) is built for each relation with a genealogy
 * meaning (a sample, interpolation, remix or cover), between the analysed track and a node made
 * from the record (the other recording's title and artist, or the work's title). It points from
 * the earlier record to the later one (`GenealogyLink`): a recording this one samples, remixes or
 * covers is the source; one that samples, remixes or covers it, or another recording of its
 * song, is the target. Each link states its own claim (`claimId`), never another link's.
 *
 * Curation. Per link type at most CODE_LINKS_PER_TYPE links: relations about this recording
 * (`track/` records) before those about its song (`work/` records), then in the order
 * MusicBrainz lists them, one per other record. Records carry no release date, so no date
 * order is attempted. Credits are kept once per credited name and roles (a credit on the track
 * before the same one on the whole release). Every other record stays in the evidence pack only.
 */

import {
  type Claim,
  type ClaimScope,
  type Evidence,
  LINK_CLAIM_ABOUT,
} from "@liner-notes/contract";
import type { ClaimAbout, LinkType } from "@liner-notes/contract";
import { normalizeArtist, titlesMatch } from "../sources/records.js";
import type { PrimaryRelation, RecordingRelation } from "./research/relations.js";
import type { Genealogy, GenealogyLink, GenealogyNode } from "./schema.js";
import type { ComposedDraft } from "./state.js";
import { LINK_VALUE } from "./verifier/links.js";

/** The most code links of one type a result draws; the rest stay in the evidence pack. */
export const CODE_LINKS_PER_TYPE = 6;

/** How a node made from a record is drawn: a related record, until the verifier groups it. */
const CODE_NODE_GROUP = 4;
const CODE_NODE_SIZE = 22;

/** The link type of each relationship kind, and whether the other record is the earlier one. */
const LINK_OF: Record<RecordingRelation["kind"], { type: LinkType; otherEarlier: boolean }> = {
  samples: { type: "sample", otherEarlier: true },
  "sampled-by": { type: "sample", otherEarlier: false },
  interpolates: { type: "interpolation", otherEarlier: true },
  "interpolated-by": { type: "interpolation", otherEarlier: false },
  "remix-of": { type: "remix", otherEarlier: true },
  "remixed-by": { type: "remix", otherEarlier: false },
  "cover-of": { type: "cover", otherEarlier: true },
  "covered-by": { type: "cover", otherEarlier: false },
};

/** The claim scope of a record's recordRef scope. */
const CLAIM_SCOPE: Record<PrimaryRelation["scope"], ClaimScope> = {
  track: "recording",
  work: "work",
  release: "release",
};

/** The source prefix a primary record's excerpt starts with, when it has one. */
const SOURCE_PREFIX = /^(?:MusicBrainz|SecondHandSongs|Genius):\s+/;

/** A claim's text from the item that states it: its excerpt, without the source prefix. */
export function codeClaimText(item: Pick<Evidence, "excerpt">): string {
  const text = item.excerpt.replace(SOURCE_PREFIX, "").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The id of the node made from a MusicBrainz record. */
const nodeId = (relation: RecordingRelation) => `mb-${relation.other.mbid}`;

export interface CodeBuilt {
  claims: Claim[];
  /** The nodes made from the records, the analysed track's not included. */
  nodes: GenealogyNode[];
  links: GenealogyLink[];
}

/** The relations that get a link, curated (see the module comment). */
export function curatedRelations(relations: readonly PrimaryRelation[]): RecordingRelation[] {
  const recordings = relations.filter((r): r is RecordingRelation => r.type === "relation");
  const ordered = [
    ...recordings.filter((r) => r.scope === "track"),
    ...recordings.filter((r) => r.scope !== "track"),
  ];
  const seen = new Set<string>();
  const perType = new Map<LinkType, number>();
  const kept: RecordingRelation[] = [];
  for (const relation of ordered) {
    const { type } = LINK_OF[relation.kind];
    const key = `${type} ${relation.other.mbid}`;
    const count = perType.get(type) ?? 0;
    if (seen.has(key) || count >= CODE_LINKS_PER_TYPE) continue;
    seen.add(key);
    perType.set(type, count + 1);
    kept.push(relation);
  }
  return kept;
}

/** The credits kept: once per credited name and roles, a credit on the track first. */
export function curatedCredits(relations: readonly PrimaryRelation[]) {
  const credits = relations.filter((r) => r.type === "credit");
  const ordered = [
    ...credits.filter((c) => c.scope === "track"),
    ...credits.filter((c) => c.scope !== "track"),
  ];
  const seen = new Set<string>();
  return ordered.filter((credit) => {
    const roles = credit.roles.map((role) => role.trim().toLowerCase()).sort();
    const key = `${normalizeArtist(credit.name)}|${roles.join("|")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The code-built claims, nodes and links of a run, from its relations and its evidence pack. A
 * relation whose item is not in `evidence` gives nothing. Pure, apart from `newId`.
 */
export function buildCodeClaims(
  relations: readonly PrimaryRelation[],
  evidence: readonly Evidence[],
  newId: () => string,
): CodeBuilt {
  const items = new Map(evidence.map((item) => [item.id, item]));
  const claims: Claim[] = [];
  const claimFor = (relation: PrimaryRelation, about: ClaimAbout): Claim | null => {
    const item = items.get(relation.evidenceId);
    if (!item) return null;
    const claim: Claim = {
      id: newId(),
      text: codeClaimText(item),
      about,
      kind: "sourced",
      origin: "code",
      evidenceIds: [item.id],
      verdict: null,
      verdictReason: null,
      numericCheck: "n/a",
      scope: CLAIM_SCOPE[relation.scope],
    };
    claims.push(claim);
    return claim;
  };

  const nodes = new Map<string, GenealogyNode>();
  const links: GenealogyLink[] = [];
  for (const relation of curatedRelations(relations)) {
    const { type, otherEarlier } = LINK_OF[relation.kind];
    const claim = claimFor(relation, LINK_CLAIM_ABOUT[type][0]);
    if (!claim) continue;
    const id = nodeId(relation);
    if (!nodes.has(id)) {
      const { title, artist } = relation.other;
      nodes.set(id, {
        id,
        group: CODE_NODE_GROUP,
        label: artist ? `${title} - ${artist}` : title,
        size: CODE_NODE_SIZE,
        // A work has no artist: it is not searched for as a track.
        ...(artist ? { trackTitle: title, trackArtist: artist } : {}),
      });
    }
    links.push({
      source: otherEarlier ? id : "current",
      target: otherEarlier ? "current" : id,
      value: LINK_VALUE[type],
      type,
      kind: "sourced",
      origin: "code",
      claimId: claim.id,
      evidenceIds: [...claim.evidenceIds],
    });
  }
  for (const credit of curatedCredits(relations)) claimFor(credit, "credit");
  for (const release of relations.filter((r) => r.type === "release")) {
    claimFor(release, "track");
  }
  return { claims, nodes: [...nodes.values()], links };
}

// =============================================================================
// With the model's genealogy
// =============================================================================

const SEPARATOR = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;

/** A credit's artists one by one, for comparison. */
const artistParts = (credit: string) =>
  credit
    .split(SEPARATOR)
    .map((part) => normalizeArtist(part))
    .filter(Boolean);

/** The title and artist a model node names: its own fields, else its label "Title - Artist". */
function namedRecord(node: GenealogyNode): { title: string; artist: string } {
  const [labelTitle = "", ...rest] = node.label.split(" - ");
  const labelArtist = rest.join(" - ").replace(/\s*\(\d{4}\)\s*$/, "");
  return {
    title: node.trackTitle?.trim() || labelTitle.trim(),
    artist: node.trackArtist?.trim() || labelArtist.trim(),
  };
}

/**
 * True when a model node names the record a code node was made from: the same title (without
 * featured-artist and remaster suffixes) and at least one credited artist in common.
 */
export function sameRecord(model: GenealogyNode, code: GenealogyNode): boolean {
  if (!code.trackTitle || !code.trackArtist) return false;
  const named = namedRecord(model);
  if (!named.title || !named.artist || !titlesMatch(named.title, code.trackTitle)) return false;
  const theirs = new Set(artistParts(code.trackArtist));
  return artistParts(named.artist).some((artist) => theirs.has(artist));
}

const pairKey = (link: Pick<GenealogyLink, "source" | "target" | "type">) =>
  `${link.type ?? "influence"} ${[link.source, link.target].sort().join(" ")}`;

/**
 * The draft with the code-built claims and links added. A model node that names a code node's
 * record becomes that node (the record's names are kept), and a model link that then duplicates
 * a code link (the same two nodes and the same type, either way round) folds into it: the code
 * link and its claim stay, the model link and its relation claim go. A model node whose id a
 * code node uses is renamed. Pure.
 */
export function withCodeClaims<T extends Pick<ComposedDraft, "claims" | "genealogy" | "nodeYears">>(
  draft: T,
  code: CodeBuilt,
): T {
  if (code.claims.length === 0) return draft;
  const codeIds = new Set(code.nodes.map((node) => node.id));
  const taken = new Set(["current", ...codeIds]);
  const idOf = new Map<string, string>([["current", "current"]]);
  const modelNodes: GenealogyNode[] = [];
  let current: GenealogyNode | undefined;
  for (const node of draft.genealogy.nodes) {
    if (node.id === "current") {
      current = node;
      continue;
    }
    const same = code.nodes.find((codeNode) => sameRecord(node, codeNode));
    if (same) {
      idOf.set(node.id, same.id);
      continue;
    }
    let id = node.id;
    while (taken.has(id)) id = `${id}-related`;
    taken.add(id);
    idOf.set(node.id, id);
    modelNodes.push(id === node.id ? node : { ...node, id });
  }

  const codePairs = new Set(code.links.map(pairKey));
  const folded = new Set<string>();
  const modelLinks: GenealogyLink[] = [];
  for (const link of draft.genealogy.links) {
    const source = idOf.get(link.source) ?? link.source;
    const target = idOf.get(link.target) ?? link.target;
    const moved = { ...link, source, target };
    if (source === target || codePairs.has(pairKey(moved))) {
      if (link.claimId) folded.add(link.claimId);
      continue;
    }
    modelLinks.push(moved);
  }

  const nodeYears: Record<string, string> = {};
  for (const [id, year] of Object.entries(draft.nodeYears)) {
    const moved = idOf.get(id);
    // The model's year is kept for its own nodes only, never put on a node made from a record.
    if (moved && !codeIds.has(moved)) nodeYears[moved] = year;
  }
  const genealogy: Genealogy = {
    nodes: [...(current ? [current] : []), ...modelNodes, ...code.nodes],
    links: [...modelLinks, ...code.links],
  };
  return {
    ...draft,
    claims: [...draft.claims.filter((claim) => !folded.has(claim.id)), ...code.claims],
    genealogy,
    nodeYears,
  };
}

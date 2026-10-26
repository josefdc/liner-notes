/**
 * Code-built claims and genealogy links: written by code from the relations the primary records
 * state (research/relations.ts), with no model involved, so a result is evidence-backed even
 * when the model is unavailable (the fallback carries them too).
 *
 * A code claim (`origin: "code"`, `kind: "sourced"`) states only what its record says:
 * - its text is the evidence item's excerpt without its source prefix ("MusicBrainz: "); a
 *   Discogs excerpt names its release by its Discogs number and has no prefix, so it is kept
 *   whole, with the credited name without Discogs' disambiguation number ("Nirvana (2)" reads
 *   "Nirvana"). A partial or medley cover says so: "partly covers", "covers part of … in a
 *   medley", never "is covered by";
 * - it cites exactly that item, and its scope is the item's recordRef scope (a `track/` record
 *   gives a claim about this recording, `work/` one about the song, `release/` one about a
 *   whole release): a track-scoped Discogs credit gives a recording claim, a release-wide credit
 *   a release claim, and the release MusicBrainz names for the recording a release claim;
 * - it is about the relation (`LINK_CLAIM_ABOUT`'s first entry for a link's type), a credit,
 *   or, for the release, the track;
 * - it has no verdict: the verifier does not judge it (it is sourced by construction), but still
 *   checks its citation against the pack and its scope.
 *
 * A code link (`origin: "code"`, `kind: "sourced"`) is built for a relation of this recording
 * (a `track/` record) with a genealogy meaning (a sample, interpolation, remix or whole cover),
 * between the analysed track and a node made from the record (the other recording's title and
 * artist, or the work's title). It points from the earlier record to the later one
 * (`GenealogyLink`): a recording this one samples, remixes or covers is the source; one that
 * samples, remixes or covers it is the target. Each link states its own claim (`claimId`),
 * never another link's. No link is drawn for:
 * - a cover of the song (a `work/` record: this recording is not shown to be its original, so
 *   nothing says it is the one covered, or the earlier one): its claim, about the work, only;
 * - a partial or medley cover: it takes part of the other record, not the whole of it.
 *
 * Curation. Per relationship kind (samples, sampled-by, remix-of, remixed-by, cover-of,
 * covered-by and the interpolations) at most CODE_RELATIONS_PER_KIND, each kind on its own, so
 * what the track draws on is never pushed out by what draws on it: relations about this
 * recording before those about its song, whole ones before partial or medley ones, then in the
 * order MusicBrainz lists them, one per other record; only relations whose item is in the
 * evidence count. Records carry no release date, so no date order is attempted. Credits: one per
 * credited artist (by Discogs id, else by name) and roles, a credit on the track before the same
 * one on the whole release, at most CODE_CREDITS_MAX, the track's before the whole release's.
 * Every other record stays in the evidence pack only.
 */

import {
  type Claim,
  type ClaimAbout,
  type ClaimScope,
  type Evidence,
  LINK_CLAIM_ABOUT,
  type LinkType,
} from "@liner-notes/contract";
import { normalizeArtist, normalizeTitle, titlesMatch } from "../sources/records.js";
import type { CreditRelation, PrimaryRelation, RecordingRelation } from "./research/relations.js";
import type { Genealogy, GenealogyLink, GenealogyNode } from "./schema.js";
import type { ComposedDraft } from "./state.js";
import { LINK_VALUE } from "./verifier/links.js";

/** The most relations of one kind a result states; the rest stay in the evidence pack. */
export const CODE_RELATIONS_PER_KIND = 6;
/** The most credits a result states; the rest stay in the evidence pack. */
export const CODE_CREDITS_MAX = 12;

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

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A claim's text from the item that states it: its excerpt, without the source prefix. */
export function codeClaimText(item: Pick<Evidence, "excerpt">): string {
  return capitalized(item.excerpt.replace(SOURCE_PREFIX, "").trim());
}

/** Whether a relationship takes only part of the other record: "partial" or "medley". */
const partOnly = (relation: RecordingRelation) =>
  relation.attributes.includes("partial") || relation.attributes.includes("medley");

/**
 * The text of a partial or medley cover's claim, from its item's excerpt ("A is covered by B",
 * "A is a cover of B"): "B partly covers A", or "B covers part of A in a medley". Null when the
 * excerpt is not one of those sentences: the claim is then not made.
 */
function partialCoverText(relation: RecordingRelation, item: Evidence): string | null {
  const text = item.excerpt.replace(SOURCE_PREFIX, "").trim();
  const phrase = relation.kind === "covered-by" ? " is covered by " : " is a cover of ";
  const at = text.indexOf(phrase);
  if (at < 0 || !text.endsWith(".")) return null;
  const [subject, object] = [text.slice(0, at), text.slice(at + phrase.length, -1)];
  // "A is covered by B": B covers A. "A is a cover of B": A covers B.
  const [coverer, covered] = relation.kind === "covered-by" ? [object, subject] : [subject, object];
  return capitalized(
    relation.attributes.includes("medley")
      ? `${coverer} covers part of ${covered} in a medley.`
      : `${coverer} partly covers ${covered}.`,
  );
}

/** A Discogs name without its disambiguation number or variation mark: "Nirvana (2)*". */
const creditedName = (name: string) =>
  name
    .trim()
    .replace(/\*+$/, "")
    .replace(/\s+\(\d+\)$/, "")
    .trim();

/** A credit claim's text: the excerpt, naming the artist without Discogs' disambiguation. */
function creditText(credit: CreditRelation, item: Evidence): string {
  const as = ` as ${credit.roles.join(", ")} on `;
  return codeClaimText({
    excerpt: item.excerpt.replace(
      ` credits ${credit.name}${as}`,
      ` credits ${creditedName(credit.name)}${as}`,
    ),
  });
}

/** The id of the node made from a MusicBrainz record. */
const nodeId = (relation: RecordingRelation) => `mb-${relation.other.mbid}`;

export interface CodeBuilt {
  claims: Claim[];
  /** The nodes made from the records, the analysed track's not included. */
  nodes: GenealogyNode[];
  links: GenealogyLink[];
}

/** The relationships that get a claim, curated (see the module comment). */
export function curatedRelations(relations: readonly PrimaryRelation[]): RecordingRelation[] {
  const recordings = relations.filter((r): r is RecordingRelation => r.type === "relation");
  const rank = (r: RecordingRelation) => (r.scope === "track" ? 0 : 2) + (partOnly(r) ? 1 : 0);
  const ordered = recordings
    .map((relation, index) => ({ relation, index }))
    .sort((a, b) => rank(a.relation) - rank(b.relation) || a.index - b.index)
    .map(({ relation }) => relation);
  const seen = new Set<string>();
  const perKind = new Map<RecordingRelation["kind"], number>();
  const kept: RecordingRelation[] = [];
  for (const relation of ordered) {
    const key = `${relation.kind} ${relation.other.mbid}`;
    const count = perKind.get(relation.kind) ?? 0;
    if (seen.has(key) || count >= CODE_RELATIONS_PER_KIND) continue;
    seen.add(key);
    perKind.set(relation.kind, count + 1);
    kept.push(relation);
  }
  return kept;
}

/** The credits kept (see the module comment). */
export function curatedCredits(relations: readonly PrimaryRelation[]): CreditRelation[] {
  const credits = relations.filter((r): r is CreditRelation => r.type === "credit");
  const ordered = [
    ...credits.filter((c) => c.scope === "track"),
    ...credits.filter((c) => c.scope !== "track"),
  ];
  const seen = new Set<string>();
  return ordered
    .filter((credit) => {
      const roles = credit.roles.map((role) => role.trim().toLowerCase()).sort();
      const who = credit.artistId !== null ? `id ${credit.artistId}` : normalizeArtist(credit.name);
      const key = `${who}|${roles.join("|")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, CODE_CREDITS_MAX);
}

/**
 * The code-built claims, nodes and links of a run, from its relations and its evidence pack. A
 * relation whose item is not in `evidence` gives nothing, and takes no place in the curation.
 * Pure, apart from `newId`.
 */
export function buildCodeClaims(
  relations: readonly PrimaryRelation[],
  evidence: readonly Evidence[],
  newId: () => string,
): CodeBuilt {
  const items = new Map(evidence.map((item) => [item.id, item]));
  const present = relations.filter((relation) => items.has(relation.evidenceId));
  const claims: Claim[] = [];
  const claimFor = (relation: PrimaryRelation, about: ClaimAbout, text: string): Claim => {
    const claim: Claim = {
      id: newId(),
      text,
      about,
      kind: "sourced",
      origin: "code",
      evidenceIds: [relation.evidenceId],
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
  for (const relation of curatedRelations(present)) {
    const item = items.get(relation.evidenceId);
    if (!item) continue;
    const { type, otherEarlier } = LINK_OF[relation.kind];
    const text = partOnly(relation) ? partialCoverText(relation, item) : codeClaimText(item);
    if (text === null) continue;
    const claim = claimFor(relation, LINK_CLAIM_ABOUT[type][0], text);
    // A link only for a whole relation of this recording (see the module comment).
    if (relation.scope !== "track" || partOnly(relation)) continue;
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
  for (const credit of curatedCredits(present)) {
    const item = items.get(credit.evidenceId);
    if (item) claimFor(credit, "credit", creditText(credit, item));
  }
  for (const release of present.filter((r) => r.type === "release")) {
    const item = items.get(release.evidenceId);
    if (item) claimFor(release, "track", codeClaimText(item));
  }
  return { claims, nodes: [...nodes.values()], links };
}

// =============================================================================
// With the model's genealogy
// =============================================================================

const SEPARATOR = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/|\bx\b|\bwith\b)\s*/i;

/** A credit's artists, normalised, as a sorted list: equal lists are the same credit. */
const creditOf = (credit: string) =>
  credit
    .split(SEPARATOR)
    .map((part) => normalizeArtist(part))
    .filter(Boolean)
    .sort()
    .join("|");

/** Titles too common to tell one record from another. */
const GENERIC_TITLES = new Set(
  [
    "Intro",
    "Outro",
    "Interlude",
    "Skit",
    "Remix",
    "Megamix",
    "Mix",
    "Medley",
    "Untitled",
    "Instrumental",
    "Prelude",
    "Hidden Track",
  ].map((title) => normalizeTitle(title)),
);

/** Credits that name no artist: a compilation's. */
const GENERIC_ARTISTS = new Set(["various artists", "various", "unknown artist", "anonymous"]);

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
 * featured-artist and remaster suffixes) and the same artist credit, every credited artist and
 * no other (in any order, case and punctuation aside). Never for a generic title ("Intro",
 * "Remix") or a credit that names no artist ("Various Artists").
 */
export function sameRecord(model: GenealogyNode, code: GenealogyNode): boolean {
  if (!code.trackTitle || !code.trackArtist) return false;
  const named = namedRecord(model);
  if (!named.title || !named.artist || !titlesMatch(named.title, code.trackTitle)) return false;
  if (GENERIC_TITLES.has(normalizeTitle(code.trackTitle))) return false;
  if (GENERIC_ARTISTS.has(normalizeArtist(code.trackArtist))) return false;
  const whole = normalizeArtist(named.artist) === normalizeArtist(code.trackArtist);
  return whole || creditOf(named.artist) === creditOf(code.trackArtist);
}

const linkKey = (link: Pick<GenealogyLink, "source" | "target" | "type">) =>
  `${link.type ?? "influence"} ${link.source} ${link.target}`;

/**
 * The draft with the code-built claims and links added.
 * - A model node that names a code node's record becomes that node (the record's names are
 *   kept); a code node takes at most one model node, so no model link between two of its nodes
 *   is lost. A model node whose id a code node uses is renamed.
 * - A model link that then duplicates a code link (the same two nodes, the same type and the
 *   same direction) folds into it: the code link and its claim stay, the model link and its
 *   relation claim go. A link stated the other way round stays, for the verifier to judge.
 * - A model claim about a credit (not a card's) that cites only Discogs items the code credit
 *   claims cite folds into them: it goes.
 * Pure.
 */
export function withCodeClaims<T extends Pick<ComposedDraft, "claims" | "genealogy" | "nodeYears">>(
  draft: T,
  code: CodeBuilt,
): T {
  if (code.claims.length === 0) return draft;
  const codeIds = new Set(code.nodes.map((node) => node.id));
  const taken = new Set(["current", ...codeIds]);
  const absorbed = new Set<string>();
  const idOf = new Map<string, string>([["current", "current"]]);
  const modelNodes: GenealogyNode[] = [];
  let current: GenealogyNode | undefined;
  for (const node of draft.genealogy.nodes) {
    if (node.id === "current") {
      current = node;
      continue;
    }
    const same = code.nodes.find(
      (codeNode) => !absorbed.has(codeNode.id) && sameRecord(node, codeNode),
    );
    if (same) {
      absorbed.add(same.id);
      idOf.set(node.id, same.id);
      continue;
    }
    let id = node.id;
    while (taken.has(id)) id = `${id}-related`;
    taken.add(id);
    idOf.set(node.id, id);
    modelNodes.push(id === node.id ? node : { ...node, id });
  }

  const codeLinks = new Set(code.links.map(linkKey));
  const folded = new Set<string>();
  const modelLinks: GenealogyLink[] = [];
  for (const link of draft.genealogy.links) {
    const source = idOf.get(link.source) ?? link.source;
    const target = idOf.get(link.target) ?? link.target;
    const moved = { ...link, source, target };
    if (codeLinks.has(linkKey(moved))) {
      if (link.claimId) folded.add(link.claimId);
      continue;
    }
    // A link from a node to itself is never drawn; its claim stays, for the verifier.
    if (source !== target) modelLinks.push(moved);
  }

  // The Discogs items the code credit claims cite.
  const credited = new Set(
    code.claims.filter((claim) => claim.about === "credit").flatMap((claim) => claim.evidenceIds),
  );
  const linkClaims = new Set(draft.genealogy.links.flatMap((link) => link.claimId ?? []));
  const foldedCredit = (claim: Claim) =>
    claim.origin === "model" &&
    claim.about === "credit" &&
    claim.factoid === undefined &&
    !linkClaims.has(claim.id) &&
    claim.evidenceIds.length > 0 &&
    claim.evidenceIds.every((id) => credited.has(id));

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
    claims: [
      ...draft.claims.filter((claim) => !folded.has(claim.id) && !foldedCredit(claim)),
      ...code.claims,
    ],
    genealogy,
    nodeYears,
  };
}

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
 *   medley" (only when MusicBrainz marks it partial), "covers … in a medley", never "is covered
 *   by";
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
 * artist; for a song this recording covers, "<title> (the song)", so it is never read as this
 * track). It points from the earlier record to the later one (`GenealogyLink`): a recording this
 * one samples, remixes or covers is the source; one that samples, remixes or covers it is the
 * target. Each link states its own claim (`claimId`), never another link's. One node stands for
 * one record: two MusicBrainz recordings with the same title and artist credit (or one credit
 * within the other, led by the same artist) are one node, and each keeps its claim. No link is
 * drawn for:
 * - a cover of the song (a `work/` record: this recording is not shown to be its original, so
 *   nothing says it is the one covered, or the earlier one): its claim, about the work, only;
 * - a partial or medley cover: it takes part of the other record, not the whole of it.
 *
 * Curation. MusicBrainz gives these relationships no release status, so relevance is read from
 * what the records do say:
 * - what this recording draws on (samples, interpolates, remix-of, cover-of) always comes before
 *   what draws on it (sampled-by, interpolated-by, remixed-by, covered-by), in the claims and in
 *   the node order;
 * - each kind is capped on its own, what draws on this recording lower
 *   (CODE_DESCENDANTS_PER_KIND) than what it draws on (CODE_SOURCES_PER_KIND);
 * - within a kind: relations about this recording before those about its song, whole ones
 *   before partial or medley ones, then in the order MusicBrainz lists them;
 * - a record that draws on this one with an artist credit that is mostly not letters or digits
 *   (decorative Unicode: an uploader's handle, not a known artist) is left out;
 * - only relations whose item is in the evidence count, and a record is counted once.
 * Credits: one per credited artist (by Discogs id, else by name) and roles, a credit on the
 * track before the same one on the whole release, at most CODE_CREDITS_MAX, the track's before
 * the whole release's. Every other record stays in the evidence pack only.
 *
 * Artwork. Each node made from a recording may be searched for its cover, but only the first
 * CODE_ARTWORK_PER_KIND of each relationship kind (`noArtwork` lists the rest), so one run never
 * sends a burst of searches that a rate limit would cut short.
 */

import {
  type Claim,
  type ClaimAbout,
  type ClaimScope,
  type Evidence,
  LINK_CLAIM_ABOUT,
  type LinkType,
} from "@liner-notes/contract";
import { normalizeArtist, normalizeTitle, quoted, titlesMatch } from "../sources/records.js";
import type { CreditRelation, PrimaryRelation, RecordingRelation } from "./research/relations.js";
import type { Genealogy, GenealogyLink, GenealogyNode } from "./schema.js";
import type { ComposedDraft } from "./state.js";
import { LINK_VALUE } from "./verifier/links.js";

/** The most relations of one kind this recording draws on (samples, remix-of …) a result states. */
export const CODE_SOURCES_PER_KIND = 6;
/** The most relations of one kind that draw on this recording (sampled-by …) a result states. */
export const CODE_DESCENDANTS_PER_KIND = 4;
/** The most credits a result states; the rest stay in the evidence pack. */
export const CODE_CREDITS_MAX = 12;
/** The nodes of one relationship kind whose cover art is looked up. */
export const CODE_ARTWORK_PER_KIND = 2;

/** How a node made from a record is drawn: a related record, until the verifier groups it. */
const CODE_NODE_GROUP = 4;
const CODE_NODE_SIZE = 22;

type Kind = RecordingRelation["kind"];

/** The link type of each relationship kind, and whether the other record is the earlier one. */
const LINK_OF: Record<Kind, { type: LinkType; otherEarlier: boolean }> = {
  samples: { type: "sample", otherEarlier: true },
  "sampled-by": { type: "sample", otherEarlier: false },
  interpolates: { type: "interpolation", otherEarlier: true },
  "interpolated-by": { type: "interpolation", otherEarlier: false },
  "remix-of": { type: "remix", otherEarlier: true },
  "remixed-by": { type: "remix", otherEarlier: false },
  "cover-of": { type: "cover", otherEarlier: true },
  "covered-by": { type: "cover", otherEarlier: false },
};

/** True for a kind this recording draws on: the other record is the earlier one. */
const drawsOn = (kind: Kind) => LINK_OF[kind].otherEarlier;

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
 * The text of a partial or medley cover's claim, from its item's excerpt, which ends with the
 * relationship and the other record (`${phrase} "Title" by Artist.`, what the cache check
 * requires): "B partly covers A." (partial), "B covers part of A in a medley." (partial, in a
 * medley), "B covers A in a medley." (a medley not marked partial). Null when the excerpt does
 * not end so: the claim is then not made.
 */
function partialCoverText(relation: RecordingRelation, item: Evidence): string | null {
  const text = item.excerpt.replace(SOURCE_PREFIX, "").trim();
  const phrase = relation.kind === "covered-by" ? " is covered by " : " is a cover of ";
  const other = quoted(relation.other.title, relation.other.artist);
  const ending = `${phrase}${other}.`;
  if (!text.endsWith(ending) || text.length === ending.length) return null;
  const subject = text.slice(0, -ending.length);
  // "A is covered by B": B covers A. "A is a cover of B": A covers B.
  const [coverer, covered] = relation.kind === "covered-by" ? [other, subject] : [subject, other];
  const partial = relation.attributes.includes("partial");
  const medley = relation.attributes.includes("medley");
  return capitalized(
    medley
      ? partial
        ? `${coverer} covers part of ${covered} in a medley.`
        : `${coverer} covers ${covered} in a medley.`
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
  // A function, so a "$" in a name is written as it is.
  return codeClaimText({
    excerpt: item.excerpt.replace(
      ` credits ${credit.name}${as}`,
      () => ` credits ${creditedName(credit.name)}${as}`,
    ),
  });
}

// =============================================================================
// Artist credits
// =============================================================================

/** Joins between the artists of one credit; a word inside a name ("X Ambassadors") never is. */
const SEPARATOR = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;

/** A credit's artists, normalised, in credit order, each a whole name. */
const creditArtists = (credit: string) =>
  credit
    .split(SEPARATOR)
    .map((part) => normalizeArtist(part))
    .filter(Boolean);

/**
 * True when two artist credits name the same artists: the same whole credit, or the same
 * artists in any order, or one credit within the other led by the same artist ("Queen" within
 * "Queen & David Bowie"; never "Fire" within "Earth, Wind & Fire", whose lead is "Earth").
 */
export function sameCredit(a: string, b: string): boolean {
  const [wholeA, wholeB] = [normalizeArtist(a), normalizeArtist(b)];
  if (wholeA !== "" && wholeA === wholeB) return true;
  const [left, right] = [creditArtists(a), creditArtists(b)];
  if (left.length === 0 || right.length === 0) return false;
  const [small, large] = left.length <= right.length ? [left, right] : [right, left];
  if (!small.every((artist) => large.includes(artist))) return false;
  // The same artists in any order, or fewer of them led by the same artist.
  return small.length === large.length || small[0] === large[0];
}

/** Credits that name no artist: a compilation's, or MusicBrainz's special-purpose artists. */
const GENERIC_ARTISTS = new Set(
  ["Various Artists", "Various", "Unknown Artist", "[unknown]", "Anonymous", "[anonymous]"].map(
    (name) => normalizeArtist(name),
  ),
);

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

/**
 * An artist credit that is mostly not letters or digits, or written in decorative letters
 * (Unicode's mathematical alphanumerics): an uploader's handle, not a known artist.
 */
export function oddCredit(credit: string | null): boolean {
  if (credit === null) return false;
  const chars = [...credit.replace(/\s+/gu, "")];
  if (chars.length === 0) return true;
  if (chars.some((char) => /[\u{1D400}-\u{1D7FF}]/u.test(char))) return true;
  const plain = chars.filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  return plain * 2 < chars.length;
}

/** True when two recordings, by their names, are one record (see `sameCredit`). */
const sameNames = (
  a: { title: string; artist: string | null },
  b: { title: string; artist: string | null },
) =>
  a.artist !== null &&
  b.artist !== null &&
  normalizeTitle(a.title) !== "" &&
  normalizeTitle(a.title) === normalizeTitle(b.title) &&
  sameCredit(a.artist, b.artist);

// =============================================================================
// Curation and building
// =============================================================================

export interface CodeBuilt {
  claims: Claim[];
  /** The nodes made from the records, the analysed track's not included. */
  nodes: GenealogyNode[];
  links: GenealogyLink[];
  /** The ids of the nodes whose cover art is not looked up (see the module comment). */
  noArtwork: string[];
  /** The song each work node stands for, by node id, for the fold of the model's nodes. */
  works: Record<string, { title: string; artist: string | null }>;
}

/** The relationships that get a claim, curated (see the module comment), in claim order. */
export function curatedRelations(relations: readonly PrimaryRelation[]): RecordingRelation[] {
  const recordings = relations.filter(
    (r): r is RecordingRelation =>
      r.type === "relation" && (drawsOn(r.kind) || !oddCredit(r.other.artist)),
  );
  const rank = (r: RecordingRelation) =>
    (drawsOn(r.kind) ? 0 : 4) + (r.scope === "track" ? 0 : 2) + (partOnly(r) ? 1 : 0);
  const ordered = recordings
    .map((relation, index) => ({ relation, index }))
    .sort((a, b) => rank(a.relation) - rank(b.relation) || a.index - b.index)
    .map(({ relation }) => relation);
  const counted = new Map<Kind, RecordingRelation[]>();
  const kept: RecordingRelation[] = [];
  for (const relation of ordered) {
    const list = counted.get(relation.kind) ?? [];
    // The same record filed twice under one kind: once.
    if (kept.some((r) => r.kind === relation.kind && r.other.mbid === relation.other.mbid)) {
      continue;
    }
    // A second recording of a record already kept keeps its claim and takes no place.
    if (list.some((other) => sameNames(other.other, relation.other))) {
      kept.push(relation);
      continue;
    }
    const cap = drawsOn(relation.kind) ? CODE_SOURCES_PER_KIND : CODE_DESCENDANTS_PER_KIND;
    if (list.length >= cap) continue;
    counted.set(relation.kind, [...list, relation]);
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

  const nodes: GenealogyNode[] = [];
  const records: Array<{ id: string; title: string; artist: string | null; mbid: string }> = [];
  const works: CodeBuilt["works"] = {};
  const links: GenealogyLink[] = [];
  const drawn = new Set<string>();
  const artworkPerKind = new Map<Kind, Set<string>>();
  /** The node standing for a relation's other record: one per record. */
  const nodeFor = (relation: RecordingRelation): string => {
    const { entity, mbid, title, artist } = relation.other;
    const known = records.find(
      (record) =>
        record.mbid === mbid || (entity === "recording" && sameNames(record, relation.other)),
    );
    if (known) return known.id;
    const id = `mb-${mbid}`;
    records.push({ id, title, artist: entity === "recording" ? artist : null, mbid });
    if (entity === "work") {
      // A song: named as one, never as a recording (the analysed track may share its title).
      works[id] = { title, artist };
      nodes.push({
        id,
        group: CODE_NODE_GROUP,
        label: artist ? `${title} (the song by ${artist})` : `${title} (the song)`,
        size: CODE_NODE_SIZE,
      });
    } else {
      nodes.push({
        id,
        group: CODE_NODE_GROUP,
        label: artist ? `${title} - ${artist}` : title,
        size: CODE_NODE_SIZE,
        // A recording without an artist credit is not searched for as a track.
        ...(artist ? { trackTitle: title, trackArtist: artist } : {}),
      });
    }
    return id;
  };

  for (const relation of curatedRelations(present)) {
    const item = items.get(relation.evidenceId);
    if (!item) continue;
    const { type, otherEarlier } = LINK_OF[relation.kind];
    const text = partOnly(relation) ? partialCoverText(relation, item) : codeClaimText(item);
    if (text === null) continue;
    const claim = claimFor(relation, LINK_CLAIM_ABOUT[type][0], text);
    // A link only for a whole relation of this recording (see the module comment).
    if (relation.scope !== "track" || partOnly(relation)) continue;
    const id = nodeFor(relation);
    const [source, target] = otherEarlier ? [id, "current"] : ["current", id];
    const key = `${type} ${source} ${target}`;
    // A second recording of one record: its claim stands, the link is drawn once.
    if (drawn.has(key)) continue;
    drawn.add(key);
    const searched = artworkPerKind.get(relation.kind) ?? new Set<string>();
    if (searched.size < CODE_ARTWORK_PER_KIND) searched.add(id);
    artworkPerKind.set(relation.kind, searched);
    links.push({
      source,
      target,
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
  const searched = new Set([...artworkPerKind.values()].flatMap((ids) => [...ids]));
  const noArtwork = nodes
    .filter((node) => node.trackTitle && node.trackArtist && !searched.has(node.id))
    .map((node) => node.id);
  return { claims, nodes, links, noArtwork, works };
}

// =============================================================================
// With the model's genealogy
// =============================================================================

/** The title and artist a model node names: its own fields, else its label "Title - Artist". */
function namedRecord(node: GenealogyNode): { title: string; artist: string } {
  const [labelTitle = "", ...rest] = node.label.split(" - ");
  const labelArtist = rest.join(" - ").replace(/\s*\(\d{4}\)\s*$/, "");
  return {
    title: node.trackTitle?.trim() || labelTitle.trim(),
    artist: node.trackArtist?.trim() || labelArtist.trim(),
  };
}

/** True when a model node names a record titled `title`, credited to `artist`. */
function namesRecord(model: GenealogyNode, title: string, artist: string): boolean {
  const named = namedRecord(model);
  if (!named.title || !named.artist || !titlesMatch(named.title, title)) return false;
  if (GENERIC_TITLES.has(normalizeTitle(title))) return false;
  if (GENERIC_ARTISTS.has(normalizeArtist(artist))) return false;
  return sameCredit(named.artist, artist);
}

/**
 * True when a model node names the record a code node was made from: the same title (without
 * featured-artist and remaster suffixes) and the same artists (`sameCredit`: whole names,
 * never a word of one). Never for a generic title ("Intro", "Remix") or a credit that names no
 * artist ("Various Artists", "[unknown]").
 */
export function sameRecord(model: GenealogyNode, code: GenealogyNode): boolean {
  if (!code.trackTitle || !code.trackArtist) return false;
  return namesRecord(model, code.trackTitle, code.trackArtist);
}

const linkKey = (link: Pick<GenealogyLink, "source" | "target" | "type">) =>
  `${link.type ?? "influence"} ${link.source} ${link.target}`;

/** Words a model credit claim may use beside what the code credit claims state. */
const CONNECTIVES = new Set(
  "a an the is was are were as on of by and in for to with this that it its credited credits credit track song recording release album".split(
    " ",
  ),
);
const wordsOf = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The draft with the code-built claims and links added.
 * - A model node that names a code node's record becomes that node (the record's names are
 *   kept); so does a model node for the original recording of a song this track covers, when
 *   the record names the song's artist and the model's node names the same. A code node takes
 *   at most one model node, so no model link between two of its nodes is lost. A model node
 *   whose id a code node uses is renamed.
 * - A model link that then duplicates a code link (the same two nodes, the same type and the
 *   same direction) folds into it: the code link and its claim stay, the model link and its
 *   relation claim go. A link stated the other way round stays, for the verifier to judge.
 * - A model claim about a credit (not a card's) that cites only Discogs items the code credit
 *   claims cite, and states nothing beyond them (its words are theirs, or connectives), folds
 *   into them: it goes. One that says more (a studio, a year, another role) goes to the judge.
 * - `noArtwork` lists the code nodes whose cover is not looked up, but none the model named.
 * Pure.
 */
export function withCodeClaims<
  T extends Pick<ComposedDraft, "claims" | "genealogy" | "nodeYears"> & {
    noArtwork?: string[];
  },
>(draft: T, code: CodeBuilt): T & { noArtwork: string[] } {
  if (code.claims.length === 0) return { ...draft, noArtwork: draft.noArtwork ?? [] };
  const codeIds = new Set(code.nodes.map((node) => node.id));
  const taken = new Set(["current", ...codeIds]);
  const absorbed = new Set<string>();
  const idOf = new Map<string, string>([["current", "current"]]);
  const modelNodes: GenealogyNode[] = [];
  const matches = (node: GenealogyNode, codeNode: GenealogyNode) => {
    const work = code.works[codeNode.id];
    if (work) return work.artist !== null && namesRecord(node, work.title, work.artist);
    return sameRecord(node, codeNode);
  };
  let current: GenealogyNode | undefined;
  for (const node of draft.genealogy.nodes) {
    if (node.id === "current") {
      current = node;
      continue;
    }
    const same = code.nodes.find(
      (codeNode) => !absorbed.has(codeNode.id) && matches(node, codeNode),
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

  // The Discogs items the code credit claims cite, with the claim citing each.
  const credited = new Map(
    code.claims
      .filter((claim) => claim.about === "credit")
      .flatMap((claim) => claim.evidenceIds.map((id) => [id, claim] as const)),
  );
  const linkClaims = new Set(draft.genealogy.links.flatMap((link) => link.claimId ?? []));
  const foldedCredit = (claim: Claim) => {
    if (
      claim.origin !== "model" ||
      claim.about !== "credit" ||
      claim.factoid !== undefined ||
      linkClaims.has(claim.id) ||
      claim.evidenceIds.length === 0 ||
      !claim.evidenceIds.every((id) => credited.has(id))
    ) {
      return false;
    }
    const allowed = new Set([
      ...CONNECTIVES,
      ...claim.evidenceIds.flatMap((id) => wordsOf(credited.get(id)?.text ?? "")),
    ]);
    return wordsOf(claim.text).every((word) => allowed.has(word));
  };

  const nodeYears: Record<string, string> = {};
  for (const [id, year] of Object.entries(draft.nodeYears)) {
    const moved = idOf.get(id);
    // The model's year is kept for its own nodes only, never put on a node made from a record.
    if (moved && !codeIds.has(moved)) nodeYears[moved] = year;
  }
  const named = new Set(idOf.values());
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
    noArtwork: [...(draft.noArtwork ?? []), ...code.noArtwork.filter((id) => !named.has(id))],
  };
}

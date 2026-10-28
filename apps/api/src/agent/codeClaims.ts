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
 * The map. A node made from a record carries the record's MusicBrainz id (`mbid`) and, when
 * MusicBrainz dates the recording, the year of its first release (`year`); a node MusicBrainz
 * does not date has none, and no node built from a record ever takes the model's year. The
 * analysed track's node takes its own recording's (`CodeBuilt.current`), only when no later than
 * the release Spotify shows for it. The second hop (a
 * `hop` relation: what a recording this one samples samples, and the other recordings that
 * sample it, its siblings) gives code links between two other records, sourced on their item
 * alone: no claim (the contract's `linkClaimProblem` lets a code link stand on its evidence), and
 * only from a node already drawn, at most CODE_HOP_NODES new nodes, what the source samples
 * before its siblings. A second hop's end joins a node by its MBID only, and one that is another
 * recording of the analysed song is never drawn. A node's year is the first release date its
 * recording's own item states (`recording/<mbid>`, on the page that shows it; the analysed
 * track's own `track/` item for its node), the earliest when a node stands for several
 * recordings of one record. Where a code link's documented direction and its ends' years
 * disagree, the year of the end farther from the analysed track is left off. The whole map holds at most GENEALOGY_NODES_MAX nodes: the analysed track, then
 * the records this one draws on, then those that draw on it (CODE_NODES_MAX for the two, in that
 * order; a relation past it keeps its claim, without a node or link), then the second hop's,
 * then the model's own nodes; a link to a node left out is left out too.
 *
 * Artwork. Each node made from a recording may be searched for its cover, but only the first
 * CODE_ARTWORK_PER_KIND of each relationship kind (`noArtwork` lists the rest, and every node of
 * the second hop), so one run never sends a burst of searches that a rate limit would cut short.
 */

import {
  type Claim,
  type ClaimAbout,
  type ClaimScope,
  type Evidence,
  LINK_CLAIM_ABOUT,
  type LinkType,
} from "@liner-notes/contract";
import {
  DISAMBIGUATION_NUMBER,
  normalizeArtist,
  normalizeTitle,
  quoted,
  statesFirstRelease,
  titlesMatch,
} from "../sources/records.js";
import { dateRecordRef } from "../sources/identity.js";
import { releaseYearOf } from "../sources/musicbrainz.js";
import type {
  CreditRelation,
  HopRelation,
  PrimaryRelation,
  RecordingRelation,
} from "./research/relations.js";
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
/** The most nodes the whole map holds, the analysed track's included (see the module comment). */
export const GENEALOGY_NODES_MAX = 16;
/** The most nodes made from this recording's own relations (all but the analysed track's). */
export const CODE_NODES_MAX = GENEALOGY_NODES_MAX - 1;
/** The most new nodes the second hop adds (what the source samples, then its siblings). */
export const CODE_HOP_NODES = 4;

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

/** The relations a claim is made from: all but the second hop's, which state no claim. */
type ClaimedRelation = Exclude<PrimaryRelation, HopRelation>;

/** The claim scope of a record's recordRef scope. */
const CLAIM_SCOPE: Record<ClaimedRelation["scope"], ClaimScope> = {
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
  name.trim().replace(/\*+$/, "").replace(DISAMBIGUATION_NUMBER, "").trim();

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

/**
 * Joins between the artists of one credit; a word inside a name ("X Ambassadors") never is.
 * Whitespace before a join is read from the start of its run only, so a long run of spaces is
 * read once (the same splits as with `\s*` in front).
 */
export const SEPARATOR = /(?:(?<!\s)\s+)?(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;

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
  /** The ids of `nodes` the second hop added: in the map before the model's own nodes. */
  hopNodes?: string[];
  /**
   * What the analysed track's node takes from its own MusicBrainz recording: its id, and its
   * first release year when MusicBrainz dates it. Absent without an identified recording.
   */
  current?: { mbid: string; year?: number };
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
 * The analysed track as code-built claims read it: its MusicBrainz recording (id, first release
 * date, title and artist credit) and the release date Spotify shows for it.
 */
export interface AnalysedTrack {
  mbid: string;
  firstReleaseDate: string | null;
  title: string;
  artist: string;
  releaseDate?: string | null;
}

/** The year of a MusicBrainz first release date ("1979" of "1979-06-01"); none when unknown. */
function yearOf(date: string | null | undefined): { year?: number } {
  const year = releaseYearOf(date);
  return year ? { year: Number(year) } : {};
}

/** The second hop's relations, what a source samples before its siblings, in their order. */
function hopRelations(relations: readonly PrimaryRelation[]): HopRelation[] {
  const hops = relations.filter((r): r is HopRelation => r.type === "hop");
  return [
    ...hops.filter((r) => r.kind === "samples"),
    ...hops.filter((r) => r.kind === "sampled-by" && !oddCredit(r.other.artist)),
  ];
}

/**
 * The code-built claims, nodes and links of a run, from its relations and its evidence pack. A
 * relation whose item is not in `evidence` gives nothing, and takes no place in the curation.
 * `analysed` is the analysed track: its own MusicBrainz recording (its node's id, and its year
 * when no later than Spotify's release of it), whose names keep another recording of the same
 * song off the map. Pure, apart from `newId`.
 */
export function buildCodeClaims(
  relations: readonly PrimaryRelation[],
  evidence: readonly Evidence[],
  newId: () => string,
  analysed?: AnalysedTrack | null,
): CodeBuilt {
  const items = new Map(evidence.map((item) => [item.id, item]));
  const present = relations.filter((relation) => items.has(relation.evidenceId));
  const claims: Claim[] = [];
  const claimFor = (relation: ClaimedRelation, about: ClaimAbout, text: string): Claim => {
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
  type Other = {
    entity: "recording" | "work";
    mbid: string;
    title: string;
    artist: string | null;
    firstReleaseDate?: string | null;
  };
  /** The node of each record by its MBID: the ones it was made from, and those joined to it. */
  const nodeOfMbid = new Map<string, string>();
  /** The node already standing for a record, if any: one per record. */
  const knownNode = (other: Other): string | null =>
    nodeOfMbid.get(other.mbid) ??
    (other.entity === "recording"
      ? records.find((record) => sameNames(record, other))?.id
      : undefined) ??
    null;
  /**
   * The year of a record's node: the first release date it carries, only when the recording's
   * own item (`recording/<mbid>`, on its page) states that date.
   */
  const statedYear = (other: Other): { year?: number } => {
    const date = other.firstReleaseDate;
    const item = date ? items.get(`musicbrainz:${dateRecordRef(other.mbid)}`) : undefined;
    return date && item && statesFirstRelease(item, date) ? yearOf(date) : {};
  };
  /** A new node for a record. */
  const addNode = (other: Other): string => {
    const { entity, mbid, title, artist } = other;
    const id = `mb-${mbid}`;
    nodeOfMbid.set(mbid, id);
    records.push({ id, title, artist: entity === "recording" ? artist : null, mbid });
    if (entity === "work") {
      // A song: named as one, never as a recording (the analysed track may share its title).
      works[id] = { title, artist };
      nodes.push({
        id,
        group: CODE_NODE_GROUP,
        label: artist ? `${title} (the song by ${artist})` : `${title} (the song)`,
        size: CODE_NODE_SIZE,
        mbid,
      });
    } else {
      nodes.push({
        id,
        group: CODE_NODE_GROUP,
        label: artist ? `${title} - ${artist}` : title,
        size: CODE_NODE_SIZE,
        // A recording without an artist credit is not searched for as a track.
        ...(artist ? { trackTitle: title, trackArtist: artist } : {}),
        // Its year from MusicBrainz only, when its own item states it; never invented.
        ...statedYear(other),
        mbid,
      });
    }
    return id;
  };
  /**
   * The node standing for a relation's other record: one per record. A node that stands for
   * several recordings of one record keeps the earliest year their items state: the record's
   * first release.
   */
  const nodeFor = (other: Other): string => {
    const known = knownNode(other);
    if (known === null) return addNode(other);
    nodeOfMbid.set(other.mbid, known);
    const { year } = statedYear(other);
    const node = nodes.find((n) => n.id === known);
    if (node && year !== undefined && (node.year === undefined || year < node.year)) {
      node.year = year;
    }
    return known;
  };
  /** True for a record that is the analysed track, or another recording of it by its names. */
  const isAnalysed = (other: Other) =>
    !!analysed &&
    (other.mbid === analysed.mbid ||
      sameNames(other, { title: analysed.title, artist: analysed.artist }));

  for (const relation of curatedRelations(present)) {
    const item = items.get(relation.evidenceId);
    if (!item) continue;
    const { type, otherEarlier } = LINK_OF[relation.kind];
    const text = partOnly(relation) ? partialCoverText(relation, item) : codeClaimText(item);
    if (text === null) continue;
    const linked = relation.scope === "track" && !partOnly(relation);
    const claim = claimFor(relation, LINK_CLAIM_ABOUT[type][0], text);
    // A link only for a whole relation of this recording (see the module comment), while the
    // map has room for its record: past CODE_NODES_MAX, the claim stays without a node or link.
    if (!linked) continue;
    if (nodes.length >= CODE_NODES_MAX && knownNode(relation.other) === null) continue;
    const id = nodeFor(relation.other);
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
  // The second hop: links between two other records, each from a node already drawn. Its ends
  // are joined to nodes by MBID only: two recordings with one name are two records here. One
  // that is the analysed song (another recording of it) is the analysed track, already linked:
  // never a node of its own.
  const hopNodes: string[] = [];
  /** The end of each second-hop link farther from the analysed track: the hop's other record. */
  const farEnd = new Map<GenealogyLink, string>();
  for (const hop of hopRelations(present)) {
    const item = items.get(hop.evidenceId);
    const via = nodeOfMbid.get(hop.via.mbid);
    if (!item || via === undefined) continue;
    const other = { entity: "recording" as const, ...hop.other };
    let id = nodeOfMbid.get(other.mbid);
    if (id === undefined) {
      if (isAnalysed(other) || hopNodes.length >= CODE_HOP_NODES) continue;
      id = addNode(other);
      hopNodes.push(id);
    }
    if (id === via) continue;
    // "samples": the source samples the other record, the earlier one; "sampled-by": a sibling
    // samples the source.
    const [source, target] = hop.kind === "samples" ? [id, via] : [via, id];
    const key = `sample ${source} ${target}`;
    if (drawn.has(key)) continue;
    drawn.add(key);
    const link: GenealogyLink = {
      source,
      target,
      value: LINK_VALUE.sample,
      type: "sample",
      kind: "sourced",
      origin: "code",
      evidenceIds: [item.id],
    };
    links.push(link);
    farEnd.set(link, id);
  }
  // The analysed track's MusicBrainz year: only when its own item states it, and no later than
  // the release Spotify shows (a later one belongs to another release of the song).
  const ownDate = analysed?.firstReleaseDate ?? null;
  const ownItem = analysed ? items.get(`musicbrainz:track/recording/${analysed.mbid}`) : undefined;
  const own =
    ownDate && ownItem && statesFirstRelease(ownItem, ownDate) ? yearOf(ownDate).year : undefined;
  const released = analysed ? yearOf(analysed.releaseDate).year : undefined;
  const ownYear =
    own !== undefined && (released === undefined || own <= released) ? own : undefined;
  // A code link's direction is its record's. Where the years say otherwise (the record sampled
  // dated after the one sampling it: MusicBrainz knows only a later release of it), the year of
  // the end farther from the analysed track is left off: undated, never moved to fit.
  // The analysed track's year as the web shows it: its MusicBrainz year, else Spotify's.
  const yearOfNode = (id: string) =>
    id === "current" ? (ownYear ?? released) : nodes.find((node) => node.id === id)?.year;
  for (const link of links) {
    const [from, to] = [yearOfNode(link.source), yearOfNode(link.target)];
    if (from === undefined || to === undefined || from <= to) continue;
    const off =
      link.source === "current"
        ? link.target
        : link.target === "current"
          ? link.source
          : farEnd.get(link);
    const node = nodes.find((n) => n.id === off);
    if (node) delete node.year;
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
  const current = analysed
    ? { mbid: analysed.mbid, ...(ownYear !== undefined ? { year: ownYear } : {}) }
    : null;
  return {
    claims,
    nodes,
    links,
    noArtwork,
    works,
    ...(hopNodes.length > 0 ? { hopNodes } : {}),
    ...(current ? { current } : {}),
  };
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

/** The nodes past the map's cap (GENEALOGY_NODES_MAX), of nodes in the order the map keeps them. */
const cutOf = (ranked: readonly GenealogyNode[]) =>
  new Set(ranked.slice(GENEALOGY_NODES_MAX).map((node) => node.id));

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
 * - The analysed track's node takes its recording's MusicBrainz id and year (`code.current`); a
 *   node of the model's never carries a year or an id (those come from MusicBrainz only), and a
 *   code node never takes the model's year.
 * - The map keeps at most GENEALOGY_NODES_MAX nodes (see the module comment), and drops the
 *   links of the nodes it leaves out; their claims stay.
 * Pure.
 */
export function withCodeClaims<
  T extends Pick<ComposedDraft, "claims" | "genealogy" | "nodeYears"> & {
    noArtwork?: string[];
  },
>(draft: T, code: CodeBuilt): T & { noArtwork: string[] } {
  const { current: own } = code;
  /** A node of the draft as the map keeps it: only code sets a year or an id. */
  const asDrawn = (node: GenealogyNode): GenealogyNode => {
    const { year: _year, mbid: _mbid, ...rest } = node;
    if (node.id !== "current" || !own) return rest;
    return { ...rest, mbid: own.mbid, ...(own.year !== undefined ? { year: own.year } : {}) };
  };
  if (code.claims.length === 0 && code.links.length === 0) {
    const nodes = draft.genealogy.nodes.map(asDrawn);
    // The analysed track first, then the model's nodes in their order, up to the map's cap.
    const cut = cutOf([
      ...nodes.filter((node) => node.id === "current"),
      ...nodes.filter((node) => node.id !== "current"),
    ]);
    return {
      ...draft,
      genealogy: {
        nodes: nodes.filter((node) => !cut.has(node.id)),
        links: draft.genealogy.links.filter((l) => !cut.has(l.source) && !cut.has(l.target)),
      },
      noArtwork: (draft.noArtwork ?? []).filter((id) => !cut.has(id)),
    };
  }
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
    modelNodes.push({ ...asDrawn(node), id });
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
  const head = current ? [asDrawn(current)] : [];
  // Which nodes the map keeps: the analysed track, this recording's own records, the second
  // hop's (sourced, all of them), then the model's nodes (inferred), up to GENEALOGY_NODES_MAX;
  // links to the others are dropped.
  const hop = new Set(code.hopNodes ?? []);
  const cut = cutOf([
    ...head,
    ...code.nodes.filter((node) => !hop.has(node.id)),
    ...code.nodes.filter((node) => hop.has(node.id)),
    ...modelNodes,
  ]);
  const kept = (node: GenealogyNode) => !cut.has(node.id);
  const linkKept = (link: GenealogyLink) => !cut.has(link.source) && !cut.has(link.target);
  const genealogy: Genealogy = {
    nodes: [...head, ...modelNodes.filter(kept), ...code.nodes.filter(kept)],
    links: [...modelLinks.filter(linkKept), ...code.links.filter(linkKept)],
  };
  return {
    ...draft,
    claims: [
      ...draft.claims.filter((claim) => !folded.has(claim.id) && !foldedCredit(claim)),
      ...code.claims,
    ],
    genealogy,
    nodeYears,
    noArtwork: [
      ...(draft.noArtwork ?? []),
      ...code.noArtwork.filter((id) => !named.has(id) && !cut.has(id)),
    ],
  };
}

/**
 * The relations map as code builds it from MusicBrainz's records: each node made from a record
 * carries its MusicBrainz id and, only when MusicBrainz dates it, its first release year; the
 * second hop gives links between two other records that rest on their own item, with no claim;
 * the whole map holds at most GENEALOGY_NODES_MAX nodes, the records this one draws on first,
 * then those that draw on it, then the model's own nodes, then the second hop's.
 */

import {
  type Evidence,
  type GenealogyLink as ContractLink,
  linkDisplayKind,
  linkIssues,
  type ResultContext,
} from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { quoted, RELATION_PHRASE } from "../sources/records.js";
import {
  buildCodeClaims,
  CODE_HOP_NODES,
  CODE_NODES_MAX,
  GENEALOGY_NODES_MAX,
  withCodeClaims,
} from "./codeClaims.js";
import type { HopRelation, PrimaryRelation, RecordingRelation } from "./research/relations.js";
import type { GenealogyNode } from "./schema.js";
import { draftOf } from "./verifier/testing.js";

const OWN = "00000000-0000-4000-8000-000000000000";
/** A well-formed MBID, distinct for each `n`. */
const mbid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-10-20T12:00:00.000Z";

let ids = 0;
const newId = () => `claim-${++ids}`;

/**
 * A recording's own MusicBrainz item, on its page, stating its first release date (what a node's
 * year rests on).
 */
function datedItem(mbidOf: string, title: string, artist: string, date: string): Evidence {
  return {
    id: `musicbrainz:recording/${mbidOf}`,
    source: "musicbrainz",
    sourceTier: "primary-record",
    url: `https://musicbrainz.org/recording/${mbidOf}`,
    title: `${title} — MusicBrainz recording`,
    retrievedAt: AT,
    excerpt: `MusicBrainz recording ${quoted(title, artist)}, first released ${date}.`,
    recordRef: `recording/${mbidOf}`,
  };
}

type Part = { relation: PrimaryRelation; item: Evidence; dated?: Evidence[] };

type Names = { title?: string; artist?: string };

/**
 * A relation of this recording to recording `n`, with the item that states it, and the other
 * recording's own item stating its date (unless `unstated`).
 */
function relation(
  kind: RecordingRelation["kind"],
  n: number,
  date?: string,
  names: Names & { unstated?: boolean } = {},
): { relation: RecordingRelation; item: Evidence; dated: Evidence[] } {
  const other = { title: names.title ?? `Record ${n}`, artist: names.artist ?? `Artist ${n}` };
  const item: Evidence = {
    id: `musicbrainz:track/recording/${OWN}/${kind}/recording/${mbid(n)}`,
    source: "musicbrainz",
    sourceTier: "primary-record",
    url: `https://musicbrainz.org/recording/${OWN}`,
    title: "Track — MusicBrainz relationships",
    retrievedAt: AT,
    excerpt: `MusicBrainz: "Track" by Own ${RELATION_PHRASE[kind]} ${quoted(other.title, other.artist)}.`,
    recordRef: `track/recording/${OWN}/${kind}/recording/${mbid(n)}`,
  };
  return {
    item,
    dated: date && !names.unstated ? [datedItem(mbid(n), other.title, other.artist, date)] : [],
    relation: {
      type: "relation",
      source: "musicbrainz",
      evidenceId: item.id,
      scope: "track",
      kind,
      attributes: [],
      other: {
        entity: "recording",
        mbid: mbid(n),
        ...other,
        ...(date ? { firstReleaseDate: date } : {}),
      },
    },
  };
}

/** A second-hop relation of recording `via` to recording `n`, with its item (no scope). */
function hop(
  via: number,
  kind: HopRelation["kind"],
  n: number,
  date?: string,
  names: Names & { via?: Names; viaDate?: string } = {},
): { relation: HopRelation; item: Evidence; dated: Evidence[] } {
  const end = (m: number, d: string | undefined, given: Names = {}) => ({
    mbid: mbid(m),
    title: given.title ?? `Record ${m}`,
    artist: given.artist ?? `Artist ${m}`,
    ...(d ? { firstReleaseDate: d } : {}),
  });
  const [a, b] = [end(via, names.viaDate, names.via), end(n, date, names)];
  const ref = `recording/${a.mbid}/${kind}/recording/${b.mbid}`;
  const item: Evidence = {
    id: `musicbrainz:${ref}`,
    source: "musicbrainz",
    sourceTier: "primary-record",
    url: `https://musicbrainz.org/recording/${a.mbid}`,
    title: `${a.title} — MusicBrainz relationships`,
    retrievedAt: AT,
    excerpt: `MusicBrainz: ${quoted(a.title, a.artist)} ${RELATION_PHRASE[kind]} ${quoted(b.title, b.artist)}.`,
    recordRef: ref,
  };
  return {
    item,
    dated: [a, b].flatMap((end) =>
      end.firstReleaseDate
        ? [datedItem(end.mbid, end.title, end.artist, end.firstReleaseDate)]
        : [],
    ),
    relation: {
      type: "hop",
      source: "musicbrainz",
      evidenceId: item.id,
      scope: null,
      kind,
      attributes: [],
      via: a,
      other: b,
    },
  };
}

/** The analysed track as the composer hands it over: its recording and Spotify's release date. */
type Analysed = {
  mbid: string;
  firstReleaseDate: string | null;
  title: string;
  artist: string;
  releaseDate?: string | null;
};

const TRACK: Analysed = { mbid: OWN, firstReleaseDate: null, title: "Track", artist: "Own" };

/**
 * The code-built map of `parts`, with every item they need, and the analysed track's own item
 * stating its date (unless `ownUnstated`).
 */
function built(parts: Part[], analysed?: Analysed, ownUnstated = false) {
  const own: Evidence[] =
    analysed?.firstReleaseDate && !ownUnstated
      ? [
          {
            id: `musicbrainz:track/recording/${analysed.mbid}`,
            source: "musicbrainz",
            sourceTier: "primary-record",
            url: `https://musicbrainz.org/recording/${analysed.mbid}`,
            title: `${analysed.title} — MusicBrainz recording`,
            retrievedAt: AT,
            excerpt: `MusicBrainz recording ${quoted(analysed.title, analysed.artist)} (3:00), ISRC XX0000000000, first released ${analysed.firstReleaseDate}.`,
            recordRef: `track/recording/${analysed.mbid}`,
          },
        ]
      : [];
  const seen = new Set<string>();
  const evidence = [...own, ...parts.flatMap((p) => [p.item, ...(p.dated ?? [])])].filter(
    (item) => !seen.has(item.id) && seen.add(item.id),
  );
  const code = buildCodeClaims(
    parts.map((p) => p.relation),
    evidence,
    newId,
    analysed,
  );
  return { code, evidence };
}

/** The contract's reading of a link in a result with `evidence` and `claims`. */
function contextOf(evidence: Evidence[], claims = new Map()): ResultContext {
  return {
    evidenceIds: new Set(evidence.map((item) => item.id)),
    audio: null,
    claims,
    rejectedClaimIds: new Set(),
    sharedLinkClaimIds: new Set(),
  };
}

const nodeOf = (nodes: readonly GenealogyNode[], n: number) =>
  nodes.find((node) => node.id === `mb-${mbid(n)}`);

describe("years and ids on the nodes built from records", () => {
  it("makes a MusicBrainz sample a sourced sample link, its node dated by MusicBrainz", () => {
    const { code, evidence } = built([relation("samples", 1, "1979-06-01")]);
    expect(nodeOf(code.nodes, 1)).toMatchObject({ mbid: mbid(1), year: 1979 });
    expect(code.links).toEqual([
      expect.objectContaining({
        source: `mb-${mbid(1)}`,
        target: "current",
        type: "sample",
        kind: "sourced",
        origin: "code",
      }),
    ]);
    const claims = new Map(code.claims.map((claim) => [claim.id, claim]));
    expect(linkDisplayKind(code.links[0] as ContractLink, contextOf(evidence, claims))).toBe(
      "sourced",
    );
  });

  it("gives a node MusicBrainz does not date no year, and invents none", () => {
    const { code } = built([relation("samples", 1), relation("sampled-by", 2, "2001")]);
    expect(nodeOf(code.nodes, 1)).not.toHaveProperty("year");
    expect(nodeOf(code.nodes, 1)).toMatchObject({ mbid: mbid(1) });
    expect(nodeOf(code.nodes, 2)).toMatchObject({ year: 2001 });
  });

  it("dates the analysed track's node by its own recording, and never by the model", () => {
    const { code } = built([relation("samples", 1)], { ...TRACK, firstReleaseDate: "1990-08-01" });
    // The model names the sample (absorbed into the code node) and an influence of its own,
    // each with a year of its own: neither year reaches the map.
    const draft = draftOf([], [], {
      genealogy: {
        nodes: [
          { id: "current", group: 1, label: "Track", size: 40 },
          { id: "m1", group: 2, label: "Record 1 - Artist 1 (1975)", size: 28 },
          { id: "m2", group: 4, label: "Influence - Someone (1960)", size: 20 },
        ],
        links: [],
      },
      nodeYears: { m1: "1975", m2: "1960" },
    });
    const { genealogy } = withCodeClaims(draft, code);
    const byId = new Map(genealogy.nodes.map((node) => [node.id, node]));
    expect(byId.get("current")).toMatchObject({ mbid: OWN, year: 1990 });
    expect(byId.get(`mb-${mbid(1)}`)).not.toHaveProperty("year");
    expect(byId.get("m1")).toBeUndefined();
    expect(byId.get("m2")).not.toHaveProperty("year");
    expect(byId.get("m2")).not.toHaveProperty("mbid");
  });

  it("leaves a year off a model node that carries one, with or without code records", () => {
    const draft = draftOf([], [], {
      genealogy: {
        nodes: [
          { id: "current", group: 1, label: "Track", size: 40, year: 1800 },
          { id: "m2", group: 4, label: "Influence - Someone", size: 20, year: 1960, mbid: "x" },
        ],
        links: [],
      },
    });
    for (const code of [built([]).code, built([relation("samples", 1)]).code]) {
      const nodes = withCodeClaims(draft, code).genealogy.nodes;
      for (const node of nodes.filter((n) => !n.id.startsWith("mb-"))) {
        expect(node).not.toHaveProperty("year");
        expect(node).not.toHaveProperty("mbid");
      }
    }
  });
});

describe("the second hop", () => {
  it("links two other records on their own item, sourced with no claim", () => {
    const { code, evidence } = built([
      relation("samples", 1, "1981-10-26"),
      hop(1, "sampled-by", 2, "1999"),
      hop(1, "samples", 3, "1970"),
    ]);
    const hopLinks = code.links.filter((link) => link.target !== "current");
    expect(hopLinks).toEqual([
      // What the source samples points at the source; a sibling is pointed at by it.
      {
        source: `mb-${mbid(3)}`,
        target: `mb-${mbid(1)}`,
        value: expect.any(Number),
        type: "sample",
        kind: "sourced",
        origin: "code",
        evidenceIds: [`musicbrainz:recording/${mbid(1)}/samples/recording/${mbid(3)}`],
      },
      {
        source: `mb-${mbid(1)}`,
        target: `mb-${mbid(2)}`,
        value: expect.any(Number),
        type: "sample",
        kind: "sourced",
        origin: "code",
        evidenceIds: [`musicbrainz:recording/${mbid(1)}/sampled-by/recording/${mbid(2)}`],
      },
    ]);
    // No claim: one claim, the track's own sample.
    expect(code.claims).toHaveLength(1);
    expect(code.hopNodes).toEqual([`mb-${mbid(3)}`, `mb-${mbid(2)}`]);
    expect(nodeOf(code.nodes, 2)).toMatchObject({ year: 1999, mbid: mbid(2) });
    // The contract's rule: a code link that states no claim is sourced on its evidence.
    const context = contextOf(evidence, new Map(code.claims.map((c) => [c.id, c])));
    for (const link of hopLinks) {
      expect(linkIssues(link as ContractLink, context)).toEqual([]);
      expect(linkDisplayKind(link as ContractLink, context)).toBe("sourced");
    }
    // Its item missing from the pack, it is not.
    expect(linkDisplayKind(hopLinks[0] as ContractLink, contextOf([]))).toBe("inferred");
  });

  it("draws nothing from a source the map does not show, and at most CODE_HOP_NODES nodes", () => {
    const none = built([relation("samples", 1), hop(9, "sampled-by", 2)]).code;
    expect(none.links.filter((link) => link.target !== "current")).toEqual([]);
    expect(nodeOf(none.nodes, 2)).toBeUndefined();

    const siblings = Array.from({ length: CODE_HOP_NODES + 3 }, (_, i) =>
      hop(1, "sampled-by", 100 + i),
    );
    const { code } = built([relation("samples", 1), hop(1, "samples", 99), ...siblings]);
    expect(code.hopNodes).toHaveLength(CODE_HOP_NODES);
    // What the source samples comes before its siblings.
    expect(code.hopNodes?.[0]).toBe(`mb-${mbid(99)}`);
  });
});

describe("the map's cap", () => {
  // Ten of every kind, more than the map holds.
  const oversized = (["samples", "remix-of", "cover-of", "sampled-by", "remixed-by"] as const)
    .flatMap((kind, k) => Array.from({ length: 10 }, (_, i) => relation(kind, k * 100 + i)))
    .reverse();

  it("keeps CODE_NODES_MAX record nodes, what this recording draws on first", () => {
    const { code } = built([...oversized, ...[1, 2, 3].map((n) => hop(0, "sampled-by", 900 + n))]);
    const recordNodes = code.nodes.filter((node) => !code.hopNodes?.includes(node.id));
    expect(recordNodes).toHaveLength(CODE_NODES_MAX);
    expect(CODE_NODES_MAX + 1).toBe(GENEALOGY_NODES_MAX);
    expect(GENEALOGY_NODES_MAX).toBeGreaterThanOrEqual(12);
    expect(GENEALOGY_NODES_MAX).toBeLessThanOrEqual(16);
    // Six of each kind it draws on, in the order MusicBrainz listed them (here covers, remixes,
    // then samples), until the 15 places are taken; none of what draws on it.
    const kindOf = (node: GenealogyNode) => Math.floor(Number(node.mbid?.slice(-12)) / 100);
    expect(recordNodes.map(kindOf)).toEqual([...Array(6).fill(2), ...Array(6).fill(1), 0, 0, 0]);
    // A relation past the cap keeps its claim, with no node or link: six of each kind it draws
    // on, four of each that draws on it.
    expect(code.claims).toHaveLength(3 * 6 + 2 * 4);
    expect(code.links).toHaveLength(CODE_NODES_MAX);
  });

  it("holds the whole map to GENEALOGY_NODES_MAX: sourced records first, the model's last", () => {
    const parts = [
      relation("samples", 1),
      relation("samples", 2),
      ...Array.from({ length: 10 }, (_, i) => relation("sampled-by", 10 + i)),
      ...Array.from({ length: 4 }, (_, i) => hop(1, "sampled-by", 50 + i)),
    ];
    const { code } = built(parts);
    expect(code.nodes).toHaveLength(2 + 4 + 4);
    const modelNodes = Array.from({ length: 12 }, (_, i) => ({
      id: `model-${i}`,
      group: 4,
      label: `Influence ${i} - Someone ${i}`,
      size: 20,
    }));
    const draft = draftOf([], [], {
      genealogy: {
        nodes: [{ id: "current", group: 1, label: "Track", size: 40 }, ...modelNodes],
        links: modelNodes.map((node) => ({
          source: node.id,
          target: "current",
          value: 1,
          type: "influence" as const,
          kind: "inferred" as const,
          origin: "model" as const,
        })),
      },
    });
    const { genealogy } = withCodeClaims(draft, code);
    expect(genealogy.nodes).toHaveLength(GENEALOGY_NODES_MAX);
    const kept = new Set(genealogy.nodes.map((node) => node.id));
    // Every node built from a record (the second hop's too: sourced), then the model's
    // inferred nodes in the places left.
    for (const node of code.nodes) expect(kept.has(node.id)).toBe(true);
    expect(modelNodes.filter((node) => kept.has(node.id))).toHaveLength(
      GENEALOGY_NODES_MAX - 1 - code.nodes.length,
    );
    // No link names a node the map left out.
    for (const link of genealogy.links) {
      expect(kept.has(link.source) && kept.has(link.target)).toBe(true);
    }
  });

  it("holds a map with no records to GENEALOGY_NODES_MAX too", () => {
    const modelNodes = Array.from({ length: 20 }, (_, i) => ({
      id: `model-${i}`,
      group: 4,
      label: `Influence ${i} - Someone ${i}`,
      size: 20,
    }));
    const draft = draftOf([], [], {
      genealogy: {
        nodes: [{ id: "current", group: 1, label: "Track", size: 40 }, ...modelNodes],
        links: modelNodes.map((node) => ({
          source: node.id,
          target: "current",
          value: 1,
          type: "influence" as const,
          kind: "inferred" as const,
          origin: "model" as const,
        })),
      },
    });
    const { genealogy } = withCodeClaims(draft, built([]).code);
    expect(genealogy.nodes).toHaveLength(GENEALOGY_NODES_MAX);
    expect(genealogy.nodes[0].id).toBe("current");
    const kept = new Set(genealogy.nodes.map((node) => node.id));
    expect(genealogy.links).toHaveLength(GENEALOGY_NODES_MAX - 1);
    for (const link of genealogy.links) {
      expect(kept.has(link.source) && kept.has(link.target)).toBe(true);
    }
  });
});

describe("the analysed track on the map", () => {
  const UP = { title: "Under Pressure", artist: "Queen & David Bowie" };
  const ICE = { title: "Ice Ice Baby", artist: "Vanilla Ice" };

  it("never draws another recording of the analysed song as its sibling", () => {
    // MusicBrainz files several recordings of "Ice Ice Baby" (album, edits) as sampling "Under
    // Pressure": the second hop finds them, under their own MBIDs.
    const { code } = built(
      [
        relation("samples", 1, "1981-10-26", UP),
        hop(1, "sampled-by", 2, "1989", { ...ICE, via: UP, viaDate: "1981-10-26" }),
        hop(1, "sampled-by", 3, "1999", { title: "Sibling Song", artist: "Someone", via: UP }),
      ],
      { ...TRACK, ...ICE, firstReleaseDate: "1990-08-01" },
    );
    expect(code.nodes.map((node) => node.id)).toEqual([`mb-${mbid(1)}`, `mb-${mbid(3)}`]);
    expect(code.links.map((link) => [link.source, link.target])).toEqual([
      [`mb-${mbid(1)}`, "current"],
      [`mb-${mbid(1)}`, `mb-${mbid(3)}`],
    ]);
    expect(code.hopNodes).toEqual([`mb-${mbid(3)}`]);
  });

  it("joins a second-hop record to a node only by its MBID, never by its names", () => {
    const remix = { title: "Track (Remix)", artist: "DJ X" };
    const { code } = built([
      relation("samples", 1, "1970"),
      relation("remixed-by", 5, "1995", remix),
      // Another recording with the remix's names samples the source: a node of its own.
      hop(1, "sampled-by", 6, "2010", remix),
    ]);
    expect(nodeOf(code.nodes, 5)).toMatchObject({ year: 1995, mbid: mbid(5) });
    expect(nodeOf(code.nodes, 6)).toMatchObject({ year: 2010, mbid: mbid(6) });
    expect(code.links).toContainEqual(
      expect.objectContaining({ source: `mb-${mbid(1)}`, target: `mb-${mbid(6)}` }),
    );
  });

  it("takes its MusicBrainz year only when it is no later than its Spotify release", () => {
    const yearFor = (firstReleaseDate: string, releaseDate?: string | null) =>
      built([relation("samples", 1)], { ...TRACK, firstReleaseDate, releaseDate }).code.current;
    expect(yearFor("1990-08-01", "2015-03-01")).toEqual({ mbid: OWN, year: 1990 });
    expect(yearFor("1990-08-01", "1990")).toEqual({ mbid: OWN, year: 1990 });
    // A later MusicBrainz date than the release Spotify shows: no MusicBrainz year at all.
    expect(yearFor("2015-01-01", "1990-05-01")).toEqual({ mbid: OWN });
    expect(yearFor("1990-08-01", null)).toEqual({ mbid: OWN, year: 1990 });
  });
});

describe("years the evidence states", () => {
  it("gives no year a node's cited item does not state", () => {
    const { code } = built([
      relation("samples", 1, "1979", { unstated: true }),
      relation("samples", 2, "1981"),
    ]);
    expect(nodeOf(code.nodes, 1)).not.toHaveProperty("year");
    expect(nodeOf(code.nodes, 2)).toMatchObject({ year: 1981 });
    const tampered = hop(2, "sampled-by", 3, "2001");
    tampered.relation.other.firstReleaseDate = "2099";
    const withHop = built([relation("samples", 2, "1981"), tampered]).code;
    expect(nodeOf(withHop.nodes, 3)).not.toHaveProperty("year");
  });

  it("gives no year to the analysed track when its own item does not state it", () => {
    const analysed = { ...TRACK, firstReleaseDate: "1990-08-01" };
    expect(built([relation("samples", 1)], analysed).code.current).toEqual({
      mbid: OWN,
      year: 1990,
    });
    expect(built([relation("samples", 1)], analysed, true).code.current).toEqual({ mbid: OWN });
  });

  it("keeps the earliest year of the recordings one node stands for", () => {
    const groove = { title: "Rare Groove", artist: "Obscure Band" };
    const { code } = built([
      relation("samples", 1, "2005-03-01", groove),
      relation("samples", 2, "1973-05-01", groove),
    ]);
    expect(code.nodes).toHaveLength(1);
    expect(nodeOf(code.nodes, 1)).toMatchObject({ year: 1973 });
  });

  it("leaves off a year that contradicts a sourced link's documented direction", () => {
    // MusicBrainz dates the sampled record 2005 (a later reissue): the track (1994) samples it.
    const juicy = { ...TRACK, firstReleaseDate: "1994-08-09", releaseDate: "1994-09-13" };
    const groove = { title: "Rare Groove", artist: "Obscure Band" };
    const { code } = built([relation("samples", 1, "2005-03-01", groove)], juicy);
    expect(code.current).toEqual({ mbid: OWN, year: 1994 });
    expect(nodeOf(code.nodes, 1)).not.toHaveProperty("year");
    expect(code.links).toEqual([
      expect.objectContaining({ source: `mb-${mbid(1)}`, target: "current", kind: "sourced" }),
    ]);
    // A second-hop link the same: the source (1981) samples a record dated 1990, whose year goes.
    const hopped = built([
      relation("samples", 1, "1981"),
      hop(1, "samples", 2, "1990", { viaDate: "1981" }),
      hop(1, "sampled-by", 3, "1999", { viaDate: "1981" }),
    ]).code;
    expect(nodeOf(hopped.nodes, 1)).toMatchObject({ year: 1981 });
    expect(nodeOf(hopped.nodes, 2)).not.toHaveProperty("year");
    expect(nodeOf(hopped.nodes, 3)).toMatchObject({ year: 1999 });
    // The analysed track with no MusicBrainz year it may take (MusicBrainz dates it 1999,
    // after Spotify's 1994 release): its year is Spotify's, as the web shows it, and a sampled
    // record dated 2005 contradicts the link the same.
    const unstated = { ...juicy, firstReleaseDate: "1999-01-01" };
    const later = built([relation("samples", 1, "2005-03-01", groove)], unstated).code;
    expect(later.current).toEqual({ mbid: OWN });
    expect(nodeOf(later.nodes, 1)).not.toHaveProperty("year");
    // Never moved to fit: no node takes another's year.
    expect(hopped.nodes.map((node) => node.year)).toEqual([1981, undefined, 1999]);
  });
});

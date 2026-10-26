/**
 * Code-built claims and links on the "Ice Ice Baby" source fixture (sources/fixtures, with a
 * Discogs release shaped like the API's): MusicBrainz's relationships, Discogs' credits and the
 * release MusicBrainz names for the recording become claims and links written by code, with no
 * model involved; the verifier keeps them sourced; the fallback carries them.
 */

import {
  analysisIssues,
  type Claim,
  type Evidence,
  linkDisplayKind,
  type ResultContext,
  sharedClaimIds,
  TrackAnalysis,
} from "@liner-notes/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The node ids the artwork lookup was given, last call. */
const artwork = vi.hoisted(() => ({ given: [] as string[] }));
vi.mock(
  "./enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => {
        artwork.given = (genealogy?.nodes ?? []).map(({ id }) => id);
        return { nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })), complete: true };
      },
    }) satisfies Partial<typeof import("./enricher.js")>,
);
// The verifier's long-term store, outside a graph: none (the fallback is never stored).
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getStore: () => undefined,
}));

import loveStoryTvDetails from "../sources/fixtures/musicbrainz-recording-details-love-story-taylors-version.json" with {
  type: "json",
};
import loveStoryTvIsrc from "../sources/fixtures/musicbrainz-isrc-love-story-taylors-version.json" with {
  type: "json",
};
import loveStoryWork from "../sources/fixtures/musicbrainz-work-love-story.json" with {
  type: "json",
};
import { LlmError } from "../llm/errors.js";
import { collectPrimarySources, type IdentifiedRecording } from "../sources/identity.js";
import { MusicBrainzRateLimiter } from "../sources/musicbrainz.js";
import { json, stubFetch } from "../sources/testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "../sources/testing/iceIceBaby.js";
import {
  buildCodeClaims,
  type CodeBuilt,
  curatedRelations,
  sameRecord,
  withCodeClaims,
} from "./codeClaims.js";
import { createComposerNode } from "./nodes/composerNode.js";
import { primaryRecordEvidence } from "./research/evidencePack.js";
import { type PrimaryRelation, primaryRelations } from "./research/relations.js";
import {
  cachedEvidenceOf,
  cachedRunEvidence,
  restoredItems,
  runEvidence,
} from "./research/runEvidence.js";
import type { GenealogyLink, GenealogyNode } from "./schema.js";
import type { ComposedDraft, SonicAgentStateType } from "./state.js";
import { audioV2 } from "./testing/measuredAudio.js";
import { stubLlm, testRuntime } from "./testing/stubLlm.js";
import { applyVerdicts, checkClaims, createVerifierNode } from "./verifier/index.js";
import { draftOf, modelClaim, stateFor } from "./verifier/testing.js";

const AT = "2026-10-20T12:00:00.000Z";
const now = () => new Date(AT);
const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";
const ICE_ICE_BACON = "6507f9c2-48c9-4648-9daa-4c9271e0f983";
const FAITH_NO_MORE = "a91d02d8-d5b0-42ec-ae95-678ec39bd373";
const SAMPLES_ID = `musicbrainz:track/recording/${ICE}/samples/recording/${UNDER_PRESSURE}`;
const SAMPLED_ID = `musicbrainz:track/recording/${ICE}/sampled-by/recording/${ICE_ICE_BACON}`;
const COVER_ID = `musicbrainz:work/e0ebb61d-7f69-3667-a2b1-dcd447d80f3d/covered-by/recording/${FAITH_NO_MORE}`;
const RELEASE_ID = "musicbrainz:release/ae103b0a-b932-4009-acb6-388db1cf890b";

/**
 * The Discogs release MusicBrainz links first for the recording (599648), shaped like the API's,
 * with placeholder credits: a producer and an engineer on the track, the engineer again among the
 * release's credits for track 1 (a duplicate), the producer again for the whole release (a
 * duplicate), and a credit for the whole release.
 */
const DISCOGS_RELEASE = {
  id: 599648,
  title: "To the Extreme",
  year: 1990,
  artists: [{ id: 1, name: "Vanilla Ice", anv: "", join: "" }],
  extraartists: [
    { id: 2, name: "Test Engineer", anv: "", role: "Engineer", tracks: "1" },
    { id: 3, name: "Test Producer", anv: "", role: "Producer", tracks: "" },
    { id: 4, name: "Test Designer", anv: "", role: "Design", tracks: "" },
  ],
  tracklist: [
    {
      position: "1",
      type_: "track",
      title: "Ice Ice Baby",
      duration: "4:31",
      extraartists: [
        { id: 3, name: "Test Producer", anv: "", role: "Producer", tracks: "" },
        { id: 2, name: "Test Engineer", anv: "", role: "Engineer", tracks: "" },
      ],
    },
  ],
};
const TRACK_CREDIT = (n: number) => `discogs:track/release/599648/credit/${n}`;
const RELEASE_CREDIT = (n: number) => `discogs:release/599648/credit/${n}`;

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
  stubFetch((call) =>
    call.url === "https://api.discogs.com/releases/599648"
      ? json(DISCOGS_RELEASE)
      : primaryRoute(call),
  );
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  delete process.env.DISCOGS_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The primary sources for the track, as a run reads them. */
async function readIce() {
  let recording: IdentifiedRecording | null = null;
  const sources = await collectPrimarySources(ICE_TRACK, {
    now,
    onRecording: (found) => {
      recording = found;
    },
  });
  const evidence: Evidence[] = primaryRecordEvidence(sources);
  const relations = primaryRelations(sources);
  return { sources, evidence, relations, recording: recording as IdentifiedRecording | null };
}

const counter = () => {
  let next = 0;
  return () => `code-${++next}`;
};

const claimCiting = (claims: readonly Claim[], id: string) =>
  claims.find((claim) => claim.evidenceIds.includes(id));

/** A MusicBrainz relationship of the recording "Own" by Artist to record `n`. */
function relation(
  n: number,
  kind: Extract<PrimaryRelation, { type: "relation" }>["kind"],
  scope: "track" | "work",
  attributes: string[] = [],
): Extract<PrimaryRelation, { type: "relation" }> {
  return {
    type: "relation",
    source: "musicbrainz",
    evidenceId: `musicbrainz:${scope}/recording/own/${kind}/recording/rec-${n}`,
    scope,
    kind,
    attributes,
    other: { entity: "recording", mbid: `rec-${n}`, title: `Song ${n}`, artist: `Band ${n}` },
  };
}

const PHRASE: Record<string, string> = {
  samples: "samples",
  "sampled-by": "is sampled in",
  "remix-of": "is a remix of",
  "remixed-by": "is remixed in",
  "cover-of": "is a cover of",
  "covered-by": "is covered by",
};

/** The item that states a relation of `relation()`, as the MusicBrainz module writes it. */
function itemOf(relation: PrimaryRelation): Evidence {
  if (relation.type !== "relation") throw new Error("not a relation");
  const { title, artist } = relation.other;
  return {
    id: relation.evidenceId,
    source: "musicbrainz",
    sourceTier: "primary-record",
    url: "https://musicbrainz.org/recording/own",
    title: "Own — MusicBrainz relationships",
    retrievedAt: AT,
    excerpt: `MusicBrainz: "Own" by Artist ${PHRASE[relation.kind]} "${title}" by ${artist}.`,
    recordRef: relation.evidenceId.replace(/^musicbrainz:/, ""),
  };
}

/** What the contract's readers check a result's links and claims against. */
function contextOf(claims: readonly Claim[], links: GenealogyLink[], evidence: Evidence[]) {
  return {
    evidenceIds: new Set(evidence.map((item) => item.id)),
    audio: null,
    claims: new Map(claims.map((claim) => [claim.id, claim])),
    rejectedClaimIds: new Set<string>(),
    sharedLinkClaimIds: sharedClaimIds(links),
  } satisfies ResultContext;
}

describe("code-built claims and links from the primary records", () => {
  it("turns the MusicBrainz sample into a sourced claim and a code link from the sampled record", async () => {
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(relations, evidence, counter());

    const claim = claimCiting(code.claims, SAMPLES_ID);
    expect(claim).toEqual({
      id: expect.any(String),
      text: '"Ice Ice Baby" by Vanilla Ice samples "Under Pressure" by Queen & David Bowie.',
      about: "sample",
      kind: "sourced",
      origin: "code",
      evidenceIds: [SAMPLES_ID],
      verdict: null,
      verdictReason: null,
      numericCheck: "n/a",
      scope: "recording",
    });
    // The earlier record, the one sampled, is the link's source.
    const link = code.links.find((l) => l.claimId === claim?.id);
    expect(link).toEqual({
      source: `mb-${UNDER_PRESSURE}`,
      target: "current",
      value: 3,
      type: "sample",
      kind: "sourced",
      origin: "code",
      claimId: claim?.id,
      evidenceIds: [SAMPLES_ID],
    });
    // The node is made from the record, with its names.
    expect(code.nodes.find((node) => node.id === `mb-${UNDER_PRESSURE}`)).toMatchObject({
      label: "Under Pressure - Queen & David Bowie",
      trackTitle: "Under Pressure",
      trackArtist: "Queen & David Bowie",
    });
    // A record that samples this one is the later one: the link points to it.
    const sampledBy = code.links.find((l) => l.evidenceIds?.includes(SAMPLED_ID));
    expect(sampledBy).toMatchObject({
      source: "current",
      target: `mb-${ICE_ICE_BACON}`,
      type: "sample",
    });
    // The contract's readers show the link sourced through its own claim.
    const context = contextOf(code.claims, code.links, evidence);
    for (const each of code.links) expect(linkDisplayKind(each, context)).toBe("sourced");
    expect(sharedClaimIds(code.links).size).toBe(0);
  });

  it("states a cover of the song as a claim about the work, and draws no link from this recording", async () => {
    // The recording is not shown to be the song's original: its covers are the work's.
    const { sources, evidence, relations } = await readIce();
    expect(sources.identity?.original.original).toBe(false);
    const code = buildCodeClaims(relations, evidence, counter());
    const claim = claimCiting(code.claims, COVER_ID);
    expect(claim).toMatchObject({
      text: 'The work "Ice Ice Baby" is covered by "Ice Ice Baby" by Faith No More.',
      about: "cover",
      scope: "work",
      origin: "code",
      kind: "sourced",
    });
    // Nothing says this recording is the one covered, or the earlier one.
    expect(claim?.text).not.toContain("Vanilla Ice");
    expect(code.links.filter((l) => l.type === "cover")).toEqual([]);
    expect(code.nodes.some((node) => node.id === `mb-${FAITH_NO_MORE}`)).toBe(false);
  });

  it("draws no link from a re-recording to the covers of its song", async () => {
    // "Love Story (Taylor's Version)" (2021), ruled out as the original by its title.
    const MB = "https://musicbrainz.org/ws/2";
    stubFetch((call) => {
      if (call.url.startsWith(`${MB}/isrc/USUG12100342?`)) return json(loveStoryTvIsrc);
      if (call.url.startsWith(`${MB}/recording/93484aa2-0ce6-4356-9ff4-9db61e07acd5?`)) {
        return json(loveStoryTvDetails);
      }
      if (call.url.startsWith(`${MB}/release?`)) return json({ "release-count": 0, releases: [] });
      if (call.url.startsWith(`${MB}/work/c8975007-ba64-3e81-9a3c-69a3ba2fab95?`)) {
        return json(loveStoryWork);
      }
      return undefined;
    });
    const sources = await collectPrimarySources(
      {
        isrc: "USUG12100342",
        title: "Love Story (Taylor’s Version)",
        artists: ["Taylor Swift"],
        durationMs: 235_766,
      },
      { now },
    );
    expect(sources.identity?.original.original).toBe(false);
    const code = buildCodeClaims(
      primaryRelations(sources),
      primaryRecordEvidence(sources),
      counter(),
    );
    const covers = code.claims.filter((claim) => claim.about === "cover");
    expect(covers.length).toBeGreaterThan(0);
    for (const claim of covers) {
      expect(claim.scope).toBe("work");
      expect(claim.text).toMatch(
        /^The work "Love Story" is (?:partly )?covered by |covers part of the work "Love Story"/,
      );
    }
    expect(code.links.filter((l) => l.type === "cover")).toEqual([]);
  });

  it("draws no link for a medley of the song, and leaves it last among the covers", async () => {
    // FORK's "Anniversary Medley Part 1": partial, in a medley; whole covers come first, and the
    // covers of this recording's song are capped at 4.
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(relations, evidence, counter());
    const id = `musicbrainz:work/e0ebb61d-7f69-3667-a2b1-dcd447d80f3d/covered-by/recording/d03e2f99-0248-4cc2-ace4-3e0abbcbf386`;
    expect(code.links.some((l) => l.evidenceIds?.includes(id))).toBe(false);
    expect(claimCiting(code.claims, id)).toBeUndefined();
    expect(code.claims.filter((claim) => claim.about === "cover")).toHaveLength(4);
  });

  it("scopes a Discogs credit by what it names: the track, or the whole release", async () => {
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(relations, evidence, counter());
    const credits = code.claims.filter((claim) => claim.about === "credit");

    expect(credits.map((claim) => [claim.evidenceIds, claim.scope])).toEqual([
      [[TRACK_CREDIT(0)], "recording"],
      [[TRACK_CREDIT(1)], "recording"],
      [[RELEASE_CREDIT(4)], "release"],
    ]);
    expect(claimCiting(credits, TRACK_CREDIT(0))?.text).toBe(
      'Discogs release 599648 ("To the Extreme", 1990) credits Test Producer as Producer on track 1 "Ice Ice Baby".',
    );
    expect(claimCiting(credits, RELEASE_CREDIT(4))?.text).toBe(
      'Discogs release 599648 ("To the Extreme", 1990) credits Test Designer as Design on the whole release (which includes "Ice Ice Baby").',
    );
    // The same credit again (the engineer for track 1, the producer for the whole release) is
    // left in the evidence only.
    expect(evidence.map((item) => item.id)).toEqual(
      expect.arrayContaining([TRACK_CREDIT(2), RELEASE_CREDIT(3)]),
    );
    expect(claimCiting(code.claims, TRACK_CREDIT(2))).toBeUndefined();
    expect(claimCiting(code.claims, RELEASE_CREDIT(3))).toBeUndefined();
    for (const claim of credits) expect(claim).toMatchObject({ origin: "code", kind: "sourced" });
  });

  it("states the release MusicBrainz names for the recording as a claim about that release", async () => {
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(relations, evidence, counter());
    expect(claimCiting(code.claims, RELEASE_ID)).toMatchObject({
      text: '"Ice Ice Baby" by Vanilla Ice appears on the official album "To the Extreme" (1990-09-04).',
      about: "track",
      scope: "release",
      origin: "code",
      kind: "sourced",
      evidenceIds: [RELEASE_ID],
    });
    // No link: a release is not a record of the genealogy.
    expect(code.links.some((link) => link.evidenceIds?.includes(RELEASE_ID))).toBe(false);
  });

  it("builds nothing from a relation whose item is not in the evidence", async () => {
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(
      relations,
      evidence.filter((item) => item.id !== SAMPLES_ID),
      counter(),
    );
    expect(claimCiting(code.claims, SAMPLES_ID)).toBeUndefined();
    expect(code.nodes.some((node) => node.id === `mb-${UNDER_PRESSURE}`)).toBe(false);
  });

  it("keeps at most 4 relations of a kind that draws on the recording, its own and the whole ones first", () => {
    const relations = [
      ...Array.from({ length: 12 }, (_, i) => relation(i, "covered-by", "work")),
      relation(20, "covered-by", "track", ["cover", "partial"]),
      relation(21, "covered-by", "track"),
      // The same record filed again under the same kind: once.
      { ...relation(21, "covered-by", "track"), evidenceId: "musicbrainz:dup" },
    ];
    expect(curatedRelations(relations).map((r) => r.other.mbid)).toEqual([
      "rec-21",
      "rec-20",
      "rec-0",
      "rec-1",
    ]);
  });

  it("never lets what draws on the track push out what the track draws on", () => {
    const sampledBy = Array.from({ length: 7 }, (_, i) => relation(i, "sampled-by", "track"));
    const remixedBy = Array.from({ length: 6 }, (_, i) => relation(10 + i, "remixed-by", "track"));
    const kept = curatedRelations([
      ...sampledBy,
      relation(99, "samples", "track"),
      ...remixedBy,
      relation(98, "remix-of", "track"),
    ]);
    expect(kept.filter((r) => r.kind === "samples").map((r) => r.other.mbid)).toEqual(["rec-99"]);
    expect(kept.filter((r) => r.kind === "remix-of").map((r) => r.other.mbid)).toEqual(["rec-98"]);
    // What draws on it is capped lower, and comes after.
    expect(kept.filter((r) => r.kind === "sampled-by")).toHaveLength(4);
    expect(kept.filter((r) => r.kind === "remixed-by")).toHaveLength(4);
    expect(kept.slice(0, 2).map((r) => r.kind)).toEqual(["samples", "remix-of"]);
  });

  it("spends no place of the cap on a relation whose item is not in the evidence", () => {
    const relations = Array.from({ length: 7 }, (_, i) => relation(i, "samples", "track"));
    const evidence = relations.slice(1).map((r) => itemOf(r));
    const code = buildCodeClaims(relations, evidence, counter());
    expect(code.links.map((l) => l.source)).toEqual(
      relations.slice(1).map((r) => `mb-${r.type === "relation" ? r.other.mbid : ""}`),
    );
  });

  it("draws no link for a partial cover, and says it is partial", () => {
    const partial = relation(1, "covered-by", "track", ["cover", "partial"]);
    const code = buildCodeClaims([partial], [itemOf(partial)], counter());
    expect(code.links).toEqual([]);
    expect(code.claims.map((claim) => claim.text)).toEqual([
      '"Song 1" by Band 1 partly covers "Own" by Artist.',
    ]);
  });
});

describe("credits", () => {
  const credit = (
    n: number,
    name: string,
    artistId: number | null,
    scope: "track" | "release" = "track",
  ): PrimaryRelation => ({
    type: "credit",
    source: "discogs",
    evidenceId: scope === "track" ? TRACK_CREDIT(n) : RELEASE_CREDIT(n),
    scope,
    name,
    artistId,
    roles: ["Producer"],
  });
  const creditItem = (relation: PrimaryRelation): Evidence => {
    if (relation.type !== "credit") throw new Error("not a credit");
    const where =
      relation.scope === "track"
        ? 'track 1 "Ice Ice Baby"'
        : 'the whole release (which includes "Ice Ice Baby")';
    return {
      id: relation.evidenceId,
      source: "discogs",
      sourceTier: "primary-record",
      url: "https://www.discogs.com/release/599648",
      title: "To the Extreme — Discogs release 599648",
      retrievedAt: AT,
      excerpt: `Discogs release 599648 ("To the Extreme", 1990) credits ${relation.name} as ${relation.roles.join(", ")} on ${where}.`,
      recordRef: relation.evidenceId.replace(/^discogs:/, ""),
    };
  };

  it("names a credited artist without Discogs' disambiguation, and keeps two artists of one name", () => {
    const relations = [credit(0, "Nirvana (2)", 100), credit(1, "Nirvana", 200)];
    const code = buildCodeClaims(relations, relations.map(creditItem), counter());
    expect(code.claims.map((claim) => claim.text)).toEqual([
      'Discogs release 599648 ("To the Extreme", 1990) credits Nirvana as Producer on track 1 "Ice Ice Baby".',
      'Discogs release 599648 ("To the Extreme", 1990) credits Nirvana as Producer on track 1 "Ice Ice Baby".',
    ]);
  });

  it("keeps at most 12 credits, the track's before the whole release's", () => {
    const relations = [
      ...Array.from({ length: 10 }, (_, i) => credit(i, `Release Person ${i}`, i, "release")),
      ...Array.from({ length: 5 }, (_, i) => credit(10 + i, `Track Person ${i}`, 10 + i)),
    ];
    const code = buildCodeClaims(relations, relations.map(creditItem), counter());
    expect(code.claims).toHaveLength(12);
    expect(code.claims.slice(0, 5).every((claim) => claim.scope === "recording")).toBe(true);
    expect(code.claims.slice(5).every((claim) => claim.scope === "release")).toBe(true);
  });

  it("folds the model's claim of a credit only when it says no more than the code claim", () => {
    const relations = [credit(0, "Test Producer", 3)];
    const code = buildCodeClaims(relations, relations.map(creditItem), counter());
    const cites = { about: "credit" as const, evidenceIds: [TRACK_CREDIT(0)] };
    const draft = draftOf([
      modelClaim("m-same", {
        ...cites,
        text: 'Test Producer is credited as producer on "Ice Ice Baby".',
      }),
      modelClaim("m-more", { ...cites, text: "Test Producer produced it at Hit Factory in 1989." }),
      modelClaim("m-other-role", { ...cites, text: "Test Producer wrote the lyrics." }),
      modelClaim("m-uncited", { about: "credit", evidenceIds: [TRACK_CREDIT(7)] }),
      {
        ...modelClaim("m-card", { ...cites, text: "Test Producer is credited as producer." }),
        factoid: { title: "Credits", type: "credits", entities: [] },
      },
    ]);
    const merged = withCodeClaims(draft, code);
    expect(merged.claims.map((claim) => claim.id)).toEqual([
      "m-more",
      "m-other-role",
      "m-uncited",
      "m-card",
      code.claims[0].id,
    ]);
  });
});

describe("the research cache keeps the relations with their items", () => {
  it("restores them only while each item still states its relation", async () => {
    const { sources, recording } = await readIce();
    const runtime = testRuntime(
      stubLlm(() => ({})),
      AT,
    );
    const config = { writer: () => {} } as never;
    const pack = await runEvidence(
      Promise.resolve({ status: "read", sources }),
      [],
      config,
      runtime,
    );
    expect(pack.relations.map((r) => r.evidenceId)).toEqual(
      expect.arrayContaining([SAMPLES_ID, COVER_ID, RELEASE_ID, TRACK_CREDIT(0)]),
    );
    const row = JSON.parse(JSON.stringify(cachedEvidenceOf(pack, ICE_TRACK.isrc, recording, AT)));
    expect(row.relations).toEqual(pack.relations);
    const restored = restoredItems(row);
    expect(restored).not.toBeNull();
    // A hit gives them back with the items, for the code-built claims of the run it serves.
    expect(cachedRunEvidence(row, restored ?? [], config, runtime).relations).toEqual(
      pack.relations,
    );

    // A relation to another record than its item states: the cached evidence is not used.
    const tampered = structuredClone(row);
    const sample = tampered.relations.find(
      (r: PrimaryRelation) => r.evidenceId === SAMPLES_ID,
    ) as Extract<PrimaryRelation, { type: "relation" }>;
    sample.other.mbid = FAITH_NO_MORE;
    expect(restoredItems(tampered)).toBeNull();
  });

  /** A relation of the cached row changed by `change`, or one more relation added. */
  const tampers: Array<[string, (relations: PrimaryRelation[]) => void]> = [
    [
      "names another record than its item",
      (relations) => {
        const sample = relations.find((r) => r.evidenceId === SAMPLES_ID);
        if (sample?.type === "relation") sample.other.title = "Some Other Song";
      },
    ],
    [
      "names another artist than its item",
      (relations) => {
        const sample = relations.find((r) => r.evidenceId === SAMPLES_ID);
        if (sample?.type === "relation") sample.other.artist = "Someone Else";
      },
    ],
    [
      "credits another name than its item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === TRACK_CREDIT(0));
        if (found?.type === "credit") found.name = "Someone Else";
      },
    ],
    [
      "credits other roles than its item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === TRACK_CREDIT(0));
        if (found?.type === "credit") found.roles = ["Mixed By"];
      },
    ],
    [
      "names another release than its item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === RELEASE_ID);
        if (found?.type === "release") found.release.title = "Another Album";
      },
    ],
    [
      "names another release id than its item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === RELEASE_ID);
        if (found?.type === "release") found.release.mbid = "00000000-0000-4000-8000-000000000000";
      },
    ],
    [
      "gives a credit another scope than its item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === TRACK_CREDIT(0));
        if (found) found.scope = "release";
      },
    ],
    [
      "says a credit is stated by a MusicBrainz item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === TRACK_CREDIT(0));
        if (found) found.evidenceId = RELEASE_ID;
      },
    ],
    [
      "says two relations are stated by one item",
      (relations) => {
        const found = relations.find((r) => r.evidenceId === TRACK_CREDIT(0));
        if (found) relations.push(structuredClone(found));
      },
    ],
  ];
  for (const [what, tamper] of tampers) {
    it(`does not restore a cached relation that ${what}`, async () => {
      const { sources, recording } = await readIce();
      const pack = await runEvidence(
        Promise.resolve({ status: "read", sources }),
        [],
        { writer: () => {} } as never,
        testRuntime(
          stubLlm(() => ({})),
          AT,
        ),
      );
      const row = JSON.parse(JSON.stringify(cachedEvidenceOf(pack, ICE_TRACK.isrc, recording, AT)));
      expect(restoredItems(row)).not.toBeNull();
      tamper(row.relations);
      expect(restoredItems(row)).toBeNull();
    });
  }
});

describe("a model link that duplicates a code link", () => {
  const code: CodeBuilt = {
    claims: [
      {
        ...modelClaim("code-1", { about: "sample", evidenceIds: [SAMPLES_ID] }),
        origin: "code",
        kind: "sourced",
      },
    ],
    nodes: [
      {
        id: `mb-${UNDER_PRESSURE}`,
        group: 4,
        label: "Under Pressure - Queen & David Bowie",
        size: 22,
        trackTitle: "Under Pressure",
        trackArtist: "Queen & David Bowie",
      },
    ],
    links: [
      {
        source: `mb-${UNDER_PRESSURE}`,
        target: "current",
        value: 3,
        type: "sample",
        kind: "sourced",
        origin: "code",
        claimId: "code-1",
        evidenceIds: [SAMPLES_ID],
      },
    ],
    noArtwork: [],
    works: {},
  };
  const modelLink = (
    source: string,
    target: string,
    type: GenealogyLink["type"],
    claimId: string,
  ) =>
    ({
      source,
      target,
      value: 1,
      type,
      kind: "inferred",
      origin: "model",
      claimId,
      evidenceIds: [],
    }) as GenealogyLink;

  /** The model's node for Under Pressure, named with the record's full artist credit. */
  const withUp = (
    draft: ReturnType<typeof draftOf>,
    label = "Under Pressure - Queen & David Bowie (1981)",
  ) => {
    draft.genealogy.nodes = draft.genealogy.nodes.map((node) =>
      node.id === "up" ? { ...node, label, trackTitle: "Under Pressure" } : node,
    );
    return draft;
  };

  it("folds into the code link, which keeps its own claim", () => {
    const draft = withUp(
      draftOf(
        [modelClaim("m-sample"), modelClaim("m-influence"), modelClaim("m-other")],
        [
          // The model's sample, on its own node for the record.
          modelLink("up", "current", "sample", "m-sample"),
          modelLink("up", "current", "influence", "m-influence"),
          modelLink(`mb-${UNDER_PRESSURE}`, "current", "influence", "m-other"),
        ],
        { nodeYears: { up: "1981", [`mb-${UNDER_PRESSURE}`]: "1990" } },
      ),
    );

    const merged = withCodeClaims(draft, code);

    // The model's node for the record is the code node; a model node whose id the code node
    // uses is renamed.
    expect(merged.genealogy.nodes.map((node) => node.id)).toEqual([
      "current",
      `mb-${UNDER_PRESSURE}-related`,
      `mb-${UNDER_PRESSURE}`,
    ]);
    // The duplicate sample is gone with its claim; the code link and claim stay; the model's
    // influence (another type) stays, moved onto the code node.
    expect(merged.genealogy.links.map((l) => [l.source, l.target, l.type, l.claimId])).toEqual([
      [`mb-${UNDER_PRESSURE}`, "current", "influence", "m-influence"],
      [`mb-${UNDER_PRESSURE}-related`, "current", "influence", "m-other"],
      [`mb-${UNDER_PRESSURE}`, "current", "sample", "code-1"],
    ]);
    expect(merged.claims.map((claim) => claim.id)).toEqual(["m-influence", "m-other", "code-1"]);
    // The model's year is never put on a node made from a record.
    expect(merged.nodeYears).toEqual({ [`mb-${UNDER_PRESSURE}-related`]: "1990" });
  });

  it("does not fold a model link that states the relation the other way round", () => {
    // "Under Pressure samples Ice Ice Baby": the verifier judges it, and may reject it.
    const draft = withUp(
      draftOf([modelClaim("m-reversed")], [modelLink("current", "up", "sample", "m-reversed")]),
    );
    const merged = withCodeClaims(draft, code);
    expect(merged.genealogy.links.map((l) => [l.source, l.target, l.type, l.claimId])).toEqual([
      ["current", `mb-${UNDER_PRESSURE}`, "sample", "m-reversed"],
      [`mb-${UNDER_PRESSURE}`, "current", "sample", "code-1"],
    ]);
    expect(merged.claims.map((claim) => claim.id)).toEqual(["m-reversed", "code-1"]);
  });

  it("keeps the link between two model nodes for one record, and its claim", () => {
    const draft = draftOf([modelClaim("m-remaster")], [modelLink("a", "b", "remix", "m-remaster")]);
    draft.genealogy.nodes = draft.genealogy.nodes.map((node) =>
      node.id === "a"
        ? { ...node, label: "Under Pressure - Queen & David Bowie" }
        : node.id === "b"
          ? { ...node, label: "Under Pressure (Remastered 2011) - Queen & David Bowie" }
          : node,
    );
    const merged = withCodeClaims(draft, code);
    // One model node becomes the record's node; the other stays its own.
    expect(merged.genealogy.nodes.map((node) => node.id)).toEqual([
      "current",
      "b",
      `mb-${UNDER_PRESSURE}`,
    ]);
    expect(merged.genealogy.links.map((l) => [l.source, l.target, l.type, l.claimId])).toEqual([
      [`mb-${UNDER_PRESSURE}`, "b", "remix", "m-remaster"],
      [`mb-${UNDER_PRESSURE}`, "current", "sample", "code-1"],
    ]);
    expect(merged.claims.map((claim) => claim.id)).toEqual(["m-remaster", "code-1"]);
  });
});

describe("a model node names a record's node only with the record's whole credit", () => {
  const record = (title: string, artist: string): GenealogyNode => ({
    id: "mb-x",
    group: 4,
    label: `${title} - ${artist}`,
    size: 22,
    trackTitle: title,
    trackArtist: artist,
  });
  const model = (label: string): GenealogyNode => ({ id: "m", group: 4, label, size: 22 });

  it.each([
    ["one artist more", "Intro - The xx & Someone", record("Intro", "The xx")],
    [
      "the generic artist Various Artists",
      "Megamix - Various Artists",
      record("Megamix", "Various Artists"),
    ],
    ["one word of a band's name", "September - Fire", record("September", "Earth, Wind & Fire")],
    [
      "another performance with one artist in common",
      "Under Pressure - David Bowie & Annie Lennox (1992)",
      record("Under Pressure", "Queen & David Bowie"),
    ],
    [
      "a cover by another artist",
      "Ice Ice Baby - Vanilla Ice",
      record("Ice Ice Baby", "Glee Cast"),
    ],
    ["a generic title", "Intro - The xx", record("Intro", "The xx")],
  ])("not on %s", (_what, label, code) => {
    expect(sameRecord(model(label), code)).toBe(false);
  });

  it("on the same title and the same credited artists, in any order", () => {
    const code = record("Under Pressure", "Queen & David Bowie");
    expect(sameRecord(model("Under Pressure - Queen & David Bowie (1981)"), code)).toBe(true);
    expect(sameRecord(model("Under Pressure - David Bowie & Queen"), code)).toBe(true);
    expect(
      sameRecord(
        model("September - Earth, Wind & Fire"),
        record("September", "Earth, Wind & Fire"),
      ),
    ).toBe(true);
  });
});

describe("through the verifier", () => {
  it("keeps code claims sourced without a verdict, and checks their citations", async () => {
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(relations, evidence, counter());
    const draft = withCodeClaims(draftOf([]), code);

    const kept = applyVerdicts(checkClaims(draft, evidence, null, "Ice Ice Baby"), new Map());
    const sample = claimCiting(kept.claims, SAMPLES_ID);
    expect(sample).toMatchObject({ kind: "sourced", verdict: null, numericCheck: "n/a" });
    const link = kept.genealogy.links.find((l) => l.claimId === sample?.id);
    expect(link).toMatchObject({ kind: "sourced", value: 3 });
    // The sampled record is drawn as one.
    expect(kept.genealogy.nodes.find((n) => n.id === `mb-${UNDER_PRESSURE}`)?.group).toBe(2);

    // Without the item it cites, a code claim is not sourced, and neither is its link.
    const without = evidence.filter((item) => item.id !== SAMPLES_ID);
    const lost = applyVerdicts(checkClaims(draft, without, null, "Ice Ice Baby"), new Map());
    const lostClaim = lost.claims.find((claim) => claim.id === sample?.id);
    expect(lostClaim).toMatchObject({ kind: "inferred", evidenceIds: [] });
    expect(lost.genealogy.links.find((l) => l.claimId === sample?.id)?.kind).toBe("inferred");
  });

  it("does not compare a code claim's numbers with the measurement", () => {
    // A release titled with a tempo and a key, against a measured 115.8 BPM in D minor.
    const release: PrimaryRelation = {
      type: "release",
      source: "musicbrainz",
      evidenceId: RELEASE_ID,
      scope: "release",
      release: { mbid: "ae103b0a-b932-4009-acb6-388db1cf890b", title: "140 BPM in C major" },
    };
    const item: Evidence = {
      id: RELEASE_ID,
      source: "musicbrainz",
      sourceTier: "primary-record",
      url: "https://musicbrainz.org/release/ae103b0a-b932-4009-acb6-388db1cf890b",
      title: "140 BPM in C major — MusicBrainz release",
      retrievedAt: AT,
      excerpt: 'MusicBrainz: "Own" by Artist appears on the official album "140 BPM in C major".',
      recordRef: "release/ae103b0a-b932-4009-acb6-388db1cf890b",
    };
    const code = buildCodeClaims([release], [item], counter());
    const checked = checkClaims(withCodeClaims(draftOf([]), code), [item], audioV2(), "Own");
    expect(checked.claims[0]).toMatchObject({ origin: "code", numericCheck: "n/a" });
    expect(checked.claims[0]).not.toHaveProperty("field");
  });
});

describe("the fallback", () => {
  it("carries the code-built claims and links, evidence-backed without any model call", async () => {
    const { evidence, relations } = await readIce();
    const llm = stubLlm((call) => {
      if (call.callSite === "verifier") throw new Error("the judge must not be asked");
      throw new LlmError("rate_limited", "composer: rate_limited");
    });
    const runtime = testRuntime(llm, AT);
    const state = stateFor(null as unknown as ComposedDraft, evidence, {
      relations,
      usage: [],
      audioFeatures: null,
    });
    const config = { writer: () => {}, configurable: { thread_id: "fallback-1" } } as never;

    const composed = await createComposerNode(runtime)(state, config);
    expect(composed.draft?.modelUnavailableReason).toBe("rate_limited");
    const verified = await createVerifierNode(runtime)(
      {
        ...state,
        draft: composed.draft,
        usage: composed.usage ?? [],
      } as SonicAgentStateType,
      config,
    );

    const result = TrackAnalysis.parse(verified.trackData);
    expect(result).toMatchObject({ modelUnavailable: true, run: { fallback: true } });
    expect(llm.calls.map((call) => call.callSite)).toEqual(["composer"]);
    const sample = claimCiting(result.claims ?? [], SAMPLES_ID);
    expect(sample).toMatchObject({ origin: "code", kind: "sourced", verdict: null });
    expect(claimCiting(result.claims ?? [], RELEASE_ID)).toMatchObject({ scope: "release" });
    expect(claimCiting(result.claims ?? [], TRACK_CREDIT(0))).toMatchObject({ scope: "recording" });
    const link = result.genealogy.links.find((l) => l.claimId === sample?.id);
    expect(link).toMatchObject({
      source: `mb-${UNDER_PRESSURE}`,
      target: "current",
      type: "sample",
      kind: "sourced",
      origin: "code",
    });
    expect(analysisIssues(result)).toEqual([]);
    expect(result.claims?.every((claim) => claim.origin === "code")).toBe(true);
  });
});

describe("a song this track covers", () => {
  const coverOfSong = (artist: string | null = null): PrimaryRelation => ({
    type: "relation",
    source: "musicbrainz",
    evidenceId: "musicbrainz:track/recording/jb/cover-of/work/hw",
    scope: "track",
    kind: "cover-of",
    attributes: ["cover", "live"],
    other: { entity: "work", mbid: "hw", title: "Hallelujah", artist },
  });
  const item: Evidence = {
    id: "musicbrainz:track/recording/jb/cover-of/work/hw",
    source: "musicbrainz",
    sourceTier: "primary-record",
    url: "https://musicbrainz.org/recording/jb",
    title: "Hallelujah — MusicBrainz relationships",
    retrievedAt: AT,
    excerpt: 'MusicBrainz: "Hallelujah" by Jeff Buckley is a cover of "Hallelujah".',
    recordRef: "track/recording/jb/cover-of/work/hw",
  };
  const cohen = (draft: ReturnType<typeof draftOf>) => {
    draft.genealogy.nodes = draft.genealogy.nodes.map((node) =>
      node.id === "orig" ? { ...node, label: "Hallelujah - Leonard Cohen (1984)" } : node,
    );
    return draft;
  };

  it("is named as the song, never as this track", () => {
    const code = buildCodeClaims([coverOfSong()], [item], counter());
    expect(code.nodes.map((node) => node.label)).toEqual(["Hallelujah (the song)"]);
    expect(code.nodes[0]).not.toHaveProperty("trackTitle");
    expect(code.links).toMatchObject([{ source: "mb-hw", target: "current", type: "cover" }]);
  });

  it("takes the model's node for the original recording only when the record names its artist", () => {
    const link = {
      source: "orig",
      target: "current",
      value: 1,
      type: "cover" as const,
      kind: "inferred" as const,
      origin: "model" as const,
      claimId: "m-cover",
      evidenceIds: [],
    };
    // The record names no artist for the song: the model's node stays its own.
    const unnamed = withCodeClaims(
      cohen(draftOf([modelClaim("m-cover")], [link])),
      buildCodeClaims([coverOfSong()], [item], counter()),
    );
    expect(unnamed.genealogy.nodes.map((node) => node.id)).toEqual(["current", "orig", "mb-hw"]);
    // It does: the model's node for Leonard Cohen's recording is the song's node.
    const named = withCodeClaims(
      cohen(draftOf([modelClaim("m-cover")], [link])),
      buildCodeClaims([coverOfSong("Leonard Cohen")], [item], counter()),
    );
    expect(named.genealogy.nodes.map((node) => node.label)).toEqual([
      "Ice Ice Baby",
      "Hallelujah (the song by Leonard Cohen)",
    ]);
    expect(named.claims.map((claim) => claim.id)).not.toContain("m-cover");
  });
});

describe("one node for one record", () => {
  it("takes the model's node whose credit is part of the record's, led by the same artist", () => {
    const record: GenealogyNode = {
      id: "mb-up",
      group: 4,
      label: "Under Pressure - Queen & David Bowie",
      size: 22,
      trackTitle: "Under Pressure",
      trackArtist: "Queen & David Bowie",
    };
    const model = (label: string): GenealogyNode => ({ id: "m", group: 4, label, size: 22 });
    expect(sameRecord(model("Under Pressure - Queen (1981)"), record)).toBe(true);
    expect(sameRecord(model("Under Pressure - David Bowie"), record)).toBe(false);
  });

  it("draws two recordings with one title and artist as one node, keeping both claims", () => {
    const twin = (n: number): PrimaryRelation => ({
      ...relation(n, "covered-by", "track"),
      other: { entity: "recording", mbid: `rec-${n}`, title: "Ice Ice Baby", artist: "DJ Twin" },
    });
    const relations = [twin(1), twin(2)];
    const items = relations.map((r) => ({
      ...itemOf(r),
      excerpt: 'MusicBrainz: "Own" by Artist is covered by "Ice Ice Baby" by DJ Twin.',
    }));
    const code = buildCodeClaims(relations, items, counter());
    expect(code.nodes.map((node) => node.id)).toEqual(["mb-rec-1"]);
    expect(code.links).toHaveLength(1);
    expect(code.claims.map((claim) => claim.evidenceIds[0])).toEqual(
      relations.map((r) => r.evidenceId),
    );
  });

  it.each([
    ["Ambassadors", "X Ambassadors"],
    ["Malcolm", "Malcolm X"],
  ])("never takes %s for %s", (model, record) => {
    const code: GenealogyNode = {
      id: "mb-x",
      group: 4,
      label: `Renegades - ${record}`,
      size: 22,
      trackTitle: "Renegades",
      trackArtist: record,
    };
    expect(sameRecord({ id: "m", group: 4, label: `Renegades - ${model}`, size: 22 }, code)).toBe(
      false,
    );
  });

  it("never takes a record credited to MusicBrainz's unknown artist", () => {
    const code: GenealogyNode = {
      id: "mb-x",
      group: 4,
      label: "Song - [unknown]",
      size: 22,
      trackTitle: "Song",
      trackArtist: "[unknown]",
    };
    expect(sameRecord({ id: "m", group: 4, label: "Song - [unknown]", size: 22 }, code)).toBe(
      false,
    );
  });
});

describe("the wording of a partial or medley cover", () => {
  /** The claim code builds for a cover of this recording, from its item's excerpt. */
  const cover = (
    kind: "cover-of" | "covered-by",
    attributes: string[],
    other: { title: string; artist: string | null; entity?: "recording" | "work" },
    excerpt: string,
  ) => {
    const relationOf: PrimaryRelation = {
      type: "relation",
      source: "musicbrainz",
      evidenceId: "musicbrainz:track/recording/own/x",
      scope: "track",
      kind,
      attributes,
      other: {
        entity: other.entity ?? "recording",
        mbid: "x",
        title: other.title,
        artist: other.artist,
      },
    };
    const item: Evidence = {
      ...itemOf(relation(1, kind, "track")),
      id: relationOf.evidenceId,
      excerpt,
    };
    return buildCodeClaims([relationOf], [item], counter()).claims.map((claim) => claim.text);
  };

  it("splits on the record named at the end, whatever the title before it says", () => {
    expect(
      cover(
        "cover-of",
        ["cover", "partial"],
        { title: "Hallelujah", artist: null, entity: "work" },
        'MusicBrainz: "this is a cover of hallelujah lol" by kid is a cover of "Hallelujah".',
      ),
    ).toEqual(['"this is a cover of hallelujah lol" by kid partly covers "Hallelujah".']);
    expect(
      cover(
        "covered-by",
        ["cover", "partial"],
        { title: "Snow", artist: "Band" },
        'MusicBrainz: the work "Snow is covered by Rain" is covered by "Snow" by Band.',
      ),
    ).toEqual(['"Snow" by Band partly covers the work "Snow is covered by Rain".']);
  });

  it("says part of only when MusicBrainz marks the cover partial", () => {
    const excerpt = 'MusicBrainz: the work "Song" is covered by "Mix" by Band.';
    expect(
      cover("covered-by", ["cover", "medley"], { title: "Mix", artist: "Band" }, excerpt),
    ).toEqual(['"Mix" by Band covers the work "Song" in a medley.']);
    expect(
      cover(
        "covered-by",
        ["cover", "medley", "partial"],
        { title: "Mix", artist: "Band" },
        excerpt,
      ),
    ).toEqual(['"Mix" by Band covers part of the work "Song" in a medley.']);
  });
});

describe("record text in claims", () => {
  it("writes a Discogs name with a dollar sign as it is", () => {
    const money: PrimaryRelation = {
      type: "credit",
      source: "discogs",
      evidenceId: TRACK_CREDIT(0),
      scope: "track",
      name: "Ca$$h Money (2)",
      artistId: 9,
      roles: ["Producer"],
    };
    const item: Evidence = {
      id: TRACK_CREDIT(0),
      source: "discogs",
      sourceTier: "primary-record",
      url: "https://www.discogs.com/release/599648",
      title: "To the Extreme — Discogs release 599648",
      retrievedAt: AT,
      excerpt:
        'Discogs release 599648 ("To the Extreme", 1990) credits Ca$$h Money (2) as Producer on track 1 "Ice Ice Baby".',
      recordRef: "track/release/599648/credit/0",
    };
    expect(buildCodeClaims([money], [item], counter()).claims[0].text).toBe(
      'Discogs release 599648 ("To the Extreme", 1990) credits Ca$$h Money as Producer on track 1 "Ice Ice Baby".',
    );
  });

  it("masks a handle in a code claim as in the node made from the same record", async () => {
    const handle: PrimaryRelation = {
      ...relation(1, "remixed-by", "track"),
      other: {
        entity: "recording",
        mbid: "rec-1",
        title: "Song (@djhandle remix)",
        artist: "Band",
      },
    };
    const item = {
      ...itemOf(relation(1, "remixed-by", "track")),
      excerpt: 'MusicBrainz: "Own" by Artist is remixed in "Song (@djhandle remix)" by Band.',
    };
    const runtime = testRuntime(
      stubLlm(() => {
        throw new LlmError("rate_limited", "composer: rate_limited");
      }),
      AT,
    );
    const state = stateFor(null as unknown as ComposedDraft, [item], {
      relations: [handle],
      usage: [],
      audioFeatures: null,
    });
    const config = { writer: () => {}, configurable: { thread_id: "handle-1" } } as never;
    const composed = await createComposerNode(runtime)(state, config);
    const verified = await createVerifierNode(runtime)(
      { ...state, draft: composed.draft, usage: composed.usage ?? [] } as SonicAgentStateType,
      config,
    );
    const result = TrackAnalysis.parse(verified.trackData);
    const node = result.genealogy.nodes.find((n) => n.id === "mb-rec-1");
    const claim = result.claims?.find((c) => c.origin === "code");
    expect(node?.label).not.toContain("@djhandle");
    expect(claim?.text).not.toContain("@djhandle");
    expect(claim).toMatchObject({ kind: "sourced" });
  });
});

describe("cover art for the nodes made from records", () => {
  it("is looked up for the first 2 of each kind only", async () => {
    const relations = Array.from({ length: 4 }, (_, i) => relation(i, "sampled-by", "track"));
    const evidence = relations.map(itemOf);
    const llm = stubLlm(() => {
      throw new LlmError("rate_limited", "composer: rate_limited");
    });
    const runtime = testRuntime(llm, AT);
    const state = stateFor(null as unknown as ComposedDraft, evidence, {
      relations,
      usage: [],
      audioFeatures: null,
    });
    const config = { writer: () => {}, configurable: { thread_id: "artwork-1" } } as never;
    const composed = await createComposerNode(runtime)(state, config);
    await createVerifierNode(runtime)(
      { ...state, draft: composed.draft, usage: composed.usage ?? [] } as SonicAgentStateType,
      config,
    );
    expect(artwork.given).toEqual(["current", "mb-rec-0", "mb-rec-1"]);
  });
});

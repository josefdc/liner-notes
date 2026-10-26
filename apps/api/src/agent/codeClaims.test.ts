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

vi.mock(
  "./enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
        complete: true,
      }),
    }) satisfies Partial<typeof import("./enricher.js")>,
);
// The verifier's long-term store, outside a graph: none (the fallback is never stored).
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getStore: () => undefined,
}));

import { LlmError } from "../llm/errors.js";
import { collectPrimarySources, type IdentifiedRecording } from "../sources/identity.js";
import { MusicBrainzRateLimiter } from "../sources/musicbrainz.js";
import { json, stubFetch } from "../sources/testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "../sources/testing/iceIceBaby.js";
import {
  buildCodeClaims,
  CODE_LINKS_PER_TYPE,
  type CodeBuilt,
  curatedRelations,
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
import type { GenealogyLink } from "./schema.js";
import type { ComposedDraft, SonicAgentStateType } from "./state.js";
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

  it("states a cover of the song as a claim about the work, the cover the later record", async () => {
    const { evidence, relations } = await readIce();
    const code = buildCodeClaims(relations, evidence, counter());
    const claim = claimCiting(code.claims, COVER_ID);
    expect(claim).toMatchObject({
      text: 'The work "Ice Ice Baby" is covered by "Ice Ice Baby" by Faith No More.',
      about: "cover",
      scope: "work",
      origin: "code",
      kind: "sourced",
    });
    expect(code.links.find((l) => l.claimId === claim?.id)).toMatchObject({
      source: "current",
      target: `mb-${FAITH_NO_MORE}`,
      type: "cover",
    });
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

  it(`draws at most ${CODE_LINKS_PER_TYPE} links of a type, the recording's own relations first`, () => {
    const cover = (n: number, scope: "track" | "work"): PrimaryRelation => ({
      type: "relation",
      source: "musicbrainz",
      evidenceId: `musicbrainz:${scope}/x/covered-by/recording/${n}`,
      scope,
      kind: "covered-by",
      other: { entity: "recording", mbid: `rec-${n}`, title: "Ice Ice Baby", artist: `Band ${n}` },
    });
    const relations = [
      ...Array.from({ length: 12 }, (_, i) => cover(i, "work")),
      cover(20, "track"),
      // The same record again under another kind of the same type: one link.
      { ...cover(20, "track"), evidenceId: "musicbrainz:dup", kind: "cover-of" as const },
    ];
    const kept = curatedRelations(relations);
    expect(kept.map((r) => r.other.mbid)).toEqual([
      "rec-20",
      "rec-0",
      "rec-1",
      "rec-2",
      "rec-3",
      "rec-4",
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

  it("folds into the code link, which keeps its own claim", () => {
    const draft = draftOf(
      [modelClaim("m-sample"), modelClaim("m-influence"), modelClaim("m-other")],
      [
        // The model's sample, written the other way round, on its own node for the record.
        modelLink("current", "up", "sample", "m-sample"),
        modelLink("up", "current", "influence", "m-influence"),
        modelLink(`mb-${UNDER_PRESSURE}`, "current", "influence", "m-other"),
      ],
      { nodeYears: { up: "1981", [`mb-${UNDER_PRESSURE}`]: "1990" } },
    );
    draft.genealogy.nodes = draft.genealogy.nodes.map((node) =>
      node.id === "up"
        ? { ...node, label: "Under Pressure - Queen (1981)", trackTitle: "Under Pressure" }
        : node,
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

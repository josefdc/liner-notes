/**
 * One claim per fact, in the verifier's result: a model claim restating a code-built claim on the
 * same record is left out and the code claim stays; of two model claims with one text, the one
 * whose scope fits its evidence, then the better verdict, stays; a claim that adds information
 * (other evidence, another relation, a partial verdict) stays; what is left out is counted in
 * `run.verifier.restated` and shown nowhere, its fact card included.
 */

import type { Claim, Evidence } from "@liner-notes/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn() }));
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getStore: () => store,
}));
vi.mock(
  "../enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
        complete: true,
      }),
    }) satisfies Partial<typeof import("../enricher.js")>,
);

import type { Factoid, TrackData } from "../schema.js";
import { testRuntime } from "../testing/stubLlm.js";
import { createVerifierNode } from "./index.js";
import { draftOf, judging, modelClaim, stateFor, trackRecord } from "./testing.js";

const config = { writer: () => {}, configurable: { thread_id: "run-1" } } as never;

/** A MusicBrainz record of a sample of this recording. */
const sampleRecord: Evidence = {
  ...trackRecord("ev-sample"),
  recordRef: "track/recording/r1/samples/recording/r2",
  excerpt:
    'MusicBrainz: "Ice Ice Baby" by Vanilla Ice samples "Under Pressure" by Queen & David Bowie.',
};
/** The MusicBrainz release this recording appears on. */
const releaseRecord: Evidence = {
  ...trackRecord("ev-release"),
  recordRef: "release/r9",
  excerpt:
    'MusicBrainz: "Ice Ice Baby" by Vanilla Ice appears on the official album "To the Extreme".',
};
/** A web page about the sample. */
const webPage: Evidence = {
  ...trackRecord("ev-web"),
  source: "tavily",
  sourceTier: "web",
  recordRef: null,
  url: "https://example.org/ice",
  excerpt: "The bass line was taken from Under Pressure and played a beat later.",
};
const evidence = [sampleRecord, releaseRecord, webPage];

/** A code-built claim, as codeClaims.ts builds it from `item`. */
function codeClaim(
  id: string,
  item: Evidence,
  about: Claim["about"],
  scope: Claim["scope"],
): Claim {
  return {
    id,
    text: item.excerpt.replace(/^MusicBrainz:\s+/, ""),
    about,
    kind: "sourced",
    origin: "code",
    evidenceIds: [item.id],
    verdict: null,
    verdictReason: null,
    numericCheck: "n/a",
    scope,
  };
}
const codeSample = codeClaim("code-sample", sampleRecord, "sample", "recording");
const codeRelease = codeClaim("code-release", releaseRecord, "track", "release");

/** The card a model claim is shown on. */
const cardOf = (claim: Claim): Factoid => ({
  id: `card-${claim.id}`,
  title: "Card",
  content: claim.text,
  type: "trivia",
  claimId: claim.id,
});

/**
 * The verifier's result for `claims` (and `cards`), the judge answering `verdicts` by statement
 * text (the judge is sent each claim by its place in the batch), else "supported".
 */
async function verified(
  claims: Claim[],
  verdicts: Record<string, "supported" | "partial" | "unsupported" | "contradicted">,
  cards: Factoid[] = [],
): Promise<TrackData> {
  const llm = judging((sent) =>
    sent.map(({ claimId, text }) => ({
      claimId,
      verdict: verdicts[text] ?? "supported",
      reason: "The record says so.",
    })),
  );
  const out = await createVerifierNode(testRuntime(llm))(
    stateFor(draftOf(claims, [], { factoids: cards }), evidence),
    config,
  );
  if (!out.trackData) throw new Error(`no result: ${out.error}`);
  return out.trackData;
}
const idsOf = (data: TrackData) => (data.claims ?? []).map((claim) => claim.id);

describe("a model claim that restates a code-built claim", () => {
  beforeEach(() => {
    store.put.mockReset();
  });

  it("is left out, with its card; the code claim stays as built, and the count is recorded", async () => {
    const restated = modelClaim("m-sample", {
      text: "Vanilla Ice's track samples Queen and David Bowie's Under Pressure.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const carded = modelClaim("m-card", {
      text: "MusicBrainz lists Under Pressure as sampled in Ice Ice Baby.",
      about: "connection",
      evidenceIds: ["ev-sample"],
    });
    const data = await verified([restated, carded, codeSample], {}, [cardOf(carded)]);

    expect(idsOf(data)).toEqual(["code-sample"]);
    expect(data.claims?.[0]).toEqual(codeSample);
    expect(data.factoids).toEqual([]);
    expect(data.run?.verifier).toEqual({ judged: 2, unjudged: 0, restated: 2 });
  });

  it("stays when it adds information: other evidence, another relation, a partial verdict", async () => {
    const moreEvidence = modelClaim("m-more", {
      text: "Vanilla Ice's track samples Under Pressure, a beat later.",
      about: "sample",
      evidenceIds: ["ev-sample", "ev-web"],
    });
    const otherEvidence = modelClaim("m-other", {
      text: "Vanilla Ice's track samples Under Pressure.",
      about: "sample",
      evidenceIds: ["ev-web"],
    });
    const otherRelation = modelClaim("m-cover", {
      text: "Ice Ice Baby covers Under Pressure.",
      about: "cover",
      evidenceIds: ["ev-sample"],
    });
    const partly = modelClaim("m-partial", {
      text: "Ice Ice Baby samples Under Pressure's bass line, played a beat later.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const otherScope = modelClaim("m-scope", {
      text: "Ice Ice Baby appears on To the Extreme.",
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const claims = [moreEvidence, otherEvidence, otherRelation, partly, otherScope, codeSample];
    const data = await verified(claims, { [partly.text]: "partial" });

    // The release claim cites no item a code claim cites: no code claim states the release here.
    expect(idsOf(data)).toEqual(claims.map((claim) => claim.id));
    expect(data.run?.verifier).toEqual({ judged: 5, unjudged: 0 });
    // Each keeps its own verdict.
    expect(data.claims?.find((claim) => claim.id === "m-partial")?.verdict).toBe("partial");
  });

  it("is left out when its text is the code claim's, whatever the judge said", async () => {
    const copied = modelClaim("m-copy", {
      text: `“${codeSample.text.replaceAll('"', "")}”`,
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const data = await verified([copied, codeSample], { [copied.text]: "unsupported" });
    expect(idsOf(data)).toEqual(["code-sample"]);
    expect(data.run?.verifier).toMatchObject({ restated: 1 });
  });

  it("stays when a measured value is compared with it", async () => {
    // One points at the tempo itself; the other states a tempo the check compares.
    const field = modelClaim("m-field", {
      text: "Ice Ice Baby samples Under Pressure.",
      about: "sample",
      field: "tempo",
      evidenceIds: ["ev-sample"],
    });
    const tempo = modelClaim("m-tempo", {
      text: "Vanilla Ice's anthem pulses at 232 BPM.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const data = await verified([field, tempo, codeSample], {});
    expect(idsOf(data)).toEqual(["m-field", "m-tempo", "code-sample"]);
    expect(data.claims?.[1]?.numericCheck).toBe("conflict");
  });
});

describe("two model claims with the same text", () => {
  it("keep the one whose scope fits its evidence, under different subjects; its card goes", async () => {
    const text = "“Ice Ice Baby” appears on Vanilla Ice’s album To the Extreme.";
    const track = modelClaim("m-track", {
      text,
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    // About a credit of this recording, citing a whole release: the item does not fit its scope.
    const credit = modelClaim("m-credit", {
      text: text.replaceAll("’", "'"),
      about: "credit",
      scope: "recording",
      evidenceIds: ["ev-release"],
    });
    const data = await verified([credit, track], {}, [cardOf(credit)]);
    expect(idsOf(data)).toEqual(["m-track"]);
    expect(data.factoids).toEqual([]);
    expect(data.run?.verifier).toEqual({ judged: 1, unjudged: 0, restated: 1 });
  });

  it("keep the better verdict when both fit, and keep its own verdict", async () => {
    const text = "Ice Ice Baby appears on To the Extreme.";
    const partly = modelClaim("m-partly", {
      text: "Ice Ice Baby appears on “To the Extreme”.",
      about: "credit",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const whole = modelClaim("m-whole", {
      text,
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const data = await verified([partly, whole], { [partly.text]: "partial" });
    expect(idsOf(data)).toEqual(["m-whole"]);
    expect(data.claims?.[0]).toMatchObject({ verdict: "supported", kind: "sourced" });
  });

  it("both stay when the other one cites more", async () => {
    const text = "Ice Ice Baby samples Under Pressure.";
    const one = modelClaim("m-one", { text, about: "sample", evidenceIds: ["ev-web"] });
    const two = modelClaim("m-two", {
      text,
      about: "connection",
      evidenceIds: ["ev-web", "ev-sample"],
    });
    const data = await verified([one, two], {});
    expect(idsOf(data)).toEqual(["m-one", "m-two"]);
  });

  it("both go when they restate a code-built claim: the release is stated once, by its record", async () => {
    const text = "“Ice Ice Baby” appears on Vanilla Ice’s album To the Extreme.";
    const track = modelClaim("m-track", {
      text,
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const credit = modelClaim("m-credit", {
      text,
      about: "credit",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const data = await verified([track, credit, codeRelease], {}, [cardOf(credit)]);
    expect(idsOf(data)).toEqual(["code-release"]);
    expect(data.claims?.[0]).toEqual(codeRelease);
    expect(data.factoids).toEqual([]);
    expect(data.run?.verifier).toEqual({ judged: 2, unjudged: 0, restated: 2 });
  });
});

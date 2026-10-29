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

import type { Factoid, GenealogyLink, TrackData } from "../schema.js";
import type { ComposedDraft } from "../state.js";
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
/** What a link joins, how, and whose it is: the verifier sets its weight and kind. */
const ends = ({ source, target, type, origin, claimId }: GenealogyLink) => ({
  source,
  target,
  type,
  origin,
  claimId,
});

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
    // Counted even when nothing is left out: a reader knows the step ran.
    expect(data.run?.verifier).toEqual({ judged: 5, unjudged: 0, restated: 0 });
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
  it("keep the one whose scope fits its evidence, when the other is left citing nothing; its card goes", async () => {
    const text = "Ice Ice Baby takes its bass line from Under Pressure.";
    // About the song, citing a record of this recording: the item does not fit its scope.
    const work = modelClaim("m-work", {
      text: text.replace("Under Pressure", "“Under Pressure”"),
      about: "sample",
      scope: "work",
      evidenceIds: ["ev-sample"],
    });
    // Partly supported: a sample is stated whole, so both read as inferred.
    const recording = modelClaim("m-recording", {
      text,
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const data = await verified([work, recording], { [text]: "partial" }, [cardOf(work)]);
    expect(idsOf(data)).toEqual(["m-recording"]);
    expect(data.claims?.[0]).toMatchObject({ verdict: "partial", kind: "inferred" });
    expect(data.factoids).toEqual([]);
    expect(data.run?.verifier).toEqual({ judged: 1, unjudged: 0, restated: 1 });
  });

  it("are compared as the result shows them, their handles masked", async () => {
    const one = modelClaim("m-one", {
      text: "A remix by @djone is on SoundCloud.",
      about: "trivia",
    });
    const two = modelClaim("m-two", {
      text: "A remix by @djtwo is on SoundCloud.",
      about: "trivia",
    });
    const data = await verified([one, two], {});
    expect(data.claims?.map((claim) => claim.text)).toEqual(["A remix by @… is on SoundCloud."]);
    expect(data.run?.verifier).toMatchObject({ restated: 1 });
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

describe("a claim that a link or a timeline sample states", () => {
  it("stays when a timeline sample states it; one only a model link states goes with that link", async () => {
    const linked = modelClaim("m-link", {
      text: "Ice Ice Baby samples Under Pressure.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const timed = modelClaim("m-timed", {
      text: "Vanilla Ice samples Under Pressure by Queen.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const link: GenealogyLink = {
      source: "up",
      target: "current",
      value: 1,
      type: "sample",
      kind: "inferred",
      origin: "model",
      claimId: "m-link",
      evidenceIds: ["ev-sample"],
    };
    // The code-built link the map draws for the record.
    const coded: GenealogyLink = {
      source: "mb-r2",
      target: "current",
      value: 1,
      type: "sample",
      kind: "sourced",
      origin: "code",
      claimId: "code-sample",
      evidenceIds: ["ev-sample"],
    };
    const draft = draftOf([linked, timed, codeSample], [link, coded], {
      // A timeline sample that names its claim, as the contract's Sample can.
      samples: [
        { time: 12, description: "The bass line", claimId: "m-timed" },
      ] as unknown as ComposedDraft["samples"],
    });
    const llm = judging((sent) =>
      sent.map(({ claimId }) => ({ claimId, verdict: "supported", reason: "It says so." })),
    );
    const out = await createVerifierNode(testRuntime(llm))(stateFor(draft, evidence), config);
    expect(idsOf(out.trackData!)).toEqual(["m-timed", "code-sample"]);
    expect(out.trackData?.run?.verifier).toMatchObject({ judged: 2, restated: 1 });
    // The model's link, and the node only it drew, go with its claim.
    expect(out.trackData?.genealogy.links.map(ends)).toEqual([ends(coded)]);
    expect(out.trackData?.genealogy.nodes.map((node) => node.id)).toEqual(["current", "mb-r2"]);
  });

  it("stays with a model link when no code-built link draws its relation, or the link reads another way", async () => {
    const linked = modelClaim("m-link", {
      text: "Ice Ice Baby samples Under Pressure.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const link: GenealogyLink = {
      source: "up",
      target: "current",
      value: 1,
      type: "sample",
      kind: "inferred",
      origin: "model",
      claimId: "m-link",
      evidenceIds: ["ev-sample"],
    };
    const coded: GenealogyLink = {
      ...link,
      source: "mb-r2",
      kind: "sourced",
      origin: "code",
      claimId: "code-sample",
    };
    const llm = judging((sent) =>
      sent.map(({ claimId }) => ({ claimId, verdict: "supported", reason: "It says so." })),
    );
    const run = async (links: GenealogyLink[]) => {
      const draft = draftOf([linked, codeSample], links);
      const out = await createVerifierNode(testRuntime(llm))(stateFor(draft, evidence), config);
      return out.trackData!;
    };
    // No code link: the model's link is the map's only line for the sample, and it stays.
    const alone = await run([link]);
    expect(idsOf(alone)).toEqual(["m-link", "code-sample"]);
    expect(alone.genealogy.links.map(ends)).toEqual([ends(link)]);
    // A link that reads the other way (this track sampled by Under Pressure), or as a cover,
    // states another relation than the record's.
    for (const other of [
      { ...link, source: "current", target: "up" },
      { ...link, type: "cover" as const },
    ]) {
      const out = await run([other, coded]);
      expect(idsOf(out)).toEqual(["m-link", "code-sample"]);
      expect(out.genealogy.links.map(ends)).toEqual([other, coded].map(ends));
    }
  });
});

describe("a partly supported model claim that restates a code-built relation", () => {
  /** A cover of the song, documented on its MusicBrainz work page (no node of its own). */
  const coverRecord: Evidence = {
    ...trackRecord("ev-cover"),
    recordRef: "work/w1/covered-by/recording/r5",
    excerpt: 'MusicBrainz: the work "Ice Ice Baby" is covered by "Ice Ice Baby" by Ice Band.',
  };
  const codeCover = codeClaim("code-cover", coverRecord, "cover", "work");

  it("goes with the model's link and node, naming the analysed track's artist", async () => {
    // "Vanilla Ice" is not in the record: it is the analysed track's artist.
    const cover = modelClaim("m-cover", {
      text: '"Ice Ice Baby - Ice Band" is a cover of "Ice Ice Baby - Vanilla Ice".',
      about: "cover",
      scope: "work",
      evidenceIds: ["ev-cover"],
    });
    const link: GenealogyLink = {
      source: "current",
      target: "ice-band",
      value: 1,
      type: "cover",
      kind: "inferred",
      origin: "model",
      claimId: "m-cover",
      evidenceIds: ["ev-cover"],
    };
    const llm = judging((sent) =>
      sent.map(({ claimId }) => ({ claimId, verdict: "partial", reason: "In part." })),
    );
    const out = await createVerifierNode(testRuntime(llm))(
      stateFor(draftOf([cover, codeCover], [link]), [...evidence, coverRecord]),
      config,
    );
    const data = out.trackData!;
    expect(idsOf(data)).toEqual(["code-cover"]);
    expect(data.claims?.[0]).toEqual(codeCover);
    expect(data.genealogy.links).toEqual([]);
    expect(data.genealogy.nodes.map((node) => node.id)).toEqual(["current"]);
    expect(data.run?.verifier).toEqual({ judged: 1, unjudged: 0, restated: 1 });
  });
});

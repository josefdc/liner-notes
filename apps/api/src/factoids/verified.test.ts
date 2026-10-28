/**
 * "More facts" as verified claims: each new fact is a model claim, checked against the evidence
 * of the analysis run the request names, judged once, and never measured. The model layer is a
 * fake (factoids/testing/fakes.ts): it writes one card per focus and judges what it is sent.
 */

import { type Claim, FactoidsResponse, type Verdict } from "@liner-notes/contract";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenealogyLink } from "../agent/schema.js";
import { stubLlm } from "../agent/testing/stubLlm.js";
import { applyVerdicts, checkClaims } from "../agent/verifier/index.js";
import { draftOf, modelClaim } from "../agent/verifier/testing.js";
import { createTestApp, withRunToken } from "../http/testApp.js";
import { createFactoidsRouter } from "../http/routes/factoids.js";
import { LlmError } from "../llm/errors.js";
import { FACTOID_PACK_MAX } from "./prompt.js";
import { writeFactoids } from "./service.js";
import {
  card,
  DEMO_TRACK,
  demoRecord,
  evidenceItem,
  type FakeModel,
  fakeModel,
  isJudge,
  RUN_ID,
  statementsOf,
  storedRun,
} from "./testing/fakes.js";

const PACK = [
  evidenceItem("ev-1", "Recorded with a Roland Juno-106 at the band's home studio."),
  evidenceItem("ev-2", "Mixed at Studio Plus XXX in Paris."),
];

/** Supported by ev-1; written without evidence; citing ev-2, which does not support it. */
const SOURCED = "The synth line was played on a Roland Juno-106 at home.";
const UNCITED = "The vocal was recorded in a single afternoon session.";
const UNSUPPORTED = "The drums were sampled from a disco record bought in Chicago.";

const cards = () => [card(SOURCED, ["ev-1"]), card(UNCITED), card(UNSUPPORTED, ["ev-2"])];
const judgeByText = (text: string) => (text === SOURCED ? "supported" : "unsupported");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function moreFacts(
  model: FakeModel,
  body: Record<string, unknown> = { runId: RUN_ID },
  pack = PACK,
) {
  const llm = fakeModel(model);
  const app = createTestApp(
    createFactoidsRouter({ llm, loadRun: (id) => (id === RUN_ID ? storedRun(pack) : null) }),
  );
  const res = await request(app)
    .post(withRunToken("/api/factoids/more"))
    .send({ ...DEMO_TRACK, existingFactoidIds: ["f1"], ...body })
    .timeout(5000);
  const claims: Claim[] = res.body.claims ?? [];
  const claimOf = (text: string) => claims.find((claim) => claim.text === text);
  return { res, llm, claims, claimOf };
}

describe("more facts as verified claims", () => {
  it("gives every fact a claimId that names one of the returned claims", async () => {
    const { res, claims } = await moreFacts({ cards: cards(), judge: judgeByText });

    expect(res.status).toBe(200);
    expect(FactoidsResponse.safeParse(res.body).success).toBe(true);
    expect(res.body.factoids).toHaveLength(3);
    expect(claims).toHaveLength(3);
    for (const factoid of res.body.factoids) {
      const claim = claims.find((each) => each.id === factoid.claimId);
      expect(claim).toBeDefined();
      expect(claim).toMatchObject({
        text: factoid.content,
        origin: "model",
        factoid: { title: factoid.title, type: factoid.type },
      });
    }
  });

  it("reads an uncited or an unsupported fact as inferred", async () => {
    const { claimOf } = await moreFacts({ cards: cards(), judge: judgeByText });

    expect(claimOf(UNCITED)).toMatchObject({ kind: "inferred", verdict: null, evidenceIds: [] });
    expect(claimOf(UNSUPPORTED)).toMatchObject({
      kind: "inferred",
      verdict: "unsupported",
      evidenceIds: ["ev-2"],
    });
  });

  it("reads a fact the judge supports with a citation as sourced", async () => {
    const { claimOf, llm } = await moreFacts({ cards: cards(), judge: judgeByText });

    expect(claimOf(SOURCED)).toMatchObject({
      kind: "sourced",
      verdict: "supported",
      evidenceIds: ["ev-1"],
    });
    // One judge call, sent the cited facts in focus order.
    const judged = llm.calls.filter((call) => isJudge(call));
    expect(judged).toHaveLength(1);
    expect(judged[0].tier).toBe("judge");
    // Logged apart from an analysis's judge.
    expect(judged[0].callSite).toBe("factoids-judge");
    expect(statementsOf(judged[0]).map((statement) => statement.text)).toEqual([
      SOURCED,
      UNSUPPORTED,
    ]);
  });

  it("keeps every fact, with no verdict and read as inferred, when the judge fails", async () => {
    const { res, claims } = await moreFacts({
      cards: cards(),
      judge: new LlmError("budget_exceeded", "verifier: the daily cap is reached"),
    });

    expect(res.status).toBe(200);
    expect(res.body.factoids).toHaveLength(3);
    for (const claim of claims) {
      expect(claim).toMatchObject({ kind: "inferred", verdict: null });
    }
    // The facts that cite evidence say they were not checked.
    const cited = claims.filter((claim) => claim.evidenceIds.length > 0);
    expect(cited).toHaveLength(2);
    for (const claim of cited) expect(claim.verdictReason).toMatch(/not checked/i);
  });

  it("drops a cited id that is not in the run's evidence pack", async () => {
    const { claimOf } = await moreFacts({
      cards: [card(SOURCED, ["ev-1", "ev-invented"]), null, card(UNCITED, ["ev-invented"])],
      judge: () => "supported",
    });

    expect(claimOf(SOURCED)?.evidenceIds).toEqual(["ev-1"]);
    expect(claimOf(UNCITED)).toMatchObject({ kind: "inferred", evidenceIds: [] });
  });

  it("never reads a fact as measured, whatever the judge says", async () => {
    for (const judge of [() => "supported" as const, judgeByText, new LlmError("timeout", "x")]) {
      const { claims } = await moreFacts({ cards: cards(), judge });
      expect(claims).toHaveLength(3);
      expect(claims.map((claim) => claim.kind)).not.toContain("measured");
    }
  });

  it("reads every fact as inferred without a run id, and asks no judge", async () => {
    const { res, claims, llm } = await moreFacts(
      { cards: cards(), judge: () => "supported" },
      { runId: undefined },
    );

    expect(res.body.factoids).toHaveLength(3);
    expect(claims.map((claim) => claim.kind)).toEqual(["inferred", "inferred", "inferred"]);
    expect(claims.every((claim) => claim.evidenceIds.length === 0)).toBe(true);
    expect(llm.calls.some((call) => isJudge(call))).toBe(false);
  });

  it("drops a citation of an item the prompt did not show (past the pack's size)", async () => {
    // Ten items of about 1,000 characters: the prompt shows only the first ones.
    const big = Array.from({ length: 10 }, (_, i) =>
      evidenceItem(`ev-big-${i}`, `${"Session notes. ".repeat(66)}(${i})`),
    );
    const { claimOf, llm } = await moreFacts(
      { cards: [card(SOURCED, ["ev-big-0", "ev-big-9"]), card(UNCITED, ["ev-big-9"]), null] },
      { runId: RUN_ID },
      big,
    );

    const factoidPrompt = llm.calls.find((call) => call.callSite === "factoids");
    const user = JSON.stringify(factoidPrompt?.input);
    expect(user).toContain("ev-big-0");
    expect(user).not.toContain("ev-big-9");
    expect(big.reduce((size, item) => size + item.excerpt.length, 0)).toBeGreaterThan(
      FACTOID_PACK_MAX,
    );
    expect(claimOf(SOURCED)?.evidenceIds).toEqual(["ev-big-0"]);
    expect(claimOf(UNCITED)).toMatchObject({ kind: "inferred", verdict: null, evidenceIds: [] });
  });

  it("uses no run context for a run of a song with the same title by another artist", async () => {
    const { res, claims, llm } = await moreFacts(
      { cards: cards(), judge: () => "supported" },
      { runId: RUN_ID, trackId: "local-track-1", trackArtist: "A Different Artist" },
    );

    expect(res.body.factoids).toHaveLength(3);
    for (const claim of claims) {
      expect(claim).toMatchObject({ kind: "inferred", verdict: null, evidenceIds: [] });
    }
    expect(llm.calls.some((call) => isJudge(call))).toBe(false);
    // The prompt showed no evidence of the other song.
    expect(JSON.stringify(llm.calls[0].input)).not.toContain("ev-1");
  });

  it("asks no judge when the client leaves once the facts are written", async () => {
    const client = new AbortController();
    let written = 0;
    const llm = stubLlm((call) => {
      if (isJudge(call)) return { verdicts: [] };
      // The client leaves as the last fact comes back.
      if (++written === 3) client.abort();
      return { factoids: [card(`${SOURCED} (${written})`, ["ev-1"])] };
    });

    await expect(
      writeFactoids(
        {
          track: { title: DEMO_TRACK.trackTitle, artist: DEMO_TRACK.trackArtist },
          runId: RUN_ID,
          existingIds: [],
        },
        { llm, purpose: "dev", signal: client.signal, loadRun: () => storedRun(PACK) },
      ),
    ).rejects.toBeDefined();
    expect(llm.calls.map((call) => call.callSite)).toEqual(["factoids", "factoids", "factoids"]);
  });
});

describe("a new fact that restates a code-built claim of the run", () => {
  /** The run's code-built claim on ev-1, as codeClaims.ts builds one from its record. */
  const built: Claim = {
    id: "code-1",
    text: PACK[0].excerpt,
    about: "production",
    kind: "sourced",
    origin: "code",
    evidenceIds: ["ev-1"],
    verdict: null,
    verdictReason: null,
    numericCheck: "n/a",
    scope: "recording",
  };

  it("is not sent: the run already states it, on the same record", async () => {
    const llm = fakeModel({ cards: cards(), judge: judgeByText });
    const app = createTestApp(
      createFactoidsRouter({
        llm,
        loadRun: (id) => (id === RUN_ID ? storedRun(PACK, [], [built]) : null),
      }),
    );
    const res = await request(app)
      .post(withRunToken("/api/factoids/more"))
      .send({ ...DEMO_TRACK, existingFactoidIds: ["f1"], runId: RUN_ID })
      .timeout(5000);

    expect(res.status).toBe(200);
    const texts = res.body.factoids.map((factoid: { content: string }) => factoid.content);
    expect(texts).toEqual([UNCITED, UNSUPPORTED]);
    expect(res.body.claims.map((claim: Claim) => claim.text)).toEqual([UNCITED, UNSUPPORTED]);
    // The judge still checked it: a restatement is known only once it is judged.
    expect(llm.calls.filter(isJudge)).toHaveLength(1);
  });

  it("is sent when it says more than the record: another name, another number", async () => {
    const more = "The synth line was played on a Roland Juno-106 at home by Thomas Bangalter.";
    const llm = fakeModel({
      cards: [card(more, ["ev-1"]), null, null],
      judge: () => "supported",
    });
    const app = createTestApp(
      createFactoidsRouter({
        llm,
        loadRun: (id) => (id === RUN_ID ? storedRun(PACK, [], [built]) : null),
      }),
    );
    const res = await request(app)
      .post(withRunToken("/api/factoids/more"))
      .send({ ...DEMO_TRACK, existingFactoidIds: ["f1"], runId: RUN_ID })
      .timeout(5000);
    expect(res.body.factoids.map((factoid: { content: string }) => factoid.content)).toEqual([
      more,
    ]);
  });
});

describe("a relation from more facts is stated whole, as the analysis states it", () => {
  const SAMPLE = "The hook samples a 1979 disco record from Chicago.";
  const sampleCard = (text: string, evidenceIds: string[]) => ({
    ...card(text, evidenceIds),
    type: "sample" as const,
  });

  /**
   * The kind and verdict the analysis gives a model claim about `about` citing ev-1 that the judge
   * found `verdict`: a fact card's claim, or, with `linked`, the claim a sample link states.
   */
  function fromAnalysis(verdict: Verdict, about: "sample" | "production", linked = false) {
    const claim = modelClaim("cl-a", {
      text: about === "sample" ? SAMPLE : SOURCED,
      about,
      evidenceIds: ["ev-1"],
      ...(linked ? {} : { factoid: { title: "A card", type: about, entities: [] } }),
    });
    const link = {
      source: "up",
      target: "current",
      value: 1,
      type: "sample",
      kind: "inferred",
      origin: "model",
      claimId: "cl-a",
      evidenceIds: ["ev-1"],
    } as GenealogyLink;
    const checked = checkClaims(draftOf([claim], linked ? [link] : []), PACK, null);
    const verdicts = new Map([["cl-a", { verdict, reason: "The cited excerpt decides it." }]]);
    // The verifier node's call (agent/verifier/index.ts, step 4).
    const [judged] = applyVerdicts(checked, verdicts).claims;
    return { kind: judged.kind, verdict: judged.verdict };
  }

  const provenance = (claim: Claim | undefined) => ({ kind: claim?.kind, verdict: claim?.verdict });

  it("reads a partly supported sample as inferred, as the analysis reads its card or link claim", async () => {
    const { claimOf } = await moreFacts({
      cards: [null, sampleCard(SAMPLE, ["ev-1"]), null],
      judge: () => "partial",
    });

    expect(claimOf(SAMPLE)).toMatchObject({ about: "sample", evidenceIds: ["ev-1"] });
    expect(provenance(claimOf(SAMPLE))).toEqual({ kind: "inferred", verdict: "partial" });
    expect(provenance(claimOf(SAMPLE))).toEqual(fromAnalysis("partial", "sample"));
    expect(provenance(claimOf(SAMPLE))).toEqual(fromAnalysis("partial", "sample", true));
  });

  it("keeps a fully supported sample sourced, as the analysis does", async () => {
    const { claimOf } = await moreFacts({
      cards: [null, sampleCard(SAMPLE, ["ev-1"]), null],
      judge: () => "supported",
    });

    expect(provenance(claimOf(SAMPLE))).toEqual({ kind: "sourced", verdict: "supported" });
    expect(provenance(claimOf(SAMPLE))).toEqual(fromAnalysis("supported", "sample"));
    expect(provenance(claimOf(SAMPLE))).toEqual(fromAnalysis("supported", "sample", true));
  });

  it("leaves a partly supported claim that states no relation sourced", async () => {
    const { claimOf } = await moreFacts({
      cards: [card(SOURCED, ["ev-1"]), null, null],
      judge: () => "partial",
    });

    expect(claimOf(SOURCED)).toMatchObject({ about: "production" });
    expect(provenance(claimOf(SOURCED))).toEqual({ kind: "sourced", verdict: "partial" });
    expect(provenance(claimOf(SOURCED))).toEqual(fromAnalysis("partial", "production"));
  });
});

describe("a statement from more facts that asserts a relation is stated whole, whatever its label", () => {
  // The recorded run's own relation records: Circo Loco samples the track; a string quartet
  // covers the song.
  const recorded = demoRecord().analysis.evidence ?? [];
  const recordOf = (part: string) => {
    const item = recorded.find((each) => each.recordRef?.includes(part));
    if (!item) throw new Error(`the recording has no ${part} record`);
    return item;
  };
  const sampledBy = recordOf("/sampled-by/recording/1da61e7a");
  const coveredBy = recordOf("/covered-by/recording/29df9c62");
  // The album the recording is on: a release-wide record, which states no relation.
  const album = recordOf("release/bd3bb36e");
  const pack = [...PACK, sampledBy, coveredBy, album];
  const SAMPLES = "Drake and 21 Savage's Circo Loco samples One More Time.";
  const COVER = "Vitamin String Quartet recorded its own version of the song.";
  const TRIVIA = "The synth was bought second-hand in Paris.";
  const labelled = (
    text: string,
    type: "trivia" | "curiosity" | "connection",
    evidenceIds: string[],
    scope: "recording" | "work" = "recording",
  ) => ({ ...card(text, evidenceIds), type, scope });
  const provenance = (claim: Claim | undefined) => ({ kind: claim?.kind, verdict: claim?.verdict });

  it.each(["trivia", "curiosity", "connection"] as const)(
    "reads a partly supported sample statement labelled %s as inferred",
    async (type) => {
      const { claimOf } = await moreFacts(
        { cards: [null, labelled(SAMPLES, type, [sampledBy.id]), null], judge: () => "partial" },
        { runId: RUN_ID },
        pack,
      );

      expect(claimOf(SAMPLES)).toMatchObject({ evidenceIds: [sampledBy.id] });
      expect(claimOf(SAMPLES)?.about).not.toBe("sample");
      expect(provenance(claimOf(SAMPLES))).toEqual({ kind: "inferred", verdict: "partial" });
    },
  );

  it("keeps a fully supported sample statement labelled trivia sourced", async () => {
    const { claimOf } = await moreFacts(
      {
        cards: [null, labelled(SAMPLES, "trivia", [sampledBy.id]), null],
        judge: () => "supported",
      },
      { runId: RUN_ID },
      pack,
    );

    expect(provenance(claimOf(SAMPLES))).toEqual({ kind: "sourced", verdict: "supported" });
  });

  it("leaves a partly supported trivia statement that asserts no relation sourced", async () => {
    const { claimOf } = await moreFacts(
      { cards: [labelled(TRIVIA, "trivia", ["ev-1"]), null, null], judge: () => "partial" },
      { runId: RUN_ID },
      pack,
    );

    expect(claimOf(TRIVIA)).toMatchObject({ about: "trivia", evidenceIds: ["ev-1"] });
    expect(provenance(claimOf(TRIVIA))).toEqual({ kind: "sourced", verdict: "partial" });
  });

  it("reads a partly supported cover statement labelled connection as inferred", async () => {
    const { claimOf } = await moreFacts(
      {
        cards: [null, labelled(COVER, "connection", [coveredBy.id], "work"), null],
        judge: () => "partial",
      },
      { runId: RUN_ID },
      pack,
    );

    expect(claimOf(COVER)).toMatchObject({ about: "connection", evidenceIds: [coveredBy.id] });
    expect(provenance(claimOf(COVER))).toEqual({ kind: "inferred", verdict: "partial" });
  });

  it("reads a partly supported cover statement as inferred when its cover record was dropped for scope", async () => {
    const { claimOf } = await moreFacts(
      {
        cards: [null, labelled(COVER, "connection", [coveredBy.id, "ev-1"]), null],
        judge: () => "partial",
      },
      { runId: RUN_ID },
      pack,
    );

    // Scoped to the recording, the card keeps ev-1 only; it still asserts the cover.
    expect(claimOf(COVER)).toMatchObject({ scope: "recording", evidenceIds: ["ev-1"] });
    expect(provenance(claimOf(COVER))).toEqual({ kind: "inferred", verdict: "partial" });
  });

  it("keeps the same cover statement sourced when supported after the drop", async () => {
    const { claimOf } = await moreFacts(
      {
        cards: [null, labelled(COVER, "connection", [coveredBy.id, "ev-1"]), null],
        judge: () => "supported",
      },
      { runId: RUN_ID },
      pack,
    );

    expect(claimOf(COVER)).toMatchObject({ evidenceIds: ["ev-1"] });
    expect(provenance(claimOf(COVER))).toEqual({ kind: "sourced", verdict: "supported" });
  });

  it("leaves a fact that cites no relation record, before or after the check, as before", async () => {
    // The release-wide record is dropped for scope; ev-1 is kept.
    const { claimOf } = await moreFacts(
      {
        cards: [labelled(TRIVIA, "trivia", [album.id, "ev-1"]), null, null],
        judge: () => "partial",
      },
      { runId: RUN_ID },
      pack,
    );

    expect(claimOf(TRIVIA)).toMatchObject({ scope: "recording", evidenceIds: ["ev-1"] });
    expect(provenance(claimOf(TRIVIA))).toEqual({ kind: "sourced", verdict: "partial" });
  });
});

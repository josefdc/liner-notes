/**
 * "More facts" as verified claims: each new fact is a model claim, checked against the evidence
 * of the analysis run the request names, judged once, and never measured. The model layer is a
 * fake (factoids/testing/fakes.ts): it writes one card per focus and judges what it is sent.
 */

import { type Claim, FactoidsResponse } from "@liner-notes/contract";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLlm } from "../agent/testing/stubLlm.js";
import { createTestApp } from "../http/testApp.js";
import { createFactoidsRouter } from "../http/routes/factoids.js";
import { LlmError } from "../llm/errors.js";
import { FACTOID_PACK_MAX } from "./prompt.js";
import { writeFactoids } from "./service.js";
import {
  card,
  DEMO_TRACK,
  evidenceItem,
  type FakeModel,
  fakeModel,
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
    .post("/api/factoids/decrypt")
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
    const judged = llm.calls.filter((call) => call.callSite === "verifier");
    expect(judged).toHaveLength(1);
    expect(judged[0].tier).toBe("judge");
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
    expect(llm.calls.some((call) => call.callSite === "verifier")).toBe(false);
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
    expect(llm.calls.some((call) => call.callSite === "verifier")).toBe(false);
    // The prompt showed no evidence of the other song.
    expect(JSON.stringify(llm.calls[0].input)).not.toContain("ev-1");
  });

  it("asks no judge when the client leaves once the facts are written", async () => {
    const client = new AbortController();
    let written = 0;
    const llm = stubLlm((call) => {
      if (call.callSite === "verifier") return { verdicts: [] };
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

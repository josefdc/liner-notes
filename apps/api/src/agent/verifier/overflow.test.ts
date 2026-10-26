/**
 * The judge's batch: at most JUDGE_BATCH_MAX claims go to one call, the first ones in result
 * order; the rest get no verdict, read as model inference, and are counted in `run.verifier`.
 */

import {
  claimDisplayKind,
  JUDGE_BATCH_MAX,
  resultContext,
  TrackAnalysis,
} from "@liner-notes/contract";
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

import { UNCHECKED_RESULT_TTL_MS } from "../storedResults.js";
import { testRuntime } from "../testing/stubLlm.js";
import { createVerifierNode } from "./index.js";
import { draftOf, judging, modelClaim, sentStatements, stateFor, trackRecord } from "./testing.js";

const config = { writer: () => {}, configurable: { thread_id: "run-1" } } as never;

describe("the judge batch", () => {
  beforeEach(() => {
    store.put.mockReset();
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });

  it("judges the first 20 of 25 cited claims; 5 get no verdict, read as inference, and are counted", async () => {
    expect(JUDGE_BATCH_MAX).toBe(20);
    const evidence = [trackRecord("ev-1")];
    const claims = Array.from({ length: 25 }, (_, i) =>
      modelClaim(`cl-${i + 1}`, { evidenceIds: ["ev-1"] }),
    );
    const llm = judging((sent) =>
      sent.map(({ claimId }) => ({ claimId, verdict: "supported", reason: "The record says so." })),
    );

    const out = await createVerifierNode(testRuntime(llm))(
      stateFor(draftOf(claims), evidence),
      config,
    );

    // One call, with the first 20 in result order, named by their place in the batch.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ callSite: "verifier", tier: "judge" });
    const sent = sentStatements(llm.calls[0]);
    expect(sent.map((statement) => statement.claimId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `c${i + 1}`),
    );
    expect(sent.map((statement) => statement.text)).toEqual(
      claims.slice(0, 20).map((claim) => claim.text),
    );

    const result = TrackAnalysis.parse(out.trackData);
    const context = resultContext(result);
    const shown = (result.claims ?? []).map((claim) => [
      claim.id,
      claim.verdict,
      claimDisplayKind(claim, context),
    ]);
    expect(shown.slice(0, 20)).toEqual(
      claims.slice(0, 20).map((claim) => [claim.id, "supported", "sourced"]),
    );
    expect(shown.slice(20)).toEqual(claims.slice(20).map((claim) => [claim.id, null, "inferred"]));
    expect(result.run?.verifier).toEqual({ judged: 20, unjudged: 5 });
    // A run whose batch overflowed is stored: the next run would send the same 20.
    expect(store.put).toHaveBeenCalledTimes(1);
  });

  it("sends the genealogy links' claims first, so a long list of claims never leaves them unjudged", async () => {
    const evidence = [trackRecord("ev-1")];
    const claims = Array.from({ length: 22 }, (_, i) =>
      modelClaim(`cl-${i + 1}`, { evidenceIds: ["ev-1"] }),
    );
    const relation = modelClaim("rel", {
      text: "A samples B.",
      about: "sample",
      evidenceIds: ["ev-1"],
    });
    const link = {
      source: "up",
      target: "current",
      value: 1,
      type: "sample" as const,
      kind: "inferred" as const,
      origin: "model" as const,
      claimId: "rel",
      evidenceIds: ["ev-1"],
    };
    const llm = judging((sent) =>
      sent.map(({ claimId }) => ({ claimId, verdict: "supported", reason: "Stated." })),
    );

    const out = await createVerifierNode(testRuntime(llm))(
      stateFor(draftOf([...claims, relation], [link]), evidence),
      config,
    );

    const sent = sentStatements(llm.calls[0]);
    expect(sent).toHaveLength(20);
    expect(sent[0].text).toBe("A samples B.");
    expect(out.trackData?.genealogy.links[0]).toMatchObject({ kind: "sourced", type: "sample" });
    expect(out.trackData?.run?.verifier).toEqual({ judged: 20, unjudged: 3 });
  });

  it("counts a claim the judge left out as unjudged, marks the check incomplete, and sends nothing when nothing cites", async () => {
    const evidence = [trackRecord("ev-1")];
    const claims = [
      modelClaim("cl-1", { evidenceIds: ["ev-1"] }),
      modelClaim("cl-2", { evidenceIds: ["ev-1"] }),
      modelClaim("cl-3"),
    ];
    const llm = judging(() => [{ claimId: "c2", verdict: "unsupported", reason: "Not stated." }]);

    const out = await createVerifierNode(testRuntime(llm))(
      stateFor(draftOf(claims), evidence),
      config,
    );

    expect(sentStatements(llm.calls[0])).toHaveLength(2);
    expect(out.trackData?.claims?.map((claim) => [claim.id, claim.verdict])).toEqual([
      ["cl-1", null],
      ["cl-2", "unsupported"],
      ["cl-3", null],
    ]);
    // cl-3 cites nothing: there is nothing to judge it against, so it is not counted. The
    // answer left cl-1 out: the check did not complete, and the run says so.
    expect(out.trackData?.run?.verifier).toEqual({ judged: 1, unjudged: 1, failed: true });
    expect(out.statusMessages?.[0]).toBe(
      "The check of the notes against their sources was incomplete: 1 statement got no verdict; " +
        "they are shown as model inference, not checked against their sources",
    );
    // Stored for the shorter time, so a later run checks it again.
    expect(store.put.mock.calls[0][2]).toMatchObject({ ttlMs: UNCHECKED_RESULT_TTL_MS });

    const none = judging(() => []);
    const quiet = await createVerifierNode(testRuntime(none))(
      stateFor(draftOf([modelClaim("cl-1")]), evidence),
      config,
    );
    expect(none.calls).toHaveLength(0);
    expect(quiet.trackData?.run?.verifier).toEqual({ judged: 0, unjudged: 0 });
  });
});

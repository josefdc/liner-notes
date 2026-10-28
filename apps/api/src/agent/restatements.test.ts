/**
 * withoutRestatements, on judged claims: which copy of a fact stays, what is never left out, and
 * the count.
 */

import type { Claim, Evidence } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { statementKey, withoutRestatements } from "./restatements.js";
import { modelClaim, trackRecord } from "./verifier/testing.js";

const sampleRecord: Evidence = {
  ...trackRecord("ev-sample"),
  recordRef: "track/recording/r1/samples/recording/r2",
};
const releaseRecord: Evidence = { ...trackRecord("ev-release"), recordRef: "release/r9" };
const otherRecord: Evidence = trackRecord("ev-other");
const evidence = [sampleRecord, releaseRecord, otherRecord];

const judged = (id: string, change: Partial<Claim>): Claim =>
  modelClaim(id, { verdict: "supported", kind: "sourced", ...change });
const codeSample: Claim = {
  ...modelClaim("code-sample", {
    text: '"Ice Ice Baby" by Vanilla Ice samples "Under Pressure" by Queen.',
    about: "sample",
    evidenceIds: ["ev-sample"],
  }),
  kind: "sourced",
  origin: "code",
};
type Card = { id: string; claimId?: string };
const card = (claimId: string): Card => ({ id: `card-${claimId}`, claimId });
const ids = (claims: readonly Claim[]) => claims.map((claim) => claim.id);

describe("withoutRestatements", () => {
  it("reads a statement's words, without case, quotes or punctuation", () => {
    expect(statementKey("“One More Time” appears on Daft Punk’s album.")).toBe(
      statementKey('"one more time" appears on Daft Punk\'s album'),
    );
    expect(statementKey("One More Time.")).not.toBe(statementKey("One More Time again."));
  });

  it("leaves out a model claim restating a code claim on its record, keeps the code claim, and counts it", () => {
    const restated = judged("m-1", {
      text: "Vanilla Ice samples Queen.",
      about: "sample",
      evidenceIds: ["ev-sample"],
    });
    const kept = withoutRestatements(
      [restated, codeSample],
      [card("m-1"), { id: "plain" }],
      [],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["code-sample"]);
    expect(kept.claims[0]).toBe(codeSample);
    expect(kept.factoids).toEqual([{ id: "plain" }]);
    expect(kept.restated).toBe(1);
  });

  it("keeps a model claim with other evidence, another relation, another scope or a partial verdict", () => {
    const claims = [
      judged("m-more", { about: "sample", evidenceIds: ["ev-sample", "ev-other"] }),
      judged("m-other", { about: "sample", evidenceIds: ["ev-other"] }),
      judged("m-cover", { about: "cover", evidenceIds: ["ev-sample"] }),
      judged("m-scope", { about: "sample", scope: "work", evidenceIds: ["ev-sample"] }),
      judged("m-partial", { about: "sample", verdict: "partial", evidenceIds: ["ev-sample"] }),
      judged("m-unjudged", { about: "sample", verdict: null, evidenceIds: ["ev-sample"] }),
      judged("m-none", { about: "sample", evidenceIds: [] }),
      codeSample,
    ];
    const kept = withoutRestatements(claims, [], [], evidence);
    expect(ids(kept.claims)).toEqual(ids(claims));
    expect(kept.restated).toBe(0);
  });

  it("never leaves out a claim a link or a timeline sample states, nor a code-built claim", () => {
    const linked = judged("m-link", { about: "sample", evidenceIds: ["ev-sample"] });
    const timed = judged("m-timed", { about: "trivia", evidenceIds: ["ev-sample"] });
    const twin = { ...codeSample, id: "code-twin" };
    const kept = withoutRestatements(
      [linked, timed, codeSample, twin],
      [],
      [{ claimId: "m-link" }, { claimId: "m-timed" }],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["m-link", "m-timed", "code-sample", "code-twin"]);
  });

  it("of two model claims with one text, keeps the one whose scope fits its evidence", () => {
    // The first cites a release record for a claim about this recording: it does not fit.
    const misfit = judged("m-credit", {
      text: "It appears on “To the Extreme”.",
      about: "credit",
      scope: "recording",
      evidenceIds: ["ev-release"],
    });
    const fit = judged("m-track", {
      text: 'It appears on "To the Extreme".',
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const kept = withoutRestatements([misfit, fit], [card("m-credit")], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-track"]);
    expect(kept.factoids).toEqual([]);
    expect(kept.restated).toBe(1);
  });

  it("of two that both fit, keeps the better verdict: supported, partial, not judged, unsupported", () => {
    const text = "It appears on To the Extreme.";
    const order = ["unsupported", null, "partial", "supported"] as const;
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        if (i === j) continue;
        const a = judged("a", { text, about: "track", scope: "release", verdict: order[i] });
        const b = judged("b", { text, about: "credit", scope: "release", verdict: order[j] });
        const kept = withoutRestatements([a, b], [], [], evidence);
        // No evidence on either: equal fit, so the verdict decides.
        expect(ids(kept.claims), `${order[i]} / ${order[j]}`).toEqual([i > j ? "a" : "b"]);
      }
    }
  });

  it("of two otherwise equal copies, keeps the one on a fact card, and its card", () => {
    const text = "The bass line comes from Under Pressure.";
    const plain = modelClaim("m-plain", { text, about: "sample" });
    const carded = modelClaim("m-card", {
      text,
      about: "sample",
      factoid: { title: "Borrowed bass", type: "sample", entities: [] },
    });
    const kept = withoutRestatements([plain, carded], [card("m-card")], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-card"]);
    expect(kept.factoids).toEqual([card("m-card")]);
    expect(kept.restated).toBe(1);
  });

  it("keeps both copies when the one that would go cites more", () => {
    const text = "It samples Under Pressure.";
    const kept = withoutRestatements(
      [
        judged("m-one", { text, about: "sample", evidenceIds: ["ev-other"] }),
        judged("m-two", {
          text,
          about: "trivia",
          verdict: "partial",
          evidenceIds: ["ev-other", "ev-sample"],
        }),
      ],
      [],
      [],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["m-one", "m-two"]);
  });
});

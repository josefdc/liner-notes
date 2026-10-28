/**
 * The One More Time recording (fixtures/replays/one-more-time-daft-punk.json), replayed: each of
 * the four facts the model restated beside a code-built claim (the Eddie Johns sample, the Circo
 * Loco sample, the London Elektricity cover, the Discovery release) is stated once, by the
 * code-built claim, and the claims left out are counted. The one model claim on those records
 * that adds information (the brass figure, partly supported) stays, on its card.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Claim, ReplayRecord, type TrackAnalysis } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { playRecord, replayedAnalysis } from "./player.js";
import { DEFAULT_REPLAY_DIR } from "./records.js";

const record = ReplayRecord.parse(
  JSON.parse(readFileSync(join(DEFAULT_REPLAY_DIR, "one-more-time-daft-punk.json"), "utf8")),
);

const RECORDING = "musicbrainz:track/recording/60fa767a-d85d-4991-82bc-4294e0b11ae7";
/** The record of each fact, by name. */
const FACTS = {
  "Eddie Johns sample": `${RECORDING}/samples/recording/cd6c8d5c-fd3b-4ec4-bb57-7a59451f7edb`,
  "Circo Loco sample": `${RECORDING}/sampled-by/recording/1da61e7a-d61d-4538-bd75-63464988923f`,
  "London Elektricity cover":
    "musicbrainz:work/4bb47ffc-9006-32cf-8aa9-e213334550dc/covered-by/recording/ac096174-a4dc-43ff-8077-291591990e9e",
  "Discovery release": "musicbrainz:release/bd3bb36e-16c8-438f-850e-dfbf4d1478f0",
};
/** The model's claim on the Eddie Johns record that says more than it: kept. */
const BRASS_FIGURE = "452be048";

/** A statement's words, in order, without case or punctuation. */
const wordsOf = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");

/** The claims that state a fact on its record alone: cite only it, and are not partial. */
const statingOnly = (claims: readonly Claim[], item: string) =>
  claims.filter(
    (claim) =>
      claim.evidenceIds.length === 1 &&
      claim.evidenceIds[0] === item &&
      claim.verdict !== "partial",
  );

async function streamed(): Promise<TrackAnalysis> {
  const result = await playRecord(record, "run-omt", () => true, new AbortController().signal, {
    speed: 1e9,
    maxGapMs: 0,
  });
  if (!result) throw new Error("the replay sent no result");
  return result;
}

describe("the One More Time recording, replayed", () => {
  it("states each of the four facts once, by its code-built claim", async () => {
    const recorded = record.analysis.claims ?? [];
    // As recorded: each fact twice or more, the model's copies beside the code-built one.
    for (const item of Object.values(FACTS)) {
      expect(statingOnly(recorded, item).length).toBeGreaterThan(1);
    }

    for (const served of [replayedAnalysis(record, "run-omt"), await streamed()]) {
      const claims = served.claims ?? [];
      for (const [fact, item] of Object.entries(FACTS)) {
        const stating = statingOnly(claims, item);
        expect(
          stating.map((claim) => claim.origin),
          fact,
        ).toEqual(["code"]);
      }
      // 7 of the 9 model claims are left out, and counted; none is listed twice by its words.
      expect(served.run?.verifier).toEqual({ judged: 9, unjudged: 0, restated: 7 });
      expect(claims).toHaveLength(recorded.length - 7);
      const keys = claims.map((claim) => wordsOf(claim.text));
      expect(new Set(keys).size).toBe(keys.length);
      // The kept claims are as recorded: verdicts, kinds and evidence untouched.
      for (const claim of claims) {
        expect(recorded.find((other) => other.id === claim.id)).toEqual(claim);
      }
    }
  });

  it("keeps the model claim that adds to a record, on its card, and drops the cards it leaves out", () => {
    const served = replayedAnalysis(record, "run-omt");
    const claims = served.claims ?? [];
    const brass = claims.find((claim) => claim.id.startsWith(BRASS_FIGURE));
    expect(brass).toMatchObject({ verdict: "partial", evidenceIds: [FACTS["Eddie Johns sample"]] });
    // The duration the model read from MusicBrainz restates no code-built claim: it stays.
    expect(claims.filter((claim) => claim.origin === "model")).toHaveLength(2);
    // Every card shows a kept claim; the cards of the claims left out are gone.
    const ids = new Set(claims.map((claim) => claim.id));
    expect(served.factoids.map((card) => card.claimId)).toEqual([brass?.id]);
    for (const card of served.factoids) expect(ids.has(card.claimId ?? "")).toBe(true);
    // A link or a sample never names a claim that is gone.
    for (const link of served.genealogy.links) {
      if (link.claimId) expect(ids.has(link.claimId)).toBe(true);
    }
  });
});

describe("a recording replayed", () => {
  /** The full id of the recorded claim whose id starts with `prefix`. */
  const claimId = (prefix: string) =>
    (record.analysis.claims ?? []).find((claim) => claim.id.startsWith(prefix))!.id;
  const EDDIE_JOHNS = "fdbb79f2";
  const CIRCO_LOCO = "72c47650";

  it("keeps a restating claim that a link or a timeline sample names", () => {
    const named = ReplayRecord.parse({
      ...record,
      analysis: {
        ...record.analysis,
        genealogy: {
          ...record.analysis.genealogy,
          links: [
            ...record.analysis.genealogy.links,
            {
              source: "current",
              target: record.analysis.genealogy.nodes[1].id,
              value: 1,
              type: "sample",
              kind: "inferred",
              origin: "model",
              claimId: claimId(EDDIE_JOHNS),
              evidenceIds: [FACTS["Eddie Johns sample"]],
            },
          ],
        },
        samples: [{ time: 30, description: "Circo Loco", claimId: claimId(CIRCO_LOCO) }],
      },
    });
    const claims = replayedAnalysis(named, "run-omt").claims ?? [];
    for (const id of [EDDIE_JOHNS, CIRCO_LOCO]) {
      expect(claims.some((claim) => claim.id === claimId(id))).toBe(true);
    }
    expect(replayedAnalysis(named, "run-omt").run?.verifier).toMatchObject({ restated: 5 });
  });

  it("is left as recorded when its run already left out what restates another", () => {
    const run = record.analysis.run!;
    const already = ReplayRecord.parse({
      ...record,
      analysis: { ...record.analysis, run: { ...run, verifier: { ...run.verifier, restated: 0 } } },
    });
    const served = replayedAnalysis(already, "run-omt");
    expect(served.claims).toEqual(already.analysis.claims);
    expect(served.factoids).toEqual(already.analysis.factoids);
    expect(served.run?.verifier).toEqual({ judged: 9, unjudged: 0, restated: 0 });
  });
});

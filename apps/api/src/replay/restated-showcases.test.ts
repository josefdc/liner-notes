/**
 * The four showcases served before the golden run's (fixtures/pinned/9971adea845d, whose exact
 * claims these counts and ids pin), replayed: each relation a record documents is stated once, by
 * its code-built claim. The model's claims and fact cards that only list such records ("“Juicy”
 * is sampled in A, B and C"), or state one in words of their own ("MusicBrainz documents X as a
 * source sampled in this recording", the Coldplay cover of Bitter Sweet Symphony), are left out
 * and counted; a claim that says more stays, and is named as its record names the relation when
 * it states it in a plain sentence beside detail ("…around that sample"). Every committed
 * showcase (fixtures/replays) is checked for what holds whatever its text: every card and link
 * served names a claim served, and serving it again leaves nothing more out.
 */

import type { Claim, TrackAnalysis } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { documentedRelation, oneClaimPerFact } from "../agent/restatements.js";
import { replayedAnalysis, replayNotice } from "./player.js";
import { previousShowcase, readRecording, recordingSlugs } from "./testing/recordings.js";

/** What a showcase holds as recorded and as served: claims, fact cards and map links. */
interface Counts {
  claims: number;
  cards: number;
  links: number;
}
const countsOf = (analysis: TrackAnalysis): Counts => ({
  claims: (analysis.claims ?? []).length,
  cards: analysis.factoids.length,
  links: analysis.genealogy.links.length,
});

const SHOWCASES: Record<
  string,
  {
    recorded: Counts;
    served: Counts;
    /** The model's claims left out, by the start of their ids. */
    left: string[];
    /** The model's claims kept on a record-built relation, each with its mark. */
    kept: Record<string, string | undefined>;
  }
> = {
  "bitter-sweet-symphony-the-verve": {
    recorded: { claims: 14, cards: 2, links: 5 },
    served: { claims: 12, cards: 1, links: 5 },
    // The Coldplay cover, as a claim and as a CONNECTION card.
    left: ["f67d7102", "824ae39c"],
    // The sample card: its second sentence adds detail around "that sample".
    kept: { "71a2da2e": "103514e6" },
  },
  "hung-up-madonna": {
    recorded: { claims: 10, cards: 1, links: 6 },
    served: { claims: 10, cards: 1, links: 6 },
    left: [],
    // The remix list names the remixers inside the records' titles: it is not read, and stays.
    kept: { e6b2b34e: undefined },
  },
  "juicy-the-notorious-big": {
    recorded: { claims: 17, cards: 3, links: 11 },
    served: { claims: 13, cards: 0, links: 11 },
    // The list of tracks that sample Juicy, its CONNECTION card, and the two sample cards.
    left: ["117ba937", "f3a2ae6f", "49a56b45", "5ed3b846"],
    kept: {},
  },
  "one-more-time-daft-punk": {
    recorded: { claims: 16, cards: 1, links: 9 },
    served: { claims: 15, cards: 0, links: 9 },
    // "MusicBrainz documents … as a source sampled in this recording of …".
    left: ["78acfe08"],
    kept: {},
  },
};

const short = (id: string) => id.slice(0, 8);

/** The relation records `claim` cites, when it cites only such records. */
function relationRecords(claim: Claim, analysis: TrackAnalysis): string[] | null {
  const pack = new Map((analysis.evidence ?? []).map((item) => [item.id, item]));
  const records = claim.evidenceIds.filter((id) => {
    const item = pack.get(id);
    return item !== undefined && documentedRelation(item) !== null;
  });
  return records.length > 0 && records.length === claim.evidenceIds.length ? records : null;
}

describe.each(Object.entries(SHOWCASES))(
  "the showcase recording %s, replayed",
  (slug, expected) => {
    const record = previousShowcase(slug);
    const served = replayedAnalysis(record, `run-${slug}`);

    it("serves each fact once: the claims, cards and links before and after", () => {
      expect(countsOf(record.analysis)).toEqual(expected.recorded);
      expect(countsOf(served)).toEqual(expected.served);
      const recorded = new Set((record.analysis.claims ?? []).map((claim) => claim.id));
      const shown = new Set((served.claims ?? []).map((claim) => claim.id));
      expect([...recorded].filter((id) => !shown.has(id)).map(short)).toEqual(expected.left);
      expect(served.run?.verifier?.restated).toBe(
        (record.analysis.run?.verifier?.restated ?? 0) + expected.left.length,
      );
      const notice = replayNotice(record).message;
      if (expected.left.length > 0) {
        expect(notice).toContain(
          `${expected.left.length} repeated claim${expected.left.length === 1 ? "" : "s"} left out.`,
        );
      } else expect(notice).not.toContain("left out");
      // Every card shows a kept claim; no link names a claim that went.
      for (const card of served.factoids) expect(shown.has(card.claimId ?? "")).toBe(true);
      for (const link of served.genealogy.links) {
        if (link.claimId) expect(shown.has(link.claimId)).toBe(true);
      }
    });

    it("lists each documented relation once, by its record, never also as a guess beside it", () => {
      const claims = served.claims ?? [];
      // The model's claims on record-built relations still shown, and how each is marked.
      const onRecords = claims.filter(
        (claim) => claim.origin === "model" && relationRecords(claim, served) !== null,
      );
      expect(
        Object.fromEntries(
          onRecords.map((claim) => [short(claim.id), claim.documentedBy?.map(short).join(",")]),
        ),
      ).toEqual(expected.kept);
      // Each kept claim is as recorded but for its mark: no verdict or kind changed.
      for (const { documentedBy: _mark, ...claim } of claims) {
        const { documentedBy: _recorded, ...before } = (record.analysis.claims ?? []).find(
          (each) => each.id === claim.id,
        ) as Claim;
        expect(claim).toEqual(before);
      }
      // Each record a code-built claim states is stated by no other claim, but one that says
      // more and is marked as stating its record's relation (or is about no relation).
      for (const built of claims.filter((claim) => claim.origin === "code")) {
        for (const id of relationRecords(built, served) ?? []) {
          const others = claims.filter(
            (claim) =>
              claim !== built && claim.origin === "model" && claim.evidenceIds.includes(id),
          );
          for (const other of others) {
            const relation = other.about === "sample" || other.about === "cover";
            if (relation) expect(other.documentedBy ?? [], other.text).toContain(built.id);
          }
        }
      }
    });

    it("leaves nothing more out when run on what it served", () => {
      const again = oneClaimPerFact(served);
      expect(again.restated).toBe(0);
      expect(again.result.claims).toEqual(served.claims);
      expect(again.result.factoids).toEqual(served.factoids);
      expect(again.result.genealogy).toEqual(served.genealogy);
    });
  },
);

describe.each(recordingSlugs())("the committed showcase %s, replayed", (slug) => {
  const record = readRecording(slug);
  const served = replayedAnalysis(record, `run-${slug}`);

  it("shows only served claims on its cards and links, each claim as recorded but for its mark", () => {
    const shown = new Set((served.claims ?? []).map((claim) => claim.id));
    for (const card of served.factoids) expect(shown.has(card.claimId ?? "")).toBe(true);
    for (const link of served.genealogy.links) {
      if (link.claimId) expect(shown.has(link.claimId)).toBe(true);
    }
    for (const { documentedBy: _mark, ...claim } of served.claims ?? []) {
      const { documentedBy: _recorded, ...before } = (record.analysis.claims ?? []).find(
        (each) => each.id === claim.id,
      ) as Claim;
      expect(claim).toEqual(before);
    }
  });

  it("leaves nothing more out when run on what it served", () => {
    const again = oneClaimPerFact(served);
    expect(again.restated).toBe(0);
    expect(again.result.claims).toEqual(served.claims);
    expect(again.result.factoids).toEqual(served.factoids);
    expect(again.result.genealogy).toEqual(served.genealogy);
  });
});

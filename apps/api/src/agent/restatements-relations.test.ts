/**
 * withoutRestatements on claims about a relation between two records (a sample, a cover): a
 * model claim that states only what a record documents goes whatever the judge found of it, with
 * its card and the model's links that state it; two model claims that state one relation are
 * shown once; a claim that says anything else stays, judged as it was.
 */

import type { Claim, Evidence } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { documentedRelation, withoutRestatements } from "./restatements.js";
import { modelClaim, trackRecord } from "./verifier/testing.js";

const record = (id: string, recordRef: string, excerpt: string): Evidence => ({
  ...trackRecord(id, excerpt),
  recordRef,
});
/** The shapes of the One More Time, Hung Up and Juicy recordings' records. */
const coverRecord = record(
  "ev-cover",
  "work/w1/covered-by/recording/r5",
  'MusicBrainz: the work "One More Time" is covered by "One More Time" by The London Elektricity Big Band.',
);
const abbaRecord = record(
  "ev-abba",
  "track/recording/h1/samples/recording/a1",
  'MusicBrainz: "Hung Up" by Madonna samples "Gimme! Gimme! Gimme! (A Man After Midnight)" by ABBA.',
);
const remixRecord = record(
  "ev-remix",
  "track/recording/h1/remixed-by/recording/x1",
  'MusicBrainz: "Hung Up" by Madonna is remixed in "Hung Up (SDP extended vocal)" by Madonna.',
);
const fruitRecord = record(
  "ev-fruit",
  "track/recording/j1/samples/recording/m1",
  'MusicBrainz: "Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume.',
);
const dukeRecord = record(
  "ev-duke",
  "track/recording/j1/samples/recording/d1",
  `MusicBrainz: "Juicy" by The Notorious B.I.G. samples "Rappin' Duke (vocal)" by The Rappin' Duke.`,
);
const evidence = [coverRecord, abbaRecord, remixRecord, fruitRecord, dukeRecord];

/** A code-built claim on `item`, as codeClaims.ts builds it. */
const codeClaim = (id: string, item: Evidence, change: Partial<Claim>): Claim => ({
  ...modelClaim(id, {
    text: item.excerpt.replace(/^MusicBrainz:\s+/, ""),
    evidenceIds: [item.id],
    ...change,
  }),
  kind: "sourced",
  origin: "code",
});
const codeCover = codeClaim("code-cover", coverRecord, { about: "cover", scope: "work" });
const codeAbba = codeClaim("code-abba", abbaRecord, { about: "sample" });
const codeRemix = codeClaim("code-remix", remixRecord, { about: "sample" });
const codeFruit = codeClaim("code-fruit", fruitRecord, { about: "sample" });
const codeDuke = codeClaim("code-duke", dukeRecord, { about: "sample" });

/** A model claim as the judge left it: a partly supported relation reads as inferred. */
const judged = (id: string, change: Partial<Claim>): Claim => {
  const verdict = change.verdict === undefined ? "supported" : change.verdict;
  return modelClaim(id, {
    verdict,
    kind: verdict === "supported" ? "sourced" : "inferred",
    ...change,
  });
};
type Card = { id: string; claimId?: string };
const card = (claimId: string): Card => ({ id: `card-${claimId}`, claimId });
const ids = (claims: readonly Claim[]) => claims.map((claim) => claim.id);

const omt = { title: "One More Time", artist: "Daft Punk" };
const hungUp = { title: "Hung Up", artist: "Madonna" };
const juicy = { title: "Juicy", artist: "The Notorious B.I.G." };

/** The model's cover of One More Time, partly supported, as recorded for #217. */
const modelCover = judged("m-cover", {
  text: '"One More Time - The London Elektricity Big Band" is a cover of "One More Time - Daft Punk".',
  about: "cover",
  scope: "work",
  verdict: "partial",
  evidenceIds: ["ev-cover"],
});
/** The model's map: its own node for the cover, and its link, which states its claim. */
const coverMap = () => ({
  nodes: [{ id: "current" }, { id: "mb-x" }, { id: "lebb" }],
  links: [
    {
      source: "current",
      target: "lebb",
      type: "cover",
      kind: "inferred",
      origin: "model",
      claimId: "m-cover",
    },
    {
      source: "current",
      target: "mb-x",
      type: "remix",
      kind: "sourced",
      origin: "code",
      claimId: "code-remix",
    },
  ],
});

describe("documentedRelation", () => {
  it("reads the relation and the other record from a record's ref and excerpt", () => {
    expect(documentedRelation(coverRecord)).toEqual({
      kind: "covered-by",
      title: "One More Time",
      artist: "The London Elektricity Big Band",
    });
    expect(documentedRelation(remixRecord)).toMatchObject({
      kind: "remixed-by",
      title: "Hung Up (SDP extended vocal)",
    });
    expect(documentedRelation(trackRecord("ev-plain"))).toBeNull();
  });
});

describe("a model claim that restates a record-built relation", () => {
  it("goes when partly supported, with the model's link and the node only that link drew", () => {
    const map = coverMap();
    const kept = withoutRestatements([modelCover, codeCover, codeRemix], [], map.links, evidence, {
      genealogy: map,
      track: omt,
    });
    expect(ids(kept.claims)).toEqual(["code-cover", "code-remix"]);
    expect(kept.restated).toBe(1);
    // The relation is stated once, by its record: no second node or inferred link for it.
    expect(kept.genealogy?.links).toEqual([map.links[1]]);
    expect(kept.genealogy?.nodes).toEqual([{ id: "current" }, { id: "mb-x" }]);
    // Run again, nothing more goes.
    const again = withoutRestatements(kept.claims, [], kept.genealogy?.links ?? [], evidence, {
      genealogy: kept.genealogy,
      track: omt,
    });
    expect(again.restated).toBe(0);
    expect(again.genealogy).toBe(kept.genealogy);
  });

  it("reads the analysed track's names as no new name", () => {
    // "Daft Punk" is not in the cover's record: only as the analysed track's artist is it known.
    const kept = withoutRestatements([modelCover, codeCover], [], [], evidence, {
      track: { title: "One More Time", artist: "Someone Else" },
    });
    expect(ids(kept.claims)).toEqual(["m-cover", "code-cover"]);
  });

  it("stays while a link the map does not hold, or a code-built link, states it", () => {
    const map = coverMap();
    const stating = [{ ...map.links[0] }];
    // Without the map, every link that states a claim keeps it.
    expect(
      ids(
        withoutRestatements([modelCover, codeCover], [], stating, evidence, { track: omt }).claims,
      ),
    ).toEqual(["m-cover", "code-cover"]);
    const coded = { ...map, links: [{ ...map.links[0], origin: "code" }] };
    expect(
      ids(
        withoutRestatements([modelCover, codeCover], [], coded.links, evidence, {
          genealogy: coded,
          track: omt,
        }).claims,
      ),
    ).toEqual(["m-cover", "code-cover"]);
  });

  it("goes with its fact card, at either verdict that finds its record behind it", () => {
    for (const verdict of ["partial", "supported"] as const) {
      const sample = judged("m-abba", {
        text: "The recording samples “Gimme! Gimme! Gimme! (A Man After Midnight)” by ABBA.",
        about: "sample",
        verdict,
        evidenceIds: ["ev-abba"],
        factoid: { title: "An ABBA hook", type: "sample", entities: [] },
      });
      const kept = withoutRestatements(
        [sample, codeAbba],
        [card("m-abba"), { id: "plain" }],
        [],
        evidence,
        { track: hungUp },
      );
      expect(ids(kept.claims), verdict).toEqual(["code-abba"]);
      // No card is left to read "Possible sample" for the sample the record documents.
      expect(kept.factoids, verdict).toEqual([{ id: "plain" }]);
    }
  });

  it("goes when the records it cites are each stated by a code-built claim", () => {
    const both = judged("m-both", {
      text: "This recording samples Mtume’s “Juicy Fruit” and “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
      about: "sample",
      evidenceIds: ["ev-fruit", "ev-duke"],
    });
    const kept = withoutRestatements([both, codeFruit, codeDuke], [], [], evidence, {
      track: juicy,
    });
    expect(ids(kept.claims)).toEqual(["code-fruit", "code-duke"]);
    // One of its records stated by no code claim: it says what no record-built claim does.
    const half = withoutRestatements([both, codeFruit], [], [], evidence, { track: juicy });
    expect(ids(half.claims)).toEqual(["m-both", "code-fruit"]);
  });
});

describe("a model claim on a record-built relation that says something else", () => {
  it("stays, judged as it was", () => {
    const claims = [
      // A word of its own, partly supported: the judge found something in it no record says.
      judged("m-more", {
        text: "The recording samples “Gimme! Gimme! Gimme! (A Man After Midnight)” by ABBA, bringing the earlier song into Madonna’s dance track.",
        about: "sample",
        verdict: "partial",
        evidenceIds: ["ev-abba"],
      }),
      // Another relation: the record documents a remix, the claim states a sample.
      judged("m-type", {
        text: '"Hung Up (SDP extended vocal)" samples "Hung Up" by Madonna.',
        about: "sample",
        verdict: "partial",
        evidenceIds: ["ev-remix"],
      }),
      // Another pair of records: in its record's words, but not naming the record sampled.
      judged("m-self", {
        text: "Madonna samples Hung Up.",
        about: "sample",
        verdict: "partial",
        evidenceIds: ["ev-abba"],
      }),
      // Another record than the one it cites.
      judged("m-pair", {
        text: "The recording samples ABBA’s “Voulez-Vous”.",
        about: "sample",
        evidenceIds: ["ev-abba"],
      }),
      // Not judged, or found unsupported: nothing says its record is behind it.
      judged("m-unjudged", {
        text: "Hung Up samples ABBA.",
        about: "sample",
        verdict: null,
        evidenceIds: ["ev-abba"],
      }),
      judged("m-unsupported", {
        text: "Madonna samples ABBA.",
        about: "sample",
        verdict: "unsupported",
        evidenceIds: ["ev-abba"],
      }),
      codeAbba,
      codeRemix,
    ];
    const kept = withoutRestatements(claims, [card("m-more")], [], evidence, { track: hungUp });
    expect(ids(kept.claims)).toEqual(ids(claims));
    expect(kept.factoids).toEqual([card("m-more")]);
    expect(kept.claims[0]).toBe(claims[0]);
    expect(kept.restated).toBe(0);
  });
});

describe("two model claims that state one relation in other words", () => {
  /** The Juicy recording's two copies, with no record-built claim beside them. */
  const plain = judged("m-plain", {
    text: "This recording samples Mtume’s “Juicy Fruit”.",
    about: "sample",
    evidenceIds: ["ev-fruit"],
  });
  const carded = judged("m-card", {
    text: "This recording samples Mtume’s “Juicy Fruit,” linking Biggie’s track to the earlier song.",
    about: "sample",
    evidenceIds: ["ev-fruit"],
    factoid: { title: "A familiar groove reworked", type: "sample", entities: [] },
  });

  it("are shown once: the one that says only what its record says goes", () => {
    const kept = withoutRestatements([plain, carded], [card("m-card")], [], evidence, {
      track: juicy,
    });
    expect(ids(kept.claims)).toEqual(["m-card"]);
    expect(kept.factoids).toEqual([card("m-card")]);
    expect(kept.restated).toBe(1);
    expect(
      withoutRestatements(kept.claims, kept.factoids, [], evidence, { track: juicy }).restated,
    ).toBe(0);
  });

  it("both stay when the one that would go says more, reads as another kind or another relation", () => {
    // The better copy (now the one on a card) says only what the record says; the other names
    // what the record does not ("Biggie").
    const { factoid, ...uncarded } = carded;
    const plainOnCard = { ...plain, factoid };
    expect(
      ids(withoutRestatements([plainOnCard, uncarded], [], [], evidence, { track: juicy }).claims),
    ).toEqual(["m-plain", "m-card"]);
    // A stricter copy is never dropped for a lenient one.
    const strict = { ...plain, verdict: "partial" as const, kind: "inferred" as const };
    expect(
      ids(withoutRestatements([strict, carded], [], [], evidence, { track: juicy }).claims),
    ).toEqual(["m-plain", "m-card"]);
    const history = { ...carded, about: "history" as const };
    expect(
      ids(withoutRestatements([plain, history], [], [], evidence, { track: juicy }).claims),
    ).toEqual(["m-plain", "m-card"]);
  });
});

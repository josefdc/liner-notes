/**
 * withoutRestatements on claims about a relation between two records (a sample, a cover): a
 * model claim that states only what a record documents goes whatever the judge found of it, with
 * its card and the model's links that state it; two model claims that state one relation are
 * shown once; a claim that says anything else stays, judged as it was.
 */

import type { Claim, Evidence } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { threadCpuMs, timed } from "../sources/testing/strings.js";
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
/** A Discogs credit, and the code-built claim on it. */
const credit: Evidence = {
  ...trackRecord(
    "ev-credit",
    'Discogs release 1234 ("Confessions on a Dance Floor", 2005) credits Stuart Price as Producer on "Hung Up".',
  ),
  source: "discogs",
  recordRef: "track/release/1234/credit/stuart-price",
};
const codeCredit = codeClaim("code-credit", credit, { about: "credit", text: credit.excerpt });
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
  nodes: [
    { id: "current" },
    { id: "mb-x" },
    { id: "lebb", label: "One More Time - The London Elektricity Big Band" },
  ],
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
    // A relations map's second hop joins two other recordings: it documents none of this track.
    expect(
      documentedRelation({
        recordRef: "recording/v1/samples/recording/o1",
        excerpt: 'MusicBrainz: "Other" by Someone samples "Juicy Fruit" by Mtume.',
      }),
    ).toBeNull();
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

  it("stays, with the model's link, when that link draws another relation or reads the other way", () => {
    const claim = judged("m-1", {
      text: "Juicy samples Juicy Fruit by Mtume.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-fruit"],
    });
    const coded = {
      source: "c-node",
      target: "current",
      type: "sample",
      origin: "code",
      claimId: "code-fruit",
      evidenceIds: ["ev-fruit"],
    };
    const model = {
      source: "m-node",
      target: "current",
      type: "sample",
      origin: "model",
      claimId: "m-1",
    };
    const run = (link: typeof model) => {
      const map = {
        nodes: [
          { id: "current" },
          { id: "c-node" },
          { id: "m-node", label: "Juicy Fruit - Mtume" },
          { id: "isley", label: "Between the Sheets - The Isley Brothers" },
        ],
        links: [link, coded],
      };
      return withoutRestatements([claim, codeFruit], [], map.links, evidence, {
        genealogy: map,
        track: juicy,
      });
    };
    for (const link of [
      { ...model, type: "interpolation" },
      { ...model, type: "remix" },
      { ...model, source: "current", target: "m-node" },
    ]) {
      const kept = run(link);
      expect(ids(kept.claims), JSON.stringify(link)).toEqual(["m-1", "code-fruit"]);
      expect(kept.genealogy?.links, JSON.stringify(link)).toEqual([link, coded]);
    }
    // A link to another record's node (as its label names it) stays, and so does its claim.
    const isley = { ...model, source: "isley" };
    const kept = run(isley);
    expect(ids(kept.claims)).toEqual(["m-1", "code-fruit"]);
    expect(kept.genealogy?.links).toEqual([isley, coded]);
    // The link that draws the record's relation, as the code link does, to the record's own node
    // (the code link's, or one its label names), goes with its claim.
    for (const link of [model, { ...model, source: "c-node" }]) {
      const gone = run(link);
      expect(ids(gone.claims), link.source).toEqual(["code-fruit"]);
      expect(gone.genealogy?.links, link.source).toEqual([coded]);
    }
    // A record the map draws no code link for (past the map's cap): the model's link is the only
    // one that draws it, so it stays, with its claim, even to a node its label names.
    const alone = {
      nodes: [{ id: "current" }, { id: "m-node", label: "Juicy Fruit - Mtume" }],
      links: [model],
    };
    const uncoded = withoutRestatements([claim, codeFruit], [], alone.links, evidence, {
      genealogy: alone,
      track: juicy,
    });
    expect(ids(uncoded.claims)).toEqual(["m-1", "code-fruit"]);
    expect(uncoded.genealogy?.links).toEqual([model]);
    // A cover of the song, which the map never draws: a link of another type stays too.
    for (const type of ["sample", "remix"]) {
      const map = coverMap();
      const other = { ...map.links[0], type };
      const links = [other, map.links[1]];
      const kept = withoutRestatements([modelCover, codeCover, codeRemix], [], links, evidence, {
        genealogy: { ...map, links },
        track: omt,
      });
      expect(ids(kept.claims), type).toEqual(["m-cover", "code-cover", "code-remix"]);
      expect(kept.genealogy?.links, type).toEqual(links);
    }
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
    // Each is as it was: none states its record's relation and nothing else, so none is marked.
    for (const [i, claim] of kept.claims.entries()) expect(claim).toBe(claims[i]);
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
    text: "The recording samples “Juicy Fruit” by Mtume.",
    about: "sample",
    evidenceIds: ["ev-fruit"],
    factoid: { title: "A familiar groove reworked", type: "sample", entities: [] },
  });

  it("are shown once: the better copy (on a card) stays", () => {
    for (const claims of [
      [plain, carded],
      [carded, plain],
    ]) {
      const kept = withoutRestatements(claims, [card("m-card")], [], evidence, { track: juicy });
      expect(ids(kept.claims)).toEqual(["m-card"]);
      expect(kept.factoids).toEqual([card("m-card")]);
      expect(kept.restated).toBe(1);
      expect(
        withoutRestatements(kept.claims, kept.factoids, [], evidence, { track: juicy }).restated,
      ).toBe(0);
    }
  });

  it("both stay when one says more than its record, or names what its records do not", () => {
    // Read in doubt, the one that says more states nothing for certain: it covers no other claim.
    for (const text of [
      "This recording samples Mtume’s “Juicy Fruit,” linking the track to the earlier song.",
      "This recording samples Mtume’s “Juicy Fruit,” linking Biggie’s track to the earlier song.",
    ]) {
      const more = { ...carded, text };
      for (const claims of [
        [plain, more],
        [more, plain],
      ]) {
        const kept = withoutRestatements(claims, [card("m-card")], [], evidence, { track: juicy });
        expect(ids(kept.claims).sort(), text).toEqual(["m-card", "m-plain"]);
        expect(kept.restated).toBe(0);
      }
    }
  });

  it("both stay when they read as different kinds or are about another subject", () => {
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

  it("never drop a supported copy for a partly supported one, whatever their kinds", () => {
    // Read as the same kind (a supported claim whose citation did not fit its scope reads
    // inferred), the partly supported one, which cites one more record, never covers it.
    const supported = { ...plain, kind: "inferred" as const };
    const partial = {
      ...carded,
      verdict: "partial" as const,
      kind: "inferred" as const,
      evidenceIds: ["ev-fruit", "ev-duke"],
    };
    for (const claims of [
      [supported, partial],
      [partial, supported],
    ]) {
      expect(
        ids(withoutRestatements(claims, [], [], evidence, { track: juicy }).claims).sort(),
      ).toEqual(["m-card", "m-plain"]);
    }
  });
});

// The cases each of the rules below was written for: each one stays, or goes, as said. A claim
// goes only when the whole of it is one of the templates of relationText.ts; anything else is
// read in doubt: it stays, judged as it was, unmarked.
describe("a model claim on a relation, read word by word", () => {
  const sampledByRecord = record(
    "ev-sby",
    "track/recording/j1/sampled-by/recording/q1",
    'MusicBrainz: "Juicy" by The Notorious B.I.G. is sampled in "Big Poppa Remix" by Someone Else.',
  );
  const shoutRecord = record(
    "ev-shout",
    "track/recording/s1/samples/recording/t1",
    'MusicBrainz: "Track" by Someone samples "Shout" by Tears for Fears.',
  );
  const coverMeRecord = record(
    "ev-coverme",
    "track/recording/h1/cover-of/recording/s1",
    'MusicBrainz: "Hung Up" by Madonna is a cover of "Cover Me" by Bruce Springsteen.',
  );
  const standRecord = record(
    "ev-stand",
    "track/recording/h1/samples/recording/s2",
    'MusicBrainz: "Hung Up" by Madonna samples "Stand by Me" by Ben E. King.',
  );
  const circoRecord = record(
    "ev-circo",
    "track/recording/o1/sampled-by/recording/c1",
    'MusicBrainz: "One More Time" by Daft Punk is sampled in "Circo Loco" by Drake & 21 Savage.',
  );
  const all = [...evidence, sampledByRecord, shoutRecord, coverMeRecord, standRecord, circoRecord];
  const code = [
    codeAbba,
    codeRemix,
    codeFruit,
    codeDuke,
    codeCover,
    codeClaim("code-sby", sampledByRecord, { about: "sample" }),
    codeClaim("code-shout", shoutRecord, { about: "sample" }),
    codeClaim("code-coverme", coverMeRecord, { about: "cover" }),
    codeClaim("code-stand", standRecord, { about: "sample" }),
    codeClaim("code-circo", circoRecord, { about: "sample" }),
  ];
  const tracks: Record<string, { title: string; artist: string }> = {
    "ev-abba": hungUp,
    "ev-remix": hungUp,
    "ev-coverme": hungUp,
    "ev-stand": hungUp,
    "ev-fruit": juicy,
    "ev-duke": juicy,
    "ev-sby": juicy,
    "ev-shout": { title: "Track", artist: "Someone" },
    "ev-cover": omt,
    "ev-circo": omt,
  };
  /**
   * What becomes of a model claim with `text` on `cited`, at `verdict`: it goes, or it stays
   * (marked or not). `stated`: a timeline sample states it, so it stays, and its mark shows.
   */
  const read = (
    text: string,
    cited: string[],
    verdict: "supported" | "partial",
    { stated = false, pack = all } = {},
  ) => {
    const about = cited[0] === "ev-cover" || cited[0] === "ev-coverme" ? "cover" : "sample";
    const scope = cited[0] === "ev-cover" ? "work" : "recording";
    const claim = judged("m-1", { text, about, scope, verdict, evidenceIds: cited });
    const kept = withoutRestatements(
      [claim, ...code],
      [],
      stated ? [{ claimId: "m-1" }] : [],
      pack,
      { track: tracks[cited[0]] },
    );
    const left = kept.claims.find((each) => each.id === "m-1");
    if (!left) return "goes";
    return left.documentedBy === undefined ? "stays" : `stays, marked ${left.documentedBy}`;
  };
  const both = ["supported", "partial"] as const;

  it("goes when the whole of it states its record's relation, in the record's direction", () => {
    for (const verdict of both) {
      for (const [text, cited] of [
        ["Juicy samples Juicy Fruit by Mtume.", "ev-fruit"],
        ["This recording samples Mtume’s “Juicy Fruit”.", "ev-fruit"],
        ["The Notorious B.I.G.’s Juicy sampled Juicy Fruit.", "ev-fruit"],
        ["Juicy does sample Juicy Fruit.", "ev-fruit"],
        ["Juicy is sampled in Big Poppa Remix by Someone Else.", "ev-sby"],
        ["Juicy was sampled by Big Poppa Remix.", "ev-sby"],
        ["Big Poppa Remix by Someone Else samples Juicy.", "ev-sby"],
        ["Hung Up samples ABBA.", "ev-abba"],
        ["Hung Up is a cover of Cover Me by Bruce Springsteen.", "ev-coverme"],
        ["Hung Up samples Stand by Me by Ben E. King.", "ev-stand"],
        ["Hung Up samples Stand by Me.", "ev-stand"],
        ["One More Time is sampled in Circo Loco by Drake.", "ev-circo"],
        ["One More Time is sampled in Drake's Circo Loco.", "ev-circo"],
        ["One More Time is sampled in Circo Loco by Drake and 21 Savage.", "ev-circo"],
        ["The song One More Time is covered by The London Elektricity Big Band.", "ev-cover"],
      ]) {
        expect(read(text, [cited], verdict), `${verdict}: ${text}`).toBe("goes");
      }
    }
  });

  it("stays, unmarked, when it reads the relation the other way round, or cannot be read so", () => {
    for (const verdict of both) {
      for (const [text, cited] of [
        ["Juicy Fruit by Mtume samples Juicy by The Notorious B.I.G.", "ev-fruit"],
        ["Juicy is sampled by Mtume.", "ev-fruit"],
        ["Juicy is sampled in Juicy Fruit.", "ev-fruit"],
        ["Juicy samples Big Poppa Remix by Someone Else.", "ev-sby"],
        [
          'Gimme! Gimme! Gimme! (A Man After Midnight) by ABBA samples "Hung Up" by Madonna.',
          "ev-abba",
        ],
        ["ABBA sampling Madonna: Hung Up.", "ev-abba"],
        ["Cover Me by Bruce Springsteen covers Hung Up.", "ev-coverme"],
        // A relative clause or a comma clause between a name and the verb.
        ["Big Poppa Remix by Someone Else is the track that Juicy samples.", "ev-sby"],
        ["Big Poppa Remix by Someone Else is the funk track that Juicy samples.", "ev-sby"],
        ["Juicy Fruit by Mtume is the track that Juicy samples.", "ev-fruit"],
        ["Juicy Fruit by Mtume, which Juicy samples, is a funk song.", "ev-fruit"],
        ["Juicy, whose producer liked Mtume, samples Juicy Fruit.", "ev-fruit"],
        // "has X sampled in it", an adverb before "by" or "in", "on" or "into" after the verb.
        ["ABBA has Hung Up sampled in it.", "ev-abba"],
        ["Hung Up has ABBA sampled in it.", "ev-abba"],
        ["Hung Up was sampled heavily by ABBA.", "ev-abba"],
        ["Hung Up was itself sampled by ABBA.", "ev-abba"],
        ["Hung Up is used in ABBA's Gimme! Gimme! Gimme! as a sample.", "ev-abba"],
        ["Hung Up was sampled on ABBA's Gimme! Gimme! Gimme!.", "ev-abba"],
        ["One More Time was sampled on Circo Loco.", "ev-circo"],
        ["One More Time was sampled into Circo Loco.", "ev-circo"],
        ["Circo Loco was later sampled in One More Time.", "ev-circo"],
      ]) {
        expect(read(text, [cited], verdict), `${verdict}: ${text}`).toBe("stays");
      }
    }
  });

  it("stays, unmarked, when it states another relation, hedges or denies it, or says more", () => {
    for (const verdict of both) {
      for (const [text, cited] of [
        ['"Hung Up (SDP extended vocal)" samples "Hung Up" by Madonna.', "ev-remix"],
        ["Hung Up interpolates Gimme! Gimme! Gimme! by ABBA.", "ev-abba"],
        ["Juicy does not sample Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy doesn't sample Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy never sampled Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy samples nothing; Juicy Fruit by Mtume samples Juicy.", "ev-fruit"],
        ["Hung Up allegedly samples ABBA.", "ev-abba"],
        ["Hung Up is rumoured to sample ABBA.", "ev-abba"],
        ["Hung Up is often wrongly said to sample ABBA.", "ev-abba"],
        ["Hung Up reportedly samples ABBA.", "ev-abba"],
        // A word that holds, or starts with, the relation's word is not it.
        ["Juicy resamples Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy samples Mtume’s sampler.", "ev-fruit"],
        ["Hung Up is a coverage of Cover Me by Bruce Springsteen.", "ev-coverme"],
        ["Hung Up (SDP extended vocal) is a remixer of Hung Up.", "ev-remix"],
        ["Notably, Hung Up samples ABBA.", "ev-abba"],
        // The base form alone ("sample:"), and the record named on the track's side too.
        ["Juicy — sample: Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy Fruit and Juicy sampled Juicy Fruit by Mtume.", "ev-fruit"],
        ["Hung Up and ABBA's Gimme! Gimme! Gimme!.", "ev-abba"],
        ["Track samples Shout by will.i.am.", "ev-shout"],
        ["Hung Up samples Stand by Me by John Lennon.", "ev-stand"],
        [
          "Juicy samples the bass line and chorus of Juicy Fruit by Mtume, slowed down.",
          "ev-fruit",
        ],
        ["Juicy samples the instrumental extended mix of Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy samples Juicy Fruit by Mtume and a drum break by will.i.am.", "ev-fruit"],
        ["Juicy samples a live version of Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy samples Mtume's 1983 hit Juicy Fruit.", "ev-fruit"],
        ["Biggie's Juicy samples Juicy Fruit.", "ev-fruit"],
        // A cover of the song named without its title.
        ["Daft Punk is covered by The London Elektricity Big Band.", "ev-cover"],
      ]) {
        expect(read(text, [cited], verdict), `${verdict}: ${text}`).toBe("stays");
        expect(read(text, [cited], verdict, { stated: true }), `${verdict}: ${text}`).toBe("stays");
      }
    }
  });

  it("stays when it cites two records and names one", () => {
    for (const verdict of both) {
      expect(
        read("This recording samples Mtume’s “Juicy Fruit”.", ["ev-fruit", "ev-duke"], verdict),
        verdict,
      ).toBe("stays");
    }
  });

  it("is marked with the code claims of its records when it stays and states only their relations", () => {
    expect(
      read("Juicy samples Juicy Fruit by Mtume.", ["ev-fruit"], "partial", { stated: true }),
    ).toBe("stays, marked code-fruit");
    expect(
      read(
        "This recording samples Mtume’s “Juicy Fruit” and “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
        ["ev-fruit", "ev-duke"],
        "supported",
        { stated: true },
      ),
    ).toBe("stays, marked code-fruit,code-duke");
  });

  it("reads a negation or a relation word inside a name as part of the name", () => {
    const named = (title: string, artist: string, text: string) => {
      const item = record(
        "ev-s",
        "track/recording/t/samples/recording/o",
        `MusicBrainz: "Song" by Artist samples "${title}" by ${artist}.`,
      );
      return ids(
        withoutRestatements(
          [
            judged("m-1", { text, about: "sample", verdict: "partial", evidenceIds: ["ev-s"] }),
            codeClaim("code-s", item, { about: "sample" }),
          ],
          [],
          [],
          [item],
          { track: { title: "Song", artist: "Artist" } },
        ).claims,
      );
    };
    for (const [title, artist, text] of [
      ["No Scrubs", "TLC", "Song samples No Scrubs by TLC."],
      ["Without Me", "Eminem", "Song samples Without Me by Eminem."],
      ["Ain't No Sunshine", "Bill Withers", "Song samples Ain't No Sunshine by Bill Withers."],
      ["Never Too Much", "Luther Vandross", "Song samples Never Too Much."],
      ["Cover Girl", "Someone", "Song samples Cover Girl by Someone."],
    ]) {
      expect(named(title, artist, text), text).toEqual(["code-s"]);
    }
    expect(named("No Scrubs", "TLC", "Song never sampled No Scrubs by TLC."), "never").toEqual([
      "m-1",
      "code-s",
    ]);
    // In the analysed track's title, too.
    const never = record(
      "ev-never",
      "track/recording/n1/samples/recording/f1",
      'MusicBrainz: "Never Gonna Give You Up" by Rick Astley samples "Funk Groove" by The Band.',
    );
    const run = (text: string) =>
      ids(
        withoutRestatements(
          [
            judged("m-1", { text, about: "sample", verdict: "partial", evidenceIds: ["ev-never"] }),
            codeClaim("code-never", never, { about: "sample" }),
          ],
          [],
          [],
          [never],
          { track: { title: "Never Gonna Give You Up", artist: "Rick Astley" } },
        ).claims,
      );
    expect(run("Never Gonna Give You Up samples Funk Groove by The Band.")).toEqual(["code-never"]);
    expect(run("Never Gonna Give You Up never sampled Funk Groove by The Band.")).toEqual([
      "m-1",
      "code-never",
    ]);
  });

  it("names a record by its title, or by an artist no other record of the result credits", () => {
    for (const title of ["It", "Sample", "A", "Cover"]) {
      const item = record(
        "ev-it",
        "track/recording/h1/samples/recording/i1",
        `MusicBrainz: "Hung Up" by Madonna samples "${title}" by The Band.`,
      );
      const run = (text: string) =>
        ids(
          withoutRestatements(
            [
              judged("m-1", { text, about: "sample", verdict: "partial", evidenceIds: ["ev-it"] }),
              codeClaim("code-it", item, { about: "sample" }),
            ],
            [],
            [],
            [item],
            { track: hungUp },
          ).claims,
        );
      // A title that tells nothing apart names nothing.
      expect(run(`Hung Up samples ${title.toLowerCase()}.`), title).toEqual(["m-1", "code-it"]);
      expect(run(`Hung Up samples ${title} by The Band.`), title).toEqual(["m-1", "code-it"]);
      expect(run("Hung Up samples a cover."), title).toEqual(["m-1", "code-it"]);
      // Its artist, the only one of the result, does.
      expect(run("Hung Up samples The Band."), title).toEqual(["code-it"]);
    }
    // Another record by the same artist, in the pack or on the map: the artist alone names none.
    const queen = record(
      "ev-queen",
      "track/recording/h1/samples/recording/q9",
      'MusicBrainz: "Hung Up" by Madonna samples "Dancing Queen" by ABBA.',
    );
    expect(read("Hung Up samples ABBA.", ["ev-abba"], "partial", { pack: [...all, queen] })).toBe(
      "stays",
    );
    const drawn = withoutRestatements(
      [
        judged("m-1", {
          text: "Hung Up samples ABBA.",
          about: "sample",
          verdict: "partial",
          evidenceIds: ["ev-abba"],
        }),
        codeAbba,
      ],
      [],
      [],
      all,
      {
        track: hungUp,
        genealogy: {
          nodes: [{ id: "current" }, { id: "dq", label: "Dancing Queen - ABBA" }],
          links: [],
        },
      },
    );
    expect(ids(drawn.claims)).toEqual(["m-1", "code-abba"]);
    // Two records with one title, by different artists, both cited: the title alone names
    // neither of them.
    const richie = record(
      "ev-richie",
      "track/recording/x1/samples/recording/l1",
      'MusicBrainz: "Track Ten" by Some Band samples "Hello" by Lionel Richie.',
    );
    const adele = record(
      "ev-adele",
      "track/recording/x1/samples/recording/a1",
      'MusicBrainz: "Track Ten" by Some Band samples "Hello" by Adele.',
    );
    const hellos = (text: string) =>
      ids(
        withoutRestatements(
          [
            judged("m-1", { text, about: "sample", evidenceIds: ["ev-richie", "ev-adele"] }),
            codeClaim("code-richie", richie, { about: "sample" }),
            codeClaim("code-adele", adele, { about: "sample" }),
          ],
          [],
          [],
          [richie, adele],
          { track: { title: "Track Ten", artist: "Some Band" } },
        ).claims,
      );
    expect(hellos("Track Ten samples Hello.")).toEqual(["m-1", "code-richie", "code-adele"]);
    expect(hellos("Track Ten samples Hello by Lionel Richie and Hello by Adele.")).toEqual([
      "code-richie",
      "code-adele",
    ]);
    // With no analysed track given, the record's own side names it: its title and artist.
    expect(
      ids(
        withoutRestatements(
          [
            judged("m-1", {
              text: "Juicy samples Mtume’s Juicy Fruit.",
              about: "sample",
              verdict: "partial",
              evidenceIds: ["ev-fruit"],
            }),
            codeFruit,
          ],
          [],
          [],
          evidence,
        ).claims,
      ),
    ).toEqual(["code-fruit"]);
    // Drake credits another record of the result: "Drake" alone names neither.
    const other = record(
      "ev-drake",
      "track/recording/o1/sampled-by/recording/d2",
      'MusicBrainz: "One More Time" by Daft Punk is sampled in "Other Song" by Drake.',
    );
    expect(read("One More Time is sampled in Drake.", ["ev-circo"], "partial")).toBe("goes");
    expect(
      read("One More Time is sampled in Drake.", ["ev-circo"], "partial", {
        pack: [...all, other],
      }),
    ).toBe("stays");
    expect(
      read("One More Time is sampled in Circo Loco by Drake.", ["ev-circo"], "partial", {
        pack: [...all, other],
      }),
    ).toBe("goes");
  });

  it("reads names without accents, tonos, ß or the dotless ı, and a title without its subtitle", () => {
    const chiLites = record(
      "ev-chi",
      "track/recording/c1/samples/recording/w1",
      'MusicBrainz: "Crazy in Love" by Beyoncé samples "Are You My Woman? (Tell Me So)" by The Chi-Lites.',
    );
    const crazy = { title: "Crazy in Love", artist: "Beyoncé" };
    for (const text of [
      "Beyonce’s Crazy in Love samples Are You My Woman? (Tell Me So).",
      "Crazy in Love samples “Are You My Woman”.",
      "Crazy in Love samples Are You My Woman by The Chi-Lites.",
    ]) {
      const kept = withoutRestatements(
        [
          judged("m-1", { text, about: "sample", verdict: "partial", evidenceIds: ["ev-chi"] }),
          codeClaim("code-chi", chiLites, { about: "sample" }),
        ],
        [],
        [],
        [chiLites],
        { track: crazy },
      );
      expect(ids(kept.claims), text).toEqual(["code-chi"]);
    }
    const named = (title: string, artist: string, text: string) => {
      const item = record(
        "ev-s",
        "track/recording/t/samples/recording/o",
        `MusicBrainz: "Song" by Artist samples "${title}" by ${artist}.`,
      );
      return ids(
        withoutRestatements(
          [
            judged("m-1", { text, about: "sample", verdict: "partial", evidenceIds: ["ev-s"] }),
            codeClaim("code-s", item, { about: "sample" }),
          ],
          [],
          [],
          [item],
          { track: { title: "Song", artist: "Artist" } },
        ).claims,
      );
    };
    for (const [title, artist, text] of [
      ["Ρόδα", "Μίκης", "Song samples Ροδα by Μικης."],
      ["Straße", "Kraftwerk", "Song samples Strasse by Kraftwerk."],
      ["Işık", "Sezen", "Song samples Isik by Sezen."],
      ["Elevation", "U2", "Song samples U2."],
      ["Lean On", "MØ", "Song samples MØ."],
    ]) {
      expect(named(title, artist, text), text).toEqual(["code-s"]);
    }
    // A mark that changes a letter in another script is kept: "Й" is not "И".
    expect(named("Песня", "Йолка", "Song samples Песня by Иолка.")).toEqual(["m-1", "code-s"]);
  });

  it("names the analysed track's names only in a claim on a relation, never in a credit", () => {
    const kept = (text: string) =>
      ids(
        withoutRestatements(
          [judged("m-1", { text, about: "credit", evidenceIds: ["ev-credit"] }), codeCredit],
          [],
          [],
          [credit],
          { track: hungUp },
        ).claims,
      );
    for (const text of [
      "Madonna and Stuart Price produced Hung Up.",
      "Stuart Price produced Hung Up for Madonna.",
    ]) {
      expect(kept(text), text).toEqual(["m-1", "code-credit"]);
    }
    expect(kept("Stuart Price produced Hung Up.")).toEqual(["code-credit"]);
  });

  it("never reads a hedged or denied claim as restating its record, whatever its subject", () => {
    const kept = (text: string) =>
      ids(
        withoutRestatements(
          [judged("m-1", { text, about: "credit", evidenceIds: ["ev-credit"] }), codeCredit],
          [],
          [],
          [credit],
          { track: hungUp },
        ).claims,
      );
    for (const hedge of [
      "nothing",
      "none",
      "neither",
      "nor",
      "without",
      "never",
      "not",
      "no",
      "cannot",
      "allegedly",
      "reportedly",
      "rumoured",
      "rumored",
      "supposedly",
      "wrongly",
      "falsely",
      "mistakenly",
      "claimed",
      "disputed",
      "often said",
    ]) {
      expect(kept(`Stuart Price ${hedge} produced Hung Up.`), hedge).toEqual([
        "m-1",
        "code-credit",
      ]);
    }
    expect(kept("Stuart Price didn't produce Hung Up.")).toEqual(["m-1", "code-credit"]);
    // A negation inside a name its record quotes is part of the name.
    const scrubs: Evidence = {
      ...credit,
      id: "ev-scrubs",
      excerpt:
        'Discogs release 99 ("FanMail", 1999) credits Kandi Burruss as Writer on "No Scrubs".',
    };
    const codeScrubs = codeClaim("code-scrubs", scrubs, { about: "credit", text: scrubs.excerpt });
    expect(
      ids(
        withoutRestatements(
          [
            judged("m-1", {
              text: "Kandi Burruss wrote No Scrubs.",
              about: "credit",
              evidenceIds: ["ev-scrubs"],
            }),
            codeScrubs,
          ],
          [],
          [],
          [scrubs],
          { track: { title: "No Scrubs", artist: "TLC" } },
        ).claims,
      ),
    ).toEqual(["code-scrubs"]);
  });

  it("marks only what states its record's relation, and reads a mark it came with again", () => {
    const stale = judged("m-1", {
      text: "The recording samples ABBA’s “Voulez-Vous”.",
      about: "sample",
      evidenceIds: ["ev-abba"],
      documentedBy: ["code-abba"],
    });
    const kept = withoutRestatements([stale, codeAbba], [], [], evidence, { track: hungUp });
    expect(kept.claims[0]).toEqual({ ...stale, documentedBy: undefined });
    expect("documentedBy" in kept.claims[0]).toBe(false);
  });
});

describe("documentedRelation on Genius and SecondHandSongs records", () => {
  it("reads their refs and excerpts, a SecondHandSongs date left out", () => {
    expect(
      documentedRelation({
        recordRef: "track/song/123/samples/456",
        excerpt: 'Genius: the song "Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume.',
      }),
    ).toEqual({ kind: "samples", title: "Juicy Fruit", artist: "Mtume" });
    expect(
      documentedRelation({
        recordRef: "work/song/50429/samples/2248838",
        excerpt:
          'Genius: the song "Bitter Sweet Symphony" by The Verve samples "The Last Time" by The Andrew Oldham Orchestra.',
      }),
    ).toEqual({ kind: "samples", title: "The Last Time", artist: "The Andrew Oldham Orchestra" });
    expect(
      documentedRelation({
        recordRef: "work/performance/10/covered-by/13",
        excerpt:
          'SecondHandSongs: "Ice Ice Baby" by Vanilla Ice is covered by "Ice Ice Baby" by Glee Cast (2010).',
      }),
    ).toEqual({ kind: "covered-by", title: "Ice Ice Baby", artist: "Glee Cast" });
  });

  it("reads a record with no artist, and none from an excerpt it cannot tell apart", () => {
    expect(
      documentedRelation({
        recordRef: "track/recording/j1/samples/work/w9",
        excerpt: 'MusicBrainz: "Juicy" by The Notorious B.I.G. samples "Juicy Fruit".',
      }),
    ).toEqual({ kind: "samples", title: "Juicy Fruit", artist: null });
    // A title that holds the relation's phrase: which phrase is the record's cannot be told.
    for (const excerpt of [
      'MusicBrainz: "Free" by D samples "Free samples "now"" by D.',
      'MusicBrainz: "A samples "B" by C" by D samples "E" by F.',
    ]) {
      expect(
        documentedRelation({ recordRef: "track/recording/f1/samples/recording/n1", excerpt }),
        excerpt,
      ).toBeNull();
    }
  });

  it("shows two of the model's copies on a Genius record once", () => {
    const genius: Evidence = {
      ...trackRecord(
        "ev-genius",
        'Genius: the song "Juicy" by The Notorious B.I.G. samples "Juicy Fruit" by Mtume.',
      ),
      source: "genius",
      recordRef: "track/song/123/samples/456",
    };
    const copies = [
      judged("m-a", {
        text: "This recording samples Mtume’s “Juicy Fruit”.",
        about: "sample",
        evidenceIds: ["ev-genius"],
      }),
      judged("m-b", {
        text: "The recording samples “Juicy Fruit” by Mtume.",
        about: "sample",
        evidenceIds: ["ev-genius"],
      }),
    ];
    for (const claims of [copies, [...copies].reverse()]) {
      expect(ids(withoutRestatements(claims, [], [], [genius], { track: juicy }).claims)).toEqual([
        "m-a",
      ]);
    }
  });

  it("reads a record of the song with no artist as the relation a claim states", () => {
    const work = record(
      "ev-work",
      "track/recording/j1/samples/work/w9",
      'MusicBrainz: "Juicy" by The Notorious B.I.G. samples "Juicy Fruit".',
    );
    const kept = withoutRestatements(
      [
        judged("m-1", {
          text: "Juicy samples Juicy Fruit.",
          about: "sample",
          verdict: "partial",
          evidenceIds: ["ev-work"],
        }),
        codeClaim("code-work", work, { about: "sample" }),
      ],
      [],
      [],
      [work],
      { track: juicy },
    );
    expect(ids(kept.claims)).toEqual(["code-work"]);
  });
});

describe("the model's copies of a relation no code-built claim states", () => {
  const popcornRecord = record(
    "ev-popcorn",
    "track/recording/h1/samples/recording/p1",
    'MusicBrainz: "Hung Up" by Madonna samples "Popcorn" by Hot Butter.',
  );
  const pack = [...evidence, popcornRecord];

  it("keep a relation another claim only cites, and does not state", () => {
    const kept = judged("m-abba", {
      text: "Hung Up samples ABBA's Gimme! Gimme! Gimme!.",
      about: "sample",
      evidenceIds: ["ev-abba", "ev-popcorn"],
      factoid: { title: "An ABBA hook", type: "sample", entities: [] },
    });
    for (const copy of [
      judged("m-copy", {
        text: "Hung Up samples Popcorn by Hot Butter.",
        about: "sample",
        evidenceIds: ["ev-popcorn"],
      }),
      judged("m-copy", {
        text: "Hung Up is remixed in Hung Up (SDP extended vocal).",
        about: "sample",
        evidenceIds: ["ev-remix"],
      }),
    ]) {
      const both = { ...kept, evidenceIds: [...new Set(["ev-abba", ...copy.evidenceIds])] };
      for (const claims of [
        [both, copy],
        [copy, both],
      ]) {
        const out = withoutRestatements(claims, [card("m-abba")], [], pack, { track: hungUp });
        expect(ids(out.claims).sort(), copy.text).toEqual(["m-abba", "m-copy"]);
      }
    }
  });

  it("never leave a copy out for a rejected one", () => {
    const rejected = judged("m-rej", {
      text: "Hung Up samples ABBA's Gimme! Gimme! Gimme!, twice as fast.",
      about: "sample",
      evidenceIds: ["ev-abba"],
      numericCheck: "contradicted",
    });
    const good = judged("m-good", {
      text: "Hung Up samples ABBA's Gimme! Gimme! Gimme!.",
      about: "sample",
      evidenceIds: ["ev-abba"],
    });
    for (const claims of [
      [rejected, good],
      [good, rejected],
    ]) {
      expect(
        ids(withoutRestatements(claims, [], [], pack, { track: hungUp }).claims).sort(),
      ).toEqual(["m-good", "m-rej"]);
    }
    // Nor for a rejected copy of its text that would otherwise come first (its id).
    const copy = { ...good, id: "m-a", numericCheck: "contradicted" as const };
    for (const claims of [
      [copy, good],
      [good, copy],
    ]) {
      expect(
        ids(withoutRestatements(claims, [], [], pack, { track: hungUp }).claims).sort(),
      ).toEqual(["m-a", "m-good"]);
    }
  });

  it("keep both when one says more or reads the other way, whatever their order", () => {
    const bare = judged("m-a", {
      text: "Hung Up samples ABBA.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-abba"],
    });
    // Read in doubt: it states nothing for certain, so it covers nothing.
    const more = judged("m-b", {
      text: "Hung Up samples ABBA, turning the riff into a dance-floor hook.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-abba"],
    });
    const reversed = judged("m-c", {
      text: "Gimme! Gimme! Gimme! by ABBA samples Hung Up.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-abba"],
    });
    for (const other of [more, reversed]) {
      for (const claims of [
        [bare, other],
        [other, bare],
      ]) {
        expect(
          ids(withoutRestatements(claims, [], [], pack, { track: hungUp }).claims).sort(),
          other.text,
        ).toEqual(["m-a", other.id]);
      }
    }
  });

  it("keep the copy that states more records, whatever their ids", () => {
    const one = judged("m-a", {
      text: "Hung Up samples ABBA.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-abba"],
    });
    const two = judged("m-b", {
      text: "Hung Up samples ABBA and Popcorn by Hot Butter.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-abba", "ev-popcorn"],
    });
    for (const claims of [
      [one, two],
      [two, one],
    ]) {
      expect(ids(withoutRestatements(claims, [], [], pack, { track: hungUp }).claims)).toEqual([
        "m-b",
      ]);
    }
  });

  it("are kept the same whatever the order of the claims", () => {
    const texts = [
      "Hung Up samples ABBA.",
      "Hung Up samples Gimme! Gimme! Gimme! by ABBA.",
      "Hung Up samples ABBA, turning the riff into a hook.",
      "Hung Up samples Popcorn by Hot Butter.",
      "Hung Up samples ABBA and Popcorn by Hot Butter.",
      "Hung Up is remixed in Hung Up (SDP extended vocal).",
      "Gimme! Gimme! Gimme! by ABBA samples Hung Up.",
    ];
    const cites = [["ev-abba"], ["ev-popcorn"], ["ev-abba", "ev-popcorn"], ["ev-remix"]];
    const verdicts = ["supported", "partial", "unsupported", null] as const;
    // A fixed seed: the same sets and orders on every run.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let trial = 0; trial < 300; trial++) {
      const claims = Array.from({ length: 2 + next(5) }, (_, i) => {
        const verdict = verdicts[next(verdicts.length)];
        return judged(`m-${i}`, {
          text: texts[next(texts.length)],
          about: "sample",
          verdict,
          kind: verdict === "supported" ? "sourced" : "inferred",
          evidenceIds: cites[next(cites.length)],
          ...(next(4) === 0 ? { factoid: { title: "Card", type: "sample", entities: [] } } : {}),
        });
      });
      const code = next(2) === 0 ? [codeAbba] : [];
      const run = (order: Claim[]) =>
        ids(
          withoutRestatements([...order, ...code], [], [], pack, { track: hungUp }).claims,
        ).sort();
      const first = run(claims);
      for (let shuffle = 0; shuffle < 4; shuffle++) {
        const order = [...claims];
        for (let i = order.length - 1; i > 0; i--) {
          const j = next(i + 1);
          [order[i], order[j]] = [order[j], order[i]];
        }
        expect(run(order), JSON.stringify(claims.map((c) => [c.text, c.verdict]))).toEqual(first);
      }
    }
  });
});

describe("the step on many claims", () => {
  it("reads 500 claims on records with long titles in well under a second each", () => {
    // At most about 0.2 s of CPU time each; reading a claim's records again for each other claim
    // it is compared with took 16 s on the last.
    const title = Array.from({ length: 400 }, (_, i) => `Word${i}`)
      .join(" ")
      .slice(0, 2400);
    const item = record(
      "ev-long",
      "track/recording/h1/samples/recording/l1",
      `MusicBrainz: "Hung Up" by Madonna samples "${title}" by ABBA.`,
    );
    const claims = Array.from({ length: 500 }, (_, i) =>
      judged(`m-${i}`, {
        text: `Hung Up samples ${title} by ABBA${i % 2 === 0 ? ", a hook" : ""}.`,
        about: "sample",
        verdict: "partial",
        evidenceIds: ["ev-long"],
      }),
    );
    const code = codeClaim("code-long", item, { about: "sample" });
    // And 500 claims, each on a record of its own: none states another's relation.
    const tail = " lorem ipsum".repeat(200);
    const items = Array.from({ length: 500 }, (_, i) =>
      record(
        `ev-${i}`,
        `track/recording/h1/samples/recording/r${i}`,
        `MusicBrainz: "Hung Up${tail}" by Madonna samples "Title ${i} Words${tail}" by Artist ${i}.`,
      ),
    );
    // Each says only what its record says, so each is compared with every other one.
    const apart = Array.from({ length: 500 }, (_, i) =>
      judged(`m-${i}`, {
        text: `Hung Up samples Title ${i} Words by Artist ${i}.`,
        about: "sample",
        verdict: "partial",
        evidenceIds: [`ev-${i}`],
      }),
    );
    const { ms: apartMs, result: apartResult } = timed(
      () => withoutRestatements(apart, [], [], items, { track: hungUp }),
      { runs: 2, stopAboveMs: 5_000, clock: threadCpuMs },
    );
    expect(apartMs).toBeLessThan(1_500);
    expect(apartResult.claims).toHaveLength(500);
    // And 500 claims on one of those records, each naming its artist and a word of its own.
    const together = apart.map((claim, i) => ({
      ...claim,
      text: `Hung Up samples Artist 0 ${"x".repeat(i % 7)} ${i}`,
      evidenceIds: ["ev-0"],
    }));
    const { ms: togetherMs, result: togetherResult } = timed(
      () => withoutRestatements(together, [], [], items, { track: hungUp }),
      { runs: 2, stopAboveMs: 5_000, clock: threadCpuMs },
    );
    expect(togetherMs).toBeLessThan(1_500);
    expect(togetherResult.claims).toHaveLength(500);
    for (const [all, left] of [
      [claims, 2],
      [[...claims, code], 1],
    ] as const) {
      const { ms, result } = timed(
        () => withoutRestatements(all, [], [], [item], { track: hungUp }),
        { runs: 2, stopAboveMs: 5_000, clock: threadCpuMs },
      );
      expect(ms).toBeLessThan(1_500);
      // One copy of the claim that says more stays (copies of one text); the ones that say only
      // the record's words go, but for the best of them when no code-built claim states it.
      expect(result.claims.filter((claim) => claim.origin === "model")).toHaveLength(left);
    }
  });
});

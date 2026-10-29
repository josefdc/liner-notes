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
        nodes: [{ id: "current" }, { id: "c-node" }, { id: "m-node" }],
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
    // The link that draws the record's relation, as the code link does, goes with its claim.
    const gone = run(model);
    expect(ids(gone.claims)).toEqual(["code-fruit"]);
    expect(gone.genealogy?.links).toEqual([coded]);
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
    // The one that states its record's relation is marked with the code claim that documents it;
    // the others are as they were.
    expect(kept.claims[0]).toEqual({ ...claims[0], documentedBy: ["code-abba"] });
    for (const [i, claim] of kept.claims.entries()) if (i > 0) expect(claim).toBe(claims[i]);
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
    text: "This recording samples Mtume’s “Juicy Fruit,” linking the track to the earlier song.",
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

  it("both stay when the one that says more names what its records do not", () => {
    // "Biggie" is in no record: nothing shows the card's claim states the record's relation.
    const biggie = { ...carded, text: carded.text.replace("the track", "Biggie’s track") };
    const kept = withoutRestatements([plain, biggie], [card("m-card")], [], evidence, {
      track: juicy,
    });
    expect(ids(kept.claims)).toEqual(["m-plain", "m-card"]);
    expect(kept.restated).toBe(0);
  });

  it("both stay when the one that would go says more, reads as another kind or another relation", () => {
    // The better copy (now the one on a card) says only what the record says; the other names
    // what the record does not ("Biggie").
    const { factoid, ...uncarded } = {
      ...carded,
      text: carded.text.replace("the track", "Biggie’s track"),
    };
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

// The cases each of the rules below was written for: each one stays, or goes, as said.
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
  const all = [...evidence, sampledByRecord, shoutRecord];
  const codeSby = codeClaim("code-sby", sampledByRecord, { about: "sample" });
  const codeShout = codeClaim("code-shout", shoutRecord, { about: "sample" });
  const code = [codeAbba, codeRemix, codeFruit, codeDuke, codeSby, codeShout];
  const tracks: Record<string, { title: string; artist: string }> = {
    "ev-abba": hungUp,
    "ev-remix": hungUp,
    "ev-fruit": juicy,
    "ev-duke": juicy,
    "ev-sby": juicy,
    "ev-shout": { title: "Track", artist: "Someone" },
  };
  /** Whether a model claim with `text` on `cited`, at `verdict`, is left as it is or goes. */
  const read = (text: string, cited: string[], verdict: "supported" | "partial") => {
    const claim = judged("m-1", { text, about: "sample", verdict, evidenceIds: cited });
    const kept = withoutRestatements([claim, ...code], [], [], all, { track: tracks[cited[0]] });
    const left = kept.claims.find((each) => each.id === "m-1");
    if (!left) return "goes";
    return left.documentedBy === undefined ? "stays" : `stays, marked ${left.documentedBy}`;
  };

  it("stays when it states the relation the other way round", () => {
    for (const verdict of ["supported", "partial"] as const) {
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
      ]) {
        expect(read(text, [cited], verdict), `${verdict}: ${text}`).toBe("stays");
      }
    }
    // Read in the record's direction, it goes.
    for (const text of [
      "Juicy is sampled in Big Poppa Remix by Someone Else.",
      "Big Poppa Remix by Someone Else samples Juicy.",
    ]) {
      expect(read(text, ["ev-sby"], "partial"), text).toBe("goes");
    }
  });

  it("stays, unmarked, when it states another relation than its record's, or denies it", () => {
    for (const verdict of ["supported", "partial"] as const) {
      for (const [text, cited] of [
        ['"Hung Up (SDP extended vocal)" samples "Hung Up" by Madonna.', "ev-remix"],
        ["Hung Up interpolates Gimme! Gimme! Gimme! by ABBA.", "ev-abba"],
        ["Juicy does not sample Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy never sampled Juicy Fruit by Mtume.", "ev-fruit"],
        ["Juicy resamples Juicy Fruit by Mtume.", "ev-fruit"],
        ["Hung Up and ABBA's Gimme! Gimme! Gimme!.", "ev-abba"],
        ["Track samples Shout by will.i.am.", "ev-shout"],
      ]) {
        expect(read(text, [cited], verdict), `${verdict}: ${text}`).toBe("stays");
      }
      // A word that only starts as the relation's is a word of its own.
      expect(read("Juicy samples Mtume’s sampler.", ["ev-fruit"], verdict)).toMatch(/^stays/);
    }
  });

  it("stays, marked, when found supported but it says more than its record", () => {
    for (const text of [
      "Juicy samples the bass line and chorus of Juicy Fruit by Mtume, slowed down and looped.",
      "Juicy samples the instrumental extended mix of Juicy Fruit by Mtume.",
    ]) {
      expect(read(text, ["ev-fruit"], "supported"), text).toBe("stays, marked code-fruit");
    }
    expect(read("Juicy samples Juicy Fruit by Mtume.", ["ev-fruit"], "supported")).toBe("goes");
  });

  it("stays when it cites two records and names one", () => {
    for (const verdict of ["supported", "partial"] as const) {
      expect(
        read("This recording samples Mtume’s “Juicy Fruit”.", ["ev-fruit", "ev-duke"], verdict),
        verdict,
      ).toBe("stays");
    }
  });

  it("never reads a negation as the relation, even in the analysed track's title", () => {
    const never = record(
      "ev-never",
      "track/recording/n1/samples/recording/f1",
      'MusicBrainz: "Never Gonna Give You Up" by Rick Astley samples "Funk Groove" by The Band.',
    );
    const kept = withoutRestatements(
      [
        judged("m-1", {
          text: "Never Gonna Give You Up samples Funk Groove by The Band.",
          about: "sample",
          verdict: "partial",
          evidenceIds: ["ev-never"],
        }),
        codeClaim("code-never", never, { about: "sample" }),
      ],
      [],
      [],
      [never],
      { track: { title: "Never Gonna Give You Up", artist: "Rick Astley" } },
    );
    expect(ids(kept.claims)).toEqual(["m-1", "code-never"]);
  });

  it("names a record by its artist when its title tells nothing apart", () => {
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
      expect(run(`Hung Up samples ${title.toLowerCase()}.`), title).toEqual(["m-1", "code-it"]);
      expect(run("Hung Up samples a cover."), title).toEqual(["m-1", "code-it"]);
      expect(run(`Hung Up samples ${title} by The Band.`), title).toEqual(["code-it"]);
    }
  });

  it("reads names without accents, and a title with or without its subtitle", () => {
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
  });

  it("names the analysed track's names only in a claim on a relation, never in a credit", () => {
    const credit: Evidence = {
      ...trackRecord(
        "ev-credit",
        'Discogs release 1234 ("Confessions on a Dance Floor", 2005) credits Stuart Price as Producer on "Hung Up".',
      ),
      source: "discogs",
      recordRef: "track/release/1234/credit/stuart-price",
    };
    const codeCredit = codeClaim("code-credit", credit, { about: "credit", text: credit.excerpt });
    for (const text of [
      "Madonna and Stuart Price produced Hung Up.",
      "Stuart Price produced Hung Up for Madonna.",
    ]) {
      const kept = withoutRestatements(
        [judged("m-1", { text, about: "credit", evidenceIds: ["ev-credit"] }), codeCredit],
        [],
        [],
        [credit],
        { track: hungUp },
      );
      expect(ids(kept.claims), text).toEqual(["m-1", "code-credit"]);
    }
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

  it("keep the one that says more, whatever their order", () => {
    const bare = judged("m-a", {
      text: "Hung Up samples ABBA.",
      about: "sample",
      verdict: "partial",
      evidenceIds: ["ev-abba"],
    });
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
    for (const claims of [
      [bare, more],
      [more, bare],
    ]) {
      expect(ids(withoutRestatements(claims, [], [], pack, { track: hungUp }).claims)).toEqual([
        "m-b",
      ]);
    }
    // One that states the relation the other way round states another fact: both stay.
    for (const claims of [
      [bare, reversed],
      [reversed, bare],
    ]) {
      expect(
        ids(withoutRestatements(claims, [], [], pack, { track: hungUp }).claims).sort(),
      ).toEqual(["m-a", "m-c"]);
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
    for (const all of [claims, [...claims, code]]) {
      const { ms, result } = timed(
        () => withoutRestatements(all, [], [], [item], { track: hungUp }),
        { runs: 2, stopAboveMs: 5_000, clock: threadCpuMs },
      );
      expect(ms).toBeLessThan(1_500);
      // One copy of the claim that says more stays; the ones that say only the record's words go.
      expect(result.claims.filter((claim) => claim.origin === "model")).toHaveLength(1);
    }
  });
});

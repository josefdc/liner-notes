/**
 * withoutRestatements, on judged claims: which copy of a fact stays, what is never left out, and
 * the count.
 */

import type { Claim, Evidence } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { namesOnlyWhatItCites, statementKey, withoutRestatements } from "./restatements.js";
import { modelClaim, trackRecord } from "./verifier/testing.js";

const sampleRecord: Evidence = {
  ...trackRecord(
    "ev-sample",
    'MusicBrainz: "Ice Ice Baby" by Vanilla Ice samples "Under Pressure" by Queen.',
  ),
  recordRef: "track/recording/r1/samples/recording/r2",
};
const releaseRecord: Evidence = {
  ...trackRecord(
    "ev-release",
    'MusicBrainz: "Ice Ice Baby" by Vanilla Ice appears on the official album "To the Extreme" (1990-09-10).',
  ),
  recordRef: "release/r9",
};
const otherRecord: Evidence = trackRecord("ev-other");
const evidence = [sampleRecord, releaseRecord, otherRecord];

const judged = (id: string, change: Partial<Claim>): Claim =>
  modelClaim(id, { verdict: "supported", kind: "sourced", ...change });
const codeClaim = (id: string, item: Evidence, change: Partial<Claim>): Claim => ({
  ...modelClaim(id, {
    text: item.excerpt.replace(/^MusicBrainz:\s+/, ""),
    evidenceIds: [item.id],
    ...change,
  }),
  kind: "sourced",
  origin: "code",
});
const codeSample = codeClaim("code-sample", sampleRecord, { about: "sample" });
const codeRelease = codeClaim("code-release", releaseRecord, {
  about: "track",
  scope: "release",
});
type Card = { id: string; claimId?: string };
const card = (claimId: string): Card => ({ id: `card-${claimId}`, claimId });
const ids = (claims: readonly Claim[]) => claims.map((claim) => claim.id);

describe("statementKey", () => {
  it("reads a statement without case, quotes, apostrophes or sentence punctuation", () => {
    const same = [
      [
        "“One More Time” appears on Daft Punk’s album.",
        '"one more time" appears on Daft Punk\'s album',
      ],
      ["It runs, at last; in D minor!", "it runs at last in d minor"],
      // Compatibility forms read as their plain letters (NFKC).
      ["Ｄａｆｔ Ｐｕｎｋ", "Daft Punk"],
      ["The ﬁlter sweep", "The filter sweep"],
    ];
    for (const [a, b] of same) expect(statementKey(a), `${a} / ${b}`).toBe(statementKey(b));
  });

  it("keeps what changes a fact: accidentals, signs, percent and decimal separators", () => {
    const different = [
      ["It is in B♭ major.", "It is in B major."],
      ["It is in C# minor.", "It is in C minor."],
      ["It is in C♯ minor.", "It is in C minor."],
      ["The mix sits at -3 dB.", "The mix sits at 3 dB."],
      ["It sold 50% more.", "It sold 50 more."],
      ["It sold 1.500 copies.", "It sold 1,500 copies."],
      ["It runs at 1.5 times.", "It runs at 15 times."],
      ["One More Time.", "One More Time again."],
      // A chord or key name keeps its case: C-sharp minor is not C-sharp major, B-flat not B-B.
      ["It is in C#m.", "It is in C#M."],
      ["The bass plays Bb.", "The bass plays BB."],
      ["It moves to Am.", "It moves to AM."],
    ];
    for (const [a, b] of different)
      expect(statementKey(a), `${a} / ${b}`).not.toBe(statementKey(b));
  });
});

describe("namesOnlyWhatItCites", () => {
  it("counts a name in a script without case as a name", () => {
    const text = "The melody was written by 林哲司.";
    expect(namesOnlyWhatItCites(text, ["The melody was written by a session player."])).toBe(false);
    expect(namesOnlyWhatItCites(text, ["Written by 林哲司 in 1983."])).toBe(true);
    expect(namesOnlyWhatItCites("La chanson est de محمد.", ["La chanson."])).toBe(false);
  });
});

describe("withoutRestatements", () => {
  it("keeps a copy the judge found unsupported over an unjudged copy: its objection stays", () => {
    const text = "The hook was cut from a horn line.";
    // Past the judge's batch: no verdict.
    const unjudged = judged("m-card", {
      text,
      about: "trivia",
      verdict: null,
      kind: "inferred",
      evidenceIds: ["ev-other"],
      factoid: { title: "The hook", type: "trivia", entities: [] },
    });
    const unsupported = judged("m-checked", {
      text,
      about: "trivia",
      verdict: "unsupported",
      kind: "inferred",
      evidenceIds: ["ev-other"],
    });
    const kept = withoutRestatements([unjudged, unsupported], [card("m-card")], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-checked"]);
    expect(kept.claims[0].verdict).toBe("unsupported");
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
      // Each names only what the sample record names: only what the test varies keeps it.
      judged("m-more", {
        text: "Vanilla Ice samples Under Pressure.",
        about: "sample",
        evidenceIds: ["ev-sample", "ev-other"],
      }),
      judged("m-other", {
        text: "Ice Ice Baby samples Queen.",
        about: "sample",
        evidenceIds: ["ev-other"],
      }),
      judged("m-cover", {
        text: "Vanilla Ice samples Queen.",
        about: "cover",
        evidenceIds: ["ev-sample"],
      }),
      judged("m-scope", {
        text: "Ice Ice Baby samples Under Pressure by Queen.",
        about: "sample",
        scope: "work",
        evidenceIds: ["ev-sample"],
      }),
      judged("m-partial", {
        text: "Queen is sampled by Vanilla Ice.",
        about: "sample",
        verdict: "partial",
        evidenceIds: ["ev-sample"],
      }),
      judged("m-unjudged", {
        text: "Under Pressure is sampled by Ice Ice Baby.",
        about: "sample",
        verdict: null,
        evidenceIds: ["ev-sample"],
      }),
      judged("m-none", {
        text: "MusicBrainz lists Ice Ice Baby.",
        about: "sample",
        evidenceIds: [],
      }),
      codeSample,
    ];
    const kept = withoutRestatements(claims, [], [], evidence);
    expect(ids(kept.claims)).toEqual(ids(claims));
    expect(kept.restated).toBe(0);
  });

  it("keeps a supported model claim that names what its record does not (a label, a person)", () => {
    const more = judged("m-label", {
      text: "Vanilla Ice released Ice Ice Baby on SBK Records, produced by Earthquake.",
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const year = judged("m-year", {
      text: "Ice Ice Baby appears on To the Extreme, from 1991.",
      about: "track",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const kept = withoutRestatements([more, year, codeRelease], [], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-label", "m-year", "code-release"]);
  });

  it("reads a month by its number: a date the record states is no new information", () => {
    const dated = judged("m-dated", {
      text: "“Ice Ice Baby” appears on Vanilla Ice’s album To the Extreme, released September 10, 1990.",
      about: "credit",
      scope: "release",
      evidenceIds: ["ev-release"],
    });
    const kept = withoutRestatements([dated, codeRelease], [], [], evidence);
    expect(ids(kept.claims)).toEqual(["code-release"]);
  });

  it("never leaves out a rejected copy: it belongs in the rejected panel", () => {
    const contradicted = judged("m-no", {
      text: codeSample.text,
      about: "sample",
      verdict: "contradicted",
      kind: "inferred",
      evidenceIds: ["ev-sample"],
    });
    const twin = { ...contradicted, id: "m-no-2", verdict: "supported" as const };
    const kept = withoutRestatements([twin, contradicted, codeSample], [], [], evidence);
    // The supported twin restates the code claim; the contradicted copy stays.
    expect(ids(kept.claims)).toEqual(["m-no", "code-sample"]);
  });

  it("keeps a claim compared with a measured value, with or without a field", () => {
    const claims = [
      judged("m-checked", {
        text: "Vanilla Ice samples Queen.",
        about: "sample",
        numericCheck: "consistent",
        evidenceIds: ["ev-sample"],
      }),
      judged("m-field", { about: "sample", field: "tempo", evidenceIds: ["ev-sample"] }),
      codeSample,
    ];
    expect(ids(withoutRestatements(claims, [], [], evidence).claims)).toEqual(ids(claims));
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

  it("removes nothing more when run on its own output", () => {
    const text = "It samples Under Pressure.";
    const claims = [
      // The best copy restates the code claim; the two left are copies of each other.
      judged("m-best", { text, about: "sample", evidenceIds: ["ev-sample"] }),
      judged("m-two", { text, about: "sample", verdict: "partial", evidenceIds: ["ev-other"] }),
      judged("m-three", {
        text,
        about: "sample",
        verdict: "unsupported",
        evidenceIds: ["ev-other"],
      }),
      codeSample,
    ];
    const once = withoutRestatements(claims, [], [], evidence);
    expect(ids(once.claims)).toEqual(["m-two", "code-sample"]);
    expect(once.restated).toBe(2);
    const twice = withoutRestatements(once.claims, [], [], evidence);
    expect(twice.restated).toBe(0);
    expect(twice.claims).toEqual(once.claims);
  });
});

describe("two model claims with one text", () => {
  it("keep the one whose scope fits its evidence, when the other cites nothing", () => {
    // About the song, citing a record of this recording: the deterministic step left it citing
    // nothing. Both read as inferred (a sample is stated whole: partial is not enough).
    const misfit = judged("m-work", {
      text: "It samples “Under Pressure”.",
      about: "sample",
      scope: "work",
      verdict: null,
      kind: "inferred",
      evidenceIds: [],
    });
    const fit = judged("m-recording", {
      text: 'It samples "Under Pressure".',
      about: "sample",
      verdict: "partial",
      kind: "inferred",
      evidenceIds: ["ev-other"],
    });
    const kept = withoutRestatements([misfit, fit], [card("m-work")], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-recording"]);
    expect(kept.factoids).toEqual([]);
    expect(kept.restated).toBe(1);
  });

  it("both stay when they are about other scopes and both cite something", () => {
    const text = "It samples Under Pressure.";
    const kept = withoutRestatements(
      [
        judged("m-recording", { text, about: "sample", evidenceIds: ["ev-other"] }),
        judged("m-work", { text, about: "sample", scope: "work", evidenceIds: ["ev-other"] }),
      ],
      [],
      [],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["m-recording", "m-work"]);
  });

  it("both stay when they read as different kinds: a stricter copy is never dropped for a lenient one", () => {
    const text = "Circo Loco samples One More Time.";
    // Partly supported: a trivia card reads as sourced, a sample claim as inferred (stated whole).
    const lenient = judged("m-card", {
      text,
      about: "trivia",
      verdict: "partial",
      kind: "sourced",
      evidenceIds: ["ev-other"],
      factoid: { title: "Circo Loco", type: "trivia", entities: [] },
    });
    const strict = judged("m-sample", {
      text,
      about: "sample",
      verdict: "partial",
      kind: "inferred",
      evidenceIds: ["ev-other"],
    });
    const kept = withoutRestatements([lenient, strict], [card("m-card")], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-card", "m-sample"]);
  });

  it("both stay when the same subject reads as two kinds (one cited a relation record the check dropped)", () => {
    const text = "The hook was cut from a horn line.";
    const lenient = judged("m-card", {
      text,
      about: "trivia",
      verdict: "partial",
      kind: "sourced",
      evidenceIds: ["ev-other"],
      factoid: { title: "The hook", type: "trivia", entities: [] },
    });
    const strict = judged("m-plain", {
      text,
      about: "trivia",
      verdict: "partial",
      kind: "inferred",
      evidenceIds: ["ev-other"],
    });
    const kept = withoutRestatements([strict, lenient], [card("m-card")], [], evidence);
    expect(ids(kept.claims)).toEqual(["m-plain", "m-card"]);
  });

  it("drop a copy that repeats any copy kept, not only the best one", () => {
    const text = "The hook was cut from a horn line.";
    const third = trackRecord("ev-third");
    const kept = withoutRestatements(
      [
        judged("m-best", { text, about: "trivia", evidenceIds: ["ev-other"] }),
        judged("m-second", {
          text,
          about: "trivia",
          verdict: "partial",
          evidenceIds: ["ev-third"],
        }),
        judged("m-third", {
          text,
          about: "trivia",
          verdict: "unsupported",
          evidenceIds: ["ev-third"],
        }),
      ],
      [],
      [],
      [...evidence, third],
    );
    expect(ids(kept.claims)).toEqual(["m-best", "m-second"]);
  });

  it("are compared once the restatements of code-built claims are gone", () => {
    // The supported copy restates the code claim; the unsupported one does not, and is compared
    // with nothing left: it stays, with its verdict.
    const text = "Vanilla Ice samples Queen.";
    const kept = withoutRestatements(
      [
        judged("m-supported", { text, about: "sample", evidenceIds: ["ev-sample"] }),
        judged("m-unsupported", {
          text,
          about: "sample",
          verdict: "unsupported",
          evidenceIds: ["ev-sample"],
        }),
        codeSample,
      ],
      [],
      [],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["m-unsupported", "code-sample"]);
  });

  it("both stay when one states a relation and the other does not", () => {
    const text = "Circo Loco samples One More Time.";
    const kept = withoutRestatements(
      [
        judged("m-history", { text, about: "history", evidenceIds: ["ev-other"] }),
        judged("m-sample", { text, about: "sample", evidenceIds: ["ev-other"] }),
      ],
      [],
      [],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["m-history", "m-sample"]);
  });

  it("keep the better verdict when both fit: supported, partial, unsupported, then not judged", () => {
    const text = "It appears on To the Extreme.";
    const order = [null, "unsupported", "partial", "supported"] as const;
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

  it("keep the one that cites evidence over one that cites nothing, the first of the two", () => {
    const text = "It samples Under Pressure.";
    const kept = withoutRestatements(
      [
        judged("m-none", { text, about: "sample", evidenceIds: [] }),
        judged("m-cited", { text, about: "sample", evidenceIds: ["ev-other"] }),
      ],
      [],
      [],
      evidence,
    );
    expect(ids(kept.claims)).toEqual(["m-cited"]);
  });

  it("keep the one on a fact card when otherwise equal, with its card", () => {
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

  it("both stay when the one that would go cites more", () => {
    const text = "It samples Under Pressure.";
    const kept = withoutRestatements(
      [
        judged("m-one", { text, about: "sample", evidenceIds: ["ev-other"] }),
        judged("m-two", {
          text,
          about: "sample",
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

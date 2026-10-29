/**
 * withoutRestatements on the showcase recordings' own words: a model claim, or a fact card, that
 * lists records whose relations the code already builds ("“Juicy” is sampled in A, B and C"), or
 * states one record in a wording of its own ("MusicBrainz documents X as a source sampled in this
 * recording"), is left out; a claim that adds a record, another relation, a doubt or anything
 * else stays. A detail sentence that refers back to the relation ("around that sample") is
 * detail. Each case starts from the recording's exact text, then changes it.
 */

import type { Claim } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { readRecording } from "../replay/testing/recordings.js";
import { withoutRestatements } from "./restatements.js";

const JUICY = "juicy-the-notorious-big";
const OMT = "one-more-time-daft-punk";
const BSS = "bitter-sweet-symphony-the-verve";
const HUNG_UP = "hung-up-madonna";

const recordings = new Map(
  [JUICY, OMT, BSS, HUNG_UP].map((slug) => [slug, readRecording(slug).analysis]),
);
const showcase = (slug: string) => {
  const analysis = recordings.get(slug);
  if (!analysis) throw new Error(`no recording ${slug}`);
  return analysis;
};
/** The recorded claim of `slug` whose id starts with `prefix`. */
const claimOf = (slug: string, prefix: string) => {
  const claim = (showcase(slug).claims ?? []).find((each) => each.id.startsWith(prefix));
  if (!claim) throw new Error(`no claim ${prefix} in ${slug}`);
  return claim;
};
/** The id of the recorded evidence item of `slug` whose ref ends with `end`. */
const itemOf = (slug: string, end: string) => {
  const item = (showcase(slug).evidence ?? []).find((each) => each.id.endsWith(end));
  if (!item) throw new Error(`no item ${end} in ${slug}`);
  return item.id;
};
const short = (ids: readonly string[]) => ids.map((id) => id.slice(0, 8));

/**
 * What the step makes of the model claims `claims` of `slug` beside its code-built claims, its
 * cards, its map and its pack: for each, "goes" or "stays" ("stays, marked <code claims>" when
 * marked), and whether its card is kept. A claim kept is as it came but for its mark: never
 * made sourced, its kind and verdict untouched.
 */
function fates(slug: string, claims: readonly Claim[]) {
  const analysis = showcase(slug);
  const code = (analysis.claims ?? []).filter((claim) => claim.origin === "code");
  const cards = claims.map((claim) => ({ id: `card-${claim.id}`, claimId: claim.id }));
  const kept = withoutRestatements(
    [...claims, ...code],
    cards,
    analysis.genealogy.links,
    analysis.evidence ?? [],
    {
      genealogy: analysis.genealogy,
      track: { title: analysis.title, artist: analysis.artist },
    },
  );
  return claims.map((claim) => {
    const left = kept.claims.find((each) => each.id === claim.id);
    const card = kept.factoids.some((each) => each.claimId === claim.id);
    if (!left) {
      expect(card, claim.text).toBe(false);
      return "goes";
    }
    expect(card, claim.text).toBe(true);
    const { documentedBy, ...rest } = left;
    expect(rest, claim.text).toEqual(
      Object.fromEntries(Object.entries(claim).filter(([key]) => key !== "documentedBy")),
    );
    return documentedBy ? `stays, marked ${short(documentedBy).join(",")}` : "stays";
  });
}

/** What the step makes of the recorded claim `prefix` of `slug`, changed by `change`. */
const fate = (slug: string, prefix: string, change: Partial<Claim> = {}) =>
  fates(slug, [{ ...claimOf(slug, prefix), ...change }])[0];

describe("a list of the records whose relations the code builds", () => {
  const LIST = "117ba937";
  const CARD = "5ed3b846";
  const dream = itemOf(JUICY, "beb2b87b-cf8e-4688-9407-35271cec7109");
  const awol = itemOf(JUICY, "b3201b35-4fbe-4da5-9bac-1c9523e63df5");
  const history = itemOf(JUICY, "362b4346-fee5-4447-8329-f85d25498335");
  const hipHop = itemOf(JUICY, "e1e3d537-732a-47ca-9f8e-b8ec6f4c19b9");
  const fruit = itemOf(JUICY, "1d890c2b-2ba3-4b34-9196-64d5cb0cc0dc");

  it("is left out, as recorded: Juicy's model claim and its CONNECTION card", () => {
    expect(claimOf(JUICY, LIST)).toMatchObject({
      text: "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” Mos Def feat. Talib Kweli’s “History,” and Apathy feat. Brevi’s “It’s Only Hip Hop.”",
      about: "connection",
      verdict: "supported",
      evidenceIds: [dream, awol, history, hipHop],
    });
    expect(claimOf(JUICY, CARD)).toMatchObject({
      text: "MusicBrainz records “Juicy” as sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      about: "connection",
      evidenceIds: [dream, awol, history],
    });
    expect(fate(JUICY, LIST)).toBe("goes");
    expect(fate(JUICY, CARD)).toBe("goes");
    expect(fates(JUICY, [claimOf(JUICY, LIST), claimOf(JUICY, CARD)])).toEqual(["goes", "goes"]);
    // Partly supported, or about a sample: the same.
    expect(fate(JUICY, LIST, { verdict: "partial", kind: "inferred" })).toBe("goes");
    expect(fate(JUICY, CARD, { about: "sample" })).toBe("goes");
    // Written with "and" alone, or without the last comma.
    const plain =
      "“Juicy” is sampled in Jay-Z’s “A Dream” and RBX’s “A.W.O.L.” and Mos Def feat. Talib Kweli’s “History”.";
    expect(fate(JUICY, CARD, { text: plain })).toBe("goes");
    const noOxford =
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.” and Mos Def feat. Talib Kweli’s “History.”";
    expect(fate(JUICY, CARD, { text: noOxford })).toBe("goes");
    const according =
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History,” according to MusicBrainz.";
    expect(fate(JUICY, CARD, { text: according })).toBe("goes");
    expect(fate(JUICY, CARD, { text: according.replace("MusicBrainz", "Discogs") })).toBe("stays");
  });

  it("stays when it lists a record it does not cite, or one the result does not hold", () => {
    // The fourth record is in the result, but the card does not cite it.
    expect(fate(JUICY, CARD, { text: claimOf(JUICY, LIST).text })).toBe("stays");
    for (const text of [
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” Mos Def feat. Talib Kweli’s “History,” Nas’s “Halftime,” and Apathy feat. Brevi’s “It’s Only Hip Hop.”",
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” Mos Def feat. Talib Kweli’s “History,” and Apathy feat. Brevi’s “It’s Only Hip Hop,” and Nas’s “Halftime.”",
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” Mos Def feat. Talib Kweli’s “History,” and Apathy feat. Brevi’s “It’s Only Hip Hop,” among many others.",
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” Mos Def feat. Talib Kweli’s “History,” and Apathy feat. Brevi’s “It’s Only Hip Hop,” all from the 1990s.",
    ]) {
      expect(fate(JUICY, LIST, { text }), text).toBe("stays");
    }
    // It names three records and cites four: the fourth is a fact it does not state.
    expect(fate(JUICY, LIST, { text: claimOf(JUICY, CARD).text })).toBe("stays");
  });

  it("stays when it hedges, reads the other way, or states another relation for one record", () => {
    for (const text of [
      "“Juicy” is reportedly sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      "“Juicy” may be sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      "“Juicy” is not sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” or Mos Def feat. Talib Kweli’s “History.”",
      "MusicBrainz wrongly records “Juicy” as sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and possibly Mos Def feat. Talib Kweli’s “History.”",
      // The other direction.
      "“Juicy” samples Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      "Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History” are sampled in “Juicy.”",
      "MusicBrainz records Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History” as sampled in “Juicy.”",
      // Another relation.
      "“Juicy” is covered by Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      "“Juicy” is remixed in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      // Another source than the records'.
      "Discogs records “Juicy” as sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
      // A list that does not end: a comma with nothing after it, or two commas.
      "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,”, and Mos Def feat. Talib Kweli’s “History.”",
    ]) {
      expect(fate(JUICY, CARD, { text }), text).toBe("stays");
    }
    // A record of another relation in the list: Juicy samples "Juicy Fruit", it is not sampled in it.
    const mixed = {
      text: "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mtume’s “Juicy Fruit.”",
      evidenceIds: [dream, awol, fruit],
    };
    expect(fate(JUICY, CARD, mixed)).toBe("stays");
  });

  it("stays, and its card with it, when the judge did not find it supported", () => {
    for (const verdict of ["unsupported", "contradicted", null] as const) {
      expect(fate(JUICY, LIST, { verdict, kind: "inferred" }), String(verdict)).toBe("stays");
    }
  });

  it("stays when it is about another subject than a relation or a connection", () => {
    for (const about of ["history", "trivia", "production"] as const) {
      expect(fate(JUICY, LIST, { about }), about).toBe("stays");
    }
  });

  it("is never marked: a connection keeps its own words", () => {
    const detail = `${claimOf(JUICY, CARD).text} Each one reworks its hook.`;
    expect(fate(JUICY, CARD, { text: detail })).toBe("stays");
  });
});

describe("Hung Up's remix list", () => {
  it("stays: it names the remixers inside the records' titles, not the records", () => {
    expect(claimOf(HUNG_UP, "e6b2b34e")).toMatchObject({
      text: "The track has several documented remixes, including versions by Chus & Ceballos, SDP and Tracy Young.",
      about: "production",
    });
    expect(fate(HUNG_UP, "e6b2b34e")).toBe("stays");
    expect(fate(HUNG_UP, "e6b2b34e", { about: "connection" })).toBe("stays");
  });
});

describe("one record in a wording of the model's own", () => {
  it("is left out, as recorded: One More Time's card and Juicy's two cards", () => {
    expect(claimOf(OMT, "78acfe08").text).toBe(
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled in this recording of "One More Time."',
    );
    expect(claimOf(JUICY, "f3a2ae6f").text).toBe(
      "MusicBrainz credits “Juicy” with sampling Mtume’s “Juicy Fruit.”",
    );
    expect(claimOf(JUICY, "49a56b45").text).toBe(
      "The recording also samples “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
    );
    expect(fate(OMT, "78acfe08")).toBe("goes");
    expect(fate(JUICY, "f3a2ae6f")).toBe("goes");
    expect(fate(JUICY, "49a56b45")).toBe("goes");
  });

  it("is left out with the analysed track named as this recording, this track or the song", () => {
    for (const text of [
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled in this recording.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled in this track.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled in the song.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as sampled in this recording.',
      'MusicBrainz lists "More Spell on You" by Eddie Johns as sampled by "One More Time."',
      'This track samples Eddie Johns\'s "More Spell on You."',
      'The song samples "More Spell on You" by Eddie Johns.',
      'This recording of "One More Time" samples "More Spell on You."',
      'This recording also samples "More Spell on You" by Eddie Johns.',
      'Eddie Johns\'s "More Spell on You" is also sampled in this recording.',
    ]) {
      expect(fate(OMT, "78acfe08", { text }), text).toBe("goes");
    }
    for (const text of [
      "MusicBrainz lists “Juicy” as sampling Mtume’s “Juicy Fruit.”",
      "MusicBrainz credits this recording with sampling “Juicy Fruit” by Mtume.",
      "MusicBrainz credits the song with sampling Mtume’s “Juicy Fruit,” according to MusicBrainz.",
    ]) {
      expect(fate(JUICY, "f3a2ae6f", { text }), text).toBe("goes");
    }
  });

  it("stays when it reads the other way, names another track or source, or adds a word", () => {
    for (const text of [
      // The other direction.
      'MusicBrainz documents "One More Time" as a source sampled in Eddie Johns\'s "More Spell on You."',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampling this recording.',
      // "This recording of" another track: both sides are then records.
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled in this recording of "Circo Loco."',
      // "Of" names the track only by its title.
      'This recording of Daft Punk samples "More Spell on You" by Eddie Johns.',
      // Another source, or a word of its own.
      'Discogs documents Eddie Johns\'s "More Spell on You" as a source sampled in this recording.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source heavily sampled in this recording.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a disco source sampled in this recording.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled on this recording.',
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as a source sampled in this recording of "One More Time" and "Circo Loco."',
      'This recording also also samples "More Spell on You" by Eddie Johns.',
    ]) {
      expect(fate(OMT, "78acfe08", { text }), text).toBe("stays");
    }
    for (const text of [
      "MusicBrainz credits Mtume’s “Juicy Fruit” with sampling “Juicy.”",
      "Genius credits “Juicy” with sampling Mtume’s “Juicy Fruit.”",
      "MusicBrainz credits “Juicy” with sampling Mtume’s “Juicy Fruit” bass line.",
      "MusicBrainz credits “Juicy” for sampling Mtume’s “Juicy Fruit.”",
      "MusicBrainz credits “Juicy” with heavily sampling Mtume’s “Juicy Fruit.”",
    ]) {
      expect(fate(JUICY, "f3a2ae6f", { text }), text).toBe("stays");
    }
    for (const text of [
      "The recording also heavily samples “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
      "The recording also samples “Rappin’ Duke (vocal)” by The Rappin’ Duke and Mtume.",
      "The recording also reportedly samples “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
      "The Rappin’ Duke also samples “Juicy.”",
    ]) {
      expect(fate(JUICY, "49a56b45", { text }), text).toBe("stays");
    }
  });
});

describe("Bitter Sweet Symphony's Coldplay cover, stated three ways", () => {
  const COVER = "f67d7102";
  const CONNECTION = "824ae39c";

  it("is stated once, by its record: the model's claim and its CONNECTION card are left out", () => {
    expect(claimOf(BSS, COVER)).toMatchObject({
      text: "The song’s work has been covered by Coldplay featuring Richard Ashcroft.",
      about: "cover",
      scope: "work",
    });
    expect(claimOf(BSS, CONNECTION)).toMatchObject({
      text: "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover. This relationship is attached to the song’s work, not specifically to this recording.",
      about: "connection",
      scope: "work",
    });
    expect(fates(BSS, [claimOf(BSS, COVER), claimOf(BSS, CONNECTION)])).toEqual(["goes", "goes"]);
    // Each alone, and in other words for the same record.
    expect(fate(BSS, COVER)).toBe("goes");
    expect(fate(BSS, CONNECTION)).toBe("goes");
    for (const text of [
      "The song has been covered by Coldplay feat. Richard Ashcroft.",
      "The song’s work has been covered by Coldplay ft. Richard Ashcroft.",
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover.",
      "MusicBrainz lists a version of “Bitter Sweet Symphony” by Coldplay featuring Richard Ashcroft as a cover.",
    ]) {
      expect(fate(BSS, COVER, { text }), text).toBe("goes");
    }
  });

  it("stays when it says more, names the band alone as covered, or ties the cover to this recording", () => {
    for (const text of [
      // The band, not the song: which of its songs is not said.
      "The Verve has been covered by Coldplay featuring Richard Ashcroft.",
      "The song’s work has been covered by Coldplay featuring Richard Ashcroft in 2005.",
      "The song’s work has been covered by Coldplay featuring Richard Ashcroft and London Grammar.",
      "The song’s work has been covered by Richard Ashcroft featuring Coldplay.",
      "The song’s work has been remixed by Coldplay featuring Richard Ashcroft.",
      "The song’s work has reportedly been covered by Coldplay featuring Richard Ashcroft.",
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover of “Bitter Sweet Symphony.”",
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a live cover.",
      "Discogs lists a version of the song by Coldplay featuring Richard Ashcroft as a cover.",
    ]) {
      expect(fate(BSS, COVER, { text }), text).toBe("stays");
    }
    // Partly supported, so only the relation's own reading could leave them out (a supported
    // connection that names nothing its record does not is read as any other claim is).
    expect(fate(BSS, CONNECTION, { verdict: "partial", kind: "inferred" })).toBe("goes");
    for (const text of [
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover. This relationship is attached to this recording.",
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover. This relationship is attached to the song’s work, not to this recording, which Coldplay played live.",
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover. This relationship is attached to the song’s work, which Coldplay played live.",
      "MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover. Its arrangement is new.",
      "This relationship is attached to the song’s work, not specifically to this recording.",
    ]) {
      const partial = { text, verdict: "partial", kind: "inferred" } as const;
      expect(fate(BSS, CONNECTION, partial), text).toBe("stays");
    }
  });

  it("reads the song's scope sentence only beside a record of the song", () => {
    // The same two sentences on a sample of this recording: its record is no record of the song.
    const sample = claimOf(BSS, "71a2da2e");
    const text =
      "The Verve’s recording samples “The Last Time” by The Andrew Oldham Orchestra. This relationship is attached to the song’s work, not specifically to this recording.";
    expect(fate(BSS, sample.id, { text, verdict: "supported", kind: "sourced" })).toBe("stays");
  });
});

describe("a detail sentence that refers back to the relation", () => {
  const SAMPLE = "71a2da2e";
  const STATED = "The Verve’s recording samples “The Last Time” by The Andrew Oldham Orchestra.";
  const code = () =>
    (showcase(BSS).claims ?? []).find(
      (claim) => claim.origin === "code" && claim.text.includes("The Last Time"),
    )?.id ?? "";

  it("is detail: Bitter Sweet Symphony's sample card is marked with its record", () => {
    expect(claimOf(BSS, SAMPLE)).toMatchObject({
      text: `${STATED} The track’s layered arrangement was described in the source material as adding vocals, strings, guitar and percussion around that sample.`,
      about: "sample",
      verdict: "partial",
      kind: "inferred",
    });
    expect(fate(BSS, SAMPLE)).toBe(`stays, marked ${code().slice(0, 8)}`);
    for (const detail of [
      "The sample opens the track.",
      "Strings were layered over the sample.",
      "This sample carries the whole arrangement.",
      "The arrangement was built around that sample!",
    ]) {
      expect(fate(BSS, SAMPLE, { text: `${STATED} ${detail}` }), detail).toBe(
        `stays, marked ${code().slice(0, 8)}`,
      );
    }
  });

  it("is not detail beside a new name, a tie to something else, another relation or a doubt", () => {
    for (const detail of [
      // A name the result does not hold, or another record's.
      "Noel Gallagher built the arrangement around that sample.",
      "The arrangement was built around that sample by Richard Ashcroft.",
      "Richard Ashcroft built the arrangement around that sample.",
      // A tie to something else.
      "The arrangement was built around the sample of “Popcorn.”",
      "The arrangement was built around the sample from 1965.",
      "The arrangement was built around the sample in “Juicy Cuts 7.”",
      // Not the relation stated, or not a back-reference.
      "The arrangement was built around that cover.",
      "The arrangement was built around that remix.",
      "Its strings that sample the riff were added later.",
      "The arrangement was built around that sample, and a sample of a drum break.",
      "A sample of the riff opens it.",
      // A doubt.
      "That sample was later disputed.",
      "The arrangement was perhaps built around that sample.",
      "Was the arrangement built around that sample?",
    ]) {
      expect(fate(BSS, SAMPLE, { text: `${STATED} ${detail}` }), detail).toBe("stays");
    }
  });
});

describe("the step on lists, in any order", () => {
  const texts = [
    claimOf(JUICY, "117ba937").text,
    claimOf(JUICY, "5ed3b846").text,
    claimOf(JUICY, "f3a2ae6f").text,
    claimOf(JUICY, "49a56b45").text,
    "“Juicy” is sampled in Jay-Z’s “A Dream” and RBX’s “A.W.O.L.”",
    "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Nas’s “Halftime.”",
    "“Juicy” is reportedly sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
    "“Juicy” samples Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
    "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History,” among others.",
    "This recording samples Mtume’s “Juicy Fruit” and “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
  ];
  /** Texts that hedge, read the other way or add a record: never left out. */
  const neverGo = new Set(texts.slice(5, 9));
  const items = (showcase(JUICY).evidence ?? []).filter((item) =>
    /\/(samples|sampled-by)\//.test(item.recordRef ?? ""),
  );
  const pack = showcase(JUICY).evidence ?? [];
  const codeClaims = (showcase(JUICY).claims ?? []).filter((claim) => claim.origin === "code");
  const verdicts = ["supported", "partial", "unsupported", null] as const;
  const abouts = ["connection", "sample", "history"] as const;
  const track = { title: showcase(JUICY).title, artist: showcase(JUICY).artist };

  it("keeps the same claims whatever their order, loses no fact, and leaves nothing more on a second run", () => {
    // A fixed seed: the same sets and orders on every run.
    let seed = 247;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    let left = 0;
    for (let trial = 0; trial < 400; trial++) {
      const claims = Array.from({ length: 2 + next(5) }, (_, i) => {
        const verdict = verdicts[next(verdicts.length)];
        const cited = items.filter(() => next(2) === 0).map((item) => item.id);
        return {
          ...claimOf(JUICY, "117ba937"),
          id: `m-${i}`,
          text: texts[next(texts.length)],
          about: abouts[next(abouts.length)],
          verdict,
          kind: verdict === "supported" ? "sourced" : "inferred",
          evidenceIds: cited.length > 0 ? cited : [items[next(items.length)].id],
          ...(next(4) === 0
            ? { factoid: { title: "Card", type: "connection", entities: [] } }
            : {}),
        } as Claim;
      });
      // Every code-built claim, or only some.
      const code = codeClaims.filter(() => next(3) !== 0);
      const run = (order: readonly Claim[]) =>
        withoutRestatements([...order, ...code], [], [], pack, { track });
      const first = run(claims);
      const kept = first.claims.map((claim) => claim.id).sort();
      for (let shuffle = 0; shuffle < 3; shuffle++) {
        const order = [...claims];
        for (let i = order.length - 1; i > 0; i--) {
          const j = next(i + 1);
          [order[i], order[j]] = [order[j], order[i]];
        }
        const again = run(order).claims.map((claim) => claim.id);
        expect(again.sort(), JSON.stringify(claims.map((c) => [c.text, c.verdict]))).toEqual(kept);
      }
      // Run on its own result: nothing more goes, nothing changes.
      const second = withoutRestatements(first.claims, [], [], pack, { track });
      expect(second.restated).toBe(0);
      expect(second.claims).toEqual(first.claims);
      // Each claim left out: judged, never one that hedges, reads the other way or adds a record,
      // and each record it cites is cited by a claim still shown.
      for (const claim of claims) {
        if (kept.includes(claim.id)) continue;
        left++;
        expect(claim.verdict === "supported" || claim.verdict === "partial", claim.text).toBe(true);
        // One of those goes only as a copy of the same words kept beside it.
        if (neverGo.has(claim.text)) {
          const copy = first.claims.some(
            (each) =>
              each.text === claim.text &&
              claim.evidenceIds.every((id) => each.evidenceIds.includes(id)),
          );
          expect(copy, claim.text).toBe(true);
        }
        for (const id of claim.evidenceIds) {
          expect(
            first.claims.some((each) => each.evidenceIds.includes(id)),
            `${claim.text} ${id}`,
          ).toBe(true);
        }
      }
    }
    // The check reads lists that go, not only ones that stay.
    expect(left).toBeGreaterThan(100);
  });
});

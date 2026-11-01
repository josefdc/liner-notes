/**
 * withoutRestatements on the showcase recordings' own words (the four served before the golden run's,
 * fixtures/pinned/9971adea845d): a model claim, or a fact card, that
 * lists records whose relations the code already builds ("“Juicy” is sampled in A, B and C"), or
 * states one record in a wording of its own ("MusicBrainz documents X as a source sampled in this
 * recording"), is left out; a claim that adds a record, another relation, a doubt or anything
 * else stays. A detail sentence that refers back to the relation ("around that sample") is
 * detail. Each case starts from the recording's exact text, then changes it.
 */

import type { Claim } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { previousShowcase } from "../replay/testing/recordings.js";
import { withoutRestatements } from "./restatements.js";

const JUICY = "juicy-the-notorious-big";
const OMT = "one-more-time-daft-punk";
const BSS = "bitter-sweet-symphony-the-verve";
const HUNG_UP = "hung-up-madonna";

const recordings = new Map(
  [JUICY, OMT, BSS, HUNG_UP].map((slug) => [slug, previousShowcase(slug).analysis]),
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
 * made sourced, its kind and verdict untouched. `code` stands in for the recorded code claims.
 */
function fates(slug: string, claims: readonly Claim[], { code }: { code?: readonly Claim[] } = {}) {
  const analysis = showcase(slug);
  code ??= (analysis.claims ?? []).filter((claim) => claim.origin === "code");
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
const fate = (
  slug: string,
  prefix: string,
  change: Partial<Claim> = {},
  options: { code?: readonly Claim[] } = {},
) => fates(slug, [{ ...claimOf(slug, prefix), ...change }], options)[0];
/** The recorded code claims of `slug`. */
const codeOf = (slug: string) =>
  (showcase(slug).claims ?? []).filter((claim) => claim.origin === "code");

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
      // A list that starts with a separator, or does not end: a comma with nothing after it, or
      // two commas.
      "“Juicy” is sampled in and Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”",
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

  it("stays, and its card with it, when no code claim states its records", () => {
    // Its records' relations are then stated by nothing else shown.
    expect(fate(JUICY, LIST, {}, { code: [] })).toBe("stays");
    expect(fate(JUICY, CARD, {}, { code: [] })).toBe("stays");
    expect(fates(JUICY, [claimOf(JUICY, LIST), claimOf(JUICY, CARD)], { code: [] })).toEqual([
      "stays",
      "stays",
    ]);
    // Or only code claims about another subject than a relation.
    const history = codeOf(JUICY).map((claim) => ({ ...claim, about: "history" as const }));
    expect(fate(JUICY, LIST, {}, { code: history })).toBe("stays");
    expect(fate(JUICY, CARD, {}, { code: history })).toBe("stays");
    // Or code claims that state some of its records and not the others.
    const withoutDream = codeOf(JUICY).filter((claim) => !claim.evidenceIds.includes(dream));
    expect(withoutDream.length).toBeLessThan(codeOf(JUICY).length);
    expect(fate(JUICY, CARD, {}, { code: withoutDream })).toBe("stays");
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
      'MusicBrainz documents Eddie Johns\'s "More Spell on You" as uncredited source sampled in this recording.',
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
      // Which "by" names the version is not told.
      "MusicBrainz lists a version of “Bitter Sweet Symphony” by The Verve by Coldplay featuring Richard Ashcroft as a cover.",
      // Stated twice: the claim is no one statement.
      "The song’s work has been covered by Coldplay featuring Richard Ashcroft. MusicBrainz lists a version of the song by Coldplay featuring Richard Ashcroft as a cover.",
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
  const COVER = "f67d7102";
  const STATED = "The Verve’s recording samples “The Last Time” by The Andrew Oldham Orchestra.";
  const COVERED = "The song’s work has been covered by Coldplay featuring Richard Ashcroft.";
  const codeAbout = (title: string) =>
    (showcase(BSS).claims ?? []).find(
      (claim) => claim.origin === "code" && claim.text.includes(title),
    )?.id ?? "";
  const sampleMark = () => `stays, marked ${codeAbout("The Last Time").slice(0, 8)}`;
  /** BSS's sample claim with `detail` after its statement, as recorded: partly supported. */
  const withDetail = (detail: string, change: Partial<Claim> = {}) =>
    fate(BSS, SAMPLE, { text: `${STATED} ${detail}`, ...change });

  it("is detail: Bitter Sweet Symphony's sample card is marked with its record", () => {
    expect(claimOf(BSS, SAMPLE)).toMatchObject({
      text: `${STATED} The track’s layered arrangement was described in the source material as adding vocals, strings, guitar and percussion around that sample.`,
      about: "sample",
      verdict: "partial",
      kind: "inferred",
    });
    expect(fate(BSS, SAMPLE)).toBe(sampleMark());
    for (const detail of [
      "Strings were layered over the sample.",
      "The vocal sits above this sample.",
      "The arrangement was built around that sample!",
      "The band added drums beneath the sample.",
      "Guitar and percussion were added alongside that sample.",
      // The analysed track's own, and what was written about it.
      "The track’s strings were layered over the sample.",
      "As described in the source material, strings were layered over the sample.",
      "Strings, as taken from the source material, were layered over the sample.",
    ]) {
      expect(withDetail(detail), detail).toBe(sampleMark());
    }
    // A cover's own noun, after a cover.
    const cover = { text: `${COVERED} Strings were added over this cover.`, verdict: "partial" };
    expect(fate(BSS, COVER, { ...cover, kind: "inferred" } as Partial<Claim>)).toBe(
      `stays, marked ${codeAbout("Coldplay").slice(0, 8)}`,
    );
  });

  it("is not detail when the relation's noun is the subject: it may dispute, reverse or move it", () => {
    for (const detail of [
      "The sample opens the track.",
      "This sample carries the whole arrangement.",
      "The sample was lifted from The Verve’s recording by The Andrew Oldham Orchestra.",
      "The Verve’s recording is the sample’s original source.",
      "“The Last Time” by The Andrew Oldham Orchestra is where the sample ended up.",
      "The sample came first; “The Last Time” followed.",
      "The sample appears in “The Last Time” too.",
      "The sample was uncleared and cost the band all royalties.",
      "This sample was not used.",
      "The sample was taken out before release.",
      "The sample is fake.",
      "The sample was replaced by a re-recording.",
      "Some say the sample is fake.",
      "The sample belongs to a different song.",
      "This sample is a misattribution.",
      "The sample is bogus.",
      "The sample was taken from another track entirely.",
      "The sample is actually a replayed re-recording.",
      "The sample is apocryphal.",
      "The sample is invented.",
      "The sample: fabricated.",
      "The sample is the riff of a later song.",
      "The sample was replaced by a re-recorded string part.",
      "The sample was later reused in another hit.",
      "the sample.",
      "The sample",
      "That sample.",
    ]) {
      expect(withDetail(detail), detail).toBe("stays");
    }
    // Supported, the same.
    const lifted =
      "The sample was lifted from The Verve’s recording by The Andrew Oldham Orchestra.";
    expect(withDetail(lifted, { verdict: "supported", kind: "sourced" })).toBe("stays");
    // As the tail of the stating sentence.
    expect(
      fate(BSS, SAMPLE, {
        text: `${STATED.slice(0, -1)}, the sample having first appeared on The Verve’s recording.`,
      }),
    ).toBe("stays");
    // Juicy's sample, and the Coldplay cover.
    expect(
      fate(JUICY, "49a56b45", {
        text: `${claimOf(JUICY, "49a56b45").text} The sample was later reused in another hit.`,
        verdict: "partial",
        kind: "inferred",
      }),
    ).toBe("stays");
    for (const detail of [
      "This cover predates the song.",
      "This cover is the original recording.",
      "The cover came out before The Verve’s recording.",
      "The cover was recorded live.",
    ]) {
      const cover = { text: `${COVERED} ${detail}`, verdict: "partial", kind: "inferred" };
      expect(fate(BSS, COVER, cover as Partial<Claim>), detail).toBe("stays");
    }
  });

  it("is not detail beside a list's records in other words", () => {
    const change = {
      text: "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.” and Mos Def feat. Talib Kweli’s “History”. Countless tracks were built around that sample.",
      about: "sample",
      verdict: "partial",
      kind: "inferred",
    } as Partial<Claim>;
    expect(fate(JUICY, "5ed3b846", change)).toBe("stays");
    const producers = {
      ...change,
      text: "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.” and Mos Def feat. Talib Kweli’s “History”. Hip-hop producers built beats around that sample.",
    };
    expect(fate(JUICY, "5ed3b846", producers)).toBe("stays");
  });

  it("is not detail after a comma that closes a quoted title (“…,”): that comma ends no part", () => {
    const text =
      "The Verve’s recording samples The Andrew Oldham Orchestra’s “The Last Time,” its strings swelling over the drums.";
    expect(fate(BSS, SAMPLE, { text })).toBe("stays");
    // After the closing quote, the comma ends the part.
    const after = text.replace("Time,”", "Time”,");
    expect(fate(BSS, SAMPLE, { text: after })).toBe(sampleMark());
  });

  it("is not detail with a name beside it, more than one sample, or a word that ties it elsewhere", () => {
    for (const detail of [
      // A name the result does not hold, the track's, or a cited record's.
      "Noel Gallagher built the arrangement around that sample.",
      "Richard Ashcroft built the arrangement around that sample.",
      "The Verve layered strings around that sample.",
      "Coldplay layered strings around that sample.",
      "The Andrew Oldham Orchestra built “The Last Time” around the sample.",
      "The arrangement was built around that sample by Richard Ashcroft.",
      // A record in other words: the other side, or a third record.
      "The orchestral original was itself built around that sample.",
      "The earlier recording was built around that sample.",
      "The earlier record was later rebuilt atop that sample.",
      "The source recording was layered over the sample.",
      "The earlier record was recorded with that sample.",
      "A later hit was built around that sample.",
      "Another band later built its own hit around that sample.",
      "The previous single was layered over the sample.",
      "A subsequent version was built around that sample.",
      "The source was built around that sample.",
      "A track was built around that sample.",
      "The song was layered over the sample.",
      // Records in the plural, or other words for one.
      "Other songs were built around that sample.",
      "Many hits were built around that sample.",
      "Countless records were built around that sample.",
      "Several tracks were built around that sample.",
      "The originals were built around that sample.",
      "The 1965 tune was built around that sample.",
      "The album was built around that sample.",
      "The composition was built around that sample.",
      "Its predecessor was built around that sample.",
      "Their next album was built around that sample.",
      "The rival band’s songs were built around that sample.",
      "Numerous releases were built around that sample.",
      "The B-side was built around that sample.",
      "Later versions were built around that sample.",
      // The source material, not as what the fact was taken from.
      "The source material was built around that sample.",
      "The source material describes strings layered over the sample.",
      // One record word alone.
      "An older arrangement was built around that sample.",
      "The prior arrangement was built around that sample.",
      "A subsequent arrangement was built around that sample.",
      "The arrangement was itself built around that sample.",
      "The hit was built around that sample.",
      "The single was built around that sample.",
      "Another arrangement was built around that sample.",
      "Other strings were layered over the sample.",
      "Many strings were layered over the sample.",
      "Several strings were layered over the sample.",
      "Countless strings were layered over the sample.",
      "A rival arrangement was built around that sample.",
      // Who else used it, and what else it is.
      "Hip-hop producers built beats around that sample.",
      "Dozens of producers have built beats around that sample.",
      "Rappers have freestyled over that sample.",
      "Hip-hop cuts were built around that sample.",
      "Its successor was built around that sample.",
      "The follow-up was built around that sample.",
      "The sequel was built around that sample.",
      "The mixtape was built around that sample.",
      "The soundtrack was built around that sample.",
      "Their debut was built around that sample.",
      "Mashups were built around that sample.",
      "Bootlegs were built around that sample.",
      "Edits were built around that sample.",
      "The rerecording was built around that sample.",
      "The demo was built around that sample.",
      "Other artists built tracks around that sample.",
      "The orchestra’s arrangement was built around that sample.",
      "The strings were themselves built around that sample.",
      // A possessive other than the track's own.
      "The original’s riff was rebuilt around that sample.",
      "The album’s strings were layered over the sample.",
      // Not the sample stated, or more than one.
      "The arrangement was built around a sample.",
      "The arrangement was built around one sample.",
      "The arrangement was built around those samples.",
      "The arrangement was built around the samples.",
      "The arrangement was built around this sampling.",
      // A tie to something else, before a name or a lower-case word.
      "The arrangement was built around the sample of “Popcorn.”",
      "The arrangement was built around the sample from 1965.",
      "The arrangement was built around the sample in “Juicy Cuts 7.”",
      "The arrangement was built around that sample in the chorus.",
      "The arrangement was built on the sample by the house band.",
      "The arrangement was built around the sample by the house band.",
      "The band opened with the sample at the start.",
      "The strings swell over the sample into the bridge.",
      "The drums were built around this sample with a drum loop.",
      "The strings were layered around the sample on their next single.",
      // A preposition that says where it came from, or that it is something else.
      "The strings were taken from this sample.",
      "The arrangement is based on this sample.",
      "The riff was first heard in the sample.",
      "The riff was turned into the sample.",
      "The riff was added to the sample.",
      "The riff was played against the sample.",
      // Not the relation stated, or not a back-reference.
      "The arrangement was built around that cover.",
      "The arrangement was built around that remix.",
      "Its strings that sample the riff were added later.",
      "The arrangement was built around that sample, and a sample of a drum break.",
      "A sample of the riff opens it.",
      "Around that sample, strings swell.",
      // A doubt, or a question.
      "That sample was later disputed.",
      "The arrangement was perhaps built around that sample.",
      "Was the arrangement built around that sample?",
    ]) {
      expect(withDetail(detail), detail).toBe("stays");
    }
    for (const detail of [
      "Strings were taken from this cover.",
      "The arrangement is based on this cover.",
      "Strings were added over this cover in 2005.",
      "The original song was later rebuilt around this cover.",
      "Many songs were built around this cover.",
      "Hip-hop producers built beats around this cover.",
      "Other bands recorded songs over this cover.",
      "The original was written atop this cover.",
      "Strings were added with this cover.",
    ]) {
      const cover = { text: `${COVERED} ${detail}`, verdict: "partial", kind: "inferred" };
      expect(fate(BSS, COVER, cover as Partial<Claim>), detail).toBe("stays");
    }
  });
});

describe("the track named by a noun of the record's scope", () => {
  const COVER = "f67d7102";
  const SAMPLE = "71a2da2e";
  const supported = { verdict: "supported", kind: "sourced" } as const;

  it("names a work record's track as the song or its work, never as this recording or track", () => {
    expect(
      showcase(BSS).evidence?.find((item) => item.id === claimOf(BSS, COVER).evidenceIds[0]),
    ).toBeDefined();
    for (const text of [
      "The song has been covered by Coldplay featuring Richard Ashcroft.",
      "The work has been covered by Coldplay featuring Richard Ashcroft.",
      "The song’s work has been covered by Coldplay featuring Richard Ashcroft.",
    ]) {
      expect(fate(BSS, COVER, { text }), text).toBe("goes");
    }
    for (const text of [
      "This recording has been covered by Coldplay featuring Richard Ashcroft.",
      "This track has been covered by Coldplay featuring Richard Ashcroft.",
      "The recording has been covered by Coldplay featuring Richard Ashcroft.",
    ]) {
      expect(fate(BSS, COVER, { text }), text).toBe("stays");
      const detail = { text: `${text} The cover was recorded live.`, verdict: "partial" };
      expect(fate(BSS, COVER, { ...detail, kind: "inferred" } as Partial<Claim>), text).toBe(
        "stays",
      );
      const over = { text: `${text} Strings were added over this cover.`, verdict: "partial" };
      expect(fate(BSS, COVER, { ...over, kind: "inferred" } as Partial<Claim>), text).toBe("stays");
    }
  });

  it("names a recording record's track as this recording, this track or the song, never as its work", () => {
    for (const text of [
      "This recording samples “The Last Time” by The Andrew Oldham Orchestra.",
      "This track samples “The Last Time” by The Andrew Oldham Orchestra.",
      "The song samples “The Last Time” by The Andrew Oldham Orchestra.",
    ]) {
      expect(fate(BSS, SAMPLE, { text, ...supported }), text).toBe("goes");
    }
    for (const text of [
      "The song’s work samples “The Last Time” by The Andrew Oldham Orchestra.",
      "The work samples “The Last Time” by The Andrew Oldham Orchestra.",
    ]) {
      expect(fate(BSS, SAMPLE, { text, ...supported }), text).toBe("stays");
      const detail = `${text} Strings were layered over the sample.`;
      expect(fate(BSS, SAMPLE, { text: detail }), text).toBe("stays");
    }
    expect(
      fate(OMT, "78acfe08", { text: 'The work samples "More Spell on You" by Eddie Johns.' }),
    ).toBe("stays");
    expect(
      fate(OMT, "78acfe08", {
        text: 'The song’s work samples "More Spell on You" by Eddie Johns.',
      }),
    ).toBe("stays");
  });
});

describe("a cover named by the guest it features", () => {
  const COVER = "f67d7102";

  it("stays: the guest alone is not the covering artist", () => {
    for (const text of [
      "The song has been covered by Richard Ashcroft.",
      "The song’s work has been covered by Richard Ashcroft.",
      "MusicBrainz lists a version of the song by Richard Ashcroft as a cover.",
    ]) {
      expect(fate(BSS, COVER, { text }), text).toBe("stays");
    }
    const detail = {
      text: "The song has been covered by Richard Ashcroft. Strings were added over this cover.",
      verdict: "partial",
      kind: "inferred",
    } as Partial<Claim>;
    expect(fate(BSS, COVER, detail)).toBe("stays");
  });

  it("goes named by its lead, and stays named by the other cover's whole credit", () => {
    // The result holds “Coldplay feat. Richard Ashcroft” and “Coldplay with Richard Ashcroft”: the
    // second credit is one name, so Coldplay leads only the first.
    expect(fate(BSS, COVER, { text: "The song’s work has been covered by Coldplay." })).toBe(
      "goes",
    );
    expect(
      fate(BSS, COVER, {
        text: "The song’s work has been covered by Coldplay with Richard Ashcroft.",
      }),
    ).toBe("stays");
  });
});

describe("a list that may group its names otherwise", () => {
  const CARD = "5ed3b846";
  const dream = itemOf(JUICY, "beb2b87b-cf8e-4688-9407-35271cec7109");
  const awol = itemOf(JUICY, "b3201b35-4fbe-4da5-9bac-1c9523e63df5");

  it("stays when one title is given more artists than its record's", () => {
    for (const text of [
      "“Juicy” is sampled in “A Dream” by Jay-Z, RBX and Mos Def.",
      "“Juicy” is sampled in “A Dream” by Jay-Z, RBX, and Mos Def.",
    ]) {
      expect(fate(JUICY, CARD, { text }), text).toBe("stays");
    }
    for (const text of ["“Juicy” is sampled in “A Dream” by Jay-Z and RBX."]) {
      expect(fate(JUICY, CARD, { text, evidenceIds: [dream, awol] }), text).toBe("stays");
    }
    const apart = "“Juicy” is sampled in “A Dream” by Jay-Z and “A.W.O.L.” by RBX.";
    expect(fate(JUICY, CARD, { text: apart, evidenceIds: [dream, awol] })).toBe("goes");
  });
});

describe("a question", () => {
  it("is never read as a statement", () => {
    for (const [slug, prefix, text] of [
      [BSS, "f67d7102", "The song’s work has been covered by Coldplay featuring Richard Ashcroft?"],
      [
        JUICY,
        "5ed3b846",
        "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History?”",
      ],
      [
        JUICY,
        "5ed3b846",
        "Is “Juicy” sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History”?",
      ],
      [OMT, "78acfe08", 'This track samples Eddie Johns\'s "More Spell on You"?'],
      [
        JUICY,
        "5ed3b846",
        "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History” (?)",
      ],
      [
        JUICY,
        "5ed3b846",
        "“Juicy” is sampled in Jay-Z’s “A Dream,” RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History”?!",
      ],
      [
        JUICY,
        "49a56b45",
        "The recording also samples “Rappin’ Duke (vocal)” by The Rappin’ Duke (?)",
      ],
      [
        JUICY,
        "49a56b45",
        "The recording also samples (?) “Rappin’ Duke (vocal)” by The Rappin’ Duke.",
      ],
      [JUICY, "f3a2ae6f", "MusicBrainz credits “Juicy” with sampling Mtume’s “Juicy Fruit”? "],
    ] as const) {
      expect(fate(slug, prefix, { text }), text).toBe("stays");
    }
    // Nor marked: a stating sentence that asks, beside detail.
    for (const text of [
      "The Verve’s recording samples “The Last Time” by The Andrew Oldham Orchestra? Strings were layered over the sample.",
      "The Verve’s recording samples “The Last Time” (?) by The Andrew Oldham Orchestra. Strings were layered over the sample.",
      "The Verve’s recording samples “The Last Time” by The Andrew Oldham Orchestra (?), strings layered over the sample.",
    ]) {
      expect(fate(BSS, "71a2da2e", { text }), text).toBe("stays");
    }
    // Its statement, the same words, goes.
    expect(
      fate(BSS, "f67d7102", {
        text: "The song’s work has been covered by Coldplay featuring Richard Ashcroft.",
      }),
    ).toBe("goes");
  });
});

describe("a claim whose text holds any word", () => {
  it("is read as words, never as a comma: a word a statement could hold stands for nothing", () => {
    const forged =
      "The Verve’s 0listcomma0 recording samples “The Last Time” by The Andrew Oldham Orchestra, adding strings.";
    expect(() => fate(BSS, "71a2da2e", { text: forged })).not.toThrow();
    expect(fate(BSS, "71a2da2e", { text: forged })).toBe("stays");
    const listed =
      "“Juicy” is sampled in Jay-Z’s “A Dream,” 0LISTCOMMA0 RBX’s “A.W.O.L.,” and Mos Def feat. Talib Kweli’s “History.”";
    expect(fate(JUICY, "5ed3b846", { text: listed })).toBe("stays");
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
    // 400 trials take about 2 s alone and up to 5.6 s inside the full API run on a loaded machine,
    // past the 5 s default; 30 s leaves a wide margin without dropping trials.
  }, 30_000);
});

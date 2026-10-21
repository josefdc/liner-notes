/** The identity rules every primary-record source applies, and the Evidence they build. */

import { EVIDENCE_EXCERPT_MAX, evidenceIssues } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { SourceError } from "./http.js";
import {
  artistsMatch,
  checkIdentity,
  creditStringMatches,
  DURATION_TOLERANCE_MS,
  durationCheck,
  failed,
  found,
  identityAccuracy,
  missing,
  parseClockDuration,
  primaryEvidence,
  titlesMatch,
} from "./records.js";

describe("titlesMatch", () => {
  it.each([
    ["Under Pressure - Remastered 2011", "Under Pressure"],
    ["Under Pressure (2011 Remaster)", "Under Pressure"],
    ["Bohemian Rhapsody - 2011 Remaster", "Bohemian Rhapsody"],
    ["Heroes [Remastered]", "Heroes"],
    ["Rapper's Delight (feat. X)", "Rapper's Delight"],
    ["Me & Bobby McGee", "Me and Bobby McGee"],
    ["BIRDS OF A FEATHER", "Birds of a Feather"],
  ])("%s is %s", (a, b) => {
    expect(titlesMatch(a, b)).toBe(true);
  });

  it.each([
    ["Ice Ice Baby (radio edit)", "Ice Ice Baby"],
    ["Ice Ice Baby (Miami Drop Mix)", "Ice Ice Baby"],
    ["Under Pressure (Rah Mix)", "Under Pressure"],
    ["Remastered", ""],
  ])("%s is not %s", (a, b) => {
    expect(titlesMatch(a, b)).toBe(false);
  });
});

describe("artist checks", () => {
  it("needs exactly the expected set of artists", () => {
    const credit = (...names: string[]) => names.map((n) => ({ names: [n] }));
    expect(artistsMatch(["Queen", "David Bowie"], credit("David Bowie", "Queen"))).toBe(true);
    expect(artistsMatch(["Queen", "David Bowie"], credit("Queen"))).toBe(false);
    expect(artistsMatch(["Queen"], credit("Queen", "David Bowie"))).toBe(false);
    expect(artistsMatch(["Earth, Wind & Fire"], credit("Earth, Wind and Fire"))).toBe(true);
  });

  it("reads a credit written as one string", () => {
    expect(creditStringMatches("Queen & David Bowie", ["Queen", "David Bowie"])).toBe(true);
    expect(creditStringMatches("Queen feat. David Bowie", ["Queen", "David Bowie"])).toBe(true);
    expect(creditStringMatches("Earth, Wind & Fire", ["Earth, Wind & Fire"])).toBe(true);
    expect(creditStringMatches("Queen & David Bowie", ["Queen"])).toBe(false);
    expect(creditStringMatches("", ["Queen"])).toBe(false);
  });
});

describe("durationCheck", () => {
  it("allows 3 s either way and treats a missing length as unknown", () => {
    expect(DURATION_TOLERANCE_MS).toBe(3000);
    expect(durationCheck(271_000, 274_000)).toBe("match");
    expect(durationCheck(271_000, 274_001)).toBe("mismatch");
    expect(durationCheck(271_000, 267_999)).toBe("mismatch");
    expect(durationCheck(null, 271_000)).toBe("unknown");
    expect(durationCheck(271_000, 0)).toBe("unknown");
  });

  it("reads printed durations", () => {
    expect(parseClockDuration("4:31")).toBe(271_000);
    expect(parseClockDuration("1:02:03")).toBe(3_723_000);
    expect(parseClockDuration("")).toBeNull();
    expect(parseClockDuration("4.31")).toBeNull();
  });

  it("is part of the identity check only when both sides know it", () => {
    const track = { title: "Ice Ice Baby", artists: ["Vanilla Ice"], durationMs: 271_000 };
    const record = { title: "Ice Ice Baby", artists: "Vanilla Ice" };
    expect(checkIdentity(track, { ...record, durationMs: null })).toEqual({
      ok: true,
      duration: "unknown",
    });
    expect(checkIdentity(track, { ...record, durationMs: 226_666 })).toMatchObject({
      ok: false,
      failed: "duration",
    });
  });
});

describe("results and Evidence", () => {
  it("cuts an excerpt to the contract's limit", () => {
    const item = primaryEvidence({
      source: "musicbrainz",
      recordRef: "recording/x",
      url: null,
      title: "t",
      excerpt: "x".repeat(EVIDENCE_EXCERPT_MAX + 50),
      retrievedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(item.excerpt).toHaveLength(EVIDENCE_EXCERPT_MAX);
    expect(evidenceIssues(item)).toEqual([]);
    expect(item).toMatchObject({ id: "musicbrainz:recording/x", sourceTier: "primary-record" });
  });

  it("turns a source error into a typed missing result", () => {
    const timeout = failed("discogs", new SourceError("discogs", "timeout", "no answer"));
    expect(timeout).toMatchObject({ status: "missing", error: { code: "timeout" } });
    const parse = failed("genius", new SourceError("genius", "parse", "bad body"));
    expect(parse).toMatchObject({ error: { code: "invalid_response" } });
    expect(failed("genius", new Error("bug"))).toMatchObject({ error: { code: "unavailable" } });
  });

  it("sums identity counts per source", () => {
    const rejected = missing("discogs", "r", { omitted: [{ ref: "release/1", reason: "x" }] });
    expect(identityAccuracy([missing("discogs", "none"), rejected])).toEqual({
      discogs: { matched: 0, rejected: 1, missing: 1, unavailable: 0 },
    });
    const twice = [found("genius", [], []), found("genius", [], []), missing("genius", "none")];
    const down = failed("genius", new SourceError("genius", "timeout", "deadline reached"));
    expect(identityAccuracy([...twice, down])).toEqual({
      genius: { matched: 2, rejected: 0, missing: 1, unavailable: 1 },
    });
  });

  it("counts a record that was identified but holds nothing as matched, not missing", () => {
    expect(missing("discogs", "no credits", { matched: 1 }).identity).toEqual({
      matched: 1,
      rejected: 0,
      missing: 0,
      unavailable: 0,
    });
  });

  it("reports a malformed answer as an invalid response, and a deadline as a timeout", () => {
    expect(failed("discogs", new TypeError("x is not iterable"))).toMatchObject({
      error: { code: "invalid_response" },
    });
    expect(failed("discogs", new SourceError("discogs", "timeout", "deadline"))).toMatchObject({
      error: { code: "timeout" },
    });
    // Cancelled by the caller: not a timeout.
    expect(failed("discogs", new SourceError("discogs", "aborted", "aborted"))).toMatchObject({
      error: { code: "unavailable" },
    });
  });
});

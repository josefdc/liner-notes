/**
 * Where the evidence pack's items come from: only from a source's answer. A research summary a
 * model wrote, an object shaped like Evidence (such as one parsed from a model's JSON) or a copy
 * of a real item cannot be added; the pack keeps an id once, orders by tier and caps its size.
 */

import { Evidence as EvidenceSchema, evidenceIssues, SourceId } from "@liner-notes/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPrimarySources, type PrimarySources } from "../../sources/identity.js";
import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import { found, primaryEvidence, scopedRef } from "../../sources/records.js";
import { stubFetch } from "../../sources/testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "../../sources/testing/iceIceBaby.js";
import {
  EVIDENCE_PACK_MAX_ITEMS,
  EvidenceOriginError,
  EvidencePack,
  primaryRecordEvidence,
  primarySourceErrors,
  type SourcedEvidence,
  webSearchEvidence,
} from "./evidencePack.js";

const now = () => new Date("2026-10-20T12:00:00.000Z");
const AT = "2026-10-20T12:00:00.000Z";

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());
beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The primary sources' answers for "Ice Ice Baby", from the captured fixtures. */
async function iceIceBaby(): Promise<PrimarySources> {
  stubFetch(primaryRoute);
  return collectPrimarySources(ICE_TRACK, { now });
}

/** A summary a research model could write about the track. */
const SUMMARY =
  "Research summary: Ice Ice Baby samples Under Pressure by Queen and David Bowie, " +
  "and was produced by Vanilla Ice in 1989.";

/** The summary dressed as Evidence: it passes the contract's schema and checks. */
const dressed = {
  id: "musicbrainz:track/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43/summary",
  source: "musicbrainz",
  sourceTier: "primary-record",
  url: "https://musicbrainz.org/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43",
  title: "Research summary",
  retrievedAt: AT,
  excerpt: SUMMARY,
  recordRef: "track/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43/summary",
} as const;

const web = (url: string, content = "A page about the track.", title = "Page") => ({
  result: { url, content, title },
  retrievedAt: AT,
});

describe("EvidencePack.add refuses anything not built from a source's answer", () => {
  it("throws on a research summary string", () => {
    const pack = new EvidencePack();
    expect(() => pack.add(SUMMARY as unknown as SourcedEvidence)).toThrow(EvidenceOriginError);
    expect(() => pack.add(SUMMARY as unknown as SourcedEvidence)).toThrow(/text is not evidence/);
    expect(pack.size).toBe(0);
  });

  it("throws on an object shaped like Evidence, though the contract accepts it", () => {
    // What a model's JSON answer parsed into Evidence would be: valid by the schema alone.
    const parsed = EvidenceSchema.parse(JSON.parse(JSON.stringify(dressed)));
    expect(evidenceIssues(parsed)).toEqual([]);
    const pack = new EvidencePack();
    expect(() => pack.add(parsed as SourcedEvidence)).toThrow(EvidenceOriginError);
    expect(() => pack.add(null as unknown as SourcedEvidence)).toThrow(EvidenceOriginError);
    expect(pack.items()).toEqual([]);
  });

  it("throws on a copy of a real item, and a real item cannot be rewritten", async () => {
    const [item] = primaryRecordEvidence(await iceIceBaby());
    const pack = new EvidencePack();
    expect(() => pack.add({ ...item })).toThrow(EvidenceOriginError);
    expect(() => pack.add({ ...item, excerpt: SUMMARY })).toThrow(EvidenceOriginError);
    expect(() => {
      (item as { excerpt: string }).excerpt = SUMMARY;
    }).toThrow(TypeError);
    expect(pack.add(item)).toBe(true);
    expect(pack.items()[0].excerpt).not.toBe(SUMMARY);
  });

  it("refuses primary-source results whose items the source did not build", () => {
    const forged = {
      musicbrainz: found("musicbrainz", [], [dressed]),
      discogs: { status: "missing", error: null },
      genius: { status: "missing", error: null },
      secondhandsongs: { status: "missing", error: null },
    } as unknown as PrimarySources;
    expect(() => primaryRecordEvidence(forged)).toThrow(EvidenceOriginError);
  });

  it("refuses a source's item filed under another source", () => {
    const item = primaryEvidence({
      source: "secondhandsongs",
      recordRef: scopedRef("work", "work/4196/covered-by/performance/1"),
      url: "https://secondhandsongs.com/work/4196",
      title: "Ice Ice Baby — SecondHandSongs",
      excerpt: "SecondHandSongs: a cover.",
      retrievedAt: AT,
    });
    const misfiled = {
      musicbrainz: found("musicbrainz", [], [item]),
      discogs: { status: "missing", error: null },
      genius: { status: "missing", error: null },
      secondhandsongs: { status: "missing", error: null },
    } as unknown as PrimarySources;
    expect(() => primaryRecordEvidence(misfiled)).toThrow(/not a musicbrainz primary record/);
  });
});

describe("items built from the sources' answers", () => {
  it("takes every primary record of the answers, each valid and of a source, none a model", async () => {
    const sources = await iceIceBaby();
    const items = primaryRecordEvidence(sources);

    expect(items.map((e) => e.id)).toEqual(sources.evidence.map((e) => e.id));
    expect(new Set(items.map((e) => e.source))).toEqual(
      new Set(["musicbrainz", "secondhandsongs"]),
    );
    for (const item of items) {
      expect(SourceId.options).toContain(item.source);
      expect(evidenceIssues(EvidenceSchema.parse(item))).toEqual([]);
      expect(item.sourceTier).toBe("primary-record");
      expect(item.retrievedAt).toBe(AT);
    }
    const pack = new EvidencePack();
    expect(pack.addAll(items)).toBe(items.length);
    // Discogs and Genius have no credential here: their errors are the run's source errors.
    expect(primarySourceErrors(sources)).toEqual([
      { source: "discogs", code: "not_configured", message: "DISCOGS_TOKEN is not set" },
      { source: "genius", code: "not_configured", message: "GENIUS_ACCESS_TOKEN is not set" },
    ]);
  });

  it("makes web-tier items of the web search's results, one per page", () => {
    const long = "x".repeat(900);
    const items = webSearchEvidence([
      web("https://example.test/a", long, "  Page A  "),
      web("https://example.test/a", "the same page again"),
      web("https://genius.com/Vanilla-ice-ice-ice-baby-lyrics"),
      web("javascript:alert(1)"),
      web("https://example.test/empty", "   "),
      web("https://example.test/b", "Recorded in Miami.", ""),
    ]);

    expect(items).toEqual([
      {
        id: "tavily:https://example.test/a",
        source: "tavily",
        sourceTier: "web",
        url: "https://example.test/a",
        title: "Page A",
        retrievedAt: AT,
        excerpt: `${"x".repeat(499)}…`,
        recordRef: null,
      },
      {
        id: "tavily:https://example.test/b",
        source: "tavily",
        sourceTier: "web",
        url: "https://example.test/b",
        title: "https://example.test/b",
        retrievedAt: AT,
        excerpt: "Recorded in Miami.",
        recordRef: null,
      },
    ]);
    const pack = new EvidencePack();
    expect(pack.addAll(items)).toBe(2);
  });
});

describe("the pack", () => {
  const primary = (scope: "track" | "work" | "release", n: number) =>
    primaryEvidence({
      source: "musicbrainz",
      recordRef: scopedRef(scope, `recording/r${n}`),
      url: `https://musicbrainz.org/recording/r${n}`,
      title: `Record ${n}`,
      excerpt: `MusicBrainz record ${n}.`,
      retrievedAt: AT,
    });
  const sealed = (...items: ReturnType<typeof primary>[]) =>
    primaryRecordEvidence({
      musicbrainz: found("musicbrainz", [], items),
      discogs: { status: "missing", error: null },
      genius: { status: "missing", error: null },
      secondhandsongs: { status: "missing", error: null },
    } as unknown as PrimarySources);

  it("keeps an id once, the first item", () => {
    const pack = new EvidencePack();
    const [first] = webSearchEvidence([web("https://example.test/a", "first")]);
    const [again] = webSearchEvidence([web("https://example.test/a", "second")]);
    expect(pack.add(first)).toBe(true);
    expect(pack.add(again)).toBe(false);
    expect(pack.items().map((e) => e.excerpt)).toEqual(["first"]);
  });

  it("lists the recording's records, then a release's, then the song's, then the web", () => {
    const pack = new EvidencePack();
    pack.addAll(webSearchEvidence([web("https://example.test/a")]));
    pack.addAll(sealed(primary("work", 1), primary("track", 2), primary("release", 3)));
    pack.addAll(sealed(primary("track", 4)));
    expect(pack.items().map((e) => e.recordRef ?? e.id)).toEqual([
      "track/recording/r2",
      "track/recording/r4",
      "release/recording/r3",
      "work/recording/r1",
      "tavily:https://example.test/a",
    ]);
  });

  it("keeps at most its cap, leaving out the lowest-ranked items and counting them", () => {
    expect(EVIDENCE_PACK_MAX_ITEMS).toBe(80);
    const pack = new EvidencePack(3);
    pack.addAll(webSearchEvidence([web("https://example.test/a"), web("https://example.test/b")]));
    pack.addAll(sealed(primary("work", 1), primary("track", 2)));
    expect(pack.size).toBe(4);
    expect(pack.omitted).toBe(1);
    expect(pack.items().map((e) => e.id)).toEqual([
      "musicbrainz:track/recording/r2",
      "musicbrainz:work/recording/r1",
      "tavily:https://example.test/a",
    ]);
  });
});

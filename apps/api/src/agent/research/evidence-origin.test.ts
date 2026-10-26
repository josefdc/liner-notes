/**
 * Where the evidence pack's items come from: only from a source's answer. A research summary a
 * model wrote, an object shaped like Evidence (such as one parsed from a model's JSON) or a copy
 * of a real item cannot be added; the pack keeps an id once, orders by tier and caps its size.
 */

import {
  type Evidence,
  Evidence as EvidenceSchema,
  evidenceIssues,
  SourceId,
} from "@liner-notes/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveCoverOf } from "../../replay/cover.js";
import { collectPrimarySources, type PrimarySources } from "../../sources/identity.js";
import { evidenceForPrompt, shownEvidence } from "../prompts.js";
import { stubLlm, testRuntime } from "../testing/stubLlm.js";
import { lastingAmong, runEvidence } from "./runEvidence.js";
import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import { found, primaryEvidence, scopedRef } from "../../sources/records.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceError } from "../../sources/http.js";
import { failed, unexpectedShape } from "../../sources/records.js";
import { type FetchRoute, never, stubFetch } from "../../sources/testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "../../sources/testing/iceIceBaby.js";
import {
  EVIDENCE_PACK_MAX_ITEMS,
  EvidenceOriginError,
  EvidencePack,
  lostRecords,
  primaryRecordEvidence,
  primarySourceErrors,
  restoredEvidence,
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

describe("evidence given back by the research cache", () => {
  /** A real pack's items as the research cache stores and reads them (JSON, parsed). */
  async function storedPack(): Promise<Evidence[]> {
    const pack = new EvidencePack();
    pack.addAll(primaryRecordEvidence(await iceIceBaby()));
    pack.addAll(webSearchEvidence([web("https://example.test/ice-ice-baby")]));
    return JSON.parse(JSON.stringify(pack.items())).map((item: unknown) =>
      EvidenceSchema.parse(item),
    );
  }

  const RECORDING = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
  /** What the cached run read: the recording, not the song's original, no Discogs or Genius. */
  const context = {
    readAt: AT,
    recordingMbid: RECORDING,
    trackIsOriginal: false,
    configured: { discogs: false, genius: false },
    track: { title: "Ice Ice Baby", artist: "Vanilla Ice" },
  };

  it("restores what a pack held, as items a pack takes again", async () => {
    const stored = await storedPack();
    const restored = restoredEvidence(stored, context);
    expect(restored).toEqual(stored);
    const pack = new EvidencePack();
    expect(pack.addAll(restored ?? [])).toBe(stored.length);
    // A stored item itself is still refused by the pack: only the restored copy is taken.
    expect(() => pack.add(stored[0] as SourcedEvidence)).toThrow(EvidenceOriginError);
  });

  it("refuses the whole cached evidence when one item is not what a source module builds", async () => {
    const stored = await storedPack();
    const [primary] = stored;
    const page = stored.find((e) => e.sourceTier === "web") as Evidence;
    const cover = stored.find(
      (e) => e.source === "musicbrainz" && e.recordRef?.startsWith("work/"),
    ) as Evidence;
    const coverOfTrack = cover.recordRef?.replace(/^work\/[^/]+/, `track/recording/${RECORDING}`);
    // The release that stands for the recording (sources/identity.ts) is restored with the rest.
    const release = stored.find(
      (e) => e.source === "musicbrainz" && e.recordRef?.startsWith("release/"),
    ) as Evidence;
    expect(release.url).toBe(`https://musicbrainz.org/${release.recordRef}`);
    const discogs = {
      ...primary,
      id: "discogs:release/123/credit/0",
      source: "discogs" as const,
      url: "https://www.discogs.com/release/123",
      excerpt: "Discogs release 123 credits Somebody Else as Producer on the whole release.",
      recordRef: "release/123/credit/0",
    };
    const forged: Array<[string, Evidence]> = [
      ["a summary filed as web search's primary record", { ...primary, source: "tavily" }],
      ["an editorial item", { ...primary, sourceTier: "editorial" }],
      ["an id that is not the source's", { ...primary, id: `${primary.id}/edited` }],
      [
        "a record without a scope",
        { ...primary, recordRef: "recording/x", id: "musicbrainz:recording/x" },
      ],
      ["a web page with a recordRef", { ...page, recordRef: "track/x" }],
      ["a web page whose id is not its URL", { ...page, id: "tavily:https://example.test/other" }],
      [
        "a lyric page",
        { ...page, url: "https://genius.com/x-lyrics", id: "tavily:https://genius.com/x-lyrics" },
      ],
      ["a placeholder text", { ...page, excerpt: "No results found." }],
      ["an item that breaks the contract", { ...primary, url: null, recordRef: null }],
      [
        "a web error page",
        {
          ...page,
          url: "https://example.test/err",
          id: "tavily:https://example.test/err",
          title: "404 Not Found",
          excerpt: "The requested URL was not found on this server.",
        },
      ],
      ["an item read after the run", { ...page, retrievedAt: "2027-06-01T00:00:00.000Z" }],
      ["a Discogs item while Discogs is not configured", discogs],
      [
        "a Genius item with a lyric excerpt",
        {
          ...primary,
          id: "genius:track/song/1/samples/2",
          source: "genius",
          url: "https://genius.com/Vanilla-ice-ice-ice-baby-lyrics",
          excerpt: "Yo, VIP, let's kick it! Ice ice baby, ice ice baby",
          recordRef: "track/song/1/samples/2",
        },
      ],
      ["a preview link", { ...primary, url: "https://p.scdn.co/mp3-preview/abc?cid=1" }],
      [
        "a cover of the song stated about the track, which is not the original",
        { ...cover, recordRef: coverOfTrack ?? null, id: `musicbrainz:${coverOfTrack}` },
      ],
      [
        "a MusicBrainz record of another recording",
        {
          ...primary,
          id: "musicbrainz:track/recording/00000000-0000-4000-8000-000000000000",
          recordRef: "track/recording/00000000-0000-4000-8000-000000000000",
          url: "https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000000",
        },
      ],
      ["a record on another site's page", { ...primary, url: "https://example.test/recording" }],
      [
        "a MusicBrainz release on another release's page",
        {
          ...release,
          url: "https://musicbrainz.org/release/00000000-0000-4000-8000-000000000000",
        },
      ],
      [
        "a second MusicBrainz release, which the module never writes",
        {
          ...release,
          id: "musicbrainz:release/00000000-0000-4000-8000-000000000000",
          recordRef: "release/00000000-0000-4000-8000-000000000000",
          url: "https://musicbrainz.org/release/00000000-0000-4000-8000-000000000000",
        },
      ],
      [
        "a MusicBrainz release with a path after its MBID",
        {
          ...release,
          id: `${release.id}/front`,
          recordRef: `${release.recordRef}/front`,
        },
      ],
    ];
    for (const [what, item] of forged) {
      expect(restoredEvidence([...stored, item], context), what).toBeNull();
    }
    // The checks hold the cached run's facts: a configured Discogs and an original recording.
    const configured = { ...context, configured: { discogs: true, genius: false } };
    expect(restoredEvidence([...stored, discogs], configured)).not.toBeNull();
    const original = { ...context, trackIsOriginal: true };
    const rescoped = {
      ...cover,
      recordRef: coverOfTrack ?? null,
      id: `musicbrainz:${coverOfTrack}`,
    };
    expect(restoredEvidence([...stored, rescoped], original)).not.toBeNull();
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
      web("https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3"),
      web("https://bucket.s3.amazonaws.com/press.pdf?X-Amz-Signature=abc123"),
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
  const discogsCredit = (scope: "track" | "release", n: number) =>
    primaryEvidence({
      source: "discogs",
      recordRef:
        scope === "track"
          ? scopedRef("track", `release/599648/credit/${n}`)
          : scopedRef("release", `599648/credit/${n}`),
      url: "https://www.discogs.com/release/599648",
      title: `Credit ${n}`,
      excerpt: `Discogs release 599648 credit ${n}.`,
      retrievedAt: AT,
    });
  const sealed = (...items: ReturnType<typeof primary>[]) =>
    primaryRecordEvidence({
      musicbrainz: found("musicbrainz", [], items),
      discogs: { status: "missing", error: null },
      genius: { status: "missing", error: null },
      secondhandsongs: { status: "missing", error: null },
    } as unknown as PrimarySources);

  it("writes a web page's id as the prompt shows it, so a citation of it is kept", () => {
    const [item] = webSearchEvidence([
      web("https://ja.example.test/wiki/アイス・アイス・ベイビー（曲）"),
    ]);
    expect(item.id).toMatch(/^tavily:https:\/\/ja\.example\.test\/wiki\/%[0-9A-F]{2}/);
    expect(item.url).toBe(item.id.slice("tavily:".length));
    expect(evidenceForPrompt([item])).toContain(JSON.stringify(item.id));
    expect(shownEvidence([item]).map((e) => e.id)).toEqual([item.id]);
  });

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
    pack.addAll(
      primaryRecordEvidence({
        musicbrainz: { status: "missing", error: null },
        discogs: found("discogs", [], [discogsCredit("release", 5)]),
        genius: { status: "missing", error: null },
        secondhandsongs: { status: "missing", error: null },
      } as unknown as PrimarySources),
    );
    expect(pack.items().map((e) => e.recordRef ?? e.id)).toEqual([
      // The release MusicBrainz names for the recording ranks with the recording's items.
      "track/recording/r2",
      "release/recording/r3",
      "track/recording/r4",
      "release/599648/credit/5",
      "work/recording/r1",
      "tavily:https://example.test/a",
    ]);
  });

  it("keeps the MusicBrainz release, and so a recorded cover, when the cap cuts a full pack", () => {
    // Every primary source full for an original recording: MusicBrainz's recording and 25
    // relationships, 25 at Genius and at SecondHandSongs (all about the track), Discogs credits.
    const RELEASE = "ae103b0a-b932-4009-acb6-388db1cf890b";
    const item = (source: "genius" | "secondhandsongs", n: number) =>
      primaryEvidence({
        source,
        recordRef: scopedRef("track", `song/1/samples/${n}`),
        url: source === "genius" ? "https://genius.com/x" : "https://secondhandsongs.com/work/1",
        title: `Record ${n}`,
        excerpt: `${source} record ${n}.`,
        retrievedAt: AT,
      });
    const release = primaryEvidence({
      source: "musicbrainz",
      recordRef: scopedRef("release", RELEASE),
      url: `https://musicbrainz.org/release/${RELEASE}`,
      title: "To the Extreme — MusicBrainz release",
      excerpt:
        'MusicBrainz: "Ice Ice Baby" by Vanilla Ice appears on the official album "To the Extreme".',
      retrievedAt: AT,
    });
    const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const sources = {
      musicbrainz: found(
        "musicbrainz",
        [],
        [...range(26).map((n) => primary("track", n)), release],
      ),
      discogs: found(
        "discogs",
        [],
        range(8).map((n) => discogsCredit("track", n)),
      ),
      genius: found(
        "genius",
        [],
        range(25).map((n) => item("genius", n)),
      ),
      secondhandsongs: found(
        "secondhandsongs",
        [],
        range(25).map((n) => item("secondhandsongs", n)),
      ),
    } as unknown as PrimarySources;
    const pack = new EvidencePack();
    pack.addAll(primaryRecordEvidence(sources));
    pack.addAll(webSearchEvidence([web("https://example.test/a")]));
    expect(pack.size).toBe(86);
    expect(pack.omitted).toBe(6);
    const kept = pack.items();
    expect(kept.map((e) => e.id)).toContain(`musicbrainz:release/${RELEASE}`);
    expect(archiveCoverOf({ evidence: kept })).toBe(
      `https://coverartarchive.org/release/${RELEASE}/front-500`,
    );
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

describe("what a primary source lost, and a bug in its reader", () => {
  it("reports a work read cut by the deadline as lost records, with the timeout", async () => {
    const work = "https://musicbrainz.org/ws/2/work/";
    const route: FetchRoute = (call) =>
      call.url.startsWith(work) ? never(call) : primaryRoute(call);
    stubFetch(route);
    const sources = await collectPrimarySources(ICE_TRACK, { now, deadlineMs: 300 });

    expect(sources.musicbrainz.status).toBe("found");
    expect(lostRecords(sources)).toEqual([
      {
        error: expect.objectContaining({ source: "musicbrainz", code: "timeout" }),
        note: expect.stringMatching(/the work "Ice Ice Baby" could not be read/),
      },
    ]);
    expect(primarySourceErrors(sources)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "musicbrainz", code: "timeout" })]),
    );
  });

  it("loses no record when the deadline cuts the dating of the work's recordings", async () => {
    // The releases are read last, on the dating signal: the cut leaves the release unnamed.
    const normal = primaryRecordEvidence(await iceIceBaby())
      .map((e) => e.id)
      .filter((id) => !id.startsWith("musicbrainz:release/"));
    const dating = "https://musicbrainz.org/ws/2/recording?work=";
    stubFetch((call) => (call.url.startsWith(dating) ? never(call) : primaryRoute(call)));
    const sources = await collectPrimarySources(ICE_TRACK, { now, deadlineMs: 300 });

    expect(lostRecords(sources)).toEqual([]);
    expect(primarySourceErrors(sources).filter((e) => e.source === "musicbrainz")).toEqual([]);
    // A note, not an error: the work's covers are listed, about the work.
    expect(sources.musicbrainz).toMatchObject({
      status: "found",
      incomplete: expect.stringMatching(/^dates incomplete: .*; releases incomplete: /),
    });
    expect(primaryRecordEvidence(sources).map((e) => e.id)).toEqual(normal);

    // The note is shown: the covers are less specific than a later run may give.
    const sent: Array<{ type: string; message?: string }> = [];
    const pack = await runEvidence(
      Promise.resolve({ status: "read", sources }),
      [],
      { writer: (event: never) => sent.push(event) } as never,
      testRuntime(stubLlm(() => ({}))),
    );
    expect(pack.lost).toEqual([]);
    const line =
      "MusicBrainz release dates incomplete: the work's recordings could not be dated, so its covers are not claimed for this recording; a later run reads them";
    expect(pack.status).toContain(line);
    expect(sent).toContainEqual(expect.objectContaining({ type: "status", message: line }));
    expect(pack.incomplete).toEqual([
      { source: "musicbrainz", part: "dates" },
      { source: "musicbrainz", part: "releases" },
    ]);
    expect(pack.status).toContain(
      "MusicBrainz releases incomplete: the recording's releases could not be read, so no release is named for it; a later run reads them",
    );
  });

  it("takes a lasting error as lasting only when no other error has its source and code", () => {
    const shape = {
      source: "secondhandsongs",
      code: "invalid_response",
      message: "unexpected",
    } as const;
    expect(lastingAmong([shape], [])).toEqual([shape]);
    expect(lastingAmong([shape], [{ source: "discogs", code: "not_configured" }])).toEqual([shape]);
    // The same source and code from elsewhere (another step): not lasting, so it blocks.
    expect(lastingAmong([shape], [{ ...shape, message: "unexpected" }])).toEqual([]);
    expect(
      lastingAmong([shape], [{ source: "secondhandsongs", code: "invalid_response" }]),
    ).toEqual([]);
  });

  it("lists no lost records when every request answered", async () => {
    expect(lostRecords(await iceIceBaby())).toEqual([]);
  });

  it("reports a TypeError in a reader as an internal error, not as the source's answer", () => {
    const bug = failed("secondhandsongs", new TypeError("name.trim is not a function"));
    expect(bug).toMatchObject({
      status: "missing",
      error: {
        source: "secondhandsongs",
        code: "unavailable",
        message: "internal error: name.trim is not a function",
      },
    });
    const shape = failed("secondhandsongs", unexpectedShape("secondhandsongs", "no versions"));
    expect(shape).toMatchObject({ error: { code: "invalid_response" } });
    const busy = failed("secondhandsongs", new SourceError("secondhandsongs", "timeout", "slow"));
    expect(busy).toMatchObject({ error: { code: "timeout" } });
  });
});

describe("who builds evidence", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const IMPORT = /import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+)\s+from\s+["']([^"']+)["']/g;

  it("only the source readers and agent/research import the evidence constructors", () => {
    const importers: Record<string, string[]> = {
      primaryEvidence: [],
      webSearchEvidence: [],
      restoredEvidence: [],
    };
    const modules: Record<string, RegExp> = {
      primaryEvidence: /records\.js$/,
      webSearchEvidence: /evidencePack\.js$/,
      restoredEvidence: /evidencePack\.js$/,
    };
    for (const path of files(SRC)) {
      const text = readFileSync(path, "utf8");
      for (const [, names = "", from] of text.matchAll(IMPORT)) {
        for (const [name, module] of Object.entries(modules)) {
          if (!module.test(from)) continue;
          if (names === "" || new RegExp(`\\b${name}\\b`).test(names)) {
            importers[name].push(relative(SRC, path));
          }
        }
      }
    }
    const allowed = (path: string) => /^(?:sources|agent\/research)\//.test(path);
    expect(importers.primaryEvidence.length).toBeGreaterThan(0);
    expect(importers.webSearchEvidence.length).toBeGreaterThan(0);
    expect(importers.restoredEvidence.length).toBeGreaterThan(0);
    expect(
      Object.values(importers)
        .flat()
        .filter((path) => !allowed(path)),
    ).toEqual([]);
  });
});

/**
 * Discogs release credits, against a stubbed API. fixtures/discogs-release-249504.json is the
 * release the Discogs API documentation uses as its example, cut to the fields read; the other
 * releases here are built inline in the same shape.
 */

import { Evidence as EvidenceSchema, evidenceIssues } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // So a local .env cannot set the User-Agent under test.
  process.env.MUSICBRAINZ_USER_AGENT = "";
  process.env.SOURCE_USER_AGENT = "";
});

import rickRoll from "./fixtures/discogs-release-249504.json" with { type: "json" };
import {
  creditCovers,
  creditRange,
  type DiscogsRelease,
  discogsReleaseId,
  discogsTrackCredits,
  findTrack,
  splitRoles,
  trackCredits,
} from "./discogs.js";
import { evidenceScope, type TrackRef } from "./records.js";
import { json, stubFetch } from "./testing/fetchStub.js";
import { recordThenReplay } from "./testing/roundTrip.js";
import { allStrings, randomStrings, timed } from "./testing/strings.js";

const TOKEN = "discogs-test-token-0123456789";
const now = () => new Date("2026-10-20T12:00:00.000Z");

const TRACK: TrackRef = {
  isrc: "GBARL9300135",
  title: "Never Gonna Give You Up",
  artists: ["Rick Astley"],
  durationMs: 213_573,
};

beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DISCOGS_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("without DISCOGS_TOKEN", () => {
  it("is missing, requests nothing and does not throw", async () => {
    delete process.env.DISCOGS_TOKEN;
    const net = stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits(TRACK, [249504]);
    expect(result).toMatchObject({
      status: "missing",
      reason: "DISCOGS_TOKEN is not set",
      error: { source: "discogs", code: "not_configured" },
      identity: { matched: 0, rejected: 0, missing: 0, unavailable: 1 },
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("with DISCOGS_TOKEN", () => {
  beforeEach(() => {
    process.env.DISCOGS_TOKEN = TOKEN;
  });

  it("sends the token in the Authorization header, never in the URL", async () => {
    const net = stubFetch(() => json(rickRoll));
    await discogsTrackCredits(TRACK, [249504], { now });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe("https://api.discogs.com/releases/249504");
    expect(net.calls[0].headers.authorization).toBe(`Discogs token=${TOKEN}`);
    expect(net.calls[0].headers["user-agent"]).toMatch(/^LinerNotes\//);
  });

  it("finds the track on the release and yields its credits as primary-record Evidence", async () => {
    stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits(TRACK, [249504], { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toEqual([
      expect.objectContaining({ name: "Me Company", roles: ["Design"], scope: "release" }),
      expect.objectContaining({
        name: "Stock / Aitken / Waterman",
        artistId: 20942,
        roles: ["Producer", "Written-By"],
        scope: "release",
        position: "A",
      }),
    ]);
    expect(result.identity).toEqual({ matched: 1, rejected: 0, missing: 0, unavailable: 0 });
    for (const item of result.evidence) {
      expect(evidenceIssues(EvidenceSchema.parse(item))).toEqual([]);
      expect(item).toMatchObject({
        source: "discogs",
        sourceTier: "primary-record",
        url: "https://www.discogs.com/release/249504",
        retrievedAt: "2026-10-20T12:00:00.000Z",
      });
    }
    expect(result.evidence[1].excerpt).toBe(
      'Discogs release 249504 ("Never Gonna Give You Up", 1987) credits Stock / Aitken / ' +
        'Waterman as Producer, Written-By on the whole release (which includes "Never Gonna Give You Up").',
    );
  });

  it("omits a release whose track is more than 5 s off the printed duration", async () => {
    stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits({ ...TRACK, durationMs: 219_000 }, [249504]);
    expect(result).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    expect(result.omitted[0].reason).toMatch(/^duration 212\.0 s is more than 5\.0 s/);
    expect("evidence" in result).toBe(false);
  });

  it("omits a release credited to other artists", async () => {
    stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits(
      { ...TRACK, artists: ["Rick Astley", "Kylie Minogue"] },
      [249504],
    );
    expect(result).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    expect(result.omitted[0].reason).toContain('credited to "Rick Astley"');
  });

  it("checks each linked release on its own and uses the first that holds the track", async () => {
    const other = { ...rickRoll, id: 1, tracklist: [{ position: "A", title: "Together Forever" }] };
    const net = stubFetch((call) => json(call.url.endsWith("/1") ? other : rickRoll));
    const result = await discogsTrackCredits(TRACK, [1, 249504, 7], { now });
    expect(result.status).toBe("found");
    expect(result.omitted).toEqual([
      { ref: "release/1", reason: 'no track titled "Never Gonna Give You Up" among 1 tracks' },
    ]);
    expect(net.calls.map((c) => c.url)).toEqual([
      "https://api.discogs.com/releases/1",
      "https://api.discogs.com/releases/249504",
    ]);
  });

  it("is missing when no release is linked", async () => {
    const net = stubFetch(() => undefined);
    const result = await discogsTrackCredits(TRACK, []);
    expect(result).toMatchObject({ status: "missing", identity: { missing: 1 } });
    expect(net.calls).toHaveLength(0);
  });

  it("is missing, with a typed error and no token in it, when Discogs fails", async () => {
    stubFetch(() => json({ message: "You are making requests too quickly." }, { status: 429 }));
    const limited = await discogsTrackCredits(TRACK, [249504]);
    expect(limited).toMatchObject({ status: "missing", error: { code: "rate_limited" } });

    stubFetch(() => {
      throw new TypeError(`Headers.append: "Discogs token=${TOKEN}" is an invalid header value.`);
    });
    const broken = await discogsTrackCredits(TRACK, [249504]);
    expect(broken.status).toBe("missing");
    expect(JSON.stringify(broken)).not.toContain(TOKEN);
  });

  it("replays the recorded run with no network; the cassette keeps only the fields read", async () => {
    const live = { ...rickRoll, notes: "Durations do not appear on the release.", images: [] };
    const run = await recordThenReplay(
      () => json(live),
      () => discogsTrackCredits(TRACK, [249504], { now }),
    );
    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
    expect(run.live.status).toBe("found");
    expect(run.cassettes.discogs).not.toContain("Durations do not appear");
    expect(run.cassettes.discogs).not.toContain(TOKEN);
  });
});

describe("credits filtered to the track", () => {
  const release: DiscogsRelease = {
    id: 10,
    title: "Example",
    artists: [{ name: "Rick Astley" }],
    extraartists: [
      { name: "Whole Release", role: "Mastered By", tracks: "" },
      { name: "Side A Only", role: "Mixed By", tracks: "A" },
      { name: "Side B Only", role: "Mixed By", tracks: "B" },
      { name: "A Range", role: "Engineer", tracks: "A to B" },
      { name: "No Role", role: "", tracks: "" },
    ],
    tracklist: [
      {
        position: "A",
        title: "Never Gonna Give You Up",
        duration: "3:32",
        extraartists: [{ name: "On The Track", role: "Keyboards [Synth], Programmed By" }],
      },
      { position: "B", title: "Never Gonna Give You Up (Instrumental)", duration: "3:30" },
    ],
  };

  it("keeps the track's credits and the release credits that cover its position", () => {
    const match = findTrack(release, TRACK);
    if (!match.ok) throw new Error(match.reason);
    expect(match.track.position).toBe("A");
    const { credits, ambiguous } = trackCredits(release, match.track);
    expect(ambiguous).toBe(0);
    expect(credits.map((c) => [c.name, c.scope])).toEqual([
      ["On The Track", "track"],
      ["Whole Release", "release"],
      ["Side A Only", "track"],
      ["A Range", "track"],
    ]);
    expect(credits[0].roles).toEqual(["Keyboards [Synth]", "Programmed By"]);
  });

  it("reads positions and ranges in the tracklist's order", () => {
    const order = ["A1", "A2", "B1", "B2"];
    expect(creditCovers("A1 to B1", "A2", order)).toBe(true);
    expect(creditCovers("A1 to B1", "B2", order)).toBe(false);
    expect(creditCovers("A1, B2", "b2", order)).toBe(true);
    expect(creditCovers("A1, B2", "A2", order)).toBe(false);
    expect(creditCovers(" ", "A2", order)).toBe("all");
  });

  it("takes the one track with a matching printed duration when titles repeat", () => {
    const twice: DiscogsRelease = {
      ...release,
      tracklist: [
        { position: "1", title: "Never Gonna Give You Up", duration: "" },
        { position: "2", title: "Never Gonna Give You Up", duration: "3:33" },
      ],
    };
    const match = findTrack(twice, TRACK);
    expect(match.ok && match.track.position).toBe("2");
    const untimed = { ...twice, tracklist: twice.tracklist?.map((t) => ({ ...t, duration: "" })) };
    expect(findTrack(untimed, TRACK)).toEqual({
      ok: false,
      reason: "2 tracks on the release match the track",
    });
  });

  it("reads Discogs' artist name forms", () => {
    const named = (name: string, anv = "") => ({
      ...release,
      artists: [{ name, anv }],
    });
    expect(findTrack(named("Rick Astley (2)"), TRACK).ok).toBe(true);
    expect(findTrack(named("Astley, Rick"), TRACK).ok).toBe(false);
    expect(findTrack(named("Rick Astley Band", "Rick Astley"), TRACK).ok).toBe(true);
    expect(findTrack(named("Persuader, The"), { ...TRACK, artists: ["The Persuader"] }).ok).toBe(
      true,
    );
  });

  it("splits roles at commas outside brackets", () => {
    expect(splitRoles("Producer, Written-By")).toEqual(["Producer", "Written-By"]);
    expect(splitRoles("Music By [All Tracks By, Uncredited]")).toEqual([
      "Music By [All Tracks By, Uncredited]",
    ]);
  });

  it("reads the release id from a Discogs release URL only", () => {
    expect(discogsReleaseId("https://www.discogs.com/release/599648")).toBe(599648);
    expect(
      discogsReleaseId("https://www.discogs.com/release/599648-Vanilla-Ice-To-The-Extreme"),
    ).toBe(599648);
    expect(discogsReleaseId("https://www.discogs.com/master/5427")).toBeNull();
    expect(discogsReleaseId("https://example.com/release/599648")).toBeNull();
  });
});

describe("repeated positions, caps, holes, headings and missing releases", () => {
  beforeEach(() => {
    process.env.DISCOGS_TOKEN = TOKEN;
  });

  /** Two discs, each numbered from 1 under its heading. */
  const twoDiscs: DiscogsRelease = {
    id: 20,
    title: "Deluxe",
    artists: [{ name: "Rick Astley" }],
    extraartists: [
      { name: "Producer One", role: "Producer", tracks: "2" },
      { name: "Remixer Two", role: "Remix", tracks: "1 to 2" },
      { name: "Everyone", role: "Mastered By", tracks: "" },
    ],
    tracklist: [
      { position: "", type_: "heading", title: "CD1" },
      { position: "1", type_: "track", title: "Intro", duration: "1:00" },
      { position: "2", type_: "track", title: "Other Song", duration: "4:00" },
      { position: "", type_: "heading", title: "CD2" },
      { position: "1", type_: "track", title: "Bonus", duration: "3:00" },
      { position: "2", type_: "track", title: "Never Gonna Give You Up", duration: "3:32" },
    ],
  };

  it("leaves out credits that name a position repeated on another disc", () => {
    const match = findTrack(twoDiscs, TRACK);
    if (!match.ok) throw new Error(match.reason);
    const { credits, ambiguous } = trackCredits(twoDiscs, match.track);
    // "2" and "1 to 2" may be CD1's; only the whole-release credit is certain.
    expect(credits.map((c) => c.name)).toEqual(["Everyone"]);
    expect(ambiguous).toBe(2);
    expect(creditCovers("2", "2", ["1", "2", "1", "2"])).toBe("ambiguous");
    expect(creditCovers("3", "2", ["1", "2", "1", "2"])).toBe(false);
    expect(creditCovers("B1 to B2", "A1", ["A1", "A2", "B1", "B2"])).toBe(false);
  });

  it("says so in the result when credits are left out", async () => {
    stubFetch(() => json(twoDiscs));
    const result = await discogsTrackCredits(TRACK, [20], { now });
    expect(result.status === "found" && result.incomplete).toBe(
      "2 credits name position 2, which repeats on the release; left out",
    );
  });

  it("lists at most 25 credits and says how many more there are", async () => {
    const many = {
      ...rickRoll,
      extraartists: Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        name: `Session Player ${i + 1}`,
        role: "Musician",
        tracks: "A",
      })),
    };
    stubFetch(() => json(many));
    const result = await discogsTrackCredits(TRACK, [249504], { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toHaveLength(25);
    expect(result.evidence).toHaveLength(25);
    expect(result.incomplete).toBe("5 more credits not listed");
  });

  it("skips a hole in the tracklist instead of losing the release", async () => {
    const holed = { ...rickRoll, tracklist: [null, ...rickRoll.tracklist, null] };
    stubFetch(() => json(holed));
    const result = await discogsTrackCredits(TRACK, [249504], { now });
    expect(result.status).toBe("found");
  });

  it("reports an answer that is not a release as an invalid response", async () => {
    stubFetch(() => json(["not", "a", "release"]));
    const result = await discogsTrackCredits(TRACK, [249504]);
    expect(result).toMatchObject({ status: "missing", error: { code: "invalid_response" } });
  });

  it("does not take a heading for a track", () => {
    const headed: DiscogsRelease = {
      ...twoDiscs,
      tracklist: [
        { position: "", type_: "heading", title: "Never Gonna Give You Up" },
        { position: "1", type_: "track", title: "Together Forever", duration: "3:20" },
      ],
    };
    expect(findTrack(headed, TRACK)).toMatchObject({ ok: false });
  });

  it("passes over a release Discogs does not have (not an identity rejection)", async () => {
    const net = stubFetch((call) =>
      call.url.endsWith("/404404")
        ? json({ message: "Release not found." }, { status: 404 })
        : json(rickRoll),
    );
    const result = await discogsTrackCredits(TRACK, [404404, 249504], { now });
    expect(result).toMatchObject({ status: "found", omitted: [], identity: { rejected: 0 } });
    expect(net.calls).toHaveLength(2);
    stubFetch(() => json({ message: "Release not found." }, { status: 404 }));
    const none = await discogsTrackCredits(TRACK, [404404]);
    expect(none).toMatchObject({
      status: "missing",
      reason: "Discogs has no release 404404",
      identity: { matched: 0, rejected: 0, missing: 1, unavailable: 0 },
    });
  });

  it("reads an artist name variation marked with a trailing asterisk", () => {
    expect(findTrack({ ...rickRoll, artists: [{ name: "Rick Astley*" }] }, TRACK).ok).toBe(true);
  });

  it("keeps the token out of the cassette even when the answer echoes it", async () => {
    const echo = { ...rickRoll, title: `Never Gonna Give You Up token=${TOKEN}` };
    const run = await recordThenReplay(
      () => json(echo),
      () => discogsTrackCredits(TRACK, [249504], { now }),
    );
    expect(run.live.status).toBe("found");
    expect(run.cassettes.discogs).not.toContain(TOKEN);
    const denied = await recordThenReplay(
      () => json({ message: `Invalid consumer token ${TOKEN}` }, { status: 401 }),
      () => discogsTrackCredits(TRACK, [249504]),
    );
    expect(denied.live.status).toBe("missing");
    expect(denied.cassettes.discogs).not.toContain(TOKEN);
  });
});

describe("releases without credits, and truthful reasons", () => {
  beforeEach(() => {
    process.env.DISCOGS_TOKEN = TOKEN;
  });

  it("moves on when the first release holding the track lists no credits for it", async () => {
    const bare = { ...rickRoll, id: 1, extraartists: [] };
    const net = stubFetch((call) => json(call.url.endsWith("/1") ? bare : rickRoll));
    const result = await discogsTrackCredits(TRACK, [1, 249504], { now });
    expect(result.status).toBe("found");
    expect(net.calls).toHaveLength(2);

    // At most three releases are read.
    const bounded = stubFetch(() => json(bare));
    const none = await discogsTrackCredits(TRACK, [1, 2, 3, 4], { now });
    expect(none).toMatchObject({
      status: "missing",
      reason:
        "Discogs release 1 lists no credits for the track; Discogs release 2 lists no credits for the track; Discogs release 3 lists no credits for the track",
      identity: { matched: 3 },
    });
    expect(bounded.calls).toHaveLength(3);
  });

  it("says when not every release was read, also when no Discogs link was found", async () => {
    const net = stubFetch(() => undefined);
    const note = "only 200 of the recording's 350 releases were read for Discogs links";
    const result = await discogsTrackCredits(TRACK, [], { note });
    expect(result).toMatchObject({
      status: "missing",
      reason: `MusicBrainz links no Discogs release to an original release of the recording; ${note}`,
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("matched counts and evidence scope", () => {
  beforeEach(() => {
    process.env.DISCOGS_TOKEN = TOKEN;
  });

  it("counts every release that held the track, found or failed", async () => {
    const bare = { ...rickRoll, id: 1, extraartists: [] };
    stubFetch((call) => json(call.url.endsWith("/1") ? bare : rickRoll));
    const result = await discogsTrackCredits(TRACK, [1, 249504], { now });
    expect(result).toMatchObject({ status: "found", identity: { matched: 2 } });

    stubFetch((call) =>
      call.url.endsWith("/1") ? json(bare) : json({ message: "boom" }, { status: 500 }),
    );
    const broken = await discogsTrackCredits(TRACK, [1, 2], { now });
    expect(broken).toMatchObject({
      status: "missing",
      error: { code: "unavailable" },
      identity: { matched: 1, unavailable: 1 },
    });
  });

  it("scopes a whole-release credit to the release and a track credit to the track", async () => {
    const mixed = {
      ...rickRoll,
      extraartists: [
        ...rickRoll.extraartists,
        { id: 9, name: "Side A Engineer", anv: "", role: "Engineer", tracks: "A" },
      ],
    };
    stubFetch(() => json(mixed));
    const result = await discogsTrackCredits(TRACK, [249504], { now });
    if (result.status !== "found") throw new Error(result.reason);
    const scopeOf = (name: string) => {
      const credit = result.records.find((c) => c.name === name);
      const item = result.evidence.find((e) => e.id === credit?.evidenceId);
      return item && evidenceScope(item);
    };
    expect(scopeOf("Me Company")).toBe("release");
    expect(scopeOf("Side A Engineer")).toBe("track");
  });

  it("reads Discogs' variation mark with an inverted article or a number", () => {
    const named = (name: string) => ({ ...rickRoll, artists: [{ name }] });
    const persuader = { ...TRACK, artists: ["The Persuader"] };
    expect(findTrack(named("Persuader, The*"), persuader).ok).toBe(true);
    expect(findTrack(named("Rick Astley (2)*"), TRACK).ok).toBe(true);
  });
});

describe("creditRange", () => {
  // The expression before #194: polynomial time on runs of whitespace and "to".
  const POLYNOMIAL = /^\s*(.+?)\s+to\s+(.+?)\s*$/i;
  const old = (part: string) => {
    const range = part.match(POLYNOMIAL);
    return range ? [range[1], range[2]] : null;
  };

  it("reads exactly the ranges the earlier expression read", () => {
    const realistic = [
      "A1 to A3",
      " B1 to B4 ",
      "1 to 3",
      "CD1-1 to CD1-12",
      "A1 TO A3",
      "A1 To B2",
      "Side A to Side B",
      "1-1 to 1-5",
      "A1to A3",
      "A1 toA3",
      "A1 to",
      "to A3",
      "A1 to A3 to B1",
      "A1\tto\tA3",
      "A1\nto\nA3",
      "A1\n to A3",
      "A1 to A3\n",
      "A\n1 to A3",
      "A1 to A\n3",
      "   to A3",
      " \n to A3",
      "A1 to    ",
      "A1 to \n",
      "A1 to \n\n ",
      "A1 to x\u2028",
      "A1\u00a0to\u00a0A3",
      "",
      " ",
    ];
    const symbols = [" ", "\t", "\n", "\u2028", "\u00a0", "t", "T", "o", "O", "A1"];
    const parts = [
      " ",
      "  ",
      "\t",
      "\n",
      "\r\n",
      "to",
      "TO",
      "To",
      "t",
      "o",
      "A1",
      "B2",
      "Side",
      " to ",
    ];
    const cases = [...realistic, ...allStrings(symbols, 5), ...randomStrings(parts, 20_000, 14)];

    for (const part of cases) expect(creditRange(part), JSON.stringify(part)).toEqual(old(part));
    // Both kinds of answer are exercised.
    expect(cases.filter((part) => old(part) !== null).length).toBeGreaterThan(1000);
    expect(cases.filter((part) => old(part) === null).length).toBeGreaterThan(1000);
  });

  it("answers quickly on a field built to make the earlier expression backtrack", () => {
    // About 4 s with the earlier expression.
    const run = "\t".repeat(80);
    const tracks = `${run}T${run}\nTO\t${run}\t\tTO${run}\nT`;
    const { ms, result } = timed(() => creditCovers(tracks, "A1", ["A1", "A2"]));
    expect(ms).toBeLessThan(100);
    expect(result).toBe(false);
  });
});

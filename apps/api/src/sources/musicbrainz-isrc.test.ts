/**
 * MusicBrainz ISRC lookup and recording relationships, on answers captured from the live API
 * (fixtures/musicbrainz-*, cut to the fields read): "Ice Ice Baby" (USCA29001716), "Under
 * Pressure" (GBUM71106916) and "BIRDS OF A FEATHER" (USUM72401994).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import birdsIsrc from "./fixtures/musicbrainz-isrc-birds-of-a-feather.json" with { type: "json" };
import iceIsrc from "./fixtures/musicbrainz-isrc-ice-ice-baby.json" with { type: "json" };
import underPressureIsrc from "./fixtures/musicbrainz-isrc-under-pressure.json" with {
  type: "json",
};
import iceDetails from "./fixtures/musicbrainz-recording-details-ice-ice-baby.json" with {
  type: "json",
};
import underPressureDetails from "./fixtures/musicbrainz-recording-details-under-pressure.json" with {
  type: "json",
};
import iceWork from "./fixtures/musicbrainz-work-ice-ice-baby.json" with { type: "json" };
import { json, stubFetch } from "./testing/fetchStub.js";
import hallelujahDetails from "./fixtures/musicbrainz-recording-details-hallelujah-live.json" with {
  type: "json",
};
import iceWorkRecordings1 from "./fixtures/musicbrainz-work-recordings-ice-ice-baby-1.json" with {
  type: "json",
};
import {
  browseRecordingReleases,
  browseWorkRecordings,
  creditString,
  getRecordingDetails,
  lookupIsrc,
  type MbRecordingDetails,
  MusicBrainzRateLimiter,
  normalizeIsrc,
  normalizeName,
  recordingRelationships,
  withoutFeatured,
  workCovers,
} from "./musicbrainz.js";

const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());
beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("lookupIsrc", () => {
  it("asks for the ISRC with artist credits and returns every recording filed under it", async () => {
    const net = stubFetch(() => json(iceIsrc));
    const recordings = await lookupIsrc("usca2-9001716");
    expect(net.calls[0].url).toBe(
      "https://musicbrainz.org/ws/2/isrc/USCA29001716?inc=artist-credits&fmt=json",
    );
    expect(recordings.map((r) => [r.title, r.length])).toEqual([
      ["Ice Ice Baby (radio edit)", 231_773],
      ["Ice Ice Baby (radio mix)", 268_280],
      ["Ice Ice Baby (radio edit)", 232_000],
      ["Ice Ice Baby", 271_000],
      ["Ice Ice Baby", 226_666],
    ]);
  });

  it("reads the credit of a two-artist recording and of a recent one", async () => {
    stubFetch((call) =>
      call.url.includes("GBUM71106916") ? json(underPressureIsrc) : json(birdsIsrc),
    );
    const underPressure = await lookupIsrc("GBUM71106916");
    expect(underPressure.map((r) => r.id)).toContain(UNDER_PRESSURE);
    expect(underPressure[0]["artist-credit"]?.map((c) => c.name)).toEqual(["Queen", "David Bowie"]);
    const birds = await lookupIsrc("USUM72401994");
    expect(birds).toHaveLength(1);
    expect(birds[0]).toMatchObject({ title: "BIRDS OF A FEATHER", length: 210_266 });
  });

  it("returns no recordings when MusicBrainz answers 404 for the ISRC", async () => {
    stubFetch(() => json({ error: "Not Found" }, { status: 404 }));
    await expect(lookupIsrc("USSM19000034")).resolves.toEqual([]);
  });

  it("rejects a malformed ISRC without a request", async () => {
    const net = stubFetch(() => undefined);
    await expect(lookupIsrc("USCA2900171")).rejects.toMatchObject({ kind: "invalid_input" });
    expect(net.calls).toHaveLength(0);
    expect(normalizeIsrc(" gb-um7-11-06916 ")).toBe("GBUM71106916");
    expect(normalizeIsrc("GBUM7110691X")).toBeNull();
  });

  it("still fails on any other error", async () => {
    stubFetch(() => json({ error: "boom" }, { status: 500 }));
    await expect(lookupIsrc("USCA29001716")).rejects.toMatchObject({ kind: "http", status: 500 });
  });
});

describe("getRecordingDetails and browseRecordingReleases", () => {
  it("asks for recording, work and URL relationships, and the works' URLs", async () => {
    const net = stubFetch(() => json(iceDetails));
    await getRecordingDetails(ICE);
    const url = new URL(net.calls[0].url);
    expect(url.pathname).toBe(`/ws/2/recording/${ICE}`);
    expect(url.searchParams.get("inc")).toBe(
      "artist-credits recording-rels work-rels work-level-rels url-rels",
    );
  });

  it("reads the next page of releases while there are more, up to the page limit", async () => {
    const release = (n: number) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      title: "To the Extreme",
    });
    const net = stubFetch((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset"));
      const size = offset === 0 ? 100 : 30;
      return json({
        "release-count": 130,
        releases: Array.from({ length: size }, (_, i) => release(offset + i)),
      });
    });
    const { releases, total } = await browseRecordingReleases(ICE);
    expect(total).toBe(130);
    expect(releases).toHaveLength(130);
    const params = net.calls.map((c) => new URL(c.url).searchParams);
    expect(params.map((p) => p.get("offset"))).toEqual(["0", "100"]);
    expect(params[0].get("recording")).toBe(ICE);
    expect(params[0].get("status")).toBe("official");
    expect(params[0].get("inc")).toBe("url-rels release-groups");

    const capped = stubFetch(() =>
      json({ "release-count": 500, releases: Array.from({ length: 100 }, (_, i) => release(i)) }),
    );
    await browseRecordingReleases(ICE, 2);
    expect(capped.calls).toHaveLength(2);
  });
});

describe("recordingRelationships", () => {
  it("reads what Ice Ice Baby samples and what samples it, by the relationship's direction", () => {
    const relations = recordingRelationships(iceDetails as MbRecordingDetails);
    expect(relations.map((r) => [r.kind, r.recording?.title, r.recording?.artist])).toEqual([
      ["samples", "Under Pressure", "Queen & David Bowie"],
      ["sampled-by", "Ice Ice Bacon", "Trotters"],
      ["sampled-by", "Pushin' Ice", "Malice"],
    ]);
    expect(relations[0].recording?.mbid).toBe(UNDER_PRESSURE);
  });

  it("reads the remixes of Under Pressure and what samples it", () => {
    const relations = recordingRelationships(underPressureDetails as MbRecordingDetails);
    expect(relations.filter((r) => r.kind === "remixed-by").map((r) => r.recording?.title)).toEqual(
      [
        "Under Pressure (Knebworth mix)",
        "Under Pressure (Mike Spencer mix)",
        "Under Pressure (Rah mix)",
      ],
    );
    expect(relations.filter((r) => r.kind === "sampled-by").map((r) => r.recording?.title)).toEqual(
      ["Come Again", "Ice Ice Baby"],
    );
    expect(relations.some((r) => r.kind === "samples")).toBe(false);
  });

  it("reads a forward remix as a remix of the other recording, and a cover performance", () => {
    const relations = recordingRelationships({
      id: ICE,
      title: "Ice Ice Baby (Miami Drop)",
      relations: [
        {
          type: "remix",
          direction: "forward",
          recording: { id: UNDER_PRESSURE, title: "Under Pressure" },
        },
        {
          type: "performance",
          direction: "forward",
          attributes: ["cover"],
          work: { id: "e0ebb61d-7f69-3667-a2b1-dcd447d80f3d", title: "Ice Ice Baby" },
        },
        {
          type: "performance",
          direction: "forward",
          attributes: [],
          work: { id: "e0ebb61d-7f69-3667-a2b1-dcd447d80f3d", title: "Ice Ice Baby" },
        },
      ],
    });
    expect(relations.map((r) => r.kind)).toEqual(["remix-of", "cover-of"]);
    expect(relations[1].work?.title).toBe("Ice Ice Baby");
  });
});

describe("workCovers", () => {
  it("lists the recordings filed as covers of the work, not the original", () => {
    const covers = workCovers(iceWork, ICE);
    expect(covers).toHaveLength(6);
    expect(covers.every((c) => c.kind === "covered-by")).toBe(true);
    expect(covers.map((c) => c.recording?.artist)).toContain("Faith No More");
    expect(covers.some((c) => c.recording?.mbid === ICE)).toBe(false);
    // When the track is itself one of the covers, it is not listed as covering itself.
    const own = covers[0].recording?.mbid as string;
    expect(workCovers(iceWork, own).map((c) => c.recording?.mbid)).not.toContain(own);
    expect(workCovers(iceWork, own)).toHaveLength(5);
  });
});

describe("work recordings, duplicates and name normalisation", () => {
  it("reads a work's recordings with their first release dates, page by page", async () => {
    const net = stubFetch((call) => {
      const offset = new URL(call.url).searchParams.get("offset");
      return json(offset === "0" ? iceWorkRecordings1 : { "recording-count": 117, recordings: [] });
    });
    const { recordings, total } = await browseWorkRecordings(
      "e0ebb61d-7f69-3667-a2b1-dcd447d80f3d",
    );
    expect(total).toBe(117);
    expect(recordings).toHaveLength(100);
    expect(recordings.find((r) => r.id === ICE)?.["first-release-date"]).toBe("1990-09-04");
    const params = net.calls.map((c) => new URL(c.url).searchParams);
    expect(params.map((p) => p.get("offset"))).toEqual(["0", "100"]);
    expect(params[0].get("work")).toBe("e0ebb61d-7f69-3667-a2b1-dcd447d80f3d");
  });

  it("reads a relationship filed twice once", () => {
    // Jeff Buckley's live "Hallelujah" (USSM10902080) performs the work twice, dated 1995-01-31
    // and 1995-01.
    expect(hallelujahDetails.relations).toHaveLength(2);
    const relations = recordingRelationships(hallelujahDetails as MbRecordingDetails);
    expect(relations.map((r) => [r.kind, r.work?.title])).toEqual([["cover-of", "Hallelujah"]]);
  });

  it("reads a credit that is not a list as no credit", () => {
    expect(creditString({ name: "Queen" } as never)).toBe("");
    expect(creditString(undefined)).toBe("");
  });

  it("keeps the marks that change a letter outside the Latin script", () => {
    expect(normalizeName("バカ")).not.toBe(normalizeName("ハカ"));
    expect(normalizeName("Beyoncé")).toBe("beyonce");
    expect(normalizeName("Sigur Rós")).toBe(normalizeName("Sigur Ros"));
  });

  it("strips a featured-artist note, not a title that looks like one", () => {
    expect(withoutFeatured("Stay (With Me)")).toBe("Stay (With Me)");
    expect(withoutFeatured("Welcome to Ft. Lauderdale")).toBe("Welcome to Ft. Lauderdale");
    expect(withoutFeatured("Song (feat. Anyone)")).toBe("Song");
    expect(withoutFeatured("Song [ft. Anyone]")).toBe("Song");
    expect(withoutFeatured("Song - feat. Anyone")).toBe("Song");
    expect(withoutFeatured("Song (with Rihanna)", ["Eminem", "Rihanna"])).toBe("Song");
    expect(withoutFeatured("Song feat. Rihanna", ["Eminem", "Rihanna"])).toBe("Song");
    expect(withoutFeatured("Song feat. Rihanna", ["Eminem"])).toBe("Song feat. Rihanna");
  });

  it("reads an ISRC written with en dashes or spaces", () => {
    expect(normalizeIsrc("US–UM7–24–01994")).toBe("USUM72401994");
    expect(normalizeIsrc("USUM7 2401994")).toBe("USUM72401994");
  });
});

describe("the shared queue and a request's signal", () => {
  it("lets an aborted request leave the queue at once, without taking a slot", async () => {
    const limiter = MusicBrainzRateLimiter.getInstance();
    const restore = limiter.setIntervalForTests(300);
    try {
      const net = stubFetch(() => json(birdsIsrc));
      // Six requests ahead, 300 ms apart: about 1.5 s of waiting.
      const ahead = Array.from({ length: 6 }, () => lookupIsrc("USUM72401994"));
      const controller = new AbortController();
      const started = Date.now();
      const late = lookupIsrc("USCA29001716", controller.signal);
      setTimeout(() => controller.abort(), 50);
      await expect(late).rejects.toMatchObject({ kind: "aborted" });
      expect(Date.now() - started).toBeLessThan(500);
      expect(limiter.pending).toBeLessThanOrEqual(6);
      await Promise.all(ahead);
      expect(net.calls.some((c) => c.url.includes("USCA29001716"))).toBe(false);
      // An already aborted request is never queued.
      await expect(lookupIsrc("USCA29001716", AbortSignal.abort())).rejects.toMatchObject({
        kind: "aborted",
      });
    } finally {
      restore();
    }
  });

  it("reports a deadline reached in the queue as a timeout", async () => {
    const limiter = MusicBrainzRateLimiter.getInstance();
    const restore = limiter.setIntervalForTests(300);
    try {
      stubFetch(() => json(birdsIsrc));
      const ahead = Array.from({ length: 4 }, () => lookupIsrc("USUM72401994"));
      await expect(lookupIsrc("USCA29001716", AbortSignal.timeout(50))).rejects.toMatchObject({
        kind: "timeout",
      });
      await Promise.all(ahead);
    } finally {
      restore();
    }
  });

  it("does not retry a shed request once its signal has aborted, nor wait out the delay", async () => {
    const controller = new AbortController();
    const net = stubFetch(() => {
      controller.abort();
      return json({ error: "slow down" }, { status: 503, headers: { "retry-after": "2" } });
    });
    const started = Date.now();
    await expect(lookupIsrc("USCA29001716", controller.signal)).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(net.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1000);

    // Aborted during the delay before the retry: rejects at once.
    const during = new AbortController();
    const shed = stubFetch(() => json({ error: "slow down" }, { status: 503 }));
    const pending = lookupIsrc("USCA29001716", during.signal);
    setTimeout(() => during.abort(), 50);
    const began = Date.now();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(shed.calls).toHaveLength(1);
  });

  it("reads a non-string ISRC as no ISRC", () => {
    expect(normalizeIsrc(undefined)).toBeNull();
    expect(normalizeIsrc(12345)).toBeNull();
  });
});

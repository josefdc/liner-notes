/**
 * Client-side pacing of Discogs and SecondHandSongs (sources/pacing.ts, `pacedFetchJson`), with
 * fake timers and a stubbed network: requests start at most at the source's pace, a request whose
 * slot is too far away is refused as rate limited without being sent, and a 429 is retried once
 * after its Retry-After, then reported as a typed `rate_limited` error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rickRoll from "./fixtures/discogs-release-249504.json" with { type: "json" };
import work from "./fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import { DISCOGS_PACE, discogsTrackCredits } from "./discogs.js";
import { isSourceError, MAX_RETRY_WAIT_MS, pacedFetchJson } from "./http.js";
import { type Pace, RequestPacer, setUnpacedForTests } from "./pacing.js";
import type { TrackRef } from "./records.js";
import { SHS_ANONYMOUS_PACE, SHS_KEYED_PACE, shsPace, shsRelationships } from "./shs.js";
import { type FetchCall, json, stubFetch } from "./testing/fetchStub.js";

const START = new Date("2026-10-20T12:00:00.000Z").getTime();
const SHS_WORK = "https://secondhandsongs.com/work/4196";
const WORK_LINK = { kind: "work", id: 4196, from: "work" } as const;
const ICE: TrackRef = {
  isrc: "USCA29001716",
  title: "Ice Ice Baby",
  artists: ["Vanilla Ice"],
  durationMs: 271_733,
};
const RICK: TrackRef = {
  isrc: "GBARL9300135",
  title: "Never Gonna Give You Up",
  artists: ["Rick Astley"],
  durationMs: 213_573,
};

beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  delete process.env.SHS_API_KEY;
  delete process.env.DISCOGS_TOKEN;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: START });
  setUnpacedForTests(false);
});
afterEach(() => {
  setUnpacedForTests(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** When each request started, in ms after START. */
const startsOf = (calls: Array<FetchCall & { at?: number }>) => calls.map((c) => c.at);

/** A stub that notes when each request reached it. */
function timedStub(answer: (call: FetchCall, index: number) => Response) {
  const calls: Array<FetchCall & { at: number }> = [];
  const net = stubFetch((call) => {
    calls.push({ ...call, at: Date.now() - START });
    return answer(call, calls.length - 1);
  });
  return { net, calls };
}

describe("a pacer", () => {
  const pace = (p: Partial<Pace> = {}): Pace => ({ intervalMs: 1000, maxWaitMs: 10_000, ...p });

  it("starts requests at most one per interval, in order", async () => {
    const pacer = new RequestPacer("Test", () => pace());
    const started: number[] = [];
    const all = Promise.all(
      [0, 1, 2, 3].map(() => pacer.slot().then(() => started.push(Date.now() - START))),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(started).toEqual([0, 1000, 2000, 3000]);
  });

  it("keeps a budget per window: past it, a request waits for the oldest start to leave", async () => {
    const pacer = new RequestPacer("Test", () =>
      pace({ intervalMs: 0, budget: { max: 2, windowMs: 60_000 }, maxWaitMs: 120_000 }),
    );
    const started: number[] = [];
    const all = Promise.all(
      [0, 1, 2].map(() => pacer.slot().then(() => started.push(Date.now() - START))),
    );
    await vi.advanceTimersByTimeAsync(61_000);
    await all;
    expect(started).toEqual([0, 0, 60_000]);
  });

  it("refuses at once a request whose slot is further than it may wait, and keeps no slot for it", async () => {
    const pacer = new RequestPacer("Test", () => pace({ maxWaitMs: 1500 }));
    await pacer.slot();
    const second = pacer.slot();
    await expect(pacer.slot()).rejects.toMatchObject({ name: "PaceRefused", waitMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    // The refused request took no slot: the next one starts one interval after the second.
    const next = pacer.slot();
    let at = -1;
    void next.then(() => {
      at = Date.now() - START;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toBe(2000);
  });

  it("gives the slot back when its request is cancelled while it waits", async () => {
    const pacer = new RequestPacer("Test", () => pace());
    await pacer.slot();
    const cancel = new AbortController();
    const waiting = pacer.slot(cancel.signal);
    cancel.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    const next = pacer.slot();
    let at = -1;
    void next.then(() => {
      at = Date.now() - START;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toBe(1000);
  });

  it("holds every request after the source asked to slow down", async () => {
    const pacer = new RequestPacer("Test", () => pace({ intervalMs: 0 }));
    pacer.holdFor(3000);
    let at = -1;
    void pacer.slot().then(() => {
      at = Date.now() - START;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(at).toBe(3000);
  });
});

describe("a paced request", () => {
  const pacer = () => new RequestPacer("Test", () => ({ intervalMs: 1000, maxWaitMs: 5000 }));
  const request = { source: "secondhandsongs" as const, url: SHS_WORK };

  it("is retried once after the Retry-After of a 429, and then answers", async () => {
    const { calls } = timedStub((_call, i) =>
      i === 0
        ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } })
        : json({ ok: true }),
    );
    const answer = pacedFetchJson(pacer(), request);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(answer).resolves.toEqual({ ok: true });
    expect(startsOf(calls)).toEqual([0, 3000]);
  });

  it("reports a second 429 as a typed rate limit, after one retry only", async () => {
    const { calls } = timedStub(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    );
    const answer = pacedFetchJson(pacer(), request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await answer;
    expect(isSourceError(error, "rate_limited")).toBe(true);
    expect((error as Error).message).toMatch(/rate limited \(HTTP 429\); retry after 1 s/);
    expect(calls).toHaveLength(2);
  });

  it("does not wait out a Retry-After longer than it honours", async () => {
    const { calls } = timedStub(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
    );
    const error = await pacedFetchJson(pacer(), request).catch((e: unknown) => e);
    expect(isSourceError(error, "rate_limited")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(MAX_RETRY_WAIT_MS).toBeLessThan(120_000);
  });

  it("is refused as rate limited, and not sent, when its slot is too far away", async () => {
    const { calls } = timedStub(() => json({ ok: true }));
    const slow = new RequestPacer("Test", () => ({ intervalMs: 10_000, maxWaitMs: 5000 }));
    await pacedFetchJson(slow, request);
    const error = await pacedFetchJson(slow, request).catch((e: unknown) => e);
    expect(isSourceError(error, "rate_limited")).toBe(true);
    expect((error as Error).message).toMatch(/paced: the next Test request may start in 10 s/);
    expect(calls).toHaveLength(1);
  });

  it("is not paced when it is replayed from a cassette", async () => {
    vi.stubEnv("SOURCE_CASSETTE", "replay");
    const slow = new RequestPacer("Test", () => ({ intervalMs: 10_000, maxWaitMs: 0 }));
    const errors = await Promise.all(
      [0, 1].map(() => pacedFetchJson(slow, request).catch((e: unknown) => e)),
    );
    // Both reach the cassette (which has no entry): neither is refused by the pacer.
    for (const error of errors) expect(isSourceError(error, "cassette_miss")).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("Discogs and SecondHandSongs are paced", () => {
  it("Discogs: one release request a little over every second", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const { calls } = timedStub((call) =>
      call.url.endsWith("/249504")
        ? json(rickRoll)
        : json({ id: Number(call.url.split("/").pop()), title: "Other", tracklist: [] }),
    );
    const result = discogsTrackCredits(RICK, [1, 2, 249504], {});
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).status).toBe("found");
    expect(startsOf(calls)).toEqual([0, DISCOGS_PACE.intervalMs, 2 * DISCOGS_PACE.intervalMs]);
    expect(DISCOGS_PACE.intervalMs).toBeGreaterThanOrEqual(1000); // ≤ 60 a minute
  });

  it("Discogs: a 429 is retried once after its Retry-After, then the credits are read", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const { calls } = timedStub((_call, i) =>
      i === 0
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : json(rickRoll),
    );
    const result = discogsTrackCredits(RICK, [249504], {});
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).status).toBe("found");
    expect(startsOf(calls)).toEqual([0, 2000]);
  });

  it("SecondHandSongs: two 429s give the source's typed rate_limited error", async () => {
    const { calls } = timedStub(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    );
    const result = shsRelationships(ICE, [WORK_LINK]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({
      status: "missing",
      error: { source: "secondhandsongs", code: "rate_limited" },
    });
    expect(calls).toHaveLength(2);
  });

  it("SecondHandSongs: anonymous requests 6 s apart, at most 100 an hour; faster with a key", async () => {
    expect(shsPace()).toBe(SHS_ANONYMOUS_PACE);
    expect(SHS_ANONYMOUS_PACE).toMatchObject({
      intervalMs: 6000,
      budget: { max: 100, windowMs: 3_600_000 },
    });
    const { calls } = timedStub(() => json(work));
    const both = Promise.all([
      shsRelationships(ICE, [WORK_LINK]),
      shsRelationships(ICE, [WORK_LINK]),
    ]);
    await vi.advanceTimersByTimeAsync(7000);
    for (const result of await both) expect(result.status).toBe("found");
    expect(startsOf(calls)).toEqual([0, 6000]);

    process.env.SHS_API_KEY = "shs-test-key-0123456789";
    expect(shsPace()).toBe(SHS_KEYED_PACE);
  });
});

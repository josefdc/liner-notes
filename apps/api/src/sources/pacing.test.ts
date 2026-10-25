/**
 * Client-side pacing of Discogs and SecondHandSongs (sources/pacing.ts, `pacedFetchJson`), with
 * fake timers and a stubbed network: requests start at most at the source's pace and budgets; a
 * request whose slot is too far away, or after the caller's deadline, is refused without being
 * sent (the source is "not asked", never a timeout); a 429 holds the source for its Retry-After
 * (bounded) and is retried once, then reported as a typed `rate_limited` error; and pacing is
 * on by default.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rickRoll from "./fixtures/discogs-release-249504.json" with { type: "json" };
import work from "./fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import { DISCOGS_PACE, discogsTrackCredits } from "./discogs.js";
import { isSourceError, MAX_RETRY_WAIT_MS, pacedFetchJson } from "./http.js";
import {
  type Lane,
  type LanePace,
  LanePacer,
  MAX_HOLD_MS,
  type Pace,
  PaceRefused,
  pacingClock,
  RequestPacer,
  setUnpacedForTests,
} from "./pacing.js";
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
const FAKE = ["setTimeout", "clearTimeout", "Date", "performance"] as const;

let t0 = 0;
beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  delete process.env.SHS_API_KEY;
  delete process.env.DISCOGS_TOKEN;
  vi.useFakeTimers({ toFake: [...FAKE], now: START });
  t0 = pacingClock();
  setUnpacedForTests(false);
});
afterEach(() => {
  setUnpacedForTests(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Ms since the test started, on the pacers' clock. */
const elapsed = () => Math.round(pacingClock() - t0);

/** A stub that notes when each request reached it. */
function timedStub(answer: (call: FetchCall, index: number) => Response) {
  const calls: Array<FetchCall & { at: number }> = [];
  stubFetch((call) => {
    calls.push({ ...call, at: elapsed() });
    return answer(call, calls.length - 1);
  });
  return calls;
}
const startsOf = (calls: Array<{ at: number }>) => calls.map((c) => c.at);

/** Starts `n` slots of `pacer` at once; the times they were granted, or the refusals. */
async function slots(pacer: RequestPacer, n: number, advanceMs: number) {
  const out: Array<number | string> = [];
  const all = Promise.all(
    Array.from({ length: n }, () =>
      pacer.slot().then(
        () => out.push(elapsed()),
        (error: unknown) => out.push(error instanceof PaceRefused ? "refused" : String(error)),
      ),
    ),
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  await all;
  return out;
}

describe("a pacer", () => {
  const pace = (p: Partial<Pace> = {}): Pace => ({ intervalMs: 1000, maxWaitMs: 10_000, ...p });

  it("starts requests at most one per interval, in order", async () => {
    expect(await slots(new RequestPacer("Test", () => pace()), 4, 5000)).toEqual([
      0, 1000, 2000, 3000,
    ]);
  });

  it("keeps every budget: past one, a request waits for its oldest start to leave", async () => {
    const pacer = new RequestPacer("Test", () =>
      pace({
        intervalMs: 0,
        budgets: [
          { max: 2, windowMs: 10_000 },
          { max: 3, windowMs: 60_000 },
        ],
        maxWaitMs: 120_000,
      }),
    );
    expect(await slots(pacer, 4, 61_000)).toEqual([0, 0, 10_000, 60_000]);
  });

  it("keeps no more starts than its longest budget window holds, and none without a budget", async () => {
    const budgeted = new RequestPacer("Test", () =>
      pace({ intervalMs: 0, budgets: [{ max: 1000, windowMs: 1000 }] }),
    );
    for (let i = 0; i < 50; i++) {
      await budgeted.slot();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(budgeted.kept).toBeLessThanOrEqual(11);
    const plain = new RequestPacer("Test", () => pace({ intervalMs: 0 }));
    for (let i = 0; i < 50; i++) await plain.slot();
    expect(plain.kept).toBe(0);
  });

  it("refuses at once a request whose slot is further than it may wait, and keeps no slot for it", async () => {
    const pacer = new RequestPacer("Test", () => pace({ maxWaitMs: 1500 }));
    expect(await slots(pacer, 3, 2000)).toEqual([0, "refused", 1000]);
    // The refused request took no slot: the next one starts one interval after the second.
    expect(await slots(pacer, 1, 1000)).toEqual([2000]);
  });

  it("refuses a request whose slot comes after the caller's deadline", async () => {
    const pacer = new RequestPacer("Test", () => pace());
    await pacer.slot();
    await expect(pacer.slot({ notAfter: pacingClock() + 500 })).rejects.toBeInstanceOf(PaceRefused);
    const granted = pacer.slot({ notAfter: pacingClock() + 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(granted).resolves.toBeUndefined();
  });

  it("gives the slot back when its request is cancelled while it waits", async () => {
    const pacer = new RequestPacer("Test", () => pace());
    await pacer.slot();
    const cancel = new AbortController();
    const waiting = pacer.slot({ signal: cancel.signal });
    cancel.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(await slots(pacer, 1, 1000)).toEqual([1000]);
  });

  it("holds every request after the source asked to slow down, at most MAX_HOLD_MS", async () => {
    const pacer = new RequestPacer("Test", () =>
      pace({ intervalMs: 0, maxWaitMs: 2 * MAX_HOLD_MS }),
    );
    expect(pacer.holdFor(3000)).toBe(3000);
    expect(await slots(pacer, 1, 3000)).toEqual([3000]);
    expect(pacer.holdFor(10 * 365 * 24 * 3600 * 1000)).toBe(MAX_HOLD_MS);
    expect(await slots(pacer, 1, MAX_HOLD_MS)).toEqual([3000 + MAX_HOLD_MS]);
  });

  it("makes a request already waiting for its slot wait out a hold that came meanwhile", async () => {
    const pacer = new RequestPacer("Test", () => pace({ maxWaitMs: 120_000 }));
    const granted: number[] = [];
    const all = Promise.all([0, 1, 2].map(() => pacer.slot().then(() => granted.push(elapsed()))));
    await vi.advanceTimersByTimeAsync(0);
    pacer.holdFor(60_000);
    await vi.advanceTimersByTimeAsync(62_000);
    await all;
    // The first had started; the two waiting take new slots after the hold, still paced.
    expect(granted).toEqual([0, 60_000, 61_000]);
  });

  it("reads a monotonic clock: a step of the wall clock moves no slot", async () => {
    const pacer = new RequestPacer("Test", () => pace());
    await pacer.slot();
    vi.setSystemTime(START - 3600_000);
    expect(await slots(pacer, 1, 1000)).toEqual([1000]);
  });
});

describe("a lane pacer", () => {
  const lanePace = (p: Partial<LanePace> = {}): LanePace => ({
    windowMs: 5000,
    max: 4,
    backgroundMax: 3,
    maxWaitMs: 10_000,
    ...p,
  });
  /** Starts `n` requests of `lane` at once; when each started, or "refused". */
  const starts = (pacer: LanePacer, n: number, lane: Lane, options: { notAfter?: number } = {}) => {
    const out: Array<number | string> = [];
    const all = Promise.all(
      Array.from({ length: n }, () =>
        pacer.slot({ lane, ...options }).then(
          () => out.push(elapsed()),
          (error: unknown) => out.push(error instanceof PaceRefused ? "refused" : String(error)),
        ),
      ),
    );
    return { out, all };
  };

  it("starts at most `max` requests in any window, and at most `backgroundMax` background ones", async () => {
    const pacer = new LanePacer("Test", () => lanePace());
    const background = starts(pacer, 4, "background");
    await vi.advanceTimersByTimeAsync(0);
    const priority = starts(pacer, 2, "priority");
    await vi.advanceTimersByTimeAsync(11_000);
    await Promise.all([background.all, priority.all]);

    expect(background.out).toEqual([0, 0, 0, 5000]);
    // One slot of the first window was left; the other priority request takes the next.
    expect(priority.out).toEqual([0, 5000]);
  });

  it("starts a waiting priority request before the background ones that waited longer", async () => {
    const pacer = new LanePacer("Test", () => lanePace({ backgroundMax: 4 }));
    const first = starts(pacer, 4, "background");
    const waiting = starts(pacer, 2, "background");
    await vi.advanceTimersByTimeAsync(1000);
    const order: string[] = [];
    void waiting.all.then(() => order.push("background"));
    const priority = pacer.slot({ lane: "priority" }).then(() => {
      order.push(`priority at ${elapsed()}`);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first.all, waiting.all, priority]);

    expect(order[0]).toBe("priority at 5000");
    expect(waiting.out).toEqual([5000, 5000]);
  });

  it("refuses at once a request whose slot is later than its deadline or too far away", async () => {
    const pacer = new LanePacer("Test", () => lanePace({ maxWaitMs: 4000 }));
    await starts(pacer, 4, "priority").all;

    const late = starts(pacer, 1, "background", { notAfter: pacingClock() + 4000 });
    const far = starts(pacer, 1, "priority");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([late.all, far.all]);

    expect(late.out).toEqual(["refused"]);
    expect(far.out).toEqual(["refused"]);
    // Neither took a slot.
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pacer.slot().then(() => elapsed())).toBe(5000);
  });

  it("refuses a background request that priority ones kept waiting past its deadline", async () => {
    const pacer = new LanePacer("Test", () => lanePace({ max: 2 }));
    await starts(pacer, 2, "priority").all;
    const background = starts(pacer, 1, "background", { notAfter: pacingClock() + 6000 });
    await vi.advanceTimersByTimeAsync(1000);
    // Two priority requests come ahead of it: the next window is theirs.
    const priority = starts(pacer, 2, "priority");
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([background.all, priority.all]);

    expect(priority.out).toEqual([5000, 5000]);
    expect(background.out).toEqual(["refused"]);
  });

  it("lets a waiting request leave at once when its signal aborts, taking no slot", async () => {
    const pacer = new LanePacer("Test", () => lanePace({ max: 1 }));
    await pacer.slot();
    const controller = new AbortController();
    const waiting = pacer.slot({ signal: controller.signal }).then(
      () => "started",
      () => `left at ${elapsed()}`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await waiting).toBe("left at 1000");
    expect(pacer.waiting).toBe(0);
    const next = pacer.slot().then(() => elapsed());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await next).toBe(5000);
  });
});

describe("pacing is on by default", () => {
  it("paces a pacer of a fresh module, without the tests' switch", async () => {
    vi.resetModules();
    const fresh = await import("./pacing.js");
    const pacer = new fresh.RequestPacer("Test", () => ({ intervalMs: 1000, maxWaitMs: 10 }));
    await pacer.slot();
    await expect(pacer.slot()).rejects.toBeInstanceOf(fresh.PaceRefused);
  });

  it("is switched off only by tests and their setup", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
      });
    const callers = files(src)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith("sources/pacing.ts"))
      .filter((path) => readFileSync(path, "utf8").includes("setUnpacedForTests"))
      .map((path) => relative(src, path));
    expect(callers).toEqual([]);
  });
});

describe("a paced request", () => {
  const pacer = (p: Partial<Pace> = {}) =>
    new RequestPacer("Test", () => ({ intervalMs: 1000, maxWaitMs: 60_000, ...p }));
  const request = { source: "secondhandsongs" as const, url: SHS_WORK };
  const tooMany = (after: string) =>
    new Response("slow down", { status: 429, headers: { "retry-after": after } });

  it("is retried once after the Retry-After of a 429, and then answers", async () => {
    const calls = timedStub((_call, i) => (i === 0 ? tooMany("3") : json({ ok: true })));
    const answer = pacedFetchJson(pacer(), request);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(answer).resolves.toEqual({ ok: true });
    expect(startsOf(calls)).toEqual([0, 3000]);
  });

  it("reports a second 429 as a typed rate limit, after one retry only", async () => {
    const calls = timedStub(() => tooMany("1"));
    const answer = pacedFetchJson(pacer(), request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await answer;
    expect(isSourceError(error, "rate_limited")).toBe(true);
    expect((error as Error).message).toMatch(/rate limited \(HTTP 429\); retry after 1 s/);
    expect(calls).toHaveLength(2);
  });

  it("does not wait out a Retry-After over 5 s, and holds the source for it", async () => {
    const calls = timedStub(() => tooMany("120"));
    const paced = pacer({ maxWaitMs: 60_000 });
    const error = await pacedFetchJson(paced, request).catch((e: unknown) => e);
    expect(isSourceError(error, "rate_limited")).toBe(true);
    expect(MAX_RETRY_WAIT_MS).toBeLessThan(120_000);
    // The next request is not sent inside the hold: its slot is too far away.
    await expect(pacedFetchJson(paced, request)).rejects.toBeInstanceOf(PaceRefused);
    expect(calls).toHaveLength(1);
  });

  it("bounds a Retry-After that is huge or a far date, and takes a past date for none", async () => {
    for (const after of ["99999999", "Fri, 01 Jan 2100 00:00:00 GMT"]) {
      const calls = timedStub(() => tooMany(after));
      const start = elapsed();
      const paced = pacer({ maxWaitMs: 2 * MAX_HOLD_MS });
      await pacedFetchJson(paced, request).catch(() => {});
      const next = pacedFetchJson(paced, request).catch(() => {});
      await vi.advanceTimersByTimeAsync(MAX_HOLD_MS + 1000);
      await next;
      expect(calls).toHaveLength(2);
      expect(calls[1].at - start).toBeLessThanOrEqual(MAX_HOLD_MS + 1000);
    }
    // A date in the past says nothing: the default 2 s wait before the one retry.
    const calls = timedStub((_call, i) =>
      i === 0 ? tooMany("Mon, 01 Jan 2001 00:00:00 GMT") : json({ ok: true }),
    );
    const start = elapsed();
    const answer = pacedFetchJson(pacer({ intervalMs: 0 }), request);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(answer).resolves.toEqual({ ok: true });
    expect(startsOf(calls).map((t) => t - start)).toEqual([0, 2000]);
  });

  it("is refused, and not sent, when its slot is too far away; a refusal is never retried", async () => {
    const calls = timedStub(() => json({ ok: true }));
    const slow = new RequestPacer("Test", () => ({ intervalMs: 10_000, maxWaitMs: 5000 }));
    await pacedFetchJson(slow, request);
    const error = await pacedFetchJson(slow, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaceRefused);
    expect((error as Error).message).toMatch(/paced: the next Test request may start in 10 s/);
    expect(calls).toHaveLength(1);
    // Nor does a refusal hold the source: the next request goes at its own slot.
    await vi.advanceTimersByTimeAsync(6000);
    const next = pacedFetchJson(slow, request);
    await vi.advanceTimersByTimeAsync(4000);
    await next;
    expect(startsOf(calls)).toEqual([0, 10_000]);
  });

  it("is refused, never a timeout, when the deadline comes while it waits for its slot", async () => {
    const calls = timedStub(() => json({ ok: true }));
    const paced = pacer();
    await pacedFetchJson(paced, request);
    const deadline = new AbortController();
    const waiting = pacedFetchJson(paced, { ...request, signal: deadline.signal }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(100);
    deadline.abort(new DOMException("deadline reached", "TimeoutError"));
    expect(await waiting).toMatchObject({ name: "PaceRefused", why: "deadline" });
    expect(calls).toHaveLength(1);
  });

  it("is not sent, and takes no slot, when the deadline has passed before it is made", async () => {
    const calls = timedStub(() => json({ ok: true }));
    const paced = pacer();
    const deadline = new AbortController();
    deadline.abort(new DOMException("deadline reached", "TimeoutError"));
    const error = await pacedFetchJson(paced, { ...request, signal: deadline.signal }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: "PaceRefused", why: "deadline" });
    expect(calls).toHaveLength(0);
    // The next request starts at once: the refused one reserved nothing.
    await pacedFetchJson(paced, request);
    expect(startsOf(calls)).toEqual([0]);
  });

  it("is stopped, not refused, when the caller cancels it", async () => {
    timedStub(() => json({ ok: true }));
    const cancel = new AbortController();
    cancel.abort(new Error("cancelled"));
    const error = await pacedFetchJson(pacer(), { ...request, signal: cancel.signal }).catch(
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(PaceRefused);
    expect(isSourceError(error, "aborted")).toBe(true);
  });

  it("is not paced when it is replayed from a cassette", async () => {
    vi.stubEnv("SOURCE_CASSETTE", "replay");
    const slow = new RequestPacer("Test", () => ({ intervalMs: 10_000, maxWaitMs: 0 }));
    const errors = await Promise.all(
      [0, 1].map(() => pacedFetchJson(slow, request).catch((e: unknown) => e)),
    );
    // Both reach the cassette (which has no entry): neither is refused by the pacer.
    for (const error of errors) expect(isSourceError(error, "cassette_miss")).toBe(true);
  });
});

describe("Discogs and SecondHandSongs are paced", () => {
  it("Discogs: at most 55 a minute, at least 200 ms apart", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    expect(DISCOGS_PACE).toMatchObject({
      intervalMs: 200,
      budgets: [{ max: 55, windowMs: 60_000 }],
    });
    const calls = timedStub((call) =>
      call.url.endsWith("/249504")
        ? json(rickRoll)
        : json({ id: Number(call.url.split("/").pop()), title: "Other", tracklist: [] }),
    );
    const result = discogsTrackCredits(RICK, [1, 2, 249504], {});
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).status).toBe("found");
    expect(startsOf(calls)).toEqual([0, 200, 400]);
  });

  it("Discogs: a 429 is retried once after its Retry-After, then the credits are read", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const calls = timedStub((_call, i) =>
      i === 0
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : json(rickRoll),
    );
    const result = discogsTrackCredits(RICK, [249504], {});
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).status).toBe("found");
    expect(startsOf(calls)).toEqual([0, 2000]);
  });

  it("Discogs: a request our pacing does not send is not asked, with no source error", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const calls = timedStub(() => json(rickRoll));
    // Two runs at once whose deadline leaves 100 ms: the second's slot (200 ms) is too late.
    const notAfter = pacingClock() + 100;
    const [first, second] = await Promise.all([
      discogsTrackCredits(RICK, [249504], { notAfter }),
      discogsTrackCredits(RICK, [249504], { notAfter }),
    ]);
    expect(first.status).toBe("found");
    expect(second).toMatchObject({ status: "missing", error: null, notAsked: "pace" });
    expect(calls).toHaveLength(1);
  });

  it("SecondHandSongs: two 429s give the source's typed rate_limited error", async () => {
    const calls = timedStub(
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

  it("SecondHandSongs anonymous: 10 a minute and 100 an hour; a key allows 60 a minute", async () => {
    expect(shsPace()).toBe(SHS_ANONYMOUS_PACE);
    expect(SHS_ANONYMOUS_PACE.budgets).toEqual([
      { max: 10, windowMs: 60_000 },
      { max: 100, windowMs: 3_600_000 },
    ]);
    const calls = timedStub(() => json(work));
    const all = Promise.all(Array.from({ length: 11 }, () => shsRelationships(ICE, [WORK_LINK])));
    await vi.advanceTimersByTimeAsync(61_000);
    for (const result of await all) expect(result.status).toBe("found");
    // A burst of ten, 250 ms apart; the eleventh when the first leaves the minute.
    expect(startsOf(calls)).toEqual([...Array.from({ length: 10 }, (_, i) => i * 250), 60_000]);

    process.env.SHS_API_KEY = "shs-test-key-0123456789";
    expect(shsPace()).toBe(SHS_KEYED_PACE);
  });
});

/**
 * Test helper: runs a MusicBrainz queue test on a fake clock, so the spacing and order it checks
 * are what the queue enforces, not when a loaded machine got round to each request.
 *
 *   queueOnFakeClock(60);
 *   await settleOnFakeClock(Promise.all([findArtist("Queen"), findArtist("Vanilla Ice")]));
 */

import { expect, onTestFinished, vi } from "vitest";
import { MusicBrainzRateLimiter } from "../musicbrainz.js";

/**
 * Fakes setTimeout, Date and performance and sets the queue's interval to `intervalMs` until the
 * test ends. It assumes the queue times its requests with those clocks and waits with
 * setTimeout. However the test ends (a timeout included), the real timers and the interval come
 * back and the queue is reset to idle and empty: a wait the fake clock dropped would otherwise
 * leave it jammed for the rest of the file. The fake timers are not run out there, because the
 * test's fetch stub is already gone by then.
 */
export function queueOnFakeClock(intervalMs: number): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const limiter = MusicBrainzRateLimiter.getInstance();
  const restoreInterval = limiter.setIntervalForTests(intervalMs);
  onTestFinished(() => {
    vi.useRealTimers();
    restoreInterval();
    limiter.resetForTests();
  });
}

/**
 * Runs the fake timers until none are left, then returns `work`. Fails at once, rather than at
 * the test timeout, when `work` is still pending by then (something waited outside the fake
 * clock).
 */
export async function settleOnFakeClock<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  work.then(mark, mark);
  await vi.runAllTimersAsync();
  expect(settled, "requests still pending after the fake timers ran out").toBe(true);
  return work;
}

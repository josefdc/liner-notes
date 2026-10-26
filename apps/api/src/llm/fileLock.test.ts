import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  acquireLock,
  LockTimeoutError,
  PID_NAMESPACE,
  removeIfSame,
  withLock,
} from "./fileLock.js";

let dir: string;
let target: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-lock-"));
  target = join(dir, "spend.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A pid that no process has: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(child.stdout.toString());
}

describe("file lock", () => {
  it("lets one holder in at a time", async () => {
    let inside = 0;
    let overlap = false;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(target, async () => {
          inside += 1;
          if (inside > 1) overlap = true;
          await new Promise((r) => setTimeout(r, 5));
          inside -= 1;
        }),
      ),
    );
    expect(overlap).toBe(false);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("fails after waitMs while a live process holds the lock", async () => {
    const release = await acquireLock(target);
    await expect(acquireLock(target, { waitMs: 50 })).rejects.toBeInstanceOf(LockTimeoutError);
    await release();
    await (await acquireLock(target, { waitMs: 50 }))();
  });

  /**
   * Runs `wait` on a wall clock that moves with real time and steps by `step` ms 20 ms in; its
   * outcome (what it resolved to or threw, or "still waiting" after 3 s) and how long it took,
   * on the monotonic clock.
   */
  async function withWallClockStep<T>(step: number, wait: () => Promise<T>) {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const started = performance.now();
    setTimeout(() => vi.setSystemTime(Date.now() + step), 20);
    const gaveUp = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3_000));
    const outcome = await Promise.race([wait().catch((error: unknown) => error), gaveUp]);
    return { outcome, took: performance.now() - started };
  }

  it.each([
    ["back an hour", -60 * 60_000],
    ["forward 10 s", 10_000],
  ])(
    "waits waitMs on the monotonic clock when the wall clock steps %s during the wait",
    async (_label, step) => {
      const release = await acquireLock(target);
      onTestFinished(release);

      const { outcome, took } = await withWallClockStep(step, () =>
        acquireLock(target, { waitMs: 200 }),
      );

      expect(outcome).toBeInstanceOf(LockTimeoutError);
      expect(took).toBeGreaterThanOrEqual(200);
    },
  );

  it("breaks a lock left by a crash elsewhere before giving up, though the wall clock steps back", async () => {
    // Only its age can show this lock is stale: its owner runs on another host.
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: process.pid, host: "another-host", token: "crashed", at: Date.now() }),
    );

    const { outcome } = await withWallClockStep(-60 * 60_000, () =>
      acquireLock(target, { staleMs: 300, waitMs: 1_000 }),
    );

    expect(typeof outcome).toBe("function");
    expect(JSON.parse(readFileSync(`${target}.lock`, "utf8")).pid).toBe(process.pid);
    await (outcome as () => Promise<void>)();
  });

  it("breaks a lock left by a process that died", async () => {
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({
        pid: deadPid(),
        host: hostname(),
        pidns: PID_NAMESPACE,
        token: "dead",
        at: 0,
      }),
    );
    const release = await acquireLock(target, { waitMs: 200 });
    expect(JSON.parse(readFileSync(`${target}.lock`, "utf8")).pid).toBe(process.pid);
    await release();
  });

  it("breaks a lock older than staleMs whoever holds it", async () => {
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: process.pid, host: "another-host", token: "old", at: 0 }),
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${target}.lock`, old, old);
    await (await acquireLock(target, { waitMs: 200, staleMs: 60_000 }))();
  });

  it("does not break a recent lock of a live process on another host", async () => {
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: 1, host: "another-host", token: "live", at: Date.now() }),
    );
    await expect(acquireLock(target, { waitMs: 50 })).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("releases only its own lock", async () => {
    const release = await acquireLock(target);
    // Someone broke it and took it meanwhile: the old holder must leave the new lock alone.
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: process.pid, host: hostname(), token: "other", at: Date.now() }),
    );
    await release();
    expect(existsSync(`${target}.lock`)).toBe(true);
  });

  it("holds an empty lock younger than staleMs: it may be one being written", async () => {
    writeFileSync(`${target}.lock`, "");
    await expect(acquireLock(target, { waitMs: 100, staleMs: 10_000 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    expect(existsSync(`${target}.lock`)).toBe(true);
    const old = new Date(Date.now() - 20_000);
    utimesSync(`${target}.lock`, old, old);
    await (await acquireLock(target, { waitMs: 200, staleMs: 10_000 }))();
  });

  it("does not test the pid of an owner in another PID namespace", async () => {
    writeFileSync(
      `${target}.lock`,
      JSON.stringify({
        pid: deadPid(),
        host: hostname(),
        pidns: "pid:[other-namespace]",
        token: "elsewhere",
        at: Date.now(),
      }),
    );
    await expect(acquireLock(target, { waitMs: 100 })).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("waits longer than the stale age by default, so a crash leftover is broken in time", async () => {
    writeFileSync(`${target}.lock`, "");
    const old = new Date(Date.now() - 500);
    utimesSync(`${target}.lock`, old, old);
    // staleMs 1 s and no waitMs: the waiter outlasts the lock's remaining second.
    const started = Date.now();
    await (await acquireLock(target, { staleMs: 1000 }))();
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("breaks a stale lock once when many waiters see it, and keeps one holder at a time", async () => {
    writeFileSync(`${target}.lock`, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${target}.lock`, old, old);
    let inside = 0;
    let overlap = false;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        withLock(
          target,
          async () => {
            inside += 1;
            if (inside > 1) overlap = true;
            await new Promise((r) => setTimeout(r, 3));
            inside -= 1;
          },
          { staleMs: 60_000 },
        ),
      ),
    );
    expect(overlap).toBe(false);
  });

  it("does not remove a lock that changed since it was judged stale (same inode, new content)", async () => {
    const lock = `${target}.lock`;
    writeFileSync(lock, "");
    const info = statSync(lock);
    const seen = { owner: null, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
    // The same inode now holds a lock being written (no token yet), as after inode reuse.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(lock, "{");
    await removeIfSame(lock, seen);
    expect(readFileSync(lock, "utf8")).toBe("{");
    // Unchanged, it is removed.
    const now = statSync(lock);
    await removeIfSame(lock, { owner: null, ino: now.ino, mtimeMs: now.mtimeMs, size: now.size });
    expect(existsSync(lock)).toBe(false);
  });
});

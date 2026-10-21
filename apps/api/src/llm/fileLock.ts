/**
 * A lock shared by processes on one machine: an exclusive lock file next to the guarded file.
 *
 *   <path>.lock        created with O_CREAT | O_EXCL; holds { pid, host, pidns, token, at }
 *   <path>.lock.break  taken (the same way) by a process that removes a stale lock
 *
 * The caller names the guarded file by its resolved path (budget.ts), so a symlink and its
 * target share one lock.
 *
 * A lock is broken only when it is provably stale:
 *   - its owner runs on this host, in this PID namespace, and no longer exists (a crash); or
 *   - it is older than `staleMs` (an owner elsewhere, a reused pid, a lock left empty by a crash
 *     between create and write). An empty or unreadable lock younger than that is held.
 * By default a waiter waits longer than `staleMs`, so a lock left by a crash is always broken
 * before a waiter gives up. The guarded sections are short (read a file, append a line).
 *
 * Breaking: holding the break lock, the breaker renames the stale lock to a unique name and
 * checks that what it renamed is the lock it judged stale (same inode and token). If it is not,
 * because another process broke it and took a fresh lock meanwhile, it links the file back. A
 * break lock is itself broken only under the same rules. Release removes the lock only while it
 * still holds this holder's token.
 *
 * Remaining window: a breaker that renames a live lock while yet another process creates a new
 * lock before the rename is undone leaves two holders. That needs a crashed holder plus three
 * processes interleaving within microseconds.
 */

import { randomUUID } from "node:crypto";
import { readlinkSync } from "node:fs";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";

export interface LockOptions {
  /** How long to wait for the lock before failing (default: staleMs + 5 s). */
  waitMs?: number;
  /** Age after which a lock is broken whoever holds it (default 30 s). */
  staleMs?: number;
}

export class LockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";
  constructor(readonly lockPath: string) {
    super(`lock ${lockPath} is held by another process`);
  }
}

interface LockOwner {
  pid: number;
  host: string;
  pidns: string | null;
  token: string;
  at: number;
}

const POLL_MS = 5;
export const DEFAULT_STALE_MS = 30_000;

/** This process's PID namespace (Linux), so a pid is only tested where it means something. */
export const PID_NAMESPACE: string | null = (() => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
})();

const ownerRecord = (token: string): LockOwner => ({
  pid: process.pid,
  host: hostname(),
  pidns: PID_NAMESPACE,
  token,
  at: Date.now(),
});

/** False when no process has this pid. EPERM means it exists but belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockOwner>;
    if (typeof value.token !== "string" || typeof value.pid !== "number") return null;
    return value as LockOwner;
  } catch {
    return null;
  }
}

/** Creates `path` exclusively with `content`; false when it already exists. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

interface Seen {
  owner: LockOwner | null;
  ino: number;
}

/** The lock as seen now when it is provably stale; null when it is held (or gone). */
async function staleLock(path: string, staleMs: number): Promise<Seen | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  const owner = await readOwner(path);
  if (Date.now() - info.mtimeMs > staleMs) return { owner, ino: info.ino };
  // Being written, or a crash leftover not yet old enough: held.
  if (owner === null) return null;
  const sameNamespace = owner.host === hostname() && (owner.pidns ?? null) === PID_NAMESPACE;
  return sameNamespace && !processAlive(owner.pid) ? { owner, ino: info.ino } : null;
}

/** Moves `path` aside if it is still the file judged stale, and puts it back if it is not. */
async function removeIfSame(path: string, seen: Seen): Promise<void> {
  const aside = `${path}.stale.${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch {
    return; // already gone
  }
  const [info, owner] = await Promise.all([stat(aside).catch(() => null), readOwner(aside)]);
  const same = info?.ino === seen.ino && (owner?.token ?? null) === (seen.owner?.token ?? null);
  if (!same) {
    // A fresh lock was moved: put it back, unless someone has taken the name meanwhile.
    await link(aside, path).catch(() => {});
  }
  await unlink(aside).catch(() => {});
}

async function breakStale(lockPath: string, seen: Seen, staleMs: number): Promise<void> {
  const breakPath = `${lockPath}.break`;
  const token = randomUUID();
  if (!(await createExclusive(breakPath, JSON.stringify(ownerRecord(token))))) {
    const staleBreak = await staleLock(breakPath, staleMs);
    if (staleBreak) await removeIfSame(breakPath, staleBreak);
    return; // the caller starts again
  }
  try {
    await removeIfSame(lockPath, seen);
  } finally {
    const current = await readOwner(breakPath);
    if (current?.token === token) await unlink(breakPath).catch(() => {});
  }
}

/** Takes the lock for `path`; returns the release function. */
export async function acquireLock(
  path: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? staleMs + 5000;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await createExclusive(lockPath, JSON.stringify(ownerRecord(token)))) {
      return async () => {
        const current = await readOwner(lockPath);
        if (current?.token === token) await unlink(lockPath).catch(() => {});
      };
    }
    const stale = await staleLock(lockPath, staleMs);
    if (stale) {
      await breakStale(lockPath, stale, staleMs);
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeoutError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Runs `fn` holding the lock for `path`. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const release = await acquireLock(path, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

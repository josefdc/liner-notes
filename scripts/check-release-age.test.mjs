// Fixture tests for the release-age check, with a stub registry (no network). Run with `npm test`.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedEntries,
  DEFAULT_MIN_DAYS,
  packumentUrl,
  readMinReleaseAge,
  run,
} from "./check-release-age.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures", "release-age");
const fixtureText = (name) => readFileSync(join(FIXTURES, name), "utf8");
const fixtureLock = (name) => JSON.parse(fixtureText(name));
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

// Publish times of the versions in head-lock.json, as of NOW.
const TIMES = {
  fresh: { "1.0.0": "2026-01-01T00:00:00.000Z", "1.1.0": ago(3) },
  "@scope/edge": { "2.0.0": "2026-01-01T00:00:00.000Z", "2.1.0": ago(14) },
  old: { "1.0.0": "2025-01-01T00:00:00.000Z", "1.1.0": "2026-09-01T00:00:00.000Z" },
  child: { "1.0.0": "2026-01-01T00:00:00.000Z", "1.1.0": ago(20) },
};

/** A stub `fetch` serving full packuments with `times`; `calls` lists the requested URLs. */
function stubRegistry(times = TIMES) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    if (!(name in times)) return new Response('{"error":"Not found"}', { status: 404 });
    return Response.json({ name, "dist-tags": {}, versions: {}, time: times[name] });
  };
  return { fetch, calls };
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A git repository whose HEAD commit holds base-lock.json as package-lock.json, with `npmrc`
 * (a fixture name, or null for none) as .npmrc. `head` (a lock object) replaces the lock in
 * the working tree.
 */
function repo({ head, npmrc = "npmrc-unset" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-age-"));
  dirs.push(dir);
  copyFileSync(join(FIXTURES, "base-lock.json"), join(dir, "package-lock.json"));
  if (npmrc) copyFileSync(join(FIXTURES, npmrc), join(dir, ".npmrc"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "base",
  );
  if (head) writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify(head, null, 2)}\n`);
  return dir;
}

/** base-lock.json with `changes` applied: a path to an entry replaces it, to null removes it. */
function lockWith(changes) {
  const lock = fixtureLock("base-lock.json");
  for (const [path, entry] of Object.entries(changes)) {
    if (entry === null) delete lock.packages[path];
    else lock.packages[path] = entry;
  }
  return lock;
}

const release = (name, version) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: "sha512-CCCC",
});

/** Runs the check in `cwd` against HEAD; returns the exit code, output and registry calls. */
async function check(cwd, { registry = stubRegistry(), argv = ["--base", "HEAD"], env = {} } = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, {
    cwd,
    fetch: registry.fetch,
    now: NOW,
    env,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    retryDelayMs: 0,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: registry.calls };
}

describe("readMinReleaseAge", () => {
  it("reads the threshold from an .npmrc", () => {
    expect(readMinReleaseAge(fixtureText("npmrc-30"))).toBe(30);
    expect(readMinReleaseAge(readFileSync(join(import.meta.dirname, "..", ".npmrc"), "utf8"))).toBe(
      14,
    );
  });

  it("defaults to 14 days without the setting, and the last setting wins", () => {
    expect(DEFAULT_MIN_DAYS).toBe(14);
    expect(readMinReleaseAge(fixtureText("npmrc-unset"))).toBe(14);
    expect(readMinReleaseAge("# min-release-age=1\n; min-release-age=2\n")).toBe(14);
    expect(readMinReleaseAge("min-release-age=7\nmin-release-age = 21\n")).toBe(21);
  });

  it.each(["min-release-age=", "min-release-age=two", "min-release-age=-1"])(
    "refuses %j",
    (text) => {
      expect(() => readMinReleaseAge(text)).toThrow(/min-release-age must be a number of days/);
    },
  );
});

describe("changedEntries", () => {
  it("lists new and changed registry entries, with nested ones under their own name", () => {
    const { check, skipped } = changedEntries(
      fixtureLock("base-lock.json").packages,
      fixtureLock("head-lock.json").packages,
    );
    expect(check).toEqual([
      { path: "node_modules/@scope/edge", name: "@scope/edge", version: "2.1.0" },
      { path: "node_modules/fresh", name: "fresh", version: "1.1.0" },
      { path: "node_modules/old", name: "old", version: "1.1.0" },
      { path: "node_modules/parent/node_modules/old", name: "old", version: "1.0.0" },
      { path: "node_modules/parent/node_modules/child", name: "child", version: "1.1.0" },
    ]);
    // The removed entry ("gone"), the workspace packages and links are in neither list.
    expect(skipped).toEqual([
      {
        path: "node_modules/from-git",
        reason: expect.stringMatching(/^resolved from git\+ssh:.* not a registry tarball$/),
      },
    ]);
  });

  it("counts a changed resolved URL, and uses an alias's real name", () => {
    const base = { "node_modules/a": release("a", "1.0.0") };
    const moved = { ...release("a", "1.0.0"), resolved: "https://mirror.example/a/-/a-1.0.0.tgz" };
    expect(changedEntries(base, { "node_modules/a": moved }).check).toEqual([
      { path: "node_modules/a", name: "a", version: "1.0.0" },
    ]);
    const alias = { ...release("real", "2.0.0"), name: "real" };
    expect(changedEntries({}, { "node_modules/alias": alias }).check).toEqual([
      { path: "node_modules/alias", name: "real", version: "2.0.0" },
    ]);
  });

  it("lists an entry with no resolved URL as skipped", () => {
    const bundled = { version: "1.0.0", inBundle: true };
    expect(changedEntries({}, { "node_modules/b": bundled })).toEqual({
      check: [],
      skipped: [{ path: "node_modules/b", reason: 'no "resolved" URL' }],
    });
  });

  it("builds packument URLs with the scope's slash encoded", () => {
    expect(packumentUrl("https://registry.npmjs.org/", "@scope/edge")).toBe(
      "https://registry.npmjs.org/@scope%2fedge",
    );
    expect(packumentUrl("https://npm.example/repo", "left-pad")).toBe(
      "https://npm.example/repo/left-pad",
    );
  });
});

describe("run", () => {
  it("fails a changed entry under 14 days old, naming the package, version, publish time and age", async () => {
    const { code, err, calls } = await check(
      repo({ head: lockWith({ "node_modules/fresh": release("fresh", "1.1.0") }) }),
    );
    expect(code).toBe(1);
    expect(err).toContain(
      "fresh@1.1.0 was published 2026-10-27T12:00:00.000Z, 3.0 days before 2026-10-30T12:00:00.000Z",
    );
    expect(err).toContain("it can be taken from 2026-11-10T12:00:00.000Z");
    expect(calls).toEqual(["https://registry.npmjs.org/fresh"]);
  });

  it("passes an entry exactly 14 days old, and fails one a millisecond younger", async () => {
    const head = lockWith({ "node_modules/@scope/edge": release("@scope/edge", "2.1.0") });
    const atLimit = await check(repo({ head }));
    expect(atLimit.code).toBe(0);
    expect(atLimit.out).toContain(
      "ok   @scope/edge@2.1.0  published 2026-10-16T12:00:00.000Z  14.0 days old",
    );

    const younger = stubRegistry({
      "@scope/edge": { "2.1.0": new Date(NOW - 14 * DAY_MS + 1).toISOString() },
    });
    const late = await check(repo({ head }), { registry: younger });
    expect(late.code).toBe(1);
    expect(late.err).toContain(
      "@scope/edge@2.1.0 was published 2026-10-16T12:00:00.001Z, 13.9 days before",
    );
  });

  it("passes an old entry", async () => {
    const { code, out, calls } = await check(
      repo({ head: lockWith({ "node_modules/old": release("old", "1.1.0") }) }),
    );
    expect(code).toBe(0);
    expect(out).toContain("ok   old@1.1.0  published 2026-09-01T00:00:00.000Z  59.5 days old");
    expect(out).toContain("every changed release is at least 14 days old");
    expect(calls).toHaveLength(1);
  });

  it("ignores a removed entry", async () => {
    const { code, out, calls } = await check(
      repo({ head: lockWith({ "node_modules/gone": null }) }),
    );
    expect(code).toBe(0);
    expect(out).toContain("no registry request made");
    expect(calls).toEqual([]);
  });

  it("checks a nested node_modules/a/node_modules/b entry as package b", async () => {
    const path = "node_modules/parent/node_modules/child";
    const old = await check(repo({ head: lockWith({ [path]: release("child", "1.1.0") }) }));
    expect(old.code).toBe(0);
    expect(old.calls).toEqual(["https://registry.npmjs.org/child"]);

    const fresh = stubRegistry({ child: { "1.1.0": ago(2) } });
    const young = await check(repo({ head: lockWith({ [path]: release("child", "1.1.0") }) }), {
      registry: fresh,
    });
    expect(young.code).toBe(1);
    expect(young.err).toContain(`child@1.1.0 was published ${ago(2)}`);
    expect(young.err).toContain(`(${path})`);
  });

  it("skips workspace links and workspace packages without a registry request", async () => {
    const head = lockWith({
      "apps/api": { name: "@fixture/api", version: "0.2.0" },
      "apps/web": { name: "@fixture/web", version: "0.1.0" },
      "node_modules/@fixture/web": { resolved: "apps/web", link: true },
    });
    const { code, out, calls } = await check(repo({ head }));
    expect(code).toBe(0);
    expect(out).not.toContain("skipped");
    expect(calls).toEqual([]);
  });

  it("makes no registry request when the lock is unchanged", async () => {
    const { code, out, calls } = await check(repo());
    expect(code).toBe(0);
    expect(out).toBe(
      "[release-age] no new or changed registry entries in the lock against HEAD; no registry request made",
    );
    expect(calls).toEqual([]);
  });

  it("checks every changed entry of the fixture lock, reading each packument once", async () => {
    const { code, out, err, calls } = await check(repo({ head: fixtureLock("head-lock.json") }));
    expect(code).toBe(1);
    expect(out).toContain("[release-age] skipped node_modules/from-git: resolved from git+ssh:");
    expect(out).toContain("5 changed lock entries against HEAD; minimum age 14 days");
    // Two versions of "old" (node_modules/old and parent/node_modules/old), one request.
    expect(out).toContain("ok   old@1.0.0  published 2025-01-01T00:00:00.000Z");
    expect(out).toContain("ok   old@1.1.0  published 2026-09-01T00:00:00.000Z");
    expect(out).toContain("[release-age] 4 registry requests");
    expect(err.split("\n")[0]).toBe("[release-age] 1 release under 14 days old:");
    expect(err).toContain("fresh@1.1.0 was published");
    expect(err).not.toMatch(/old@|child@|edge@/);
    expect([...calls].sort()).toEqual([
      "https://registry.npmjs.org/@scope%2fedge",
      "https://registry.npmjs.org/child",
      "https://registry.npmjs.org/fresh",
      "https://registry.npmjs.org/old",
    ]);
  });

  it("fails a version that the registry has no publish time for", async () => {
    const registry = stubRegistry({ old: { "1.0.0": "2025-01-01T00:00:00.000Z" } });
    const { code, err } = await check(
      repo({ head: lockWith({ "node_modules/old": release("old", "1.1.0") }) }),
      { registry },
    );
    expect(code).toBe(1);
    expect(err).toContain("old@1.1.0: the registry has no publish time for this version");
  });

  it.each([
    [
      "a refused connection",
      async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
        });
      },
      "ECONNREFUSED",
      2,
    ],
    ["a server error", async () => new Response("busy", { status: 503 }), "HTTP 503", 2],
    ["an unknown package", async () => new Response("{}", { status: 404 }), "HTTP 404", 1],
    [
      "a reply that is not JSON",
      async () => new Response("<html>", { status: 200 }),
      "not JSON",
      1,
    ],
    ["a packument without times", async () => Response.json({ name: "old" }), 'no "time" field', 1],
  ])("exits 2 on %s from the registry", async (_label, reply, message, attempts) => {
    const calls = [];
    const registry = {
      calls,
      fetch: (url) => {
        calls.push(url);
        return reply();
      },
    };
    const { code, err } = await check(
      repo({ head: lockWith({ "node_modules/old": release("old", "1.1.0") }) }),
      { registry },
    );
    expect(code).toBe(2);
    expect(err).toContain(
      "[release-age] cannot check release ages: cannot read old from https://registry.npmjs.org/old",
    );
    expect(err).toContain(message);
    expect(calls).toHaveLength(attempts);
  });

  it("takes the threshold from .npmrc", async () => {
    const head = lockWith({
      "node_modules/parent/node_modules/child": release("child", "1.1.0"),
    });
    const strict = await check(repo({ head, npmrc: "npmrc-30" }));
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("minimum age 30 days (.npmrc min-release-age)");
    expect(strict.err).toContain("[release-age] 1 release under 30 days old:");
    expect(strict.err).toContain(`child@1.1.0 was published ${ago(20)}, 20.0 days before`);

    expect((await check(repo({ head, npmrc: "npmrc-unset" }))).code).toBe(0);
    expect((await check(repo({ head, npmrc: null }))).code).toBe(0);
  });

  it("reads from --registry, else from npm's registry setting", async () => {
    const head = lockWith({ "node_modules/old": release("old", "1.1.0") });
    const dir = repo({ head });
    const option = await check(dir, {
      argv: ["--base", "HEAD", "--registry", "https://npm.example/repo"],
      env: { npm_config_registry: "https://other.example/" },
    });
    expect(option.calls).toEqual(["https://npm.example/repo/old"]);
    const setting = await check(dir, { env: { npm_config_registry: "https://other.example/" } });
    expect(setting.calls).toEqual(["https://other.example/old"]);
  });

  it("checks a lock given with --lock against the base's package-lock.json", async () => {
    const dir = repo();
    const scratch = join(dir, "scratch-lock.json");
    writeFileSync(
      scratch,
      JSON.stringify(lockWith({ "node_modules/fresh": release("fresh", "1.1.0") })),
    );
    const { code, err } = await check(dir, { argv: ["--base", "HEAD", "--lock", scratch] });
    expect(code).toBe(1);
    expect(err).toContain("fresh@1.1.0 was published");
  });

  it.each([
    [[], "usage: check-release-age.mjs --base <git-ref>"],
    [["--base", "no-such-ref"], 'unknown base "no-such-ref"'],
    [["--base", "HEAD", "--registry", "registry.npmjs.org"], "--registry must be an http(s) URL"],
    [["--base", "HEAD", "--frobnicate"], "Unknown option '--frobnicate'"],
  ])("exits 2 for the arguments %j", async (argv, message) => {
    const { code, err, calls } = await check(repo(), { argv });
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(calls).toEqual([]);
  });
});

// Fixture tests for the release-age check, with a stub registry (no network). Run with `npm test`.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_DAYS,
  lockChanges,
  packumentUrl,
  parseTarball,
  readMinReleaseAge,
  redact,
  run,
} from "./check-release-age.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures", "release-age");
const SCRIPT = join(import.meta.dirname, "check-release-age.mjs");
const fixtureText = (name) => readFileSync(join(FIXTURES, name), "utf8");
const fixtureLock = (name) => JSON.parse(fixtureText(name));
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();
// Git in the throwaway repositories ignores the caller's GIT_* variables and git config.
const isolatedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
Object.assign(isolatedEnv, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
for (const key of [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NODE_USE_ENV_PROXY",
]) {
  delete isolatedEnv[key];
}

// Publish times of the versions in the fixture locks, as of NOW.
const TIMES = {
  fresh: { created: ago(900), "1.0.0": "2026-01-01T00:00:00.000Z", "1.1.0": ago(3) },
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

/** A stub `fetch` that answers each request with the next of `replies` (functions of the signal). */
function scriptedRegistry(...replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    return reply(init.signal);
  };
  return { fetch, calls };
}

const refused = () => {
  throw new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
};
/** A request that never answers until its signal aborts. */
const hangs = (signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const packument = (time) => () => Response.json({ name: "old", time });

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE_FILES = {
  "package-lock.json": fixtureText("base-lock.json"),
  ".npmrc": fixtureText("npmrc-unset"),
};

/**
 * A git repository whose HEAD commit holds `base` (file name -> text; base-lock.json as
 * package-lock.json and an .npmrc without the setting by default); `head` then writes (text) or
 * removes (null) files in the working tree.
 */
function repo({ base = BASE_FILES, head = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-age-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(base)) writeFileSync(join(dir, name), text);
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: isolatedEnv });
  git("init", "-q");
  git("add", "--all");
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
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  for (const [name, text] of Object.entries(head)) {
    if (text === null) rmSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** base-lock.json with `changes` applied: a path to an entry replaces it, to null removes it. */
function lockWith(changes, lock = fixtureLock("base-lock.json")) {
  for (const [path, entry] of Object.entries(changes)) {
    if (entry === null) delete lock.packages[path];
    else lock.packages[path] = entry;
  }
  return lock;
}
const text = (lock) => `${JSON.stringify(lock, null, 2)}\n`;
/** A repository whose working-tree package-lock.json is base-lock.json with `changes`. */
const changed = (changes) => repo({ head: { "package-lock.json": text(lockWith(changes)) } });

const tarball = (name, version) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
const release = (name, version) => ({
  version,
  resolved: tarball(name, version),
  integrity: "sha512-CCCC",
});

/** Runs the check in `cwd` against HEAD; returns the exit code, output, registry calls and waits. */
async function check(cwd, options = {}) {
  const { registry = stubRegistry(), argv = ["--base", "HEAD"], env = {}, ...rest } = options;
  const out = [];
  const err = [];
  const waits = [];
  const code = await run(argv, {
    cwd,
    fetch: registry.fetch,
    now: NOW,
    env: { ...isolatedEnv, ...env },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    sleep: async (ms, signal) => {
      waits.push(ms);
      if (signal.aborted) throw signal.reason;
    },
    ...rest,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: registry.calls, waits };
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

  it("reads values as npm's ini parser does: inline comments, quotes and sections", () => {
    expect(readMinReleaseAge("min-release-age=30 # thirty days\n")).toBe(30);
    expect(readMinReleaseAge("min-release-age = 21 ; three weeks\n")).toBe(21);
    expect(readMinReleaseAge("min-release-age=7#x\n")).toBe(7);
    expect(readMinReleaseAge('min-release-age="28"\n')).toBe(28);
    expect(readMinReleaseAge("min-release-age='35'\n")).toBe(35);
    expect(readMinReleaseAge("min-release-age=20\r\n[section]\nmin-release-age=0\n")).toBe(20);
  });

  it.each([
    "min-release-age=",
    "min-release-age=two",
    "min-release-age=-1",
    "min-release-age",
    "min-release-age=# only a comment",
  ])("refuses %j", (npmrc) => {
    expect(() => readMinReleaseAge(npmrc)).toThrow(/min-release-age must be a number of days/);
  });
});

describe("parseTarball", () => {
  it("reads the name and version of npmjs tarballs, scoped or not", () => {
    expect(parseTarball(tarball("p-queue", "9.3.5"))).toEqual({
      name: "p-queue",
      version: "9.3.5",
    });
    expect(parseTarball(tarball("@scope/edge", "2.1.0-rc.1"))).toEqual({
      name: "@scope/edge",
      version: "2.1.0-rc.1",
    });
  });

  it.each([
    ["http://registry.npmjs.org/a/-/a-1.0.0.tgz", "not a tarball from https://registry.npmjs.org/"],
    ["https://mirror.example/a/-/a-1.0.0.tgz", "not a tarball from https://registry.npmjs.org/"],
    ["https://registry.npmjs.org:8443/a/-/a-1.0.0.tgz", "not a tarball from"],
    ["https://user:token@registry.npmjs.org/a/-/a-1.0.0.tgz", "not a tarball from"],
    ["https://codeload.github.com/evil/a/tar.gz/abc123", "not a tarball from"],
    ["git+ssh://git@github.com/evil/a.git#abc", "not a tarball from"],
    ["file:vendor/a-1.0.0.tgz", "not a tarball from"],
    ["vendor/a", "not a URL"],
    ["https://registry.npmjs.org/a/-/a-1.0.0.tgz?x=1", "not a registry tarball path"],
    ["https://registry.npmjs.org/a/a-1.0.0.tgz", "not a registry tarball path"],
    ["https://registry.npmjs.org/a/-/b-1.0.0.tgz", 'does not start with "a-"'],
    ["https://registry.npmjs.org/a/-/a-created.tgz", 'version "created" is not semver'],
    ["https://registry.npmjs.org/a/-/a-1.0.tgz", 'version "1.0" is not semver'],
  ])("refuses %s", (url, message) => {
    expect(parseTarball(url).error).toContain(message);
  });
});

describe("lockChanges", () => {
  it("sorts the fixture lock's changes into checks, entries needing no check, and failures", () => {
    const { check, allowed, problems } = lockChanges(
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
    // The removed entry ("gone") is in no list; the git dependency fails closed.
    expect(allowed).toEqual([
      { path: "apps/api", reason: "workspace package" },
      { path: "apps/web", reason: "workspace package" },
      { path: "node_modules/@fixture/web", reason: "link to the workspace apps/web" },
      { path: "node_modules/old/node_modules/bundled", reason: "bundled in node_modules/old" },
    ]);
    expect(problems).toEqual([
      {
        path: "node_modules/from-git",
        reason:
          "resolved from git+ssh://git@github.com/example/from-git.git#0123456789abcdef0123456789abcdef01234567: " +
          "not a tarball from https://registry.npmjs.org/",
      },
    ]);
  });

  it("counts a change to the version, resolved, integrity, name, link or inBundle field", () => {
    const base = { "node_modules/a": { ...release("a", "1.0.0"), integrity: "sha512-AAAA" } };
    for (const change of [
      { version: "1.0.1" },
      { resolved: tarball("a", "1.0.1") },
      { integrity: "sha512-EVIL" },
      { name: "a" },
      { link: true },
      { inBundle: true },
    ]) {
      const { check, allowed, problems } = lockChanges(base, {
        "node_modules/a": { ...base["node_modules/a"], ...change },
      });
      expect(check.length + allowed.length + problems.length, JSON.stringify(change)).toBe(1);
    }
    expect(lockChanges(base, base)).toEqual({ check: [], allowed: [], problems: [] });
  });

  it("takes the name and version from the tarball, failing on any disagreement with the entry", () => {
    const one = (entry, path = "node_modules/fresh") => lockChanges({}, { [path]: entry });
    // The version field says an old release, the tarball is a new one.
    expect(one({ version: "1.0.0", resolved: tarball("fresh", "1.1.0") }).problems).toEqual([
      {
        path: "node_modules/fresh",
        reason: 'its version is "1.0.0", but resolved is the tarball of fresh@1.1.0',
      },
    ]);
    // "created" is a key of the packument's time map, not a version.
    expect(
      one({ version: "created", resolved: tarball("fresh", "1.1.0") }).problems[0].reason,
    ).toBe('its version is "created", but resolved is the tarball of fresh@1.1.0');
    // A name field (npm alias) that is not the tarball's package.
    expect(
      one({ name: "lodash", version: "1.1.0", resolved: tarball("fresh", "1.1.0") }).problems,
    ).toEqual([
      {
        path: "node_modules/fresh",
        reason: 'its name is "lodash", but resolved is the tarball of fresh@1.1.0',
      },
    ]);
    // Without a name field, the path names the package.
    expect(one(release("other", "1.0.0")).problems[0].reason).toBe(
      'its path names "fresh", but resolved is the tarball of other@1.0.0',
    );
    // An npm alias whose name field is the tarball's package is checked as that package.
    expect(one({ ...release("real", "2.0.0"), name: "real" }, "node_modules/alias").check).toEqual([
      { path: "node_modules/alias", name: "real", version: "2.0.0" },
    ]);
  });

  it("checks an entry with no resolved URL by its version, and fails it without a semver one", () => {
    const one = (entry) => lockChanges({}, { "node_modules/fresh": entry });
    expect(one({ version: "1.1.0" }).check).toEqual([
      { path: "node_modules/fresh", name: "fresh", version: "1.1.0" },
    ]);
    expect(one({ version: "created" }).problems[0].reason).toBe(
      'no resolved URL, and its version "created" is not semver',
    );
    expect(one({ integrity: "sha512-AAAA" }).problems[0].reason).toBe(
      "no resolved URL and no version",
    );
  });

  it("allows only links to the root workspaces, and only workspace packages outside node_modules", () => {
    const head = {
      "": { name: "x", workspaces: ["packages/*", "./tools/cli/"] },
      "packages/a": { name: "a", version: "1.0.0" },
      "tools/cli": { name: "cli", version: "1.0.0" },
      "vendor/b": { name: "b", version: "1.0.0" },
      "node_modules/a": { resolved: "packages/a", link: true },
      "node_modules/cli": { resolved: "tools/cli", link: true },
      "node_modules/b": { resolved: "vendor/b", link: true },
      "node_modules/c": { ...release("c", "1.0.0"), link: true },
      "node_modules/d": { resolved: "packages/a/node_modules/d", link: true },
    };
    const { check, allowed, problems } = lockChanges({}, head);
    expect(check).toEqual([]);
    expect(allowed.map(({ path }) => path)).toEqual([
      "packages/a",
      "tools/cli",
      "node_modules/a",
      "node_modules/cli",
    ]);
    expect(problems).toEqual([
      {
        path: "vendor/b",
        reason: "a package outside node_modules that is not one of the root workspaces",
      },
      {
        path: "node_modules/b",
        reason: 'a link to "vendor/b", which is not one of the root workspaces',
      },
      {
        path: "node_modules/c",
        reason:
          'a link to "https://registry.npmjs.org/c/-/c-1.0.0.tgz", which is not one of the root workspaces',
      },
      {
        path: "node_modules/d",
        reason: 'a link to "packages/a/node_modules/d", which is not one of the root workspaces',
      },
    ]);
  });

  it("allows an inBundle entry only inside a package checked in the same change", () => {
    const base = { "node_modules/p": release("p", "1.0.0") };
    const bundled = { version: "1.0.0", inBundle: true };
    const nested = {
      "node_modules/p/node_modules/b": bundled,
      "node_modules/p/node_modules/b/node_modules/c": bundled,
    };
    // p changed: its bundled entries (and theirs) come from its checked tarball.
    const updated = lockChanges(base, { "node_modules/p": release("p", "1.1.0"), ...nested });
    expect(updated.problems).toEqual([]);
    expect(updated.allowed).toEqual([
      { path: "node_modules/p/node_modules/b", reason: "bundled in node_modules/p" },
      { path: "node_modules/p/node_modules/b/node_modules/c", reason: "bundled in node_modules/p" },
    ]);
    // p unchanged: a new bundled entry cannot come from it.
    expect(lockChanges(base, { ...base, ...nested }).problems).toEqual([
      {
        path: "node_modules/p/node_modules/b",
        reason: "bundled in node_modules/p, which is not a changed registry release",
      },
      {
        path: "node_modules/p/node_modules/b/node_modules/c",
        reason: "bundled in node_modules/p, which is not a changed registry release",
      },
    ]);
    expect(lockChanges({}, { "node_modules/b": bundled }).problems).toEqual([
      { path: "node_modules/b", reason: "marked inBundle, but no package above it bundles it" },
    ]);
  });
});

describe("helpers", () => {
  it("builds packument URLs with the scope's slash encoded", () => {
    expect(packumentUrl("https://registry.npmjs.org/", "@scope/edge")).toBe(
      "https://registry.npmjs.org/@scope%2fedge",
    );
    expect(packumentUrl("https://npm.example/repo", "left-pad")).toBe(
      "https://npm.example/repo/left-pad",
    );
  });

  it("masks credentials in URLs", () => {
    expect(redact("https://user:secret@npm.example/x")).toBe("https://***:***@npm.example/x");
    expect(redact("https://ghp_token@github.com/o/r.git")).toBe("https://***@github.com/o/r.git");
    expect(redact("git+ssh://git@github.com/o/r.git")).toBe("git+ssh://git@github.com/o/r.git");
    expect(redact("vendor/b")).toBe("vendor/b");
  });
});

describe("run", () => {
  it("fails a changed entry under 14 days old, naming the package, version, publish time and age", async () => {
    const { code, err, calls } = await check(
      changed({ "node_modules/fresh": release("fresh", "1.1.0") }),
    );
    expect(code).toBe(1);
    expect(err).toContain(
      "fresh@1.1.0 was published 2026-10-27T12:00:00.000Z, 3.0 days before 2026-10-30T12:00:00.000Z",
    );
    expect(err).toContain("it can be taken from 2026-11-10T12:00:00.000Z");
    expect(calls).toEqual(["https://registry.npmjs.org/fresh"]);
  });

  it("passes an entry exactly 14 days old, and fails one a millisecond younger", async () => {
    const changes = { "node_modules/@scope/edge": release("@scope/edge", "2.1.0") };
    const atLimit = await check(changed(changes));
    expect(atLimit.code).toBe(0);
    expect(atLimit.out).toContain(
      "ok   @scope/edge@2.1.0  published 2026-10-16T12:00:00.000Z  14.0 days old",
    );

    const younger = stubRegistry({
      "@scope/edge": { "2.1.0": new Date(NOW - 14 * DAY_MS + 1).toISOString() },
    });
    const late = await check(changed(changes), { registry: younger });
    expect(late.code).toBe(1);
    expect(late.err).toContain(
      "@scope/edge@2.1.0 was published 2026-10-16T12:00:00.001Z, 13.9 days before",
    );
  });

  it("passes an old entry", async () => {
    const { code, out, calls } = await check(
      changed({ "node_modules/old": release("old", "1.1.0") }),
    );
    expect(code).toBe(0);
    expect(out).toContain("ok   old@1.1.0  published 2026-09-01T00:00:00.000Z  59.5 days old");
    expect(out).toContain("every changed registry release is at least 14 days old");
    expect(calls).toHaveLength(1);
  });

  it("ignores a removed entry", async () => {
    const { code, out, calls } = await check(changed({ "node_modules/gone": null }));
    expect(code).toBe(0);
    expect(out).toContain("no new or changed entries; no registry request made");
    expect(calls).toEqual([]);
  });

  it("checks a nested node_modules/a/node_modules/b entry as package b", async () => {
    const path = "node_modules/parent/node_modules/child";
    const old = await check(changed({ [path]: release("child", "1.1.0") }));
    expect(old.code).toBe(0);
    expect(old.calls).toEqual(["https://registry.npmjs.org/child"]);

    const young = await check(changed({ [path]: release("child", "1.1.0") }), {
      registry: stubRegistry({ child: { "1.1.0": ago(2) } }),
    });
    expect(young.code).toBe(1);
    expect(young.err).toContain(`child@1.1.0 was published ${ago(2)}`);
    expect(young.err).toContain(`(${path})`);
  });

  it("lets workspace links and packages through without a registry request, and says so", async () => {
    const head = lockWith({
      "": { name: "fixture", version: "0.0.0", workspaces: ["apps/api", "apps/web"] },
      "apps/api": { name: "@fixture/api", version: "0.2.0" },
      "apps/web": { name: "@fixture/web", version: "0.1.0" },
      "node_modules/@fixture/web": { resolved: "apps/web", link: true },
    });
    const { code, out, calls } = await check(repo({ head: { "package-lock.json": text(head) } }));
    expect(code).toBe(0);
    expect(out).not.toContain("no new or changed");
    expect(out).toContain(
      "0 registry releases to check, 3 workspace or bundled entries with no check needed, 0 entries that cannot be checked",
    );
    expect(out).toContain(
      "  no check needed  node_modules/@fixture/web: link to the workspace apps/web",
    );
    expect(out).toContain("[release-age] no registry request made");
    expect(calls).toEqual([]);
  });

  it("makes no registry request when the lock is unchanged", async () => {
    const { code, out, calls } = await check(repo());
    expect(code).toBe(0);
    expect(out).toBe(
      "[release-age] package-lock.json against package-lock.json at HEAD: no new or changed entries; no registry request made",
    );
    expect(calls).toEqual([]);
  });

  it("checks every changed entry of the fixture lock, reading each packument once", async () => {
    const { code, out, err, calls } = await check(
      repo({ head: { "package-lock.json": fixtureText("head-lock.json") } }),
    );
    expect(code).toBe(1);
    expect(out).toContain(
      "5 registry releases to check, 4 workspace or bundled entries with no check needed, 1 entry that cannot be checked; minimum age 14 days",
    );
    // Two versions of "old" (node_modules/old and parent/node_modules/old), one request.
    expect(out).toContain("ok   old@1.0.0  published 2025-01-01T00:00:00.000Z");
    expect(out).toContain("ok   old@1.1.0  published 2026-09-01T00:00:00.000Z");
    expect(out).toContain("[release-age] 4 registry requests");
    const lines = err.split("\n");
    expect(lines[0]).toBe("[release-age] 2 entries fail the check (minimum age 14 days):");
    expect(lines[1]).toMatch(
      /^ {2}node_modules\/from-git: resolved from git\+ssh:.* not a tarball from/,
    );
    expect(lines[2]).toMatch(/^ {2}fresh@1\.1\.0 was published /);
    expect(lines).toHaveLength(4);
    expect([...calls].sort()).toEqual([
      "https://registry.npmjs.org/@scope%2fedge",
      "https://registry.npmjs.org/child",
      "https://registry.npmjs.org/fresh",
      "https://registry.npmjs.org/old",
    ]);
  });

  it.each([
    [
      "a codeload tarball",
      { version: "1.1.0", resolved: "https://codeload.github.com/e/fresh/tar.gz/abc" },
    ],
    [
      "a git dependency",
      { version: "1.1.0", resolved: "git+ssh://git@github.com/e/fresh.git#abc" },
    ],
    [
      "an http tarball",
      { version: "1.0.0", resolved: "http://registry.npmjs.org/fresh/-/fresh-1.0.0.tgz" },
    ],
    [
      "another host",
      { version: "1.0.0", resolved: "https://evil.example/fresh/-/fresh-1.0.0.tgz" },
    ],
    [
      "a version that is not the tarball's",
      { version: "1.0.0", resolved: tarball("fresh", "1.1.0") },
    ],
    ["the version 'created'", { version: "created", resolved: tarball("fresh", "1.1.0") }],
    [
      "another package's name",
      { name: "lodash", version: "4.17.21", resolved: tarball("fresh", "1.1.0") },
    ],
    ["a link to a registry tarball", { ...release("fresh", "1.1.0"), link: true }],
  ])("fails closed on %s, with no registry request", async (_label, entry) => {
    const { code, out, err, calls } = await check(changed({ "node_modules/fresh": entry }));
    expect(code).toBe(1);
    expect(out).toContain("1 entry that cannot be checked");
    expect(err).toContain("  node_modules/fresh: ");
    expect(calls).toEqual([]);
  });

  it("checks an entry whose resolved URL was removed by its version", async () => {
    const { code, err, calls } = await check(
      changed({ "node_modules/fresh": { version: "1.1.0" } }),
    );
    expect(code).toBe(1);
    expect(err).toContain("fresh@1.1.0 was published 2026-10-27T12:00:00.000Z, 3.0 days before");
    expect(calls).toEqual(["https://registry.npmjs.org/fresh"]);
  });

  it("checks an entry whose only change is its integrity", async () => {
    const entry = {
      ...fixtureLock("base-lock.json").packages["node_modules/old"],
      integrity: "sha512-EVIL",
    };
    const { code, out, calls } = await check(changed({ "node_modules/old": entry }));
    expect(code).toBe(0);
    expect(out).toContain("ok   old@1.0.0");
    expect(calls).toEqual(["https://registry.npmjs.org/old"]);
  });

  it("fails a new bundled entry inside an unchanged package", async () => {
    const { code, err, calls } = await check(
      changed({ "node_modules/old/node_modules/fresh": { version: "1.1.0", inBundle: true } }),
    );
    expect(code).toBe(1);
    expect(err).toContain(
      "node_modules/old/node_modules/fresh: bundled in node_modules/old, which is not a changed registry release",
    );
    expect(calls).toEqual([]);
  });

  it("fails a version that the registry has no publish time for", async () => {
    const registry = stubRegistry({ old: { "1.0.0": "2025-01-01T00:00:00.000Z" } });
    const { code, err } = await check(changed({ "node_modules/old": release("old", "1.1.0") }), {
      registry,
    });
    expect(code).toBe(1);
    expect(err).toContain("old@1.1.0: the registry has no publish time for this version");
  });

  it("exits 1, not 2, when an entry fails closed and the registry is also down", async () => {
    const head = {
      "node_modules/old": release("old", "1.1.0"),
      "node_modules/fresh": { version: "1.1.0", resolved: "git+ssh://git@github.com/e/fresh.git" },
    };
    const { code, err } = await check(changed(head), { registry: scriptedRegistry(refused) });
    expect(code).toBe(1);
    expect(err).toContain(
      "[release-age] cannot read old from https://registry.npmjs.org/old: ECONNREFUSED",
    );
    expect(err).toContain("node_modules/fresh: resolved from git+ssh:");
  });

  it.each([
    ["a refused connection", refused, "ECONNREFUSED", 3],
    ["a server error", () => new Response("busy", { status: 503 }), "HTTP 503", 3],
    ["an unknown package", () => new Response("{}", { status: 404 }), "HTTP 404", 1],
    ["a reply that is not JSON", () => new Response("<html>", { status: 200 }), "not JSON", 1],
    ["a packument without times", () => Response.json({ name: "old" }), 'no "time" field', 1],
  ])("exits 2 on %s from the registry", async (_label, reply, message, attempts) => {
    const registry = scriptedRegistry(reply);
    const { code, err, waits } = await check(
      changed({ "node_modules/old": release("old", "1.1.0") }),
      {
        registry,
      },
    );
    expect(code).toBe(2);
    expect(err).toMatch(
      /^\[release-age\] cannot check release ages: cannot read old from https:\/\/registry\.npmjs\.org\/old: /,
    );
    expect(err).toContain(message);
    expect(registry.calls).toHaveLength(attempts);
    // Backoff between attempts: 1 s, then 2 s.
    expect(waits).toEqual([1000, 2000].slice(0, attempts - 1));
  });

  it("retries a failed connection or a body that breaks off, and passes when a retry succeeds", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
      );
    const ok = packument({ "1.1.0": "2026-09-01T00:00:00.000Z" });
    const head = { "node_modules/old": release("old", "1.1.0") };
    for (const first of [refused, broken]) {
      const registry = scriptedRegistry(first, ok);
      const { code, out } = await check(changed(head), { registry });
      expect(code).toBe(0);
      expect(out).toContain("ok   old@1.1.0");
      expect(registry.calls).toHaveLength(2);
    }
  });

  it("waits as long as a 429's Retry-After says, up to 30 s", async () => {
    const busy = (after) => () =>
      new Response("slow down", { status: 429, headers: { "retry-after": after } });
    const ok = packument({ "1.1.0": "2026-09-01T00:00:00.000Z" });
    const head = { "node_modules/old": release("old", "1.1.0") };
    const short = await check(changed(head), { registry: scriptedRegistry(busy("7"), ok) });
    expect(short.code).toBe(0);
    expect(short.waits).toEqual([7000]);
    const long = await check(changed(head), {
      registry: scriptedRegistry(busy("120"), busy("bogus"), ok),
    });
    expect(long.code).toBe(0);
    expect(long.waits).toEqual([30_000, 2000]);
  });

  it("gives up on a request with no answer after its timeout, three times", async () => {
    const registry = scriptedRegistry(hangs);
    const { code, err } = await check(changed({ "node_modules/old": release("old", "1.1.0") }), {
      registry,
      requestTimeoutMs: 20,
    });
    expect(code).toBe(2);
    expect(err).toContain(
      "cannot read old from https://registry.npmjs.org/old: no complete response within 0.02 s",
    );
    expect(registry.calls).toHaveLength(3);
  });

  it("exits 2 when the registry reads pass the overall deadline", async () => {
    const { code, err } = await check(changed({ "node_modules/old": release("old", "1.1.0") }), {
      registry: scriptedRegistry(hangs),
      deadlineMs: 50,
    });
    expect(code).toBe(2);
    expect(err).toBe(
      "[release-age] cannot check release ages: the registry reads did not finish within the 0.05 s deadline",
    );
  });

  it("hints at NODE_USE_ENV_PROXY=1 when a connection fails with a proxy set", async () => {
    const head = { "node_modules/old": release("old", "1.1.0") };
    const proxied = await check(changed(head), {
      registry: scriptedRegistry(refused),
      env: { HTTPS_PROXY: "http://proxy.example:3128" },
    });
    expect(proxied.code).toBe(2);
    expect(proxied.err).toContain(
      "ECONNREFUSED (HTTPS_PROXY is set, but Node's fetch uses a proxy only with NODE_USE_ENV_PROXY=1)",
    );
    const used = await check(changed(head), {
      registry: scriptedRegistry(refused),
      env: { HTTPS_PROXY: "http://proxy.example:3128", NODE_USE_ENV_PROXY: "1" },
    });
    expect(used.err).not.toContain("NODE_USE_ENV_PROXY");
  });

  it("takes the threshold from .npmrc", async () => {
    const lock = text(
      lockWith({ "node_modules/parent/node_modules/child": release("child", "1.1.0") }),
    );
    const strict = await check(
      repo({ head: { "package-lock.json": lock, ".npmrc": fixtureText("npmrc-30") } }),
    );
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("minimum age 30 days");
    expect(strict.err).toContain(`child@1.1.0 was published ${ago(20)}, 20.0 days before`);

    expect((await check(repo({ head: { "package-lock.json": lock } }))).code).toBe(0);
    expect((await check(repo({ head: { "package-lock.json": lock, ".npmrc": null } }))).code).toBe(
      0,
    );
  });

  it("does not let a change lower the threshold below the base's, or below 14 days", async () => {
    const child = text(
      lockWith({ "node_modules/parent/node_modules/child": release("child", "1.1.0") }),
    );
    const raisedAtBase = await check(
      repo({
        base: { ...BASE_FILES, ".npmrc": fixtureText("npmrc-30") },
        head: { "package-lock.json": child, ".npmrc": "min-release-age=14\n" },
      }),
    );
    expect(raisedAtBase.code).toBe(1);
    expect(raisedAtBase.out).toContain("minimum age 30 days");

    const fresh = text(lockWith({ "node_modules/fresh": release("fresh", "1.1.0") }));
    const zero = await check(
      repo({ head: { "package-lock.json": fresh, ".npmrc": "min-release-age=0\n" } }),
    );
    expect(zero.code).toBe(1);
    expect(zero.err).toContain("fresh@1.1.0 was published");
  });

  it("keeps 14 days as the floor when both .npmrc files set less", async () => {
    const lock = text(lockWith({ "node_modules/fresh": release("fresh", "1.1.0") }));
    const { code, out, err } = await check(
      repo({
        base: { ...BASE_FILES, ".npmrc": "min-release-age=7\n" },
        head: { "package-lock.json": lock, ".npmrc": "min-release-age=7\n" },
      }),
      { registry: stubRegistry({ fresh: { "1.1.0": ago(10) } }) },
    );
    expect(code).toBe(1);
    expect(out).toContain("minimum age 14 days");
    expect(err).toContain(`fresh@1.1.0 was published ${ago(10)}, 10.0 days before`);
  });

  it("runs git with the environment it is given", async () => {
    const { code, err } = await check(repo(), { env: { GIT_DIR: "/nonexistent/.git" } });
    expect(code).toBe(2);
    expect(err).toContain('unknown base "HEAD"');
  });

  it("reads an .npmrc with an inline comment", async () => {
    const { code } = await check(repo({ head: { ".npmrc": "min-release-age=14 # two weeks\n" } }));
    expect(code).toBe(0);
  });

  it("reads from registry.npmjs.org unless --registry is given, whatever npm's settings say", async () => {
    const head = {
      "package-lock.json": text(lockWith({ "node_modules/old": release("old", "1.1.0") })),
      ".npmrc": "registry=https://mirror.evil/\n",
    };
    const dir = repo({ head });
    const settings = await check(dir, { env: { npm_config_registry: "https://mirror.evil/" } });
    expect(settings.calls).toEqual(["https://registry.npmjs.org/old"]);
    const option = await check(dir, {
      argv: ["--base", "HEAD", "--registry", "https://npm.example/repo"],
    });
    expect(option.calls).toEqual(["https://npm.example/repo/old"]);
  });

  it("refuses a --registry with credentials without printing them", async () => {
    const { code, err, calls } = await check(repo(), {
      argv: ["--base", "HEAD", "--registry", "https://user:s3cret@npm.example/"],
    });
    expect(code).toBe(2);
    expect(err).toContain('--registry must not hold credentials: "https://***:***@npm.example/"');
    expect(err).not.toContain("s3cret");
    expect(calls).toEqual([]);
  });

  it("checks an added npm-shrinkwrap.json against the base's package-lock.json", async () => {
    const shrinkwrap = text(lockWith({ "node_modules/fresh": release("fresh", "1.1.0") }));
    const { code, out, err } = await check(repo({ head: { "npm-shrinkwrap.json": shrinkwrap } }));
    expect(code).toBe(1);
    expect(out).toContain("npm-shrinkwrap.json against package-lock.json at HEAD");
    expect(err).toContain("fresh@1.1.0 was published");
  });

  it("checks a changed npm-shrinkwrap.json against the base's shrinkwrap", async () => {
    // The base's shrinkwrap already has fresh@1.1.0; only the change to old is new.
    const baseShrinkwrap = lockWith({ "node_modules/fresh": release("fresh", "1.1.0") });
    const headShrinkwrap = lockWith(
      { "node_modules/old": release("old", "1.1.0") },
      structuredClone(baseShrinkwrap),
    );
    const { code, out, calls } = await check(
      repo({
        base: { ...BASE_FILES, "npm-shrinkwrap.json": text(baseShrinkwrap) },
        head: { "npm-shrinkwrap.json": text(headShrinkwrap) },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("npm-shrinkwrap.json against npm-shrinkwrap.json at HEAD");
    expect(calls).toEqual(["https://registry.npmjs.org/old"]);
  });

  it("counts every entry as new when the base has no lock", async () => {
    const { code, out, err } = await check(
      repo({
        base: { ".npmrc": fixtureText("npmrc-unset") },
        head: {
          "package-lock.json": text(lockWith({ "node_modules/fresh": release("fresh", "1.1.0") })),
        },
      }),
      {
        registry: stubRegistry({
          ...TIMES,
          gone: { "1.0.0": ago(400) },
          parent: { "1.0.0": ago(400) },
        }),
      },
    );
    expect(code).toBe(1);
    expect(out).toContain(
      "no package-lock.json at HEAD: every entry of package-lock.json counts as new",
    );
    expect(out).toContain("6 registry releases to check");
    expect(err).toContain("fresh@1.1.0 was published");
  });

  it.each([
    [
      "the working tree",
      { head: { "package-lock.json": "{" } },
      "package-lock.json is not valid JSON",
    ],
    [
      "the base",
      {
        base: { ...BASE_FILES, "package-lock.json": '{"lockfileVersion":1}' },
        head: { "package-lock.json": fixtureText("base-lock.json") },
      },
      'package-lock.json at HEAD has no "packages"',
    ],
  ])("exits 2 for an invalid lock in %s", async (_label, files, message) => {
    const { code, err, calls } = await check(repo(files));
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(calls).toEqual([]);
  });

  it("checks a lock given with --lock against the base's package-lock.json", async () => {
    const dir = repo();
    const scratch = join(dir, "scratch-lock.json");
    writeFileSync(scratch, text(lockWith({ "node_modules/fresh": release("fresh", "1.1.0") })));
    const { code, err } = await check(dir, { argv: ["--base", "HEAD", "--lock", scratch] });
    expect(code).toBe(1);
    expect(err).toContain("fresh@1.1.0 was published");
  });

  it.each([
    [[], "usage: check-release-age.mjs --base <git-ref>"],
    [
      ["--base", "no-such-ref"],
      'unknown base "no-such-ref": not a commit in this repository (a shallow clone',
    ],
    [["--base", "HEAD", "--registry", "registry.npmjs.org"], "--registry must be an http(s) URL"],
    [["--base", "HEAD", "--registry", "ftp://npm.example/"], "--registry must be an http(s) URL"],
    [["--base", "HEAD", "--frobnicate"], "Unknown option '--frobnicate'"],
  ])("exits 2 for the arguments %j", async (argv, message) => {
    const { code, err, calls } = await check(repo(), { argv });
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(calls).toEqual([]);
  });

  it("exits 2, not 1, on an unexpected error", async () => {
    const code = await run(["--base", "HEAD"], {
      cwd: repo(),
      env: isolatedEnv,
      log: () => {
        throw new Error("stdout closed");
      },
      error: (line) =>
        expect(line).toMatch(
          /^\[release-age\] cannot check release ages: unexpected error: Error: stdout closed/,
        ),
    });
    expect(code).toBe(2);
  });

  it("runs as a command, also through a symlink, and sets the exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-age-link-"));
    dirs.push(dir);
    const link = join(dir, "check.mjs");
    symlinkSync(SCRIPT, link);
    for (const path of [SCRIPT, link]) {
      const result = spawnSync(process.execPath, [path, "--base", "no-such-ref"], {
        encoding: "utf8",
        env: isolatedEnv,
        timeout: 20_000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown base "no-such-ref"');
    }
  });
});

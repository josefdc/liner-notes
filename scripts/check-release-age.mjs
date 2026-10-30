#!/usr/bin/env node
// Release-age check: every lock entry that is new or changed against a base commit must be an npm
// registry release published at least N days ago, where N is the largest of 14 and .npmrc's
// `min-release-age` at the base and in the working tree (so a change cannot lower it for itself).
// The window rolls with the publish time, as `exclude-newer = "14 days"` does in the audio service.
//
//   npm run check:release-age -- --base <git-ref>
//     --registry <url>   read publish times from this registry instead of registry.npmjs.org
//     --lock <path>      check this lock instead of npm-shrinkwrap.json / package-lock.json
//
// npm's own min-release-age applies only when npm resolves a version: `npm ci` installs whatever
// the lock names, so a lock edited by hand or resolved without the setting could bring in a
// release that is too new. The lock checked is npm-shrinkwrap.json when there is one (npm ci
// prefers it), else package-lock.json; it is compared with the same file at <git-ref>, or with
// package-lock.json there when the shrinkwrap is new.
//
// An entry counts as changed when it is new or its version, resolved, integrity, name, link or
// inBundle field differs. Each changed entry must be one of:
// - a tarball at https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz whose name and
//   semver version match the entry's version, and its name field (an npm alias) or else its
//   path; its age is the publish time of the tarball's version;
// - an entry with no resolved URL but a semver version, which npm resolves again from the
//   registry as name@version; its age is the publish time of that version;
// - a workspace package, or a link to one of the root `workspaces`; these are not releases;
// - an inBundle entry inside a package that is itself checked in this change (its files come
//   from that package's tarball).
// Anything else fails closed (exit 1): git, codeload, file, http or other-host tarballs, links
// elsewhere, an entry whose fields disagree with its tarball, or a version that is not semver.
// Publish times come from each package's full packument (the abbreviated one has no `time`), one
// request per name. An unchanged lock makes no registry request.
//
// Exit codes: 0 every changed entry passes; 1 an entry fails (too new, no publish time, or not a
// checkable registry release); 2 the check could not run (bad arguments, unknown base, unreadable
// lock or .npmrc value, a registry that cannot be read, or the 3-minute deadline).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MIN_DAYS = 14;
export const NPM_REGISTRY = "https://registry.npmjs.org/";
const TARBALL_HOST = "registry.npmjs.org";
const DAY_MS = 86_400_000;
const ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
const CONCURRENCY = 4;
const PREFIX = "[release-age]";
// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
// Compared to decide whether an entry changed.
const FIELDS = ["version", "resolved", "integrity", "name", "link", "inBundle"];

/** The check could not run (exit 2). */
export class CheckError extends Error {}

/** An .npmrc value as npm's ini parser reads it: quotes removed, or an unquoted `;`/`#` comment cut. */
function iniValue(raw) {
  const value = raw.trim();
  const quoted =
    value.length > 1 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  if (quoted) {
    const inner = value.startsWith("'") ? value.slice(1, -1) : value;
    try {
      return String(JSON.parse(inner));
    } catch {
      return inner;
    }
  }
  let out = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      out += ";#\\".includes(char) ? char : `\\${char}`;
      escaped = false;
    } else if (char === ";" || char === "#") {
      break;
    } else if (char === "\\") {
      escaped = true;
    } else {
      out += char;
    }
  }
  return (escaped ? `${out}\\` : out).trim();
}

/**
 * `min-release-age` in days from the text of an .npmrc, read as npm reads it (comment lines,
 * inline comments and quotes; keys under a [section] are not top-level settings; the last
 * setting wins), or 14 without one.
 */
export function readMinReleaseAge(npmrcText) {
  let days = DEFAULT_MIN_DAYS;
  let inSection = false;
  for (const line of npmrcText.split(/[\r\n]+/)) {
    if (/^\s*$/.test(line) || /^\s*[;#]/.test(line)) continue;
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    const pair = /^([^=]+)(?:=(.*))?$/.exec(line);
    if (!pair || inSection || iniValue(pair[1]) !== "min-release-age") continue;
    const value = pair[2] === undefined ? "" : iniValue(pair[2]);
    const parsed = Number(value);
    if (value === "" || !Number.isFinite(parsed) || parsed < 0) {
      throw new CheckError(
        `min-release-age must be a number of days, got ${JSON.stringify(value)}`,
      );
    }
    days = parsed;
  }
  return days;
}

/** A URL with any credentials in it masked, for printing; other text unchanged. */
export function redact(text) {
  try {
    const url = new URL(text);
    if (url.password) url.password = "***";
    if (url.username && (url.password || url.username !== "git")) url.username = "***";
    return url.href;
  } catch {
    return String(text);
  }
}

/**
 * The package name and version of an npm registry tarball URL
 * (https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz), or `{ error }`.
 */
export function parseTarball(resolved) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return { error: "not a URL" };
  }
  if (url.protocol !== "https:" || url.host !== TARBALL_HOST || url.username || url.password) {
    return { error: `not a tarball from ${NPM_REGISTRY}` };
  }
  const match = /^\/((?:@[^/@]+\/)?[^/@]+)\/-\/([^/]+)\.tgz$/.exec(url.pathname);
  if (!match || url.search || url.hash) return { error: "not a registry tarball path" };
  const name = match[1];
  const unscoped = name.slice(name.lastIndexOf("/") + 1);
  if (!match[2].startsWith(`${unscoped}-`)) {
    return { error: `the tarball's file name does not start with "${unscoped}-"` };
  }
  const version = match[2].slice(unscoped.length + 1);
  if (!SEMVER.test(version)) return { error: `the tarball's version "${version}" is not semver` };
  return { name, version };
}

const pathName = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const inNodeModules = (path) => /(?:^|\/)node_modules\//.test(path);

/** Matches the root package's `workspaces` (an array, or `{ packages }`), with * and ** globs. */
function workspaceMatcher(rootEntry) {
  const list = Array.isArray(rootEntry?.workspaces)
    ? rootEntry.workspaces
    : Array.isArray(rootEntry?.workspaces?.packages)
      ? rootEntry.workspaces.packages
      : [];
  const patterns = list
    .filter((pattern) => typeof pattern === "string")
    .map((pattern) => {
      const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
      const source = clean
        .split(/(\*\*|\*)/)
        .map((part) =>
          part === "**"
            ? ".*"
            : part === "*"
              ? "[^/]*"
              : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return new RegExp(`^${source}$`);
    });
  return (path) =>
    typeof path === "string" && !inNodeModules(path) && patterns.some((re) => re.test(path));
}

/** The package an inBundle entry was bundled by: its nearest ancestor that is not inBundle. */
function bundlerOf(path, packages) {
  let current = path;
  for (;;) {
    const cut = current.lastIndexOf("/node_modules/");
    if (cut < 0) return null;
    current = current.slice(0, cut);
    const entry = packages[current];
    if (!entry) return null;
    if (entry.inBundle !== true) return current;
  }
}

/**
 * The lock entries of `headPackages` that are new or changed since `basePackages`, sorted into
 * `check` (registry releases to look up: path, name, version), `allowed` (workspace packages and
 * links, and bundled entries of a checked package; path and reason) and `problems` (entries that
 * fail closed; path and reason). Removed entries are in none of them.
 */
export function lockChanges(basePackages, headPackages) {
  const isWorkspace = workspaceMatcher(headPackages[""]);
  const check = [];
  const allowed = [];
  const problems = [];
  const bundled = [];
  for (const [path, entry] of Object.entries(headPackages)) {
    if (path === "") continue;
    const before = basePackages[path];
    if (before && FIELDS.every((field) => before[field] === entry[field])) continue;
    const fail = (reason) => problems.push({ path, reason });
    if (!inNodeModules(path)) {
      if (isWorkspace(path)) allowed.push({ path, reason: "workspace package" });
      else fail("a package outside node_modules that is not one of the root workspaces");
    } else if (entry.link === true) {
      if (isWorkspace(entry.resolved)) {
        allowed.push({ path, reason: `link to the workspace ${entry.resolved}` });
      } else {
        fail(
          `a link to ${JSON.stringify(redact(entry.resolved))}, which is not one of the root workspaces`,
        );
      }
    } else if (entry.inBundle === true) {
      bundled.push(path);
    } else if (typeof entry.resolved === "string") {
      const tarball = parseTarball(entry.resolved);
      if (tarball.error) {
        fail(`resolved from ${redact(entry.resolved)}: ${tarball.error}`);
        continue;
      }
      const disagree = [];
      if (entry.version !== tarball.version) {
        disagree.push(`its version is ${JSON.stringify(entry.version)}`);
      }
      if (typeof entry.name === "string") {
        if (entry.name !== tarball.name) disagree.push(`its name is ${JSON.stringify(entry.name)}`);
      } else if (pathName(path) !== tarball.name) {
        disagree.push(`its path names ${JSON.stringify(pathName(path))}`);
      }
      const id = `${tarball.name}@${tarball.version}`;
      if (disagree.length === 0) {
        check.push({ path, ...tarball });
      } else {
        fail(`${disagree.join(" and ")}, but resolved is the tarball of ${id}`);
      }
    } else if (typeof entry.version === "string") {
      const name = typeof entry.name === "string" ? entry.name : pathName(path);
      if (SEMVER.test(entry.version)) check.push({ path, name, version: entry.version });
      else fail(`no resolved URL, and its version ${JSON.stringify(entry.version)} is not semver`);
    } else {
      fail("no resolved URL and no version");
    }
  }
  const checked = new Set(check.map(({ path }) => path));
  for (const path of bundled) {
    const owner = bundlerOf(path, headPackages);
    if (owner && checked.has(owner)) {
      allowed.push({ path, reason: `bundled in ${owner}` });
    } else if (owner) {
      problems.push({
        path,
        reason: `bundled in ${owner}, which is not a changed registry release`,
      });
    } else {
      problems.push({ path, reason: "marked inBundle, but no package above it bundles it" });
    }
  }
  return { check, allowed, problems };
}

/** The URL of a package's full packument (`@scope/name` as `@scope%2fname`). */
export function packumentUrl(registry, name) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  return new URL(name.replace("/", "%2f"), base).href;
}

/** Milliseconds to wait for a Retry-After header (seconds or an HTTP date), or null. */
function retryAfterMs(header, now) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]);

/** The packument's `time` map (version -> ISO publish time), with retries; CheckError if it fails. */
async function publishTimes(name, context) {
  const { registry, fetch, retryDelayMs, requestTimeoutMs, deadline, sleep, env } = context;
  const url = packumentUrl(registry, name);
  const cannot = (why) => new CheckError(`cannot read ${name} from ${redact(url)}: ${why}`);
  let problem = "";
  let code = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let wait = retryDelayMs * 2 ** (attempt - 1);
    let text;
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(requestTimeoutMs)]),
      });
      if (response.ok) {
        text = await response.text();
      } else {
        await response.body?.cancel().catch(() => {});
        problem = `HTTP ${response.status}`;
        code = "";
        if (response.status !== 429 && response.status < 500) break;
        const after = retryAfterMs(response.headers.get("retry-after"), Date.now());
        if (after !== null) wait = Math.min(after, MAX_RETRY_AFTER_MS);
      }
    } catch (error) {
      if (deadline.signal.aborted) throw deadline.error();
      code = error?.cause?.code ?? error?.code ?? "";
      problem =
        error?.name === "TimeoutError"
          ? `no complete response within ${requestTimeoutMs / 1000} s`
          : code || error?.cause?.message || error?.message || String(error);
    }
    if (text !== undefined) {
      let body;
      try {
        body = JSON.parse(text);
      } catch (error) {
        if (error instanceof SyntaxError) throw cannot("the response is not JSON");
        throw error;
      }
      if (!body || typeof body.time !== "object" || body.time === null) {
        throw cannot('the packument has no "time" field');
      }
      return body.time;
    }
    if (attempt < ATTEMPTS) {
      try {
        await sleep(wait, deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) throw deadline.error();
        throw error;
      }
    }
  }
  const proxy = PROXY_VARIABLES.find((variable) => env[variable]);
  const hint =
    CONNECT_ERRORS.has(code) && proxy && env.NODE_USE_ENV_PROXY !== "1"
      ? ` (${proxy} is set, but Node's fetch uses a proxy only with NODE_USE_ENV_PROXY=1)`
      : "";
  throw cannot(`${problem}${hint}`);
}

/**
 * Reads the publish time of every release in `entries` (path, name, version) and compares its
 * age at `now` with `minDays`. Returns one result per name@version (`tooNew`, or `problem` when
 * the registry has no publish time for it) and the number of registry requests. Throws
 * CheckError when the registry cannot be read.
 */
export async function checkReleases(entries, options) {
  const { minDays, now, fetch } = options;
  const byName = new Map();
  for (const entry of entries) {
    const versions = byName.get(entry.name) ?? new Map();
    const paths = versions.get(entry.version) ?? [];
    paths.push(entry.path);
    versions.set(entry.version, paths);
    byName.set(entry.name, versions);
  }
  let requests = 0;
  const counted = (...args) => {
    requests += 1;
    return fetch(...args);
  };
  const names = [...byName.keys()].sort();
  const results = [];
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < names.length) {
      const name = names[next++];
      let times;
      try {
        times = await publishTimes(name, { ...options, fetch: counted });
      } catch (error) {
        failed = true;
        throw error;
      }
      for (const [version, paths] of byName.get(name)) {
        const result = { name, version, paths };
        const published = Object.hasOwn(times, version) ? times[version] : undefined;
        const publishedMs = typeof published === "string" ? Date.parse(published) : Number.NaN;
        if (Number.isNaN(publishedMs)) {
          result.problem = "the registry has no publish time for this version";
        } else {
          result.published = new Date(publishedMs).toISOString();
          result.ageMs = now - publishedMs;
          result.tooNew = result.ageMs < minDays * DAY_MS;
        }
        results.push(result);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  results.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { results, requests };
}

/** Days with one decimal, rounded down, so an age under the limit never prints as the limit. */
const days = (ms) => `${(Math.floor((ms / DAY_MS) * 10) / 10).toFixed(1)} days`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function readLock(text, where) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    throw new CheckError(`${where} is not valid JSON: ${error.message}`);
  }
  if (!lock || typeof lock.packages !== "object" || lock.packages === null) {
    throw new CheckError(`${where} has no "packages" (lockfileVersion 2 or 3 is needed)`);
  }
  return lock.packages;
}

/** Git, run in `cwd` with `env` (and this process's PATH when `env` has none). */
function git(cwd, env, args, output = false) {
  return execFileSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", output ? "pipe" : "ignore", "ignore"],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** A file's text at `ref`, or null when the file is not there. */
function showAt(cwd, env, ref, path) {
  try {
    return git(cwd, env, ["show", `${ref}:${path}`], true);
  } catch {
    return null;
  }
}

function registryOption(value) {
  const shown = JSON.stringify(redact(value));
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CheckError(`--registry must be an http(s) URL, got ${shown}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CheckError(`--registry must be an http(s) URL, got ${shown}`);
  }
  if (url.username || url.password)
    throw new CheckError(`--registry must not hold credentials: ${shown}`);
  return url.href;
}

/**
 * Runs the check and returns its exit code. `cwd` is the repository root (holding .npmrc and the
 * lock); `fetch`, `now`, `env` (also passed to git), `sleep`, the timeouts and the output
 * functions can be replaced in tests.
 */
export async function run(argv, options = {}) {
  const {
    cwd = root,
    fetch = globalThis.fetch,
    now = Date.now(),
    env = process.env,
    log = console.log,
    error = console.error,
    retryDelayMs = 1000,
    requestTimeoutMs = 30_000,
    deadlineMs = 180_000,
    sleep = (ms, signal) => sleepFor(ms, undefined, { signal }),
  } = options;
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          base: { type: "string" },
          registry: { type: "string" },
          lock: { type: "string" },
        },
      }));
    } catch (problem) {
      throw new CheckError(problem.message);
    }
    if (!values.base) {
      throw new CheckError(
        "usage: check-release-age.mjs --base <git-ref> [--registry <url>] [--lock <path>]",
      );
    }
    const ref = values.base;
    // Only an explicit --registry replaces npmjs: the .npmrc and environment under review could
    // otherwise point the check at a registry that reports any publish time.
    const registry = values.registry === undefined ? NPM_REGISTRY : registryOption(values.registry);

    try {
      git(cwd, env, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      throw new CheckError(
        `unknown base ${JSON.stringify(ref)}: not a commit in this repository (a shallow clone ` +
          "needs enough history, e.g. fetch-depth: 2 for HEAD^1)",
      );
    }

    const npmrcPath = join(cwd, ".npmrc");
    const headDays = existsSync(npmrcPath)
      ? readMinReleaseAge(readFileSync(npmrcPath, "utf8"))
      : DEFAULT_MIN_DAYS;
    const baseNpmrc = showAt(cwd, env, ref, ".npmrc");
    const baseDays = baseNpmrc === null ? DEFAULT_MIN_DAYS : readMinReleaseAge(baseNpmrc);
    const minDays = Math.max(DEFAULT_MIN_DAYS, baseDays, headDays);

    const shrinkwrap = join(cwd, "npm-shrinkwrap.json");
    const lockPath = values.lock
      ? resolve(cwd, values.lock)
      : existsSync(shrinkwrap)
        ? shrinkwrap
        : join(cwd, "package-lock.json");
    const shortName = relative(cwd, lockPath);
    const lockName = shortName && !shortName.startsWith("..") ? shortName : lockPath;
    let lockText;
    try {
      lockText = readFileSync(lockPath, "utf8");
    } catch (problem) {
      throw new CheckError(`cannot read ${lockPath}: ${problem.message}`);
    }
    const head = readLock(lockText, lockName);
    let baseName =
      basename(lockPath) === "npm-shrinkwrap.json" ? "npm-shrinkwrap.json" : "package-lock.json";
    let baseText = showAt(cwd, env, ref, baseName);
    if (baseText === null && baseName === "npm-shrinkwrap.json") {
      baseName = "package-lock.json";
      baseText = showAt(cwd, env, ref, baseName);
    }
    if (baseText === null) {
      log(`${PREFIX} no ${baseName} at ${ref}: every entry of ${lockName} counts as new`);
    }
    const base = baseText === null ? {} : readLock(baseText, `${baseName} at ${ref}`);

    const { check, allowed, problems } = lockChanges(base, head);
    const against = `${lockName} against ${baseName} at ${ref}`;
    if (check.length + allowed.length + problems.length === 0) {
      log(`${PREFIX} ${against}: no new or changed entries; no registry request made`);
      return 0;
    }
    log(
      `${PREFIX} ${against}: ${plural(check.length, "registry release", "registry releases")} to check, ` +
        `${plural(allowed.length, "workspace or bundled entry", "workspace or bundled entries")} with no check needed, ` +
        `${plural(problems.length, "entry", "entries")} that cannot be checked; minimum age ${minDays} days ` +
        `(the largest of 14 and min-release-age in .npmrc at ${ref} and in the working tree)`,
    );
    for (const { path, reason } of allowed) log(`  no check needed  ${path}: ${reason}`);
    const failures = problems.map(({ path, reason }) => `${path}: ${reason}`);
    for (const failure of failures) log(`  FAIL ${failure}`);

    if (check.length > 0) {
      log(`${PREFIX} reading publish times from ${redact(registry)}`);
      const deadline = {
        signal: AbortSignal.timeout(deadlineMs),
        error: () =>
          new CheckError(
            `the registry reads did not finish within the ${deadlineMs / 1000} s deadline`,
          ),
      };
      let outcome;
      try {
        outcome = await checkReleases(check, {
          minDays,
          now,
          registry,
          fetch,
          retryDelayMs,
          requestTimeoutMs,
          deadline,
          sleep,
          env,
        });
      } catch (problem) {
        // Entries that already fail decide the exit code; the registry error is reported too.
        if (!(problem instanceof CheckError) || failures.length === 0) throw problem;
        error(`${PREFIX} ${problem.message}`);
        outcome = { results: [], requests: Number.NaN };
      }
      const at = new Date(now).toISOString();
      for (const result of outcome.results) {
        const id = `${result.name}@${result.version}`;
        if (result.problem) {
          failures.push(`${id}: ${result.problem} (${result.paths.join(", ")})`);
          log(`  FAIL ${id}: ${result.problem}`);
        } else if (result.tooNew) {
          const from = new Date(Date.parse(result.published) + minDays * DAY_MS).toISOString();
          failures.push(
            `${id} was published ${result.published}, ${days(result.ageMs)} before ${at}; ` +
              `it can be taken from ${from} (${result.paths.join(", ")})`,
          );
          log(`  FAIL ${id}  published ${result.published}  ${days(result.ageMs)} old`);
        } else {
          log(`  ok   ${id}  published ${result.published}  ${days(result.ageMs)} old`);
        }
      }
      if (!Number.isNaN(outcome.requests)) {
        log(`${PREFIX} ${plural(outcome.requests, "registry request", "registry requests")}`);
      }
    } else {
      log(`${PREFIX} no registry request made`);
    }

    if (failures.length > 0) {
      error(
        `${PREFIX} ${plural(failures.length, "entry fails", "entries fail")} the check ` +
          `(minimum age ${minDays} days):`,
      );
      for (const failure of failures) error(`  ${failure}`);
      error(
        `${PREFIX} take registry releases that are old enough, and resolve the lock with npm and ` +
          "its min-release-age (.npmrc) instead of editing it by hand",
      );
      return 1;
    }
    log(`${PREFIX} every changed registry release is at least ${minDays} days old`);
    return 0;
  } catch (problem) {
    const message =
      problem instanceof CheckError
        ? problem.message
        : `unexpected error: ${problem?.stack ?? problem}`;
    error(`${PREFIX} cannot check release ages: ${message}`);
    return 2;
  }
}

// Runs when executed directly, not when the tests import it. (import.meta.main is undefined
// before Node 24.2, which would turn the check into a silent no-op there.)
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2));
}

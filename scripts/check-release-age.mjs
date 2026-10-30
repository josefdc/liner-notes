#!/usr/bin/env node
// Release-age check: every package-lock.json entry that is new or changed against a base commit
// must be a release published at least `min-release-age` days ago (from .npmrc, default 14). The
// window rolls with the publish time, as `exclude-newer = "14 days"` does in the audio service.
//
//   npm run check:release-age -- --base <git-ref>
//     --registry <url>   registry to read publish times from (default: npm's `registry` setting,
//                        which `npm run` passes on as npm_config_registry, else registry.npmjs.org)
//     --lock <path>      lock to check instead of package-lock.json (still compared with <git-ref>)
//
// npm's own min-release-age applies only when npm resolves a version: `npm ci` installs whatever
// the lock names, so a lock edited by hand or resolved without the setting could bring in a
// release that is too new. An entry counts as changed when it is new or its version or resolved
// URL differs from <git-ref>. Workspace packages and links are not releases and are skipped; an
// entry not resolved from a registry tarball (git, file, bundled) is listed and skipped. The
// publish time of each exact version comes from the package's full packument (the abbreviated
// one has no `time`), read once per package name. An unchanged lock makes no registry request.
//
// Exit codes: 0 every changed entry is old enough; 1 an entry is too new or has no publish time;
// 2 the check could not run (bad arguments, unknown base, unreadable lock or .npmrc value, or a
// registry that cannot be read). It never passes without reading every publish time it needs.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MIN_DAYS = 14;
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;
const PREFIX = "[release-age]";

/** The check could not run (exit 2). */
export class CheckError extends Error {}

/** `min-release-age` in days from the text of an .npmrc (the last setting wins), or the default. */
export function readMinReleaseAge(npmrcText) {
  let days = DEFAULT_MIN_DAYS;
  for (const raw of npmrcText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const match = /^min-release-age\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
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

/** The registry package name of a lock entry: its `name` (set for aliases), else its path's. */
export function packageName(path, entry) {
  if (typeof entry.name === "string" && entry.name !== "") return entry.name;
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

function isRegistryTarball(resolved) {
  try {
    const url = new URL(resolved);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      /\/-\/[^/]+\.tgz$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * The entries of `headPackages` (a lock's `packages`) that are new or whose version or resolved
 * URL changed since `basePackages`: `check` lists the registry releases, `skipped` the changed
 * entries that are not (with the reason). Removed entries, workspace packages and links are
 * left out.
 */
export function changedEntries(basePackages, headPackages) {
  const check = [];
  const skipped = [];
  for (const [path, entry] of Object.entries(headPackages)) {
    // The root and workspace packages ("", "apps/api") are not installed from a registry.
    if (!path.includes("node_modules/")) continue;
    if (entry.link === true) continue;
    const before = basePackages[path];
    if (before && before.version === entry.version && before.resolved === entry.resolved) continue;
    if (typeof entry.resolved !== "string") {
      skipped.push({ path, reason: 'no "resolved" URL' });
    } else if (!isRegistryTarball(entry.resolved)) {
      skipped.push({ path, reason: `resolved from ${entry.resolved}, not a registry tarball` });
    } else if (typeof entry.version !== "string") {
      skipped.push({ path, reason: 'no "version"' });
    } else {
      check.push({ path, name: packageName(path, entry), version: entry.version });
    }
  }
  return { check, skipped };
}

/** The URL of a package's full packument (`@scope/name` as `@scope%2fname`). */
export function packumentUrl(registry, name) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  return new URL(name.replace("/", "%2f"), base).href;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The packument's `time` map (version -> ISO publish time); one retry on a network or 5xx error. */
async function publishTimes(name, { registry, fetch, retryDelayMs }) {
  const url = packumentUrl(registry, name);
  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs);
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      problem = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
      continue;
    }
    if (response.ok) {
      let body;
      try {
        body = await response.json();
      } catch {
        throw new CheckError(`cannot read ${name} from ${url}: the response is not JSON`);
      }
      if (!body || typeof body.time !== "object" || body.time === null) {
        throw new CheckError(`cannot read ${name} from ${url}: the packument has no "time" field`);
      }
      return body.time;
    }
    await response.body?.cancel();
    problem = `HTTP ${response.status}`;
    if (response.status < 500 && response.status !== 429) break;
  }
  throw new CheckError(`cannot read ${name} from ${url}: ${problem}`);
}

/**
 * Reads the publish time of every release in `entries` and compares its age at `now` with
 * `minDays`. Returns one result per name@version (`tooNew`, or `problem` when the registry has no
 * usable publish time for it) and the number of registry requests. Throws CheckError when the
 * registry cannot be read.
 */
export async function checkReleases(
  entries,
  { minDays, now, registry, fetch, retryDelayMs = 1000 },
) {
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
        times = await publishTimes(name, { registry, fetch: counted, retryDelayMs });
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

function baseLock(cwd, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new CheckError(`unknown base ${JSON.stringify(ref)}`);
  }
  let text;
  try {
    text = execFileSync("git", ["show", `${ref}:package-lock.json`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  return readLock(text, `package-lock.json at ${ref}`);
}

/**
 * Runs the check and returns its exit code. `cwd` is the repository root (holding .npmrc and
 * package-lock.json); `fetch`, `now`, `env` and the output functions can be replaced in tests.
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

    const npmrcPath = join(cwd, ".npmrc");
    const minDays = existsSync(npmrcPath)
      ? readMinReleaseAge(readFileSync(npmrcPath, "utf8"))
      : DEFAULT_MIN_DAYS;

    const registry = values.registry || env.npm_config_registry || DEFAULT_REGISTRY;
    if (!/^https?:\/\//.test(registry)) {
      throw new CheckError(`--registry must be an http(s) URL, got ${JSON.stringify(registry)}`);
    }

    const lockPath = resolve(cwd, values.lock ?? "package-lock.json");
    let lockText;
    try {
      lockText = readFileSync(lockPath, "utf8");
    } catch (problem) {
      throw new CheckError(`cannot read ${lockPath}: ${problem.message}`);
    }
    const head = readLock(lockText, lockPath);
    const base = baseLock(cwd, values.base);
    if (base === null)
      log(`${PREFIX} no package-lock.json at ${values.base}: every entry counts as new`);

    const { check, skipped } = changedEntries(base ?? {}, head);
    for (const { path, reason } of skipped) log(`${PREFIX} skipped ${path}: ${reason}`);
    if (check.length === 0) {
      log(
        `${PREFIX} no new or changed registry entries in the lock against ${values.base}; ` +
          "no registry request made",
      );
      return 0;
    }

    log(
      `${PREFIX} ${plural(check.length, "changed lock entry", "changed lock entries")} against ${values.base}; ` +
        `minimum age ${minDays} days (.npmrc min-release-age); registry ${registry}`,
    );
    const { results, requests } = await checkReleases(check, {
      minDays,
      now,
      registry,
      fetch,
      retryDelayMs,
    });
    const at = new Date(now).toISOString();
    const failures = [];
    for (const result of results) {
      const id = `${result.name}@${result.version}`;
      if (result.problem) {
        failures.push(`${id}: ${result.problem} (${result.paths.join(", ")})`);
        log(`  FAIL ${id}: ${result.problem}`);
      } else if (result.tooNew) {
        const allowed = new Date(Date.parse(result.published) + minDays * DAY_MS).toISOString();
        failures.push(
          `${id} was published ${result.published}, ${days(result.ageMs)} before ${at}; ` +
            `it can be taken from ${allowed} (${result.paths.join(", ")})`,
        );
        log(`  FAIL ${id}  published ${result.published}  ${days(result.ageMs)} old`);
      } else {
        log(`  ok   ${id}  published ${result.published}  ${days(result.ageMs)} old`);
      }
    }
    log(`${PREFIX} ${plural(requests, "registry request", "registry requests")}`);
    if (failures.length > 0) {
      error(
        `${PREFIX} ${plural(failures.length, "release", "releases")} under ${minDays} days old:`,
      );
      for (const failure of failures) error(`  ${failure}`);
      error(
        `${PREFIX} take an older version, or wait until it is old enough; resolve the lock with ` +
          `npm's min-release-age (.npmrc) instead of editing it by hand`,
      );
      return 1;
    }
    log(`${PREFIX} every changed release is at least ${minDays} days old`);
    return 0;
  } catch (problem) {
    if (!(problem instanceof CheckError)) throw problem;
    error(`${PREFIX} cannot check release ages: ${problem.message}`);
    return 2;
  }
}

// Runs only when executed directly (import.meta.main also holds through symlinked paths).
if (import.meta.main) process.exit(await run(process.argv.slice(2)));

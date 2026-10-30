#!/usr/bin/env node
// Release-age check: every lock entry that is new or changed against a base commit must be an npm
// registry release published at least N days ago, where N is the largest of 14 and .npmrc's
// `min-release-age` at the base and in the working tree (so a change cannot lower it for itself).
// The window rolls with the publish time, as `exclude-newer = "14 days"` does in the audio service.
//
//   npm run check:release-age -- --base <git-ref>
//     --registry <url>   read packuments from this registry instead of registry.npmjs.org
//     --lock <path>      check this lock instead of npm-shrinkwrap.json / package-lock.json
//
// npm's own min-release-age applies only when npm resolves a version: `npm ci` installs what the
// lock names wherever the lock still agrees with package.json, so a lock edited by hand or resolved
// without the setting could bring in a release that is too new.
//
// Threat model: this guards against honest mistakes like that one. It is not a security boundary
// against a change written to defeat it; such a change could as well edit the CI workflow.
// Not covered: .npmrc settings other than the registry ones below (proxies, userconfig,
// globalconfig, CA and TLS settings), and in CI the fallback to the parent commit when the commit
// before a push cannot be fetched.
//
// Locks: npm ci uses npm-shrinkwrap.json when there is one, else package-lock.json. The head's
// lock is compared with the one npm would have used at <git-ref> (its shrinkwrap if it had one);
// while both files exist in the working tree, package-lock.json is also compared with the base's
// package-lock.json, so it cannot change unchecked and take over when the shrinkwrap goes.
//
// An entry counts as changed when it is new or its version, resolved, integrity, name, link,
// inBundle or hasShrinkwrap field differs. A changed entry with a name field that is not a valid
// package name, or with hasShrinkwrap (npm then installs what the package's own shrinkwrap names),
// fails. Otherwise each changed entry must be one of:
// - a tarball at https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz (<basename> is the
//   name without its scope) whose name and semver version match the entry's version, and its name
//   field (an npm alias) or else its path, with an integrity;
// - an entry with no resolved URL but a semver version and an integrity, which npm resolves again
//   from the registry as name@version;
// - a workspace package, or a link to one of the `workspaces` of the base (its lock's root entry
//   or its package.json), or of the working tree's package.json, which npm ci reads (a workspace
//   added there must be a local folder with no resolved URL or integrity, and its link must
//   carry no integrity); these are not releases and need no check. The head lock's root entry
//   is never used for this.
// A release passes when its version was published at least N days ago and the lock's integrity
// agrees with the registry's for that version (versions[v].dist.integrity, and dist.shasum as
// sha1): every hash in it must parse, use an algorithm the registry lists, and match. Anything
// else fails closed (exit 1): git, codeload, file, http or other-host tarballs, links elsewhere,
// an entry whose fields disagree with its tarball, a version that is not semver, an entry with no
// integrity (including a bundled one, which npm resolves with nothing to verify it against when
// the parent does not bundle it). So does a change to npm's registry settings in .npmrc
// (registry, <scope>:registry, replace-registry-host), and a dependency spec in the root or a
// workspace package.json that is not a registry range, a tag, an npm: alias of one, or a path to
// a workspace: npm ci would resolve such a spec again, outside the lock.
// Packuments are the full ones (the abbreviated one has no `time`), one request per name; an
// unchanged lock makes no registry request.
//
// Exit codes: 0 every changed entry passes; 1 an entry fails (too new, no publish time, an
// integrity that differs or is missing, a registry setting changed, a dependency spec npm would
// resolve outside the registry, or not a checkable registry release); 2 the check could not run
// (bad arguments, unknown base, unreadable lock, package.json or .npmrc value, a registry that
// cannot be read, or the 3-minute deadline).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MIN_DAYS = 14;
export const NPM_REGISTRY = "https://registry.npmjs.org/";
const TARBALL_HOST = "registry.npmjs.org";
const SHRINKWRAP = "npm-shrinkwrap.json";
const PACKAGE_LOCK = "package-lock.json";
const DAY_MS = 86_400_000;
const ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
const CONCURRENCY = 4;
const PREFIX = "[release-age]";
// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
// Compared to decide whether an entry changed.
const FIELDS = ["version", "resolved", "integrity", "name", "link", "inBundle", "hasShrinkwrap"];
// npm's rule for package names (validate-npm-package-name), with the capitals of old packages.
const PACKAGE_NAME = /^(?:@[a-z0-9\-*~][a-z0-9\-*._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/i;

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
 * The top-level settings of an .npmrc, read as npm's ini parser reads it (comment lines, inline
 * comments, quotes; keys under a [section] are not top-level; the last setting wins). A `key[]`
 * setting collects every value in an array under `key[]`; a key without `=` has the value "".
 */
export function readNpmrc(npmrcText) {
  const settings = new Map();
  let inSection = false;
  for (const line of npmrcText.split(/[\r\n]+/)) {
    if (/^\s*$/.test(line) || /^\s*[;#]/.test(line)) continue;
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    const pair = /^([^=]+)(?:=(.*))?$/.exec(line);
    if (!pair || inSection) continue;
    const key = iniValue(pair[1]);
    const value = pair[2] === undefined ? "" : iniValue(pair[2]);
    if (key.endsWith("[]")) settings.set(key, [...(settings.get(key) ?? []), value]);
    else settings.set(key, value);
  }
  return settings;
}

/**
 * `min-release-age` in days from the text of an .npmrc, or 14 without one. `min-release-age[]`
 * values count too and the largest value wins, which can only make the check stricter than npm.
 */
export function readMinReleaseAge(npmrcText) {
  const settings = readNpmrc(npmrcText);
  const values = [
    ...(settings.has("min-release-age") ? [settings.get("min-release-age")] : []),
    ...(settings.get("min-release-age[]") ?? []),
  ];
  if (values.length === 0) return DEFAULT_MIN_DAYS;
  return Math.max(
    ...values.map((value) => {
      const parsed = Number(value);
      if (value === "" || !Number.isFinite(parsed) || parsed < 0) {
        throw new CheckError(
          `min-release-age must be a number of days, got ${JSON.stringify(value)}`,
        );
      }
      return parsed;
    }),
  );
}

/** The .npmrc settings that decide where npm fetches packages from, as sorted [key, value] pairs. */
export function registrySettings(npmrcText) {
  return [...readNpmrc(npmrcText)]
    .filter(([key]) => {
      const bare = key.replace(/\[\]$/, "");
      return bare === "registry" || bare.endsWith(":registry") || bare === "replace-registry-host";
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

// An SRI hash as npm's ssri reads one: any algorithm name, a base64 digest and optional options.
const HASH = /^([a-z0-9]+)-([A-Za-z0-9+/]+={0,2})(?:\?\S*)?$/;

/**
 * The hashes of an SRI integrity string, as algorithm -> set of base64 digests, and the tokens
 * that are not hashes.
 */
function hashesOf(integrity) {
  const hashes = new Map();
  const unparsed = [];
  const text = typeof integrity === "string" ? integrity.trim() : "";
  for (const token of text === "" ? [] : text.split(/\s+/)) {
    const match = HASH.exec(token);
    if (!match) {
      unparsed.push(token);
      continue;
    }
    if (!hashes.has(match[1])) hashes.set(match[1], new Set());
    hashes.get(match[1]).add(match[2]);
  }
  return { hashes, unparsed };
}

const abridged = (digest) => (digest.length > 16 ? `${digest.slice(0, 16)}...` : digest);

/**
 * Compares a lock entry's integrity with a packument version's `dist` (its `integrity`, and its
 * `shasum` as a sha1). npm verifies with the strongest algorithm in the lock's string, so every
 * token must be a hash, every algorithm must be one the registry lists for the version, and every
 * hash must match. Returns `{ compared }` (the algorithms) or `{ problem }`.
 */
export function compareIntegrity(lockIntegrity, dist) {
  const { hashes: lock, unparsed } = hashesOf(lockIntegrity);
  if (unparsed.length > 0) {
    return { problem: `its integrity holds ${JSON.stringify(unparsed[0])}, which is not a hash` };
  }
  if (lock.size === 0) return { problem: "its integrity is empty" };
  const { hashes: registry } = hashesOf(dist?.integrity);
  if (typeof dist?.shasum === "string" && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    if (!registry.has("sha1")) registry.set("sha1", new Set());
    registry.get("sha1").add(Buffer.from(dist.shasum, "hex").toString("base64"));
  }
  if (registry.size === 0) return { problem: "the registry lists no integrity for this version" };
  const compared = [...lock.keys()];
  const unknown = compared.find((algorithm) => !registry.has(algorithm));
  if (unknown) {
    return {
      problem:
        `its integrity has a ${unknown} hash, but the registry lists only ` +
        `${[...registry.keys()].join(", ")} for this version`,
    };
  }
  for (const algorithm of compared) {
    const listed = registry.get(algorithm);
    for (const digest of lock.get(algorithm)) {
      if (!listed.has(digest)) {
        return {
          problem:
            `its integrity ${algorithm}-${abridged(digest)} is not the registry's ` +
            `${algorithm}-${abridged([...listed][0])}`,
        };
      }
    }
  }
  return { compared };
}

const pathName = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const inNodeModules = (path) => /(?:^|\/)node_modules\//.test(path);
/** Whether `name` is a package name npm would accept (with the capitals of old packages). */
const isPackageName = (name) =>
  typeof name === "string" && name.length <= 214 && PACKAGE_NAME.test(name);

/** The `workspaces` patterns of a package.json or lock root entry (an array, or `{ packages }`). */
export function workspacesOf(manifest) {
  const list = Array.isArray(manifest?.workspaces)
    ? manifest.workspaces
    : Array.isArray(manifest?.workspaces?.packages)
      ? manifest.workspaces.packages
      : [];
  return list.filter((pattern) => typeof pattern === "string");
}

/** Matches workspace folders against `patterns`, with * and ** globs. */
function workspaceMatcher(patterns) {
  const regexps = patterns.map((pattern) => {
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    const source = clean
      .split(/(\*\*|\*)/)
      .map((part) =>
        part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${source}$`);
  });
  return (path) =>
    typeof path === "string" && !inNodeModules(path) && regexps.some((re) => re.test(path));
}

/**
 * The lock entries of `headPackages` that are new or changed since `basePackages`, sorted into
 * `check` (registry releases to look up: path, name, version, and the integrity to compare),
 * `allowed` (workspace packages and links; path and reason) and `problems`
 * (entries that fail closed; path and reason). Removed entries are in none of them. `workspaces`
 * are the base's workspace patterns; `headWorkspaces` are those of the working tree's package.json
 * (what npm ci reads), which allow only a folder entry with no resolved URL or integrity, or a link
 * to such a folder with no integrity.
 */
export function lockChanges(basePackages, headPackages, workspaces = [], headWorkspaces = []) {
  const isWorkspace = workspaceMatcher(workspaces);
  const isHeadWorkspace = workspaceMatcher(headWorkspaces);
  const check = [];
  const allowed = [];
  const problems = [];
  for (const [path, entry] of Object.entries(headPackages)) {
    if (path === "") continue;
    const before = basePackages[path];
    if (before && FIELDS.every((field) => before[field] === entry[field])) continue;
    const fail = (reason) => problems.push({ path, reason });
    const name = typeof entry.name === "string" ? entry.name : pathName(path);
    const plain = entry.integrity === undefined;
    if (Object.hasOwn(entry, "name") && !isPackageName(entry.name)) {
      // npm builds the spec it resolves from this field as it is.
      fail(`its name ${JSON.stringify(entry.name)} is not a package name`);
    } else if (entry.hasShrinkwrap === true) {
      fail(
        "it has hasShrinkwrap: npm then installs what the package's own npm-shrinkwrap.json " +
          "names, which this check does not see",
      );
    } else if (!inNodeModules(path)) {
      if (isWorkspace(path)) {
        allowed.push({ path, reason: "workspace package" });
      } else if (!isHeadWorkspace(path)) {
        fail(
          "a package outside node_modules that is not a workspace of the base or of package.json",
        );
      } else if (entry.resolved === undefined && plain) {
        allowed.push({ path, reason: "workspace package added in package.json" });
      } else {
        fail("a workspace folder added in package.json, but with a resolved URL or an integrity");
      }
    } else if (entry.link === true) {
      const target = entry.resolved;
      const local = typeof target === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(target);
      if (isWorkspace(target)) {
        allowed.push({ path, reason: `link to the workspace ${target}` });
      } else if (local && plain && isHeadWorkspace(target)) {
        allowed.push({ path, reason: `link to the workspace ${target}, added in package.json` });
      } else {
        fail(
          `a link to ${JSON.stringify(redact(target))}, which is not a workspace of the base or ` +
            "(as a local folder, with no integrity) of package.json",
        );
      }
    } else if (entry.inBundle === true && entry.resolved === undefined && plain) {
      // If the parent does not bundle it after all, npm resolves name@version from the registry
      // with nothing to verify the bytes against.
      fail(
        "bundled, with no resolved URL and no integrity: if its parent does not bundle it, npm " +
          "resolves it with nothing to verify it against",
      );
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
      if (disagree.length > 0) {
        fail(`${disagree.join(" and ")}, but resolved is the tarball of ${id}`);
      } else if (typeof entry.integrity !== "string") {
        fail(`${id} has no integrity in the lock`);
      } else {
        check.push({ path, ...tarball, integrity: entry.integrity });
      }
    } else if (typeof entry.version === "string") {
      if (!isPackageName(name)) {
        fail(`no resolved URL, and its path names ${JSON.stringify(name)}, not a package name`);
      } else if (!SEMVER.test(entry.version)) {
        fail(`no resolved URL, and its version ${JSON.stringify(entry.version)} is not semver`);
      } else if (typeof entry.integrity !== "string") {
        fail(`${name}@${entry.version} has no resolved URL and no integrity in the lock`);
      } else {
        check.push({ path, name, version: entry.version, integrity: entry.integrity });
      }
    } else {
      fail("no resolved URL and no version");
    }
  }
  return { check, allowed, problems };
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
// A registry range or a dist-tag: none of the characters that make npm read a spec as a URL, a
// git repository, a path or an alias.
const RANGE_OR_TAG = /^[0-9A-Za-z.\-+*^~<>=|_ ]*$/;
const TARBALL_FILE = /\.(?:tgz|tar\.gz|tar)$/i;
const isRangeOrTag = (text) =>
  RANGE_OR_TAG.test(text) && !TARBALL_FILE.test(text.trim()) && !text.trim().startsWith(".");

/**
 * Why npm would resolve a package.json dependency `spec` outside the registry, or null when it is a
 * registry range, a tag, an npm: alias of one, or a workspace: or file: path to a workspace folder
 * (`isWorkspaceFolder`, given the path relative to the repository root). `from` is the folder of
 * the package.json, relative to the root ("" for the root).
 */
export function specProblem(spec, isWorkspaceFolder = () => false, from = "") {
  if (typeof spec !== "string") return "not a string";
  const text = spec.trim();
  if (text.startsWith("npm:")) {
    const rest = text.slice("npm:".length);
    const at = rest.indexOf("@", 1);
    const alias = at === -1 ? rest : rest.slice(0, at);
    if (!isPackageName(alias)) return "an npm: alias of something that is not a package name";
    return at === -1 || isRangeOrTag(rest.slice(at + 1))
      ? null
      : "an npm: alias with something other than a registry range or tag";
  }
  if (text.startsWith("workspace:")) {
    return isRangeOrTag(text.slice("workspace:".length))
      ? null
      : "a workspace: spec with something other than a range";
  }
  if (text.startsWith("file:")) {
    const target = posix.normalize(posix.join(from, text.slice("file:".length)));
    const inside = !target.startsWith("../") && target !== ".." && !posix.isAbsolute(target);
    return inside && isWorkspaceFolder(target.replace(/\/+$/, ""))
      ? null
      : "a file: path that is not a workspace folder";
  }
  return isRangeOrTag(text)
    ? null
    : "not a registry range, a tag, an npm: alias of one, or a path to a workspace";
}

/** The dependency specs of a package.json, including `overrides`, as [label, spec] pairs. */
function dependencySpecs(manifest) {
  const specs = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest?.[field];
    if (deps === undefined) continue;
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
      specs.push([field, deps]);
      continue;
    }
    for (const [name, spec] of Object.entries(deps))
      specs.push([`${field}[${JSON.stringify(name)}]`, spec]);
  }
  const walk = (label, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value)) {
        walk(`${label}[${JSON.stringify(key)}]`, inner);
      }
    } else if (typeof value === "string" && /^\$/.test(value)) {
      // A reference to a root dependency's spec, which is checked on its own.
      specs.push([label, isPackageName(value.slice(1)) ? "*" : value]);
    } else {
      specs.push([label, value]);
    }
  };
  if (manifest?.overrides !== undefined) walk("overrides", manifest.overrides);
  return specs;
}

/** The folders under `cwd` that match workspace `patterns` (* and ** globs), relative to it. */
function workspaceFolders(cwd, patterns) {
  const found = new Set();
  const subfolders = (folder) => {
    try {
      return readdirSync(join(cwd, folder), { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && dirent.name !== "node_modules")
        .filter((dirent) => !dirent.name.startsWith("."))
        .map((dirent) => (folder ? `${folder}/${dirent.name}` : dirent.name));
    } catch {
      return [];
    }
  };
  const expand = (folder, parts) => {
    if (parts.length === 0) {
      if (folder) found.add(folder);
      return;
    }
    const [part, ...rest] = parts;
    if (part === "**") {
      expand(folder, rest);
      for (const sub of subfolders(folder)) expand(sub, parts);
    } else if (part.includes("*")) {
      const re = new RegExp(
        `^${part
          .split("*")
          .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*")}$`,
      );
      for (const sub of subfolders(folder)) {
        if (re.test(sub.slice(sub.lastIndexOf("/") + 1))) expand(sub, rest);
      }
    } else if (part !== "" && part !== "." && part !== "..") {
      const next = folder ? `${folder}/${part}` : part;
      if (existsSync(join(cwd, next))) expand(next, rest);
    }
  };
  for (const pattern of patterns) {
    expand("", pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/"));
  }
  return [...found].sort();
}

/**
 * Failures for dependency specs in the working tree's root package.json and its workspaces'
 * package.json files that npm ci would resolve outside the registry (it resolves a spec again
 * when the lock no longer satisfies it).
 */
function packageJsonProblems(cwd, patterns, isWorkspaceFolder) {
  const problems = [];
  const folders = [
    "",
    ...workspaceFolders(cwd, patterns).filter((folder) =>
      existsSync(join(cwd, folder, "package.json")),
    ),
  ];
  for (const folder of folders) {
    const file = folder ? `${folder}/package.json` : "package.json";
    if (!existsSync(join(cwd, file))) continue;
    const manifest = parseJson(readFileSync(join(cwd, file), "utf8"), file);
    for (const [label, spec] of dependencySpecs(manifest)) {
      const problem = specProblem(spec, isWorkspaceFolder, folder);
      if (problem) {
        const shown =
          typeof spec === "string" ? JSON.stringify(redact(spec)) : JSON.stringify(spec);
        problems.push(
          `${file}: ${label} is ${shown}: ${problem}; npm ci would resolve it outside the lock`,
        );
      }
    }
  }
  return problems;
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

/** A package's full packument (`time` and `versions`), with retries; CheckError if it fails. */
async function readPackument(name, context) {
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
      return body;
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
 * Reads the packument of every release in `entries` (path, name, version and integrity),
 * compares each version's age at `now` with `minDays` and each entry's integrity with the
 * registry's. Returns one result per name@version (`tooNew`, or `problem` when the
 * registry has no publish time for it, and `integrity`: the entries whose integrity differs or
 * cannot be compared), the number of integrity comparisons that matched, and the number of
 * registry requests. Throws CheckError when the registry cannot be read.
 */
export async function checkReleases(entries, options) {
  const { minDays, now, fetch } = options;
  const byName = new Map();
  for (const entry of entries) {
    const versions = byName.get(entry.name) ?? new Map();
    versions.set(entry.version, [...(versions.get(entry.version) ?? []), entry]);
    byName.set(entry.name, versions);
  }
  let requests = 0;
  let matched = 0;
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
      let packument;
      try {
        packument = await readPackument(name, { ...options, fetch: counted });
      } catch (error) {
        failed = true;
        throw error;
      }
      const { time } = packument;
      for (const [version, located] of byName.get(name)) {
        const result = { name, version, paths: located.map(({ path }) => path), integrity: [] };
        const published = Object.hasOwn(time, version) ? time[version] : undefined;
        const publishedMs = typeof published === "string" ? Date.parse(published) : Number.NaN;
        if (Number.isNaN(publishedMs)) {
          result.problem = "the registry has no publish time for this version";
        } else {
          result.published = new Date(publishedMs).toISOString();
          result.ageMs = now - publishedMs;
          result.tooNew = result.ageMs < minDays * DAY_MS;
        }
        // A semver version is never an inherited key, so no own-property check is needed.
        const listed = packument.versions?.[version];
        for (const entry of located) {
          const comparison = compareIntegrity(entry.integrity, listed?.dist);
          if (comparison.problem) {
            result.integrity.push({ path: entry.path, reason: comparison.problem });
          } else {
            matched += 1;
          }
        }
        results.push(result);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  results.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { results, matched, requests };
}

/** Days with one decimal, rounded down, so an age under the limit never prints as the limit. */
const days = (ms) => `${(Math.floor((ms / DAY_MS) * 10) / 10).toFixed(1)} days`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CheckError(`${where} is not valid JSON: ${error.message}`);
  }
}

function readLock(text, where) {
  const lock = parseJson(text, where);
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
  if (url.username || url.password) {
    throw new CheckError(`--registry must not hold credentials: ${shown}`);
  }
  return url.href;
}

/** Throws CheckError when `ref` is not a commit here, saying how to get it in a shallow clone. */
function verifyBase(cwd, env, ref) {
  try {
    git(cwd, env, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return;
  } catch {}
  let shallow = false;
  try {
    shallow = git(cwd, env, ["rev-parse", "--is-shallow-repository"], true).trim() === "true";
  } catch {}
  throw new CheckError(
    shallow
      ? `unknown base ${JSON.stringify(ref)}: this clone is shallow and does not have it; fetch ` +
          "it first (git fetch --no-tags --depth=1 origin <sha>) or clone more history"
      : `unknown base ${JSON.stringify(ref)}: not a commit in this repository`,
  );
}

/** The settings of two .npmrc texts that decide where npm fetches from, when they differ. */
function registryChange(baseNpmrc, headNpmrc) {
  const before = registrySettings(baseNpmrc);
  const after = registrySettings(headNpmrc);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  const shown = (pairs) =>
    pairs.length === 0
      ? "none"
      : pairs.map(([key, value]) => `${key}=${[value].flat().map(redact).join(",")}`).join(", ");
  return (
    `.npmrc: npm's registry settings change from ${shown(before)} to ${shown(after)}; they ` +
    "decide where npm ci fetches every tarball from, so this check fails on any change to them " +
    "(a maintainer changes them on the base branch, past this check)"
  );
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
    // Only an explicit --registry replaces npmjs: the .npmrc and environment of the change being
    // checked could otherwise point the check at a registry that reports any publish time.
    const registry = values.registry === undefined ? NPM_REGISTRY : registryOption(values.registry);
    verifyBase(cwd, env, ref);

    const npmrcPath = join(cwd, ".npmrc");
    const headNpmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf8") : "";
    const baseNpmrc = showAt(cwd, env, ref, ".npmrc") ?? "";
    const minDays = Math.max(
      DEFAULT_MIN_DAYS,
      readMinReleaseAge(baseNpmrc),
      readMinReleaseAge(headNpmrc),
    );
    const failures = [];
    const changedRegistry = registryChange(baseNpmrc, headNpmrc);
    if (changedRegistry) failures.push(changedRegistry);

    // The locks to check, each with the base file it is compared with (null: none at the base).
    const base = {
      [SHRINKWRAP]: showAt(cwd, env, ref, SHRINKWRAP),
      [PACKAGE_LOCK]: showAt(cwd, env, ref, PACKAGE_LOCK),
    };
    // npm's own choice at the base: its shrinkwrap if it had one.
    const baseUsed =
      base[SHRINKWRAP] !== null ? SHRINKWRAP : base[PACKAGE_LOCK] !== null ? PACKAGE_LOCK : null;
    const pairs = [];
    if (values.lock) {
      pairs.push({ head: resolve(cwd, values.lock), base: baseUsed });
    } else {
      const hasShrinkwrap = existsSync(join(cwd, SHRINKWRAP));
      const hasLock = existsSync(join(cwd, PACKAGE_LOCK));
      if (hasShrinkwrap) pairs.push({ head: join(cwd, SHRINKWRAP), base: baseUsed });
      if (hasLock) {
        const lockBase = base[PACKAGE_LOCK] !== null ? PACKAGE_LOCK : null;
        pairs.push({ head: join(cwd, PACKAGE_LOCK), base: hasShrinkwrap ? lockBase : baseUsed });
      }
      if (pairs.length === 0) {
        throw new CheckError(`no ${SHRINKWRAP} or ${PACKAGE_LOCK} in ${cwd}`);
      }
    }

    // Workspaces come from the base, or from the working tree's package.json (which npm ci reads)
    // for local folders only; never from the head lock's root entry, which npm ci does not use.
    const basePackageJson = showAt(cwd, env, ref, "package.json");
    const workspaces =
      basePackageJson === null
        ? []
        : workspacesOf(parseJson(basePackageJson, `package.json at ${ref}`));
    const baseLocks = {};
    for (const name of [SHRINKWRAP, PACKAGE_LOCK]) {
      if (base[name] === null) continue;
      baseLocks[name] = readLock(base[name], `${name} at ${ref}`);
      workspaces.push(...workspacesOf(baseLocks[name][""]));
    }
    const packageJsonPath = join(cwd, "package.json");
    const headWorkspaces = existsSync(packageJsonPath)
      ? workspacesOf(parseJson(readFileSync(packageJsonPath, "utf8"), "package.json"))
      : [];
    const isBaseWorkspace = workspaceMatcher(workspaces);
    const isHeadWorkspace = workspaceMatcher(headWorkspaces);
    failures.push(
      ...packageJsonProblems(
        cwd,
        [...new Set([...workspaces, ...headWorkspaces])],
        (folder) => isBaseWorkspace(folder) || isHeadWorkspace(folder),
      ),
    );

    const check = [];
    const allowed = [];
    const problems = [];
    const described = [];
    for (const pair of pairs) {
      const shortName = relative(cwd, pair.head);
      const headName = shortName && !shortName.startsWith("..") ? shortName : pair.head;
      let text;
      try {
        text = readFileSync(pair.head, "utf8");
      } catch (problem) {
        throw new CheckError(`cannot read ${pair.head}: ${problem.message}`);
      }
      const headPackages = readLock(text, headName);
      if (pair.base === null) {
        log(`${PREFIX} no lock to compare ${headName} with at ${ref}: every entry counts as new`);
      }
      described.push(`${headName} against ${pair.base ?? "no lock"} at ${ref}`);
      const label = (path) => (pairs.length > 1 ? `${headName}: ${path}` : path);
      const changes = lockChanges(
        pair.base === null ? {} : baseLocks[pair.base],
        headPackages,
        workspaces,
        headWorkspaces,
      );
      check.push(...changes.check.map((entry) => ({ ...entry, path: label(entry.path) })));
      allowed.push(...changes.allowed.map((entry) => ({ ...entry, path: label(entry.path) })));
      problems.push(...changes.problems.map((entry) => ({ ...entry, path: label(entry.path) })));
    }
    const against = described.join(", and ");
    if (check.length + allowed.length + problems.length + failures.length === 0) {
      log(`${PREFIX} ${against}: no new or changed entries; no registry request made`);
      return 0;
    }
    failures.push(...problems.map(({ path, reason }) => `${path}: ${reason}`));
    log(
      `${PREFIX} ${against}: ` +
        `${plural(check.length, "registry release", "registry releases")} to check, ` +
        `${plural(allowed.length, "workspace entry", "workspace entries")} with no check needed, ` +
        `${plural(failures.length, "failure", "failures")} before any registry request; ` +
        `minimum age ${minDays} days (the largest of 14 and min-release-age in .npmrc at ${ref} ` +
        "and in the working tree)",
    );
    for (const { path, reason } of allowed) log(`  no check needed  ${path}: ${reason}`);
    for (const failure of failures) log(`  FAIL ${failure}`);

    if (check.length > 0) {
      log(`${PREFIX} reading packuments from ${redact(registry)}`);
      const deadline = {
        signal: AbortSignal.timeout(deadlineMs),
        error: () =>
          new CheckError(
            `the registry reads did not finish within the ${deadlineMs / 1000} s deadline`,
          ),
      };
      let outcome = null;
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
      }
      if (outcome) {
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
          for (const { path, reason } of result.integrity) {
            failures.push(`${path}: ${id}: ${reason}`);
            log(`  FAIL ${path}: ${id}: ${reason}`);
          }
        }
        log(
          `${PREFIX} ${plural(outcome.requests, "registry request", "registry requests")}; ` +
            `${plural(outcome.matched, "integrity matches", "integrities match")} the registry's`,
        );
      }
    } else {
      log(`${PREFIX} no registry request made`);
    }

    if (failures.length > 0) {
      error(
        `${PREFIX} ${plural(failures.length, "failure", "failures")} (minimum age ${minDays} days):`,
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

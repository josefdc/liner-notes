#!/usr/bin/env node
// Honesty guard: counts patterns that put invented or placeholder data in front of users
// (or that hide where data comes from) and fails when any count rises above its baseline.
//
//   npm run guard:honest            check against scripts/guard-baseline.json
//   npm run guard:honest -- --update lower baselines to the current counts (never raises them)
//
// A rule whose baseline is 0 is a hard zero: any match fails. Baselines only go down, as the
// issue that owns each rule removes the pattern.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "guard-baseline.json");

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

const rules = [
  {
    id: "random-values-api",
    owner: "#9",
    description: "Math.random() in API code (values must be measured or missing, never random)",
    files: (p) => p.startsWith("apps/api/src/") && /\.ts$/.test(p) && !isTest(p),
    pattern: /Math\.random\(\)/g,
    // Allowed: retry backoff jitter and identifiers, which are not data shown to users.
    allowLine: (line) => /jitter/i.test(line) || /Math\.random\(\)\.toString\(36\)/.test(line),
  },
  {
    id: "stock-images-web",
    owner: "#10",
    description: "Stock or placeholder image hosts in the web app",
    files: (p) => p.startsWith("apps/web/src/"),
    pattern: /picsum|unsplash/gi,
  },
  {
    id: "tailwind-v3-variable-classes",
    owner: "#18",
    description: "Tailwind v3 `-[--token]` classes, which Tailwind v4 compiles to invalid CSS",
    files: (p) => p.startsWith("apps/web/src/") && /\.(tsx?|css)$/.test(p),
    pattern: /-\[--[\w-]+\]/g,
  },
  {
    id: "hex-colours-outside-tokens",
    owner: "#30",
    description: "Hex colours in web code outside the design tokens",
    files: (p) =>
      p.startsWith("apps/web/src/") &&
      /\.tsx?$/.test(p) &&
      !p.startsWith("apps/web/src/styles/") &&
      !isTest(p),
    pattern: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/g,
  },
  {
    id: "dotenv-outside-config",
    owner: "#5",
    description: "dotenv.config() outside apps/api/src/config (the API loads its env once, first)",
    files: (p) =>
      p.startsWith("apps/api/src/") && /\.ts$/.test(p) && !p.startsWith("apps/api/src/config/"),
    pattern: /dotenv\.config\(/g,
  },
  {
    id: "string-sentinel-tool-results",
    owner: "#11",
    description:
      'Tool results checked by string prefix ("Error…", "No …") instead of typed results',
    files: (p) => p.startsWith("apps/api/src/") && /\.ts$/.test(p) && !isTest(p),
    pattern: /\.startsWith\(\s*["'`](?:Error|No )/g,
  },
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function count(rule, files) {
  let total = 0;
  const locations = [];
  for (const path of files.filter(rule.files)) {
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (rule.allowLine?.(line)) return;
      const matches = line.match(rule.pattern);
      if (matches) {
        total += matches.length;
        locations.push(`${path}:${index + 1}`);
      }
    });
  }
  return { total, locations };
}

const update = process.argv.includes("--update");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const files = trackedFiles();

let failed = false;
const next = { ...baseline };
const rows = [];

for (const rule of rules) {
  if (!(rule.id in baseline)) {
    console.error(`[guard] rule "${rule.id}" has no baseline in scripts/guard-baseline.json`);
    process.exit(1);
  }
  const { total, locations } = count(rule, files);
  const limit = baseline[rule.id];
  let status = "ok";
  if (total > limit) {
    status = "ABOVE BASELINE";
    failed = true;
  } else if (total < limit) {
    status = update ? "lowered" : "below baseline (run with --update)";
    if (update) next[rule.id] = total;
  }
  rows.push({ rule, total, limit, status, locations });
}

for (const id of Object.keys(baseline)) {
  if (!rules.some((rule) => rule.id === id)) {
    console.error(`[guard] baseline entry "${id}" has no rule`);
    process.exit(1);
  }
}

const width = Math.max(...rules.map((rule) => rule.id.length));
for (const { rule, total, limit, status, locations } of rows) {
  console.log(
    `${rule.id.padEnd(width)}  ${String(total).padStart(3)} / ${String(limit).padEnd(3)}  ${status}  (${rule.owner})`,
  );
  if (status === "ABOVE BASELINE") {
    console.log(`  ${rule.description}`);
    for (const location of locations) console.log(`    ${location}`);
  }
}

if (update && !failed) {
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log("[guard] baseline updated");
}

if (failed) {
  console.error(
    "[guard] a count rose above its baseline; remove the new occurrences instead of raising the baseline",
  );
  process.exit(1);
}

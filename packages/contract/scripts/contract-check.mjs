// Fails when the contract changed in a breaking way since a base commit:
//
//   npm run contract:check -- --base HEAD^1
//
// The schemas as built now (dist/) are compared with the snapshots committed at the base, so
// editing or deleting snapshots in a change cannot hide a breaking change. A deliberate
// breaking change is acknowledged by adding its exact line, as this script prints it, to
// packages/contract/BREAKING-CHANGES in the same change; lines already at the base excuse
// nothing new (lines are counted, so the same line can be acknowledged again later).
//
// The comparison itself is code in this change. When that code (ENGINE_FILES) or the CI step
// that runs it differs from the base, the change must also add a line
// `engine changed: <reason>`, so loosening the check is never silent.
//
// Exit codes: 0 compatible, 1 breaking or unacknowledged, 2 the base cannot be read.
//
// Options: --base <ref> (required), --repo <dir> (default: the current directory's
// repository), --path <dir> (the contract package inside it; default packages/contract).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const base = option("base");
if (!base) {
  console.error("usage: contract-check --base <ref> [--repo <dir>] [--path <dir>]");
  process.exit(2);
}
const repo = option("repo") ?? process.cwd();
const path = option("path", "packages/contract");
const git = (...gitArgs) =>
  execFileSync("git", ["-C", repo, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
const fail = (message, error) => {
  console.error(`[contract] ${message}`);
  if (error?.stderr) console.error(String(error.stderr).trim());
  process.exit(2);
};

let root;
try {
  root = git("rev-parse", "--show-toplevel").trim();
  git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
} catch (error) {
  fail(`unknown base "${base}" (with actions/checkout, use fetch-depth: 2)`, error);
}

const ENGINE_FILES = [
  `${path}/src/compat.ts`,
  `${path}/src/snapshot.ts`,
  `${path}/src/refinements.ts`,
  `${path}/src/schemas.ts`,
  `${path}/src/tolerant.ts`,
  `${path}/src/jsonSchema.ts`,
  `${path}/scripts/contract-check.mjs`,
];
const CI_FILE = ".github/workflows/ci.yml";

// Whether the base has snapshots at all: a missing directory means the contract is new there;
// any other git failure is an error, never "no snapshots".
let hasSnapshots = true;
try {
  git("cat-file", "-e", `${base}:${path}/snapshots`);
} catch (probe) {
  try {
    hasSnapshots = git("ls-tree", "--name-only", base, "--", `${path}/snapshots`).trim() !== "";
  } catch (error) {
    fail(`cannot read ${path}/snapshots at ${base}`, error);
  }
  if (hasSnapshots) fail(`cannot read ${path}/snapshots at ${base}`, probe);
}
if (!hasSnapshots) {
  console.log(`[contract] no snapshots at ${base}: nothing to compare`);
  process.exit(0);
}

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const {
  compareSnapshots,
  contractSnapshots,
  engineChangeUnacknowledged,
  ENGINE_ACK_PREFIX,
  snapshotFileName,
  unacknowledgedBreaking,
} = await import(join(dist, "snapshot.js"));

let before;
try {
  const files = git("ls-tree", "--name-only", `${base}:${path}/snapshots`)
    .split("\n")
    .filter((file) => file.endsWith(".schema.json"));
  before = Object.fromEntries(
    files.map((file) => [
      file.replace(/\.schema\.json$/, ""),
      JSON.parse(git("show", `${base}:${path}/snapshots/${file}`)),
    ]),
  );
} catch (error) {
  fail(`cannot read the snapshots at ${base}`, error);
}
const unreadable = Object.entries(before).filter(
  ([, snapshot]) => typeof snapshot?.input !== "object" || typeof snapshot?.output !== "object",
);
if (unreadable.length > 0) {
  fail(
    `snapshots at ${base} are not in the expected format: ${unreadable.map(([n]) => n).join(", ")}`,
  );
}

const showAtBase = (file) => {
  try {
    return git("show", `${base}:${file}`);
  } catch {
    return null; // Not in the base.
  }
};
const readNow = (file) =>
  existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null;

const ackFile = `${path}/BREAKING-CHANGES`;
const ackNow = (readNow(ackFile) ?? "").split("\n");
const ackBase = (showAtBase(ackFile) ?? "").split("\n");

// The comparison's own code, and the CI lines that run it.
const changedEngine = git("diff", "--name-only", base, "--", ...ENGINE_FILES)
  .split("\n")
  .filter(Boolean);
const ciLines = (text) => (text ?? "").split("\n").filter((line) => /contract/i.test(line));
if (ciLines(showAtBase(CI_FILE)).join("\n") !== ciLines(readNow(CI_FILE)).join("\n")) {
  changedEngine.push(`${CI_FILE} (the contract step)`);
}
const engineUnacknowledged = engineChangeUnacknowledged(changedEngine, ackNow, ackBase);

const after = contractSnapshots();
const changes = compareSnapshots(before, after);
const unacknowledged = unacknowledgedBreaking(changes, ackNow, ackBase);

let additive = 0;
for (const [name, { additive: added }] of Object.entries(changes)) {
  additive += added.length;
  for (const change of added) console.log(`[contract] additive: ${name} ${change}`);
}
const acknowledged =
  Object.values(changes).reduce((sum, { breaking }) => sum + breaking.length, 0) -
  unacknowledged.length;
for (const line of unacknowledged) console.error(`[contract] breaking: ${line}`);
if (changedEngine.length > 0) {
  const state = engineUnacknowledged ? "not acknowledged" : "acknowledged";
  console.error(`[contract] the comparison itself changed (${state}): ${changedEngine.join(", ")}`);
  if (engineUnacknowledged) {
    console.error(`[contract] add a line "${ENGINE_ACK_PREFIX} <reason>" to ${ackFile}`);
  }
}
console.log(
  `[contract] ${Object.keys(after).length} schemas against ${base} (${snapshotFileName("*")}): ` +
    `${unacknowledged.length} breaking, ${acknowledged} acknowledged, ${additive} additive`,
);
process.exit(unacknowledged.length === 0 && !engineUnacknowledged ? 0 : 1);

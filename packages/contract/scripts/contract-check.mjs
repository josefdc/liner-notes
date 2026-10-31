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
// The comparison itself is code in this change. When that code (ENGINE_FILES), the CI step
// that runs it or the zod version the contract resolves (package-lock.json) differs from the
// base, the change must also add a line `engine changed: <reason>`, so loosening the check is
// never silent. zod builds the JSON Schemas and holds the internals readerFacts reads: a zod
// release that hid a refinement or an unknown-key policy would otherwise pass as additive.
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
const CI_STEP = "Contract compatibility";

// The lines of every step named CI_STEP in a workflow (null when there is none): from the `-`
// that starts the step to the last line before the next line indented no deeper than that `-`
// (the next step, the end of the job), less trailing blank lines. Comments at that depth belong
// to what follows. There is no YAML library here, so this reads block-style YAML by indentation:
// the name may come first or after other keys, plain or quoted, and lines inside block scalars
// (`run: |`) are content, never steps, even when they start with "-". Flow-style steps
// (`- { name: ... }`) and multi-line names are not read.
function ciStep(text) {
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const indent = (line) => line.length - line.trimStart().length;
  const blank = (line) => line.trim() === "";
  // Lines inside a block scalar: those after a `key: |` or `- |` line (any indicators, then an
  // optional comment) that are blank or deeper than the key, or than that dash.
  const content = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (content.has(i)) continue;
    const scalar =
      /^( *(?:- +)*)(?:"[^"]*"|'[^']*'|[^\s"'#:][^:]*?):[ \t]+[|>][1-9+-]*[ \t]*(?:#.*)?$/.exec(
        lines[i],
      ) ?? /^( *(?:- +)*)-[ \t]+[|>][1-9+-]*[ \t]*(?:#.*)?$/.exec(lines[i]);
    if (!scalar) continue;
    const parent = scalar[1].length;
    for (let j = i + 1; j < lines.length && (blank(lines[j]) || indent(lines[j]) > parent); j++) {
      content.add(j);
    }
  }
  const unquote = (raw) => {
    const value = raw.trim();
    const double = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
    if (double) return double[1].replace(/\\(.)/g, "$1");
    const single = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
    if (single) return single[1].replaceAll("''", "'");
    return value.replace(/\s+#.*$/, "");
  };
  const blocks = [];
  for (let start = 0; start < lines.length; start++) {
    const item = content.has(start) ? null : /^( *)-(?: +(.*))?$/.exec(lines[start]);
    if (!item) continue;
    const dash = item[1].length;
    let end = start + 1;
    while (end < lines.length && (blank(lines[end]) || indent(lines[end]) > dash)) end++;
    while (end > start + 1 && blank(lines[end - 1])) end--;
    // The step's own keys sit where the text after its dash starts, or, when the dash is alone
    // on its line, at the depth of the next line.
    const first = item[2] && !item[2].startsWith("#");
    const nextLine = lines.slice(start + 1, end).find((line) => !blank(line));
    const keys = first ? lines[start].length - item[2].length : indent(nextLine ?? "");
    const named = [first ? item[2] : null, ...lines.slice(start + 1, end)].some((line, offset) => {
      if (line === null || (offset > 0 && (content.has(start + offset) || indent(line) !== keys))) {
        return false;
      }
      const name = /^\s*name:[ \t]+(.*)$/.exec(line);
      return name !== null && unquote(name[1]) === CI_STEP;
    });
    if (named) blocks.push(lines.slice(start, end).join("\n"));
  }
  return blocks.length === 0 ? null : blocks.join("\n\n");
}

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

// The comparison's own code, and the CI step that runs it.
const changedEngine = git("diff", "--name-only", base, "--", ...ENGINE_FILES)
  .split("\n")
  .filter(Boolean);
const stepAtBase = ciStep(showAtBase(CI_FILE));
const stepNow = ciStep(readNow(CI_FILE));
if (stepAtBase !== stepNow) {
  const how = stepAtBase === null ? ", added" : stepNow === null ? ", removed" : "";
  changedEngine.push(`${CI_FILE} (the "${CI_STEP}" step${how})`);
}
// The zod the contract package resolves: its own copy if it has one, else the hoisted one.
const LOCK_FILE = "package-lock.json";
const zodVersion = (lockText) => {
  if (lockText === null) return "none";
  try {
    const packages = JSON.parse(lockText).packages ?? {};
    return (
      (packages[`${path}/node_modules/zod`] ?? packages["node_modules/zod"])?.version ?? "none"
    );
  } catch {
    return "unreadable";
  }
};
const zodAtBase = zodVersion(showAtBase(LOCK_FILE));
const zodNow = zodVersion(readNow(LOCK_FILE));
if (zodAtBase !== zodNow) changedEngine.push(`zod ${zodAtBase} -> ${zodNow} (${LOCK_FILE})`);
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

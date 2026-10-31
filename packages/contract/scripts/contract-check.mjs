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
// base, the change must also add a line `engine changed: <reason>`. zod builds the JSON
// Schemas and holds the internals readerFacts reads: a zod release that hid a refinement or an
// unknown-key policy would otherwise pass as additive.
//
// The CI step is the one named CI_STEP in CI_FILE. What is compared is the lines with YAML
// meaning (not comments or blank lines) of: the workflow outside `jobs:` (on, env, defaults,
// permissions, concurrency, name and the rest), the key of the job that holds the step and
// that job's settings outside `steps:` (if, continue-on-error, strategy, defaults, needs,
// runs-on, env and the rest), and the step's own block. The check fails on every run, whatever
// BREAKING-CHANGES says, when that cannot be read: .github/workflows exists but CI_FILE does
// not, CI_FILE has no step named CI_STEP that this reader can find, or CI_FILE contains a
// character that YAML 1.1 parsers read as a line break (U+0085, U+2028, U+2029), which this
// reader does not. Other jobs and steps are not compared, so some ways to weaken the check
// still pass unnoticed: earlier steps that change what the check reads (a shim on PATH, a write
// to BREAKING-CHANGES, older sources checked out), the root package.json script the step runs,
// and YAML aliases or merge keys whose anchor sits outside the compared lines.
//
// Exit codes: 0 compatible; 1 breaking, unacknowledged, or a CI step that cannot be read (see
// above); 2 the base cannot be read.
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

// The characters other than CR and LF that YAML 1.1 parsers read as line breaks.
const LINE_BREAKS = {
  "\u0085": "NEXT LINE",
  "\u2028": "LINE SEPARATOR",
  "\u2029": "PARAGRAPH SEPARATOR",
};

// What the check compares in a workflow (null when it has no step named CI_STEP under
// jobs.<job>.steps): the workflow's lines outside `jobs:`, then, for each such step, the job's
// key and its lines outside `steps:`, then the step's block, from the `-` that starts it to the
// next structural line indented no deeper than that `-`. Only lines with YAML meaning are
// kept: comments never end a block and are never compared, at any column, and neither are blank
// lines, except inside a multi-line scalar. There is no YAML library here, so this reads
// block-style YAML by indentation: the name may come first or after other keys, plain or
// quoted, and the lines of block scalars (`run: |`) and of quoted scalars that span lines are
// content, never structure or comments, even when they start with "-" or "#". A step written
// in flow style (`- { name: ... }`), with a multi-line or escaped name, or anywhere but under
// jobs.<job>.steps is not read.
function ciStep(text) {
  if (text === null) return null;
  // A lone CR is a line break in YAML too (the other breaks fail the check, see LINE_BREAKS).
  const lines = text.split(/\r\n?|\n/);
  const indent = (line) => line.length - line.trimStart().length;
  const blank = (line) => line.trim() === "";
  const comment = (line) => /^\s*#/.test(line);
  const KEY = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'#:][^:]*?):[ \t]+`;
  const closes = { '"': /^(?:[^"\\]|\\.)*"/, "'": /^(?:[^']|'')*'(?!')/ };
  // Lines inside a scalar that spans lines: after a `key: |` or `- |` line (any indicators, then
  // an optional comment), those that are blank or deeper than the key, or than that dash, less
  // trailing blank lines; after a value that opens a quote and does not close it on its line,
  // every line up to the one that closes it.
  const content = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (content.has(i)) continue;
    const block =
      new RegExp(`^( *(?:- +)*)${KEY}[|>][1-9+-]*[ \\t]*(?:#.*)?$`).exec(lines[i]) ??
      /^( *(?:- +)*)-[ \t]+[|>][1-9+-]*[ \t]*(?:#.*)?$/.exec(lines[i]);
    if (block) {
      const parent = block[1].length;
      let last = i;
      for (let j = i + 1; j < lines.length && (blank(lines[j]) || indent(lines[j]) > parent); j++) {
        if (!blank(lines[j])) last = j;
      }
      for (let j = i + 1; j <= last; j++) content.add(j);
      continue;
    }
    const quoted = new RegExp(`^ *(?:- +)*(?:${KEY})?(["'])(.*)$`).exec(lines[i]);
    if (!quoted || closes[quoted[1]].test(quoted[2])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      content.add(j);
      if (closes[quoted[1]].test(lines[j])) break;
    }
  }
  // Lines that carry structure: not blank, not a comment, not inside a multi-line scalar.
  const structural = (i) => !content.has(i) && !blank(lines[i]) && !comment(lines[i]);
  const meaningful = (i) => structural(i) || content.has(i);
  const item = (i) => (structural(i) ? /^( *)-(?: +(.*))?$/.exec(lines[i]) : null);
  // The end of the node that starts at line `start`, `depth` deep: the next structural line no
  // deeper (a "-" item at that depth continues an indentless sequence when `items`).
  const endOf = (start, depth, items = false) => {
    let end = start + 1;
    while (
      end < lines.length &&
      (!structural(end) ||
        indent(lines[end]) > depth ||
        (items && indent(lines[end]) === depth && item(end)))
    ) {
      end++;
    }
    return end;
  };
  // The meaningful lines in [from, to), less those in [skipFrom, skipTo).
  const keep = (from, to, skipFrom = to, skipTo = to) => {
    const kept = [];
    for (let i = from; i < to; i++) {
      if ((i < skipFrom || i >= skipTo) && meaningful(i)) kept.push(lines[i]);
    }
    return kept;
  };
  // The key line that holds line `at`: the nearest structural line above it that is less deep,
  // or as deep and not an item when `at` is an item (an indentless sequence).
  const parentOf = (at) => {
    for (let i = at - 1; i >= 0; i--) {
      if (!structural(i)) continue;
      if (indent(lines[i]) < indent(lines[at])) return i;
      if (indent(lines[i]) === indent(lines[at]) && item(at) && !item(i)) return i;
    }
    return -1;
  };
  const key = (at, name) => at >= 0 && new RegExp(`^ *${name}:[ \\t]*(?:#.*)?$`).test(lines[at]);
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
    const step = item(start);
    if (!step) continue;
    const dash = step[1].length;
    const end = endOf(start, dash);
    // The step's own keys sit where the text after its dash starts, or, when the dash is alone
    // on its line, at the depth of its next structural line.
    const first = step[2] && !step[2].startsWith("#");
    let next = start + 1;
    while (next < end && !structural(next)) next++;
    const keys = first ? lines[start].length - step[2].length : indent(lines[next] ?? "");
    const own = [];
    if (first) own.push(step[2]);
    for (let i = start + 1; i < end; i++) {
      if (structural(i) && indent(lines[i]) === keys) own.push(lines[i]);
    }
    const named = own.some((line) => {
      const name = /^\s*name:[ \t]+(.*)$/.exec(line);
      return name !== null && unquote(name[1]) === CI_STEP;
    });
    if (!named) continue;
    // Only a step: an item of jobs.<job>.steps.
    const steps = parentOf(start);
    const job = key(steps, "steps") ? parentOf(steps) : -1;
    const jobs = job < 0 ? -1 : parentOf(job);
    if (!key(jobs, "jobs") || indent(lines[jobs]) !== 0) continue;
    if (blocks.length === 0) blocks.push(keep(0, lines.length, jobs, endOf(jobs, 0)).join("\n"));
    const settings = keep(
      job,
      endOf(job, indent(lines[job])),
      steps,
      endOf(steps, indent(lines[steps]), true),
    );
    blocks.push([...settings, ...keep(start, end)].join("\n"));
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
const ciNow = readNow(CI_FILE);
const stepAtBase = ciStep(showAtBase(CI_FILE));
const stepNow = ciStep(ciNow);
if (stepAtBase !== stepNow) {
  const how = stepAtBase === null ? ", added" : stepNow === null ? ", removed" : "";
  changedEngine.push(`${CI_FILE} (the "${CI_STEP}" step${how})`);
}
// A CI step that cannot be read now would compare equal with a base that had the same problem,
// on every later change: fail instead, whatever BREAKING-CHANGES says. A repository without
// .github/workflows (one that does not run the check in CI) has nothing to compare.
const ciUnreadable = [];
if (ciNow === null && existsSync(join(root, dirname(CI_FILE)))) {
  ciUnreadable.push(`${dirname(CI_FILE)} exists but ${CI_FILE} does not`);
}
if (ciNow !== null && stepNow === null) {
  ciUnreadable.push(`${CI_FILE}: no step named "${CI_STEP}" could be found under jobs.<job>.steps`);
}
for (const [character, name] of Object.entries(LINE_BREAKS)) {
  const at = (ciNow ?? "").split(/\r\n?|\n/).findIndex((line) => line.includes(character));
  if (at === -1) continue;
  const code = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  ciUnreadable.push(
    `${CI_FILE}:${at + 1} contains U+${code} (${name}), which YAML 1.1 parsers read as a line break`,
  );
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
for (const problem of ciUnreadable) {
  console.error(
    `[contract] ${problem}, so the step that runs this check cannot be compared ` +
      `(an "${ENGINE_ACK_PREFIX}" line does not excuse this)`,
  );
}
console.log(
  `[contract] ${Object.keys(after).length} schemas against ${base} (${snapshotFileName("*")}): ` +
    `${unacknowledged.length} breaking, ${acknowledged} acknowledged, ${additive} additive`,
);
const passed = unacknowledged.length === 0 && !engineUnacknowledged && ciUnreadable.length === 0;
process.exit(passed ? 0 : 1);

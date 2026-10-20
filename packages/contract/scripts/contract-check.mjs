// Fails when the contract changed in a breaking way since a base commit:
//
//   npm run contract:check -- --base HEAD^1
//
// The schemas as built now (dist/) are compared with the snapshots committed at the base, so
// editing or deleting snapshots in a change cannot hide a breaking change. A deliberate
// breaking change is acknowledged by adding its exact line, as this script prints it, to
// packages/contract/BREAKING-CHANGES in the same change; lines already at the base excuse
// nothing new.
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
const git = (...gitArgs) =>
  execFileSync("git", ["-C", repo, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
const repo = option("repo") ?? process.cwd();
const root = git("rev-parse", "--show-toplevel").trim();
try {
  git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
} catch {
  console.error(`[contract] unknown base "${base}" (with actions/checkout, use fetch-depth: 2)`);
  process.exit(2);
}
const path = option("path", "packages/contract");

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { compareSnapshots, contractSnapshots, snapshotFileName, unacknowledgedBreaking } =
  await import(join(dist, "snapshot.js"));

let files = [];
try {
  files = git("ls-tree", "--name-only", `${base}:${path}/snapshots`)
    .split("\n")
    .filter((file) => file.endsWith(".schema.json"));
} catch {
  // The base has no snapshots directory.
}
if (files.length === 0) {
  console.log(`[contract] no snapshots at ${base}: nothing to compare`);
  process.exit(0);
}
const before = Object.fromEntries(
  files.map((file) => [
    file.replace(/\.schema\.json$/, ""),
    JSON.parse(git("show", `${base}:${path}/snapshots/${file}`)),
  ]),
);
const unreadable = Object.entries(before).filter(
  ([, snapshot]) => typeof snapshot?.input !== "object" || typeof snapshot?.output !== "object",
);
if (unreadable.length > 0) {
  console.error(`[contract] snapshots at ${base} are not in the expected format:`);
  for (const [name] of unreadable) console.error(`  ${name}`);
  process.exit(2);
}
const after = contractSnapshots();
const changes = compareSnapshots(before, after);

const ackFile = `${path}/BREAKING-CHANGES`;
const ackNow = existsSync(join(root, ackFile)) ? readFileSync(join(root, ackFile), "utf8") : "";
let ackBase = "";
try {
  ackBase = git("show", `${base}:${ackFile}`);
} catch {
  // No acknowledgement file at the base.
}
const unacknowledged = unacknowledgedBreaking(changes, ackNow.split("\n"), ackBase.split("\n"));

let additive = 0;
for (const [name, { additive: added }] of Object.entries(changes)) {
  additive += added.length;
  for (const change of added) console.log(`[contract] additive: ${name} ${change}`);
}
const acknowledged =
  Object.values(changes).reduce((sum, { breaking }) => sum + breaking.length, 0) -
  unacknowledged.length;
for (const line of unacknowledged) console.error(`[contract] breaking: ${line}`);
console.log(
  `[contract] ${Object.keys(after).length} schemas against ${base} (${snapshotFileName("*")}): ` +
    `${unacknowledged.length} breaking, ${acknowledged} acknowledged, ${additive} additive`,
);
process.exit(unacknowledged.length === 0 ? 0 : 1);

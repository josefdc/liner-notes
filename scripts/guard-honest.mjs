#!/usr/bin/env node
// Honesty guard: counts patterns that put invented or placeholder data in front of users
// (or that hide where data comes from) and fails when any count rises above its baseline.
//
//   npm run guard:honest                     check against scripts/guard-baseline.json
//   npm run guard:honest -- --update          lower baselines to the current counts
//   npm run guard:honest -- --base <git-ref>  also fail if a baseline is higher than at <git-ref>
//
// Baselines only go down: a count above its baseline fails, and so does a count below it until
// the baseline is lowered in the same change (--update), so removed occurrences cannot be added
// back later. A rule whose baseline is 0 is a hard zero.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts", "guard-baseline.json");

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
const isScript = (path) => /\.[cm]?[jt]sx?$/.test(path);
// Test helpers and fixtures that live next to the source (e.g. apps/api/src/sources/testing/).
const isTestSupport = (path) =>
  isTest(path) || /(?:^|\/)(?:tests?|__tests__|__mocks__|testing|fixtures)\//.test(path);

// An occurrence that is not user-facing data (e.g. retry jitter) is allowed only with a marker
// on the same line naming the rule and a reason: `// guard-allow: <rule-id> — <reason>`.
// Each marker allows exactly one match on its line.
const allowMarker = (line, id) => new RegExp(`guard-allow:\\s*${id}\\s*[—-]\\s*\\S`).test(line);

const scriptKind = (path) => {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
};

const STRING_TOKENS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

// The comment and string-literal spans of a script, read with the TypeScript parser, so that
// `//` inside a string or in JSX text is not taken for a comment, and comments spanning several
// lines (JSX `{/* … */}` included) are found. Every comment lies in the trivia before a token.
function scriptSpans(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const comments = [];
  const strings = [];
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return; // JSDoc is a comment, found as the trivia of the token that follows it
    }
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (STRING_TOKENS.has(node.kind)) strings.push([node.getStart(source), node.end]);
    // A token's trivia (from its pos to its start) holds only whitespace and comments. JSX text
    // has none: a `//` in it is text shown to the user.
    if (node.kind !== ts.SyntaxKind.JsxText) comments.push([node.pos, node.getStart(source)]);
  };
  visit(source);
  return { comments, strings };
}

// Blanks (keep: false) or keeps only (keep: true) the given spans; line breaks always stay, so
// line numbers do not move.
function mask(text, spans, keep) {
  const inSpan = new Uint8Array(text.length);
  for (const [start, end] of spans) inSpan.fill(1, start, end);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    out += char === "\n" || char === "\r" || Boolean(inSpan[i]) === keep ? char : " ";
  }
  return out;
}

const blockComments = (text, pattern) =>
  [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);

// Text with its comments blanked: script comments (line, block and JSX `{/* … */}`), CSS
// `/* … */` and HTML `<!-- … -->` comments. Other files are scanned as they are.
function withoutComments(text, path) {
  if (isScript(path)) return mask(text, scriptSpans(text, path).comments, false);
  if (/\.css$/.test(path)) return mask(text, blockComments(text, /\/\*[\s\S]*?\*\//g), false);
  if (/\.html?$/.test(path)) return mask(text, blockComments(text, /<!--[\s\S]*?-->/g), false);
  return text;
}

// Only the contents of string and template literals (including their quotes); everything else,
// comments and JSX text included, is blanked.
const stringsOnly = (text, path) =>
  isScript(path) ? mask(text, scriptSpans(text, path).strings, true) : "";

// Phrases of the prototype's theatrical copy and its old product name. Counted wherever they
// appear outside comments, prompts and log lines included. Identifiers (`SonicAgentState`,
// `decryptMoreFactoidsStream`, `DECRYPT_COUNT`), the `sonic-agent.db` file name and the
// lowercase route path `/api/factoids/decrypt` (renamed by #31) are not copy and do not match.
const PROTOTYPE_PHRASES_EXACT_CASE = [
  "AGENT_ID",
  "X9-ALPHA",
  "STATUS: ONLINE",
  "ANALYZE_SONG",
  "DEEP_DIVE_MODE",
  "BACK TO BASE",
  "D3\\.JS FORCE SIMULATION",
  "INTERACTIVE: ENABLED",
  "\\bINTEL\\b",
  "RELATED ARTIFACTS",
  "LOGIC:",
  "NO CONNECTIONS MAPPED",
  "CLICK TO (?:ANALYZE|EXPLORE)",
  "Agent Analysis",
  "Frequency analysis:",
  "\\b(?:DECRYPT(?:ING|ED)?|Decrypt(?:ing|ed)?)\\b",
];
const PROTOTYPE_PHRASES_ANY_CASE = [
  "Sonic Agent",
  "sonic-agent://",
  "Command Center",
  "Cross-referencing visual artifacts",
  "Intelligence extraction",
  "intelligence already extracted",
  "intelligence briefing",
  "deep-web research protocols",
  "\\bdeep dive\\b",
  "Target acquired",
  "Establishing connection to",
  "waveform parser",
  "insights decoded",
  "\\buplink\\b",
  "\\b(?:audio|musical|sample|its) DNA\\b",
  "Signal lost",
  "Unexpected interference",
];
const PROTOTYPE_COPY = new RegExp(
  `${PROTOTYPE_PHRASES_EXACT_CASE.join("|")}|(?i:${PROTOTYPE_PHRASES_ANY_CASE.join("|")})`,
  "g",
);

// Each rule counts `pattern` per line in the files `files` selects. With `stripComments` comments
// are blanked first; with `stringsOnly` only string and template literals are scanned.
export const rules = [
  {
    id: "random-values-api",
    owner: "#9",
    description: "Math.random in API code (values must be measured or missing, never random)",
    files: (p) => p.startsWith("apps/api/src/") && isScript(p) && !isTest(p),
    pattern:
      /\bMath\s*\??\.\s*random\b|\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b|\b(?:randomInt|getRandomValues|randomBytes)\s*\(/g,
  },
  {
    id: "stock-images-web",
    owner: "#10",
    description: "Stock or placeholder image hosts in the web app",
    files: (p) => p.startsWith("apps/web/src/") || p === "apps/web/index.html",
    pattern: /picsum|unsplash/gi,
  },
  {
    id: "tailwind-v3-variable-classes",
    owner: "#18",
    description: "Tailwind v3 `-[--token]` classes, which Tailwind v4 compiles to invalid CSS",
    files: (p) => p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p),
    pattern: /-\[--[\w-]+\]/g,
  },
  {
    id: "hex-colours-outside-tokens",
    owner: "#30",
    description:
      "Hex colours in web code outside the design tokens (styles/index.css, styles/theme.ts)",
    files: (p) =>
      ((p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p)) ||
        p === "apps/web/index.html") &&
      p !== "apps/web/src/styles/index.css" &&
      p !== "apps/web/src/styles/theme.ts" &&
      !isTest(p),
    pattern: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g,
    stripComments: true,
  },
  {
    id: "dotenv-outside-config",
    owner: "#5",
    description: "dotenv.config() outside apps/api/src/config (the API loads its env once, first)",
    files: (p) =>
      p.startsWith("apps/api/src/") && isScript(p) && !p.startsWith("apps/api/src/config/"),
    pattern:
      /dotenv\.config\(|["']dotenv\/config["']|import\s*\{[^}]*\bconfig\b[^}]*\}\s*from\s*["']dotenv["']/g,
  },
  {
    id: "string-sentinel-tool-results",
    owner: "#11",
    description: 'Tool results checked by their text ("Error…", "No …") instead of typed results',
    files: (p) => p.startsWith("apps/api/src/") && isScript(p) && !isTest(p),
    pattern:
      /\.(?:startsWith|includes)\(\s*["'`](?:Error|No )|===?\s*["'`](?:Error|No )|\/\^(?:Error|No )/g,
  },
  {
    id: "prototype-copy",
    owner: "#32, #34, #35",
    description:
      'The prototype\'s theatrical copy and old product name ("The Sonic Agent", "Command Center", "[ DECRYPT MORE ]", "Target acquired"…)',
    files: (p) =>
      (((p.startsWith("apps/web/src/") || p.startsWith("apps/api/src/")) && isScript(p)) ||
        p === "apps/web/index.html") &&
      !isTestSupport(p),
    pattern: PROTOTYPE_COPY,
    stripComments: true,
  },
  {
    id: "emoji-in-progress",
    owner: "#34",
    description:
      "Emoji in progress and log messages: string literals in API source and in the web's agent hooks, which write the activity-log lines",
    files: (p) =>
      (p.startsWith("apps/api/src/") || p.startsWith("apps/web/src/hooks/")) &&
      isScript(p) &&
      !isTestSupport(p),
    pattern: /\p{RGI_Emoji}/gv,
    stringsOnly: true,
  },
];

function sourceFiles() {
  const list = (args) =>
    execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  // Tracked files plus new files not yet added, so a local run sees what CI will see.
  return [...new Set([...list([]), ...list(["--others", "--exclude-standard"])])];
}

// Counts the matches of one rule in a file's text; returns the total and the matching lines.
// `path` decides how comments and strings are read (a script by its extension, CSS or HTML).
export function countInText(rule, text, path) {
  let scannedText = text;
  if (rule.stringsOnly) scannedText = stringsOnly(text, path);
  else if (rule.stripComments) scannedText = withoutComments(text, path);
  const scannedLines = scannedText.split("\n");
  let total = 0;
  const lines = [];
  text.split("\n").forEach((line, index) => {
    const scanned = scannedLines[index] ?? "";
    const matches = scanned.match(rule.pattern)?.length ?? 0;
    const allowed = matches > 0 && allowMarker(line, rule.id) ? 1 : 0;
    if (matches - allowed > 0) {
      total += matches - allowed;
      lines.push(index + 1);
    }
  });
  return { total, lines };
}

function count(rule, files) {
  let total = 0;
  const locations = [];
  for (const path of files.filter(rule.files)) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    const result = countInText(rule, text, path);
    total += result.total;
    for (const line of result.lines) locations.push(`${path}:${line}`);
  }
  return { total, locations };
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const baseRef = args.includes("--base") ? args[args.indexOf("--base") + 1] : null;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  // A change may lower baselines but never raise them, including in its own diff.
  if (baseRef) {
    let previous = null;
    try {
      previous = JSON.parse(
        execFileSync("git", ["show", `${baseRef}:scripts/guard-baseline.json`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      console.log(`[guard] no baseline at ${baseRef}; skipping the comparison`);
    }
    const raised = Object.entries(baseline).filter(
      ([id, value]) => previous && id in previous && value > previous[id],
    );
    for (const [id, value] of raised) {
      console.error(`[guard] baseline for "${id}" was raised from ${previous[id]} to ${value}`);
    }
    if (raised.length > 0) process.exit(1);
  }
  const files = sourceFiles();

  let failed = false;
  const next = { ...baseline };
  const rows = [];

  for (const rule of rules) {
    if (!(rule.id in baseline)) {
      console.error(`[guard] rule "${rule.id}" has no baseline in scripts/guard-baseline.json`);
      process.exit(1);
    }
    const limit = baseline[rule.id];
    if (!Number.isInteger(limit) || limit < 0) {
      console.error(
        `[guard] baseline for "${rule.id}" must be a non-negative integer, got ${JSON.stringify(limit)}`,
      );
      process.exit(1);
    }
    const { total, locations } = count(rule, files);
    let status = "ok";
    if (total > limit) {
      status = "ABOVE BASELINE";
      failed = true;
    } else if (total < limit) {
      if (update) {
        status = "lowered";
        next[rule.id] = total;
      } else {
        status = "BELOW BASELINE";
        failed = true;
      }
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

  if (update && !rows.some((row) => row.status === "ABOVE BASELINE")) {
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log("[guard] baseline updated");
  }

  if (failed) {
    if (rows.some((row) => row.status === "ABOVE BASELINE")) {
      console.error(
        "[guard] a count rose above its baseline; remove the new occurrences instead of raising the baseline",
      );
    }
    if (rows.some((row) => row.status === "BELOW BASELINE")) {
      console.error(
        "[guard] a count fell below its baseline; lower it in this change: npm run guard:honest -- --update",
      );
    }
    process.exit(1);
  }
}

// Runs only when executed directly (import.meta.main also holds through symlinked paths).
if (import.meta.main) main();

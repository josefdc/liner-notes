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
const isRecording = (path) => /^fixtures\/replays\/[^/]+\.json$/.test(path);

// An occurrence that is not user-facing data (e.g. retry jitter) is allowed only with a marker
// on the same line naming the rule and a reason: `// guard-allow: <rule-id> — <reason>`.
// Each marker allows exactly one match on its line.
// The rule name must match exactly: a marker for `prototype-copy-recordings` does not allow a
// `prototype-copy` match.
const allowMarker = (line, id) =>
  new RegExp(`guard-allow:\\s*${id}(?![\\w-])\\s*[—-]\\s*\\S`).test(line);

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

// A string that names a module (`import … from "./x"`, `export … from`, `import("./x")`,
// `import x = require("./x")`, `import("./x").T`) is a path, not text.
const isModuleSpecifier = (parent, grandparent) =>
  ts.isImportDeclaration(parent) ||
  ts.isExportDeclaration(parent) ||
  ts.isExternalModuleReference(parent) ||
  (ts.isLiteralTypeNode(parent) && grandparent && ts.isImportTypeNode(grandparent)) ||
  (grandparent &&
    ts.isCallExpression(grandparent) &&
    grandparent.expression.kind === ts.SyntaxKind.ImportKeyword);

// The comment, string-literal and JSX-text spans of a script, read with the TypeScript parser, so
// that `//` inside a string or in JSX text is not taken for a comment, and comments spanning
// several lines (JSX `{/* … */}` included) are found. Every comment lies in the trivia before a
// token. Module specifiers and whitespace-only strings (`{' '}` in JSX) are not text.
function scriptSpans(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const comments = [];
  const strings = [];
  const jsxText = [];
  const visit = (node, parent, grandparent) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return; // JSDoc is a comment, found as the trivia of the token that follows it
    }
    const children = node.getChildren(source);
    if (children.length > 0) {
      for (const child of children) visit(child, node, parent);
      return;
    }
    const start = node.getStart(source);
    if (
      STRING_TOKENS.has(node.kind) &&
      !isModuleSpecifier(parent, grandparent) &&
      !/^(['"])\s*\1$/.test(text.slice(start, node.end))
    ) {
      strings.push([start, node.end]);
    }
    // A token's trivia (from its pos to its start) holds only whitespace and comments. JSX text
    // has none: a `//` in it is text shown to the user.
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    else comments.push([node.pos, start]);
  };
  visit(source);
  return { comments, strings, jsxText };
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

const spansOf = (text, pattern) =>
  [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

// Every string value of a JSON text with its path and span (quotes included). The text is
// parsed first, so a malformed file throws instead of being half read.
function jsonStrings(text) {
  JSON.parse(text);
  const found = [];
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return { start, end: i, value: JSON.parse(text.slice(start, i)) };
  };
  const value = (path) => {
    space();
    if (text[i] === '"') {
      const { start, end, value: string_ } = string();
      found.push({ path, start, end, value: string_ });
    } else if (text[i] === "{" || text[i] === "[") {
      const object = text[i++] === "{";
      for (let index = 0; ; index++) {
        space();
        if (text[i] === "}" || text[i] === "]") break;
        let key = index;
        if (object) {
          key = string().value;
          space();
          i++; // the colon
        }
        value([...path, key]);
        space();
        if (text[i] === ",") i++;
      }
      i++;
    } else {
      const literal = /-?[\d.eE+-]+|true|false|null/y;
      literal.lastIndex = i;
      i += literal.exec(text)[0].length;
    }
  };
  value([]);
  return found;
}

// In a recorded run (fixtures/replays/*.json), the text the app wrote into its events: the
// `message` of status and interrupt events and the `error` of error events. The result itself
// (claims, factoids, analysis) and every other model answer are not scanned: a recording keeps
// what the model said, and must never be edited to bring a count down. The planner's status
// lines (`🔍 <reasoning>`, `✅ <reasoning>`, node `research_manager`) are model text after the
// app's leading emoji, so only that emoji is scanned.
const PLANNER_LINE = /^(?:🔍|✅) (?!Deep dive complete$)/u;
function recordedMessageSpans(text) {
  const run = JSON.parse(text);
  const spans = [];
  for (const { path, start, end, value } of jsonStrings(text)) {
    const [events, index, key, field] = path;
    if (events !== "events" || key !== "event" || path.length !== 4) continue;
    const event = run.events[index].event;
    const written =
      ((event.type === "status" || event.type === "interrupt") && field === "message") ||
      (event.type === "error" && field === "error");
    if (!written) continue;
    if (event.type === "status" && event.node === "research_manager" && PLANNER_LINE.test(value)) {
      spans.push([start + 1, start + 1 + value.indexOf(" ")]);
    } else {
      spans.push([start, end]);
    }
  }
  return spans;
}

// What a rule scans in a file (`rule.scan`); everything else is blanked:
//   (none)    the text as it is
//   "code"    comments blanked: script comments (line, block, JSX `{/* … */}`), CSS `/* … */`
//             and HTML `<!-- … -->`
//   "strings" string and template literals of a script
//   "copy"    text in source: a script's strings and JSX text, or an HTML page without its
//             comments, scripts and styles
//   "messages" the messages the app wrote into a recorded run (see recordedMessageSpans)
export function scannedText(rule, text, path) {
  if (!rule.scan) return text;
  const html = /\.html?$/.test(path);
  if (rule.scan === "code") {
    if (isScript(path)) return mask(text, scriptSpans(text, path).comments, false);
    if (/\.css$/.test(path)) return mask(text, spansOf(text, /\/\*[\s\S]*?\*\//g), false);
    if (html) return mask(text, spansOf(text, HTML_COMMENT), false);
    return text;
  }
  if (rule.scan === "messages") return mask(text, recordedMessageSpans(text), true);
  if (rule.scan === "copy" && html) {
    const hidden = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/gi;
    return mask(text, spansOf(text, hidden), false);
  }
  if (!isScript(path)) return "";
  const spans = scriptSpans(text, path);
  return mask(
    text,
    rule.scan === "copy" ? [...spans.strings, ...spans.jsxText] : spans.strings,
    true,
  );
}

// Phrases of the prototype's theatrical copy and its old product name, matched in text a user
// can read (string literals, JSX text, the HTML page, recorded messages); code, comments and
// module paths are not scanned. A space in a phrase matches any run of whitespace, a non-breaking
// space or `&nbsp;`, so a phrase the formatter wraps over two lines still counts. Copy built from
// parts (`'Sonic ' + 'Agent'`) is out of reach of a pattern.
export const PROTOTYPE_PHRASES = {
  anyCase: [
    // The old name in any spelling; not the `sonic-agent.db` file name.
    "Sonic(?:[-_]| )?Agent(?!\\.db\\b)",
    "Command Center",
    "\\bAGENT_ID\\b",
    "X9-ALPHA",
    "STATUS: ONLINE",
    "\\b(?:ANALYZE_SONG|DEEP_DIVE_MODE|PROCESSING_DATA_STREAM)\\b",
    "BACK TO BASE",
    "D3\\.JS FORCE SIMULATION",
    "INTERACTIVE: ENABLED",
    "\\bINTEL\\b",
    "RELATED ARTIFACTS",
    "NO CONNECTIONS MAPPED",
    "\\bCLICK (?:NODE )?TO (?:ANALYZE|EXPLORE)\\b",
    "\\bEVENTS RECORDED\\b",
    "\\bAWAITING DATA\\b",
    "\\bPROCESS COMPLETE\\b",
    "No signal detected",
    "Ready for deployment",
    "\\bAgent Analysis\\b",
    "\\bFrequency analysis:",
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
  ],
  exactCase: [
    // Capitalised or upper case only: the lowercase route `/api/factoids/decrypt` (renamed by
    // #31) is a path, not copy.
    "\\b(?:DECRYPT(?:ING|ED)?|Decrypt(?:ing|ed)?)\\b",
    // Upper case only: `logic:` is an ordinary key or word.
    "\\bLOGIC:",
    // Console status lights in capitals: "● IDLE", "◉ ACTIVE", "● ONLINE", "◉ BUSY" (not a
    // legend such as "● Measured").
    "[●◉](?:\\s|&nbsp;)*[A-Z]{3,}\\b",
    // Console tags in brackets: "[ COMPLETE ]", "[ ACTIVE ]", "[ DECRYPT MORE ]".
    "\\[\\s+[A-Z]+(?:\\s+[A-Z]+)*\\s+\\]",
  ],
};
const SPACE = "(?:\\s|&nbsp;|&#160;|\\\\u00a0|\\\\xa0)+";
const phrase = (source) => source.replaceAll(" ", SPACE);
// Two expressions rather than one with a `(?i:…)` group: Node 24 drops matches of such a group
// once it holds many alternatives (`agent_id` is missed by the full list, found by a short one).
export const PROTOTYPE_COPY = [
  new RegExp(PROTOTYPE_PHRASES.anyCase.map(phrase).join("|"), "gi"),
  new RegExp(PROTOTYPE_PHRASES.exactCase.map(phrase).join("|"), "g"),
];
const EMOJI = /\p{RGI_Emoji}/gv;

// Each rule counts the matches of `pattern` (one expression or several) in the files `files`
// selects, in the part of each file that `scan` names (see scannedText). A match is reported on
// the line where it starts.
export const rules = [
  {
    id: "random-values-api",
    owner: "#9",
    description: "Math.random in API code (values must be measured or missing, never random)",
    files: (p) => p.startsWith("apps/api/src/") && isScript(p) && !isTest(p),
    pattern:
      /\bMath\s*\??\.\s*random\b|\{[^{}]*\brandom\b[^{}]*\}\s*=\s*Math\b|\b(?:randomInt|getRandomValues|randomBytes)\s*\(/g,
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
      "Hex colours in web code outside the design tokens (styles/tokens.css, styles/theme.ts)",
    files: (p) =>
      ((p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p)) ||
        p === "apps/web/index.html") &&
      p !== "apps/web/src/styles/tokens.css" &&
      p !== "apps/web/src/styles/theme.ts" &&
      !isTest(p),
    pattern: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g,
    scan: "code",
  },
  {
    id: "colour-literals-design-system",
    owner: "#30",
    description:
      "Colour literals (hex, rgb(), hsl()) in web source outside the design tokens (styles/tokens.css, styles/theme.ts)",
    files: (p) =>
      p.startsWith("apps/web/src/") &&
      /\.([cm]?[jt]sx?|css)$/.test(p) &&
      p !== "apps/web/src/styles/tokens.css" &&
      p !== "apps/web/src/styles/theme.ts" &&
      !isTestSupport(p),
    pattern: [
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g,
      // Not `\b`: in a Tailwind arbitrary value the colour follows a `_` (`_rgba(0,0,0,0.5)`).
      /(?<![A-Za-z0-9$])(?:rgba?|hsla?)\(/gi,
    ],
    scan: "code",
  },
  {
    id: "gray-palette-utilities",
    owner: "#30",
    description:
      "Classes on Tailwind's gray scale (text-gray-400, hover:border-gray-600/50) in web source: use the surface, border and text tokens",
    files: (p) =>
      p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p) && !isTestSupport(p),
    // A utility's name ends in `-gray-<step>`, with an optional opacity; a variant (`hover:`,
    // `group-hover/item:`) may come before it. A custom property (`var(--color-gray-700)`) is
    // not a class: a match never starts right after a `-`.
    pattern: /(?<![\w-])(?:[a-z]+-)+gray-(?:50|[1-9]00|950)(?:\/(?:\d+|\[[^\]\s]+\]))?(?![\w-])/g,
    scan: "code",
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
    scan: "copy",
  },
  {
    id: "emoji-in-progress",
    owner: "#34",
    description:
      "Emoji in progress, log and status messages: string literals in API and web source",
    files: (p) =>
      (p.startsWith("apps/api/src/") || p.startsWith("apps/web/src/")) &&
      isScript(p) &&
      !isTestSupport(p),
    pattern: EMOJI,
    scan: "strings",
  },
  {
    id: "prototype-copy-recordings",
    owner: "#33",
    description:
      "The prototype's copy in the messages the app wrote into the recorded runs (fixtures/replays)",
    files: isRecording,
    pattern: PROTOTYPE_COPY,
    scan: "messages",
  },
  {
    id: "emoji-in-recordings",
    owner: "#33",
    description: "Emoji in the messages the app wrote into the recorded runs (fixtures/replays)",
    files: isRecording,
    pattern: EMOJI,
    scan: "messages",
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

// Counts the matches of one rule in a file's text. Matches are found in the whole scanned text,
// so one can span lines, and each is reported on the line where it starts. Returns the total,
// the matching lines and the matches as { line, text }. `path` decides how the file is read.
export function countInText(rule, text, path) {
  const scanned = scannedText(rule, text, path);
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  // A rule may have several patterns; where two matches overlap, the first one counts.
  const found = [rule.pattern]
    .flat()
    .flatMap((pattern) => [...scanned.matchAll(pattern)])
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  const byLine = new Map();
  let end = 0;
  for (const match of found) {
    if (match.index < end) continue;
    end = match.index + match[0].length;
    const line = lineOf(match.index);
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(match[0].replace(/\s+/g, " ").trim());
  }
  const original = text.split("\n");
  let total = 0;
  const lines = [];
  const matches = [];
  for (const [line, found] of byLine) {
    const kept = allowMarker(original[line - 1], rule.id) ? found.slice(1) : found;
    if (kept.length === 0) continue;
    total += kept.length;
    lines.push(line);
    for (const match of kept) matches.push({ line, text: match });
  }
  return { total, lines, matches };
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
    for (const { line, text: match } of result.matches) locations.push({ path, line, match });
  }
  return { total, locations };
}

// Marks the locations that are new against <base>: a match counts as new when its file holds
// more matches of the same text than the same file at <base>. Line numbers may move, so the
// comparison is by file and matched text.
function markNew(rule, locations, baseRef) {
  const before = new Map();
  for (const path of new Set(locations.map((location) => location.path))) {
    let text = "";
    try {
      text = execFileSync("git", ["show", `${baseRef}:${path}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      // a file added since <base>: every match in it is new
    }
    for (const { text: match } of countInText(rule, text, path).matches) {
      const key = `${path}\0${match}`;
      before.set(key, (before.get(key) ?? 0) + 1);
    }
  }
  return locations.map((location) => {
    const key = `${location.path}\0${location.match}`;
    const left = before.get(key) ?? 0;
    if (left > 0) before.set(key, left - 1);
    return { ...location, isNew: left === 0 };
  });
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
      const marked = baseRef ? markNew(rule, locations, baseRef) : locations;
      if (baseRef) console.log(`  (+ = not at ${baseRef})`);
      for (const { path, line, match, isNew } of marked) {
        console.log(`  ${isNew ? "+" : " "} ${path}:${line}  ${match}`);
      }
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

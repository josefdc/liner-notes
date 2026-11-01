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
// Modules next to the source that only tests import (guard-honest.test.mjs checks that no other
// file imports them).
export const TEST_HELPERS = new Set([
  "apps/web/src/components/genealogy/testing.ts",
  "apps/web/src/components/measured/testing.ts",
  "apps/web/src/components/provenance/testing.ts",
]);
// Test helpers and fixtures that live next to the source (e.g. apps/api/src/sources/testing/).
const isTestSupport = (path) =>
  isTest(path) ||
  /(?:^|\/)(?:tests?|__tests__|__mocks__|testing|fixtures)\//.test(path) ||
  TEST_HELPERS.has(path);
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

// JSX attributes whose value is words for people, not code: a colour name there is prose.
const PROSE_ATTRIBUTE = /^(?:aria-[\w-]+|title|alt|placeholder|label)$/;

// The comment, string-literal and JSX-text spans of a script, read with the TypeScript parser, so
// that `//` inside a string or in JSX text is not taken for a comment, and comments spanning
// several lines (JSX `{/* … */}` included) are found. Every comment lies in the trivia before a
// token. Module specifiers and whitespace-only strings (`{' '}` in JSX) are not text.
function scriptSpans(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const comments = [];
  const strings = [];
  const jsxText = [];
  const proseAttributes = [];
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
      // The value of a JSX attribute that holds words for people (aria-label, title, alt…).
      const attribute =
        parent && ts.isJsxAttribute(parent)
          ? parent
          : parent && ts.isJsxExpression(parent) && grandparent && ts.isJsxAttribute(grandparent)
            ? grandparent
            : null;
      if (attribute && PROSE_ATTRIBUTE.test(attribute.name.getText(source))) {
        proseAttributes.push([start, node.end]);
      }
    }
    // A token's trivia (from its pos to its start) holds only whitespace and comments. JSX text
    // has none: a `//` in it is text shown to the user.
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    else comments.push([node.pos, start]);
  };
  visit(source);
  return { comments, strings, jsxText, proseAttributes };
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
// what the model said, and must never be edited to bring a count down.
//
// The planner (node `research_manager`) sends only its own lines, and they are scanned in full.
// Older runs also sent its reasoning, model text after the app's leading emoji (`🔍 <reasoning>`,
// `✅ <reasoning>`): of those lines only that emoji is scanned.
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
//   "code-not-jsx-text"  as "code", and a script's words for people blanked too: JSX text and
//             the values of prose attributes (aria-label, title, alt, placeholder, label)
//   "strings" string and template literals of a script
//   "copy"    text in source: a script's strings and JSX text, or an HTML page without its
//             comments, scripts and styles
//   "messages" the messages the app wrote into a recorded run (see recordedMessageSpans)
export function scannedText(rule, text, path) {
  if (!rule.scan) return text;
  const html = /\.html?$/.test(path);
  if (rule.scan === "code" || rule.scan === "code-not-jsx-text") {
    if (isScript(path)) {
      const spans = scriptSpans(text, path);
      const hidden =
        rule.scan === "code"
          ? spans.comments
          : [...spans.comments, ...spans.jsxText, ...spans.proseAttributes];
      return mask(text, hidden, false);
    }
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
    // Capitalised or upper case only: a lowercase `decrypt` (the factoid routes' path before
    // #31 renamed them) is a path, not copy.
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

// Colour literals. Web source draws with the tokens: a class (bg-cyber, text-text-tertiary/60),
// a var(--color-*) in an arbitrary value, or a styles/theme.ts value in D3 and Recharts.
//
// - A hex colour: not an id or an anchor (`url(#fade)`, `href="#add"`), not a word that only looks
//   like one (`page#fade`, `&#160;`), not an issue number in text (`see #123`), not a selector
//   (`#abc {`).
// - A colour function: rgb(), hsl(), hwb(), lab(), lch(), oklab(), oklch(), color(); color-mix()
//   of tokens is allowed.
// - A CSS named colour used as a colour: a JSX attribute or style property (fill="black",
//   color: 'red'), a D3 attribute or style (.attr('fill', 'white')), a stylesheet declaration
//   (color: red), or a Tailwind arbitrary value (bg-[red], shadow-[0_0_4px_white]).
//   transparent, currentColor and inherit are not colours of their own.
export const CSS_NAMED_COLOURS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];
const NAMED = `(?:${CSS_NAMED_COLOURS.join("|")})`;
// A property that takes a colour, in JSX or CSS spelling (fill, stroke, background, *color), or
// a shorthand with a colour in it (border, outline, a shadow).
const COLOUR_PROPERTY =
  "(?:fill|stroke|background|background-color|[A-Za-z-]*[cC]olor|border(?:-[a-z]+)*|border(?:[A-Z][a-z]+)*|outline|box-shadow|boxShadow|text-shadow|textShadow)";
// A named colour as one word of a value, not part of a name (`--color-white`, `colors.white`).
const NAMED_WORD = `(?<![\\w.$#-])${NAMED}(?![\\w-])`;
const HEX = "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\\w-])";
export const COLOUR_LITERALS = [
  // Hex, but not an id or an anchor (`url(#fade)`, `href="#add"`, `href={'#add'}`), a word with a
  // `#` inside (`page#fade`, `&#160;`), or an id in a CSS selector (`#a, #b .x {`: a `{` follows
  // on the line with no `;`, quote or `${` between). An issue number in copy ("fixed in #123")
  // counts: mark it with a guard-allow comment.
  new RegExp(`(?<![A-Za-z0-9&]|url\\(|href=\\{?["'\`])${HEX}(?![^;{}'"\`$\\n]*\\{)`, "g"),
  // Not after a letter or digit (toRgb(), a.color()); after `_` it is in a Tailwind arbitrary value.
  /(?<![A-Za-z0-9$.-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi,
  // JSX attributes and style objects: fill="black", color: 'red', stroke={'white'},
  // border: '1px solid white', boxShadow: '0 0 4px black'.
  new RegExp(
    `(?<![\\w-])${COLOUR_PROPERTY}\\s*[=:]\\s*\\{?\\s*(['"\`])[^'"\`\\n]*?${NAMED_WORD}[^'"\`\\n]*\\1`,
    "gi",
  ),
  // D3: .attr('fill', 'white'), .style('border', "1px solid red").
  new RegExp(
    `\\.(?:attr|style)\\(\\s*(['"])${COLOUR_PROPERTY}\\1\\s*,\\s*(['"\`])[^'"\`\\n]*?${NAMED_WORD}[^'"\`\\n]*\\2`,
    "gi",
  ),
  // A stylesheet declaration: color: red; border: 1px solid white.
  new RegExp(`(?<![\\w-])${COLOUR_PROPERTY}\\s*:[^;{}'"\`\\n]*?${NAMED_WORD}`, "gi"),
  // A Tailwind arbitrary value: bg-[red], shadow-[0_0_4px_white], text-[color:navy].
  new RegExp(`-\\[[^\\]\\s'"\`]*?(?<=[\\[_,(:])${NAMED}(?=[\\]_,)])[^\\]\\s'"\`]*\\]`, "gi"),
];

// Tailwind's default palettes. tokens.css clears them (`--color-*: initial`), so such a class
// builds nothing, except on the grey scale, which tokens.css keeps for styles/theme.ts.
const PALETTES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
// The utilities that take a colour; a variant (`hover:`, `group-hover/item:`) may come before one
// and an opacity after it. `data-gray-500` or `swatch-gray-500` is not a utility.
const COLOUR_UTILITY =
  "(?:bg|text|border(?:-[xytrblse])?|from|via|to|ring(?:-offset)?|outline|divide|fill|stroke|shadow|inset-shadow|inset-ring|drop-shadow|text-shadow|accent|caret|decoration|placeholder)";
export const DEFAULT_PALETTE_CLASS = new RegExp(
  `(?<![\\w-])${COLOUR_UTILITY}-(?:${PALETTES})-(?:50|[1-9]00|950)(?:\\/(?:\\d+|\\[[^\\]\\s]+\\]))?(?![\\w-])`,
  "g",
);
// In web tests a palette shade counts wherever it is named, not only as a utility: a fixture
// value or an expected class (gray-800, 'text-gray-400', swatch-gray-500). A token that names a
// shade (var(--color-gray-700)) and the theme.ts scale (colors.gray[700]) are not literals.
export const PALETTE_SHADE = new RegExp(
  `(?<![A-Za-z0-9])(?<!--color-)(?:${PALETTES})-\\d{2,3}(?![\\w-])`,
  "g",
);

// The design system's own code: the token sheet's neighbours in styles/ (not the tokens or the
// theme generated from them) and the provenance, measured-value and shared UI components. Its
// colours are named by what they mean (measured, sourced, inferred, warning, error, neutral).
const DESIGN_SYSTEM_DIRS = [
  "apps/web/src/styles/",
  "apps/web/src/components/provenance/",
  "apps/web/src/components/measured/",
  "apps/web/src/components/ui/",
];
const isDesignSystemCode = (p) =>
  DESIGN_SYSTEM_DIRS.some((dir) => p.startsWith(dir)) &&
  /\.([cm]?[jt]sx?|css)$/.test(p) &&
  p !== "apps/web/src/styles/tokens.css" &&
  p !== "apps/web/src/styles/theme.ts" &&
  !isTestSupport(p);
// The hue rule also reads the genealogy graph's code, whose relation colours are named by
// relation (colors.relation.cover), not by hue.
const HUE_RULE_DIRS = [...DESIGN_SYSTEM_DIRS, "apps/web/src/components/genealogy/"];
const isHueRuleCode = (p) =>
  (isDesignSystemCode(p) || HUE_RULE_DIRS.some((dir) => p.startsWith(dir))) &&
  /\.([cm]?[jt]sx?|css)$/.test(p) &&
  p !== "apps/web/src/styles/tokens.css" &&
  p !== "apps/web/src/styles/theme.ts" &&
  !isTestSupport(p);
// A hue that means nothing about where a value comes from, named in code: a class
// (text-accent-pink), a variant ("green"), a glow (shadow-glow-purple-subtle), a theme value
// (colors.indigo), an identifier in camelCase (accentPurple), PascalCase (PinkBadge,
// <PurpleDot />), snake_case (accent_purple) or capitals (PURPLE_GLOW). Case-sensitive, so a
// longer word (greenhouse) is not a colour; words for people (JSX text, aria-label, title, alt)
// are not scanned. A colour of any name is held apart from the inferred violet by distance
// (apps/web/config/contrast.mjs, distinctFromInferred).
const HUES = ["pink", "green", "purple", "indigo", "violet", "fuchsia", "lavender", "magenta"];
const title = (word) => word[0].toUpperCase() + word.slice(1);
export const UNMEANING_HUE = [
  new RegExp(`(?<![A-Za-z0-9])(?:${HUES.join("|")})(?![a-z0-9])`, "g"),
  new RegExp(`(?:${HUES.map(title).join("|")})(?![a-z])`, "g"),
  new RegExp(
    `(?<![A-Za-z0-9])(?:${HUES.map((h) => h.toUpperCase()).join("|")})(?![A-Za-z0-9])`,
    "g",
  ),
];
// The purple and indigo tokens, gone from tokens.css: violet means inferred, and only the
// prov-inferred token is violet. A class, a token or a theme value naming one anywhere in web
// source brings a near-violet back.
export const NEAR_VIOLET = [
  /(?<![A-Za-z0-9_])(?:accent|viz|glow)-(?:purple|indigo|violet)(?:-[\w-]+)?(?![\w-])/g,
  /\b(?:colors|accent|viz)(?:\.|\[\s*['"])(?:purple|indigo|violet)\b/g,
];

// Text under 12 px (0.75 rem, 9 pt): a Tailwind size (text-[10px], text-[0.7rem],
// text-[length:10px], text-[8pt]), a stylesheet font-size or font shorthand, a --text-* size
// token, or a size set from script (D3 .attr('font-size', 9), `${9}px` or d => 9; a fontSize: 10
// prop, attribute or style: 10, 9.5, "10", '0.6rem' or '10px'). In a font-size context a
// unitless number is pixels when it is 2 or more: under 2 (fontSize: 1.2) it is an em scale,
// not a size. A variable named fontSize (const fontSize = 10) is not a size. Sizes kept in
// constants are pinned by their own tests (scripts/graph-text-size.test.mjs).
const N = String.raw`(?:\d|1[01])(?:\.\d+)?`;
// A unitless size in pixels: 2 to under 12.
const NU = String.raw`(?:[2-9]|1[01])(?:\.\d+)?`;
const REM = String.raw`0?\.(?:[0-6]\d*|7(?:[0-4]\d*)?)r?em`;
const PT = String.raw`[0-8](?:\.\d+)?pt`;
const SMALL = `(?:${N}px|${REM}|${PT})`;
export const TINY_TEXT = [
  new RegExp(String.raw`(?<![\w-])text-\[(?:length:)?${SMALL}\]`, "g"),
  new RegExp(String.raw`(?<![\w-])font-size\s*:\s*${SMALL}(?![\w.])`, "gi"),
  new RegExp(String.raw`(?<![\w-])font\s*:[^;{}\n]*?(?<![\w.\-/])${SMALL}(?![\w.])`, "gi"),
  new RegExp(
    String.raw`--text-(?!shadow)(?![\w-]*--line-height)[\w-]+\s*:\s*${SMALL}(?![\w.])`,
    "g",
  ),
  new RegExp(
    String.raw`(['"])font-size\1\s*,\s*(?:(?:\(\s*\w*\s*\)|\w+)\s*=>\s*)?(?:${NU}(?![\w.])|(['"\x60])(?:(?:\$\{\s*${N}\s*\}|${N})px|\$\{\s*${NU}\s*\}|${NU})\2|(['"\x60])(?:${REM}|${PT})\3)`,
    "g",
  ),
  new RegExp(
    String.raw`\bfontSize\s*(?::\s*|=\s*\{\s*|=\s*(?=['"]))(?:${NU}(?![\w.])|(['"\x60])(?:(?:\$\{\s*${N}\s*\}|${N})px|\$\{\s*${NU}\s*\}|${NU})\1|(['"\x60])(?:${REM}|${PT})\2)`,
    "g",
  ),
];

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
    id: "colour-literals-design-system",
    owner: "#30",
    description:
      "Colour literals in web source outside the design tokens (styles/tokens.css, styles/theme.ts): hex, colour functions, and named colours as a colour value",
    files: (p) =>
      ((p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p)) ||
        p === "apps/web/index.html") &&
      p !== "apps/web/src/styles/tokens.css" &&
      p !== "apps/web/src/styles/theme.ts" &&
      !isTestSupport(p),
    pattern: COLOUR_LITERALS,
    scan: "code",
  },
  {
    id: "default-palette-utilities",
    owner: "#30",
    description:
      "Classes on Tailwind's default palettes (text-gray-400, bg-zinc-800, hover:border-red-500/50) in web source: use the surface, border, text and status tokens",
    files: (p) =>
      p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p) && !isTestSupport(p),
    pattern: DEFAULT_PALETTE_CLASS,
    scan: "code",
  },
  {
    id: "colour-literals-web-tests",
    owner: "#38",
    description:
      "Colour literals in web component tests and test helpers (apps/web/src *.tsx tests, and helpers such as genealogy/testing.ts): hex, colour functions, named colours as a colour value and Tailwind palette shades. Take an expected colour from styles/theme.ts",
    // .test.ts files are left out: their titles cite issues (#240) and links.test.ts has an rgb()
    // contrast helper, and their colour assertions already read theme.ts.
    files: (p) =>
      p.startsWith("apps/web/src/") &&
      isScript(p) &&
      isTestSupport(p) &&
      (p.endsWith(".tsx") || !isTest(p)),
    pattern: [...COLOUR_LITERALS, PALETTE_SHADE],
    scan: "code",
  },
  {
    id: "unmeaning-hues-design-system",
    owner: "#30",
    description:
      "Pink, green, purple, indigo or violet named in the design system's code (styles/, components/provenance, measured, ui) and the genealogy graph's: name colours by meaning (measured, sourced, inferred, warning, error, neutral; a relation)",
    files: isHueRuleCode,
    pattern: UNMEANING_HUE,
    scan: "code-not-jsx-text",
  },
  {
    id: "near-violet-outside-inference",
    owner: "#30",
    description:
      "The purple and indigo tokens (accent-purple, viz-indigo, colors.purple…) named in web source or its config: violet means inferred, and only prov-inferred is violet",
    files: (p) =>
      (p.startsWith("apps/web/src/") || p.startsWith("apps/web/config/")) &&
      /\.([cm]?[jt]sx?|css)$/.test(p) &&
      p !== "apps/web/src/styles/theme.ts" &&
      !isTestSupport(p),
    pattern: NEAR_VIOLET,
    scan: "code",
  },
  {
    id: "tiny-text-web",
    owner: "#30",
    description:
      "Text under 12 px in web source (text-[10px], text-[0.7rem], font-size: 9px, font: 10px …, a --text-* token, .attr('font-size', 9), fontSize: 10): use text-chrome (12 px) or larger",
    files: (p) =>
      p.startsWith("apps/web/src/") && /\.([cm]?[jt]sx?|css)$/.test(p) && !isTestSupport(p),
    pattern: TINY_TEXT,
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
    owner: "#34, #35",
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

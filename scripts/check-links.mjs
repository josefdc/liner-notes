#!/usr/bin/env node
// Checks the relative links of the repository's Markdown files, offline:
//
//   npm run check:links                      every tracked *.md file (git ls-files)
//   node scripts/check-links.mjs <file.md>…  only these files (paths from the repository root)
//
// A link fails when the file or directory it names is not tracked, or when its #anchor names no
// heading (and no `id` or `name` attribute) of the Markdown file it points at, or of its own
// file for a bare `#anchor`. Links are inline links and images (`[text](target)`,
// `![alt](target)`), reference definitions (`[label]: target`) and the `href` and `src`
// attributes of HTML tags. Fenced code blocks, indented code blocks and inline code are not read.
// A target that starts with `/` is taken from the repository root, as GitHub does.
//
// External URLs (any scheme: https:, mailto: …) are not fetched or checked: CI runs this with
// the network denied, and their state is not this repository's.
//
// Headings become anchors as GitHub makes them: the heading's text, lower-cased, with
// punctuation and symbols (emoji included) removed and each space turned into "-"; a repeated
// anchor gets "-1", "-2" … in order of appearance.
//
// Exits 0 when every link resolves, 1 when one does not (each is printed with its file and
// line), 2 when the files cannot be listed or read.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A URL scheme (`https:`, `mailto:` …): such a target is external and is not checked. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The lines of a Markdown text that are not code: each fenced block's lines (the fences
 * included) and each indented code block's are blank, and inline code spans are blanked out, so
 * line numbers stay. Returns the cleaned lines and, per line, whether it was code.
 */
export function proseLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null;
  let previousBlank = true;
  for (const line of lines) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      out.push("");
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      out.push("");
      previousBlank = false;
      continue;
    }
    // An indented code block starts after a blank line (a list item's continuation is indented
    // too, but follows its item, not a blank line, or starts with a list marker of its own).
    if (previousBlank && /^( {4}|\t)/.test(line) && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      out.push("");
      continue;
    }
    previousBlank = line.trim() === "";
    out.push(stripInlineCode(line));
  }
  return out;
}

/** The line with each inline code span (`…`, ``…``) replaced by spaces. */
function stripInlineCode(line) {
  return line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (span) => " ".repeat(span.length));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** `text` with HTML character references decoded (named ones above, and numeric ones). */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code =
        name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Markup of the text outside code spans removed: tags, links (their text kept), emphasis. */
function plainText(part) {
  return decodeEntities(
    part
      .replace(/<[^>]+>/g, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/\*+|~~/g, "")
      // An underscore marks emphasis only at a word's edge ("_word_"), never inside one.
      .replace(/(^|[^\p{L}\p{N}_])_+(?=\S)/gu, "$1")
      .replace(/(?<=\S)_+(?=$|[^\p{L}\p{N}_])/gu, ""),
  );
}

/**
 * The text of a heading as GitHub renders it, which its anchor is made from: a code span's text
 * as written, and the rest without its Markdown and HTML markup.
 */
function headingText(raw) {
  let text = "";
  let at = 0;
  for (const match of raw.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) {
    text += plainText(raw.slice(at, match.index)) + match[2].replace(/^ (.*) $/, "$1");
    at = match.index + match[0].length;
  }
  return (text + plainText(raw.slice(at))).trim();
}

/**
 * GitHub's anchor for a heading's text (github-slugger): lower-cased; every character that is not
 * alphabetic (letters, letter numbers, and symbols such as Ⓐ), a mark, a decimal digit,
 * connector punctuation, a space or "-" removed; each space turned into "-". Letters added to
 * Unicode after github-slugger's tables are kept here and dropped there.
 */
export function slug(text) {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Every anchor of a Markdown text: its headings' (numbered when repeated) and its HTML ids. */
export function anchorsOf(text) {
  const anchors = new Set();
  // github-slugger's numbering: a taken anchor gets the next free "-n" of its base.
  const occurrences = new Map();
  const add = (base) => {
    let candidate = base;
    while (occurrences.has(candidate)) {
      occurrences.set(base, occurrences.get(base) + 1);
      candidate = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(candidate, 0);
    anchors.add(candidate);
  };
  const lines = text.split(/\r?\n/);
  const prose = proseLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (prose[i] === "" && lines[i] !== "") continue; // code
    // A heading may sit in a blockquote ("> ## Title").
    const atx = lines[i]
      .replace(/^ {0,3}(> ?)+/, "")
      .match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (atx) {
      add(slug(atx[1]));
      continue;
    }
    // A setext heading: a text line underlined with = or -.
    const next = lines[i + 1];
    if (
      next !== undefined &&
      lines[i].trim() !== "" &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(next) &&
      !/^ {0,3}([-*+]|\d+[.)])\s/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i])
    ) {
      add(slug(lines[i].trim()));
    }
  }
  for (const line of prose) {
    for (const match of line.matchAll(/<[a-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

/** The target of a link as written: angle brackets and a title removed. */
function cleanTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<")) {
    const end = target.indexOf(">");
    return end === -1 ? target.slice(1) : target.slice(1, end);
  }
  const space = target.search(/\s/);
  if (space !== -1) target = target.slice(0, space);
  return target;
}

/**
 * The links of a Markdown text: `{ target, line }` for each inline link or image, reference
 * definition and HTML href/src, outside code.
 */
export function linksOf(text) {
  const links = [];
  const prose = proseLines(text);
  prose.forEach((line, index) => {
    const lineNumber = index + 1;
    // Inline links and images: ](target), the target running to its balanced closing paren.
    let at = 0;
    for (;;) {
      const start = line.indexOf("](", at);
      if (start === -1) break;
      let depth = 1;
      let end = start + 2;
      for (; end < line.length && depth > 0; end++) {
        if (line[end] === "\\") end++;
        else if (line[end] === "(") depth++;
        else if (line[end] === ")") depth--;
      }
      if (depth === 0) {
        links.push({ target: cleanTarget(line.slice(start + 2, end - 1)), line: lineNumber });
      }
      at = start + 2;
    }
    // A reference definition; a footnote ("[^1]: text") is not one.
    const definition = line.match(/^ {0,3}\[(?!\^)[^\]]+\]:\s*(\S+)/);
    if (definition) links.push({ target: cleanTarget(definition[1]), line: lineNumber });
    for (const match of line.matchAll(/<[a-z][^>]*?\s(?:href|src)\s*=\s*["']([^"']*)["']/gi)) {
      links.push({ target: match[1], line: lineNumber });
    }
  });
  return links.filter((link) => link.target !== "");
}

/**
 * The broken links of `files` (paths from the root, posix). `read(path)` gives a file's text;
 * `tracked` is every tracked file's path. A directory resolves when a tracked file is under it.
 * Returns `{ file, line, target, reason }` for each broken link.
 */
export function brokenLinks(files, { read, tracked }) {
  const trackedSet = new Set(tracked);
  const directories = new Set();
  for (const path of tracked) {
    let dir = posix.dirname(path);
    while (dir !== "." && !directories.has(dir)) {
      directories.add(dir);
      dir = posix.dirname(dir);
    }
  }
  const anchorCache = new Map();
  const anchorsFor = (path) => {
    if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(read(path)));
    return anchorCache.get(path);
  };
  const broken = [];
  for (const file of files) {
    for (const { target, line } of linksOf(read(file))) {
      if (SCHEME.test(target) || target.startsWith("//")) continue;
      const hashAt = target.indexOf("#");
      const rawPath = hashAt === -1 ? target : target.slice(0, hashAt);
      const anchor = hashAt === -1 ? null : target.slice(hashAt + 1);
      let pathPart;
      try {
        pathPart = decodeURIComponent(rawPath.split("?")[0]);
      } catch {
        broken.push({ file, line, target, reason: "the path is not valid percent-encoding" });
        continue;
      }
      let resolved;
      if (pathPart === "") resolved = file;
      else {
        const joined = pathPart.startsWith("/")
          ? pathPart.slice(1)
          : posix.join(posix.dirname(file), pathPart);
        resolved = posix.normalize(joined).replace(/\/$/, "");
        if (resolved === "" || resolved === ".") resolved = ".";
      }
      if (resolved.startsWith("../") || resolved === "..") {
        broken.push({ file, line, target, reason: "the path leaves the repository" });
        continue;
      }
      const isFile = trackedSet.has(resolved);
      if (!isFile && resolved !== "." && !directories.has(resolved)) {
        broken.push({
          file,
          line,
          target,
          reason: `${resolved} is not a tracked file or directory`,
        });
        continue;
      }
      if (anchor === null || anchor === "") continue;
      if (!isFile || !/\.md$/i.test(resolved)) continue; // anchors of other files are not read
      let decoded;
      try {
        decoded = decodeURIComponent(anchor);
      } catch {
        decoded = anchor;
      }
      const anchors = anchorsFor(resolved);
      if (!anchors.has(decoded) && !anchors.has(decoded.toLowerCase())) {
        broken.push({ file, line, target, reason: `${resolved} has no anchor #${decoded}` });
      }
    }
  }
  return broken;
}

/** Every tracked file of the repository at `root`, posix paths from it. */
export function trackedFiles(root = ROOT) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** Runs the check and returns the exit code. */
export function main(argv = process.argv.slice(2), { root = ROOT, log = console.log } = {}) {
  let tracked;
  try {
    tracked = trackedFiles(root);
  } catch (error) {
    log(`check-links: cannot list the tracked files (${error.message})`);
    return 2;
  }
  const files = argv.length
    ? argv.map((path) => normalize(path).split("\\").join("/"))
    : tracked.filter((path) => /\.md$/i.test(path));
  let broken;
  try {
    broken = brokenLinks(files, {
      read: (path) => readFileSync(join(root, path), "utf8"),
      tracked,
    });
  } catch (error) {
    log(`check-links: cannot read a file (${error.message})`);
    return 2;
  }
  for (const link of broken) log(`${link.file}:${link.line}: ${link.target}: ${link.reason}`);
  log(
    broken.length
      ? `check-links: ${broken.length} broken link(s) in ${files.length} file(s)`
      : `check-links: ok, ${files.length} file(s)`,
  );
  return broken.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

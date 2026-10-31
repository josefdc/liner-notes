/**
 * The texts the app writes itself, and those its recorded runs hold, are prose, names and ids: no
 * redaction path may hide a part of one. Each string field of fixtures/**\/*.json, and each
 * string literal of the API's code (the static parts of a template too), is read through every
 * path a log line or a client's text takes, and must come back as it went in, but where this file
 * says why not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hideScrubbed, scrub } from "../logger.js";
import { describeError, plainReason, redactText, scrubReadText, scrubText } from "./http.js";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const SOURCE = join(REPO, "apps", "api", "src");

/** Every file under `dir` whose path matches `wanted` and not `skip`. */
function files(dir: string, wanted: RegExp, skip: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => wanted.test(path) && !skip.test(path));
}

/** Each string in a JSON value. */
function stringsOf(value: unknown, out: Set<string>): void {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringsOf(item, out);
  }
}

/** A string literal on one line: double-quoted (group 1), or a template (group 2). */
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g;
/** A template's placeholder, one level of braces inside. */
const PLACEHOLDER = /\$\{(?:[^{}]|\{[^{}]*\})*\}/;
/** A line of a comment, whose quotes are not literals. */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;

/** The API's own string literals of 8 characters or more with a space: its messages. */
function literals(): Set<string> {
  const out = new Set<string>();
  // Tests and their helpers hold credentials on purpose; the source fixtures are recorded answers.
  for (const path of files(SOURCE, /\.ts$/, /\.test\.ts$|[\\/](?:testing|fixtures)[\\/]/)) {
    const code = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !COMMENT_LINE.test(line))
      .join("\n");
    for (const match of code.matchAll(LITERAL)) {
      // A raw template is a pattern's source, not a message.
      if (code.slice(Math.max(0, match.index - 10), match.index).endsWith("String.raw")) continue;
      const pieces = match[1] !== undefined ? [match[1]] : (match[2] ?? "").split(PLACEHOLDER);
      for (const piece of pieces) {
        if (piece.length < 8 || !/ /.test(piece) || !/[a-z]/i.test(piece)) continue;
        try {
          out.add(JSON.parse(`"${piece.replace(/\\`/g, "`").replace(/(?<!\\)"/g, '\\"')}"`));
        } catch {
          // An escape JSON does not read (`\x41`): the piece is code, not a message.
        }
      }
    }
  }
  return out;
}

/**
 * The string fields of the recorded runs. The cassettes (fixtures/cassettes) are left out: they
 * hold what the sources answered and the prompts sent to the model, the input of these paths
 * rather than text the app wrote, so a path may rightly change them (a long page is cut, a
 * number that reads as a phone number is hidden).
 */
function fixtureStrings(): Set<string> {
  const out = new Set<string>();
  for (const path of files(join(REPO, "fixtures"), /\.json$/, /node_modules|[\\/]cassettes[\\/]/)) {
    stringsOf(JSON.parse(readFileSync(path, "utf8")), out);
  }
  return out;
}

/**
 * The paths, each with what it writes for a text it leaves alone: plainReason writes one line,
 * its spaces as one, and cuts it at 120 characters.
 */
const PATHS: Record<string, { run: (text: string) => string | undefined; plain?: true }> = {
  scrub: { run: (text) => scrub(text) },
  hideScrubbed: { run: (text) => hideScrubbed(text) },
  plainReason: { run: (text) => plainReason(text), plain: true },
  scrubText: { run: (text) => scrubText(text) },
  redactText: { run: (text) => redactText(text) },
  scrubReadText: { run: (text) => scrubReadText(text) },
  describeError: { run: (text) => describeError(new Error(text)) },
};

/** What a path leaves as it is: `text`, or for plainReason one line of it; undefined if cut. */
function untouched(text: string, plain: boolean): string | undefined {
  if (!plain) return text;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 120 ? line : undefined;
}

/**
 * The texts a path rewrites by design, each with why. A link is written as a label, or with its
 * user info or keys hidden, on each path; the rest are what the Authorization rule of the log has
 * always read as a scheme and its credential.
 */
const REWRITTEN: ReadonlyArray<{ text: RegExp; paths: readonly string[]; why: string }> = [
  {
    text: /:\/\//,
    paths: Object.keys(PATHS),
    why: "a link: written as [link], [media] or a label, or its digits read as a phone number",
  },
  {
    text: /^a bearer or basic credential$/,
    paths: ["scrub", "hideScrubbed"],
    why: "the log's Authorization rule reads `bearer <word>` as a scheme and its token",
  },
];

describe("the app's own texts and its recorded runs' texts (#237)", () => {
  const texts = [...new Set([...fixtureStrings(), ...literals()])];

  it("reads enough texts for the check to mean something", () => {
    expect(texts.length).toBeGreaterThan(2_000);
    // The texts that once lost a word on some path are read.
    for (const text of [
      "Discogs not asked: no key is configured for it",
      "MusicBrainz links no Discogs release to an original release of the recording",
      " with a body that is not JSON",
    ]) {
      expect(texts).toContain(text);
    }
  });

  it.each(Object.keys(PATHS))("leaves each of them as it was on %s", (path) => {
    const { run, plain } = PATHS[path] as (typeof PATHS)[string];
    const changed: Array<[string, string | undefined]> = [];
    for (const text of texts) {
      const expected = untouched(text, plain === true);
      if (expected === undefined) continue;
      if (REWRITTEN.some((rule) => rule.paths.includes(path) && rule.text.test(text))) continue;
      const out = run(text);
      // plainReason gives no reason for a text that looks like code or markup: it shows none.
      if (plain && out === undefined) continue;
      if (out !== expected) changed.push([text, out]);
    }
    expect(changed.slice(0, 10)).toEqual([]);
  });
});

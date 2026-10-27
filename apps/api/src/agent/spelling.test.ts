/**
 * The API spells "analyze" as the web does: no status line, message or other text in its code
 * says "analyse", "analysed", "analyser" or "analysing". Status lines are written from fixed
 * words in many places (statusText.ts, the nodes, the research steps, the player, the routes),
 * so every string literal of the API's code is read; comments are not.
 *
 * Left out: the model's prompts (agent/prompts.ts). They are what the model is asked, not text
 * the API sends, and every word of them keys the recorded model answers (llm/cassette.ts), so a
 * change of spelling there goes with a re-record of those answers.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { API_ROOT } from "../config/apiPackage.js";
import { DEFAULT_REPLAY_DIR, loadReplays } from "../replay/records.js";

const SOURCE_DIR = join(API_ROOT, "src");
const LEFT_OUT = new Set(["agent/prompts.ts"]);

/** British spellings of "analyze" and its forms ("analyses", also a plural noun, is not read). */
const BRITISH = /\banalys(?:e|ed|er|ers|ing)\b/i;

/** The API's source files: no tests, no test helpers. */
function sourceFiles(dir = SOURCE_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every string literal and template text of a file, with its line. */
function literals(path: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Where `texts` spell "analyze" the British way. */
const britishIn = (texts: Array<{ where: string; text: string }>) =>
  texts.filter(({ text }) => BRITISH.test(text)).map(({ where, text }) => `${where}: ${text}`);

describe("the API's spelling of analyze", () => {
  it("reads 'analysed' and 'analysing' as British, and 'analysis' and 'analyzed' as neither", () => {
    for (const word of ["analyse", "Analysed", "analysing", "the analyser"]) {
      expect(BRITISH.test(word), word).toBe(true);
    }
    for (const word of ["analysis", "Analyses", "analyzed", "analyzing", "analyzerVersion"]) {
      expect(BRITISH.test(word), word).toBe(false);
    }
  });

  it("writes no status line or message with 'analysed', 'analyse' or 'analysing'", () => {
    const files = sourceFiles().filter(
      (path) => !LEFT_OUT.has(relative(SOURCE_DIR, path).split("\\").join("/")),
    );
    const texts = files.flatMap((path) =>
      literals(path).map(({ line, text }) => ({
        where: `${relative(SOURCE_DIR, path)}:${line}`,
        text,
      })),
    );
    // The scan reads the status lines' own words (statusText.ts, the player's notice).
    expect(texts.some(({ text }) => text.startsWith("Found the track on Spotify: "))).toBe(true);
    expect(texts.some(({ text }) => text.startsWith("Replaying an analysis recorded on "))).toBe(
      true,
    );
    expect(britishIn(texts)).toEqual([]);
  });

  it("finds none in the committed recordings' status lines either, so none needs an exemption", () => {
    const { records, problems } = loadReplays(DEFAULT_REPLAY_DIR);
    expect(problems).toEqual([]);
    const lines = records.flatMap((record) =>
      record.events.flatMap(({ event }, i) =>
        event.type === "status"
          ? [{ where: `${record.slug} events[${i}]`, text: event.message }]
          : [],
      ),
    );
    expect(lines.length).toBeGreaterThan(5);
    expect(britishIn(lines)).toEqual([]);
  });
});

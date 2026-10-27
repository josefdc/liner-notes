/**
 * Expressions that read upstream text (artist credits, names, log lines) in linear time: each
 * splits or replaces exactly as the expression it replaced, which took quadratic time on a long
 * run of whitespace.
 */

import { describe, expect, it } from "vitest";
import { SEPARATOR } from "./agent/codeClaims.js";
import { CREDIT_JOIN } from "./agent/enricher.js";
import { SECRET_PAIR, scrub } from "./logger.js";
import { NAME_JOIN } from "./sources/musicbrainz.js";
import { CREDIT_SEPARATOR, DISAMBIGUATION_NUMBER, normalizeArtist } from "./sources/records.js";
import { allStrings, randomStrings, timed } from "./sources/testing/strings.js";

// The expressions before #194.
const OLD_SEPARATOR = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;
const OLD_NAME_JOIN = /\s*(?:,|&|\band\b|\/)\s*/i;
const OLD_CREDIT_JOIN = /\s*(?:,|&|\/|\s(?:and|x|with|feat\.?|ft\.?|featuring)\s)\s*/i;
const OLD_DISAMBIGUATION_NUMBER = /\s+\(\d+\)$/;
const OLD_SECRET_PAIR =
  /\b((?:x-)?api[-_]?key|apikey|(?:ocp-apim-)?subscription[-_]?key|authorization|access[-_]?token|refresh[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|password|secret|token)(["']?\s*[:=]\s*)(?!\s*(?:(?:Bearer|Basic|Discogs)\s+)?["']?\[redacted\])(?:(?:Bearer|Basic|Discogs)\s+)?["']?[^\s"'&,;}\]]+["']?/gi;

const credits = [
  "Queen & David Bowie",
  "Daft Punk feat. Pharrell Williams",
  "Earth, Wind & Fire",
  "Simon and Garfunkel",
  "X Ambassadors",
  "A x B",
  "A with B",
  "A / B",
  "A ,  B",
  "A  & B",
  "A , , B",
  ...allStrings([" ", "\t", ",", "&", "and", " and ", " x ", "feat.", "A"], 5),
  ...randomStrings(
    [
      " ",
      "  ",
      "\t",
      "\n",
      ",",
      "&",
      "/",
      "and",
      " and ",
      " x ",
      " with ",
      "feat",
      "feat.",
      " ft. ",
      "featuring",
      "Queen",
      "Bowie",
      "é",
      " ",
    ],
    20_000,
    14,
  ),
];

describe("credit joins", () => {
  it.each([
    ["codeClaims SEPARATOR", SEPARATOR, OLD_SEPARATOR],
    ["records CREDIT_SEPARATOR", CREDIT_SEPARATOR, OLD_SEPARATOR],
    ["enricher CREDIT_JOIN", CREDIT_JOIN, OLD_CREDIT_JOIN],
    ["musicbrainz NAME_JOIN", NAME_JOIN, OLD_NAME_JOIN],
  ])("%s splits a credit exactly as before", (_name, join, old) => {
    for (const credit of credits)
      expect(credit.split(join), JSON.stringify(credit)).toEqual(credit.split(old));
    expect(credits.filter((credit) => credit.split(old).length > 1).length).toBeGreaterThan(1000);
  });

  it.each([
    ["codeClaims SEPARATOR", SEPARATOR],
    ["records CREDIT_SEPARATOR", CREDIT_SEPARATOR],
    ["enricher CREDIT_JOIN", CREDIT_JOIN],
    ["musicbrainz NAME_JOIN", NAME_JOIN],
  ])("%s splits a credit with a long run of spaces quickly", (_name, join) => {
    // About 2 s to 4 s with the earlier expressions.
    const credit = `a${" ".repeat(60_000)}x`;
    const { ms, result } = timed(() => credit.split(join));
    expect(ms).toBeLessThan(100);
    expect(result).toEqual([credit]);
  });
});

describe("DISAMBIGUATION_NUMBER", () => {
  it("removes exactly what the earlier expression removed", () => {
    const names = [
      "Nirvana (2)",
      "Nirvana (2)*",
      "Nirvana  (12)",
      "Nirvana\t(2)",
      "Nirvana(2)",
      "(2)",
      " (2)",
      "Nirvana (2) ",
      "Nirvana (x)",
      ...allStrings([" ", "\t", "(", ")", "1", "a"], 6),
      ...randomStrings(
        [" ", "  ", "\t", "\n", "(", ")", "1", "(2)", " (2)", "Nirvana", " "],
        20_000,
        8,
      ),
    ];
    for (const name of names) {
      expect(name.replace(DISAMBIGUATION_NUMBER, ""), JSON.stringify(name)).toBe(
        name.replace(OLD_DISAMBIGUATION_NUMBER, ""),
      );
    }
    expect(names.filter((name) => OLD_DISAMBIGUATION_NUMBER.test(name)).length).toBeGreaterThan(
      1000,
    );
  });

  it("reads a name with a long run of spaces quickly", () => {
    // About 2 s with the earlier expression.
    const name = `a${" ".repeat(60_000)}x`;
    const { ms, result } = timed(() => normalizeArtist(name));
    expect(ms).toBeLessThan(100);
    expect(result).toBe("a x");
  });
});

describe("SECRET_PAIR", () => {
  it("redacts exactly what the earlier expression redacted", () => {
    const lines = [
      "token: abc123",
      'password = "hunter2"',
      "Authorization: Bearer abc.def",
      "x-api-key:[redacted]",
      "token:  [redacted]",
      "token:\n\tabc",
      "token:    ",
      "secret=",
      ...randomStrings(
        [
          "token",
          "Password",
          "x-api-key",
          ":",
          "=",
          " ",
          "  ",
          "\t",
          "\n",
          '"',
          "'",
          "Bearer ",
          "Discogs ",
          "[redacted]",
          "abc",
          ",",
          "]",
          "x",
        ],
        20_000,
        8,
      ),
    ];
    for (const line of lines) {
      expect(line.replace(SECRET_PAIR, "$1$2[R]"), JSON.stringify(line)).toBe(
        line.replace(OLD_SECRET_PAIR, "$1$2[R]"),
      );
    }
    expect(
      lines.filter((line) => line.replace(OLD_SECRET_PAIR, "") !== line).length,
    ).toBeGreaterThan(500);
  });

  it("reads a long run of whitespace after a secret's name quickly", () => {
    // About 2 s with the earlier expression; the log cuts a line at 16 KiB first (about 0.1 s).
    const line = `token:${"\t".repeat(60_000)}]`;
    const { ms, result } = timed(() => line.replace(SECRET_PAIR, "$1$2[R]"));
    expect(ms).toBeLessThan(100);
    expect(result).toBe(line);
    expect(timed(() => scrub(line)).ms).toBeLessThan(100);
  });
});

/**
 * Expressions that read upstream text (artist credits, names, log lines) in linear time: each
 * splits or replaces exactly as the expression it replaced, which took quadratic time on a long
 * run of whitespace.
 */

import { describe, expect, it } from "vitest";
import { SEPARATOR } from "./agent/codeClaims.js";
import { CREDIT_JOIN, featuredNotes, featuredTail } from "./agent/enricher.js";
import { SECRET_PAIR } from "./logger.js";
import { partTitlesDiffer } from "./agent/trackMatch.js";
import {
  TEMPO_RANGE,
  TEMPO_UNIT_AFTER,
  TEMPO_UNIT_BEFORE,
  TEMPO_WORD,
  tempoMentions,
} from "./agent/verifier/numeric.js";
import {
  NAME_JOIN,
  RELEASE_LABEL_BRACKETED,
  RELEASE_LABEL_DASHED,
  recordingTitle,
} from "./sources/musicbrainz.js";
import {
  CREDIT_SEPARATOR,
  DISAMBIGUATION_NUMBER,
  normalizeArtist,
  normalizeTitle,
  REMASTER_BRACKETED,
  REMASTER_DASHED,
  titlesMatch,
} from "./sources/records.js";
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
    // About 2 s with the earlier expression.
    const line = `token:${"\t".repeat(60_000)}]`;
    const { ms, result } = timed(() => line.replace(SECRET_PAIR, "$1$2[R]"));
    expect(ms).toBeLessThan(100);
    expect(result).toBe(line);
  });
});

describe("release labels in titles", () => {
  // The expressions before #194, as records.ts and musicbrainz.ts built them.
  const REMASTER = String.raw`(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|edition))?(?:\s+\d{4})?`;
  const RELEASE_LABEL = String.raw`(?:${REMASTER}|radio\s+edit|single\s+(?:version|edit)|album\s+version|(?:mono|stereo)(?:\s+version)?)`;
  const pairs: Array<[string, RegExp, RegExp]> = [
    [
      "records REMASTER_BRACKETED",
      REMASTER_BRACKETED,
      new RegExp(String.raw`\s*[([]\s*${REMASTER}\s*[)\]]`, "gi"),
    ],
    [
      "records REMASTER_DASHED",
      REMASTER_DASHED,
      new RegExp(String.raw`\s+-\s+${REMASTER}\s*$`, "i"),
    ],
    [
      "musicbrainz RELEASE_LABEL_DASHED",
      RELEASE_LABEL_DASHED,
      new RegExp(String.raw`\s+-\s+${RELEASE_LABEL}\s*$`, "i"),
    ],
    [
      "musicbrainz RELEASE_LABEL_BRACKETED",
      RELEASE_LABEL_BRACKETED,
      new RegExp(String.raw`\s*[([]\s*${RELEASE_LABEL}\s*[)\]]`, "gi"),
    ],
  ];
  const titles = [
    "Under Pressure - Remastered 2011",
    "Song (2009 Remaster)",
    "Song  [Digitally Remastered]",
    "Song - Radio Edit",
    "Song (Single Version)",
    "Song - Album Version ",
    "Song (Mono)",
    "Song -  Stereo Version",
    "Song (Remastered) (Live)",
    ...randomStrings(
      [
        " ",
        "  ",
        "\t",
        "\n",
        "\u00a0",
        "-",
        " - ",
        "(",
        ")",
        "[",
        "]",
        "Remastered",
        "remaster",
        "2011",
        " 2009",
        "Digital ",
        "Digitally",
        " Version",
        " Edition",
        "Radio Edit",
        "Single Version",
        "Album Version",
        "Mono",
        "Stereo",
        "Song",
        "x",
      ],
      60_000,
      12,
    ),
  ];

  it.each(pairs)("%s removes exactly what the earlier expression removed", (_name, now, old) => {
    for (const title of titles) {
      expect(title.replace(now, ""), JSON.stringify(title)).toBe(title.replace(old, ""));
    }
    expect(titles.filter((title) => title.replace(old, "") !== title).length).toBeGreaterThan(150);
  });
});

describe("title helpers end to end", () => {
  // About 2 s to 12 s each before #194 (normalizeTitle, titlesMatch and recordingTitle on
  // whitespace runs; partTitlesDiffer on runs of opening brackets).
  const shapes: Array<[string, string]> = [
    ["a long run of spaces", `a${" ".repeat(60_000)}x`],
    ["a long run of tabs before a dash", `a${"\t".repeat(60_000)}-x`],
    ["a run of opening square brackets", `Song ${"[".repeat(60_000)}`],
    ["a run of opening parentheses", `Song ${"(".repeat(60_000)}`],
  ];
  const helpers: Array<[string, (title: string) => unknown]> = [
    ["normalizeTitle", (title) => normalizeTitle(title, ["X"])],
    ["titlesMatch", (title) => titlesMatch(title, "Song", ["X"])],
    ["recordingTitle", (title) => recordingTitle(title, ["X"])],
    ["partTitlesDiffer", (title) => partTitlesDiffer({ title }, { title: "Song" })],
  ];

  it.each(shapes)("reads a title with %s quickly", (_name, title) => {
    for (const [name, helper] of helpers) {
      const { ms } = timed(() => helper(title));
      expect(ms, name).toBeLessThan(100);
    }
  });
});

describe("tempo mentions", () => {
  // The expressions before #194: two or three whitespace runs around an optional word, each
  // split of a long run tried in turn (quadratic; cubic for TEMPO_WORD).
  const NUMBER = String.raw`(\d{2,3}(?:[.,]\d{1,2})?)`;
  const NOT_IN_NUMBER = String.raw`(?<![\p{L}\p{N}.,])`;
  const UNIT = String.raw`\s*-?\s*(?:bpm\b|b\.p\.m\.|beats[\s-]+(?:per|a|each)[\s-]+minute\b)`;
  const pairs: Array<[string, RegExp, RegExp]> = [
    ["TEMPO_UNIT_AFTER", TEMPO_UNIT_AFTER, new RegExp(`${NOT_IN_NUMBER}${NUMBER}${UNIT}`, "giu")],
    [
      "TEMPO_UNIT_BEFORE",
      TEMPO_UNIT_BEFORE,
      new RegExp(
        String.raw`\b(?:bpm|b\.p\.m\.)\s*(?::|=|of|is|was|at)?\s*${NUMBER}(?![\p{N}%])`,
        "giu",
      ),
    ],
    [
      "TEMPO_RANGE",
      TEMPO_RANGE,
      new RegExp(
        String.raw`(?:\bbetween\s+)?${NOT_IN_NUMBER}${NUMBER}\s*(?:-|–|—|to|and)\s*${NUMBER}${UNIT}`,
        "giu",
      ),
    ],
    [
      "TEMPO_WORD",
      TEMPO_WORD,
      new RegExp(
        String.raw`\btempo\s*(?::|=|of|is|was|at|around|about)?\s*(?:about|around|roughly|approximately|~)?\s*${NUMBER}(?![\p{N}%])`,
        "giu",
      ),
    ],
  ];
  const found = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => [m.index, ...m]);
  const texts = [
    "It runs at 120 BPM.",
    "BPM: 246, tempo of about 96.5",
    "between 110 and 125 BPM",
    "100 to 110 beats per minute",
    "a tempo around ~ 120",
    "120-BPM, 120 - bpm, bpm 120%",
    ...randomStrings(
      [
        "120",
        "96.5",
        "100",
        "1",
        " ",
        "  ",
        "\t",
        "\n",
        "-",
        "–",
        "to",
        "and",
        "between ",
        "bpm",
        "BPM",
        "b.p.m.",
        "beats per minute",
        "tempo",
        ":",
        "of",
        "is",
        "about",
        "around",
        "roughly",
        "~",
        "x",
        ".",
        "%",
        "\u00a0",
      ],
      40_000,
      10,
    ),
    ...randomStrings(
      [
        "100",
        "120",
        " ",
        "  ",
        "-",
        "–",
        " to ",
        " and ",
        "between ",
        " bpm",
        "-bpm",
        " beats-per-minute",
        "x",
      ],
      20_000,
      8,
    ),
  ];
  // Every way of writing a range and a "tempo" phrase with these pieces.
  const spaces = ["", " ", "  \t"];
  for (const gap of spaces)
    for (const sep of ["-", "–", "to", "and", "x"])
      for (const unit of ["bpm", "-bpm", "- bpm", "beats per minute", "%"])
        texts.push(`between 100${gap}${sep}${gap}120${gap}${unit}`, `96.5${sep}${gap}120.5${unit}`);
  for (const gap of spaces)
    for (const first of ["", ":", "of", "about", "is"])
      for (const second of ["", "about", "~", "roughly"])
        for (const number of ["120", "96.5", "1200", "120%"])
          texts.push(`tempo${gap}${first}${gap}${second}${gap}${number}`);

  it.each(pairs)("%s finds exactly what the earlier expression found", (_name, now, old) => {
    for (const text of texts)
      expect(found(now, text), JSON.stringify(text)).toEqual(found(old, text));
    expect(texts.filter((text) => found(old, text).length > 0).length).toBeGreaterThan(150);
  });

  it.each([
    // About 2 s each with the earlier expressions at 60k; TEMPO_WORD was cubic, about 5 s at 3k.
    ["a number before a long run of spaces", `120${" ".repeat(60_000)}x`],
    ["a range before a long run of spaces", `100-120${" ".repeat(60_000)}x`],
    ["the unit before a long run of spaces", `bpm${" ".repeat(60_000)}x`],
    ["the word tempo before a run of spaces", `tempo${" ".repeat(3_000)}x`],
  ])("reads %s quickly", (_name, text) => {
    const { ms, result } = timed(() => tempoMentions(text, true));
    expect(ms).toBeLessThan(100);
    expect(result).toEqual([]);
  });
});

describe("featured-artist notes in titles", () => {
  // The expressions before #194: each note or tail was read to its end again from every start.
  const NOTE = /[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi;
  const TAIL = /(?:^|\s)(?:feat\.|ft\.|featuring)\s+([^()[\]]+)$/gi;
  const titles = [
    "Stay With Me (feat. Mary J. Blige)",
    "Song [ft. X & Y]",
    "Song (with  )",
    "Song (with )",
    "Song feat. X",
    "Song feat. X (Live)",
    "Song featuring X, Y",
    "feat. X",
    "Song feat.  ",
    ...allStrings(["(", ")", "[", " ", "feat. ", "with", "X", "\n"], 6),
    ...randomStrings(
      [
        "(",
        ")",
        "[",
        "]",
        " ",
        "  ",
        "\t",
        "\n",
        "feat",
        "feat.",
        "Feat. ",
        "ft.",
        "featuring",
        "with",
        "With ",
        "X",
        "Y",
        " & ",
        "Song",
        "\u00a0",
      ],
      40_000,
      12,
    ),
  ];

  it("finds exactly the notes and tails the earlier expressions found", () => {
    for (const title of titles) {
      expect(featuredNotes(title), JSON.stringify(title)).toEqual(
        [...title.matchAll(NOTE)].map((m) => m[1]),
      );
      expect(featuredTail(title), JSON.stringify(title)).toBe(
        [...title.matchAll(TAIL)].map((m) => m[1])[0] ?? null,
      );
    }
    expect(titles.filter((title) => [...title.matchAll(NOTE)].length > 0).length).toBeGreaterThan(
      1000,
    );
    expect(titles.filter((title) => [...title.matchAll(TAIL)].length > 0).length).toBeGreaterThan(
      1000,
    );
  });

  it.each([
    // About 2 s each with the earlier expressions.
    ["unclosed notes", "(feat x".repeat(25_000)],
    ["a note word before a long run of spaces", `(feat${" ".repeat(60_000)}`],
    ["a tail word before a long run of spaces and a bracket", `feat.${" ".repeat(60_000)}(`],
  ])("reads %s quickly", (_name, title) => {
    const { ms } = timed(() => [featuredNotes(title), featuredTail(title)]);
    expect(ms).toBeLessThan(100);
  });
});

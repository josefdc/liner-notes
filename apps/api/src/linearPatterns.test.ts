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
import { tempoExpressions, tempoMentions } from "./agent/verifier/numeric.js";
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
import { allStrings, disagreements, randomStrings, timed } from "./sources/testing/strings.js";

// The expressions before #194.
const OLD_SEPARATOR = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\/)\s*/i;
const OLD_NAME_JOIN = /\s*(?:,|&|\band\b|\/)\s*/i;
const OLD_CREDIT_JOIN = /\s*(?:,|&|\/|\s(?:and|x|with|feat\.?|ft\.?|featuring)\s)\s*/i;
const OLD_DISAMBIGUATION_NUMBER = /\s+\(\d+\)$/;
// SECRET_PAIR with the earlier form of its whitespace after ":" or "=" (before #198), for that
// whitespace only: the rest is SECRET_PAIR's own. What its scheme group takes is pinned by the
// literal cases below, and against main's expression by logger.test.ts.
const OLD_SECRET_PAIR = new RegExp(
  SECRET_PAIR.source.replace(String.raw`[:=]\s*(?!\s))`, String.raw`[:=]\s*)`),
  "gi",
);

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

describe("credit joins", { timeout: 30_000 }, () => {
  it.each([
    ["codeClaims SEPARATOR", SEPARATOR, OLD_SEPARATOR],
    ["records CREDIT_SEPARATOR", CREDIT_SEPARATOR, OLD_SEPARATOR],
    ["enricher CREDIT_JOIN", CREDIT_JOIN, OLD_CREDIT_JOIN],
    ["musicbrainz NAME_JOIN", NAME_JOIN, OLD_NAME_JOIN],
  ])("%s splits a credit exactly as before", (_name, join, old) => {
    const split = (re: RegExp) => (credit: string) => credit.split(re);
    expect(disagreements(credits, split(join), split(old))).toEqual([]);
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
    expect(ms).toBeLessThan(400);
    expect(result).toEqual([credit]);
  });
});

describe("DISAMBIGUATION_NUMBER", { timeout: 30_000 }, () => {
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
    const without = (re: RegExp) => (name: string) => name.replace(re, "");
    expect(
      disagreements(names, without(DISAMBIGUATION_NUMBER), without(OLD_DISAMBIGUATION_NUMBER)),
    ).toEqual([]);
    expect(names.filter((name) => OLD_DISAMBIGUATION_NUMBER.test(name)).length).toBeGreaterThan(
      1000,
    );
  });

  it("reads a name with a long run of spaces quickly", () => {
    // About 2 s with the earlier expression.
    const name = `a${" ".repeat(60_000)}x`;
    const { ms, result } = timed(() => normalizeArtist(name));
    expect(ms).toBeLessThan(400);
    expect(result).toBe("a x");
  });
});

describe("SECRET_PAIR", { timeout: 30_000 }, () => {
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
          "Basic ",
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
    const redact = (re: RegExp) => (line: string) => line.replace(re, "$1$2[R]");
    expect(disagreements(lines, redact(SECRET_PAIR), redact(OLD_SECRET_PAIR))).toEqual([]);
    expect(
      lines.filter((line) => line.replace(OLD_SECRET_PAIR, "") !== line).length,
    ).toBeGreaterThan(500);
  });

  it("takes the scheme before a value, quoted or not, and no more", () => {
    for (const [line, expected] of [
      ["authorization: 'Bearer\tabc.def'", "authorization: [R]"],
      ["authorization: 'Bearer  abc.def'", "authorization: [R]"],
      ['authorization: "Basic  QWxhZGRp"', "authorization: [R]"],
      ["authorization: `Bearer abc.def`", "authorization: [R]"],
      ["authorization: 'Discogs token=abc123'", "authorization: [R]"],
      ["authorization: Bearer\n  abc.def", "authorization: [R]"],
      // Readable text: the scheme word alone, quoted, then words that are no token.
      ["authorization: 'Bearer' or 'Basic' expected", "authorization: [R] or 'Basic' expected"],
      ["token: 'Basic' is not supported", "token: [R] is not supported"],
      // A line break after a quoted scheme ends the value.
      ["authorization: 'Bearer\n  at Object.x'", "authorization: [R]\n  at Object.x'"],
      // Schemes in a row are taken together, with the word after them.
      ["authorization: 'Bearer Bearer abc.def'", "authorization: [R]"],
      ["authorization: Basic bearer abc.def", "authorization: [R]"],
      ["authorization: Bearer Bearer Bearer abc.def", "authorization: [R]"],
      // Unless that word starts another rule: then the first scheme alone, as before, and the
      // rules after it find the rest.
      ["authorization: 'Bearer token: abc.def'", "authorization: [R] token: [R]"],
      ["authorization: 'Bearer \"Bearer abc.def\"'", 'authorization: [R] "Bearer abc.def"\''],
      ["authorization: Bearer Bearer x/Bearer abc", "authorization: [R] x/Bearer abc"],
    ]) {
      expect(line.replace(SECRET_PAIR, "$1$2[R]"), line).toBe(expected);
    }
  });

  it("derives the earlier whitespace from SECRET_PAIR", () => {
    expect(OLD_SECRET_PAIR.source).not.toBe(SECRET_PAIR.source);
  });

  it("reads a long run of whitespace after a secret's name quickly", () => {
    // About 2 s with the earlier expression.
    const line = `token:${"\t".repeat(60_000)}]`;
    const { ms, result } = timed(() => line.replace(SECRET_PAIR, "$1$2[R]"));
    expect(ms).toBeLessThan(400);
    expect(result).toBe(line);
  });
});

describe("release labels in titles", { timeout: 30_000 }, () => {
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
    const without = (re: RegExp) => (title: string) => title.replace(re, "");
    expect(disagreements(titles, without(now), without(old))).toEqual([]);
    expect(titles.filter((title) => title.replace(old, "") !== title).length).toBeGreaterThan(150);
  });
});

describe("title helpers end to end", { timeout: 30_000 }, () => {
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
    // Up to about 30 ms on a first call; seconds before #194.
    for (const [name, helper] of helpers) {
      const { ms } = timed(() => helper(title));
      expect(ms, name).toBeLessThan(400);
    }
  });
});

describe("tempo mentions", { timeout: 30_000 }, () => {
  // The expressions before #194: two or three whitespace runs around an optional word, each
  // split of a long run tried in turn (quadratic; cubic for TEMPO_WORD).
  const NUMBER = String.raw`(\d{2,3}(?:[.,]\d{1,2})?)`;
  const NOT_IN_NUMBER = String.raw`(?<![\p{L}\p{N}.,])`;
  const UNIT = String.raw`\s*-?\s*(?:bpm\b|b\.p\.m\.|beats[\s-]+(?:per|a|each)[\s-]+minute\b)`;
  const tempo = tempoExpressions();
  const pairs: Array<[string, RegExp, RegExp]> = [
    ["TEMPO_UNIT_AFTER", tempo.unitAfter, new RegExp(`${NOT_IN_NUMBER}${NUMBER}${UNIT}`, "giu")],
    [
      "TEMPO_UNIT_BEFORE",
      tempo.unitBefore,
      new RegExp(
        String.raw`\b(?:bpm|b\.p\.m\.)\s*(?::|=|of|is|was|at)?\s*${NUMBER}(?![\p{N}%])`,
        "giu",
      ),
    ],
    [
      "TEMPO_RANGE",
      tempo.range,
      new RegExp(
        String.raw`(?:\bbetween\s+)?${NOT_IN_NUMBER}${NUMBER}\s*(?:-|–|—|to|and)\s*${NUMBER}${UNIT}`,
        "giu",
      ),
    ],
    [
      "TEMPO_WORD",
      tempo.word,
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
    expect(
      disagreements(
        texts,
        (text) => found(now, text),
        (text) => found(old, text),
      ),
    ).toEqual([]);
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
    expect(ms).toBeLessThan(400);
    expect(result).toEqual([]);
  });
  it("never shares its expressions: a caller's lastIndex leaves tempoMentions alone", () => {
    const text = "120 BPM, a driving groove";
    for (const expression of Object.values(tempoExpressions())) {
      expression.lastIndex = 0;
      expression.test(text);
      expression.exec(`${text} ${text}`);
    }
    expect(tempoMentions(text, true)).toEqual([{ field: "tempo", bpm: 120 }]);
  });
});

describe("featured-artist notes in titles", { timeout: 30_000 }, () => {
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
    ...allStrings(["(", ")", "[", " ", "feat. ", "with", "X", "\n"], 5),
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
    expect(
      disagreements(titles, featuredNotes, (title) => [...title.matchAll(NOTE)].map((m) => m[1])),
    ).toEqual([]);
    expect(
      disagreements(
        titles,
        featuredTail,
        (title) => [...title.matchAll(TAIL)].map((m) => m[1])[0] ?? null,
      ),
    ).toEqual([]);
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
    // Seconds for a rewrite that looked for the closing bracket again from every opening one,
    // or read the rest again for a bracket after every tail word.
    ["runs of opening brackets", `${"(".repeat(50_000)})`],
    ["tail words before a bracket", `${" feat. x".repeat(120_000)}(`],
  ])("reads %s quickly", (_name, title) => {
    // Up to about 40 ms here.
    const { ms } = timed(() => [featuredNotes(title), featuredTail(title)]);
    expect(ms).toBeLessThan(400);
  });
});

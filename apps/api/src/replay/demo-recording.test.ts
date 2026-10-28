/**
 * The committed demo recording (fixtures/replays/one-more-time-daft-punk.json) is what a
 * first-time visitor sees without any key configured. These checks pin what it is for: a run of
 * today's analyzer, recorded from a committed tree, that shows its measured key or why the key
 * was withheld, the release's cover from the Cover Art Archive, source errors in words, web
 * evidence without social pages, forum comment threads or private handles, and the app's own
 * messages without the prototype's copy or emoji. A recording that falls short is re-recorded
 * (npm run replay:record -w apps/api), never edited by hand.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisIssues, ReplayRecord } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { reasonIssue } from "../sources/http.js";
import { isSocialPage, webPageIssue, webTextIssue } from "../sources/search.js";
import { ARCHIVE_FRONT, archiveCoverOf } from "./cover.js";
import { leaks, publicTextsOf } from "./recorder.js";
import { DEFAULT_REPLAY_DIR, loadReplays } from "./records.js";

const record = ReplayRecord.parse(
  JSON.parse(readFileSync(join(DEFAULT_REPLAY_DIR, "one-more-time-daft-punk.json"), "utf8")),
);
const { analysis } = record;

// The honesty guard's own patterns (scripts/guard-honest.mjs): what it counts in the messages
// the app wrote into a recorded run.
const guard: {
  rules: Array<{ id: string; pattern: RegExp | RegExp[] }>;
} = await import(new URL("../../../../scripts/guard-honest.mjs", import.meta.url).href);
const patternsOf = (id: string) => [guard.rules.find((rule) => rule.id === id)!.pattern].flat();

/** The texts the app wrote into the recording's events (as the guard scans them). */
const appMessages = record.events.flatMap(({ event }) => {
  const fields = event as { type: string; message?: unknown; error?: unknown };
  const text =
    fields.type === "status" || fields.type === "interrupt"
      ? fields.message
      : fields.type === "error"
        ? fields.error
        : undefined;
  return typeof text === "string" ? [text] : [];
});

/** "2.3.0+essentia.models-…" as [2, 3]; null when it names no version. */
function versionOf(analyzer: string | null | undefined): [number, number] | null {
  const match = /^(\d+)\.(\d+)/.exec(analyzer ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}
const atLeast23 = (version: [number, number] | null) =>
  version !== null && (version[0] > 2 || (version[0] === 2 && version[1] >= 3));

const webEvidence = (analysis.evidence ?? []).filter((item) => item.sourceTier === "web");

/**
 * The recordings in `dir` that do not name the clean commit that made them (no commit, or one
 * marked "-dirty"), and the files that could not be loaded at all, as "<slug or file>: why".
 */
function uncleanRecordings(dir: string): string[] {
  const set = loadReplays(dir);
  return [
    ...set.problems,
    ...set.records.flatMap((r) =>
      r.commit === null || r.commit === undefined || r.commit.trim() === ""
        ? [`${r.slug}: no commit`]
        : r.commit.endsWith("-dirty")
          ? [`${r.slug}: recorded from uncommitted changes (${r.commit})`]
          : [],
    ),
  ];
}

describe("every committed recording", () => {
  it("loads, and names the clean commit that made it", () => {
    expect(loadReplays(DEFAULT_REPLAY_DIR).records.length).toBeGreaterThan(0);
    expect(uncleanRecordings(DEFAULT_REPLAY_DIR)).toEqual([]);
  });

  it("is checked one by one: a second recording stamped -dirty fails the check", () => {
    const dir = mkdtempSync(join(tmpdir(), "recordings-"));
    try {
      const file = "one-more-time-daft-punk.json";
      copyFileSync(join(DEFAULT_REPLAY_DIR, file), join(dir, file));
      expect(uncleanRecordings(dir)).toEqual([]);
      // Another track's recording (the showcase under another id, title and slug), made from a
      // working tree with uncommitted changes, as replay:record --allow-dirty stamps it.
      const text = readFileSync(join(DEFAULT_REPLAY_DIR, file), "utf8");
      const commit = record.commit as string;
      writeFileSync(
        join(dir, "second-showcase.json"),
        text
          .replaceAll(record.analysis.id, "0SecondShowcaseTrack00")
          .replaceAll(record.slug, "second-showcase")
          .replaceAll(record.analysis.title, "Second Showcase")
          .replaceAll(`"${commit}"`, `"${commit}-dirty"`),
      );
      expect(loadReplays(dir).records).toHaveLength(2);
      expect(uncleanRecordings(dir)).toEqual([
        `second-showcase: recorded from uncommitted changes (${commit}-dirty)`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the demo recording (one-more-time-daft-punk)", () => {
  it("was measured by analyzer 2.3 or later", () => {
    expect(record.analyzerVersion).not.toBeNull();
    expect(atLeast23(versionOf(record.analyzerVersion))).toBe(true);
    expect(analysis.audio?.analyzerVersion).toBe(record.analyzerVersion);
  });

  it("was recorded from a committed tree, so its commit names the code that made it", () => {
    expect(record.commit).not.toBeNull();
    expect(record.commit).not.toMatch(/-dirty$/);
  });

  it("shows the tempo measured from the signal, and copies of measured values that match it", () => {
    expect(analysis.audio?.tempo?.basis).toBe("signal");
    expect(analysisIssues(analysis)).toEqual([]);
  });

  it("shows its measured key, or the reason the key was withheld", () => {
    const audio = analysis.audio;
    expect(audio).toBeTruthy();
    if (audio?.key) {
      expect(audio.key.basis).toBe("signal");
    } else {
      expect(audio?.withheld?.key?.code).toBeTruthy();
      expect(audio?.withheld?.key?.reason.trim()).not.toBe("");
    }
  });

  it("carries the Cover Art Archive front image of the release its evidence names", () => {
    expect(analysis.coverUrl).toMatch(ARCHIVE_FRONT);
    expect(analysis.coverUrl).toBe(archiveCoverOf(analysis));
  });

  it("states its source errors in words, without markup, a stack trace, a token or a link", () => {
    for (const error of analysis.run?.sourceErrors ?? []) {
      expect(error.message).not.toMatch(/<\/?[a-z!][^>]*>|&lt;|&#\d+;/i);
      expect(reasonIssue(error.message ?? ""), error.source).toBeNull();
    }
  });

  it("keeps social pages, private handles and profile boilerplate out of its web evidence", () => {
    for (const item of webEvidence) {
      expect(isSocialPage(item.url ?? ""), item.url ?? "").toBe(false);
      for (const text of [item.title ?? "", item.excerpt ?? ""]) {
        expect(webTextIssue(text), item.url ?? "").toBeNull();
        expect(text).not.toMatch(/profile (?:picture|photo)/i);
      }
    }
  });

  it("keeps forum pages and forum comment bylines out of its web evidence", () => {
    for (const item of webEvidence) {
      const page = { url: item.url, title: item.title, text: item.excerpt ?? "" };
      expect(webPageIssue(page), item.url ?? "").toBeNull();
    }
  });

  it("passes the recorder's leak check: no signed or preview URL, credential or markup", () => {
    expect(
      leaks(record, {
        secrets: [],
        typedQuery: record.request.query,
        publicTexts: publicTextsOf(analysis),
        allowedCover: archiveCoverOf(analysis),
      }),
    ).toEqual([]);
  });

  it("writes its progress without the prototype's copy or emoji (the guard's patterns)", () => {
    expect(appMessages.length).toBeGreaterThan(0);
    const patterns = [
      ...patternsOf("prototype-copy-recordings"),
      ...patternsOf("emoji-in-recordings"),
    ];
    const flagged = appMessages.filter((message) =>
      patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(message)),
    );
    expect(flagged).toEqual([]);
  });
});

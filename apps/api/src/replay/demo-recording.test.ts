/**
 * The committed showcase recordings (fixtures/replays/*.json) are what a first-time visitor sees
 * without any key configured; One More Time (one-more-time-daft-punk.json) is the first. These
 * checks pin what each is for: a run of today's analyzer, recorded from a committed tree, that
 * shows its measured tempo and key (or why the key was withheld) and never a measured value from
 * model text, the model's claims judged by the verifier, a song-relations map built by code from
 * MusicBrainz relationships and dated by MusicBrainz, the release's cover from the Cover Art
 * Archive, source errors in words, web evidence without social pages, forum comment threads or
 * private handles, and the app's own messages without the prototype's copy or emoji. A recording
 * that falls short is re-recorded (npm run replay:record -w apps/api), never edited by hand.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisIssues, type ReplayRecord } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { reasonIssue } from "../sources/http.js";
import { isSocialPage, webPageIssue, webTextIssue } from "../sources/search.js";
import { ARCHIVE_FRONT, archiveCoverOf } from "./cover.js";
import { leaks, publicTextsOf } from "./recorder.js";
import { DEFAULT_REPLAY_DIR, loadReplays } from "./records.js";
import { DEMO_SLUG, readRecording, recordingSlugs } from "./testing/recordings.js";

const SLUGS = recordingSlugs();
const demo = readRecording(DEMO_SLUG);
/** The demo's track, as scripts/replay-e2e.mjs (TRACK_ID) and the web specs open it. */
const DEMO_TRACK_ID = "0DiWol3AO6WpXZgp0goxAV";

// The honesty guard's own patterns (scripts/guard-honest.mjs): what it counts in the messages
// the app wrote into a recorded run.
const guard: {
  rules: Array<{ id: string; pattern: RegExp | RegExp[] }>;
} = await import(new URL("../../../../scripts/guard-honest.mjs", import.meta.url).href);
const patternsOf = (id: string) => [guard.rules.find((rule) => rule.id === id)!.pattern].flat();

/** The texts the app wrote into a recording's events (as the guard scans them). */
const appMessagesOf = (record: ReplayRecord) =>
  record.events.flatMap(({ event }) => {
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
      const file = `${DEMO_SLUG}.json`;
      copyFileSync(join(DEFAULT_REPLAY_DIR, file), join(dir, file));
      expect(uncleanRecordings(dir)).toEqual([]);
      // Another track's recording (the showcase under another id, title and slug), made from a
      // working tree with uncommitted changes, as replay:record --allow-dirty stamps it.
      const text = readFileSync(join(DEFAULT_REPLAY_DIR, file), "utf8");
      const commit = demo.commit as string;
      writeFileSync(
        join(dir, "second-showcase.json"),
        text
          .replaceAll(demo.analysis.id, "0SecondShowcaseTrack00")
          .replaceAll(demo.slug, "second-showcase")
          .replaceAll(demo.analysis.title, "Second Showcase")
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

  it("are each found by search as replay-e2e A3 reads it: 'dyn' finds none, 'daft' the demo first", () => {
    const set = loadReplays(DEFAULT_REPLAY_DIR);
    expect(set.records.map((r) => r.slug)).toEqual(SLUGS);
    expect(set.suggestions("dyn", 8)).toEqual([]);
    expect(set.suggestions("daft", 8)[0]?.id).toBe(DEMO_TRACK_ID);
    // Each showcase is found by its own curated query, and by no other's.
    for (const record of set.records) {
      expect(set.forQuery(record.request.query)?.slug, record.request.query).toBe(record.slug);
    }
  });
});

describe("the demo recording (one-more-time-daft-punk)", () => {
  it("is One More Time by Daft Punk, the track the replay checks and the specs open", () => {
    expect(SLUGS).toContain(DEMO_SLUG);
    expect(demo.analysis.id).toBe(DEMO_TRACK_ID);
    expect(demo.analysis.title).toBe("One More Time");
    expect(demo.analysis.artist).toBe("Daft Punk");
    expect(demo.request.query).toBe("One More Time Daft Punk");
  });
});

describe.each(SLUGS)("the showcase recording %s", (slug) => {
  const record = readRecording(slug);
  const { analysis } = record;
  const webEvidence = (analysis.evidence ?? []).filter((item) => item.sourceTier === "web");
  const appMessages = appMessagesOf(record);
  const { nodes, links } = analysis.genealogy;
  const current = nodes.find((node) => node.group === 1);

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

  it("never shows a measured field from model text: each copy matches the signal's value", () => {
    // analysisIssues holds measuredCopyIssues: bpm and key are the measured values or nothing.
    expect(analysisIssues(analysis)).toEqual([]);
    const audio = analysis.audio;
    for (const field of [audio?.tempo, audio?.key, audio?.loudness]) {
      if (field) expect(field.basis).toBe("signal");
    }
    if (analysis.bpm !== null && analysis.bpm !== undefined) {
      expect(audio?.tempo?.bpm, "a bpm with no measured tempo").toBeDefined();
    }
    if (analysis.key) expect(audio?.key, "a key with no measured key").toBeTruthy();
  });

  it("carries the verifier's judgement of every claim the model wrote (the judge's cassette)", () => {
    const verifier = analysis.run?.verifier;
    expect(verifier, "no verifier counts: recorded with the verifier off").toBeTruthy();
    expect(verifier?.judged).toBeGreaterThan(0);
    expect(verifier?.unjudged).toBe(0);
    for (const claim of (analysis.claims ?? []).filter((c) => c.origin === "model")) {
      expect(claim.verdict, `claim ${claim.id} has no verdict`).not.toBeNull();
    }
    // The judge's calls are in the recorded usage.
    expect(record.usage?.llmCalls ?? 0).toBeGreaterThan(0);
  });

  it("draws a song-relations map from MusicBrainz relationships, each link with its real type", () => {
    expect(current, "no analysed-track node").toBeTruthy();
    const evidence = new Map((analysis.evidence ?? []).map((item) => [item.id, item]));
    const fromRecords = links.filter((link) => link.origin === "code");
    expect(fromRecords.length).toBeGreaterThan(0);
    for (const link of fromRecords) {
      const what = `${link.source} -> ${link.target}`;
      expect(link.type, what).toBeTruthy();
      expect(link.evidenceIds?.length ?? 0, what).toBeGreaterThan(0);
      for (const id of link.evidenceIds ?? []) {
        expect(evidence.get(id)?.source, `${what}: ${id}`).toBe("musicbrainz");
      }
    }
    expect(fromRecords.filter((link) => link.kind === "sourced").length).toBeGreaterThan(0);
  });

  it("dates related tracks by MusicBrainz only: a year names its MusicBrainz recording", () => {
    const dated = nodes.filter((node) => node !== current && node.year !== undefined);
    expect(dated.length, "no related track has a MusicBrainz year").toBeGreaterThan(0);
    for (const node of dated)
      expect(node.mbid, `${node.id} has a year without an mbid`).toBeTruthy();
  });
});

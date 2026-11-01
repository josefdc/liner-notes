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
 *
 * The showcase is the golden run's (evals/agent/runs/2026-10-31), chosen by
 * evals/agent/showcase.mjs (whose own test checks that its choice is this set): each recording is
 * one of that run's analyses, its whole result as the run's committed result holds it, and
 * together they span at least MIN_TRACKS tracks and MIN_STYLES styles. A track's style is MusicBrainz's genre as evals/showcase-styles.json records it (with
 * the lookup's URL), never model text and never the audio service's style classifier; two styles
 * are one when their names are equal lower-cased.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analysisIssues, type ReplayRecord } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { API_ROOT } from "../config/apiPackage.js";
import { reasonIssue } from "../sources/http.js";
import { isSocialPage, webPageIssue, webTextIssue } from "../sources/search.js";
import { ARCHIVE_FRONT, archiveCoverOf } from "./cover.js";
import { leaks, publicTextsOf } from "./recorder.js";
import { DEFAULT_REPLAY_DIR, loadReplays } from "./records.js";
import { DEMO_SLUG, readRecording, recordingSlugs } from "./testing/recordings.js";

const SLUGS = recordingSlugs();
const REPO = resolve(API_ROOT, "..", "..");
/** The golden run the showcase is recorded from: its committed run records. */
const GOLDEN_RUN_DIR = join(REPO, "evals", "agent", "runs", "2026-10-31");
/** Each golden row's MusicBrainz genre (evals/agent/fetch-styles.mjs). */
const STYLES_PATH = join(REPO, "evals", "showcase-styles.json");
const MIN_TRACKS = 5;
const MIN_STYLES = 4;

interface GoldenRun {
  runId: string;
  isrc: string;
  repeat?: number;
  commit: string;
  /** When the run started; the recording's time is when it completed. */
  recordedAt: string;
  latencyMs: number;
}
interface StyleEntry {
  isrc: string;
  mbid: string;
  style: string | null;
  level: string | null;
  votes: number | null;
  url: string | null;
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/**
 * The golden run's analysis a recording was made from: the first run (row d, after the verifier)
 * whose committed result is the recording's track, with the commit it ran at, that completed
 * when the recording says (within 5 s of its start plus its latency); null for none. With the
 * run's committed result (results/<isrc>.json, normalised: lib/record.mjs).
 */
function goldenRunOf(record: ReplayRecord): { run: GoldenRun; result: GoldenResult } | null {
  const runs = readJson<GoldenRun[]>(join(GOLDEN_RUN_DIR, "d.json"));
  for (const run of runs.filter((each) => (each.repeat ?? 0) === 0)) {
    const result = readJson<GoldenResult>(join(GOLDEN_RUN_DIR, "results", `${run.isrc}.json`));
    const completed = Date.parse(run.recordedAt) + run.latencyMs;
    const when = Math.abs(Date.parse(record.recordedAt) - completed) <= 5000;
    if (result.id === record.analysis.id && run.commit === record.commit && when) {
      return { run, result };
    }
  }
  return null;
}
type GoldenResult = { id: string; audio?: unknown; queryMatch?: unknown } & Record<string, unknown>;

// The golden run's own normalisation (the masks its replay compares results under).
const goldenRecords: {
  normalisedResult: (events: unknown[]) => Record<string, unknown> | null;
  resultDifferences: (a: unknown, b: unknown, limit?: number) => string[];
} = await import(new URL("../../../../evals/agent/lib/record.mjs", import.meta.url).href);
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
  it("are the golden run's six showcases, no more and no fewer: a change to the set is made here", () => {
    // As evals/agent/showcase.mjs chooses them (evals/agent/showcase.test.mjs checks it does).
    expect(SLUGS).toEqual([
      "gangnam-style-psy",
      "hung-up-madonna",
      "natural-blues-moby",
      "one-more-time-daft-punk",
      "praise-you-fatboy-slim",
      "the-verve-bitter-sweet-symphony",
    ]);
  });

  it("are each one of the golden run's analyses, with the measured audio block its record holds", () => {
    const unmatched = SLUGS.filter((slug) => goldenRunOf(readRecording(slug)) === null);
    expect(unmatched, "recordings that are no analysis of the golden run").toEqual([]);
    for (const slug of SLUGS) {
      const record = readRecording(slug);
      const golden = goldenRunOf(record);
      // The measured block exactly as the run measured it: never edited, never re-measured.
      expect(record.analysis.audio, slug).toEqual(golden?.result.audio);
      expect(record.analysis.audio?.tempo?.basis, slug).toBe("signal");
      expect(record.analysis.coverUrl, slug).toMatch(ARCHIVE_FRONT);
    }
  });

  it("each hold the whole result their run showed: its claims, cards, map and evidence", () => {
    for (const slug of SLUGS) {
      const record = readRecording(slug);
      const golden = goldenRunOf(record);
      if (!golden) throw new Error(`${slug}: no golden run`);
      // The recording under the golden run's masks (ids by order of first appearance, no run
      // stamps, no preview link, no read times; the cover compared apart above). Only how the
      // recorded run's search text matched the track differs: the recorder leaves it out, since
      // a recording is replayed for other texts (recorder.ts). An excerpt the recorder withholds
      // (a long token-shaped run) or an image it blanks would differ too: none of these does.
      const recorded = goldenRecords.normalisedResult([
        { type: "complete", data: record.analysis },
      ]);
      const { queryMatch, ...expected } = golden.result;
      expect(queryMatch, slug).toBe("exact");
      expect(goldenRecords.resultDifferences(expected, recorded), slug).toEqual([]);
    }
  });

  it(`span at least ${MIN_TRACKS} tracks and ${MIN_STYLES} styles, each MusicBrainz's genre with its lookup`, () => {
    const styles = new Map(
      readJson<{ rows: StyleEntry[] }>(STYLES_PATH).rows.map((row) => [row.isrc, row]),
    );
    const tracks = SLUGS.map((slug) => {
      const golden = goldenRunOf(readRecording(slug));
      const entry = golden ? styles.get(golden.run.isrc) : undefined;
      return { slug, isrc: golden?.run.isrc ?? null, entry };
    });
    const unstyled = tracks.filter(({ entry }) => !entry?.style || !entry.url);
    expect(
      unstyled.map(({ slug }) => slug),
      "showcases without a MusicBrainz genre",
    ).toEqual([]);
    for (const { slug, entry } of tracks) {
      expect(entry?.url, slug).toMatch(/^https:\/\/musicbrainz\.org\/ws\/2\/[^?]+\?inc=genres/);
      expect(["recording", "release-group", "artist"], slug).toContain(entry?.level);
      expect(entry?.votes ?? 0, slug).toBeGreaterThan(0);
    }
    expect(new Set(tracks.map(({ isrc }) => isrc)).size).toBeGreaterThanOrEqual(MIN_TRACKS);
    const distinct = new Set(tracks.map(({ entry }) => entry?.style?.trim().toLowerCase()));
    expect(distinct.size, [...distinct].join(", ")).toBeGreaterThanOrEqual(MIN_STYLES);
  });

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

  it("was recorded from a run that read everything: no line says a later run reads the rest", () => {
    // A replay never runs again, so a run's promise that a later one completes it is false in a
    // recording; the run the warning comes from is recorded again instead.
    const incomplete = /\ba later run\b|\bincomplete\b/i;
    const errors = (analysis.run?.sourceErrors ?? []).map((error) => error.message ?? "");
    expect([...appMessages, ...errors].filter((text) => incomplete.test(text))).toEqual([]);
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

  it("carries the verifier's judgement of every model claim with evidence (the judge's cassette)", () => {
    const verifier = analysis.run?.verifier;
    expect(verifier, "no verifier counts: recorded with the verifier off").toBeTruthy();
    expect(verifier?.judged).toBeGreaterThan(0);
    expect(verifier?.unjudged).toBe(0);
    for (const claim of (analysis.claims ?? []).filter((c) => c.origin === "model")) {
      if (claim.evidenceIds.length > 0) {
        expect(claim.verdict, `claim ${claim.id} has no verdict`).not.toBeNull();
      } else {
        // Nothing to judge it against: shown as inferred, never as judged.
        expect(claim.kind, `claim ${claim.id}`).toBe("inferred");
        expect(claim.verdict, `claim ${claim.id}`).toBeNull();
      }
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

  it("dates each track by its own MusicBrainz record in the recording: the year it gives, and none without one", () => {
    // The track's own record is its `track/` item; a related track's, its relations map
    // record of that recording. A node's year is the year that record's excerpt gives.
    const evidence = new Map((analysis.evidence ?? []).map((item) => [item.id, item]));
    const yearIn = (id: string) => {
      const match = /\bfirst released (\d{4})\b/.exec(evidence.get(id)?.excerpt ?? "");
      return match ? Number(match[1]) : undefined;
    };
    for (const node of nodes) {
      const id = !node.mbid
        ? null
        : node === current
          ? `musicbrainz:track/recording/${node.mbid}`
          : `musicbrainz:recording/${node.mbid}`;
      const recorded = id === null ? undefined : yearIn(id);
      expect(node.year ?? undefined, `${node.id}: its year, and ${id}'s`).toBe(recorded);
    }
  });
});

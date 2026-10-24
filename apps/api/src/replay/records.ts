/**
 * The recorded runs the API can replay: one ReplayRecord (@liner-notes/contract) per file,
 * `<slug>.json` in the replay directory (REPLAY_DIR, by default fixtures/replays at the
 * repository root). They are written by the recorder (recorder.ts) from a stored live run.
 *
 * The files are read once, at first use, and each is checked strictly: the record's schema and
 * refinements, and the run rules of a replay (`runIssues`: it says when and from which commit
 * it was recorded). A file that fails is logged and left out; it is never served in part. The
 * result's other producer rules (`analysisIssues`) are logged for each record that breaks them,
 * so a recording made before a producer fix stays visible until it is recorded again.
 *
 * Each record has a digest of its content: a stored replayed run names the digest of what it
 * was sent, and is served again only from a record with that same content.
 *
 * A query finds a record only when it names the recorded track exactly (after normalising case,
 * accents and punctuation): its title and artist in either order, or the record's curated query.
 * There is no nearest match: any other query has no recording.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  analysisIssues,
  ReplayRecord,
  runIssues,
  type SearchCandidate,
} from "@liner-notes/contract";
import { API_ROOT } from "../config/apiPackage.js";

/** fixtures/replays at the repository root. */
export const DEFAULT_REPLAY_DIR = resolve(API_ROOT, "..", "..", "fixtures", "replays");

/** The replay directory: REPLAY_DIR (a relative path is taken from the API package), or the default. */
export function replayDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.REPLAY_DIR?.trim();
  if (!configured) return DEFAULT_REPLAY_DIR;
  return isAbsolute(configured) ? configured : resolve(API_ROOT, configured);
}

/** Lower case, without accents, with every run of punctuation and spaces as one space. */
export function normalizeQuery(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The queries that name a record's track exactly, normalised. */
export function recordAliases(record: ReplayRecord): string[] {
  const { title, artist } = record.analysis;
  return [
    ...new Set(
      [
        record.request.query,
        `${title} ${artist}`,
        `${artist} ${title}`,
        `${title} by ${artist}`,
      ].map(normalizeQuery),
    ),
  ].filter(Boolean);
}

export interface ReplaySet {
  readonly dir: string;
  readonly records: readonly ReplayRecord[];
  /** Files left out, with the reason (logged when loaded). */
  readonly problems: readonly string[];
  /** Producer rules the records' results break (logged when loaded; the records are kept). */
  readonly warnings: readonly string[];
  /** The sha256 of a loaded record's file content (its JSON, whitespace aside). */
  digest(record: ReplayRecord): string;
  /** The loaded record with this slug and content digest, or null. */
  forDigest(slug: string, digest: string): ReplayRecord | null;
  /** The record whose track the query names exactly, or null. */
  forQuery(query: string): ReplayRecord | null;
  /** The record of a Spotify track id, or null. */
  forTrack(spotifyId: string): ReplayRecord | null;
  /** The record of a track named by its exact title and artist (both required); or null. */
  forTitle(title: string, artist?: string): ReplayRecord | null;
  /**
   * Search suggestions from the records: the tracks whose title, artist and album have a word
   * starting with each word of the query, at most `limit`.
   */
  suggestions(query: string, limit: number): SearchCandidate[];
}

/** A record as a search suggestion (no image: recordings keep no image URLs). */
function suggestion(record: ReplayRecord): SearchCandidate {
  const { id, title, artist, album, coverUrl, releaseYear, isrc } = record.analysis;
  return {
    id,
    title,
    artist,
    album,
    coverUrl,
    ...(releaseYear !== undefined && { releaseYear }),
    ...(isrc !== undefined && { isrc }),
  };
}

/** Reads and checks every record in `dir`. A missing directory holds no records. */
export function loadReplays(dir: string): ReplaySet {
  const records: ReplayRecord[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const digests = new Map<ReplayRecord, string>();
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`${dir}: cannot be read (${(err as Error).message})`);
    }
  }

  const byAlias = new Map<string, ReplayRecord>();
  const byTrack = new Map<string, ReplayRecord>();
  for (const file of files) {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      problems.push(`${file}: not JSON (${(err as Error).message})`);
      continue;
    }
    const parsed = ReplayRecord.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      problems.push(`${file}: not a replay record (${issues.slice(0, 5).join("; ")})`);
      continue;
    }
    const record = parsed.data;
    const issues = record.analysis.run
      ? runIssues(record.analysis.run, record.analysis.audio, "analysis.run")
      : ["analysis.run: missing"];
    if (issues.length > 0) {
      problems.push(`${file}: the recorded run information is wrong (${issues.join("; ")})`);
      continue;
    }
    if (record.slug !== basename(file, ".json")) {
      problems.push(`${file}: slug "${record.slug}" does not match the file name`);
      continue;
    }
    if (byTrack.has(record.analysis.id)) {
      problems.push(`${file}: a second record of track ${record.analysis.id}`);
      continue;
    }
    const aliases = recordAliases(record);
    const taken = aliases.find((alias) => byAlias.has(alias));
    if (taken) {
      problems.push(`${file}: the query "${taken}" already names another record`);
      continue;
    }
    for (const alias of aliases) byAlias.set(alias, record);
    byTrack.set(record.analysis.id, record);
    records.push(record);
    // The digest of the file's JSON as written (whitespace aside), not of the parsed record: a
    // contract change that parses it differently does not change what the record holds.
    digests.set(record, createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
    for (const issue of analysisIssues(record.analysis)) {
      if (!issues.includes(issue)) warnings.push(`${file}: the recorded result breaks ${issue}`);
    }
  }

  return {
    dir,
    records,
    problems,
    warnings,
    digest: (record) => {
      const digest = digests.get(record);
      if (!digest) throw new Error(`Replay record ${record.slug} was not loaded here`);
      return digest;
    },
    forDigest: (slug, digest) =>
      records.find((record) => record.slug === slug && digests.get(record) === digest) ?? null,
    forQuery: (query) => byAlias.get(normalizeQuery(query)) ?? null,
    forTrack: (spotifyId) => byTrack.get(spotifyId) ?? null,
    forTitle(title, artist) {
      if (!artist) return null;
      const wanted = `${normalizeQuery(title)}\n${normalizeQuery(artist)}`;
      return (
        records.find(
          (record) =>
            `${normalizeQuery(record.analysis.title)}\n${normalizeQuery(record.analysis.artist)}` ===
            wanted,
        ) ?? null
      );
    },
    suggestions(query, limit) {
      const words = normalizeQuery(query).split(" ").filter(Boolean);
      if (words.length === 0) return [];
      return records
        .filter((record) => {
          const { title, artist, album } = record.analysis;
          const haystack = normalizeQuery(`${title} ${artist} ${album}`).split(" ");
          return words.every((word) => haystack.some((token) => token.startsWith(word)));
        })
        .slice(0, limit)
        .map(suggestion);
    },
  };
}

let loaded: ReplaySet | null = null;

/** The records of the replay directory, read at first use (and again when REPLAY_DIR changes). */
export function replays(env: NodeJS.ProcessEnv = process.env): ReplaySet {
  const dir = replayDir(env);
  if (loaded?.dir === dir) return loaded;
  loaded = loadReplays(dir);
  for (const problem of loaded.problems) console.error(`[Replay] Record left out: ${problem}`);
  for (const warning of loaded.warnings) console.warn(`[Replay] ${warning}`);
  console.log(`[Replay] ${loaded.records.length} recorded runs in ${dir}`);
  return loaded;
}

/** For tests: forgets the records read, so the next use reads the directory again. */
export function resetReplaysForTests(): void {
  loaded = null;
}

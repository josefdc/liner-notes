/**
 * The run's evidence, as the historian collects it: the primary sources read from the track's
 * ISRC (MusicBrainz, Discogs, SecondHandSongs, Genius), started while the research runs, and
 * the web search's results, put in one evidence pack and sent as `evidence` events.
 *
 * Every primary-source error is a source error of the run, and keeps the composer from storing
 * the result and the historian from caching the research, with two exceptions: a source that is
 * not configured (Discogs, Genius without their credential: the result and research keys name
 * them), and an answer of a shape the reader does not know, returned in `lasting`; both are
 * stored with the result and the research and reported again when either is served. A source
 * that answered but lost records to a failed request (the MusicBrainz work, and so its covers)
 * is also returned in `lost`, and the status says the records are incomplete.
 *
 * The research cache holds the pack (`cachedEvidenceOf`); a hit gives it back
 * (`cachedRunEvidence`) with the same items, errors and status lines, and asks no primary source.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { SourceError, SourceId } from "@liner-notes/contract";
import type { CachedEvidence } from "../../store/cache.js";
import {
  collectPrimarySources,
  DATES_INCOMPLETE,
  RELEASES_INCOMPLETE,
  type IdentifiedRecording,
  type PrimarySources,
} from "../../sources/identity.js";
import { SOURCE_NAMES } from "../prompts.js";
import { trackQuery, uniqueErrors, unreadableStatus } from "../researcherSubgraph.js";
import { lostRecordsLine } from "../statusText.js";
import { type AgentRuntime, timestampOf } from "../runtime.js";
import type { SpotifyData } from "../state.js";
import { discogsConfigured } from "../../sources/discogs.js";
import { geniusConfigured } from "../../sources/genius.js";
import type { SearchedTrack } from "./plan.js";
import {
  EvidencePack,
  lastingErrors,
  notAskedSources,
  lostRecords,
  primaryRecordEvidence,
  primarySourceErrors,
  restoredEvidence,
  type SourcedEvidence,
  type WebFinding,
  webSearchEvidence,
} from "./evidencePack.js";

/** The primary sources' answers, or the failure of the collection (a bug: it never throws). */
export type PrimaryRun = Promise<
  | { status: "read"; sources: PrimarySources }
  | { status: "not_asked"; why: "no_isrc" | "isrc_unread" }
  | { status: "threw"; error: unknown }
>;

/** The primary sources' run, and the recording the ISRC identified as soon as it is known. */
export interface PrimaryStart {
  run: PrimaryRun;
  /**
   * The identified recording, or null (no ISRC, no match, MusicBrainz could not be read): the
   * run's one ISRC lookup, read by the researcher and the composer. Never rejects.
   */
  recording: Promise<IdentifiedRecording | null>;
}

/**
 * Starts reading the primary sources for the track from its ISRC (none without one). The
 * collection never throws; a cancelled run reads as unavailable sources, and the caller stops
 * on the signal. `isrcUnread`: the track's Spotify details could not be read, so a missing ISRC
 * is unknown rather than absent, and the status says so.
 */
export function startPrimarySources(
  spotify: SpotifyData,
  isrc: string | null,
  signal: AbortSignal | undefined,
  runtime: AgentRuntime,
  isrcUnread = false,
): PrimaryStart {
  if (!isrc) {
    const why = isrcUnread ? "isrc_unread" : "no_isrc";
    return { run: Promise.resolve({ status: "not_asked", why }), recording: Promise.resolve(null) };
  }
  const { names } = trackQuery(spotify);
  let identified: (recording: IdentifiedRecording | null) => void = () => {};
  const recording = new Promise<IdentifiedRecording | null>((resolve) => {
    identified = resolve;
  });
  const run: PrimaryRun = collectPrimarySources(
    {
      isrc,
      title: spotify.title,
      artists: names,
      durationMs: spotify.durationMs > 0 ? spotify.durationMs : null,
      album: spotify.album || null,
    },
    { signal, now: runtime.now, onRecording: (found) => identified(found) },
  ).then(
    (sources) => ({ status: "read" as const, sources }),
    (error: unknown) => ({ status: "threw" as const, error }),
  );
  // The collection tells the recording once; if it threw first, there is none.
  void run.then(() => identified(null));
  return { run, recording };
}

export interface RunEvidence {
  evidence: SourcedEvidence[];
  /** The primary sources' errors, for the run's source errors. */
  errors: SourceError[];
  /** Those of `errors` whose source lost records: the run is not complete. */
  lost: SourceError[];
  /** Those of `errors` that are lasting (an answer of a shape the reader does not know). */
  lasting: SourceError[];
  /**
   * The recording's MusicBrainz sample relations as a research entry ("[MusicBrainz Samples]
   * […]"), for the result built without the model (its Sample DNA cards); empty when none.
   */
  samples: string[];
  /** How many items the pack's size cap left out. */
  omitted: number;
  /**
   * What the run could not read for a reason of its own, which is no source error and does not
   * block caching: a source our pacing did not ask, the work's recordings not dated in time.
   */
  incomplete: Incomplete[];
  /** Whether the identified recording is its song's original recording. */
  trackIsOriginal: boolean;
  status: string[];
}

/** A part of the primary sources a run did not read (`RunEvidence.incomplete`). */
export type Incomplete = CachedEvidence["incomplete"][number];

/**
 * The matched recording's sample relations (both directions, about the recording itself) as the
 * research entry the result built without the model reads: "source" for a recording this one
 * samples, "derived" for one that samples it.
 */
export function musicBrainzSampleEntries(sources: PrimarySources): string[] {
  const { musicbrainz } = sources;
  if (musicbrainz.status !== "found") return [];
  const relations = musicbrainz.records.flatMap((r) =>
    r.about === "track" && r.recording && (r.kind === "samples" || r.kind === "sampled-by")
      ? [
          {
            type: "sample",
            direction: r.kind === "samples" ? "source" : "derived",
            title: r.recording.title,
            artist: r.recording.artist,
            mbid: r.recording.mbid,
            relationshipType: "samples material",
          },
        ]
      : [],
  );
  return relations.length > 0 ? [`[MusicBrainz Samples] ${JSON.stringify(relations)}`] : [];
}

type StatusCode = "RESEARCH-FOUND" | "SYS-WARN";

/** What the primary sources gave a run: their records, errors and status lines. */
interface PrimaryOutcome {
  records: SourcedEvidence[];
  errors: SourceError[];
  lost: SourceError[];
  lasting: SourceError[];
  samples: string[];
  incomplete: Incomplete[];
  trackIsOriginal: boolean;
  found: string[];
  warnings: string[];
}

/** The status line of a source whose request was not sent: not a source error. */
const notAskedNote = (source: SourceId, why: "pace" | "deadline") =>
  why === "pace"
    ? `${SOURCE_NAMES[source]} not asked: our own pacing of its requests left no time in this run; a later run asks it`
    : `${SOURCE_NAMES[source]} not asked: the run's time for the primary sources ran out first; a later run asks it`;

/** The status line of a source the cached run did not ask. */
const cachedNotAskedNote = (source: SourceId, readAt: string) =>
  `${SOURCE_NAMES[source]} not asked: the research cached on ${readAt.slice(0, 10)} did not ask it; a later run asks it`;

/**
 * The status line of a run whose MusicBrainz releases could not be read: no release is named
 * for the recording (its cover in a recording), and a later run reads them again.
 */
const RELEASES_NOTE =
  "MusicBrainz releases incomplete: the recording's releases could not be read, so no release is named for it; a later run reads them";

const DATES_NOTE =
  "MusicBrainz release dates incomplete: the work's recordings could not be dated, so its covers are not claimed for this recording; a later run reads them";

/** The status lines of a track whose primary sources were not asked: they are read by its ISRC. */
const NO_ISRC_LINE = "Primary sources not asked: the track has no ISRC";
const ISRC_UNREAD_LINE =
  "Primary sources not asked: the track's ISRC could not be read from Spotify";

const recordsCount = (n: number) => `${n} ${n === 1 ? "record" : "records"}`;

/** The status line of the primary-source records this run read. */
function recordsLine(records: readonly SourcedEvidence[]): string {
  return `Read ${recordsCount(records.length)} from the primary sources (${countsBySource(records)})`;
}

/** The outcome of reading the primary sources for this run. */
function readOutcome(read: Awaited<PrimaryRun>): PrimaryOutcome {
  if (read.status !== "read") {
    return {
      records: [],
      errors: [],
      lost: [],
      lasting: [],
      samples: [],
      incomplete: [],
      trackIsOriginal: false,
      found: [
        read.status === "not_asked" && read.why === "isrc_unread" ? ISRC_UNREAD_LINE : NO_ISRC_LINE,
      ],
      warnings: [],
    };
  }
  const samples = musicBrainzSampleEntries(read.sources);
  const records = primaryRecordEvidence(read.sources);
  const { musicbrainz } = read.sources;
  // Without MusicBrainz the others are not asked: nothing was read, which is not "no match".
  const unread =
    musicbrainz.status === "missing" && musicbrainz.error
      ? `Primary sources: none could be read (${SOURCE_NAMES.musicbrainz} could not be read)`
      : null;
  const found = [
    records.length > 0
      ? recordsLine(records)
      : (unread ?? "Primary sources: no record matched the track"),
  ];
  const errors = uniqueErrors(primarySourceErrors(read.sources));
  const lasting = lastingErrors(read.sources);
  const losses = lostRecords(read.sources);
  const lost = losses.map(({ error }) => error);
  const warnings: string[] = [];
  // In words: the note and the error's message can hold the request's error text.
  for (const { error } of losses) warnings.push(lostRecordsLine(error));
  warnings.push(...unreadableStatus(errors.filter((e) => !lost.includes(e))));
  const incomplete: Incomplete[] = [];
  // Nothing was lost, but the covers are less specific than a later run may give: said once.
  if (musicbrainz.status === "found" && musicbrainz.incomplete?.includes(DATES_INCOMPLETE)) {
    incomplete.push({ source: "musicbrainz", part: "dates" });
    warnings.push(DATES_NOTE);
  }
  // Nothing was lost but the release that stands for the recording: no error, a later run reads it.
  if (musicbrainz.status === "found" && musicbrainz.incomplete?.includes(RELEASES_INCOMPLETE)) {
    incomplete.push({ source: "musicbrainz", part: "releases" });
    warnings.push(RELEASES_NOTE);
  }
  for (const { source, why } of notAskedSources(read.sources)) {
    incomplete.push({ source, part: "not_asked" });
    warnings.push(notAskedNote(source, why));
  }
  const trackIsOriginal = read.sources.identity?.original.original ?? false;
  return { records, errors, lost, lasting, samples, incomplete, trackIsOriginal, found, warnings };
}

/**
 * The evidence pack from the primary sources' outcome and the web-tier items, sent as
 * `evidence` events, with its status lines (also sent). `omittedBefore` counts items a cached
 * pack had already left out.
 */
function packOf(
  primary: PrimaryOutcome,
  web: readonly SourcedEvidence[],
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
  omittedBefore = 0,
): RunEvidence {
  const pack = new EvidencePack();
  pack.addAll(primary.records);
  pack.addAll(web);
  const omitted = pack.omitted + omittedBefore;
  const warnings = [...primary.warnings];
  if (omitted > 0) {
    warnings.push(`Evidence pack: ${omitted} lower-ranked items left out (size cap)`);
  }
  const evidence = pack.items();
  for (const item of evidence) config.writer?.({ type: "evidence", evidence: item });
  for (const message of primary.found) sendStatus(config, runtime, "RESEARCH-FOUND", message);
  for (const message of warnings) sendStatus(config, runtime, "SYS-WARN", message);
  return {
    evidence,
    errors: primary.errors,
    lost: primary.lost,
    lasting: primary.lasting,
    samples: primary.samples,
    omitted,
    incomplete: primary.incomplete,
    trackIsOriginal: primary.trackIsOriginal,
    status: [...primary.found, ...warnings],
  };
}

/**
 * The run's evidence pack from the primary sources' answers and the web search's results, sent
 * as `evidence` events, with the primary sources' errors and status lines (also sent). `cached`
 * are web-tier items a research-cache hit gave back (`cachedWebEvidence`).
 */
export async function runEvidence(
  primary: PrimaryRun,
  web: readonly WebFinding[],
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
  cached: readonly SourcedEvidence[] = [],
): Promise<RunEvidence> {
  const read = await primary;
  config.signal?.throwIfAborted();
  if (read.status === "threw") throw read.error;
  return packOf(readOutcome(read), [...webSearchEvidence(web), ...cached], config, runtime);
}

/**
 * How long research is kept from when it was made (`CachedEvidence.researchedAt`), a refresh
 * of its evidence included: research older than this is never served.
 */
export const RESEARCH_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * The version of `CachedEvidence` this code writes; a row of another is a miss. 3: the pack
 * names the release that stands for the recording (a row of 2 never read it). 4: web text has
 * its @handles masked and leaves out social platform pages and comment threads (a row of 3 may
 * hold them, also in the research text the composer reads).
 */
export const CACHED_EVIDENCE_FORMAT = 4;

/**
 * The run's evidence on a refresh hit (a cached row that left a part for a later run): the
 * primary sources read again, with the cached web-tier items. A source this read did not ask
 * again (its request not sent) keeps its records of the cached run, when that run read them:
 * they are merged in, with their own read dates, and the status says so.
 */
export async function refreshedRunEvidence(
  primary: PrimaryRun,
  cached: CachedEvidence,
  items: readonly SourcedEvidence[],
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<RunEvidence> {
  const read = await primary;
  config.signal?.throwIfAborted();
  if (read.status === "threw") throw read.error;
  const outcome = readOutcome(read);
  if (read.status === "read") {
    const leftThen = new Set(
      cached.incomplete.filter((part) => part.part === "not_asked").map((part) => part.source),
    );
    // The status line of the records read stays this read's: the kept ones have their own line.
    for (const { source, why } of notAskedSources(read.sources)) {
      const kept = items.filter((i) => i.sourceTier === "primary-record" && i.source === source);
      if (leftThen.has(source) || kept.length === 0) continue;
      outcome.records.push(...kept);
      outcome.incomplete = outcome.incomplete.filter(
        (part) => !(part.part === "not_asked" && part.source === source),
      );
      outcome.warnings = [
        ...outcome.warnings.filter((line) => line !== notAskedNote(source, why)),
        `${SOURCE_NAMES[source]} not asked again: its ${recordsCount(kept.length)} come from the research cache (read ${cached.readAt.slice(0, 10)})`,
      ];
    }
  }
  return packOf(outcome, cachedWebEvidence(items), config, runtime);
}

/**
 * The run's evidence as the research cache holds it, with the recording the ISRC identified.
 * Only for a run whose primary-source errors are all "not configured" or lasting: the historian
 * caches no other.
 */
export function cachedEvidenceOf(
  run: RunEvidence,
  isrc: string | null,
  recording: IdentifiedRecording | null,
  readAt: string,
  researchedAt: string = readAt,
): CachedEvidence {
  return {
    format: CACHED_EVIDENCE_FORMAT,
    researchedAt,
    readAt,
    isrc,
    items: run.evidence.map((item) => ({ ...item })),
    omitted: run.omitted,
    samples: [...run.samples],
    recording,
    trackIsOriginal: run.trackIsOriginal,
    errors: [...run.errors],
    lasting: [...run.lasting],
    incomplete: run.incomplete.map((part) => ({ ...part })),
  };
}

const PRIMARY: readonly SourceId[] = ["musicbrainz", "discogs", "genius", "secondhandsongs"];

/**
 * Why a cached evidence's own fields are not what `cachedEvidenceOf` writes for a cached run,
 * or null: errors only of the kinds the gate lets through (a source not configured, which must
 * still not be, and an answer of unknown shape, which is lasting), lasting errors among them,
 * the recording that its MusicBrainz records are about, and no primary record without an ISRC.
 */
function cachedEvidenceIssue(
  cached: CachedEvidence,
  configured: { discogs: boolean; genius: boolean },
): string | null {
  const keyOf = (e: SourceError) => `${e.source}:${e.code}`;
  if (!(Date.parse(cached.researchedAt) <= Date.parse(cached.readAt))) {
    return "evidence read before its research was made";
  }
  const lasting = new Set(cached.lasting.map(keyOf));
  for (const e of cached.errors) {
    if (!PRIMARY.includes(e.source)) return "an error of a source that is not primary";
    if (e.code === "not_configured") {
      if (e.source !== "discogs" && e.source !== "genius") return "a source that needs no key";
      if (configured[e.source]) return "a source not configured then, configured now";
    } else if (e.code !== "invalid_response" || !lasting.has(keyOf(e))) {
      return "an error that blocks caching";
    }
  }
  const errors = new Set(cached.errors.map(keyOf));
  for (const e of cached.lasting) {
    if (e.code !== "invalid_response" || !errors.has(keyOf(e))) return "not a lasting error";
  }
  const own = cached.items.some(
    (item) => item.source === "musicbrainz" && item.recordRef?.startsWith("track/"),
  );
  if (own && !cached.recording) return "MusicBrainz records without the recording";
  const primary = cached.items.some((item) => item.sourceTier === "primary-record");
  if (cached.isrc === null && (primary || cached.recording)) return "records without an ISRC";
  return null;
}

/**
 * The items of a cached research's evidence, checked and sealed again (`restoredEvidence`,
 * against what the cached run read); null when the cache holds none, holds evidence of another
 * format, or holds an item or an error that fails a check.
 */
export function restoredItems(
  cached: CachedEvidence | undefined,
  track?: SearchedTrack,
): SourcedEvidence[] | null {
  if (!cached || cached.format !== CACHED_EVIDENCE_FORMAT) return null;
  const configured = { discogs: discogsConfigured(), genius: geniusConfigured() };
  if (cachedEvidenceIssue(cached, configured) !== null) return null;
  return restoredEvidence(cached.items, {
    readAt: cached.readAt,
    recordingMbid: cached.recording?.mbid ?? null,
    trackIsOriginal: cached.trackIsOriginal,
    configured,
    track,
  });
}

/** The web-tier items among restored ones. */
export function cachedWebEvidence(items: readonly SourcedEvidence[]): SourcedEvidence[] {
  return items.filter((item) => item.sourceTier === "web");
}

/**
 * How a research-cache hit uses a cached evidence for a run with `isrc`:
 * - "miss": read for another ISRC, or for none while this run has one (a run that could not
 *   read the track's details is never cached, so this is research made without an identity):
 *   the research is made again and replaces the row;
 * - "refresh": read for this ISRC, but a part was left for a later run (`incomplete`): the
 *   primary sources are read again, with the cached research and web items;
 * - "fast": it stands for this run's evidence (also for a run that could not read the track's
 *   ISRC: the row is keyed by the track) and no primary source is asked.
 */
export function cachedEvidenceUse(
  cached: CachedEvidence,
  isrc: string | null,
): "fast" | "refresh" | "miss" {
  if (isrc !== null && cached.isrc !== isrc) return "miss";
  return isrc !== null && cached.incomplete.length > 0 ? "refresh" : "fast";
}

/**
 * The run's evidence from a research-cache hit (`items`: its restored items): the pack, errors
 * and status lines the run that made it had, sent as that run sent them. The status says the
 * primary records come from the cache, and when they were read.
 */
export function cachedRunEvidence(
  cached: CachedEvidence,
  items: readonly SourcedEvidence[],
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): RunEvidence {
  const records = items.filter((item) => item.sourceTier === "primary-record");
  const readAt = cached.readAt.slice(0, 10);
  const from = `, from the research cache (read ${readAt}; not asked again)`;
  const musicbrainzUnread = cached.errors.some((e) => e.source === "musicbrainz");
  const found =
    cached.isrc === null
      ? [NO_ISRC_LINE]
      : [
          records.length > 0
            ? `Using ${recordsCount(records.length)} from the research cache (${countsBySource(records)}; read ${readAt}); the primary sources were not asked again`
            : musicbrainzUnread
              ? `Primary sources: none could be read (${SOURCE_NAMES.musicbrainz} could not be read)${from}`
              : `Primary sources: no record matched the track${from}`,
        ];
  const outcome: PrimaryOutcome = {
    records,
    errors: [...cached.errors],
    lost: [],
    lasting: [...cached.lasting],
    samples: [...cached.samples],
    // What the cached run left for a later one is still missing: said again, never dropped.
    incomplete: cached.incomplete.map((part) => ({ ...part })),
    trackIsOriginal: cached.trackIsOriginal,
    found,
    warnings: [
      ...unreadableStatus(cached.errors),
      ...cached.incomplete.map((part) =>
        part.part === "dates"
          ? DATES_NOTE
          : part.part === "releases"
            ? RELEASES_NOTE
            : cachedNotAskedNote(part.source, cached.readAt),
      ),
    ],
  };
  return packOf(outcome, cachedWebEvidence(items), config, runtime, cached.omitted);
}

/**
 * The lasting primary-source errors that no other error of the run (`others`) shares a source
 * and code with: errors are reported once per source and code, so one that also came from
 * elsewhere (the researcher's own MusicBrainz step) is not taken as lasting, and blocks.
 */
export function lastingAmong(
  lasting: readonly SourceError[],
  others: readonly SourceError[],
): SourceError[] {
  const taken = new Set(others.map((e) => `${e.source}:${e.code}`));
  return lasting.filter((e) => !taken.has(`${e.source}:${e.code}`));
}

/** Sends one status line of the historian. */
export function sendStatus(
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
  code: StatusCode,
  message: string,
): void {
  config.writer?.({
    type: "status",
    code,
    message,
    node: "historian",
    timestamp: timestampOf(runtime),
  });
}

/** "MusicBrainz 5, SecondHandSongs 3". */
function countsBySource(items: readonly SourcedEvidence[]): string {
  const counts = new Map<SourceId, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  return [...counts].map(([source, n]) => `${SOURCE_NAMES[source]} ${n}`).join(", ");
}

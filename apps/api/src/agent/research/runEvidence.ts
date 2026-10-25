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
  type IdentifiedRecording,
  type PrimarySources,
} from "../../sources/identity.js";
import { SOURCE_NAMES } from "../prompts.js";
import { trackQuery, uniqueErrors, unreadableStatus } from "../researcherSubgraph.js";
import { type AgentRuntime, timestampOf } from "../runtime.js";
import type { SpotifyData } from "../state.js";
import {
  EvidencePack,
  lastingErrors,
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
  | { status: "not_asked" }
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
 * on the signal.
 */
export function startPrimarySources(
  spotify: SpotifyData,
  isrc: string | null,
  signal: AbortSignal | undefined,
  runtime: AgentRuntime,
): PrimaryStart {
  if (!isrc) {
    return { run: Promise.resolve({ status: "not_asked" }), recording: Promise.resolve(null) };
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
  /** The MusicBrainz work's recordings could not be dated. */
  datesIncomplete: boolean;
  status: string[];
}

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
  datesIncomplete: boolean;
  found: string[];
  warnings: string[];
}

const DATES_NOTE =
  "📇 MusicBrainz: dates incomplete, the work's recordings could not be dated, so its covers are not claimed for this recording";

/** The status line of the primary sources' records; `from` says where they came from. */
function recordsLine(records: readonly SourcedEvidence[], from = ""): string {
  return `📇 Primary sources: ${records.length} records (${countsBySource(records)})${from}`;
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
      datesIncomplete: false,
      found: ["📇 Primary sources not asked: the track has no ISRC"],
      warnings: [],
    };
  }
  const samples = musicBrainzSampleEntries(read.sources);
  const records = primaryRecordEvidence(read.sources);
  const { musicbrainz } = read.sources;
  // Without MusicBrainz the others are not asked: nothing was read, which is not "no match".
  const unread =
    musicbrainz.status === "missing" && musicbrainz.error
      ? `📇 Primary sources: none could be read (${SOURCE_NAMES.musicbrainz} could not be read)`
      : null;
  const found = [
    records.length > 0
      ? recordsLine(records)
      : (unread ?? "📇 Primary sources: no record matched the track"),
  ];
  const errors = uniqueErrors(primarySourceErrors(read.sources));
  const lasting = lastingErrors(read.sources);
  const losses = lostRecords(read.sources);
  const lost = losses.map(({ error }) => error);
  const warnings: string[] = [];
  for (const { error, note } of losses) {
    warnings.push(
      `⚠️ ${SOURCE_NAMES[error.source]} records are incomplete (${error.code}): ${
        note ?? error.message ?? "a request failed"
      }`,
    );
  }
  warnings.push(...unreadableStatus(errors.filter((e) => !lost.includes(e))));
  // Nothing was lost, but the covers are less specific than a later run may give: said once.
  const datesIncomplete =
    musicbrainz.status === "found" && Boolean(musicbrainz.incomplete?.includes(DATES_INCOMPLETE));
  if (datesIncomplete) warnings.push(DATES_NOTE);
  return { records, errors, lost, lasting, samples, datesIncomplete, found, warnings };
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
    warnings.push(`📇 Evidence pack: ${omitted} lower-ranked items left out (size cap)`);
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
    datesIncomplete: primary.datesIncomplete,
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
 * The run's evidence as the research cache holds it, with the recording the ISRC identified.
 * Only for a run whose primary-source errors are all "not configured" or lasting: the historian
 * caches no other.
 */
export function cachedEvidenceOf(
  run: RunEvidence,
  isrc: string | null,
  recording: IdentifiedRecording | null,
  readAt: string,
): CachedEvidence {
  return {
    readAt,
    isrc,
    items: run.evidence.map((item) => ({ ...item })),
    omitted: run.omitted,
    samples: [...run.samples],
    recording,
    errors: [...run.errors],
    lasting: [...run.lasting],
    datesIncomplete: run.datesIncomplete,
  };
}

/**
 * The items of a cached research's evidence, checked and sealed again (`restoredEvidence`);
 * null when the cache holds none, or holds one that fails a check.
 */
export function restoredItems(cached: CachedEvidence | undefined): SourcedEvidence[] | null {
  return cached ? restoredEvidence(cached.items) : null;
}

/** The web-tier items among restored ones. */
export function cachedWebEvidence(items: readonly SourcedEvidence[]): SourcedEvidence[] {
  return items.filter((item) => item.sourceTier === "web");
}

/**
 * True when a cached research's evidence can stand for this run's: it was read for the same
 * ISRC (or both have none). The primary sources are then not asked again.
 */
export function cachedEvidenceHolds(cached: CachedEvidence, isrc: string | null): boolean {
  return cached.isrc === isrc;
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
  const from = `, from the research cache (read ${cached.readAt.slice(0, 10)}; not asked again)`;
  const musicbrainzUnread = cached.errors.some((e) => e.source === "musicbrainz");
  const found =
    cached.isrc === null
      ? ["📇 Primary sources not asked: the track has no ISRC"]
      : [
          records.length > 0
            ? recordsLine(records, from)
            : musicbrainzUnread
              ? `📇 Primary sources: none could be read (${SOURCE_NAMES.musicbrainz} could not be read)${from}`
              : `📇 Primary sources: no record matched the track${from}`,
        ];
  const outcome: PrimaryOutcome = {
    records,
    errors: [...cached.errors],
    lost: [],
    lasting: [...cached.lasting],
    samples: [...cached.samples],
    datesIncomplete: cached.datesIncomplete,
    found,
    warnings: [...unreadableStatus(cached.errors), ...(cached.datesIncomplete ? [DATES_NOTE] : [])],
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

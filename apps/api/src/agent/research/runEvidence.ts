/**
 * The run's evidence, as the historian collects it: the primary sources read from the track's
 * ISRC (MusicBrainz, Discogs, SecondHandSongs, Genius), started while the research runs, and
 * the web search's results, put in one evidence pack and sent as `evidence` events.
 *
 * Every primary-source error is a source error of the run, and keeps the composer from storing
 * the result, with two exceptions: a source that is not configured (Discogs, Genius without
 * their credential: the result key names them), and an answer of a shape the reader does not
 * know, returned in `lasting`; both are stored with the result and reported again when it is
 * served. A source that
 * answered but lost records to a failed request (the MusicBrainz work, and so its covers) is also
 * returned in `lost`: the historian does not cache the research then, and the status says the
 * records are incomplete. Other primary-source errors do not block the research cache, which
 * holds no primary record.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { SourceError, SourceId } from "@liner-notes/contract";
import {
  collectPrimarySources,
  DATES_INCOMPLETE,
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
): PrimaryRun {
  if (!isrc) return Promise.resolve({ status: "not_asked" });
  const { names } = trackQuery(spotify);
  return collectPrimarySources(
    {
      isrc,
      title: spotify.title,
      artists: names,
      durationMs: spotify.durationMs > 0 ? spotify.durationMs : null,
    },
    { signal, now: runtime.now },
  ).then(
    (sources) => ({ status: "read" as const, sources }),
    (error: unknown) => ({ status: "threw" as const, error }),
  );
}

export interface RunEvidence {
  evidence: SourcedEvidence[];
  /** The primary sources' errors, for the run's source errors. */
  errors: SourceError[];
  /** Those of `errors` whose source lost records: the run is not complete. */
  lost: SourceError[];
  /** Those of `errors` that are lasting (an answer of a shape the reader does not know). */
  lasting: SourceError[];
  status: string[];
}

type StatusCode = "RESEARCH-FOUND" | "SYS-WARN";

/**
 * The run's evidence pack from the primary sources' answers and the web search's results, sent
 * as `evidence` events, with the primary sources' errors and status lines (also sent).
 */
export async function runEvidence(
  primary: PrimaryRun,
  web: readonly WebFinding[],
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<RunEvidence> {
  const read = await primary;
  config.signal?.throwIfAborted();
  if (read.status === "threw") throw read.error;
  const pack = new EvidencePack();
  const found: string[] = [];
  const warnings: string[] = [];
  let errors: SourceError[] = [];
  let lost: SourceError[] = [];
  let lasting: SourceError[] = [];
  if (read.status === "read") {
    const records = primaryRecordEvidence(read.sources);
    pack.addAll(records);
    const { musicbrainz } = read.sources;
    // Without MusicBrainz the others are not asked: nothing was read, which is not "no match".
    const unread =
      musicbrainz.status === "missing" && musicbrainz.error
        ? `📇 Primary sources: none could be read (${SOURCE_NAMES.musicbrainz} could not be read)`
        : null;
    found.push(
      records.length > 0
        ? `📇 Primary sources: ${records.length} records (${countsBySource(records)})`
        : (unread ?? "📇 Primary sources: no record matched the track"),
    );
    errors = uniqueErrors(primarySourceErrors(read.sources));
    lasting = lastingErrors(read.sources);
    const losses = lostRecords(read.sources);
    lost = losses.map(({ error }) => error);
    for (const { error, note } of losses) {
      warnings.push(
        `⚠️ ${SOURCE_NAMES[error.source]} records are incomplete (${error.code}): ${
          note ?? error.message ?? "a request failed"
        }`,
      );
    }
    warnings.push(...unreadableStatus(errors.filter((e) => !lost.includes(e))));
    // Nothing was lost, but the covers are less specific than a later run may give: said once.
    if (musicbrainz.status === "found" && musicbrainz.incomplete?.includes(DATES_INCOMPLETE)) {
      warnings.push(
        "📇 MusicBrainz: dates incomplete, the work's recordings could not be dated, so its covers are not claimed for this recording",
      );
    }
  } else {
    found.push("📇 Primary sources not asked: the track has no ISRC");
  }
  pack.addAll(webSearchEvidence(web));
  if (pack.omitted > 0) {
    warnings.push(`📇 Evidence pack: ${pack.omitted} lower-ranked items left out (size cap)`);
  }
  const evidence = pack.items();
  for (const item of evidence) config.writer?.({ type: "evidence", evidence: item });
  for (const message of found) sendStatus(config, runtime, "RESEARCH-FOUND", message);
  for (const message of warnings) sendStatus(config, runtime, "SYS-WARN", message);
  return { evidence, errors, lost, lasting, status: [...found, ...warnings] };
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

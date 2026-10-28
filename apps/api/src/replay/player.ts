/**
 * Plays a recorded run as a new run: the recorded events, in order, at accelerated timing, each
 * stamped with the new run's id (the stream adds `runId` and `seq`; `connected` names the new
 * run as its thread). Right after `connected` a status says that this is a replay, when and from
 * which commit it was recorded, so the progress that follows is never read as live work. The
 * result is the recorded one with the new run's id, still saying `mode: "replay"` with the
 * recording's date, commit and analyzer version, and with this run's own usage (none: a replay
 * calls no model; the recording's cost stays in the record), each fact stated once
 * (`oneClaimPerFact`). Every event carries the time it is sent, so a stream's times never go
 * back, and the time since the recorded run started (`elapsedMs`): the event's own, or else the
 * time the recording measured for it (`atMs`, since the recorded stream opened, without the wait
 * at the picker), so a recording made before events carried one still shows when each step
 * happened. The notice and the stream's own events carry none. The recorded `done` is not sent:
 * the stream sends its own, and its own heartbeats.
 */

import type { ReplayRecord, RunInfo, TrackAnalysis } from "@liner-notes/contract";
import { withoutRestatements } from "../agent/restatements.js";
import type { EventBody } from "../http/sse.js";

export interface ReplayPacing {
  /** How many times faster than recorded the events are sent. */
  speed: number;
  /** Longest wait between two events, in milliseconds. */
  maxGapMs: number;
}

export const DEFAULT_PACING: ReplayPacing = { speed: 8, maxGapMs: 400 };

let pacing = DEFAULT_PACING;

/** The pacing replays use. */
export function replayPacing(): ReplayPacing {
  return pacing;
}

/** For tests: sets the pacing. Returns a function that restores the previous one. */
export function setReplayPacingForTests(next: ReplayPacing): () => void {
  const previous = pacing;
  pacing = next;
  return () => {
    pacing = previous;
  };
}

/** What a replay spends: nothing (no model is called). */
const NO_USAGE = { llmCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 0 };

/**
 * The recorded result as the result of run `runId`. It says nothing about how a search text
 * matched the track (`queryMatch`): that belonged to the recorded run, not to this one.
 */
export function replayedAnalysis(record: ReplayRecord, runId: string): TrackAnalysis {
  const { queryMatch: _match, ...recorded } = record.analysis;
  const run = recorded.run;
  if (!run) throw new Error(`Replay record ${record.slug} has no run information`);
  const { analysis, verifier } = oneClaimPerFact(recorded, run.verifier);
  return {
    ...analysis,
    run: {
      ...run,
      ...(verifier ? { verifier } : {}),
      id: runId,
      mode: "replay",
      replayed: "run",
      recordedAt: record.recordedAt,
      commit: record.commit,
      analyzerVersion: record.analyzerVersion,
      usage: NO_USAGE,
    },
  };
}

/**
 * The recorded result with each fact stated once, as the verifier now leaves it
 * (agent/restatements.ts): a recording made before that step keeps its claims as recorded, less
 * the restated ones, which are counted in its verifier summary. A recording without a verifier
 * summary has nowhere to count them, and keeps every claim.
 */
function oneClaimPerFact(
  analysis: Omit<TrackAnalysis, "queryMatch">,
  verifier: RunInfo["verifier"],
): { analysis: Omit<TrackAnalysis, "queryMatch">; verifier: RunInfo["verifier"] } {
  if (!verifier) return { analysis, verifier };
  const kept = withoutRestatements(
    analysis.claims ?? [],
    analysis.factoids ?? [],
    [...(analysis.genealogy?.links ?? []), ...(analysis.samples ?? [])],
    analysis.evidence ?? [],
  );
  if (kept.restated === 0) return { analysis, verifier };
  return {
    analysis: { ...analysis, claims: kept.claims, factoids: kept.factoids },
    verifier: { ...verifier, restated: (verifier.restated ?? 0) + kept.restated },
  };
}

/** The status sent right after `connected`: this run is a replay of a recording. */
export function replayNotice(record: ReplayRecord): EventBody {
  return {
    type: "status",
    message:
      `Replaying an analysis recorded on ${record.recordedAt} (commit ${record.commit}); ` +
      "nothing below runs live.",
    code: "SYS-INIT",
    node: "replay",
    timestamp: new Date().toISOString(),
  };
}

/**
 * One recorded event as the body the new run's stream sends (without `runId` and `seq`), stamped
 * with this run's id and the time it is sent.
 */
export function replayedEvent(
  { atMs, event }: ReplayRecord["events"][number],
  record: ReplayRecord,
  runId: string,
): EventBody {
  const {
    runId: _recordedRun,
    seq: _recordedSeq,
    ...body
  } = event as EventBody & {
    runId?: unknown;
    seq?: unknown;
  };
  // The time since the run started is the recorded run's: the event's own, else its `atMs`.
  const recorded = { ...body, elapsedMs: (event as { elapsedMs?: number }).elapsedMs ?? atMs };
  if (event.type === "complete") return { ...recorded, data: replayedAnalysis(record, runId) };
  // Event times are this run's, like its notice and `done`; when the recording was made stays
  // in the record (`recordedAt`).
  const stamped =
    "timestamp" in recorded ? { ...recorded, timestamp: new Date().toISOString() } : recorded;
  return "threadId" in stamped ? { ...stamped, threadId: runId } : stamped;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Sends the record's events as run `runId` through `send` (false when an event was not sent).
 * Returns the result the client was sent, or null when it was not (the client left, or the
 * stream refused it).
 */
export async function playRecord(
  record: ReplayRecord,
  runId: string,
  send: (body: EventBody) => boolean,
  signal: AbortSignal,
  { speed, maxGapMs }: ReplayPacing = replayPacing(),
): Promise<TrackAnalysis | null> {
  let previousAt = 0;
  let noticed = false;
  let result: TrackAnalysis | null = null;
  for (const item of record.events) {
    const { atMs, event } = item;
    if (event.type === "done") break;
    await wait(Math.min((atMs - previousAt) / speed, maxGapMs), signal);
    previousAt = atMs;
    if (signal.aborted) return null;
    // The notice goes first, right after `connected` when the recording opens with it.
    if (!noticed && event.type !== "connected") {
      send(replayNotice(record));
      noticed = true;
    }
    const body = replayedEvent(item, record, runId);
    const sent = send(body);
    if (event.type === "complete") result = sent ? (body.data as TrackAnalysis) : null;
  }
  return result;
}

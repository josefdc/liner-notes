/**
 * Plays a recorded run as a new run: the recorded events, in order, at accelerated timing, each
 * stamped with the new run's id (the stream adds `runId` and `seq`; `connected` names the new
 * run as its thread). Right after `connected` a status says that this is a replay, when and from
 * which commit it was recorded, so the progress that follows is never read as live work. The
 * result is the recorded one with the new run's id, still saying `mode: "replay"` with the
 * recording's date, commit and analyzer version, and with this run's own usage (none: a replay
 * calls no model; the recording's cost stays in the record). The recorded `done` is not sent:
 * the stream sends its own, and its own heartbeats.
 */

import type { ReplayRecord, TrackAnalysis } from "@liner-notes/contract";
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

/** The recorded result as the result of run `runId`. */
export function replayedAnalysis(record: ReplayRecord, runId: string): TrackAnalysis {
  const run = record.analysis.run;
  if (!run) throw new Error(`Replay record ${record.slug} has no run information`);
  return {
    ...record.analysis,
    run: {
      ...run,
      id: runId,
      mode: "replay",
      recordedAt: record.recordedAt,
      commit: record.commit,
      analyzerVersion: record.analyzerVersion,
      usage: NO_USAGE,
    },
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

/** One recorded event as the body the new run's stream sends (without `runId` and `seq`). */
export function replayedEvent(
  event: ReplayRecord["events"][number]["event"],
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
  if (event.type === "complete") return { ...body, data: replayedAnalysis(record, runId) };
  if ("threadId" in body) return { ...body, threadId: runId };
  return body;
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
  for (const { atMs, event } of record.events) {
    if (event.type === "done") break;
    await wait(Math.min((atMs - previousAt) / speed, maxGapMs), signal);
    previousAt = atMs;
    if (signal.aborted) return null;
    // The notice goes first, right after `connected` when the recording opens with it.
    if (!noticed && event.type !== "connected") {
      send(replayNotice(record));
      noticed = true;
    }
    const body = replayedEvent(event, record, runId);
    const sent = send(body);
    if (event.type === "complete") result = sent ? (body.data as TrackAnalysis) : null;
  }
  return result;
}

/**
 * "More facts" for a track: POST /api/factoids/decrypt (three at once) and
 * GET /api/factoids/decrypt/stream (one per category, as server-sent events).
 *
 * Live facts are written and checked by the factoid service (../../factoids/service.ts): one
 * model call per focus through the provider layer, all in one request run (at most
 * MAX_LLM_CALLS_PER_RUN calls, held to the budget), each fact a model claim checked by the
 * verifier's steps against the evidence of the analysis run the request names (`runId`), and
 * sent with that claim once all of them have been checked. Without a run id, or for a run with
 * no stored result, there is no evidence and every fact reads as inferred. The request's abort
 * signal stops the calls in flight when the client leaves.
 *
 * Under REPLAY_MODE=only (or fallback while live analysis is unavailable) no model is called:
 * a recorded track's "more facts" are the recorded factoids the client does not have yet (often
 * none), each with its recorded claim, and any other track gets live_disabled, or
 * budget_exhausted when fallback paused live calls because the budget is spent.
 */

import {
  type Claim,
  RESOURCE_ID_PATTERN,
  type ReplayRecord,
  RunMode,
  SPOTIFY_ID_PATTERN,
} from "@liner-notes/contract";
import { type Response, Router } from "express";
import { z } from "zod";
import { defaultAgentRuntime } from "../../agent/runtime.js";
import {
  FACTOID_FOCUSES,
  type FactoidsResult,
  failure,
  type LoadRun,
  writeFactoids,
} from "../../factoids/service.js";
import { isLlmError } from "../../llm/errors.js";
import type { LlmPurpose } from "../../config/settings.js";
import { type Llm, llm } from "../../llm/invoke.js";
import { chooseReplay, type ReplayChoice, recordingFor } from "../../replay/mode.js";
import type { ReplaySet } from "../../replay/records.js";
import { asyncRoute, eventStreamHead, markFailed, sendError } from "../middleware/errors.js";
import { type EventStream, openFactoidStream } from "../sse.js";
import { boundedText, describeIssues, factoidId, trackId } from "../validation.js";
import { logger } from "../../logger.js";

const log = logger("Factoids");

/**
 * The track a factoids request names: the client sends its title and artist, so they are written
 * at debug level only, like a typed query.
 */
function logTrack(what: string, track: string): void {
  log.debug(`${what}: track`, { track });
}

// =============================================================================
// Input
// =============================================================================

// Title and artist come from track metadata and the ids from earlier answers, so they are
// bounded rather than refused: long text is truncated. New ids are never taken from the client's
// (see the factoid service). The body and URL size limits bound the lists.
const analysisRunId = z
  .string()
  .regex(RESOURCE_ID_PATTERN, "The run id is 1-100 letters, digits, '-' or '_'")
  .optional();

const DecryptBodySchema = z.object({
  trackId,
  trackTitle: boundedText(1, { truncate: true }),
  trackArtist: boundedText(0, { truncate: true }).optional(),
  existingFactoidIds: z.array(factoidId).default([]),
  // The analysis run the facts add to, so they cite its evidence and do not repeat its facts.
  runId: analysisRunId,
});

const StreamQuerySchema = z.object({
  trackTitle: boundedText(1, { truncate: true }),
  trackArtist: boundedText(0, { truncate: true }).optional(),
  existingIds: z
    .string()
    .max(16_000)
    .optional()
    .transform((value) => (value ? value.split(",").filter(Boolean) : []))
    .pipe(z.array(factoidId)),
  // How the result these facts add to was produced (its run.mode), when the client says so.
  mode: RunMode.optional(),
  runId: analysisRunId,
});

const DECRYPT_EXAMPLE = {
  trackId: "6GyFP1nfCDB8lbD2bG0Hq9",
  trackTitle: "Midnight City",
  trackArtist: "M83",
  existingFactoidIds: ["f1", "f2"],
  runId: "3f6c1d2e-4b5a-4c3d-9e8f-7a6b5c4d3e2f",
};

const describeTrack = (title: string, artist?: string) =>
  artist ? `"${title}" by ${artist}` : `"${title}"`;

// =============================================================================
// Answers
// =============================================================================

export {
  FACTOIDS_CALL_SITE,
  FACTOIDS_MAX_OUTPUT_TOKENS,
} from "../../factoids/service.js";

/**
 * The client-facing code for a failed call: the provider's rate limit, the budget or the call
 * cap (live calls paused), or a plain failure. Details stay in the server log.
 */
export function failureCode(error: unknown): "rate_limited" | "budget_exhausted" | "failed" {
  if (isLlmError(error, "rate_limited")) return "rate_limited";
  if (isLlmError(error, "budget_exceeded") || isLlmError(error, "call_cap")) {
    return "budget_exhausted";
  }
  return "failed";
}

/**
 * The factoids of a recording that the client does not have yet (by id), at most `count`, with
 * their recorded ids and claim links: asking again with them as existing ids gives nothing new,
 * so a client never shows a recorded fact twice.
 */
export function recordedFactoids(record: ReplayRecord, existingIds: string[], count: number) {
  const known = new Set(existingIds);
  return record.analysis.factoids
    .filter((factoid) => !known.has(factoid.id))
    .slice(0, count)
    .map((factoid) => ({
      id: factoid.id,
      title: factoid.title,
      content: factoid.content,
      type: factoid.type,
      entities: factoid.entities ?? [],
      ...(factoid.claimId !== undefined && { claimId: factoid.claimId }),
    }));
}

/** The recorded claim of a recorded card, when the recording has it. */
export function recordedClaim(record: ReplayRecord, card: { claimId?: string }): Claim | undefined {
  if (card.claimId === undefined) return undefined;
  return (record.analysis.claims ?? []).find((claim) => claim.id === card.claimId);
}

/** The written facts and their claims, in focus order. */
const writtenOf = (result: FactoidsResult) =>
  result.outcomes.flatMap((outcome) => (outcome.status === "written" ? [outcome] : []));

// =============================================================================
// Event streams
// =============================================================================

const STREAM_ERRORS = {
  invalid_input: "The request is not valid.",
  rate_limited: "The model is busy. Please try again later.",
  budget_exhausted: "Live model calls are paused for now.",
  live_disabled: "Live facts are not available here. Only recorded tracks have facts.",
  not_found: "The recording this result came from is no longer served, so it has no more facts.",
  failed: "This fact could not be generated.",
} as const;

const CLOSED = Symbol("closed");

/**
 * The factoid stream (events built and checked by the stream adapter, ../sse.ts), with
 * `untilClosed`: the work's result, or CLOSED as soon as the client goes away.
 */
function openEventStream(res: Response, runId: string | null) {
  const stream: EventStream = openFactoidStream(res, runId);
  const disconnected = new Promise<typeof CLOSED>((resolve) => {
    stream.signal.addEventListener("abort", () => resolve(CLOSED), { once: true });
  });
  return {
    stream,
    untilClosed<T>(work: Promise<T>): Promise<T | typeof CLOSED> {
      return Promise.race([work, disconnected]);
    },
    error(code: keyof typeof STREAM_ERRORS, detail?: Record<string, unknown>) {
      stream.error(code, STREAM_ERRORS[code], detail);
    },
  };
}

export interface FactoidsRouterOptions {
  /** The purpose tag of the routes' model calls (budget accounting). */
  purpose?: LlmPurpose;
  /** The model layer (default: the shared provider layer); the judge's calls use it too. */
  llm?: Llm;
  /** Reads an analysis run's stored result (default: the run store; see the factoid service). */
  loadRun?: LoadRun;
}

/**
 * The factoid routes. Each request is one run: its calls share one run id, so a request makes
 * at most MAX_LLM_CALLS_PER_RUN calls, and the run is ended when the request is.
 */
export function createFactoidsRouter({
  purpose = defaultAgentRuntime.purpose,
  llm: layer = llm,
  loadRun,
}: FactoidsRouterOptions = {}): Router {
  const router = Router();

  // =============================================================================
  // POST /api/factoids/decrypt
  // =============================================================================

  /**
   * Generate additional obscure facts for a track
   *
   * POST /api/factoids/decrypt
   * Body: { "trackId": "...", "trackTitle": "...", "trackArtist": "...",
   *         "existingFactoidIds": ["f1", "f2"], "runId": "..." }
   * Returns: { factoids: Factoid[], claims: Claim[] } - up to 3 new facts with entities, one per
   * focus, in focus order (fewer when the model knows fewer, or when one only repeats a fact the
   * run already has), each with its checked claim (`claimId`). `runId`, optional, names the
   * analysis run the facts add to: its evidence is what they may cite, and its facts are not
   * repeated. Ids are new: never one of the existing ids or the run's.
   * A malformed body is a 400 `invalid_input`. When no fact could be written because every call
   * failed: the model's rate limit a 429 `rate_limited`; the budget or the call cap a 503
   * `budget_exhausted`; any other failure a 500 `failed`. A track with no recording while live
   * calls may not be made (REPLAY_MODE) is a 503 `live_disabled` (or `budget_exhausted` when
   * fallback paused them because the budget is spent).
   * An empty list is a valid answer (nothing documented the model is sure of).
   */
  router.post(
    "/api/factoids/decrypt",
    asyncRoute(async (req, res) => {
      const parsed = DecryptBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, "invalid_input", {
          issues: describeIssues(parsed.error),
          example: DECRYPT_EXAMPLE,
        });
        return;
      }
      const { trackTitle, trackArtist, existingFactoidIds } = parsed.data;
      const track = describeTrack(trackTitle, trackArtist);

      // A Spotify track id names the track: title and artist are used only without one.
      const replay = await chooseReplay(
        (records) =>
          SPOTIFY_ID_PATTERN.test(parsed.data.trackId)
            ? records.forTrack(parsed.data.trackId)
            : records.forTitle(trackTitle, trackArtist),
        { purpose },
      );
      if (replay.kind === "refused") {
        sendError(res, replay.code);
        return;
      }
      if (replay.kind === "replay") {
        log.info(`Recorded facts (${replay.record.slug})`);
        logTrack("Recorded facts", track);
        const factoids = recordedFactoids(
          replay.record,
          existingFactoidIds,
          FACTOID_FOCUSES.length,
        );
        res.json({
          success: true,
          factoids,
          claims: factoids.flatMap((card) => recordedClaim(replay.record, card) ?? []),
          meta: {
            trackId: parsed.data.trackId,
            mode: "replay",
            recordedAt: replay.record.recordedAt,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      log.info("Writing more facts");
      logTrack("Writing more facts", track);

      // Stops the model calls when the client leaves before the answer.
      const disconnect = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) disconnect.abort();
      });

      let result: FactoidsResult;
      try {
        result = await writeFactoids(
          {
            track: { title: trackTitle, artist: trackArtist, trackId: parsed.data.trackId },
            runId: parsed.data.runId,
            existingIds: existingFactoidIds,
          },
          { llm: layer, purpose, signal: disconnect.signal, loadRun },
        );
      } catch (error) {
        log.error(`More facts failed (${failure(error)})`);
        if (!disconnect.signal.aborted) sendError(res, failureCode(error));
        return;
      }
      if (disconnect.signal.aborted) return;

      const written = writtenOf(result);
      const failed = result.outcomes.find((outcome) => outcome.status === "failed");
      if (written.length === 0 && failed) {
        sendError(res, failureCode(failed.error));
        return;
      }
      res.json({
        success: true,
        factoids: written.map((outcome) => outcome.factoid),
        claims: written.map((outcome) => outcome.claim),
        meta: {
          trackId: parsed.data.trackId,
          ...(result.model ? { model: result.model } : {}),
          timestamp: new Date().toISOString(),
        },
      });
    }),
  );

  // =============================================================================
  // GET /api/factoids/decrypt/stream
  // =============================================================================

  // HEAD gets the stream's headers only; it never asks the model.
  router.head("/api/factoids/decrypt/stream", eventStreamHead);

  /**
   * Stream factoids via SSE, each with its checked claim
   *
   * GET /api/factoids/decrypt/stream?trackTitle=...&trackArtist=...&existingIds=f1,f2&mode=live&runId=...
   * Messages (all on the default `message` event), each one FactoidStreamEvent of
   * @liner-notes/contract with `runId` (the analysis run the request names, else null) and `seq`:
   * - { type: "connected" }
   * - { type: "factoid", data: Factoid, claim?: Claim }: one per focus, in focus order, sent
   *   once all of them have been written and checked; `data.claimId` is `claim.id`
   * - { type: "error", code, error, index? }: invalid input, or one factoid that failed
   *   (`failed`, `rate_limited`, or `budget_exhausted` when live calls are paused); a focus the
   *   model knows nothing documented about, or whose fact only repeats one the run already has,
   *   sends nothing
   * - { type: "heartbeat" }: every 15 s while the stream is open
   * - { type: "done" }: always last
   *
   * `runId` (optional) names the analysis run the facts add to: its evidence is what they may
   * cite, and its facts are not repeated. Without it every fact reads as inferred.
   *
   * Under REPLAY_MODE the recorded factoids are sent instead, each with its recorded claim, or
   * one error live_disabled (or budget_exhausted, see above). `mode` (optional: the run.mode of
   * the result the facts add to) keeps them on the result's side whatever live services allow
   * now: a replayed result only gets facts from its recording (none left, or not_found when it
   * is no longer served), and a live result never gets recorded facts (the refusal instead).
   *
   * Invalid input is reported in the stream (an EventSource cannot read an error status). When
   * the client disconnects, the calls in flight are stopped and nothing more is written.
   */
  router.get(
    "/api/factoids/decrypt/stream",
    asyncRoute(async (req, res) => {
      const parsed = StreamQuerySchema.safeParse(req.query);
      const { stream, untilClosed, error } = openEventStream(
        res,
        parsed.success ? (parsed.data.runId ?? null) : null,
      );

      if (!parsed.success) {
        markFailed(res);
        error("invalid_input", { issues: describeIssues(parsed.error) });
        stream.done();
        return;
      }
      const { trackTitle, trackArtist, existingIds, mode } = parsed.data;
      const track = describeTrack(trackTitle, trackArtist);

      const find = (records: ReplaySet) => records.forTitle(trackTitle, trackArtist);
      let replay: ReplayChoice;
      if (mode === "replay") {
        // A replayed result: its recording, or nothing (never live facts).
        const record = recordingFor(find);
        if (!record) {
          error("not_found");
          stream.done();
          return;
        }
        replay = { kind: "replay", record };
      } else {
        replay = await chooseReplay(find, { purpose, resultMode: mode });
      }
      if (replay.kind === "refused") {
        error(replay.code);
        stream.done();
        return;
      }

      log.info("Streaming factoids");
      logTrack("Streaming factoids", track);
      stream.send({ type: "connected", timestamp: new Date().toISOString() });

      if (replay.kind === "replay") {
        const cards = recordedFactoids(replay.record, existingIds, FACTOID_FOCUSES.length);
        for (const [index, card] of cards.entries()) {
          const claim = recordedClaim(replay.record, card);
          stream.send({ type: "factoid", data: card, ...(claim ? { claim } : {}) }, { index });
        }
        stream.done();
        return;
      }

      // The stream's signal stops the calls in flight when the client leaves; the race below
      // stops waiting for them at once.
      let outcome: FactoidsResult | typeof CLOSED;
      try {
        outcome = await untilClosed(
          writeFactoids(
            {
              track: { title: trackTitle, artist: trackArtist },
              runId: parsed.data.runId,
              existingIds,
            },
            { llm: layer, purpose, signal: stream.signal, loadRun },
          ),
        );
      } catch (failed) {
        if (stream.closed) outcome = CLOSED;
        else {
          log.error(`More facts failed (${failure(failed)})`);
          error(failureCode(failed));
          stream.done();
          return;
        }
      }
      if (outcome === CLOSED || stream.closed) {
        log.info("Client left; stopped streaming factoids");
        return;
      }

      // A card that fails the contract is not sent; the adapter sends an error for its index
      // instead.
      for (const result of outcome.outcomes) {
        if (result.status === "written") {
          stream.send(
            { type: "factoid", data: result.factoid, claim: result.claim },
            { index: result.index },
          );
        } else if (result.status === "failed") {
          error(failureCode(result.error), { index: result.index });
        }
      }
      stream.done();
    }),
  );

  return router;
}

export default createFactoidsRouter();

import {
  RESOURCE_ID_PATTERN,
  ReplaysResponse,
  RunResponse,
  SPOTIFY_ID_PATTERN,
  type StoredRun,
} from "@liner-notes/contract";
import { Router } from "express";
import { oneClaimPerFact, type ResultClaims } from "../../agent/restatements.js";
import { heldTextIssue } from "../../agent/storedResults.js";
import { replayedAnalysis } from "../../replay/player.js";
import { replays } from "../../replay/records.js";
import { getDb } from "../../store/database.js";
import { getRun, latestRunsForTrack, type RunRecord, replayOfRun } from "../../store/runs.js";
import { sendError } from "../middleware/errors.js";
import { logger } from "../../logger.js";

const log = logger("Runs");

const router = Router();

const isoTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** How many of a track's latest runs GET /api/runs/by-track tries before it gives up. */
export const BY_TRACK_CANDIDATES = 5;

/**
 * A run's stored result with each fact stated once (restatements.ts): one stored before that
 * step loses the model's restatements and their cards, counted in its verifier summary and in
 * the log. A result that is not an object with a list of claims, or that the step cannot read, is
 * returned as it is, for the contract check; the step's failure is logged.
 */
function withOneClaimPerFact(runId: string, stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null) return stored;
  const result = stored as ResultClaims;
  if (!Array.isArray(result.claims)) return stored;
  try {
    const { result: served, restated } = oneClaimPerFact(result);
    if (restated > 0) log.info(`Run ${runId}: left out ${restated} claim(s) that restate another`);
    return served;
  } catch (error) {
    // A result of a shape the step cannot read: the contract check refuses it, not this step.
    log.warn(
      `Run ${runId}: its stored result could not be read for repeated claims; served as stored`,
      {
        err: error,
      },
    );
    return stored;
  }
}

/**
 * The result a run sent: its stored result, or for a replayed run the recording it was sent,
 * with its id, while a record with that same content (digest) is served and is of the run's
 * track; else null. Either with each fact stated once.
 */
export function resultOf(record: RunRecord): unknown {
  if (record.analysis !== null) return withOneClaimPerFact(record.runId, record.analysis);
  const replayOf = replayOfRun(record);
  if (!replayOf || record.status !== "completed") return null;
  const recorded = replays().forDigest(replayOf.slug, replayOf.digest);
  if (!recorded || recorded.analysis.id !== record.spotifyId) return null;
  return replayedAnalysis(recorded, record.runId);
}

/**
 * A stored run and its result as RunResponse, checked against the contract: "unfit" when the
 * stored result no longer fits it, "refused" when it holds text the readers of stored evidence
 * now refuse (heldTextIssue: a web page the web tier leaves out, or a source error whose message
 * holds markup, a stack trace, a token parameter or a link), both stored by an older release. A
 * refused result is never served in part: its claims cite its evidence by id, so a result
 * without some items would show claims without their sources. The answer is built from named
 * fields only: the query the user typed is never part of it.
 *
 * Known limit: the check reads web evidence and source errors only, as the other readers of
 * stored evidence do. Model prose, and claims citing ids that are not in the evidence, are not
 * checked; a run stored before results carried their evidence pack may hold prose written from
 * unmasked search text. Such runs age out with the run retention period.
 */
function runResponse(record: RunRecord): RunResponse | "unfit" | "refused" {
  const run: StoredRun = {
    id: record.runId,
    status: record.status,
    mode: record.mode,
    spotifyId: record.spotifyId,
    createdAt: isoTime(record.createdAt),
    finishedAt: record.finishedAt == null ? null : isoTime(record.finishedAt),
  };
  const checked = RunResponse.safeParse({ success: true, run, analysis: resultOf(record) });
  if (!checked.success) {
    log.error(`Stored run ${record.runId} fails the contract`, {
      issues: checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
    return "unfit";
  }
  const issue = checked.data.analysis ? heldTextIssue(checked.data.analysis) : null;
  if (issue) {
    // Where and why only: the text itself is not written to the log either.
    log.warn(`Stored run ${record.runId} holds text the readers now refuse; not served`, {
      runId: record.runId,
      reason: issue,
    });
    return "refused";
  }
  return checked.data;
}

/**
 * A stored run
 *
 * GET /api/runs/:id
 * Returns RunResponse: the run (never the typed query) and its own result; the result is null
 * until the run has completed, and for a run that sent a result another run composed (a cached
 * one; its mode is replay) or completed before results were stored. A replayed run's result is
 * the recording it was sent, with its id, while that same recording (same content) is served
 * (else null). The mode describes the result the run sent; a live run without a result says
 * nothing about one (see StoredRun).
 * 404 not_found for an unknown run (or one removed by retention), and for a run whose stored
 * result holds text the readers of stored evidence now refuse (stored by an older release: a web
 * page the web tier leaves out, such as a social platform page or a forum thread, or a source
 * error whose message holds markup, a stack trace, a token parameter or a link; see
 * heldTextIssue): no part of that result is served, and the detail only says it is no longer
 * served, never why. 400 invalid_input for an id that is not 1-100 letters, digits, '-' or '_';
 * 500 failed when the stored result no longer fits the contract.
 */
router.get("/api/runs/:id", (req, res) => {
  const id = req.params.id;
  if (!RESOURCE_ID_PATTERN.test(id)) {
    sendError(res, "invalid_input", { detail: "The run id is 1-100 letters, digits, '-' or '_'" });
    return;
  }
  const record = getRun(getDb(), id);
  if (!record) {
    sendError(res, "not_found");
    return;
  }
  const body = runResponse(record);
  if (body === "unfit") sendError(res, "failed");
  else if (body === "refused") {
    sendError(res, "not_found", { detail: "The run's stored result is no longer served" });
  } else {
    res.json(body);
  }
});

/**
 * The latest stored run of a track
 *
 * GET /api/runs/by-track/:spotifyId
 * Returns RunResponse for the run of that Spotify track that most recently finished with a
 * result of its own, or replayed a recording that is still served unchanged (runs that sent a cached
 * result are not counted). When that run's stored result no longer fits the contract, or holds
 * text the readers of stored evidence now refuse (as on GET /api/runs/:id; never served in
 * part), the next most recent one that can be served is served instead. Only the
 * BY_TRACK_CANDIDATES latest runs are tried, those that cannot be served included: a run older
 * than them is not reached. 404 not_found when the track has no such run, or when every one tried
 * was refused (nothing is broken: those results are no longer served); 500 failed when none can
 * be served and at least one of them no longer fits the contract, whether or not others were
 * refused; 400 invalid_input for an id that is not a Spotify track id.
 */
router.get("/api/runs/by-track/:spotifyId", (req, res) => {
  const spotifyId = req.params.spotifyId;
  if (!SPOTIFY_ID_PATTERN.test(spotifyId)) {
    sendError(res, "invalid_input", { detail: "The Spotify track id is 22 letters or digits" });
    return;
  }
  const served = replays();
  const records = latestRunsForTrack(
    getDb(),
    spotifyId,
    BY_TRACK_CANDIDATES,
    served.records.map((record) => served.digest(record)),
  );
  let broken = false;
  for (const record of records) {
    const body = runResponse(record);
    if (body === "unfit") {
      broken = true;
      continue;
    }
    // A refused result is no longer served; a replayed run whose recording is no longer served
    // has no result to show.
    if (body !== "refused" && body.analysis) {
      res.json(body);
      return;
    }
  }
  sendError(res, broken ? "failed" : "not_found");
});

/**
 * The recorded runs the API can replay
 *
 * GET /api/replays
 * Returns ReplaysResponse: one entry per recording served from the replay directory (the
 * showcase tracks), with its track and when it was recorded; an empty list when there are none.
 * The web offers these while live analysis is paused or switched off. The list does not depend
 * on REPLAY_MODE: under `off` the same tracks are analysed live.
 */
router.get("/api/replays", (_req, res) => {
  const body: ReplaysResponse = {
    success: true,
    replays: replays().records.map((record) => ({
      id: record.analysis.id,
      title: record.analysis.title,
      artist: record.analysis.artist,
      album: record.analysis.album,
      recordedAt: record.recordedAt,
    })),
  };
  res.json(ReplaysResponse.parse(body));
});

export default router;

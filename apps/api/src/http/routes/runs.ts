import {
  RESOURCE_ID_PATTERN,
  ReplaysResponse,
  RunResponse,
  SPOTIFY_ID_PATTERN,
  type StoredRun,
} from "@liner-notes/contract";
import { Router } from "express";
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
 * The result a run sent: its stored result, or for a replayed run the recording it was sent,
 * with its id, while a record with that same content (digest) is served and is of the run's
 * track; else null.
 */
function resultOf(record: RunRecord): unknown {
  if (record.analysis !== null) return record.analysis;
  const replayOf = replayOfRun(record);
  if (!replayOf || record.status !== "completed") return null;
  const recorded = replays().forDigest(replayOf.slug, replayOf.digest);
  if (!recorded || recorded.analysis.id !== record.spotifyId) return null;
  return replayedAnalysis(recorded, record.runId);
}

/**
 * A stored run and its result as RunResponse, checked against the contract, or null when the
 * stored result no longer fits it (stored by an older release). The answer is built from named
 * fields only: the query the user typed is never part of it.
 */
function runResponse(record: RunRecord): RunResponse | null {
  const run: StoredRun = {
    id: record.runId,
    status: record.status,
    mode: record.mode,
    spotifyId: record.spotifyId,
    createdAt: isoTime(record.createdAt),
    finishedAt: record.finishedAt == null ? null : isoTime(record.finishedAt),
  };
  const checked = RunResponse.safeParse({ success: true, run, analysis: resultOf(record) });
  if (checked.success) return checked.data;
  log.error(`Stored run ${record.runId} fails the contract`, {
    issues: checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  });
  return null;
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
 * 404 not_found for an unknown run (or one removed by retention); 400 invalid_input for an id
 * that is not 1-100 letters, digits, '-' or '_'; 500 failed when the stored result no longer
 * fits the contract.
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
  if (body) res.json(body);
  else sendError(res, "failed");
});

/**
 * The latest stored run of a track
 *
 * GET /api/runs/by-track/:spotifyId
 * Returns RunResponse for the run of that Spotify track that most recently finished with a
 * result of its own, or replayed a recording that is still served unchanged (runs that sent a cached
 * result are not counted). When that run's stored result no longer fits the contract, the next
 * most recent one that does is served, among the BY_TRACK_CANDIDATES latest. 404 not_found when
 * the track has no such run; 500 failed when none of those runs can be served; 400
 * invalid_input for an id that is not a Spotify track id.
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
    // A replayed run whose recording is no longer served has no result to show.
    if (body?.analysis) {
      res.json(body);
      return;
    }
    if (!body) broken = true;
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

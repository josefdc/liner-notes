import {
  RESOURCE_ID_PATTERN,
  RunResponse,
  SPOTIFY_ID_PATTERN,
  type StoredRun,
} from "@liner-notes/contract";
import { Router } from "express";
import { getDb } from "../../store/database.js";
import { getRun, latestRunsForTrack, type RunRecord } from "../../store/runs.js";
import { sendError } from "../middleware/errors.js";

const router = Router();

const isoTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** How many of a track's latest runs GET /api/runs/by-track tries before it gives up. */
export const BY_TRACK_CANDIDATES = 5;

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
  const checked = RunResponse.safeParse({ success: true, run, analysis: record.analysis });
  if (checked.success) return checked.data;
  console.error(
    `[Runs] Stored run ${record.runId} fails the contract:`,
    checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  );
  return null;
}

/**
 * A stored run
 *
 * GET /api/runs/:id
 * Returns RunResponse: the run (never the typed query) and its own result; the result is null
 * until the run has completed, and for a run that sent a result another run composed (a cached
 * one; its mode is replay) or completed before results were stored. The mode describes the
 * result the run sent; a live run without a result says nothing about one (see StoredRun).
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
 * result of its own (runs that sent a cached result are not counted). When that run's stored
 * result no longer fits the contract, the next most recent one that does is served, among the
 * BY_TRACK_CANDIDATES latest. 404 not_found when the track has no such run; 500 failed when
 * none of those runs can be served; 400 invalid_input for an id that is not a Spotify track id.
 */
router.get("/api/runs/by-track/:spotifyId", (req, res) => {
  const spotifyId = req.params.spotifyId;
  if (!SPOTIFY_ID_PATTERN.test(spotifyId)) {
    sendError(res, "invalid_input", { detail: "The Spotify track id is 22 letters or digits" });
    return;
  }
  const records = latestRunsForTrack(getDb(), spotifyId, BY_TRACK_CANDIDATES);
  if (records.length === 0) {
    sendError(res, "not_found");
    return;
  }
  for (const record of records) {
    const body = runResponse(record);
    if (body) {
      res.json(body);
      return;
    }
  }
  sendError(res, "failed");
});

export default router;

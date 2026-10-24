import {
  RESOURCE_ID_PATTERN,
  RunResponse,
  SPOTIFY_ID_PATTERN,
  type StoredRun,
} from "@liner-notes/contract";
import { type Response, Router } from "express";
import { getDb } from "../../store/database.js";
import { getRun, latestRunForTrack, type RunRecord } from "../../store/runs.js";
import { sendError } from "../middleware/errors.js";

const router = Router();

const isoTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/**
 * Answers with a stored run and its result, checked against the contract. The answer is built
 * from named fields only: the query the user typed is never part of it.
 */
function sendRun(res: Response, record: RunRecord): void {
  const run: StoredRun = {
    id: record.runId,
    status: record.status,
    mode: record.mode,
    spotifyId: record.spotifyId,
    createdAt: isoTime(record.createdAt),
    finishedAt: record.finishedAt == null ? null : isoTime(record.finishedAt),
  };
  const checked = RunResponse.safeParse({ success: true, run, analysis: record.analysis });
  if (!checked.success) {
    // A result stored by an older release that today's contract no longer reads.
    console.error(
      `[Runs] Stored run ${record.runId} fails the contract:`,
      checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
    sendError(res, "failed");
    return;
  }
  res.json(checked.data);
}

/**
 * A stored run
 *
 * GET /api/runs/:id
 * Returns RunResponse: the run (never the typed query) and its result, null until it has
 * completed. 404 not_found for an unknown run (or one removed by retention); 400 invalid_input
 * for an id that is not 1-100 letters, digits, '-' or '_'.
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
  sendRun(res, record);
});

/**
 * The latest stored run of a track
 *
 * GET /api/runs/by-track/:spotifyId
 * Returns RunResponse for the most recent run with a stored result for that Spotify track.
 * 404 not_found when there is none; 400 invalid_input for an id that is not a Spotify track id.
 */
router.get("/api/runs/by-track/:spotifyId", (req, res) => {
  const spotifyId = req.params.spotifyId;
  if (!SPOTIFY_ID_PATTERN.test(spotifyId)) {
    sendError(res, "invalid_input", { detail: "The Spotify track id is 22 letters or digits" });
    return;
  }
  const record = latestRunForTrack(getDb(), spotifyId);
  if (!record) {
    sendError(res, "not_found");
    return;
  }
  sendRun(res, record);
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { liveRefused } from "../../replay/mode.js";
import { replays } from "../../replay/records.js";
import { describeError } from "../../sources/http.js";
import { searchTracks } from "../../sources/spotify.js";
import { asyncRoute, sendError } from "../middleware/errors.js";
import { boundedText, describeIssues } from "../validation.js";

const router = Router();

const SuggestQuerySchema = z.object({
  query: boundedText(2),
  limit: z
    .string()
    .regex(/^\d{1,2}$/, "must be an integer from 1 to 10")
    .transform(Number)
    .pipe(z.number().int().min(1).max(10))
    .optional(),
});

/**
 * Search suggestions for autocomplete
 *
 * GET /api/search/suggest?query=mid&limit=5
 * Returns: Top matching tracks for autocomplete dropdown. The query is 2-200 characters and the
 * limit 1-10 (default 5); anything else is a 400 `invalid_input`. A Spotify failure is a 502
 * `upstream_unavailable` with a generic message.
 *
 * Under REPLAY_MODE=only (or fallback while live analysis is unavailable: no Spotify keys, or the
 * model budget spent) Spotify is not called:
 * the suggestions are the recorded tracks whose title, artist or album has a word starting with
 * each word of the query (often none).
 */
router.get(
  "/api/search/suggest",
  asyncRoute(async (req, res) => {
    const parsed = SuggestQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "invalid_input", {
        issues: describeIssues(parsed.error),
        example: "/api/search/suggest?query=mid&limit=5",
      });
      return;
    }
    const { query, limit = 5 } = parsed.data;

    if (await liveRefused()) {
      const suggestions = replays().suggestions(query, limit);
      res.json({
        success: true,
        suggestions,
        meta: { query, resultCount: suggestions.length, timestamp: new Date().toISOString() },
      });
      return;
    }

    try {
      // Suggestions carry no preview link: the contract's SearchCandidate has none, and a
      // preview is looked up for the track that is analysed.
      const suggestions = (await searchTracks(query, limit)).map(
        ({ previewUrl: _previewUrl, ...suggestion }) => suggestion,
      );

      res.json({
        success: true,
        suggestions,
        meta: {
          query,
          resultCount: suggestions.length,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      // Spotify's errors are typed (sources/http.ts); the client gets a generic message.
      console.error("[Search] Suggest failed:", describeError(error));
      sendError(res, "upstream_unavailable", { suggestions: [] });
    }
  }),
);

export default router;

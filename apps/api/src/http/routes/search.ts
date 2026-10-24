import { Router } from "express";
import { z } from "zod";
import { searchMultipleTracks } from "../../sources/spotify.js";
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

    try {
      const result = await searchMultipleTracks.invoke({ query, limit });

      // Tool returns JSON string or error message
      if (typeof result === "string" && result.startsWith("Error")) {
        console.error(`[Search] Suggest failed: ${result}`);
        sendError(res, "upstream_unavailable", { suggestions: [] });
        return;
      }

      // Suggestions carry no preview link: the contract's SearchCandidate has none, and a
      // preview is looked up for the track that is analysed.
      const suggestions = (JSON.parse(result as string) as Record<string, unknown>[]).map(
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
      console.error("[Search] Suggest failed:", error);
      sendError(res, "upstream_unavailable", { suggestions: [] });
    }
  }),
);

export default router;

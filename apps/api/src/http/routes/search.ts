import { Router } from "express";
import { searchMultipleTracks } from "../../sources/spotify.js";

const router = Router();

/**
 * Search suggestions for autocomplete
 *
 * GET /api/search/suggest?query=mid&limit=5
 * Returns: Top matching tracks for autocomplete dropdown
 */
router.get("/api/search/suggest", async (req, res) => {
  const query = req.query.query as string;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 5, 1), 10);

  if (!query || typeof query !== "string" || query.length < 2) {
    res.status(400).json({
      error: "Query must be at least 2 characters",
      example: "/api/search/suggest?query=mid&limit=5",
    });
    return;
  }

  console.log(`🔍 [API] Search suggest: "${query}" (limit: ${limit})`);

  try {
    // Invoke the LangGraph tool and parse JSON response
    const result = await searchMultipleTracks.invoke({ query, limit });

    // Tool returns JSON string or error message
    if (typeof result === "string" && result.startsWith("Error")) {
      res.status(500).json({ error: result, suggestions: [] });
      return;
    }

    const suggestions = JSON.parse(result as string);

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
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [API] Search suggest error:`, message);

    res.status(500).json({
      error: "Search failed",
      message,
    });
  }
});

export default router;

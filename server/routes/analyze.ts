import { Router } from "express";
import { Command } from "@langchain/langgraph";
import { analyzeSong, resumeWithSelection, createSonicAgentGraph } from "../agent/graph.js";
import type { TrackData, SearchCandidate } from "../agent/schema.js";

const router = Router();

/**
 * Analyze a song (non-streaming)
 *
 * POST /api/analyze
 * Body: { "query": "Song name Artist" }
 * Returns: TrackData or error
 */
router.post("/api/analyze", async (req, res) => {
  const startTime = Date.now();
  const { query } = req.body;

  if (!query || typeof query !== "string") {
    res.status(400).json({
      error: "Missing or invalid 'query' parameter",
      example: { query: "Midnight City M83" },
    });
    return;
  }

  console.log(`\n📥 [API] Received analysis request: "${query}"`);

  try {
    const trackData = await analyzeSong(query);

    if (!trackData) {
      res.status(404).json({
        error: "Could not analyze song",
        query,
        message: "The song may not exist on Spotify or analysis failed",
      });
      return;
    }

    const duration = Date.now() - startTime;
    console.log(`📤 [API] Analysis complete in ${duration}ms`);

    res.json({
      success: true,
      data: trackData,
      meta: {
        query,
        durationMs: duration,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [API] Error analyzing "${query}":`, message);

    res.status(500).json({
      error: "Internal server error",
      message,
      query,
    });
  }
});

/**
 * Stream analysis with Server-Sent Events
 *
 * GET /api/analyze/stream?query=Song+Name
 *
 * Events:
 * - status: Agent progress updates
 * - candidates: Human-in-the-loop disambiguation required
 * - complete: Final TrackData
 * - error: Error occurred
 */
router.get("/api/analyze/stream", async (req, res) => {
  const query = req.query.query as string;

  if (!query || typeof query !== "string") {
    res.status(400).json({
      error: "Missing or invalid 'query' parameter",
      example: "/api/analyze/stream?query=Midnight+City+M83",
    });
    return;
  }

  console.log(`\n📡 [SSE] Starting streaming analysis: "${query}"`);

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  // Generate thread ID for potential resume
  const threadId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: "connected", threadId, timestamp: new Date().toISOString() })}\n\n`);

  try {
    const graph = createSonicAgentGraph();

    // Use LangGraph streaming
    const stream = await graph.stream(
      { songQuery: query },
      {
        configurable: { thread_id: threadId },
        streamMode: ["updates", "custom"],
      }
    );

    let interruptData: { candidates: SearchCandidate[] } | null = null;

    for await (const chunk of stream) {
      const [mode, data] = chunk as unknown as [string, unknown];

      if (mode === "custom") {
        // Custom events from writer (status updates)
        res.write(`data: ${JSON.stringify(data)}\n\n`);

        // Check for disambiguation event
        const eventData = data as { type: string; candidates?: SearchCandidate[] };
        if (eventData.type === "candidates" && eventData.candidates) {
          interruptData = { candidates: eventData.candidates };
        }
      } else if (mode === "updates") {
        // Node state updates
        const updates = data as Record<string, unknown>;

        for (const [nodeName, nodeData] of Object.entries(updates)) {
          const stateData = nodeData as { trackData?: TrackData; error?: string };

          // Send completion when we have final data
          if (stateData.trackData) {
            res.write(`data: ${JSON.stringify({ type: "complete", data: stateData.trackData })}\n\n`);
          }

          // Send error if present
          if (stateData.error) {
            res.write(`data: ${JSON.stringify({ type: "error", error: stateData.error })}\n\n`);
          }
        }
      }
    }

    // If we have interrupt data, send it and keep connection for resume
    if (interruptData) {
      res.write(`data: ${JSON.stringify({
        type: "interrupt",
        reason: "disambiguation",
        threadId,
        candidates: interruptData.candidates,
        message: "Please select the correct song",
      })}\n\n`);
    }

    // Send done event
    res.write(`data: ${JSON.stringify({ type: "done", timestamp: new Date().toISOString() })}\n\n`);
    res.end();

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [SSE] Error:`, message);

    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  }
});

/**
 * Resume after Human-in-the-loop selection
 *
 * POST /api/analyze/resume
 * Body: { "threadId": "...", "selectedTrackId": "spotify_track_id" }
 */
router.post("/api/analyze/resume", async (req, res) => {
  const { threadId, selectedTrackId } = req.body;

  if (!threadId || !selectedTrackId) {
    res.status(400).json({
      error: "Missing required parameters",
      example: { threadId: "stream-123", selectedTrackId: "6GyFP1nfCDB8lbD2bG0Hq9" },
    });
    return;
  }

  console.log(`\n🔄 [API] Resuming analysis: threadId=${threadId}, track=${selectedTrackId}`);

  try {
    const trackData = await resumeWithSelection(threadId, selectedTrackId);

    if (!trackData) {
      res.status(404).json({
        error: "Could not complete analysis",
        message: "Resume failed or track not found",
      });
      return;
    }

    res.json({
      success: true,
      data: trackData,
      meta: {
        threadId,
        selectedTrackId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [API] Resume error:`, message);

    res.status(500).json({
      error: "Resume failed",
      message,
    });
  }
});

/**
 * Resume streaming after selection
 *
 * GET /api/analyze/stream/resume?threadId=...&selectedTrackId=...
 */
router.get("/api/analyze/stream/resume", async (req, res) => {
  const threadId = req.query.threadId as string;
  const selectedTrackId = req.query.selectedTrackId as string;

  if (!threadId || !selectedTrackId) {
    res.status(400).json({
      error: "Missing required parameters",
      example: "/api/analyze/stream/resume?threadId=stream-123&selectedTrackId=6GyFP1nfCDB8lbD2bG0Hq9",
    });
    return;
  }

  console.log(`\n📡 [SSE] Resuming stream: threadId=${threadId}, selectedTrackId=${selectedTrackId}`);

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({ type: "resuming", threadId, timestamp: new Date().toISOString() })}\n\n`);

  try {
    const graph = createSonicAgentGraph();

    console.log(`🔄 [Resume] Invoking graph.stream with Command({ resume: "${selectedTrackId}" })`);

    // Use Command({ resume: ... }) to continue from interrupt with the selected value
    const stream = await graph.stream(
      new Command({ resume: selectedTrackId }),
      {
        configurable: { thread_id: threadId },
        streamMode: ["updates", "custom"],
      }
    );

    console.log(`🔄 [Resume] Stream created, iterating...`);

    for await (const chunk of stream) {
      const [mode, data] = chunk as unknown as [string, unknown];

      console.log(`📦 [Resume] Received chunk: mode=${mode}`, JSON.stringify(data).substring(0, 200));

      if (mode === "custom") {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } else if (mode === "updates") {
        const updates = data as Record<string, unknown>;

        for (const [nodeName, nodeData] of Object.entries(updates)) {
          console.log(`📦 [Resume] Node update: ${nodeName}`);
          const stateData = nodeData as { trackData?: TrackData; error?: string };

          if (stateData.trackData) {
            res.write(`data: ${JSON.stringify({ type: "complete", data: stateData.trackData })}\n\n`);
          }

          if (stateData.error) {
            res.write(`data: ${JSON.stringify({ type: "error", error: stateData.error })}\n\n`);
          }
        }
      }
    }

    console.log(`✅ [Resume] Stream completed`);
    res.write(`data: ${JSON.stringify({ type: "done", timestamp: new Date().toISOString() })}\n\n`);
    res.end();

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [Resume] Error:`, error);
    res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    res.end();
  }
});

export default router;

import { Router } from "express";
import { z } from "zod";
import { generateStructuredOutput } from "../../agent/geminiClient.js";

const router = Router();

/**
 * Generate additional obscure facts for a track
 *
 * POST /api/factoids/decrypt
 * Body: { "trackId": "...", "trackTitle": "...", "trackArtist": "...", "existingFactoidIds": ["f1", "f2"] }
 * Returns: { factoids: Factoid[] } - 3 new obscure facts with entities
 */
router.post("/api/factoids/decrypt", async (req, res) => {
  const { trackId, trackTitle, trackArtist, existingFactoidIds = [] } = req.body;

  if (!trackId || !trackTitle) {
    res.status(400).json({
      error: "Missing required parameters",
      example: {
        trackId: "6GyFP1nfCDB8lbD2bG0Hq9",
        trackTitle: "Midnight City",
        trackArtist: "M83",
        existingFactoidIds: ["f1", "f2"],
      },
    });
    return;
  }

  console.log(`\n🔓 [API] Decrypting more facts for: "${trackTitle}" by ${trackArtist}`);

  // Use a FLAT schema to avoid Gemini's nesting depth limits
  // Entities are embedded as a JSON string instead of nested objects
  const FlatFactoidSchema = z.object({
    id: z.string().describe("Unique identifier, e.g. 'f1', 'f2'"),
    title: z.string().describe("Catchy title summarizing the factoid, max 50 chars"),
    content: z.string().describe("Detailed explanation 1-3 sentences with specific facts"),
    type: z.enum(["production", "trivia", "lyrics"]).describe("Category of the factoid"),
    entityNames: z
      .array(z.string())
      .optional()
      .describe("Names of entities mentioned (synths, producers, etc)"),
  });

  const DecryptResponseSchema = z.object({
    factoids: z.array(FlatFactoidSchema).length(3),
  });

  const prompt = `You are a music historian with deep knowledge of obscure facts.

Generate 3 NEW, obscure, and fascinating factoids about "${trackTitle}" by ${trackArtist}.

IMPORTANT:
- These must be DIFFERENT from any facts with IDs: ${existingFactoidIds.join(", ") || "none yet"}
- Focus on OBSCURE details that most fans don't know
- Include specific entities (equipment, producers, techniques) that can be searched
- Each factoid should reveal something surprising or hidden

Categories to explore:
- Hidden production techniques or studio secrets
- Obscure samples or influences
- Little-known collaborators or session musicians
- Equipment/synths used (e.g., "Roland Juno-106", "Prophet-5")
- Unusual recording locations or circumstances
- Cultural or historical context most miss

For entities, extract specific searchable items like:
- Synths/instruments: "Roland Juno-106", "Oberheim OB-Xa"
- Producers: "Flood", "Nigel Godrich"
- Techniques: "sidechain compression", "tape saturation"
- Samples: specific songs that were sampled

Generate unique IDs starting from "f${existingFactoidIds.length + 1}".`;

  try {
    const result = await generateStructuredOutput({
      prompt,
      schema: DecryptResponseSchema,
      useGoogleSearch: true, // Use grounding for real-time data
      useFallbackOnQuota: true,
      tier: "fast",
    });

    if (!result.data) {
      res.status(500).json({
        error: "Failed to generate factoids",
        message: result.error || "Unknown error",
      });
      return;
    }

    console.log(`✅ [API] Generated ${result.data.factoids.length} new factoids`);

    // Transform flat factoids to full format with entities
    const fullFactoids = result.data.factoids.map((f) => ({
      id: f.id,
      title: f.title,
      content: f.content,
      type: f.type,
      // Convert entityNames to full entity objects
      entities: (f.entityNames || []).map((name, i) => ({
        id: `${f.id}-e${i + 1}`,
        text: name,
        type: "technique" as const, // Default type, could be inferred
        searchQuery: name,
      })),
    }));

    res.json({
      success: true,
      factoids: fullFactoids,
      meta: {
        trackId,
        model: result.model,
        groundingUsed: result.groundingUsed,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [API] Decrypt error:`, message);

    res.status(500).json({
      error: "Failed to decrypt factoids",
      message,
    });
  }
});

/**
 * Stream factoids one-by-one via SSE for faster perceived speed
 *
 * GET /api/factoids/decrypt/stream?trackTitle=...&trackArtist=...&existingIds=f1,f2
 * SSE Events:
 * - { type: "factoid", data: Factoid }
 * - { type: "done" }
 * - { type: "error", error: string }
 */
router.get("/api/factoids/decrypt/stream", async (req, res) => {
  const trackTitle = req.query.trackTitle as string;
  const trackArtist = req.query.trackArtist as string;
  const existingIdsParam = req.query.existingIds as string;
  const existingIds = existingIdsParam ? existingIdsParam.split(",").filter(Boolean) : [];

  if (!trackTitle) {
    res.status(400).json({
      error: "Missing required parameter: trackTitle",
      example:
        "/api/factoids/decrypt/stream?trackTitle=Midnight+City&trackArtist=M83&existingIds=f1,f2",
    });
    return;
  }

  console.log(`\n📡 [SSE] Streaming factoids for: "${trackTitle}" by ${trackArtist}`);

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Send connected event
  res.write(
    `data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`,
  );

  // Schema for a single factoid
  const SingleFactoidSchema = z.object({
    id: z.string().describe("Unique identifier"),
    title: z.string().describe("Catchy title, max 50 chars"),
    content: z.string().describe("Detailed explanation 1-3 sentences"),
    type: z.enum([
      "production",
      "trivia",
      "lyrics",
      "credits",
      "sample",
      "curiosity",
      "connection",
    ]),
    entityNames: z
      .array(z.string())
      .optional()
      .describe("Names of entities (synths, producers, etc)"),
  });

  const categories = [
    "hidden production techniques or studio secrets",
    "obscure samples, influences, or interpolations",
    "little-known collaborators, session musicians, or equipment used",
  ];

  // Generate 3 factoids one at a time
  for (let i = 0; i < 3; i++) {
    const factoidId = `f${existingIds.length + i + 1}`;

    const prompt = `You are a music historian specializing in obscure facts.

Generate ONE fascinating, obscure factoid about "${trackTitle}" by ${trackArtist}.

Focus on: ${categories[i]}

REQUIREMENTS:
- Must be DIFFERENT from existing facts (IDs: ${[...existingIds, ...Array.from({ length: i }, (_, j) => `f${existingIds.length + j + 1}`)].join(", ") || "none"})
- Include 2-4 specific searchable entities (equipment names, producer names, techniques)
- The factoid should surprise even dedicated fans
- Use ID: "${factoidId}"

Entity examples: "Roland Juno-106", "Nigel Godrich", "sidechain compression", "Abbey Road Studios"`;

    try {
      const result = await generateStructuredOutput({
        prompt,
        schema: SingleFactoidSchema,
        useGoogleSearch: true,
        useFallbackOnQuota: true,
        tier: "fast",
      });

      if (result.data) {
        // Transform to full factoid format
        const fullFactoid = {
          id: result.data.id || factoidId,
          title: result.data.title,
          content: result.data.content,
          type: result.data.type,
          entities: (result.data.entityNames || []).map((name, idx) => ({
            id: `${factoidId}-e${idx + 1}`,
            text: name,
            type: "technique" as const,
            searchQuery: name,
          })),
        };

        console.log(`✅ [SSE] Emitting factoid ${i + 1}/3: "${fullFactoid.title}"`);
        res.write(`data: ${JSON.stringify({ type: "factoid", data: fullFactoid })}\n\n`);
      } else {
        console.warn(`⚠️ [SSE] Failed to generate factoid ${i + 1}:`, result.error);
        res.write(
          `data: ${JSON.stringify({ type: "error", error: result.error || "Generation failed", index: i })}\n\n`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`❌ [SSE] Error generating factoid ${i + 1}:`, message);
      res.write(`data: ${JSON.stringify({ type: "error", error: message, index: i })}\n\n`);
    }
  }

  // Send done event
  res.write(`data: ${JSON.stringify({ type: "done", timestamp: new Date().toISOString() })}\n\n`);
  res.end();
  console.log(`✅ [SSE] Factoid stream completed`);
});

export default router;

import { type Response, Router } from "express";
import { z } from "zod";
import { type GenerateResult, generateStructuredOutput } from "../../agent/geminiClient.js";
import { asyncRoute, markFailed, sendError } from "../middleware/errors.js";
import { boundedText, describeIssues, factoidId, newestIds, trackId } from "../validation.js";

const router = Router();

/** Interval between heartbeat messages on the factoid stream. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

// =============================================================================
// Input
// =============================================================================

// Title and artist come from track metadata and the ids from earlier answers, so they are
// bounded rather than refused: long text is truncated, and the prompt names only the newest ids
// (new ids are still numbered after all of them). The body and URL size limits bound the lists.
const DecryptBodySchema = z.object({
  trackId,
  trackTitle: boundedText(1, { truncate: true }),
  trackArtist: boundedText(0, { truncate: true }).optional(),
  existingFactoidIds: z.array(factoidId).default([]),
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
});

const DECRYPT_EXAMPLE = {
  trackId: "6GyFP1nfCDB8lbD2bG0Hq9",
  trackTitle: "Midnight City",
  trackArtist: "M83",
  existingFactoidIds: ["f1", "f2"],
};

const describeTrack = (title: string, artist?: string) =>
  artist ? `"${title}" by ${artist}` : `"${title}"`;

// =============================================================================
// Model output
// =============================================================================

// A flat schema: Gemini limits nesting depth, so entities are a list of names.
const FlatFactoidSchema = z.object({
  id: z.string().describe("Unique identifier, e.g. 'f1', 'f2'"),
  title: z.string().describe("Catchy title summarizing the factoid, max 50 chars"),
  content: z.string().describe("Detailed explanation 1-3 sentences with specific facts"),
  type: z.enum(["production", "trivia"]).describe("Category of the factoid"),
  entityNames: z
    .array(z.string())
    .optional()
    .describe("Names of entities mentioned (synths, producers, etc)"),
});

const DecryptResponseSchema = z.object({
  factoids: z.array(FlatFactoidSchema).length(3),
});

const SingleFactoidSchema = z.object({
  id: z.string().describe("Unique identifier"),
  title: z.string().describe("Catchy title, max 50 chars"),
  content: z.string().describe("Detailed explanation 1-3 sentences"),
  type: z.enum(["production", "trivia", "credits", "sample", "curiosity", "connection"]),
  entityNames: z
    .array(z.string())
    .optional()
    .describe("Names of entities (synths, producers, etc)"),
});

function toEntities(entityNames: string[] | undefined, factoidId: string) {
  return (entityNames ?? []).map((name, index) => ({
    id: `${factoidId}-e${index + 1}`,
    text: name,
    type: "technique" as const,
    searchQuery: name,
  }));
}

// =============================================================================
// POST /api/factoids/decrypt
// =============================================================================

/**
 * Generate additional obscure facts for a track
 *
 * POST /api/factoids/decrypt
 * Body: { "trackId": "...", "trackTitle": "...", "trackArtist": "...", "existingFactoidIds": ["f1", "f2"] }
 * Returns: { factoids: Factoid[] } - 3 new obscure facts with entities
 * A malformed body is a 400 `invalid_input`; a failed generation a 500 `failed`.
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

    console.log(`[Factoids] Decrypting more facts for ${track}`);

    const prompt = `You are a music historian with deep knowledge of obscure facts.

Generate 3 NEW, obscure, and fascinating factoids about ${track}.

IMPORTANT:
- These must be DIFFERENT from any facts with IDs: ${newestIds(existingFactoidIds).join(", ") || "none yet"}
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

    let result: GenerateResult<z.infer<typeof DecryptResponseSchema>>;
    try {
      result = await generateStructuredOutput({
        prompt,
        schema: DecryptResponseSchema,
        useGoogleSearch: true,
        useFallbackOnQuota: true,
        tier: "fast",
      });
    } catch (error) {
      console.error("[Factoids] Decrypt failed:", error);
      sendError(res, "failed");
      return;
    }

    if (!result.data) {
      console.error(`[Factoids] Decrypt failed: ${result.error ?? "no data"}`);
      sendError(res, "failed");
      return;
    }

    res.json({
      success: true,
      factoids: result.data.factoids.map((f) => ({
        id: f.id,
        title: f.title,
        content: f.content,
        type: f.type,
        entities: toEntities(f.entityNames, f.id),
      })),
      meta: {
        trackId: parsed.data.trackId,
        model: result.model,
        groundingUsed: result.groundingUsed,
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

// =============================================================================
// GET /api/factoids/decrypt/stream
// =============================================================================

const STREAM_ERRORS = {
  invalid_input: "The request is not valid.",
  failed: "This fact could not be generated.",
} as const;

type StreamEvent = Record<string, unknown> & { type: string };

const CLOSED = Symbol("closed");

/**
 * A server-sent event stream: status 200 with headers flushed at once, a heartbeat every
 * HEARTBEAT_INTERVAL_MS, and `closed` once the client has gone (the response closed before it
 * was ended). Nothing is written after that.
 */
function openEventStream(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const disconnect = new AbortController();
  const send = (event: StreamEvent) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
  // Listen on the response: the request's own "close" also fires once its body has been read.
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) disconnect.abort();
  });
  const disconnected = new Promise<typeof CLOSED>((resolve) => {
    disconnect.signal.addEventListener("abort", () => resolve(CLOSED), { once: true });
  });

  return {
    send,
    get closed() {
      return disconnect.signal.aborted;
    },
    /** Resolves with the work's result, or with CLOSED as soon as the client goes away. */
    untilClosed<T>(work: Promise<T>): Promise<T | typeof CLOSED> {
      return Promise.race([work, disconnected]);
    },
    error(code: keyof typeof STREAM_ERRORS, detail?: Record<string, unknown>) {
      send({ type: "error", code, error: STREAM_ERRORS[code], ...detail });
    },
    done() {
      send({ type: "done", timestamp: new Date().toISOString() });
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}

const STREAM_CATEGORIES = [
  "hidden production techniques or studio secrets",
  "obscure samples, influences, or interpolations",
  "little-known collaborators, session musicians, or equipment used",
];

/**
 * Stream factoids one-by-one via SSE for faster perceived speed
 *
 * GET /api/factoids/decrypt/stream?trackTitle=...&trackArtist=...&existingIds=f1,f2
 * Messages (all on the default `message` event):
 * - { type: "connected" }
 * - { type: "factoid", data: Factoid }
 * - { type: "error", code, error, index? }: invalid input, or one factoid that failed
 * - { type: "heartbeat" }: every 15 s while the stream is open
 * - { type: "done" }: always last
 *
 * Invalid input is reported in the stream (an EventSource cannot read an error status). When
 * the client disconnects, no further factoid is requested and nothing more is written.
 */
router.get(
  "/api/factoids/decrypt/stream",
  asyncRoute(async (req, res) => {
    const stream = openEventStream(res);

    const parsed = StreamQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      markFailed(res);
      stream.error("invalid_input", { issues: describeIssues(parsed.error) });
      stream.done();
      return;
    }
    const { trackTitle, trackArtist, existingIds } = parsed.data;
    const track = describeTrack(trackTitle, trackArtist);

    console.log(`[Factoids] Streaming factoids for ${track}`);
    stream.send({ type: "connected", timestamp: new Date().toISOString() });

    for (let i = 0; i < STREAM_CATEGORIES.length && !stream.closed; i++) {
      const factoidId = `f${existingIds.length + i + 1}`;
      const previousIds = [
        ...newestIds(existingIds),
        ...Array.from({ length: i }, (_, j) => `f${existingIds.length + j + 1}`),
      ];

      const prompt = `You are a music historian specializing in obscure facts.

Generate ONE fascinating, obscure factoid about ${track}.

Focus on: ${STREAM_CATEGORIES[i]}

REQUIREMENTS:
- Must be DIFFERENT from existing facts (IDs: ${previousIds.join(", ") || "none"})
- Include 2-4 specific searchable entities (equipment names, producer names, techniques)
- The factoid should surprise even dedicated fans
- Use ID: "${factoidId}"

Entity examples: "Roland Juno-106", "Nigel Godrich", "sidechain compression", "Abbey Road Studios"`;

      // The model client takes no abort signal: on disconnect the call in flight is left to
      // finish on its own, its result is dropped and no further call is made.
      let result: GenerateResult<z.infer<typeof SingleFactoidSchema>>;
      try {
        const outcome = await stream.untilClosed(
          generateStructuredOutput({
            prompt,
            schema: SingleFactoidSchema,
            useGoogleSearch: true,
            useFallbackOnQuota: true,
            tier: "fast",
          }),
        );
        if (outcome === CLOSED) break;
        result = outcome;
      } catch (error) {
        if (stream.closed) break;
        console.error(`[Factoids] Factoid ${i + 1} failed:`, error);
        stream.error("failed", { index: i });
        continue;
      }

      if (result.data) {
        stream.send({
          type: "factoid",
          data: {
            id: result.data.id || factoidId,
            title: result.data.title,
            content: result.data.content,
            type: result.data.type,
            entities: toEntities(result.data.entityNames, factoidId),
          },
        });
      } else {
        console.warn(`[Factoids] Factoid ${i + 1} failed: ${result.error ?? "no data"}`);
        stream.error("failed", { index: i });
      }
    }

    if (stream.closed) {
      console.log(`[Factoids] Client left; stopped streaming factoids for ${track}`);
      return;
    }
    stream.done();
  }),
);

export default router;

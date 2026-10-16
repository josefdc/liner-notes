/**
 * Composer Node — Synthesis with Gemini structured output
 * Uses unified geminiClient for structured output with Google Search grounding
 */

import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { generateStructuredOutput, GEMINI_MODEL_PRO } from "../geminiClient.js";
import { FlatTrackDataSchema, transformFlatToTrackData } from "../schema.js";
import { COMPOSER_SYSTEM_PROMPT, formatComposerPrompt } from "../prompts.js";
import { enrichGenealogyWithArtwork } from "../enricher.js";
import { createFallbackTrackData } from "../fallback.js";
import { withRetry, TransientError, isTransient } from "../errors.js";
import type { SonicAgentStateType } from "../state.js";

/** A short, readable reason from a model error (provider errors often arrive as JSON text). */
export function modelErrorReason(error: string | undefined): string {
  if (!error) return "No output from the model";
  try {
    const parsed = JSON.parse(error) as { error?: { message?: string; status?: string } };
    const message = parsed.error?.message;
    if (message) {
      return (parsed.error?.status ? `${message} (${parsed.error.status})` : message).slice(0, 300);
    }
  } catch {
    // Not JSON — use the text as is
  }
  return error.slice(0, 300);
}

export type ModelUnavailableReason = "no_output" | "rate_limited" | "timeout" | "auth" | "error";

/**
 * The category sent to clients when the model call fails. Provider error text stays in the
 * server log: it can name keys, projects or quotas and is not meant for users.
 */
export function modelErrorCategory(error: string | undefined): ModelUnavailableReason {
  if (!error) return "no_output";
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(error)) return "rate_limited";
  if (/timed? ?out|DEADLINE_EXCEEDED|ETIMEDOUT|\babort/i.test(error)) return "timeout";
  if (/\b40[13]\b|API key|UNAUTHENTICATED|PERMISSION_DENIED|credential/i.test(error)) return "auth";
  return "error";
}

const MODEL_REASON_TEXT: Record<ModelUnavailableReason, string> = {
  no_output: "no output",
  rate_limited: "rate limited",
  timeout: "timed out",
  auth: "not authorised",
  error: "request failed",
};

// Audio problems that may clear up on the next run. A result missing audio for one of these
// reasons is not stored, so it is not served after the analysis service recovers.
const TRANSIENT_AUDIO_REASONS = new Set(["service_unavailable", "analysis_failed", "not_run"]);

export async function composerNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return {
      error: "No Spotify data to compose",
      statusMessages: ["❌ Cannot compose - missing track data"],
    };
  }

  const writer = config.writer;
  const store = getStore();
  writer?.({
    type: "status",
    code: "GEMINI-CONNECT",
    message: `Connecting to neural synthesis engine (${GEMINI_MODEL_PRO})...`,
    node: "composer",
    timestamp: new Date().toISOString(),
  });

  console.log("🎼 [Composer] Synthesizing data for:", state.spotifyData.title);

  const prompt = formatComposerPrompt(state.spotifyData, state.audioFeatures, state.researchData);

  // Use FLATTENED schema to avoid Gemini nesting depth limits
  // Then transform back to full TrackData structure (with retry on transient failures)
  const result = await withRetry(
    async () => {
      const r = await generateStructuredOutput({
        prompt,
        schema: FlatTrackDataSchema,
        systemPrompt: COMPOSER_SYSTEM_PROMPT,
        useGoogleSearch: true, // Enable grounding for real-time data
        useFallbackOnQuota: true, // Auto-fallback through model chain on quota errors
        tier: "pro",
      });
      if (!r.data && r.error && isTransient(r.error)) {
        throw new TransientError(`Gemini: ${r.error}`);
      }
      return r;
    },
    { maxAttempts: 2, initialInterval: 2000 },
  );

  if (result.data) {
    // Transform flat LLM output to full nested TrackData. Measured audio fields (bpm, key,
    // energy, ...) and keyMoments come from the audio measurement, never from the model.
    let trackData = transformFlatToTrackData(result.data, state.audioFeatures);

    // Track metadata is known from Spotify; keep it even if the model output differs.
    const spotify = state.spotifyData;
    trackData = {
      ...trackData,
      id: spotify.id,
      title: spotify.title,
      artist: spotify.artist,
      album: spotify.album,
      coverUrl: spotify.coverUrl || trackData.coverUrl,
      spotifyUrl: spotify.spotifyUrl || trackData.spotifyUrl,
      explicit: spotify.explicit ?? trackData.explicit,
      releaseYear: spotify.releaseDate?.split("-")[0] || trackData.releaseYear,
      durationSeconds: spotify.durationMs
        ? Math.round(spotify.durationMs / 1000)
        : trackData.durationSeconds,
    };

    // Pass through Spotify preview URL for audio playback in Player
    if (spotify.previewUrl) {
      trackData = { ...trackData, previewUrl: spotify.previewUrl };
    }

    console.log(
      `✅ [Composer] Generated via ${result.model}${result.groundingUsed ? " + Google Search" : ""}`,
    );

    // Enrich genealogy with real Spotify album artwork
    writer?.({
      type: "status",
      code: "GRAPH-ENRICH",
      message: "Cross-referencing visual artifacts from Spotify...",
      node: "composer",
      timestamp: new Date().toISOString(),
    });

    try {
      const enrichedGenealogy = await enrichGenealogyWithArtwork(
        trackData.genealogy,
        state.spotifyData?.coverUrl || trackData.coverUrl,
      );
      trackData = { ...trackData, genealogy: enrichedGenealogy };
      console.log("✅ [Composer] Enriched genealogy with Spotify artwork");
    } catch (enrichError) {
      console.warn("⚠️ [Composer] Could not enrich genealogy:", enrichError);
    }

    writer?.({ type: "complete", data: trackData });

    // Cache successful result in long-term memory (unless the audio may be measurable later)
    const transientAudio = TRANSIENT_AUDIO_REASONS.has(trackData.audioUnavailableReason ?? "");
    if (store && !transientAudio) {
      const normalizedQuery = state.songQuery.toLowerCase().trim();
      try {
        await store.put(["tracks"], normalizedQuery, {
          trackData,
          timestamp: Date.now(),
        });
        console.log("📦 [Composer] Cached result for:", normalizedQuery);
      } catch (e) {
        console.warn("⚠️ [Composer] Store write error:", e);
      }
    }

    return {
      trackData,
      statusMessages: ["🎼 Analysis complete!"],
    };
  }

  // Fallback: Build from state data if LLM fails
  const modelError = modelErrorCategory(result.error);
  const modelErrorText = MODEL_REASON_TEXT[modelError];
  console.log("⚠️ [Composer] LLM failed, using fallback data:", modelErrorReason(result.error));
  console.log(
    "📊 [Composer] Error details:",
    JSON.stringify(
      {
        error: result.error,
        model: result.model,
        hasResearchData: {
          samples: state.researchData?.samples?.length || 0,
          productionTrivia: state.researchData?.productionTrivia?.length || 0,
        },
      },
      null,
      2,
    ),
  );

  writer?.({
    type: "status",
    code: "GEMINI-ERROR",
    message: `Model unavailable (${modelErrorText}); building the result from source data only`,
    node: "composer",
    timestamp: new Date().toISOString(),
  });

  let fallbackData = {
    ...(await createFallbackTrackData(state)),
    modelUnavailable: true,
    modelUnavailableReason: modelError,
  };

  // Still try to enrich artwork for fallback
  try {
    const enrichedGenealogy = await enrichGenealogyWithArtwork(
      fallbackData.genealogy,
      state.spotifyData?.coverUrl || fallbackData.coverUrl,
    );
    fallbackData = { ...fallbackData, genealogy: enrichedGenealogy };
  } catch {
    // Ignore enrichment errors in fallback
  }

  writer?.({ type: "complete", data: fallbackData });
  console.log("⚠️ [Composer] Generated fallback track data without the model");

  return {
    trackData: fallbackData,
    statusMessages: [`⚠️ Model unavailable (${modelErrorText}); showing source data only`],
  };
}

/**
 * Unified Gemini Client for The Sonic Agent
 *
 * Provides a single entry point for all LLM operations with:
 * - Two-tier model selection: Pro (reasoning) and Fast (speed)
 * - Native structured output via responseJsonSchema
 * - Optional Google Search grounding
 * - Automatic fallback chain on quota errors
 *
 * @see https://ai.google.dev/gemini-api/docs/structured-output
 */

import { GoogleGenAI } from "@google/genai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

export const GEMINI_MODEL_PRO = "gemini-3.1-pro-preview";
export const GEMINI_MODEL_FAST = "gemini-3-flash-preview";
export const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";
export const DEFAULT_TEMPERATURE = 1.0; // Gemini 3 recommended - do not lower

export type ModelTier = "pro" | "fast";

// =============================================================================
// Client Singleton
// =============================================================================

let clientInstance: GoogleGenAI | null = null;

/**
 * Get or create the Gemini client singleton
 */
export function getGeminiClient(): GoogleGenAI | null {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ [GeminiClient] GEMINI_API_KEY not set");
    return null;
  }

  clientInstance = new GoogleGenAI({ apiKey });
  console.log(
    `✅ [GeminiClient] Initialized (pro: ${GEMINI_MODEL_PRO}, fast: ${GEMINI_MODEL_FAST})`,
  );
  return clientInstance;
}

// =============================================================================
// Structured Output Types
// =============================================================================

export interface GenerateStructuredOptions<T extends z.ZodTypeAny> {
  /** The user prompt to send to the model */
  prompt: string;
  /** Zod schema for structured output validation */
  schema: T;
  /** Optional system prompt (prepended to user prompt) */
  systemPrompt?: string;
  /** Enable Google Search grounding for real-time data */
  useGoogleSearch?: boolean;
  /** Temperature (default 1.0 for Gemini 3) */
  temperature?: number;
  /** Use fallback model on quota errors */
  useFallbackOnQuota?: boolean;
  /** Model tier: "pro" for reasoning-heavy calls, "fast" for speed-sensitive (default: "pro") */
  tier?: ModelTier;
}

export interface GenerateResult<T> {
  data: T | null;
  model: string;
  groundingUsed: boolean;
  error?: string;
}

// =============================================================================
// Shared Helpers
// =============================================================================

function buildModelChain(tier: ModelTier, useFallback: boolean): string[] {
  const full =
    tier === "pro"
      ? [GEMINI_MODEL_PRO, GEMINI_MODEL_FAST, GEMINI_FALLBACK_MODEL]
      : [GEMINI_MODEL_FAST, GEMINI_FALLBACK_MODEL];
  return useFallback ? full : [full[0]];
}

function isQuotaError(error: unknown): boolean {
  const err = error as { status?: number; message?: string };
  return err.status === 429 || !!err.message?.includes("quota");
}

// =============================================================================
// Structured Output Generator
// =============================================================================

/**
 * Generate structured output using Gemini's native JSON schema support
 *
 * @example
 * const result = await generateStructuredOutput({
 *   prompt: "Analyze this song...",
 *   schema: TrackDataSchema,
 *   systemPrompt: COMPOSER_SYSTEM_PROMPT,
 *   useGoogleSearch: true,
 *   tier: "pro",
 * });
 */
export async function generateStructuredOutput<T extends z.ZodTypeAny>(
  options: GenerateStructuredOptions<T>,
): Promise<GenerateResult<z.infer<T>>> {
  const ai = getGeminiClient();
  if (!ai) {
    return { data: null, model: "none", groundingUsed: false, error: "Client not initialized" };
  }

  const {
    prompt,
    schema,
    systemPrompt,
    useGoogleSearch = false,
    temperature = DEFAULT_TEMPERATURE,
    useFallbackOnQuota = true,
    tier = "pro",
  } = options;

  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const jsonSchema = zodToJsonSchema(schema);
  const models = buildModelChain(tier, useFallbackOnQuota);

  for (const currentModel of models) {
    try {
      console.log(
        `🚀 [GeminiClient] Generating with ${currentModel} (${tier})${useGoogleSearch ? " + Google Search" : ""}`,
      );

      const response = await ai.models.generateContent({
        model: currentModel,
        contents: fullPrompt,
        config: {
          tools: useGoogleSearch ? [{ googleSearch: {} }] : undefined,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          temperature,
        },
      });

      const text = response.text;
      if (!text) {
        console.warn("⚠️ [GeminiClient] Empty response from model");
        return {
          data: null,
          model: currentModel,
          groundingUsed: useGoogleSearch,
          error: "Empty response",
        };
      }

      // Parse and validate against Zod schema
      const parsed = JSON.parse(text);
      const validated = schema.safeParse(parsed);

      if (validated.success) {
        console.log(`✅ [GeminiClient] Successfully generated and validated structured output`);
        return {
          data: validated.data,
          model: currentModel,
          groundingUsed: useGoogleSearch,
        };
      } else {
        // Schema validation failures do NOT fall back — a weaker model won't fix schema issues
        const issues = validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ");
        console.warn("⚠️ [GeminiClient] Schema validation failed:", issues);
        return {
          data: null,
          model: currentModel,
          groundingUsed: useGoogleSearch,
          error: `Validation failed: ${issues}`,
        };
      }
    } catch (error: unknown) {
      if (isQuotaError(error)) {
        console.log(`⚠️ [GeminiClient] Quota exceeded for ${currentModel}, trying next model...`);
        continue;
      }

      const message = (error as { message?: string }).message || "Unknown error";
      console.error(`❌ [GeminiClient] Generation error:`, message);
      return { data: null, model: currentModel, groundingUsed: useGoogleSearch, error: message };
    }
  }

  const lastModel = models[models.length - 1];
  return {
    data: null,
    model: lastModel,
    groundingUsed: useGoogleSearch,
    error: "All models exhausted (quota)",
  };
}

// =============================================================================
// Simple Text Generation (for non-structured use cases)
// =============================================================================

export interface GenerateTextOptions {
  prompt: string;
  systemPrompt?: string;
  useGoogleSearch?: boolean;
  temperature?: number;
  /** Model tier (default: "fast") */
  tier?: ModelTier;
  /** Use fallback model on quota errors (default: true) */
  useFallbackOnQuota?: boolean;
}

/**
 * Generate plain text output (no schema validation)
 */
export async function generateText(options: GenerateTextOptions): Promise<string | null> {
  const ai = getGeminiClient();
  if (!ai) return null;

  const {
    prompt,
    systemPrompt,
    useGoogleSearch = false,
    temperature = DEFAULT_TEMPERATURE,
    tier = "fast",
    useFallbackOnQuota = true,
  } = options;
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const models = buildModelChain(tier, useFallbackOnQuota);

  for (const currentModel of models) {
    try {
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: fullPrompt,
        config: {
          tools: useGoogleSearch ? [{ googleSearch: {} }] : undefined,
          temperature,
        },
      });

      return response.text || null;
    } catch (error) {
      if (isQuotaError(error)) {
        console.log(`⚠️ [GeminiClient] Quota exceeded for ${currentModel}, trying next model...`);
        continue;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [GeminiClient] Text generation error:", message);
      return null;
    }
  }

  console.error("❌ [GeminiClient] All models exhausted (quota)");
  return null;
}

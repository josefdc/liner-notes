/**
 * Composer node: writes the liner notes (claims, factoid cards and the genealogy graph) with
 * one model call on the `main` tier, through the provider layer (`llm.invoke`, schema
 * `ComposerOutput`).
 *
 * The model writes text only. Track metadata comes from Spotify, the duration from Spotify
 * only, and measured values from the audio measurement: `ComposerOutput` has no field for any
 * of them. Every model statement is a claim of kind `inferred` until a verifier judges it.
 *
 * On any failure of the model call (budget refused, per-run call cap, rate limit, timeout,
 * network, an incomplete, refused or invalid answer) the result is the fallback built from
 * measured and sourced data only, flagged `run.fallback`, and the call's typed error is
 * recorded in `usage`. The node does not throw for a model failure; a cancelled run stops it.
 */

import { getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  type Claim,
  type ClaimAbout,
  type ComposerOutput as ComposerOutputType,
  ComposerOutput,
  composerOutputIssues,
  type Evidence,
  type FactoidType,
  type LinkType,
  type RunInfo,
  type SourceError,
  TrackAnalysis,
} from "@liner-notes/contract";
import { isLlmError, LlmError } from "../../llm/errors.js";
import type { InvokeResult } from "../../llm/invoke.js";
import { creditString, lookupIsrc } from "../../sources/musicbrainz.js";
import { pickRecording } from "../../sources/identity.js";
import { errorRecord } from "../../sources/records.js";
import { withoutPreviewUrls } from "../../store/runs.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { answeredCall, failedCall, refusedAnswer, runUsage } from "../callRecords.js";
import { enrichGenealogyWithArtwork } from "../enricher.js";
import { isAbortError } from "../errors.js";
import { createFallbackTrackData } from "../fallback.js";
import { composerMessages, type PromptRecording, type PromptTrack } from "../prompts.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor, timestampOf } from "../runtime.js";
import {
  type Factoid,
  type Genealogy,
  type GenealogyLink,
  type GenealogyNode,
  measuredAudioFields,
  type TrackData,
} from "../schema.js";
import {
  createDefaultSegments,
  type LlmCallRecord,
  type SonicAgentStateType,
  type SpotifyData,
} from "../state.js";

export const COMPOSER_CALL_SITE = "composer";
/** Output budget of the composer call, reasoning included (main tier: low effort). */
export const COMPOSER_MAX_OUTPUT_TOKENS = 6000;

export type ModelUnavailableReason =
  | "no_output"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "error"
  | "budget_exhausted";

/**
 * The category sent to clients when the model call fails, from the error's kind. Provider
 * text stays in the server log: it can name keys, deployments or quotas.
 */
export function modelErrorCategory(error: unknown): ModelUnavailableReason {
  if (!isLlmError(error)) return "error";
  switch (error.kind) {
    case "budget_exceeded":
    case "call_cap":
      return "budget_exhausted";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "not_configured":
      return "auth";
    case "provider":
      return error.status === 401 || error.status === 403 ? "auth" : "error";
    case "incomplete":
    case "refused":
    case "invalid_output":
    case "invalid_response":
    case "content_filtered":
      return "no_output";
    default:
      return "error";
  }
}

const MODEL_REASON_TEXT: Record<ModelUnavailableReason, string> = {
  no_output: "no output",
  rate_limited: "rate limited",
  timeout: "timed out",
  auth: "not authorised",
  error: "request failed",
  budget_exhausted: "budget exhausted",
};

// Audio problems that may clear up on the next run. A result missing audio for one of these
// reasons is not stored, so it is not served after the analysis service recovers.
const TRANSIENT_AUDIO_REASONS = new Set(["service_unavailable", "analysis_failed", "not_run"]);

// =============================================================================
// Prompt metadata
// =============================================================================

/** The minimal Spotify fields the app shows: title, artist, album and year. */
export function promptTrack(spotify: SpotifyData): PromptTrack {
  return {
    title: spotify.title,
    artist: spotify.artist,
    album: spotify.album || null,
    year: spotify.releaseDate?.split("-")[0] || null,
  };
}

/**
 * The MusicBrainz recording filed under the track's ISRC that passes the identity checks, or
 * null (no ISRC, no match). A failed lookup is a source error, not a failed run.
 */
export async function musicBrainzRecording(
  spotify: SpotifyData,
  isrc: string | null,
  signal: AbortSignal | undefined,
): Promise<{ recording: PromptRecording | null; errors: SourceError[] }> {
  if (!isrc) return { recording: null, errors: [] };
  try {
    const candidates = await lookupIsrc(isrc, signal);
    const { recording } = pickRecording(
      {
        isrc,
        title: spotify.title,
        // The credited artists one by one: the joined name ("Coolio, L.V.") matches no credit.
        artists: spotify.artistNames?.length ? spotify.artistNames : [spotify.artist],
        durationMs: spotify.durationMs > 0 ? spotify.durationMs : null,
      },
      candidates,
    );
    if (!recording) return { recording: null, errors: [] };
    return {
      recording: {
        mbid: recording.id,
        title: recording.title,
        artistCredit: creditString(recording["artist-credit"]),
        firstReleaseDate: recording["first-release-date"] || null,
        lengthSeconds:
          typeof recording.length === "number" && recording.length > 0
            ? Math.round(recording.length / 1000)
            : null,
      },
      errors: [],
    };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return { recording: null, errors: [errorRecord("musicbrainz", error)] };
  }
}

// =============================================================================
// From the model's output to TrackData
// =============================================================================

/** The analysed track's node. */
const CURRENT_GROUP = 1;
const CURRENT_SIZE = 40;
/**
 * Every other node the model proposes is drawn as a related influence: the web labels a node by
 * its group ("Sampled in this track" for 2, "Samples this track" for 3), and no model statement
 * is supported until a verifier judges it, so none may be drawn as a documented relation.
 */
const MODEL_NODE_GROUP = 4;
const MODEL_NODE_SIZE = 22;

const LINK_VALUE: Record<LinkType, number> = {
  sample: 3,
  interpolation: 3,
  cover: 2,
  remix: 2,
  producer: 1,
  influence: 1,
};
/** Relations that state a documented fact; from the model they are shown as an influence. */
const DOCUMENTED_RELATIONS = new Set<LinkType>(["sample", "interpolation", "cover", "remix"]);

const FACTOID_ABOUT: Record<FactoidType, ClaimAbout> = {
  production: "production",
  trivia: "trivia",
  credits: "credit",
  sample: "sample",
  curiosity: "trivia",
  connection: "connection",
};

interface Composed {
  factoids: Factoid[];
  claims: Claim[];
  genealogy: Genealogy;
}

/**
 * Factoids, claims and the genealogy from the model's output. Ids come from `newId`; cited ids
 * that are not in the evidence pack are dropped; every model claim and link is `inferred` until
 * a verifier judges it, and every node it proposes is drawn as a related influence.
 */
export function composeFromOutput(
  output: ComposerOutputType,
  spotify: SpotifyData,
  evidence: readonly Evidence[],
  newId: () => string,
): Composed {
  const known = new Set(evidence.map((item) => item.id));
  const cited = (ids: readonly string[]) => ids.filter((id) => known.has(id));
  const modelClaim = (fields: Pick<Claim, "text" | "about" | "evidenceIds">): Claim => ({
    id: newId(),
    ...fields,
    kind: "inferred",
    origin: "model",
    verdict: null,
    verdictReason: null,
    numericCheck: "n/a",
  });

  const claims: Claim[] = output.claims.map((claim) => ({
    ...modelClaim({ text: claim.text, about: claim.about, evidenceIds: cited(claim.evidenceIds) }),
    ...(claim.field ? { field: claim.field } : {}),
  }));

  const factoids: Factoid[] = output.factoids.map((card) => {
    const claim: Claim = {
      ...modelClaim({
        text: card.text,
        about: FACTOID_ABOUT[card.type],
        evidenceIds: cited(card.evidenceIds),
      }),
      factoid: { title: card.title, type: card.type, entities: card.entities },
    };
    claims.push(claim);
    const entities = card.entities.map((entity) => ({
      id: newId(),
      text: entity.text,
      type: entity.type,
      searchQuery: entity.text,
    }));
    return {
      id: newId(),
      title: card.title,
      content: card.text,
      type: card.type,
      ...(entities.length > 0 ? { entities } : {}),
      claimId: claim.id,
    };
  });

  // The analysed track is always the node "current", labelled from Spotify. A model node that
  // is not the analysed track but uses the id "current" is renamed, so there is one current
  // node and no link from the track to itself.
  const idOf = new Map<string, string>();
  const used = new Set(["current"]);
  for (const node of output.genealogyNodes) {
    if (node.role === "current") {
      idOf.set(node.id, "current");
      continue;
    }
    let id = node.id;
    while (used.has(id)) id = `${id}-related`;
    used.add(id);
    idOf.set(node.id, id);
  }
  const nodes: GenealogyNode[] = [
    {
      id: "current",
      group: CURRENT_GROUP,
      label: spotify.title,
      size: CURRENT_SIZE,
      trackTitle: spotify.title,
      trackArtist: spotify.artist,
    },
    ...output.genealogyNodes
      .filter((node) => node.role !== "current")
      .map((node) => ({
        id: idOf.get(node.id) ?? node.id,
        group: MODEL_NODE_GROUP,
        label: node.label,
        size: MODEL_NODE_SIZE,
        ...(node.trackTitle ? { trackTitle: node.trackTitle } : {}),
        ...(node.trackArtist ? { trackArtist: node.trackArtist } : {}),
      })),
  ];
  // Every model link is an inference: cited ids that exist in the pack are kept, but citing is
  // not support (only a verifier's verdict is), so a sample, interpolation, cover or remix the
  // model proposes is drawn as an influence. Only links built by code from a source record may
  // be sourced.
  const links: GenealogyLink[] = output.genealogyLinks.flatMap((link) => {
    const source = idOf.get(link.source);
    const target = idOf.get(link.target);
    if (!source || !target || source === target) return [];
    const type = DOCUMENTED_RELATIONS.has(link.type) ? "influence" : link.type;
    return [
      {
        source,
        target,
        value: LINK_VALUE[type],
        type,
        kind: "inferred" as const,
        origin: "model" as const,
        evidenceIds: cited(link.evidenceIds),
      },
    ];
  });
  return { factoids, claims, genealogy: { nodes, links } };
}

/**
 * Album artwork and previews for the genealogy nodes. The enricher's answer is used for
 * artwork only: nodes, labels and links stay as composed.
 */
async function withArtwork(
  genealogy: Genealogy,
  coverUrl: string,
  signal: AbortSignal | undefined,
): Promise<Genealogy> {
  try {
    const enriched = await enrichGenealogyWithArtwork(genealogy, coverUrl, signal);
    const byId = new Map(enriched.nodes.map((node) => [node.id, node]));
    return {
      nodes: genealogy.nodes.map((node) => {
        const found = byId.get(node.id);
        if (!found) return node;
        return {
          ...node,
          ...(found.img ? { img: found.img } : {}),
          ...(found.previewUrl ? { previewUrl: found.previewUrl } : {}),
          ...(found.spotifyId ? { spotifyId: found.spotifyId } : {}),
        };
      }),
      links: genealogy.links,
    };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    console.warn("⚠️ [Composer] Could not enrich genealogy:", error);
    return genealogy;
  }
}

/** The fields every result takes from Spotify, the measurement and the evidence state. */
function baseFields(state: SonicAgentStateType, spotify: SpotifyData) {
  return {
    id: spotify.id,
    title: spotify.title,
    artist: spotify.artist,
    album: spotify.album,
    coverUrl: spotify.coverUrl,
    ...(spotify.spotifyUrl ? { spotifyUrl: spotify.spotifyUrl } : {}),
    // The engineer's clip of the chosen recording, for the player; none when it found none (a
    // clip it turned down is never sent).
    ...(state.previewUrl ? { previewUrl: state.previewUrl } : {}),
    ...(spotify.releaseDate?.split("-")[0]
      ? { releaseYear: spotify.releaseDate.split("-")[0] }
      : {}),
    ...(typeof spotify.explicit === "boolean" ? { explicit: spotify.explicit } : {}),
    // From Spotify only, never from a model; missing when Spotify gave none.
    ...(spotify.durationMs > 0 ? { durationSeconds: Math.round(spotify.durationMs / 1000) } : {}),
    ...measuredAudioFields(state.audioFeatures),
    // The ISRC is the one Spotify gave for the chosen track; `preview` is how the clip the audio
    // values were measured on was matched to it (none when nothing was measured). No node writes
    // evidence yet (#27): it is empty today.
    ...(state.isrc ? { isrc: state.isrc } : {}),
    ...(state.preview ? { preview: state.preview } : {}),
    evidence: state.evidence,
  };
}

/**
 * The state with the evidence-model channels present: a state written before they existed (or
 * a node called outside the graph) reads them as empty.
 */
function withChannelDefaults(state: SonicAgentStateType): SonicAgentStateType {
  return {
    ...state,
    evidence: state.evidence ?? [],
    claims: state.claims ?? [],
    usage: state.usage ?? [],
    sourceErrors: state.sourceErrors ?? [],
    isrc: state.isrc ?? null,
    preview: state.preview ?? null,
    previewUrl: state.previewUrl ?? null,
  };
}

/**
 * Why a result does not fit the contract's TrackAnalysis, or null when it fits. Such a result
 * is a bug: it is neither sent nor stored, since the stream would refuse it and a stored copy
 * would be served for every later search of the song.
 */
function contractProblems(trackData: TrackData): string | null {
  const checked = TrackAnalysis.safeParse(trackData);
  if (checked.success) return null;
  return checked.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(result)"}: ${issue.message}`)
    .join("; ");
}

// =============================================================================
// The node
// =============================================================================

export function createComposerNode(runtime: AgentRuntime = defaultAgentRuntime) {
  return async function composerNode(
    input: SonicAgentStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<SonicAgentStateType>> {
    const state = withChannelDefaults(input);
    const spotify = state.spotifyData;
    if (!spotify) {
      return {
        error: "No Spotify data to compose",
        statusMessages: ["❌ Cannot compose - missing track data"],
      };
    }

    const signal = config.signal;
    const runId = runIdFor(state, config, runtime);
    const writer = config.writer;
    const status = (code: string, message: string) =>
      writer?.({
        type: "status",
        code,
        message,
        node: "composer",
        timestamp: timestampOf(runtime),
      });
    const runInfo = (
      fallback: boolean,
      calls: LlmCallRecord[],
      errors: SourceError[],
    ): RunInfo => ({
      id: runId,
      // A run whose model answers came from cassettes is a replay, not a live run. Cassettes
      // carry no recording time or commit, so those stay null (see the review notes).
      mode: [...state.usage, ...calls].some((call) => call.mode === "replay") ? "replay" : "live",
      recordedAt: null,
      commit: null,
      analyzerVersion: null,
      fallback,
      usage: runUsage([...state.usage, ...calls], runtime.llm.callsForRun(runId)),
      sourceErrors: [...state.sourceErrors, ...errors],
    });

    status("LLM-CONNECT", "Composing the liner notes...");
    console.log("🎼 [Composer] Synthesizing data for:", spotify.title);

    // state.isrc is null when Spotify gave no ISRC: no lookup is made then.
    const { recording, errors: sourceErrors } = await musicBrainzRecording(
      spotify,
      state.isrc,
      signal,
    );
    const messages = composerMessages({
      track: promptTrack(spotify),
      recording,
      audio: state.audioFeatures,
      evidence: state.evidence,
      research: state.researchData,
      sourceErrors: [...state.sourceErrors, ...sourceErrors],
    });

    // Only the model call is guarded: any failure of it gives the fallback. A bug in what
    // follows is not a model failure and fails the run.
    let result: InvokeResult<ComposerOutputType>;
    try {
      result = await runtime.llm.invoke(COMPOSER_CALL_SITE, "main", messages, ComposerOutput, {
        purpose: runtime.purpose,
        runId,
        maxOutputTokens: COMPOSER_MAX_OUTPUT_TOKENS,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return composeFallback(error, failedCall(COMPOSER_CALL_SITE, "main", error));
    }
    // An answer that breaks the rules the schema cannot carry is refused; it was still billed.
    const issues = composerOutputIssues(result.output);
    if (issues.length > 0) {
      const refused = new LlmError(
        "invalid_output",
        `${COMPOSER_CALL_SITE}: the answer breaks the ComposerOutput rules (${issues.slice(0, 3).join("; ")})`,
      );
      return composeFallback(refused, refusedAnswer(COMPOSER_CALL_SITE, result, "invalid_output"));
    }
    const call = answeredCall(COMPOSER_CALL_SITE, result);
    const output = result.output;
    const composed = composeFromOutput(output, spotify, state.evidence, runtime.newId);

    status("GRAPH-ENRICH", "Cross-referencing visual artifacts from Spotify...");
    const trackData: TrackData = {
      ...baseFields(state, spotify),
      // A generic structure, not an analysis of this track
      segments: createDefaultSegments(spotify.durationMs),
      segmentsSource: "template",
      samples: [],
      factoids: composed.factoids,
      genealogy: await withArtwork(composed.genealogy, spotify.coverUrl, signal),
      claims: composed.claims,
      run: runInfo(false, [call], sourceErrors),
    };

    // A cancelled run reports nothing and stores nothing.
    signal?.throwIfAborted();
    const problems = contractProblems(trackData);
    if (problems) return unusable(problems, [call]);
    writer?.({ type: "complete", data: trackData });

    // Cache the result in long-term memory, unless a later run may do better: the audio may be
    // measurable later, a source failed for a passing reason (an outage, a timeout, a rate
    // limit, a rejected key), or a research planner call failed. A source that is only not
    // configured does not block it: the key names the configured sources. The run information
    // belongs to this run, not to a later one served from the cache.
    const store = getStore();
    const transientAudio = TRANSIENT_AUDIO_REASONS.has(trackData.audioUnavailableReason ?? "");
    const transientSources = [...state.sourceErrors, ...sourceErrors].some(
      (e) => e.code !== "not_configured",
    );
    const plannerFailed = state.usage.some((u) => u.status !== "ok");
    // Only a track the scout selected as the query's clear match is stored under the query's
    // text: a pick from the track picker is one user's choice, not the answer to the text.
    const clearMatch = state.selectedBy === "match";
    if (store && clearMatch && !transientAudio && !transientSources && !plannerFailed) {
      const normalizedQuery = state.songQuery.toLowerCase().trim();
      const { run: _run, ...cached } = trackData;
      try {
        signal?.throwIfAborted();
        await store.put(TRACKS_NAMESPACE, resultCacheKey(normalizedQuery, configuredSources()), {
          // Preview links are handed out for one run: a result served later shows none.
          trackData: withoutPreviewUrls(cached),
          timestamp: runtime.now().getTime(),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn("⚠️ [Composer] Store write error:", e);
      }
    }

    return {
      trackData,
      claims: composed.claims,
      usage: [call],
      sourceErrors,
      statusMessages: ["🎼 Analysis complete!"],
    };

    /** A result that does not fit the contract: the run fails, its calls still count. */
    function unusable(problems: string, calls: LlmCallRecord[]): Partial<SonicAgentStateType> {
      console.error(`❌ [Composer] The result does not fit the contract: ${problems}`);
      return {
        error: `Composer result does not fit the contract: ${problems}`,
        usage: calls,
        sourceErrors,
        statusMessages: ["❌ The analysis could not be completed"],
      };
    }

    /** The honest fallback: measured and sourced data only, no model text. */
    async function composeFallback(
      error: unknown,
      failed: LlmCallRecord,
    ): Promise<Partial<SonicAgentStateType>> {
      const reason = modelErrorCategory(error);
      console.warn(
        `⚠️ [Composer] Model unavailable (${failed.status}); building the result from source data:`,
        error instanceof Error ? error.message : String(error),
      );
      status(
        "LLM-ERROR",
        `Model unavailable (${MODEL_REASON_TEXT[reason]}); building the result from source data only`,
      );

      const fallback = await createFallbackTrackData(state, { newId: runtime.newId });
      const trackData: TrackData = {
        ...fallback,
        ...baseFields(state, spotify!),
        genealogy: await withArtwork(fallback.genealogy, spotify!.coverUrl, signal),
        claims: [],
        modelUnavailable: true,
        modelUnavailableReason: reason,
        run: runInfo(true, [failed], sourceErrors),
      };
      signal?.throwIfAborted();
      const problems = contractProblems(trackData);
      if (problems) return unusable(problems, [failed]);
      writer?.({ type: "complete", data: trackData });
      return {
        trackData,
        claims: [],
        usage: [failed],
        sourceErrors,
        statusMessages: [
          `⚠️ Model unavailable (${MODEL_REASON_TEXT[reason]}); showing source data only`,
        ],
      };
    }
  };
}

/** The composer with the default runtime (the shared provider layer, the system clock). */
export const composerNode = createComposerNode();

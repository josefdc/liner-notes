/**
 * Composer node: writes the liner notes (claims, factoid cards and the genealogy graph) with
 * one model call on the `main` tier, through the provider layer (`llm.invoke`, schema
 * `ComposerOutput`).
 *
 * The model writes text only. Track metadata comes from Spotify, the duration from Spotify
 * only, and measured values from the audio measurement: `ComposerOutput` has no field for any
 * of them. The model reads the measured values as context; the result's measurement (`audio`),
 * its copies and `run.analyzerVersion` are written by code in one last step (finalize.ts), on
 * the composed result and on the fallback alike. Every model statement is a claim of kind
 * `inferred` until a verifier judges it.
 *
 * On any failure of the model call (budget refused, per-run call cap, rate limit, timeout,
 * network, an incomplete, refused or invalid answer) the result is the fallback built from
 * measured and sourced data only, flagged `run.fallback`, and the call's typed error is
 * recorded in `usage`. The node does not throw for a model failure; a cancelled run stops it.
 */

import { getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  analysisIssues,
  type Claim,
  type ClaimAbout,
  type ComposerOutput as ComposerOutputType,
  ComposerOutput,
  composerOutputIssues,
  type Evidence,
  type FactoidType,
  type LinkType,
  type RunInfo,
  runIssues,
  type SourceError,
  TrackAnalysis,
} from "@liner-notes/contract";
import { isLlmError, LlmError } from "../../llm/errors.js";
import type { InvokeResult } from "../../llm/invoke.js";
import type { IdentifiedRecording } from "../../sources/identity.js";
import {
  answeredCall,
  failedCall,
  refusedAnswer,
  replayedRecording,
  runUsage,
} from "../callRecords.js";
import { enrichGenealogyWithArtwork } from "../enricher.js";
import { isAbortError } from "../errors.js";
import { createFallbackTrackData } from "../fallback.js";
import { finalizeResult, type ResultDraft } from "../finalize.js";
import {
  composerMessages,
  type PromptRecording,
  type PromptTrack,
  shownEvidence,
} from "../prompts.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor, timestampOf } from "../runtime.js";
import { shownQueryMatch, storeResult } from "../storedResults.js";
import type { Factoid, Genealogy, GenealogyLink, GenealogyNode, TrackData } from "../schema.js";
import {
  createDefaultSegments,
  type LlmCallRecord,
  type SonicAgentStateType,
  type SpotifyData,
} from "../state.js";
import { logger } from "../../logger.js";

const log = logger("Composer");

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

/**
 * The source errors that keep a result from being stored: any but a source that is not
 * configured (the result key names the configured sources) and one of `lasting`, the errors a
 * primary-record reader marked as an answer of a shape it does not know (never chosen by the
 * source's name or the error's code alone: an HTML page, a reader's bug or lost records block).
 */
export function blockingSourceErrors(
  errors: readonly SourceError[],
  lasting: readonly SourceError[],
): SourceError[] {
  const same = (a: SourceError, b: SourceError) =>
    a.source === b.source && a.code === b.code && a.message === b.message;
  return errors.filter(
    (e) => e.code !== "not_configured" && !lasting.some((kept) => same(kept, e)),
  );
}

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
 * The MusicBrainz recording the track's ISRC identified, as the prompt shows it; null when the
 * run has none (no ISRC, no match, MusicBrainz could not be read: the historian's identity chain
 * reported it). It is the run's one ISRC lookup: the composer does not look it up again.
 */
export function promptRecording(recording: IdentifiedRecording | null): PromptRecording | null {
  if (!recording) return null;
  return {
    mbid: recording.mbid,
    title: recording.title,
    artistCredit: recording.artist,
    firstReleaseDate: recording.firstReleaseDate,
    lengthSeconds: recording.lengthMs !== null ? Math.round(recording.lengthMs / 1000) : null,
  };
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
  /** The year the model gave for a node, by node id: for the artwork's release check only. */
  nodeYears: Map<string, string>;
}

/**
 * Factoids, claims and the genealogy from the model's output. Ids come from `newId`; cited ids
 * that are not in `evidence` (the items the prompt showed) are dropped; every model claim and link is `inferred` until
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
  const nodeYears = new Map<string, string>();
  for (const node of output.genealogyNodes) {
    const id = idOf.get(node.id);
    if (id && id !== "current" && node.year?.trim()) nodeYears.set(id, node.year.trim());
  }
  return { factoids, claims, genealogy: { nodes, links }, nodeYears };
}

/**
 * Album artwork and previews for the genealogy nodes. The enricher's answer is used for
 * artwork only: nodes, labels and links stay as composed, and an entry is merged into the node
 * with its id (an entry for no node is ignored). The enricher is given the model's year for a
 * node (`nodeYears`) for its release check; the result's nodes do not carry it. `sourceErrors`
 * holds a source the enricher could not read for the previews (Deezer). `complete` is false when
 * the artwork pass was cut short or failed: some nodes lack artwork a later run may find.
 */
async function withArtwork(
  genealogy: Genealogy,
  coverUrl: string,
  signal: AbortSignal | undefined,
  nodeYears: ReadonlyMap<string, string> = new Map(),
): Promise<{ genealogy: Genealogy; sourceErrors: SourceError[]; complete: boolean }> {
  const sourceErrors: SourceError[] = [];
  try {
    const dated = genealogy.nodes.map((node) => {
      const year = nodeYears.get(node.id);
      return year ? { ...node, year } : node;
    });
    const enriched = await enrichGenealogyWithArtwork({ nodes: dated }, coverUrl, signal, (error) =>
      sourceErrors.push(error),
    );
    const byId = new Map(enriched.nodes.map((node) => [node.id, node]));
    const nodes = genealogy.nodes.map((node) => {
      const found = byId.get(node.id);
      if (!found) return node;
      return {
        ...node,
        ...(found.img ? { img: found.img } : {}),
        ...(found.previewUrl ? { previewUrl: found.previewUrl } : {}),
        ...(found.spotifyId ? { spotifyId: found.spotifyId } : {}),
      };
    });
    const { complete } = enriched;
    return { genealogy: { nodes, links: genealogy.links }, sourceErrors, complete };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    log.warn("Could not enrich genealogy", { err: error });
    return { genealogy, sourceErrors, complete: false };
  }
}

/**
 * The fields every result takes from Spotify and the evidence state. The audio fields are
 * finalize.ts's (finalizeResult, the last step of every result).
 */
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
    // The ISRC is the one Spotify gave for the chosen track; `preview` is how the clip the audio
    // values were measured on was matched to it (none when nothing was measured). The evidence
    // is the historian's pack: records read from the sources, never model text.
    ...(state.isrc ? { isrc: state.isrc } : {}),
    ...(state.preview ? { preview: state.preview } : {}),
    // How this run's search text matched the track; the web says so when it is not exact. None
    // for a track the user clicked (shownQueryMatch).
    ...(shownQueryMatch(state) ? { queryMatch: shownQueryMatch(state) } : {}),
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
    lastingSourceErrors: state.lastingSourceErrors ?? [],
    primaryNotAsked: state.primaryNotAsked ?? [],
    isrc: state.isrc ?? null,
    isrcRecording: state.isrcRecording ?? null,
    preview: state.preview ?? null,
    previewUrl: state.previewUrl ?? null,
    queryMatch: state.queryMatch ?? null,
  };
}

/**
 * Why a result does not fit the contract's TrackAnalysis, or null when it fits. Such a result
 * is a bug: it is neither sent nor stored, since the stream would refuse it and a stored copy
 * would be served for every later search of the song. A result that fits but breaks one of the
 * contract's producer rules (`analysisIssues`) is logged: the measured copies and the run's
 * analyzer version cannot break them (finalize.ts writes them), so such a rule is about the
 * rest of the result.
 */
function contractProblems(trackData: TrackData, runId: string): string | null {
  const checked = TrackAnalysis.safeParse(trackData);
  if (checked.success) {
    const issues = analysisIssues(checked.data);
    if (issues.length > 0) {
      log.warn(
        `Run ${runId}: the result breaks the contract's producer rules (${issues.slice(0, 5).join("; ")})`,
      );
    }
    return null;
  }
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
        statusMessages: ["Liner notes not written: no track was chosen"],
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
    const runInfo = (fallback: boolean, calls: LlmCallRecord[], errors: SourceError[]): RunInfo => {
      const records = [...state.usage, ...calls];
      // A run whose model answers came from cassettes is a replay of those answers, not a live
      // run: it says when and from which commit they were recorded (replayedRecording; null
      // where a cassette does not say), and that only the model's answers were replayed.
      const replayed = records.some((call) => call.mode === "replay");
      const info: RunInfo = {
        id: runId,
        mode: replayed ? "replay" : "live",
        ...(replayed ? replayedRecording(records) : { recordedAt: null, commit: null }),
        ...(replayed && { replayed: "model_answers" as const }),
        // finalizeResult sets it to the measurement's analyzerVersion (null without one).
        analyzerVersion: null,
        fallback,
        usage: runUsage(records, runtime.llm.callsForRun(runId)),
        sourceErrors: [...state.sourceErrors, ...errors],
      };
      return info;
    };
    /** The result with the measurement written in (finalize.ts), its run rules checked. */
    const finalized = (draft: ResultDraft): TrackData => {
      const result = finalizeResult(draft, state.audioFeatures);
      const issues = result.run ? runIssues(result.run, result.audio) : [];
      if (issues.length > 0) {
        log.warn(
          `Run ${runId}: the run information breaks the contract's run rules ` +
            `(${issues.join("; ")}); record its cassettes again so they say when and where`,
        );
      }
      return result;
    };

    status("LLM-CONNECT", "Composing the liner notes...");
    log.info(`Synthesizing data for: ${spotify.title}`);

    // The recording the historian's identity chain matched by ISRC; its errors are the run's.
    const messages = composerMessages({
      track: promptTrack(spotify),
      recording: promptRecording(state.isrcRecording),
      audio: state.audioFeatures ?? null,
      evidence: state.evidence,
      research: state.researchData,
      sourceErrors: state.sourceErrors,
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
    // Only the items the prompt showed may be cited: the model never read the others.
    const composed = composeFromOutput(
      output,
      spotify,
      shownEvidence(state.evidence),
      runtime.newId,
    );

    status("GRAPH-ENRICH", "Looking up cover art on Spotify for the genealogy");
    const enriched = await withArtwork(
      composed.genealogy,
      spotify.coverUrl,
      signal,
      composed.nodeYears,
    );
    const runErrors = enriched.sourceErrors;
    const trackData: TrackData = finalized({
      ...baseFields(state, spotify),
      // A generic structure, not an analysis of this track
      segments: createDefaultSegments(spotify.durationMs),
      segmentsSource: "template",
      samples: [],
      factoids: composed.factoids,
      genealogy: enriched.genealogy,
      claims: composed.claims,
      run: runInfo(false, [call], runErrors),
    });

    // A cancelled run reports nothing and stores nothing.
    signal?.throwIfAborted();
    const problems = contractProblems(trackData, runId);
    if (problems) return unusable(problems, [call], runErrors);
    writer?.({ type: "complete", data: trackData });

    // Cache the result in long-term memory under its track (storedResults.ts), unless a later
    // run may do better: the audio may be measurable later, a source failed for a passing reason
    // (an outage, a timeout, a rate limit, a rejected key), a research planner call failed, or
    // the genealogy's artwork pass was cut short (enriched.complete). A
    // source that is only not configured does not block it: the key names the configured
    // sources. Nor does a source read only for the genealogy previews (enriched.sourceErrors):
    // a stored result never carries a preview. Nor does a lasting error of the evidence pack
    // (state.lastingSourceErrors: a primary-record answer whose shape its reader does not know); it is
    // stored with the result and reported again when the result is served. The run information,
    // the preview links and the search match belong to this run, not to a later one served from
    // the cache.
    const store = getStore();
    // Audio that may be measured later, or a measurement the cache served while the service
    // could not say its analyzer version (a newer analyzer may measure it otherwise).
    const transientAudio =
      TRANSIENT_AUDIO_REASONS.has(trackData.audioUnavailableReason ?? "") ||
      state.audioFeatures?.servedUnversioned === true;
    // The errors a stored result keeps: none of them blocks it (see blockingSourceErrors).
    const runSourceErrors = state.sourceErrors;
    const transientSources =
      blockingSourceErrors(runSourceErrors, state.lastingSourceErrors).length > 0;
    const plannerFailed = state.usage.some((u) => u.status !== "ok");
    // Built without the track's Spotify details (the picked candidate's fields only, see the
    // clarification node), whatever the reason, even a key that is not configured: a run that
    // reads them does better.
    const spotifyUnread = state.sourceErrors.some((e) => e.source === "spotify");
    // A primary source the run did not ask, its request not sent (no source error): a later run
    // asks it.
    const primaryNotAsked = state.primaryNotAsked.length > 0;
    // The result is about the track the run chose, by the scout's match or the user's pick: it
    // is stored under that track, never under the text, so it is served only for that track.
    const chosen = state.selectedBy === "match" || state.selectedBy === "user";
    if (
      store &&
      chosen &&
      !transientAudio &&
      !transientSources &&
      !plannerFailed &&
      !spotifyUnread &&
      !primaryNotAsked &&
      enriched.complete
    ) {
      try {
        signal?.throwIfAborted();
        await storeResult(store, trackData, runtime.now(), runSourceErrors);
      } catch (e) {
        if (signal?.aborted) throw e;
        log.warn("Store write error", { err: e });
      }
    }

    return {
      trackData,
      claims: composed.claims,
      usage: [call],
      sourceErrors: runErrors,
      statusMessages: ["Analysis complete"],
    };

    /**
     * A result that does not fit the contract: the run fails, its calls and the sources it could
     * not read (`errors`) still count.
     */
    function unusable(
      problems: string,
      calls: LlmCallRecord[],
      errors: SourceError[],
    ): Partial<SonicAgentStateType> {
      log.error(`The result does not fit the contract: ${problems}`);
      return {
        error: `Composer result does not fit the contract: ${problems}`,
        usage: calls,
        sourceErrors: errors,
        statusMessages: [
          "The analysis could not be completed: the result does not fit the contract",
        ],
      };
    }

    /** The honest fallback: measured and sourced data only, no model text. */
    async function composeFallback(
      error: unknown,
      failed: LlmCallRecord,
    ): Promise<Partial<SonicAgentStateType>> {
      const reason = modelErrorCategory(error);
      log.warn(
        `Model unavailable (${failed.status}); building the result from source data: ${error instanceof Error ? error.message : String(error)}`,
      );
      status(
        "LLM-ERROR",
        `Model unavailable (${MODEL_REASON_TEXT[reason]}); building the result from source data only`,
      );

      const fallback = await createFallbackTrackData(state, { newId: runtime.newId });
      const enriched = await withArtwork(fallback.genealogy, spotify!.coverUrl, signal);
      const runErrors = enriched.sourceErrors;
      const trackData: TrackData = finalized({
        ...fallback,
        ...baseFields(state, spotify!),
        genealogy: enriched.genealogy,
        claims: [],
        modelUnavailable: true,
        modelUnavailableReason: reason,
        run: runInfo(true, [failed], runErrors),
      });
      signal?.throwIfAborted();
      const problems = contractProblems(trackData, runId);
      if (problems) return unusable(problems, [failed], runErrors);
      writer?.({ type: "complete", data: trackData });
      return {
        trackData,
        claims: [],
        usage: [failed],
        sourceErrors: runErrors,
        statusMessages: [
          `Model unavailable (${MODEL_REASON_TEXT[reason]}); showing source data only`,
        ],
      };
    }
  };
}

/** The composer with the default runtime (the shared provider layer, the system clock). */
export const composerNode = createComposerNode();

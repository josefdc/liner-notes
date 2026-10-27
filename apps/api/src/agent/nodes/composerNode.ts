/**
 * Composer node: writes the liner notes (claims, factoid cards and the genealogy graph) with
 * one model call on the `main` tier, through the provider layer (`llm.invoke`, schema
 * `ComposerOutput`), and hands them to the verifier as a draft (the `draft` channel). It sends
 * no result and stores none: the verifier checks the draft, then finalizes, sends and stores the
 * result (verifier/index.ts).
 *
 * The model writes text only. Track metadata comes from Spotify, the duration from Spotify
 * only, and measured values from the audio measurement: `ComposerOutput` has no field for any
 * of them. The model reads the measured values as context. Every model statement is a claim of
 * kind `inferred`, and every link the model proposes states one claim of its own (its stated
 * type, its two ends, its evidence and a scope set by code), until the verifier judges it.
 *
 * Beside what the model wrote, the draft holds the claims and links code builds from the
 * relations the primary records state (codeClaims.ts): sourced by construction, never model
 * text. A model link that duplicates one of them folds into it.
 *
 * On any failure of the model call (budget refused, per-run call cap, rate limit, timeout,
 * network, an incomplete, refused or invalid answer) the draft is the fallback built from
 * measured and sourced data only, the code-built claims and links included, with the reason the
 * model gave nothing usable, and the call's typed error is recorded in `usage`. The node does
 * not throw for a model failure; a cancelled run stops it.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  type Claim,
  type ClaimAbout,
  type ClaimScope,
  type ComposerOutput as ComposerOutputType,
  ComposerOutput,
  composerOutputIssues,
  type Evidence,
  type FactoidType,
  type GenealogyRole,
  LINK_CLAIM_ABOUT,
  type LinkType,
} from "@liner-notes/contract";
import { LlmError } from "../../llm/errors.js";
import type { InvokeResult } from "../../llm/invoke.js";
import type { IdentifiedRecording } from "../../sources/identity.js";
import { answeredCall, failedCall, refusedAnswer } from "../callRecords.js";
import { buildCodeClaims, withCodeClaims } from "../codeClaims.js";
import { isAbortError } from "../errors.js";
import { createFallbackTrackData } from "../fallback.js";
import { composerMessages, type PromptRecording, promptTrack, shownEvidence } from "../prompts.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor, timestampOf } from "../runtime.js";
import {
  MODEL_FAILURE_TEXT,
  modelErrorCategory,
  type ModelUnavailableReason,
} from "../statusText.js";
import type { Factoid, Genealogy, GenealogyLink, GenealogyNode } from "../schema.js";
import {
  type ComposedDraft,
  createDefaultSegments,
  type LlmCallRecord,
  type SonicAgentStateType,
  type SpotifyData,
  withChannelDefaults,
} from "../state.js";
import { maskHandles } from "../../sources/search.js";
import { INFERRED_LINK_VALUE } from "../verifier/links.js";
import { logger } from "../../logger.js";

const log = logger("Composer");

export const COMPOSER_CALL_SITE = "composer";
/** Output budget of the composer call, reasoning included (main tier: low effort). */
export const COMPOSER_MAX_OUTPUT_TOKENS = 6000;

export { modelErrorCategory, type ModelUnavailableReason } from "../statusText.js";
export { promptTrack } from "../prompts.js";

/** What the fallback result shows, for its status line. */
const FALLBACK_SHOWS =
  "showing source data only, with a template song structure and no written notes";

/** A status line that starts with what happened to the model call. */
const modelLine = (reason: ModelUnavailableReason, rest: string) => {
  const text = MODEL_FAILURE_TEXT[reason];
  return `${text[0].toUpperCase()}${text.slice(1)}; ${rest}`;
};

// =============================================================================
// Prompt metadata
// =============================================================================

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
// From the model's output to a draft
// =============================================================================

/** The analysed track's node. */
const CURRENT_GROUP = 1;
const CURRENT_SIZE = 40;
/**
 * Every other node the model proposes is drawn as a related influence: the web labels a node by
 * its group ("Sampled in this track" for 2, "Samples this track" for 3), and no model statement
 * is supported until the verifier judges it. The verifier gives a node a documented group once
 * it supports the sample between it and the track.
 */
const MODEL_NODE_GROUP = 4;
const MODEL_NODE_SIZE = 22;

export const FACTOID_ABOUT: Record<FactoidType, ClaimAbout> = {
  production: "production",
  trivia: "trivia",
  credits: "credit",
  sample: "sample",
  curiosity: "trivia",
  connection: "connection",
};

/** The statement a link's claim makes, from its stated type and its two ends' labels. */
const RELATION_TEXT: Record<LinkType, (earlier: string, later: string) => string> = {
  sample: (earlier, later) => `${later} samples ${earlier}.`,
  interpolation: (earlier, later) => `${later} interpolates ${earlier}.`,
  remix: (earlier, later) => `${later} is a remix of ${earlier}.`,
  cover: (earlier, later) => `${later} is a cover of ${earlier}.`,
  producer: (one, other) => `${one} and ${other} share a producer.`,
  influence: (earlier, later) => `${earlier} influenced ${later}.`,
};

/**
 * The link's ends, earlier record first (`GenealogyLink`). When one end is the analysed track,
 * the other node's role says which is earlier: a `source` or `influence` node comes before the
 * track, a `derived` node after it; a link the model wrote the other way round is turned. A
 * producer link has no direction, and a link between two other nodes keeps the model's order.
 */
export function directedEnds(
  source: string,
  target: string,
  type: LinkType,
  roleOf: (id: string) => GenealogyRole | undefined,
): [source: string, target: string] {
  if (type === "producer") return [source, target];
  if (target === "current" && roleOf(source) === "derived") return [target, source];
  if (source === "current") {
    const other = roleOf(target);
    if (other === "source" || other === "influence") return [target, source];
  }
  return [source, target];
}

/**
 * What a link's claim states a fact about, set by code from the link's type wherever the type
 * says it: a sample, interpolation or remix ties one recording to another (recording), a cover
 * is another recording of the song (work), whichever two records it joins. So a release-wide or
 * song-level item never sources a recording-level relation, between any two records. A producer
 * or an influence link with the analysed track is about this recording; between two other
 * records only it keeps the scope the model gave it.
 */
export function relationScope(
  type: LinkType,
  source: string,
  target: string,
  stated: ClaimScope,
): ClaimScope {
  if (type === "cover") return "work";
  if (type === "sample" || type === "interpolation" || type === "remix") return "recording";
  return source === "current" || target === "current" ? "recording" : stated;
}

/** A statement the model wrote: inferred and without a verdict until the verifier judges it. */
export const modelClaim = (
  id: string,
  fields: Pick<Claim, "text" | "about" | "evidenceIds" | "scope">,
): Claim => ({
  id,
  ...fields,
  kind: "inferred",
  origin: "model",
  verdict: null,
  verdictReason: null,
  numericCheck: "n/a",
});

interface Composed {
  factoids: Factoid[];
  claims: Claim[];
  genealogy: Genealogy;
  /** The year the model gave for a node, by node id: for the artwork's release check only. */
  nodeYears: Record<string, string>;
}

/**
 * Factoids, claims and the genealogy from the model's output. Ids come from `newId`; cited ids
 * that are not in `evidence` (the items the prompt showed) are dropped; every model claim and
 * link is `inferred` until the verifier judges it, and every node it proposes is drawn as a
 * related influence. Each link states one relation claim of its own (`claimId`, never shared):
 * about its stated type (`LINK_CLAIM_ABOUT`'s first entry), citing exactly the link's evidence,
 * with the scope `relationScope` gives it. The link keeps the type the model stated; it is drawn
 * as an influence until the verifier supports its claim.
 */
export function composeFromOutput(
  output: ComposerOutputType,
  spotify: SpotifyData,
  evidence: readonly Evidence[],
  newId: () => string,
): Composed {
  const known = new Set(evidence.map((item) => item.id));
  const cited = (ids: readonly string[]) => [...new Set(ids.filter((id) => known.has(id)))];
  const claimOf = (fields: Pick<Claim, "text" | "about" | "evidenceIds" | "scope">) =>
    modelClaim(newId(), fields);

  const claims: Claim[] = output.claims.map((claim) => ({
    ...claimOf({
      text: claim.text,
      about: claim.about,
      evidenceIds: cited(claim.evidenceIds),
      scope: claim.scope,
    }),
    ...(claim.field ? { field: claim.field } : {}),
  }));

  const factoids: Factoid[] = output.factoids.map((card) => {
    const claim: Claim = {
      ...claimOf({
        text: card.text,
        about: FACTOID_ABOUT[card.type],
        evidenceIds: cited(card.evidenceIds),
        scope: card.scope,
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
  const roles = new Map<string, GenealogyRole>([["current", "current"]]);
  const used = new Set(["current"]);
  for (const node of output.genealogyNodes) {
    if (node.role === "current") {
      idOf.set(node.id, "current");
      continue;
    }
    // An id that holds an @handle is model text that would be stored: it is replaced.
    let id = maskHandles(node.id) === node.id ? node.id : "node";
    while (used.has(id)) id = `${id}-related`;
    used.add(id);
    idOf.set(node.id, id);
    roles.set(id, node.role);
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
  // How a link's claim names each end: the analysed track by its Spotify title and artist.
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  labels.set("current", `${spotify.title} - ${spotify.artist}`);
  const named = (id: string) => `"${labels.get(id) ?? id}"`;

  // Every model link is an inference: cited ids that exist in the pack are kept, but citing is
  // not support (only the verifier's verdict on the link's own claim is).
  const links: GenealogyLink[] = output.genealogyLinks.flatMap((link) => {
    const from = idOf.get(link.source);
    const to = idOf.get(link.target);
    if (!from || !to || from === to) return [];
    const [source, target] = directedEnds(from, to, link.type, (id) => roles.get(id));
    const evidenceIds = cited(link.evidenceIds);
    const claim = claimOf({
      text: RELATION_TEXT[link.type](named(source), named(target)),
      about: LINK_CLAIM_ABOUT[link.type][0],
      evidenceIds,
      scope: relationScope(link.type, source, target, link.scope),
    });
    claims.push(claim);
    return [
      {
        source,
        target,
        value: INFERRED_LINK_VALUE,
        type: link.type,
        kind: "inferred" as const,
        origin: "model" as const,
        claimId: claim.id,
        evidenceIds,
      },
    ];
  });
  const nodeYears: Record<string, string> = {};
  for (const node of output.genealogyNodes) {
    const id = idOf.get(node.id);
    if (id && id !== "current" && node.year?.trim()) nodeYears[id] = node.year.trim();
  }
  return { factoids, claims, genealogy: { nodes, links }, nodeYears };
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

    status("LLM-CONNECT", "Writing the liner notes");
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
    // Only the items the prompt showed may be cited: the model never read the others.
    const composed = composeFromOutput(
      result.output,
      spotify,
      shownEvidence(state.evidence),
      runtime.newId,
    );
    signal?.throwIfAborted();
    // The claims and links code builds from the primary records; the model's duplicates fold in.
    const withCode = withCodeClaims(composed, codeBuilt());
    const draft: ComposedDraft = {
      modelUnavailableReason: null,
      factoids: composed.factoids,
      claims: withCode.claims,
      genealogy: withCode.genealogy,
      nodeYears: withCode.nodeYears,
      noArtwork: withCode.noArtwork,
      // A generic structure, not an analysis of this track
      segments: createDefaultSegments(spotify.durationMs),
      segmentsSource: "template",
      samples: [],
    };
    return { draft, usage: [call] };

    /** The run's code-built claims and links, from the whole evidence pack. */
    function codeBuilt() {
      return buildCodeClaims(
        state.relations,
        state.evidence,
        runtime.newId,
        state.isrcRecording ?? null,
      );
    }

    /**
     * The honest fallback: measured and sourced data only, no model text. It carries the
     * code-built claims and links, so it is evidence-backed without any model call.
     */
    async function composeFallback(
      error: unknown,
      failed: LlmCallRecord,
    ): Promise<Partial<SonicAgentStateType>> {
      const reason = modelErrorCategory(error);
      log.warn(
        `Model unavailable (${failed.status}); building the result from source data: ${error instanceof Error ? error.message : String(error)}`,
      );
      const line = modelLine(reason, FALLBACK_SHOWS);
      status("LLM-ERROR", line);

      const fallback = await createFallbackTrackData(state, { newId: runtime.newId });
      signal?.throwIfAborted();
      const withCode = withCodeClaims(
        { claims: [], genealogy: fallback.genealogy, nodeYears: {} },
        codeBuilt(),
      );
      const draft: ComposedDraft = {
        modelUnavailableReason: reason,
        factoids: fallback.factoids,
        claims: withCode.claims,
        genealogy: withCode.genealogy,
        nodeYears: withCode.nodeYears,
        noArtwork: withCode.noArtwork,
        segments: fallback.segments,
        segmentsSource: "template",
        samples: fallback.samples,
      };
      return { draft, usage: [failed], statusMessages: [line] };
    }
  };
}

/** The composer with the default runtime (the shared provider layer, the system clock). */
export const composerNode = createComposerNode();

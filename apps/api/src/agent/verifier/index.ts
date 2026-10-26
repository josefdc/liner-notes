/**
 * Verifier node: checks every claim of the composer's draft against the evidence and the
 * measurement, then builds, sends and stores the result. It runs after the composer on every
 * run that has a draft, the fallback's included, and is the only node that emits `complete` for
 * a composed run.
 *
 * 1. The deterministic step (`checkClaims`, pure):
 *    - a cited id that is not in the evidence pack is dropped, and so is a cited item whose scope
 *      does not match the claim's (`scopeSupports`: a release-wide credit or a record about the
 *      song never supports a claim about this recording). A link cites what its claim still
 *      cites. A claim left citing nothing cannot be sourced; why is kept in `verdictReason`;
 *    - every claim that is not a link's relation claim gets the numeric check (numeric.ts):
 *      the tempo and key its text states against the measured ones, in `numericCheck`, apart
 *      from the judge's verdict;
 *    - a model claim that gives the track's tempo or key (its `field`), cites nothing and agrees
 *      with the measurement is dropped: it only restates a measured value, which the result
 *      shows as measured, and keeping it would show a measurement as the model's own finding.
 *      One that disagrees is kept with its check (conflict: both values shown; contradicted:
 *      the rejected panel). A factoid card's claim and a link's claim are never dropped.
 * 2. One judge call (judge.ts) on the model claims that still cite evidence, the first
 *    JUDGE_BATCH_MAX in result order; the rest get no verdict. `run.verifier` counts the judged
 *    claims and those left without a verdict. A judge failure leaves every verdict null and is
 *    recorded as a failed call; the result is still served, not the fallback.
 * 3. Kinds (`applyVerdicts`, pure): a model claim is sourced when the judge found its cited
 *    excerpts supporting it (`supported` or `partial`) and it cites at least one item, and
 *    inferred otherwise. A contradicted claim (verdict or numeric check) stays in the claims, and
 *    readers show it in the rejected panel. A link is sourced only through its own claim
 *    (`linkClaimProblem`'s rules): a link whose claim is not sourced, or is rejected, is drawn as
 *    an inferred influence that keeps its stated type.
 * 4. Model-written text (claims, factoid cards) has its @handles masked.
 * 5. The result: artwork for the genealogy nodes, the measurement written in by finalize.ts, the
 *    contract's checks, then `complete` and, when nothing a later run may do better is missing,
 *    the long-term store.
 */

import { getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  type AudioFeatures,
  analysisIssues,
  type Claim,
  claimIsRejected,
  type Evidence,
  linkClaimMismatches,
  type RunInfo,
  runIssues,
  type SourceError,
  scopeSupports,
  TrackAnalysis,
} from "@liner-notes/contract";
import { maskHandles } from "../../sources/search.js";
import { replayedRecording, runUsage } from "../callRecords.js";
import { enrichGenealogyWithArtwork } from "../enricher.js";
import { isAbortError } from "../errors.js";
import { emittableAudio, finalizeResult, type ResultDraft } from "../finalize.js";
import { promptTrack } from "../prompts.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor, timestampOf } from "../runtime.js";
import type { Factoid, Genealogy, TrackData } from "../schema.js";
import { MODEL_FAILURE_TEXT, modelErrorCategory } from "../statusText.js";
import {
  type ComposedDraft,
  type SonicAgentStateType,
  type SpotifyData,
  withChannelDefaults,
} from "../state.js";
import { shownQueryMatch, storeResult } from "../storedResults.js";
import { judgeClaims } from "./judge.js";
import { linkValue } from "./links.js";
import { checkNumbers } from "./numeric.js";
import { logger } from "../../logger.js";

const log = logger("Verifier");

export { INFERRED_LINK_VALUE, LINK_VALUE, linkValue } from "./links.js";

/** How the notes are shown when the judge gave no verdicts, for its status line. */
const UNCHECKED_SHOWN = "the notes are shown as model inference, not checked against their sources";

// =============================================================================
// The deterministic step
// =============================================================================

/** The ids of the claims the links state: their text is code-built from the relation. */
const linkClaimIds = (genealogy: Genealogy) =>
  new Set(genealogy.links.flatMap((link) => (link.claimId ? [link.claimId] : [])));

/** Why a claim's citations were all dropped, for its `verdictReason`. */
function droppedCitationsReason(outOfScope: number): string {
  if (outOfScope === 0) return "Not judged: the items it cites are not in the evidence pack.";
  return (
    "Not judged: the items it cites state facts about something other than what the claim is " +
    "about (this recording, the song or a whole release), so they cannot support it."
  );
}

export interface CheckedDraft {
  claims: Claim[];
  genealogy: Genealogy;
  /** Model claims dropped as restatements of a measured value. */
  dropped: Claim[];
}

/**
 * The deterministic step (see the module comment): citations checked against the pack and the
 * claim's scope, the numeric check against the measurement (`audio`, the block the result
 * carries), and restated measured values dropped. Pure.
 */
export function checkClaims(
  draft: Pick<ComposedDraft, "claims" | "genealogy">,
  evidence: readonly Evidence[],
  audio: AudioFeatures | null,
): CheckedDraft {
  const pack = new Map(evidence.map((item) => [item.id, item]));
  const stated = linkClaimIds(draft.genealogy);
  const dropped: Claim[] = [];
  const claims: Claim[] = [];
  for (const claim of draft.claims) {
    const inPack = claim.evidenceIds.filter((id) => pack.has(id));
    const supporting = inPack.filter((id) => {
      const item = pack.get(id);
      return item !== undefined && scopeSupports(claim.scope, item);
    });
    const lost = claim.evidenceIds.length > 0 && supporting.length === 0;
    let checked: Claim = {
      ...claim,
      evidenceIds: supporting,
      ...(lost
        ? {
            verdictReason: droppedCitationsReason(inPack.length - supporting.length),
          }
        : {}),
    };
    if (!stated.has(claim.id)) {
      const numbers = checkNumbers(claim, audio);
      checked = {
        ...checked,
        numericCheck: numbers.numericCheck,
        numericReason: numbers.numericReason,
        numericComparison: numbers.numericComparison,
        ...(checked.field === undefined && numbers.field ? { field: numbers.field } : {}),
      };
      const restated =
        claim.origin === "model" &&
        claim.factoid === undefined &&
        claim.field !== undefined &&
        supporting.length === 0 &&
        numbers.numericCheck === "consistent";
      if (restated) {
        dropped.push(checked);
        continue;
      }
    }
    claims.push(checked);
  }
  // A link cites what its claim still cites: the verifier judged the claim on those items.
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const links = draft.genealogy.links.map((link) => {
    const claim = link.claimId ? byId.get(link.claimId) : undefined;
    return claim ? { ...link, evidenceIds: [...claim.evidenceIds] } : link;
  });
  return { claims, genealogy: { nodes: draft.genealogy.nodes, links }, dropped };
}

/** The model claims the judge is asked about: those that still cite evidence, in order. */
export const judgeable = (claims: readonly Claim[]) =>
  claims.filter((claim) => claim.origin === "model" && claim.evidenceIds.length > 0);

// =============================================================================
// Kinds
// =============================================================================

/** Groups of a node a documented sample ties to the analysed track (see GenealogyNode). */
const SAMPLED_IN_TRACK = 2;
const SAMPLES_TRACK = 3;

/**
 * The claims with the judge's verdicts and their kinds, and the genealogy with each link's kind
 * from its own claim (see the module comment). Pure.
 */
export function applyVerdicts(
  checked: Pick<CheckedDraft, "claims" | "genealogy">,
  verdicts: ReadonlyMap<string, { verdict: Claim["verdict"]; reason: string }>,
): { claims: Claim[]; genealogy: Genealogy } {
  const claims = checked.claims.map((claim): Claim => {
    if (claim.origin !== "model") return claim;
    const judged = verdicts.get(claim.id);
    const verdict = judged?.verdict ?? null;
    const supported = verdict === "supported" || verdict === "partial";
    return {
      ...claim,
      verdict,
      verdictReason: judged ? judged.reason : (claim.verdictReason ?? null),
      kind: supported && claim.evidenceIds.length > 0 ? "sourced" : "inferred",
    };
  });
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const links = checked.genealogy.links.map((link) => {
    const claim = link.claimId ? byId.get(link.claimId) : undefined;
    if (!claim) return link;
    const sourced =
      claim.kind === "sourced" &&
      !claimIsRejected(claim) &&
      (link.evidenceIds ?? []).length > 0 &&
      linkClaimMismatches(link, claim).length === 0;
    const kind = sourced ? ("sourced" as const) : ("inferred" as const);
    return { ...link, kind, value: linkValue(link.type, kind) };
  });
  // A node a sourced sample or interpolation ties to the analysed track is drawn as one.
  const groups = new Map<string, number>();
  for (const link of links) {
    if (link.kind !== "sourced" || (link.type !== "sample" && link.type !== "interpolation")) {
      continue;
    }
    if (link.target === "current") groups.set(link.source, SAMPLED_IN_TRACK);
    else if (link.source === "current") groups.set(link.target, SAMPLES_TRACK);
  }
  const nodes = checked.genealogy.nodes.map((node) =>
    node.id !== "current" && groups.has(node.id) ? { ...node, group: groups.get(node.id)! } : node,
  );
  return { claims, genealogy: { nodes, links } };
}

/** Model-written text with its @handles masked: claims and factoid cards. */
function maskedText(
  claims: Claim[],
  factoids: Factoid[],
): { claims: Claim[]; factoids: Factoid[] } {
  return {
    claims: claims.map((claim) =>
      claim.origin !== "model"
        ? claim
        : {
            ...claim,
            text: maskHandles(claim.text),
            ...(claim.factoid
              ? {
                  factoid: {
                    ...claim.factoid,
                    title: maskHandles(claim.factoid.title),
                    entities: claim.factoid.entities.map((entity) => ({
                      ...entity,
                      text: maskHandles(entity.text),
                    })),
                  },
                }
              : {}),
          },
    ),
    factoids: factoids.map((card) => ({
      ...card,
      title: maskHandles(card.title),
      content: maskHandles(card.content),
      ...(card.entities
        ? {
            entities: card.entities.map((entity) => ({
              ...entity,
              text: maskHandles(entity.text),
              ...(entity.searchQuery ? { searchQuery: maskHandles(entity.searchQuery) } : {}),
            })),
          }
        : {}),
    })),
  };
}

// =============================================================================
// The result
// =============================================================================

// Audio problems that may clear up on the next run. A result missing audio for one of these
// reasons is not stored, so it is not served after the analysis service recovers, or after a
// preview lookup that could not be finished (`preview_lookup_incomplete`: no clip is known
// missing).
const TRANSIENT_AUDIO_REASONS = new Set([
  "service_unavailable",
  "analysis_failed",
  "not_run",
  "preview_lookup_incomplete",
]);

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

/**
 * Album artwork and previews for the genealogy nodes. The enricher's answer is used for
 * artwork only: nodes, labels and links stay as checked, and an entry is merged into the node
 * with its id (an entry for no node is ignored). The enricher is given the model's year for a
 * node (`nodeYears`) for its release check; the result's nodes do not carry it. `sourceErrors`
 * holds a source the enricher could not read for the previews (Deezer). `complete` is false when
 * the artwork pass was cut short or failed: some nodes lack artwork a later run may find.
 */
async function withArtwork(
  genealogy: Genealogy,
  coverUrl: string,
  signal: AbortSignal | undefined,
  nodeYears: Readonly<Record<string, string>> = {},
): Promise<{ genealogy: Genealogy; sourceErrors: SourceError[]; complete: boolean }> {
  const sourceErrors: SourceError[] = [];
  try {
    const dated = genealogy.nodes.map((node) => {
      const year = Object.hasOwn(nodeYears, node.id) ? nodeYears[node.id] : undefined;
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

export function createVerifierNode(runtime: AgentRuntime = defaultAgentRuntime) {
  return async function verifierNode(
    input: SonicAgentStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<SonicAgentStateType>> {
    const state = withChannelDefaults(input);
    const draft = state.draft;
    const spotify = state.spotifyData;
    if (!draft || !spotify) {
      return {
        error: "No draft to verify",
        statusMessages: ["The analysis could not be completed: nothing was written to check"],
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
        node: "verifier",
        timestamp: timestampOf(runtime),
      });
    const fallback = draft.modelUnavailableReason !== null;
    const audio = emittableAudio(state.audioFeatures);

    // 1. The deterministic step.
    const checked = checkClaims(draft, state.evidence, audio);
    if (checked.dropped.length > 0) {
      log.info(
        `Run ${runId}: dropped ${checked.dropped.length} claim(s) that only restate a measured value`,
      );
    }

    // 2. The judge.
    const toJudge = judgeable(checked.claims);
    if (toJudge.length > 0)
      status("LLM-CONNECT", "Checking the written notes against their sources");
    const judged = await judgeClaims(toJudge, state.evidence, promptTrack(spotify), runtime, {
      runId,
      signal,
    });
    const statusMessages: string[] = [];
    if (judged.failure !== null) {
      const text = MODEL_FAILURE_TEXT[modelErrorCategory(judged.failure)];
      const line = `${text[0].toUpperCase()}${text.slice(1)}; ${UNCHECKED_SHOWN}`;
      log.warn(
        `Run ${runId}: the judge gave no verdicts (${judged.call?.status}): ${judged.failure instanceof Error ? judged.failure.message : String(judged.failure)}`,
      );
      status("LLM-ERROR", line);
      statusMessages.push(line);
    }
    const calls = judged.call ? [judged.call] : [];

    // 3. Kinds, then 4. masked text.
    const verified = applyVerdicts(checked, judged.verdicts);
    const { claims, factoids } = maskedText(verified.claims, draft.factoids);

    // 5. The result.
    status("GRAPH-ENRICH", "Looking up cover art on Spotify for the genealogy");
    const enriched = await withArtwork(
      verified.genealogy,
      spotify.coverUrl,
      signal,
      draft.nodeYears,
    );
    const runErrors = enriched.sourceErrors;
    const records = [...state.usage, ...calls];
    // A run whose model answers came from cassettes is a replay of those answers, not a live
    // run: it says when and from which commit they were recorded (replayedRecording; null where a
    // cassette does not say), and that only the model's answers were replayed.
    const replayed = records.some((call) => call.mode === "replay");
    const run: RunInfo = {
      id: runId,
      mode: replayed ? "replay" : "live",
      ...(replayed ? replayedRecording(records) : { recordedAt: null, commit: null }),
      ...(replayed && { replayed: "model_answers" as const }),
      // finalizeResult sets it to the measurement's analyzerVersion (null without one).
      analyzerVersion: null,
      fallback,
      usage: runUsage(records, runtime.llm.callsForRun(runId)),
      verifier: { judged: judged.judged, unjudged: judged.unjudged },
      sourceErrors: [...state.sourceErrors, ...runErrors],
    };
    const resultDraft: ResultDraft = {
      ...baseFields(state, spotify),
      segments: draft.segments,
      segmentsSource: draft.segmentsSource,
      samples: draft.samples,
      factoids,
      genealogy: enriched.genealogy,
      claims,
      ...(draft.modelUnavailableReason !== null
        ? { modelUnavailable: true, modelUnavailableReason: draft.modelUnavailableReason }
        : {}),
      run,
    };
    const trackData = finalizeResult(resultDraft, state.audioFeatures);
    const issues = trackData.run ? runIssues(trackData.run, trackData.audio) : [];
    if (issues.length > 0) {
      log.warn(
        `Run ${runId}: the run information breaks the contract's run rules ` +
          `(${issues.join("; ")}); record its cassettes again so they say when and where`,
      );
    }

    // A cancelled run reports nothing and stores nothing.
    signal?.throwIfAborted();
    const problems = contractProblems(trackData, runId);
    if (problems) {
      log.error(`The result does not fit the contract: ${problems}`);
      return {
        error: `Result does not fit the contract: ${problems}`,
        usage: calls,
        sourceErrors: runErrors,
        statusMessages: [
          ...statusMessages,
          "The analysis could not be completed: the result failed its checks",
        ],
      };
    }
    writer?.({ type: "complete", data: trackData });

    // Cache the result in long-term memory under its track (storedResults.ts), unless a later
    // run may do better: the result is the fallback, the audio may be measurable later, a source
    // failed for a passing reason (an outage, a timeout, a rate limit, a rejected key), a model
    // call failed (a research planner's, or the judge's: its claims would be served unjudged),
    // or the genealogy's artwork pass was cut short (enriched.complete). A source that is only
    // not configured does not block it: the key names the configured sources. Nor does a source
    // read only for the genealogy previews (enriched.sourceErrors): a stored result never
    // carries a preview. Nor does a lasting error of the evidence pack (state.lastingSourceErrors:
    // a primary-record answer whose shape its reader does not know); it is stored with the result
    // and reported again when the result is served. The run information, the preview links and
    // the search match belong to this run, not to a later one served from the cache.
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
    const modelFailed = records.some((u) => u.status !== "ok");
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
      !fallback &&
      chosen &&
      !transientAudio &&
      !transientSources &&
      !modelFailed &&
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
      claims,
      usage: calls,
      sourceErrors: runErrors,
      statusMessages: fallback ? statusMessages : [...statusMessages, "Analysis complete"],
    };
  };
}

/** The verifier with the default runtime (the shared provider layer, the system clock). */
export const verifierNode = createVerifierNode();

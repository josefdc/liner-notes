/**
 * "More facts" for a track, as verified claims: what both factoid routes (http/routes/factoids.ts)
 * serve when facts are written live.
 *
 * 1. Run context. When the request names the analysis run the facts add to (`runId`), its stored
 *    result is read (storedAnalysis: the run's own result, or the recording a replayed run was
 *    sent): its evidence pack, its claims and factoids, and its measured audio. A run that is not
 *    stored, has no result, or is about another track gives no context: the pack is empty and
 *    every new fact reads as inferred.
 * 2. One model call per focus (tier `main`, schema `FactoidsOutput`), all at once. The provider
 *    layer runs at most LLM_CONCURRENCY of them at a time. The calls and the judge's share one
 *    request run id, so a request makes at most MAX_LLM_CALLS_PER_RUN calls, and each is held to
 *    the budget. A focus whose call fails is reported as failed; the others are kept.
 * 3. No repeats. A fact whose text is a near-duplicate (nearDuplicate) of one the run already has,
 *    or of one written earlier in the batch, is dropped.
 * 4. Claims. Each fact is a model claim (the composer's builder: inferred, no verdict), with the
 *    facts' claim id as its `claimId`. Cited ids that the prompt did not show are dropped. The
 *    claims then go through the verifier's own steps: checkClaims (citations against the pack and
 *    the claim's scope, the numeric check against the measured audio), one judge call on those
 *    that still cite evidence (in focus order), and applyVerdicts. A fact is sourced only when
 *    the judge found its cited excerpts supporting it; never measured. When the judge fails or the
 *    budget refuses it, the facts are kept with no verdict, read as inferred, and say they were
 *    not checked.
 * 5. Ids. A fact's id (also its claim's) is `fc-` and a short hash of the run id, the focus and
 *    the text, never a count, and it is unique against the ids the client and the run already
 *    have and the rest of the batch.
 *
 * The facts are handed back in focus order once all of them have been checked.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  type AudioFeatures,
  type Claim,
  type ComposerFactoid,
  type Evidence,
  type Factoid,
  FactoidsOutput,
  SPOTIFY_ID_PATTERN,
  TrackAnalysis,
} from "@liner-notes/contract";
import { FACTOID_ABOUT, modelClaim } from "../agent/nodes/composerNode.js";
import type { PromptTrack } from "../agent/prompts.js";
import { agentRuntime } from "../agent/runtime.js";
import { heldTextIssue } from "../agent/storedResults.js";
import { applyVerdicts, checkClaims, judgeable } from "../agent/verifier/index.js";
import { judgeClaims } from "../agent/verifier/judge.js";
import type { LlmPurpose } from "../config/settings.js";
import { resultOf } from "../http/routes/runs.js";
import { isLlmError } from "../llm/errors.js";
import type { Llm } from "../llm/invoke.js";
import { maskHandles } from "../sources/search.js";
import { getDb } from "../store/database.js";
import { getRun } from "../store/runs.js";
import { logger } from "../logger.js";
import { factoidMessages, shownFactoidEvidence } from "./prompt.js";

const log = logger("Factoids");

export const FACTOIDS_CALL_SITE = "factoids";
/** Output budget of a call, reasoning included (main tier: low effort). */
export const FACTOIDS_MAX_OUTPUT_TOKENS = 2500;

/** The focus of each fact, in the order the facts are sent. */
export const FACTOID_FOCUSES = [
  "hidden production techniques or studio secrets",
  "obscure samples, influences, or interpolations",
  "little-known collaborators, session musicians, or equipment used",
] as const;

/** Why a fact that cites evidence has no verdict when the judge gave none. */
export const NOT_CHECKED_REASON = "Not checked: the check against its sources could not run.";
const TOO_LONG_REASON = "Not judged: longer than the judge reads whole.";

// =============================================================================
// Run context
// =============================================================================

/** What a request's facts add to: the analysis run's stored result, or nothing. */
export interface RunContext {
  /** The analysis run, when the request named one (whether or not it was found). */
  runId: string | null;
  analysis: TrackAnalysis | null;
  evidence: readonly Evidence[];
  claims: readonly Claim[];
  factoids: readonly Factoid[];
  audio: AudioFeatures | null;
}

/** Reads the stored result of an analysis run; null when there is none to use. */
export type LoadRun = (runId: string) => TrackAnalysis | null;

/**
 * The stored result of run `runId`, as GET /api/runs/:id serves it: its own result, or for a
 * replayed run the recording it was sent. Null when the database is not open, the run is not
 * stored or has no result, the result no longer fits the contract, or it holds text the readers
 * of stored evidence now refuse (heldTextIssue).
 */
export function storedAnalysis(runId: string): TrackAnalysis | null {
  let record: ReturnType<typeof getRun>;
  try {
    record = getRun(getDb(), runId);
  } catch (error) {
    log.warn("The stored run could not be read; writing facts without it", { err: error });
    return null;
  }
  if (!record) return null;
  const parsed = TrackAnalysis.safeParse(resultOf(record));
  if (!parsed.success) return null;
  if (heldTextIssue(parsed.data)) return null;
  return parsed.data;
}

/** Text compared as a key: NFKC, lower case, letters and digits only, single spaces. */
export function normalisedFact(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The first `max` code points of a text (as the routes truncate title and artist). */
const codePoints = (text: string, max: number) => [...text].slice(0, max).join("");

/**
 * Whether a stored result is about the track the request names: the same Spotify id when the
 * request gives one, else the same title (compared as the routes truncate it).
 */
function sameTrack(analysis: TrackAnalysis, track: FactoidTrack): boolean {
  if (track.trackId && SPOTIFY_ID_PATTERN.test(track.trackId)) return analysis.id === track.trackId;
  const title = (text: string) => normalisedFact(codePoints(text, 200));
  return title(analysis.title) === title(track.title);
}

/** The context of `runId` for the track the request names (see RunContext). */
export function runContext(
  runId: string | undefined,
  track: FactoidTrack,
  load: LoadRun = storedAnalysis,
): RunContext {
  const none: RunContext = {
    runId: runId ?? null,
    analysis: null,
    evidence: [],
    claims: [],
    factoids: [],
    audio: null,
  };
  if (!runId) return none;
  const analysis = load(runId);
  if (!analysis) {
    log.info("The named run has no stored result; writing facts without evidence");
    return none;
  }
  if (!sameTrack(analysis, track)) {
    log.warn("The named run is about another track; writing facts without evidence");
    return none;
  }
  return {
    runId,
    analysis,
    evidence: analysis.evidence ?? [],
    claims: analysis.claims ?? [],
    factoids: analysis.factoids,
    audio: analysis.audio ?? null,
  };
}

// =============================================================================
// Repeats and ids
// =============================================================================

/** Below this share of shared words, two facts are different facts. */
const NEAR_DUPLICATE_OVERLAP = 0.8;

/**
 * Whether two fact texts state the same thing in nearly the same words: the same normalised
 * text, or word sets that overlap by NEAR_DUPLICATE_OVERLAP or more (shared words over all the
 * words of both).
 */
export function nearDuplicate(a: string, b: string): boolean {
  const left = normalisedFact(a);
  const right = normalisedFact(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  const words = (text: string) => new Set(text.split(" "));
  const one = words(left);
  const other = words(right);
  const shared = [...one].filter((word) => other.has(word)).length;
  return shared / (one.size + other.size - shared) >= NEAR_DUPLICATE_OVERLAP;
}

/**
 * The fact's id: `fc-` and a short hash of the analysis run id, the focus and the text; a taken
 * id is hashed again with a counter until it is free. Adds it to `taken`.
 */
export function factId(
  runId: string | null,
  focus: string,
  text: string,
  taken: Set<string>,
): string {
  for (let attempt = 0; ; attempt++) {
    const key = attempt === 0 ? [runId, focus, text] : [runId, focus, text, attempt];
    const id = `fc-${createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 12)}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

// =============================================================================
// Writing the facts
// =============================================================================

export interface FactoidTrack {
  title: string;
  artist?: string;
  /** The track id the client sent (POST only); a Spotify id names the track. */
  trackId?: string;
}

export interface FactoidRequest {
  track: FactoidTrack;
  /** The analysis run the facts add to (RESOURCE_ID_PATTERN), when the client names it. */
  runId?: string;
  /** The ids of the facts the client already shows. */
  existingIds: readonly string[];
}

export interface FactoidServiceOptions {
  llm: Llm;
  purpose: LlmPurpose;
  /** Stops the calls in flight when the client leaves. */
  signal: AbortSignal;
  /** Reads a run's stored result (default: storedAnalysis). */
  loadRun?: LoadRun;
}

/** What became of one focus. */
export type FocusOutcome =
  | { index: number; status: "written"; factoid: Factoid; claim: Claim }
  /** Nothing documented the model is sure of, or only a repeat of a fact the reader has seen. */
  | { index: number; status: "none"; reason: "nothing" | "repeat" }
  | { index: number; status: "failed"; error: unknown };

export interface FactoidsResult {
  /** One per focus, in focus order. */
  outcomes: FocusOutcome[];
  /** The analysis run the facts add to, when the request named one. */
  runId: string | null;
  /** The deployment of the first answered call; null when none answered. */
  model: string | null;
}

/** What the server log says about a failed call: the error kind, never the prompt. */
export const failure = (error: unknown) =>
  isLlmError(error) ? `${error.kind}: ${error.message}` : String(error);

/** A fact card and its claim from the model's answer, with its id set by code. */
function cardAndClaim(card: ComposerFactoid, id: string, citable: ReadonlySet<string>) {
  const claim: Claim = {
    ...modelClaim(id, {
      text: card.text,
      about: FACTOID_ABOUT[card.type],
      evidenceIds: [...new Set((card.evidenceIds ?? []).filter((item) => citable.has(item)))],
      scope: card.scope,
    }),
    factoid: { title: card.title, type: card.type, entities: card.entities },
  };
  const factoid: Factoid = {
    id,
    title: card.title,
    content: card.text,
    type: card.type,
    entities: card.entities.map((entity, index) => ({
      id: `${id}-e${index + 1}`,
      text: entity.text,
      type: entity.type,
      searchQuery: entity.text,
    })),
    claimId: id,
  };
  return { factoid, claim };
}

/** A card and its claim with their @handles masked, as the verifier masks the composer's. */
function masked(factoid: Factoid, claim: Claim): { factoid: Factoid; claim: Claim } {
  return {
    factoid: {
      ...factoid,
      title: maskHandles(factoid.title),
      content: maskHandles(factoid.content),
      entities: (factoid.entities ?? []).map((entity) => ({
        ...entity,
        text: maskHandles(entity.text),
        ...(entity.searchQuery ? { searchQuery: maskHandles(entity.searchQuery) } : {}),
      })),
    },
    claim: {
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
  };
}

/**
 * Writes one fact per focus (FACTOID_FOCUSES) about the request's track, checks them and hands
 * them back in focus order (see the module comment). Never throws for a model failure: a failed
 * focus is an outcome. Rethrows when the request's signal aborts.
 */
export async function writeFactoids(
  request: FactoidRequest,
  { llm, purpose, signal, loadRun = storedAnalysis }: FactoidServiceOptions,
): Promise<FactoidsResult> {
  const context = runContext(request.runId, request.track, loadRun);
  const callRunId = `factoids-${randomUUID()}`;
  const shown = shownFactoidEvidence(context.evidence);
  const citable = new Set(shown.map((item) => item.id));

  // What the reader has seen: the run's cards, then its other statements.
  const seen: string[] = [];
  for (const text of [
    ...context.factoids.map((factoid) => factoid.content),
    ...context.claims.map((claim) => claim.text),
  ]) {
    if (!seen.some((other) => normalisedFact(other) === normalisedFact(text))) seen.push(text);
  }

  // The run ends with the request, or as soon as the client leaves (calls may still be settling).
  const end = () => llm.endRun(callRunId);
  signal.addEventListener("abort", end, { once: true });
  try {
    // 2. One call per focus, all at once (the provider layer bounds how many run together).
    const answers = await Promise.all(
      FACTOID_FOCUSES.map(async (focus) => {
        try {
          const result = await llm.invoke(
            FACTOIDS_CALL_SITE,
            "main",
            factoidMessages({ track: request.track, evidence: shown, existing: seen }, [focus]),
            FactoidsOutput,
            { purpose, runId: callRunId, maxOutputTokens: FACTOIDS_MAX_OUTPUT_TOKENS, signal },
          );
          return { ok: true as const, card: result.output.factoids[0], model: result.deployment };
        } catch (error) {
          return { ok: false as const, error };
        }
      }),
    );
    if (signal.aborted) throw signal.reason ?? new Error("aborted");

    // 3. and 5. Repeats dropped, ids set, in focus order.
    const taken = new Set([
      ...request.existingIds,
      ...context.factoids.map((factoid) => factoid.id),
      ...context.claims.map((claim) => claim.id),
    ]);
    const written: string[] = [];
    const outcomes: FocusOutcome[] = [];
    // The written facts by focus index, until their claims are checked.
    const drafts = new Map<number, { factoid: Factoid; claim: Claim }>();
    for (const [index, answer] of answers.entries()) {
      if (!answer.ok) {
        log.error(`Factoid ${index + 1} failed (${failure(answer.error)})`);
        outcomes.push({ index, status: "failed", error: answer.error });
        continue;
      }
      const card = answer.card;
      if (!card) {
        log.info(`Factoid ${index + 1}: nothing documented`);
        outcomes.push({ index, status: "none", reason: "nothing" });
        continue;
      }
      if ([...seen, ...written].some((text) => nearDuplicate(text, card.text))) {
        log.info(`Factoid ${index + 1}: repeats a fact the reader has seen; dropped`);
        outcomes.push({ index, status: "none", reason: "repeat" });
        continue;
      }
      written.push(card.text);
      const id = factId(context.runId, FACTOID_FOCUSES[index], card.text, taken);
      drafts.set(index, cardAndClaim(card, id, citable));
    }

    // 4. The verifier's steps on the batch's claims, in focus order.
    const noGraph = { nodes: [], links: [] };
    const track = context.analysis ?? { title: request.track.title, artist: request.track.artist };
    const checked = checkClaims(
      { claims: [...drafts.values()].map((draft) => draft.claim), genealogy: noGraph },
      context.evidence,
      context.audio,
      track.title,
      track.artist,
    );
    const toJudge = judgeable(checked.claims, noGraph);
    const judged = await judgeClaims(
      toJudge,
      context.evidence,
      promptTrackOf(request.track, context.analysis),
      agentRuntime({ llm, purpose }),
      { runId: callRunId, signal },
    );
    if (judged.failure !== null) {
      log.warn(`The facts could not be checked against their sources (${failure(judged.failure)})`);
    }
    const verified = applyVerdicts({ claims: checked.claims, genealogy: noGraph }, judged.verdicts);
    const sent = new Set(toJudge.map((claim) => claim.id));
    const tooLong = new Set(judged.tooLong);
    const claimsById = new Map(
      verified.claims.map((claim) => {
        if (!sent.has(claim.id) || claim.verdict !== null) return [claim.id, claim];
        const reason = tooLong.has(claim.id) ? TOO_LONG_REASON : NOT_CHECKED_REASON;
        return [claim.id, { ...claim, verdictReason: reason }];
      }),
    );

    const answered = answers.find((answer) => answer.ok);
    const model = answered?.ok ? answered.model : null;
    for (const [index, draft] of drafts) {
      const claim = claimsById.get(draft.claim.id) ?? draft.claim;
      outcomes.push({ index, status: "written", ...masked(draft.factoid, claim) });
    }
    outcomes.sort((a, b) => a.index - b.index);
    return { runId: context.runId, model, outcomes };
  } finally {
    signal.removeEventListener("abort", end);
    if (!signal.aborted) end();
  }
}

/** The track as the judge's prompt shows it: the stored result's fields, else the request's. */
function promptTrackOf(track: FactoidTrack, analysis: TrackAnalysis | null): PromptTrack {
  if (analysis) {
    return {
      title: analysis.title,
      artist: analysis.artist,
      album: analysis.album || null,
      year: analysis.releaseYear ?? null,
    };
  }
  return { title: track.title, artist: track.artist ?? "", album: null, year: null };
}

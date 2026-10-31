/**
 * "More facts" for a result: the request the factoid stream is opened with, and how each answer
 * adds to what the result already has (MoreFacts). Plain functions, no React.
 *
 * A request names the result's own analysis run (`runId`), so the new facts can cite its
 * evidence and do not repeat its facts, and the round the last answer named (`round`), so each
 * click asks about other angles. A round asked again after some of its facts failed names them
 * (`failedIndexes`), and only those angles are asked. A result that names no run (from an older
 * server) is asked for without one: the API then writes facts without evidence, and every one of
 * them reads as inferred. The hook's own thread id is never sent in its place: it may be another
 * result's run.
 */

import type { Claim } from '@liner-notes/contract';
import { FIRST_FACTOID_ROUND, factoidRoundsLeft } from '@liner-notes/contract/factoids';
import type { Factoid, TrackData } from '../../types';
import { resultModeOf } from '../../utils/recording';
import type { RunToken } from './apiClient';
import { withRunToken } from './runToken';
import { API_BASE_URL, type FailedFact, type MoreFacts } from './types';

/** Which result a MoreFacts belongs to: its run id (when it names one) and its track id. */
export function moreFactsKey(result: TrackData): string {
  return JSON.stringify([result.run?.id ?? null, result.id]);
}

/** A result's MoreFacts before its first answer. */
export function newMoreFacts(result: TrackData): MoreFacts {
  return {
    result: moreFactsKey(result),
    factoids: [],
    claims: {},
    nextRound: FIRST_FACTOID_ROUND,
    finished: false,
    failed: [],
    failedIndexes: [],
    answerFailed: false,
    runId: null,
  };
}

/** The facts already added to `result` (none when `moreFacts` belongs to another result). */
export function moreFactsOf(result: TrackData, moreFacts: MoreFacts | null): MoreFacts {
  return moreFacts?.result === moreFactsKey(result) ? moreFacts : newMoreFacts(result);
}

/**
 * The URL of the factoid stream that asks for the next round of facts about `result`, with the
 * run token the request carries (agent/runToken.ts).
 */
export function moreFactsUrl(result: TrackData, moreFacts: MoreFacts, token: RunToken): string {
  const existingIds = [...result.factoids, ...moreFacts.factoids].map((factoid) => factoid.id);
  const mode = resultModeOf(result.run);
  const runId = result.run?.id;
  const params = new URLSearchParams({
    trackTitle: result.title,
    trackArtist: result.artist || '',
    existingIds: existingIds.join(','),
    round: String(moreFacts.nextRound),
    // The round asked again after some of its facts failed: only those angles are asked.
    ...(moreFacts.failedIndexes.length > 0
      ? { failedIndexes: moreFacts.failedIndexes.join(',') }
      : {}),
    ...(runId ? { runId } : {}),
    // More of a replayed result comes only from its recording, and more of a live result never
    // does (the API decides by this, not by what it allows right now).
    ...(mode ? { mode } : {}),
  });
  return withRunToken(`${API_BASE_URL}/factoids/more/stream?${params}`, token);
}

/**
 * With one more fact and its claim. A fact already kept (by id) is not added again; a claim
 * replaces the one kept under its id, so each claim is kept once.
 */
export function withFact(moreFacts: MoreFacts, factoid: Factoid, claim?: Claim): MoreFacts {
  const known = moreFacts.factoids.some((kept) => kept.id === factoid.id);
  if (known && !claim) return moreFacts;
  return {
    ...moreFacts,
    factoids: known ? moreFacts.factoids : [...moreFacts.factoids, factoid],
    claims: claim ? { ...moreFacts.claims, [claim.id]: claim } : moreFacts.claims,
  };
}

/** With one more fact of the latest answer that could not be written. */
export function withFailure(moreFacts: MoreFacts, failure: FailedFact): MoreFacts {
  return { ...moreFacts, failed: [...moreFacts.failed, failure] };
}

/** What one answer said and did, as the stream showed it until `done`. */
export interface MoreFactsAnswer {
  /** The round to ask for next (`connected`); absent when the answer names none. */
  nextRound?: number;
  /** Whether asking for that round can bring new facts (`connected`), when the API says. */
  roundsLeft?: boolean;
  /** The run the facts were checked against: the stream's own run id. */
  runId: string | null;
  /** How many facts it sent, new or not. */
  facts: number;
  /** How many facts it could not write (errors with an index). */
  failed: number;
  /**
   * The API could not write facts now: an error for the whole answer, or a code that says live
   * calls are unavailable (its rate limit, a paused budget, live calls switched off).
   */
  refused: boolean;
}

/**
 * Once an answer has ended. The API names the next round before it writes anything, so the round
 * it named comes next only when the answer was not refused and did not fail every fact it tried:
 * an answer with nothing new and no failure (nothing documented, or only repeats) moves on; one
 * that could not write its facts leaves the round to ask again. An answer that names no round
 * (recorded facts) leaves it too. Whether rounds are left is the API's word when it says
 * (`roundsLeft`), else the contract's count. `runId` is the run the facts were checked against.
 *
 * A round left to ask again is asked again only for the facts that failed (`failedIndexes`): the
 * indexes of this answer's failures (`moreFacts.failed`, cleared when it started). An answer that
 * failed as a whole, or was refused before it named a failed fact, wrote nothing, so the angles
 * left to ask are the ones they were. A round that moves on is asked whole.
 */
export function withAnswer(moreFacts: MoreFacts, answer: MoreFactsAnswer): MoreFacts {
  const { nextRound, runId } = answer;
  if (nextRound === undefined) return { ...moreFacts, failedIndexes: [], runId };
  const unwritten = answer.refused || (answer.facts === 0 && answer.failed > 0);
  if (unwritten) {
    const named = moreFacts.failed.length > 0 && !moreFacts.answerFailed;
    const failedIndexes = named
      ? [...new Set(moreFacts.failed.map((failure) => failure.index))].sort((a, b) => a - b)
      : moreFacts.failedIndexes;
    return { ...moreFacts, failedIndexes, runId };
  }
  const roundsLeft = answer.roundsLeft ?? factoidRoundsLeft(nextRound);
  return { ...moreFacts, nextRound, finished: !roundsLeft, failedIndexes: [], runId };
}

/**
 * A change to the facts kept for "more facts", always about one result: the facts kept for
 * another result are let go first (moreFactsOf).
 */
export type MoreFactsAction =
  /** A new answer is asked for: the last answer's failures are cleared. */
  | { type: 'answerStarted'; result: TrackData }
  /** The answer sent a fact, with its claim. */
  | { type: 'factReceived'; result: TrackData; factoid: Factoid; claim?: Claim }
  /** The answer could not write one of its facts. */
  | { type: 'factFailed'; result: TrackData; failure: FailedFact }
  /** The answer ended (`done`). */
  | { type: 'answerEnded'; result: TrackData; answer: MoreFactsAnswer }
  /** The answer failed as a whole: an error for all of it, or a stream that broke. */
  | { type: 'answerFailed'; result: TrackData }
  /** No answer could be asked for: no run token was given. */
  | { type: 'tokenRefused'; result: TrackData };

/** The facts kept after `action` (moreFacts is null before the first answer). */
export function moreFactsReducer(moreFacts: MoreFacts | null, action: MoreFactsAction): MoreFacts {
  const kept = moreFactsOf(action.result, moreFacts);
  switch (action.type) {
    case 'answerStarted':
      return { ...kept, failed: [], answerFailed: false };
    case 'factReceived':
      return withFact(kept, action.factoid, action.claim);
    case 'factFailed':
      return withFailure(kept, action.failure);
    case 'answerEnded':
      return withAnswer(kept, action.answer);
    case 'answerFailed':
      return { ...kept, answerFailed: true };
    case 'tokenRefused':
      return { ...kept, failed: [], answerFailed: true };
  }
}

/** True when `factoid` is not kept for `result` yet (by id): the answer adds it. */
export function isNewFact(
  moreFacts: MoreFacts | null,
  result: TrackData,
  factoid: Factoid,
): boolean {
  return !moreFactsOf(result, moreFacts).factoids.some((kept) => kept.id === factoid.id);
}

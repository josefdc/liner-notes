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
import {
  FACTOIDS_PER_ROUND,
  FIRST_FACTOID_ROUND,
  factoidRoundsLeft,
} from '@liner-notes/contract/factoids';
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
  /**
   * Its `connected` event came: the API took the request, and asks only after it. An answer
   * refused before it (the request limit, an expired run token, a paused budget, live calls
   * switched off, invalid input…) asked nothing.
   */
  connected: boolean;
  /** The round to ask for next (`connected`); absent when the answer names none. */
  nextRound?: number;
  /** Whether asking for that round can bring new facts (`connected`), when the API says. */
  roundsLeft?: boolean;
  /** The run the facts were checked against: the stream's own run id. */
  runId: string | null;
  /** How many facts it sent, new or not. */
  facts: number;
  /**
   * The API could not write facts now: an error for the whole answer, or a code that says live
   * calls are unavailable (its rate limit, a paused budget, live calls switched off).
   */
  refused: boolean;
  /** The angles of the round it asked, by index (askedAngles). */
  asked: number[];
  /** The angles whose fact it sent (a fact's `index`), in the order they came. */
  written: number[];
  /** How many facts it sent with no index (an older API): their angles are not known. */
  unplaced: number;
  /** The angles it could not write (errors with an index), in the order they came. */
  failedAt: number[];
  /**
   * Of those, the ones refused for now (a code that says live calls are unavailable: the rate
   * limit, a paused budget…), not failed (`failed`, what is left once the provider layer has
   * retried what is worth retrying).
   */
  refusedAt: number[];
  /** The code of its error with no index (one for the whole answer), or null. */
  wholeError: string | null;
}

/** Every angle of a round, by index. */
const EVERY_ANGLE = Array.from({ length: FACTOIDS_PER_ROUND }, (_angle, index) => index);

/** The angles the next request asks: the ones named to ask again, else every angle of the round. */
export function askedAngles(moreFacts: MoreFacts): number[] {
  return moreFacts.failedIndexes.length > 0 ? [...moreFacts.failedIndexes] : [...EVERY_ANGLE];
}

/**
 * The angles of the round an answer leaves to ask again, by index, in order: of the angles it
 * asked, the ones it did not write.
 * - An answer that ended (`done`) with no error for the whole answer said what became of every
 *   angle it asked: the ones it names as failed are left. A fact it did not send (nothing
 *   documented, or a repeat) is an answer too, and an angle an older API answered without being
 *   asked (it asks every angle) is not one this request asked.
 * - An answer that stopped before its end (a stream that broke or was left), or that sent an
 *   error for the whole answer, may not have said: every angle it asked and did not write is left.
 *   When it sent facts with no index (an older API), which angles they answer is not known: the
 *   ones named as failed are left. So an older API's stream that broke after such a fact and one
 *   failure leaves only that failure, and an angle it never answered is not named: harmless while
 *   that API asks every angle anyway, and a lost angle only if it is upgraded between two clicks.
 * - In a round asked again for some of its angles, an angle that failed with a code that is not
 *   a refusal (`failed`) is not left: it had its second try, and `failed` can be what the same
 *   prompt meets every time (a content filter, a refusal). A refusal (refusedAt) is left.
 */
export function anglesLeft(answer: MoreFactsAnswer, ended: boolean): number[] {
  const { asked, written, failedAt } = answer;
  const left =
    (ended && answer.wholeError === null) || (answer.unplaced > 0 && failedAt.length > 0)
      ? asked.filter((index) => failedAt.includes(index))
      : asked.filter((index) => !written.includes(index));
  if (asked.length === EVERY_ANGLE.length) return left;
  return left.filter((index) => !failedAt.includes(index) || answer.refusedAt.includes(index));
}

/** The request's `failedIndexes` for these angles: none when they are the whole round. */
const toAskAgain = (angles: number[]) => (angles.length === EVERY_ANGLE.length ? [] : angles);

/** The round moved on to `nextRound`: it is asked whole. */
function movedOn(moreFacts: MoreFacts, answer: MoreFactsAnswer & { nextRound: number }) {
  const roundsLeft = answer.roundsLeft ?? factoidRoundsLeft(answer.nextRound);
  return {
    ...moreFacts,
    nextRound: answer.nextRound,
    finished: !roundsLeft,
    failedIndexes: [],
    runId: answer.runId,
  };
}

/**
 * Once an answer has ended. The API names the next round before it writes anything, so the round
 * it named comes next only when the answer was not refused and did not fail every fact it tried:
 * an answer with nothing new and no failure (nothing documented, or only repeats) moves on; one
 * that could not write its facts leaves the round to ask again. That hold on an answer whose
 * every fact failed is kept, as before, for an ask of the whole round; in a round asked again for
 * some of its angles, the ones that failed with `failed` are dropped (anglesLeft), so one angle
 * that always fails does not hold its round for good. Whether rounds are left is the API's word
 * when it says (`roundsLeft`), else the contract's count. `runId` is the run the facts were
 * checked against.
 *
 * A round left to ask again is asked again only for the angles the answer left (anglesLeft,
 * `failedIndexes`); when it left none, the round moves on, and is asked whole. An answer refused
 * before `connected` asked nothing: the angles left to ask are the ones they were, except after
 * `invalid_input`, which the same request would meet again, so the round is then asked whole. A
 * recorded answer (`connected` with no round) names no angle either: its round is asked whole.
 */
export function withAnswer(moreFacts: MoreFacts, answer: MoreFactsAnswer): MoreFacts {
  const { nextRound, runId } = answer;
  if (!answer.connected) {
    return answer.wholeError === 'invalid_input'
      ? { ...moreFacts, failedIndexes: [], runId }
      : { ...moreFacts, runId };
  }
  if (nextRound === undefined) return { ...moreFacts, failedIndexes: [], runId };
  const unwritten = answer.refused || (answer.facts === 0 && answer.failedAt.length > 0);
  const left = anglesLeft(answer, true);
  if (unwritten && left.length > 0) return { ...moreFacts, failedIndexes: toAskAgain(left), runId };
  return movedOn(moreFacts, { ...answer, nextRound });
}

/**
 * Once an answer stopped before its end (a stream that broke, stopped responding or was left):
 * its round is asked again for the angles it left (anglesLeft), so a fact it sent is not asked
 * for again. When it left none (every angle it asked was written before it stopped), the round
 * it named moves on, and the answer is not said to have failed: every fact it asked for is shown.
 */
export function withStoppedAnswer(moreFacts: MoreFacts, answer: MoreFactsAnswer): MoreFacts {
  const left = anglesLeft(answer, false);
  if (left.length === 0 && answer.nextRound !== undefined) {
    return {
      ...movedOn(moreFacts, { ...answer, nextRound: answer.nextRound }),
      answerFailed: false,
    };
  }
  return { ...moreFacts, failedIndexes: toAskAgain(left) };
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
  /** The answer stopped before its end: the stream broke, stopped responding or was left. */
  | { type: 'answerStopped'; result: TrackData; answer: MoreFactsAnswer }
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
    case 'answerStopped':
      return withStoppedAnswer(kept, action.answer);
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

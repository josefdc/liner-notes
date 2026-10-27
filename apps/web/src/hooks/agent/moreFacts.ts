/**
 * "More facts" for a result: the request the factoid stream is opened with, and how each answer
 * adds to what the result already has (MoreFacts). Plain functions, no React.
 *
 * A request names the result's own analysis run (`runId`), so the new facts can cite its
 * evidence and do not repeat its facts, and the round the last answer named (`round`), so each
 * click asks about other angles. A result that names no run (from an older server) is asked for
 * without one: the API then writes facts without evidence, and every one of them reads as
 * inferred. The hook's own thread id is never sent in its place: it may be another result's run.
 */

import type { Claim } from '@liner-notes/contract';
import { FIRST_FACTOID_ROUND, factoidRoundsLeft } from '@liner-notes/contract/factoids';
import type { Factoid, TrackData } from '../../types';
import { resultModeOf } from '../../utils/recording';
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
    runId: null,
  };
}

/** The facts already added to `result` (none when `moreFacts` belongs to another result). */
export function moreFactsOf(result: TrackData, moreFacts: MoreFacts | null): MoreFacts {
  return moreFacts?.result === moreFactsKey(result) ? moreFacts : newMoreFacts(result);
}

/** The URL of the factoid stream that asks for the next round of facts about `result`. */
export function moreFactsUrl(result: TrackData, moreFacts: MoreFacts): string {
  const existingIds = [...result.factoids, ...moreFacts.factoids].map((factoid) => factoid.id);
  const mode = resultModeOf(result.run);
  const runId = result.run?.id;
  const params = new URLSearchParams({
    trackTitle: result.title,
    trackArtist: result.artist || '',
    existingIds: existingIds.join(','),
    round: String(moreFacts.nextRound),
    ...(runId ? { runId } : {}),
    // More of a replayed result comes only from its recording, and more of a live result never
    // does (the API decides by this, not by what it allows right now).
    ...(mode ? { mode } : {}),
  });
  return `${API_BASE_URL}/factoids/more/stream?${params}`;
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

/**
 * Once an answer has ended: the round it named comes next (an answer that names none, such as
 * recorded facts or a refusal, leaves the round as it was), and `runId` is the run its facts were
 * checked against.
 */
export function withAnswer(
  moreFacts: MoreFacts,
  nextRound: number | undefined,
  runId: string | null,
): MoreFacts {
  if (nextRound === undefined) return { ...moreFacts, runId };
  return { ...moreFacts, nextRound, finished: !factoidRoundsLeft(nextRound), runId };
}

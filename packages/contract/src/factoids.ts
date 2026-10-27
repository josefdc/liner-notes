/**
 * The rounds of "more facts", shared by the API (which angles a request asks about) and by the
 * web (what it asks for next, and when to stop asking). Plain code with no schema, so the web
 * loads it from `@liner-notes/contract/factoids` without zod.
 *
 * A track's facts are asked for in rounds, each about other angles: the first request asks for
 * round FIRST_FACTOID_ROUND, and each answer's `nextRound` (FactoidsResponse, the stream's
 * `connected` event) is the round to ask for next. Once it is FACTOID_ROUNDS every angle has
 * been asked, and asking again gives nothing new. An answer also says so itself (`roundsLeft`),
 * which a client reads first: a page built before the API changed its rounds may count wrong.
 */

/** The round a track's first "more facts" request asks for. */
export const FIRST_FACTOID_ROUND = 0;

/** How many rounds a track's "more facts" have: a `nextRound` this high has nothing left. */
export const FACTOID_ROUNDS = 2;

/** Whether an answer whose `nextRound` is this leaves a round to ask for. */
export function factoidRoundsLeft(nextRound: number): boolean {
  return nextRound < FACTOID_ROUNDS;
}

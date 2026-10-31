/**
 * "More facts" about a result: the next round of the factoid stream (moreFacts.ts), asked for
 * with the result's own run id and the round the last answer named. The facts and their claims
 * are kept as they come, each once by id, and the promise resolves with the facts this answer
 * added. Once every round has been asked no request is made, and it resolves with none. A fact
 * that could not be written is kept in `moreFacts.failed` by its index; the other facts of the
 * answer are kept.
 *
 * The round moves on once an answer has ended (withAnswer), or once one that stopped before its
 * end (a stream that broke, stopped responding or was left: withStoppedAnswer) had written every
 * angle it asked. An answer of a whole round whose every fact failed, one the API could not write
 * now (a paused budget, an error for the whole answer), one refused before `connected`, and a
 * stream that stopped before its angles were written leave the round to ask again.
 * The API asks the round sent, as it is. When the last answer for the round wrote some of its
 * angles, only the others are asked again (`failedIndexes`, anglesLeft): the angles it asked
 * less the ones whose fact it sent (each live fact names its angle, `index`), or, once it ended,
 * the ones it named as failed. So an angle whose fact this client was sent is not asked again,
 * and its answer cannot come back in other words; another angle can still state that fact in
 * other words (the API knows the client's facts by id only). Otherwise every angle of the
 * round is asked, and a fact the client already shows (the same text, up to case, spacing and
 * punctuation) is not sent again; one in other words is not recognised (the client sends ids,
 * not texts). An API that ignores `failedIndexes` (older) asks every angle again, and a fact it
 * sends with no index is not placed. An answer that failed as a whole, or a stream that broke or
 * stopped responding, sets `moreFacts.answerFailed`, so the Player can say so.
 */

import type { Factoid, FactoidUnavailableCode, TrackData } from '../../types';
import { type RunToken, RunTokenError } from './apiClient';
import { newRunEvents, parseFactoidEvent, streamGuard } from './events';
import type { WaitKeeper } from './failure';
import {
  askedAngles,
  isNewFact,
  type MoreFactsAction,
  type MoreFactsAnswer,
  moreFactsOf,
  moreFactsUrl,
} from './moreFacts';
import { isUsable, newRunToken, type TokenKeeper } from './runToken';
import { abortError, eitherSignal, inactivityWatchdog, readersReady } from './streams';
import type { MoreFacts, MoreFactsOptions } from './types';

/** A code that says the API cannot write facts now (a refusal), not that a fact failed. */
const isRefusal = (code: string): code is FactoidUnavailableCode =>
  code === 'rate_limited' ||
  code === 'budget_exhausted' ||
  code === 'live_disabled' ||
  code === 'not_found';

export interface FactoidStreamContext {
  /** The current run's signal: a new analysis or a reset ends the stream. */
  runSignal: AbortSignal;
  /** The facts kept so far, as last changed (before the state is rendered). */
  moreFacts: () => MoreFacts | null;
  /** Changes the facts kept (moreFactsReducer). */
  change: (action: MoreFactsAction) => void;
  /** A refusal's wait: no request is sent before it is over. */
  waits: WaitKeeper;
  /** The latest run token, sent again while it may be. */
  tokens: TokenKeeper;
}

export function streamMoreFacts(
  result: TrackData,
  { signal, onUnavailable }: MoreFactsOptions,
  { runSignal, moreFacts, change, waits, tokens }: FactoidStreamContext,
): Promise<Factoid[]> {
  return new Promise((resolve, reject) => {
    if (runSignal.aborted || signal?.aborted) {
      reject(abortError());
      return;
    }
    if (moreFactsOf(result, moreFacts()).finished) {
      resolve([]);
      return;
    }
    // A refusal said how long to wait (Wait), and that time is not over: no request is sent.
    if (waits.waiting()) {
      onUnavailable?.('rate_limited');
      resolve([]);
      return;
    }

    const open = (token: RunToken) => {
      // What this result already has; another result's facts are let go.
      const before = moreFactsOf(result, moreFacts());
      const url = moreFactsUrl(result, before, token);
      change({ type: 'answerStarted', result });

      const eventSource = new EventSource(url);
      const events = newRunEvents();
      const accept = streamGuard(events);
      const added: Factoid[] = [];
      // What the answer says and does until `done` (withAnswer).
      const answer: Omit<MoreFactsAnswer, 'runId'> = {
        connected: false,
        facts: 0,
        refused: false,
        asked: askedAngles(before),
        written: [],
        unplaced: 0,
        failedAt: [],
        refusedAt: [],
        wholeError: null,
      };
      // The answer stopped before its end: the angles it did not write are asked again.
      const stopped = () =>
        change({ type: 'answerStopped', result, answer: { ...answer, runId: events.runId } });
      let active = true;

      const stop = () => {
        active = false;
        watchdog.stop();
        eventSource.close();
        runSignal.removeEventListener('abort', onAbort);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        stop();
        // A new analysis or a reset lets the facts go: nothing is kept for this result then.
        if (!runSignal.aborted) stopped();
        reject(abortError());
      };
      // The answer failed as a whole: the Player says so, and the round is asked again.
      const answerFailed = () => change({ type: 'answerFailed', result });
      const watchdog = inactivityWatchdog(() => {
        stop();
        answerFailed();
        stopped();
        reject(new Error('Factoid stream stopped responding'));
      });
      runSignal.addEventListener('abort', onAbort, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });

      eventSource.addEventListener('heartbeat', () => watchdog.heartbeat());
      eventSource.onmessage = (event) => {
        // Nothing reaches the caller once the stream is closed or aborted.
        if (!active) return;
        watchdog.activity();
        const data = parseFactoidEvent(event.data);
        if (!data || !accept(data)) return;

        switch (data.type) {
          case 'connected':
            answer.connected = true;
            answer.nextRound = data.nextRound;
            answer.roundsLeft = data.roundsLeft;
            break;

          case 'factoid': {
            const factoid = data.data as Factoid;
            answer.facts++;
            if (data.index !== undefined) answer.written.push(data.index);
            else answer.unplaced++;
            // A fact already kept (by id) is not added again.
            if (isNewFact(moreFacts(), result, factoid)) added.push(factoid);
            change({ type: 'factReceived', result, factoid, claim: data.claim });
            break;
          }

          case 'heartbeat':
            watchdog.heartbeat();
            break;

          case 'done':
            stop();
            change({ type: 'answerEnded', result, answer: { ...answer, runId: events.runId } });
            resolve(added);
            break;

          case 'error': {
            // One fact that failed (an index) is kept as failed; the stream goes on, and
            // the other facts are kept. The rate limit, a paused budget, live calls switched
            // off and a recording no longer served are also reported to the caller, which
            // says why; other failures of the whole request are logged. A refusal, or an
            // answer that wrote none of its facts, leaves its round to ask again (withAnswer).
            // A fact that failed with `failed` beside facts written does not: that code is
            // what is left once the provider layer has retried what is worth retrying, and
            // includes failures the same prompt meets again (a content filter, a refusal).
            const refusal = isRefusal(data.code);
            if (data.index !== undefined) {
              answer.failedAt.push(data.index);
              if (refusal) answer.refusedAt.push(data.index);
              change({
                type: 'factFailed',
                result,
                failure: { index: data.index, code: data.code },
              });
            } else answer.wholeError ??= data.code;
            // A refusal that says how long to wait: nothing is sent before then.
            if (data.retryAfterMs !== undefined && data.retryAfterMs > 0) {
              waits.holdOff(data.retryAfterMs, data.error, data.code);
            }
            if (isRefusal(data.code)) {
              answer.refused = true;
              onUnavailable?.(data.code);
            } else if (data.index === undefined) {
              answer.refused = true;
              answerFailed();
              // A refused run token is not sent again: the next click asks for a new one.
              if (data.code === 'auth_expired') tokens.drop(token);
              console.warn('[useAgent] Factoid stream error:', data.error);
            }
            break;
          }
        }
      };

      // A 401 (a refused run token) reads like any failed connection here: the token is not
      // sent again, and the next click asks for a new one.
      eventSource.onerror = () => {
        stop();
        answerFailed();
        stopped();
        tokens.drop(token);
        reject(new Error('Factoid stream connection failed'));
      };
    };

    // The stream is opened once the code that reads it is loaded, with the latest run token
    // while it may still be sent, or else a new one.
    const held = tokens.held();
    let tokenFailed = false;
    const token = isUsable(held)
      ? held
      : newRunToken(eitherSignal(runSignal, signal), 'facts').then(
          (fresh) => {
            tokens.keep(fresh);
            return fresh;
          },
          (error: unknown) => {
            tokenFailed = true;
            // A refusal that says how long to wait: nothing is sent before then.
            if (error instanceof RunTokenError && error.retryAfterMs) {
              waits.holdOff(error.retryAfterMs, error.message, error.code);
            }
            throw error;
          },
        );
    const ready = readersReady();
    if (!ready && !(token instanceof Promise)) {
      open(token);
      return;
    }
    Promise.all([ready, token]).then(
      ([, usable]) => {
        if (runSignal.aborted || signal?.aborted) reject(abortError());
        else open(usable);
      },
      (error: unknown) => {
        if (runSignal.aborted || signal?.aborted) {
          reject(abortError());
          return;
        }
        // Without a token the answer could not be asked for: the Player says so, and the
        // round is asked again.
        if (tokenFailed) change({ type: 'tokenRefused', result });
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

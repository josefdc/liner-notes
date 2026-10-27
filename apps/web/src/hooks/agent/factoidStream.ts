/**
 * "More facts" about a result: the next round of the factoid stream (moreFacts.ts), asked for
 * with the result's own run id and the round the last answer named. The facts and their claims
 * are kept as they come, each once by id, and the promise resolves with the facts this answer
 * added. Once every round has been asked no request is made, and it resolves with none. A fact
 * that could not be written is kept in `moreFacts.failed` by its index; the other facts of the
 * answer are kept.
 *
 * The round moves on only once an answer has ended (withAnswer): an answer whose every fact
 * failed, or that the API could not write now (a paused budget, an error for the whole answer),
 * leaves the round to ask again, and so does a stream that broke or was left before its end.
 * The API asks the round sent, as it is: the round's angles are asked again, and a fact of it
 * the client already shows (the same text, up to case, spacing and punctuation) is not sent
 * again. A fact that comes back in other words is not recognised (the client sends ids, not
 * texts). An answer that failed as a whole, or a stream that broke or stopped responding, sets
 * `moreFacts.answerFailed`, so the Player can say so.
 */

import type { Factoid, TrackData } from '../../types';
import { type RunToken, RunTokenError } from './apiClient';
import { newRunEvents, parseFactoidEvent, streamGuard } from './events';
import type { WaitKeeper } from './failure';
import {
  isNewFact,
  type MoreFactsAction,
  type MoreFactsAnswer,
  moreFactsOf,
  moreFactsUrl,
} from './moreFacts';
import { isUsable, newRunToken, type TokenKeeper } from './runToken';
import { abortError, eitherSignal, inactivityWatchdog, readersReady } from './streams';
import type { MoreFacts, MoreFactsOptions } from './types';

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
      const url = moreFactsUrl(result, moreFactsOf(result, moreFacts()), token);
      change({ type: 'answerStarted', result });

      const eventSource = new EventSource(url);
      const events = newRunEvents();
      const accept = streamGuard(events);
      const added: Factoid[] = [];
      // What the answer says and does until `done` (withAnswer).
      const answer: Omit<MoreFactsAnswer, 'runId'> = { facts: 0, failed: 0, refused: false };
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
        reject(abortError());
      };
      // The answer failed as a whole: the Player says so, and the round is asked again.
      const answerFailed = () => change({ type: 'answerFailed', result });
      const watchdog = inactivityWatchdog(() => {
        stop();
        answerFailed();
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
            answer.nextRound = data.nextRound;
            answer.roundsLeft = data.roundsLeft;
            break;

          case 'factoid': {
            const factoid = data.data as Factoid;
            answer.facts++;
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

          case 'error':
            // One fact that failed (an index) is kept as failed; the stream goes on, and
            // the other facts are kept. The rate limit, a paused budget, live calls switched
            // off and a recording no longer served are also reported to the caller, which
            // says why; other failures of the whole request are logged. Either way the
            // answer did not write what it asked for, so its round is asked again.
            if (data.index !== undefined) {
              answer.failed++;
              change({
                type: 'factFailed',
                result,
                failure: { index: data.index, code: data.code },
              });
            }
            // A refusal that says how long to wait: nothing is sent before then.
            if (data.retryAfterMs !== undefined && data.retryAfterMs > 0) {
              waits.holdOff(data.retryAfterMs, data.error, data.code);
            }
            if (
              data.code === 'rate_limited' ||
              data.code === 'budget_exhausted' ||
              data.code === 'live_disabled' ||
              data.code === 'not_found'
            ) {
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
      };

      // A 401 (a refused run token) reads like any failed connection here: the token is not
      // sent again, and the next click asks for a new one.
      eventSource.onerror = () => {
        stop();
        answerFailed();
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

/**
 * useAgent Hook - Connect Frontend to Sonic Agent Backend
 *
 * Features:
 * - SSE streaming for real-time status updates
 * - Human-in-the-loop disambiguation handling
 * - An inactivity watchdog fed by the server's heartbeat events
 * - TypeScript types aligned with backend schemas
 *
 * Every analysis is a "run" (agent/run.ts): its first stream, the track picker and the resume
 * stream all belong to it. Events are handled only while their stream is the run's current
 * stream and the run is the latest one (agent/streams.ts), so a stale stream can never close or
 * overwrite a newer one. Each message is parsed with the contract's schema (agent/events.ts):
 * unknown types, invalid progress events, repeats, events of another run and a second `complete`
 * of the run are skipped; an outcome this page cannot read ends the run with a hint to reload
 * the page. A broken stream ends the run with an error the user can retry; it never starts the
 * analysis again by itself.
 *
 * What the hook shows is kept in pieces (agent/state.ts), each changed by named actions: the
 * progress line, what the run has to show, why it failed, its log and the facts "more facts"
 * added. This file wires them to the streams.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Factoid, LogCode, TrackData } from '../types';
import { isSpotifyTrackId } from '../utils/spotify';
import { fetchSuggestions, type RunToken } from './agent/apiClient';
import { type AnalysisEvent, eventSchemasLoaded, loadEventSchemas } from './agent/events';
import { streamMoreFacts } from './agent/factoidStream';
import { CLIENT_ERROR_CODES, OUTDATED_ERROR, tokenFailure, waitKeeper } from './agent/failure';
import { type MoreFactsAction, moreFactsReducer } from './agent/moreFacts';
import { advance, newRun, type Run } from './agent/run';
import { newLog } from './agent/runLog';
import { handleRunEvent } from './agent/runEvents';
import { checksVisitor, newRunToken, tokenKeeper, withRunToken } from './agent/runToken';
import { agentReducer, agentStateOf, INITIAL_PIECES } from './agent/state';
import { type OpenStream, openRunStream, readersReady } from './agent/streams';
import {
  API_BASE_URL,
  type AnalyzeOptions as RequestOptions,
  type MoreFacts,
  type MoreFactsOptions,
  type PickedBy,
  type SearchCandidate,
  type UseAgentReturn,
} from './agent/types';

// Re-export what consumers and tests import from this file.
export type { SearchCandidate, UseAgentReturn } from './agent/types';
export { CLIENT_ERROR_CODES, OUTDATED_ERROR } from './agent/failure';
export { CHECK_NOTE } from './agent/progress';
export { eitherSignal, STREAM_INACTIVITY_TIMEOUT_MS } from './agent/streams';

/** How `analyze` was asked for: the request's own options, and the hook's own ones. */
interface AnalyzeOptions extends RequestOptions {
  /** A log line saying why this search started. */
  note?: string;
  /** Only a result for this track is shown. */
  expectedTrackId?: string;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgent(): UseAgentReturn {
  const [pieces, dispatch] = useReducer(agentReducer, INITIAL_PIECES);

  // Built once: a fresh run (and AbortController) per render would be wasted.
  const [initialRun] = useState(() => newRun(''));
  const runRef = useRef<Run>(initialRun);
  // `analyze`, for the stream handlers defined before it.
  const analyzeRef = useRef<((query: string, options?: AnalyzeOptions) => Promise<void>) | null>(
    null,
  );
  // The run's open stream.
  const streamRef = useRef<OpenStream | null>(null);
  // `moreFacts` as last changed, for the next request (its round) before the state is rendered.
  const moreFactsRef = useRef<MoreFacts | null>(null);
  // The latest run token, and the latest refusal that said how long to wait.
  const [tokens] = useState(tokenKeeper);
  const [waits] = useState(waitKeeper);

  const changeMoreFacts = useCallback((action: MoreFactsAction) => {
    const moreFacts = moreFactsReducer(moreFactsRef.current, action);
    moreFactsRef.current = moreFacts;
    dispatch({ type: 'moreFactsChanged', moreFacts });
  }, []);

  // Fetch the stream reader as soon as the app is up, so the first search does not wait for it.
  // A failure is reported by the search that needs it, which tries again.
  useEffect(() => {
    if (!eventSchemasLoaded()) loadEventSchemas().catch(() => {});
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      runRef.current.controller.abort();
      runRef.current = newRun('');
    };
  }, []);

  const addLog = useCallback(
    (message: string, code?: LogCode, node?: string, elapsedMs?: number) =>
      dispatch({ type: 'logged', log: newLog(message, code, node, elapsedMs) }),
    [],
  );

  /**
   * Ends the run with an error the user can retry. `elapsedMs`: the time since the run started
   * that the server's event the error comes from was sent with, when it sent one.
   * `retryAfterMs`: how long the refusal said to wait; no request is sent before then
   * (`retryAt`).
   */
  const fail = useCallback(
    (run: Run, message: string, code?: string, elapsedMs?: number, retryAfterMs?: number) => {
      if (runRef.current !== run || run.life.phase === 'failed') return;
      advance(run, { type: 'failed' });
      const retryAt =
        retryAfterMs !== undefined && retryAfterMs > 0
          ? waits.holdOff(retryAfterMs, message, code ?? null)
          : null;
      dispatch({ type: 'failed', message, code: code ?? null, retryAt });
      addLog(`Error: ${message}`, 'SYS-ERROR', undefined, elapsedMs);
    },
    [addLog, waits],
  );

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    runRef.current.controller.abort();
    runRef.current = newRun('');
    moreFactsRef.current = null;
    dispatch({ type: 'reset' });
  }, []);

  /** Handle one event of the run's current stream (agent/runEvents.ts). */
  const handleStreamEvent = useCallback(
    (run: Run, data: AnalysisEvent, close: () => void) =>
      handleRunEvent(run, data, close, {
        dispatch,
        log: addLog,
        fail,
        isLatest: (candidate) => runRef.current === candidate,
        dropToken: tokens.drop,
        analyze: (query, options) => analyzeRef.current?.(query, options),
      }),
    [addLog, fail, tokens],
  );

  /**
   * Open a stream for the run and make it the run's current stream.
   */
  const openStream = useCallback(
    (url: string, run: Run, onOpen?: () => void) =>
      openRunStream(url, {
        events: run.events,
        signal: run.controller.signal,
        slot: streamRef,
        isLatest: () => runRef.current === run,
        onOpen,
        onEvent: (data, close) => handleStreamEvent(run, data, close),
        onRefused: () => tokens.drop(run.life.token),
        onLost: (message, code) => {
          if (run.life.phase === 'running') fail(run, message, code);
        },
      }),
    [fail, handleStreamEvent, tokens],
  );

  /**
   * Analyze a song with streaming
   */
  const analyze = useCallback(
    async (query: string, options: AnalyzeOptions = {}) => {
      runRef.current.controller.abort();
      const run = newRun(query, options);
      runRef.current = run;
      moreFactsRef.current = null;

      // A refusal said how long to wait, and that time is not over: nothing is sent (it would be
      // refused again), and the run ends with that refusal and the time left.
      const wait = waits.waiting();
      if (wait) {
        dispatch({ type: 'reset' });
        fail(run, wait.message, wait.code ?? undefined, undefined, wait.until - Date.now());
        return;
      }

      dispatch({ type: 'started' });
      addLog(`Searching for "${query}"`);
      // Logged after the reset above, so it stays with the run it explains.
      if (options.note) addLog(options.note, 'SYS-WARN');

      // Waits only on the first search: once the reader is loaded the stream opens at once.
      const ready = readersReady();
      if (ready) {
        try {
          await ready;
        } catch (error) {
          console.error('[useAgent] Could not load the stream reader:', error);
          fail(run, OUTDATED_ERROR.message, OUTDATED_ERROR.code);
          return;
        }
        // A newer analysis may have started while the reader loaded.
        if (runRef.current !== run) return;
      }

      // Every analysis starts with a token of its own (agent/runToken.ts), after a Turnstile check
      // when the build has a site key: the progress line says so while it runs.
      if (checksVisitor()) dispatch({ type: 'checkStarted' });
      let token: RunToken;
      try {
        token = await newRunToken(run.controller.signal);
      } catch (error) {
        if (runRef.current !== run) return;
        const { message, code, retryAfterMs } = tokenFailure(
          error,
          CLIENT_ERROR_CODES.streamOpenFailed,
        );
        fail(run, message, code, undefined, retryAfterMs);
        return;
      }
      advance(run, { type: 'tokenIssued', token });
      if (runRef.current !== run) return;
      tokens.keep(token);
      dispatch({ type: 'checkEnded' });

      try {
        // With a track id (a clicked suggestion) the API analyses that very track.
        // An id that is not a Spotify track id (a placeholder) is not sent: the text is searched.
        const byId = isSpotifyTrackId(options.trackId);
        const trackId = byId ? `&trackId=${encodeURIComponent(options.trackId as string)}` : '';
        const how = byId && options.pickedBy ? `&pickedBy=${options.pickedBy}` : '';
        const url = withRunToken(
          `${API_BASE_URL}/analyze/stream?query=${encodeURIComponent(query)}${trackId}${how}`,
          token,
        );
        openStream(url, run, () => dispatch({ type: 'opened' }));
      } catch (error) {
        fail(
          run,
          error instanceof Error ? error.message : 'Connection failed',
          CLIENT_ERROR_CODES.streamOpenFailed,
        );
      }
    },
    [addLog, fail, openStream, tokens, waits],
  );

  useEffect(() => {
    analyzeRef.current = analyze;
  }, [analyze]);

  /**
   * Select a candidate after disambiguation. Only the first selection for a picker counts.
   */
  const selectCandidate = useCallback(
    async (candidateId: string, pickedBy?: PickedBy) => {
      const run = runRef.current;
      if (run.life.phase !== 'awaiting-selection') return;
      const candidate = run.life.candidates?.find((c) => c.id === candidateId);
      if (!candidate) return;

      advance(run, { type: 'picked', candidate });
      // The analysis stream has done its part; nothing it sends later may touch this run.
      streamRef.current?.close();

      const { threadId, token } = run.life;
      if (!threadId) {
        // Without a thread there is nothing to resume: analyse the chosen track by its id, with
        // the text the user searched (the result says how it matches) and how the row was
        // picked, as a resume would. A row without a Spotify id cannot be asked for: searching
        // the text again would only bring the same picker back.
        if (!isSpotifyTrackId(candidate.id)) {
          fail(
            run,
            'The track you picked could not be found again. Please search again.',
            CLIENT_ERROR_CODES.choiceLost,
          );
          return;
        }
        await analyze(run.query || `${candidate.title} ${candidate.artist}`, {
          trackId: candidate.id,
          ...(pickedBy ? { pickedBy } : {}),
        });
        return;
      }

      // The user picked it: the picker waits for the user ("countdown" picks exist only in older
      // recordings).
      addLog('Resuming the analysis with the selected track');
      dispatch({ type: 'resumed' });

      try {
        // The run's own token: only the token a run started with resumes it. One that has
        // expired is sent all the same, and the API says so in the stream.
        if (!token) throw new Error('The run has no run token');
        const how = pickedBy ? `&pickedBy=${pickedBy}` : '';
        const url = withRunToken(
          `${API_BASE_URL}/analyze/stream/resume?threadId=${encodeURIComponent(threadId)}&selectedTrackId=${encodeURIComponent(candidateId)}${how}`,
          token,
        );
        openStream(url, run);
      } catch (error) {
        fail(
          run,
          error instanceof Error ? error.message : 'Selection failed',
          CLIENT_ERROR_CODES.resumeFailed,
        );
      }
    },
    [addLog, analyze, fail, openStream],
  );

  /**
   * Run the last analysis again (the error screen's retry).
   */
  const retry = useCallback(() => {
    const { query, trackId, pickedBy } = runRef.current;
    if (query) analyze(query, trackId ? { trackId, ...(pickedBy ? { pickedBy } : {}) } : {});
  }, [analyze]);

  /**
   * "More facts" about a result: the next round of the factoid stream (agent/factoidStream.ts),
   * kept in `moreFacts` as the facts come.
   */
  const moreFactoidsStream = useCallback(
    (result: TrackData, options: MoreFactsOptions = {}): Promise<Factoid[]> =>
      streamMoreFacts(result, options, {
        // A new analysis or a reset ends the stream, as does the caller's signal.
        runSignal: runRef.current.controller.signal,
        moreFacts: () => moreFactsRef.current,
        change: changeMoreFacts,
        waits,
        tokens,
      }),
    [changeMoreFacts, tokens, waits],
  );

  /**
   * Search suggestions for autocomplete (lightweight, no state changes). A failed request
   * rejects, so the caller can say that suggestions are unavailable. A request aborted through
   * `signal` rejects too.
   */
  const searchSuggest = useCallback(
    async (query: string, limit: number = 5, signal?: AbortSignal): Promise<SearchCandidate[]> => {
      // Skip if query too short
      if (!query || query.length < 2) {
        return [];
      }
      return fetchSuggestions(query, limit, signal);
    },
    [],
  );

  return useMemo(
    () => ({
      ...agentStateOf(pieces),
      analyze,
      selectCandidate,
      retry,
      moreFactoidsStream,
      searchSuggest,
      reset,
    }),
    [pieces, analyze, selectCandidate, retry, moreFactoidsStream, searchSuggest, reset],
  );
}

/**
 * useAgent Hook - Connect Frontend to Sonic Agent Backend
 *
 * Features:
 * - SSE streaming for real-time status updates
 * - Human-in-the-loop disambiguation handling
 * - An inactivity watchdog fed by the server's heartbeat events
 * - TypeScript types aligned with backend schemas
 *
 * Every analysis is a "run": its first stream, the track picker and the resume stream all
 * belong to it. Events are handled only while their stream is the run's current stream and
 * the run is the latest one, so a stale stream can never close or overwrite a newer one.
 * Each message is parsed with the contract's schema (agent/events.ts): unknown types, invalid
 * progress events, repeats, events of another run and a second `complete` of the run are
 * skipped; an outcome this page cannot read ends the run with a hint to reload the page.
 * A broken stream ends the run with an error the user can retry; it never starts the
 * analysis again by itself.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { LogCode, Factoid, FactoidUnavailableCode } from '../types';
import type { AgentLog } from '../types';
import type {
  AgentState,
  AnalyzeOptions as RequestOptions,
  PickedBy,
  ResultMode,
  UseAgentReturn,
  SearchCandidate,
} from './agent/types';
import { isLiveUnavailable } from '../liveUnavailable';
import { isWholeRecording } from '../utils/recording';
import { isSpotifyTrackId } from '../utils/spotify';
import { API_BASE_URL } from './agent/types';
import { fetchReplays, fetchSuggestions } from './agent/apiClient';
import {
  type AnalysisEvent,
  eventSchemasLoaded,
  loadEventSchemas,
  newRunEvents,
  parseAnalysisEvent,
  parseFactoidEvent,
  type RunEvents,
  streamGuard,
} from './agent/events';

// Re-export types for consumers that import from this file
export type { SearchCandidate, UseAgentReturn } from './agent/types';

/**
 * How long a stream may stay silent once its server has sent a heartbeat (every 15 s). A
 * heartbeat arrives either as a data message `{"type":"heartbeat","runId":…}` (what the API
 * sends) or as a named `heartbeat` event; both count. The watchdog arms only on the first heartbeat:
 * a server that sends none is never timed out, so a slow step is not cut off.
 */
export const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;

/**
 * The error of a run this page cannot follow: the API sent an outcome it cannot read, or the
 * code that reads the streams could not be loaded (both happen after a newer version was
 * deployed). The code is the app's own, not one the API sends.
 */
export const OUTDATED_ERROR = {
  code: 'outdated_client',
  message:
    'This page is out of date and cannot show the analysis. Reload the page, then search again.',
} as const;

/** Loads the code that reads the streams, unless it is loaded already. */
function readersReady(): Promise<void> | null {
  return eventSchemasLoaded() ? null : loadEventSchemas();
}

const INITIAL_STATE: AgentState = {
  status: 'idle',
  logs: [],
  trackData: null,
  candidates: null,
  threadId: null,
  error: null,
  errorCode: null,
  isLoading: false,
  isComplete: false,
  isReplay: false,
};

interface Run {
  query: string;
  threadId: string | null;
  candidates: SearchCandidate[] | null;
  /** How far the run got; a result or an error is final and later events are ignored. */
  phase: 'running' | 'awaiting-selection' | 'complete' | 'failed';
  /** Aborted when the run is replaced, on reset and on unmount; closes its streams. */
  controller: AbortController;
  /** The run's id and whether its result was taken, across its streams. */
  events: RunEvents;
  /** The candidate picked in the track picker, once the run resumes with it. */
  picked: SearchCandidate | null;
  /** The API said this run is a replay of a recorded run. */
  replay: boolean;
  /** A result for any other track is not shown (a recording asked for by the track's id). */
  expectedTrackId: string | null;
  /** The Spotify track the run asked for by id (a clicked suggestion), for a retry. */
  trackId: string | null;
  /** How the picker row the run asked for by id was picked, for a retry. */
  pickedBy: PickedBy | null;
}

/** How `analyze` was asked for: the request's own options, and the hook's own ones. */
interface AnalyzeOptions extends RequestOptions {
  /** A log line saying why this search started. */
  note?: string;
  /** Only a result for this track is shown. */
  expectedTrackId?: string;
}

function newRun(query: string): Run {
  return {
    query,
    threadId: null,
    candidates: null,
    phase: 'running',
    controller: new AbortController(),
    events: newRunEvents(),
    picked: null,
    replay: false,
    expectedTrackId: null,
    trackId: null,
    pickedBy: null,
  };
}

function sameCandidates(a: SearchCandidate[] | null, b: SearchCandidate[]): boolean {
  return !!a && a.length === b.length && a.every((candidate, i) => candidate.id === b[i].id);
}

/** Calls `onTimeout` after a silence, but only once a heartbeat has armed it. */
function inactivityWatchdog(onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(onTimeout, STREAM_INACTIVITY_TIMEOUT_MS);
  };
  return {
    heartbeat() {
      armed = true;
      restart();
    },
    activity() {
      if (armed) restart();
    },
    stop() {
      armed = false;
      clearTimeout(timer);
    },
  };
}

function abortError(): Error {
  return new DOMException('The stream was aborted', 'AbortError');
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgent(): UseAgentReturn {
  const [state, setState] = useState<AgentState>(INITIAL_STATE);

  // Built once: a fresh run (and AbortController) per render would be wasted.
  const [initialRun] = useState(() => newRun(''));
  const runRef = useRef<Run>(initialRun);
  // `analyze`, for the stream handlers defined before it.
  const analyzeRef = useRef<((query: string, options?: AnalyzeOptions) => Promise<void>) | null>(
    null,
  );
  // The run's open stream and the function that closes it (and stops its watchdog).
  const streamRef = useRef<{ source: EventSource; close: () => void } | null>(null);

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

  /**
   * Add a log entry with optional code and node
   */
  const addLog = useCallback((message: string, code?: LogCode, node?: string) => {
    const log: AgentLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      message,
      timestamp: new Date().toISOString(),
      code,
      node,
    };
    setState((prev) => ({
      ...prev,
      logs: [...prev.logs, log],
    }));
  }, []);

  /** Ends the run with an error the user can retry. */
  const fail = useCallback(
    (run: Run, message: string, code?: string) => {
      if (runRef.current !== run || run.phase === 'failed') return;
      run.phase = 'failed';
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: message,
        errorCode: code ?? null,
        candidates: null,
        isLoading: false,
      }));
      addLog(`Error: ${message}`, 'SYS-ERROR');
    },
    [addLog],
  );

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    runRef.current.controller.abort();
    runRef.current = newRun('');
    setState(INITIAL_STATE);
  }, []);

  /**
   * Handle one event of the run's current stream. `close` closes that stream.
   */
  const handleStreamEvent = useCallback(
    (run: Run, data: AnalysisEvent, close: () => void) => {
      // A result or an error is final. Later events change nothing; the stream is closed
      // when it ends.
      if (run.phase === 'complete' || run.phase === 'failed') {
        if (data.type === 'done' || data.type === 'error') close();
        return;
      }

      switch (data.type) {
        case 'connected':
          run.threadId = data.threadId || null;
          setState((prev) => ({
            ...prev,
            threadId: run.threadId,
          }));
          addLog('Connected to the analysis server', 'SYS-INIT');
          break;

        case 'status':
          // The API's notice that this run replays a recording: the progress that follows
          // was recorded, and the screens say so.
          if (data.node === 'replay' && !run.replay) {
            run.replay = true;
            setState((prev) => ({ ...prev, isReplay: true }));
          }
          // The server's own words, with its code; a status without words adds no line.
          if (data.message) addLog(data.message, data.code as LogCode | undefined, data.node);
          // Update status based on node
          if (data.node === 'scout') {
            setState((prev) => ({ ...prev, status: 'searching' }));
          } else if (data.node === 'engineer') {
            setState((prev) => ({ ...prev, status: 'analyzing' }));
          } else if (data.node === 'historian') {
            setState((prev) => ({ ...prev, status: 'researching' }));
          } else if (data.node === 'composer') {
            setState((prev) => ({ ...prev, status: 'composing' }));
          } else if (data.node === 'verifier') {
            setState((prev) => ({ ...prev, status: 'checking' }));
          }
          break;

        // `interrupt` (with the thread and the candidates, sent only here) opens the picker
        // once the run is paused.
        case 'interrupt': {
          const { candidates } = data;
          if (candidates.length === 0) {
            close();
            fail(run, 'No matching songs were found.');
            break;
          }
          run.threadId = data.threadId || run.threadId;
          // Keep the same list object when nothing changed, so the picker is not reset.
          if (!sameCandidates(run.candidates, candidates)) run.candidates = candidates;
          run.phase = 'awaiting-selection';
          setState((prev) => ({
            ...prev,
            status: 'disambiguation',
            threadId: run.threadId,
            candidates: run.candidates,
            isLoading: false,
          }));
          addLog('Several tracks match: waiting for you to pick one', 'SYS-WARN');
          break;
        }

        case 'complete': {
          if (run.expectedTrackId !== null && data.data?.id !== run.expectedTrackId) {
            close();
            fail(run, 'The recording found is not the track you picked, so it is not shown.');
            break;
          }
          run.phase = 'complete';
          // A whole recording, not a live run whose model answers came from stored answers.
          run.replay ||= isWholeRecording(data.data?.run);
          const replay = run.replay;
          setState((prev) => ({
            ...prev,
            status: 'complete',
            trackData: data.data,
            candidates: null,
            isLoading: false,
            isComplete: true,
            isReplay: replay,
          }));
          addLog(
            replay
              ? 'Recorded analysis replayed. Nothing was analysed live.'
              : 'Analysis complete.',
            'SYS-READY',
          );
          break;
        }

        case 'error': {
          close();
          // The pick could not resume live (the budget tripped while the picker was open, or
          // live analysis is off). When the very track picked has a recording, that recording
          // is replayed; another take with the same title and artist is not the track picked,
          // so anything else ends with the refusal.
          const picked = run.picked;
          if (picked && isLiveUnavailable(data.code) && runRef.current === run) {
            const refusal = { message: data.error || 'The analysis failed.', code: data.code };
            fetchReplays()
              .then(
                (tracks) => tracks.find((track) => track.id === picked.id) ?? null,
                () => null,
              )
              .then((recording) => {
                if (runRef.current !== run) return;
                if (!recording) {
                  fail(run, refusal.message, refusal.code);
                  return;
                }
                // The recording's own title and artist name it alone (no two recordings share
                // them); the result is still checked against the picked id.
                void analyzeRef.current?.(`${recording.title} ${recording.artist}`, {
                  note: 'Live analysis is unavailable: replaying the recording of the track you picked.',
                  trackId: picked.id,
                  expectedTrackId: picked.id,
                });
              });
            break;
          }
          fail(run, data.error || 'The analysis failed.', data.code);
          break;
        }

        case 'unreadable':
          close();
          fail(run, OUTDATED_ERROR.message, OUTDATED_ERROR.code);
          break;

        case 'done':
          close();
          // A stream that ends without a result, an error or a picker has nothing to show.
          if (run.phase === 'running') fail(run, 'The analysis ended without a result.');
          break;
      }
    },
    [addLog, fail],
  );

  /**
   * Open a stream for the run and make it the run's current stream.
   */
  const openRunStream = useCallback(
    (url: string, run: Run, onOpen?: () => void) => {
      const source = new EventSource(url);
      const isCurrent = () => runRef.current === run && streamRef.current?.source === source;
      // `seq` restarts on each stream; the run's id and result are shared by its streams.
      const accept = streamGuard(run.events);

      const close = () => {
        watchdog.stop();
        source.close();
        run.controller.signal.removeEventListener('abort', close);
        if (streamRef.current?.source === source) streamRef.current = null;
      };
      // The connection is gone: an error unless the run already has what it needs.
      const lose = (message: string) => {
        const current = isCurrent();
        close();
        if (current && run.phase === 'running') fail(run, message);
      };
      const watchdog = inactivityWatchdog(() => lose('The analysis stopped responding.'));

      run.controller.signal.addEventListener('abort', close, { once: true });
      streamRef.current = { source, close };

      source.onopen = () => {
        if (isCurrent()) onOpen?.();
      };
      // A named `heartbeat` event; the data-message form is handled in onmessage.
      source.addEventListener('heartbeat', () => {
        if (isCurrent()) watchdog.heartbeat();
        else close();
      });
      source.onmessage = (event) => {
        if (!isCurrent()) {
          close();
          return;
        }
        watchdog.activity();
        const data = parseAnalysisEvent(event.data);
        if (!data || !accept(data)) return;
        if (data.type === 'heartbeat') {
          watchdog.heartbeat();
          return;
        }
        handleStreamEvent(run, data, close);
      };
      // EventSource reconnects by itself, which would start the analysis again on the
      // server: close instead and let the user retry.
      source.onerror = () => lose('Lost the connection to the analysis.');
    },
    [fail, handleStreamEvent],
  );

  /**
   * Analyze a song with streaming
   */
  const analyze = useCallback(
    async (query: string, options: AnalyzeOptions = {}) => {
      runRef.current.controller.abort();
      const run = newRun(query);
      run.expectedTrackId = options.expectedTrackId ?? null;
      run.trackId = isSpotifyTrackId(options.trackId) ? options.trackId : null;
      run.pickedBy = run.trackId ? (options.pickedBy ?? null) : null;
      runRef.current = run;

      setState({ ...INITIAL_STATE, status: 'connecting', isLoading: true });
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

      try {
        // With a track id (a clicked suggestion) the API analyses that very track.
        // An id that is not a Spotify track id (a placeholder) is not sent: the text is searched.
        const byId = isSpotifyTrackId(options.trackId);
        const trackId = byId ? `&trackId=${encodeURIComponent(options.trackId as string)}` : '';
        const how = byId && options.pickedBy ? `&pickedBy=${options.pickedBy}` : '';
        const url = `${API_BASE_URL}/analyze/stream?query=${encodeURIComponent(query)}${trackId}${how}`;
        openRunStream(url, run, () =>
          setState((prev) =>
            prev.status === 'connecting' ? { ...prev, status: 'searching' } : prev,
          ),
        );
      } catch (error) {
        fail(run, error instanceof Error ? error.message : 'Connection failed');
      }
    },
    [addLog, fail, openRunStream],
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
      if (run.phase !== 'awaiting-selection') return;
      const candidate = run.candidates?.find((c) => c.id === candidateId);
      if (!candidate) return;

      run.phase = 'running';
      // The analysis stream has done its part; nothing it sends later may touch this run.
      streamRef.current?.close();

      if (!run.threadId) {
        // Without a thread there is nothing to resume: analyse the chosen track by its id, with
        // the text the user searched (the result says how it matches) and how the row was
        // picked, as a resume would. A row without a Spotify id cannot be asked for: searching
        // the text again would only bring the same picker back.
        if (!isSpotifyTrackId(candidate.id)) {
          fail(run, 'The track you picked could not be found again. Please search again.');
          return;
        }
        await analyze(run.query || `${candidate.title} ${candidate.artist}`, {
          trackId: candidate.id,
          ...(pickedBy ? { pickedBy } : {}),
        });
        return;
      }

      run.picked = candidate;
      addLog('Resuming the analysis with the track you picked');
      setState((prev) => ({
        ...prev,
        status: 'analyzing',
        isLoading: true,
        candidates: null,
      }));

      try {
        const how = pickedBy ? `&pickedBy=${pickedBy}` : '';
        const url = `${API_BASE_URL}/analyze/stream/resume?threadId=${encodeURIComponent(run.threadId)}&selectedTrackId=${encodeURIComponent(candidateId)}${how}`;
        openRunStream(url, run);
      } catch (error) {
        fail(run, error instanceof Error ? error.message : 'Selection failed');
      }
    },
    [addLog, analyze, fail, openRunStream],
  );

  /**
   * Run the last analysis again (the error screen's retry).
   */
  const retry = useCallback(() => {
    const { query, trackId, pickedBy } = runRef.current;
    if (query) analyze(query, trackId ? { trackId, ...(pickedBy ? { pickedBy } : {}) } : {});
  }, [analyze]);

  /**
   * Stream factoids one-by-one via SSE for faster perceived speed
   * Each factoid is emitted immediately when generated
   */
  const decryptMoreFactoidsStream = useCallback(
    (
      trackTitle: string,
      trackArtist: string,
      existingIds: string[],
      onFactoid: (factoid: Factoid) => void,
      signal?: AbortSignal,
      onUnavailable?: (code: FactoidUnavailableCode) => void,
      resultMode?: ResultMode,
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        // A new analysis or a reset ends the stream, as does the caller's signal.
        const runSignal = runRef.current.controller.signal;
        if (runSignal.aborted || signal?.aborted) {
          reject(abortError());
          return;
        }

        const open = () => {
          const params = new URLSearchParams({
            trackTitle,
            trackArtist: trackArtist || '',
            existingIds: existingIds.join(','),
            // More of a replayed result comes only from its recording, and more of a live
            // result never does (the API decides by this, not by what it allows right now).
            ...(resultMode ? { mode: resultMode } : {}),
          });

          const url = `${API_BASE_URL}/factoids/decrypt/stream?${params}`;
          const eventSource = new EventSource(url);
          const accept = streamGuard(newRunEvents());
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
          const watchdog = inactivityWatchdog(() => {
            stop();
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
              case 'factoid':
                // Emit factoid immediately to callback
                onFactoid(data.data as Factoid);
                break;

              case 'heartbeat':
                watchdog.heartbeat();
                break;

              case 'done':
                stop();
                resolve();
                break;

              case 'error':
                // The rate limit, a paused budget, live calls switched off and a recording no
                // longer served are reported to the caller, which shows them; other failures
                // are logged. Either way the stream goes on (one failed fact does not fail the
                // others).
                if (
                  data.code === 'rate_limited' ||
                  data.code === 'budget_exhausted' ||
                  data.code === 'live_disabled' ||
                  data.code === 'not_found'
                ) {
                  onUnavailable?.(data.code);
                } else {
                  console.warn('[useAgent] Factoid stream error:', data.error);
                }
                break;
            }
          };

          eventSource.onerror = () => {
            stop();
            reject(new Error('Factoid stream connection failed'));
          };
        };

        // The stream is opened once the code that reads it is loaded.
        const ready = readersReady();
        if (!ready) {
          open();
          return;
        }
        ready.then(
          () => {
            if (runSignal.aborted || signal?.aborted) reject(abortError());
            else open();
          },
          (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      });
    },
    [],
  );

  /**
   * Search suggestions for autocomplete (lightweight, no state changes). A failed request
   * rejects, so the caller can say that suggestions are unavailable.
   */
  const searchSuggest = useCallback(
    async (query: string, limit: number = 5): Promise<SearchCandidate[]> => {
      // Skip if query too short
      if (!query || query.length < 2) {
        return [];
      }
      return fetchSuggestions(query, limit);
    },
    [],
  );

  return useMemo(
    () => ({
      ...state,
      analyze,
      selectCandidate,
      retry,
      decryptMoreFactoidsStream,
      searchSuggest,
      reset,
    }),
    [state, analyze, selectCandidate, retry, decryptMoreFactoidsStream, searchSuggest, reset],
  );
}

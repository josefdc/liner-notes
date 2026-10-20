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
 * A broken stream ends the run with an error the user can retry; it never starts the
 * analysis again by itself.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { LogCode, Factoid } from '../types';
import type { AgentLog } from '../types';
import type { AgentState, AgentStreamEvent, UseAgentReturn, SearchCandidate } from './agent/types';
import { API_BASE_URL } from './agent/types';
import { fetchSuggestions } from './agent/apiClient';

// Re-export types for consumers that import from this file
export type { SearchCandidate, UseAgentReturn } from './agent/types';

/**
 * How long a stream may stay silent once its server has sent a heartbeat (every 15 s). A
 * heartbeat arrives either as a data message `{"type":"heartbeat"}` (what the API sends) or
 * as a named `heartbeat` event; both count. The watchdog arms only on the first heartbeat:
 * a server that sends none is never timed out, so a slow step is not cut off.
 */
export const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;

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
};

interface Run {
  query: string;
  threadId: string | null;
  candidates: SearchCandidate[] | null;
  /** How far the run got; a result or an error is final and later events are ignored. */
  phase: 'running' | 'awaiting-selection' | 'complete' | 'failed';
  /** Aborted when the run is replaced, on reset and on unmount; closes its streams. */
  controller: AbortController;
}

function newRun(query: string): Run {
  return {
    query,
    threadId: null,
    candidates: null,
    phase: 'running',
    controller: new AbortController(),
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
  // The run's open stream and the function that closes it (and stops its watchdog).
  const streamRef = useRef<{ source: EventSource; close: () => void } | null>(null);

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
    (run: Run, data: AgentStreamEvent, close: () => void) => {
      // A result or an error is final. Later events (the server repeats `complete` for
      // the thread) change nothing; the stream is closed when it ends.
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
          addLog('Connected to agent', 'SYS-INIT');
          break;

        case 'status':
          // Pass the code from the backend event
          addLog(data.message || 'Processing...', data.code as LogCode | undefined, data.node);
          // Update status based on node
          if (data.node === 'scout') {
            setState((prev) => ({ ...prev, status: 'searching' }));
          } else if (data.node === 'engineer') {
            setState((prev) => ({ ...prev, status: 'analyzing' }));
          } else if (data.node === 'historian') {
            setState((prev) => ({ ...prev, status: 'researching' }));
          } else if (data.node === 'composer') {
            setState((prev) => ({ ...prev, status: 'composing' }));
          }
          break;

        // `interrupt` (with the thread and the candidates) opens the picker once the run is
        // paused. Servers from before the interrupt-only protocol also send `candidates`
        // first; both describe the same choice.
        case 'candidates':
        case 'interrupt': {
          const candidates = data.candidates ?? run.candidates ?? [];
          if (candidates.length === 0) {
            close();
            fail(run, 'No matching songs were found.');
            break;
          }
          if (data.threadId) run.threadId = data.threadId;
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
          addLog(
            data.type === 'candidates'
              ? `Found ${candidates.length} matching songs`
              : 'Awaiting user selection...',
            'SYS-WARN',
          );
          break;
        }

        case 'complete':
          if (!data.data) {
            close();
            fail(run, 'The analysis finished without a result.');
            break;
          }
          run.phase = 'complete';
          setState((prev) => ({
            ...prev,
            status: 'complete',
            trackData: data.data ?? null,
            candidates: null,
            isLoading: false,
            isComplete: true,
          }));
          addLog('Analysis complete. Ready for deployment.', 'SYS-READY');
          break;

        case 'error':
          close();
          fail(run, data.error || 'The analysis failed.', data.code);
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
        let data: AgentStreamEvent;
        try {
          data = JSON.parse(event.data);
        } catch (e) {
          console.error('[useAgent] Failed to parse SSE event:', e);
          return;
        }
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
    async (query: string) => {
      runRef.current.controller.abort();
      const run = newRun(query);
      runRef.current = run;

      setState({ ...INITIAL_STATE, status: 'connecting', isLoading: true });
      addLog(`🔍 Searching for "${query}"...`);

      try {
        const url = `${API_BASE_URL}/api/analyze/stream?query=${encodeURIComponent(query)}`;
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

  /**
   * Select a candidate after disambiguation. Only the first selection for a picker counts.
   */
  const selectCandidate = useCallback(
    async (candidateId: string) => {
      const run = runRef.current;
      if (run.phase !== 'awaiting-selection') return;
      const candidate = run.candidates?.find((c) => c.id === candidateId);
      if (!candidate) return;

      run.phase = 'running';
      // The analysis stream has done its part; nothing it sends later may touch this run.
      streamRef.current?.close();

      if (!run.threadId) {
        // Without a thread there is nothing to resume: search for the chosen track instead.
        await analyze(`${candidate.title} ${candidate.artist}`);
        return;
      }

      addLog(`🎵 Resuming with selected track...`);
      setState((prev) => ({
        ...prev,
        status: 'analyzing',
        isLoading: true,
        candidates: null,
      }));

      try {
        const url = `${API_BASE_URL}/api/analyze/stream/resume?threadId=${encodeURIComponent(run.threadId)}&selectedTrackId=${encodeURIComponent(candidateId)}`;
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
    const { query } = runRef.current;
    if (query) analyze(query);
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
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        // A new analysis or a reset ends the stream, as does the caller's signal.
        const runSignal = runRef.current.controller.signal;
        if (runSignal.aborted || signal?.aborted) {
          reject(abortError());
          return;
        }

        const params = new URLSearchParams({
          trackTitle,
          trackArtist: trackArtist || '',
          existingIds: existingIds.join(','),
        });

        const url = `${API_BASE_URL}/api/factoids/decrypt/stream?${params}`;
        const eventSource = new EventSource(url);
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
          try {
            const data = JSON.parse(event.data);

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
                console.warn('[useAgent] Factoid stream error:', data.error);
                // Continue - don't fail the whole stream for one error
                break;
            }
          } catch (e) {
            console.error('[useAgent] Failed to parse factoid event:', e);
          }
        };

        eventSource.onerror = () => {
          stop();
          reject(new Error('Factoid stream connection failed'));
        };
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

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
import type {
  AgentState,
  AgentStatus,
  AnalyzeOptions as RequestOptions,
  PickedBy,
  ResultMode,
  UseAgentReturn,
  SearchCandidate,
} from './agent/types';
import { isLiveUnavailable } from '../liveUnavailable';
import { isWholeRecording } from '../utils/recording';
import { isSpotifyTrackId } from '../utils/spotify';
import { pickerQuestion, pickerRows } from '../components/search/pickerRows';
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
import { appendLog, type NewLog } from './agent/runLog';

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

/**
 * Codes for the failures this hook raises itself, so the page can explain each one. They are the
 * app's own, not codes the API sends (`no_match` has the same meaning as the API's).
 */
export const CLIENT_ERROR_CODES = {
  noMatch: 'no_match',
  wrongTrack: 'wrong_track',
  noResult: 'no_result',
  streamStalled: 'stream_stalled',
  connectionLost: 'connection_lost',
  choiceLost: 'choice_lost',
  // The stream could not be opened (the exception's own text is kept in `error`, never shown).
  streamOpenFailed: 'stream_open_failed',
  resumeFailed: 'resume_failed',
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
  statusNote: null,
};

// The order of a run's steps. A step reported after a later one does not move the run back.
// The engineer measures beside the historian's research (the historian reports first), so
// `measuring` ranks with `researching`; the engineer's other lines are the `analyzing` step.
const STEP_ORDER: Partial<Record<AgentStatus, number>> = {
  connecting: 0,
  searching: 1,
  disambiguation: 1,
  analyzing: 2,
  measuring: 3,
  researching: 3,
  composing: 4,
  checking: 5,
};

interface Step {
  status: AgentStatus;
  /**
   * The server's own words for the step, when they say more than the status; null clears them,
   * and undefined keeps those already shown for the same step (the composer's fallback stays
   * through its later lines).
   */
  note?: string | null;
  /** The measurement ended: the run leaves `measuring` even for a lower step. */
  ended?: boolean;
}

/** The state after the server reports a step. */
function toStep(prev: AgentState, { status, note, ended }: Step): AgentState {
  const from = STEP_ORDER[prev.status];
  const to = STEP_ORDER[status];
  const leaving = ended && prev.status === 'measuring';
  if (!leaving && from !== undefined && to !== undefined && to < from) return prev;
  const statusNote =
    note === undefined && prev.status === status ? prev.statusNote : (note ?? null);
  if (prev.status === status && prev.statusNote === statusNote) return prev;
  return { ...prev, status, statusNote };
}

/** What the engineer and the historian, which run side by side, have said so far in a run. */
interface Branches {
  researched: boolean;
  /** The historian's words for its research ("Using the research stored by an earlier run"). */
  researchNote: string | null;
  measuring: boolean;
}

const newBranches = (): Branches => ({ researched: false, researchNote: null, measuring: false });

/** The step a status event moves the run to, if any; `branches` keeps what it says. */
function stepOf(
  branches: Branches,
  node: string | undefined,
  code: string | undefined,
  message: string,
): Step | null {
  switch (node) {
    case 'scout':
      return { status: 'searching', note: null };
    case 'historian':
      branches.researched = true;
      if (code === 'RESEARCH-FOUND' && message) branches.researchNote = message;
      // A measurement under way stays on screen until it ends.
      if (branches.measuring) return null;
      return { status: 'researching', note: branches.researchNote };
    case 'engineer': {
      // Measuring only while a measurement runs: a cache hit or a result line is not one.
      if (code === 'AUDIO-INIT') {
        branches.measuring = true;
        return { status: 'measuring', note: null };
      }
      const ended = branches.measuring;
      branches.measuring = false;
      // The measurement is over: what is left is the research beside it, which has started
      // with the measurement even when it has not reported yet. Never back to reading the audio.
      return branches.researched || ended
        ? { status: 'researching', note: branches.researchNote, ended }
        : { status: 'analyzing', note: null, ended };
    }
    case 'composer':
      branches.measuring = false;
      // The composer's fallback says in its own words that no notes are written.
      return {
        status: 'composing',
        note: code?.endsWith('-ERROR') && message ? message : undefined,
      };
    case 'verifier':
      // Its model lines are the check; its other lines (a cover-art lookup) are not.
      return code?.startsWith('LLM-') || code?.startsWith('VERIFY-')
        ? { status: 'checking', note: null }
        : null;
    default:
      return null;
  }
}

// What the progress line says right after a pick, while the server reads the chosen track.
const RESUME_NOTE = 'Reading the track you selected...';

// The picker line when the server sends no words of its own.
const PICK_FALLBACK = 'Pick the track to analyze';

interface Run {
  query: string;
  /** What the engineer and the historian have said so far. */
  branches: Branches;
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
    branches: newBranches(),
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
    const log: NewLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      message,
      timestamp: new Date().toISOString(),
      code,
      node,
    };
    // Bounded, and a repeat of the last line changes nothing (agent/runLog.ts).
    setState((prev) => {
      const logs = appendLog(prev.logs, log);
      return logs === prev.logs ? prev : { ...prev, logs };
    });
  }, []);

  /** Ends the run with an error the user can retry. */
  const fail = useCallback(
    (run: Run, message: string, code?: string) => {
      if (runRef.current !== run || run.phase === 'failed') return;
      run.phase = 'failed';
      setState((prev) => ({
        ...prev,
        status: 'error',
        statusNote: null,
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
          {
            const step = stepOf(run.branches, data.node, data.code, data.message);
            if (step) setState((prev) => toStep(prev, step));
          }
          break;

        // `interrupt` (with the thread and the candidates, sent only here) opens the picker
        // once the run is paused.
        case 'interrupt': {
          const { candidates } = data;
          if (candidates.length === 0) {
            close();
            fail(run, 'No matching songs were found.', CLIENT_ERROR_CODES.noMatch);
            break;
          }
          run.threadId = data.threadId || run.threadId;
          // Keep the same list object when nothing changed, so the picker is not reset.
          if (!sameCandidates(run.candidates, candidates)) run.candidates = candidates;
          run.phase = 'awaiting-selection';
          // The server counts the candidates it sent ("One possible track…"): its words are the
          // line, unless the picker shows another number of rows, for any reason (a candidate
          // this page could not read; rows of one recording that pickerRows merges, a guard
          // for a server that does not), when the line counts the rows shown.
          const shown = pickerRows(candidates).length;
          const question =
            shown === data.sentCount ? data.message || PICK_FALLBACK : pickerQuestion(shown);
          setState((prev) => ({
            ...prev,
            status: 'disambiguation',
            statusNote: question,
            threadId: run.threadId,
            candidates: run.candidates,
            isLoading: false,
          }));
          addLog(question, undefined, 'scout');
          break;
        }

        case 'complete': {
          if (run.expectedTrackId !== null && data.data?.id !== run.expectedTrackId) {
            close();
            fail(
              run,
              'The recording found is not the track you picked, so it is not shown.',
              CLIENT_ERROR_CODES.wrongTrack,
            );
            break;
          }
          run.phase = 'complete';
          // A whole recording, not a live run whose model answers came from stored answers.
          run.replay ||= isWholeRecording(data.data?.run);
          const replay = run.replay;
          setState((prev) => ({
            ...prev,
            status: 'complete',
            statusNote: null,
            trackData: data.data,
            candidates: null,
            isLoading: false,
            isComplete: true,
            isReplay: replay,
          }));
          addLog(
            replay
              ? 'Recorded analysis replayed. Nothing was analyzed live.'
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
                  note: 'Live analysis is unavailable: replaying the recording of the selected track.',
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
          if (run.phase === 'running')
            fail(run, 'The analysis ended without a result.', CLIENT_ERROR_CODES.noResult);
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
      const lose = (message: string, code: string) => {
        const current = isCurrent();
        close();
        if (current && run.phase === 'running') fail(run, message, code);
      };
      const watchdog = inactivityWatchdog(() =>
        lose('The analysis stopped responding.', CLIENT_ERROR_CODES.streamStalled),
      );

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
      source.onerror = () =>
        lose('Lost the connection to the analysis.', CLIENT_ERROR_CODES.connectionLost);
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
        fail(
          run,
          error instanceof Error ? error.message : 'Connection failed',
          CLIENT_ERROR_CODES.streamOpenFailed,
        );
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

      run.picked = candidate;
      // The user picked it: the picker waits for the user ("countdown" picks exist only in older
      // recordings).
      addLog('Resuming the analysis with the selected track');
      setState((prev) => ({
        ...prev,
        status: 'analyzing',
        statusNote: RESUME_NOTE,
        isLoading: true,
        candidates: null,
      }));

      try {
        const how = pickedBy ? `&pickedBy=${pickedBy}` : '';
        const url = `${API_BASE_URL}/analyze/stream/resume?threadId=${encodeURIComponent(run.threadId)}&selectedTrackId=${encodeURIComponent(candidateId)}${how}`;
        openRunStream(url, run);
      } catch (error) {
        fail(
          run,
          error instanceof Error ? error.message : 'Selection failed',
          CLIENT_ERROR_CODES.resumeFailed,
        );
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

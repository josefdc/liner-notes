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
import type { LogCode, Factoid, TrackData } from '../types';
import type {
  AgentState,
  AgentStatus,
  AnalyzeOptions as RequestOptions,
  MoreFacts,
  MoreFactsOptions,
  PickedBy,
  UseAgentReturn,
  SearchCandidate,
} from './agent/types';
import { isLiveUnavailable } from '../liveUnavailable';
import { isWholeRecording } from '../utils/recording';
import { isSpotifyTrackId } from '../utils/spotify';
import { pickerQuestion, pickerRows } from '../components/search/pickerRows';
import { API_BASE_URL } from './agent/types';
import { fetchReplays, fetchSuggestions, type RunToken, RunTokenError } from './agent/apiClient';
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
import {
  type MoreFactsAnswer,
  moreFactsOf,
  moreFactsUrl,
  withAnswer,
  withFact,
  withFailure,
} from './agent/moreFacts';
import { appendLog, type NewLog } from './agent/runLog';
import { isUsable, newRunToken, withRunToken } from './agent/runToken';

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
  // The server answered the stream's request with an error status (an EventSource cannot read
  // which): a run token it refused, most often. A retry asks for a new one.
  streamRefused: 'stream_refused',
  // This build has a Turnstile site key but cannot show the check yet: no request can start.
  verificationUnavailable: 'verification_unavailable',
} as const;

/**
 * A signal that aborts once `a` or `b` does: AbortSignal.any where the browser has it, else one
 * controller listening to both (Safari before 17.4, Chrome before 116, Firefox before 124).
 */
export function eitherSignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    abort();
  } else {
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

/** EventSource.CLOSED: the browser has given the stream up and will not reconnect. */
const EVENT_SOURCE_CLOSED = 2;

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
  moreFacts: null,
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
  /** The run token the run started with; its resume sends it again. */
  token: RunToken | null;
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
    token: null,
  };
}

/**
 * Why a run token could not be had, as an error the run ends with: the API's refusal (its code
 * and message), an answer this page cannot read (`unreadableCode`), or no answer at all (the
 * connection failed).
 */
function tokenFailure(error: unknown, unreadableCode: string): { message: string; code: string } {
  if (error instanceof RunTokenError) {
    return { message: error.message, code: error.code ?? unreadableCode };
  }
  return {
    message: error instanceof Error ? error.message : 'Connection failed',
    code: CLIENT_ERROR_CODES.connectionLost,
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
  // `moreFacts` as last set, for the next request (its round) before the state is rendered.
  const moreFactsRef = useRef<MoreFacts | null>(null);
  // The latest run token this page was given: factoid requests send it again until it expires.
  const tokenRef = useRef<RunToken | null>(null);
  /**
   * Stops sending `token` again once the API refused it (or a stream sent with it failed): the
   * next request that needs one asks for a new one, once. No request is retried here.
   */
  const dropToken = useCallback((token: RunToken | null) => {
    if (token && tokenRef.current === token) tokenRef.current = null;
  }, []);

  const setMoreFacts = useCallback((moreFacts: MoreFacts | null) => {
    moreFactsRef.current = moreFacts;
    setState((prev) => (prev.moreFacts === moreFacts ? prev : { ...prev, moreFacts }));
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

  /**
   * Add a log entry with optional code and node, and the time since the run started that the
   * server sent it with
   */
  const addLog = useCallback(
    (message: string, code?: LogCode, node?: string, elapsedMs?: number) => {
      const log: NewLog = {
        id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        message,
        timestamp: new Date().toISOString(),
        code,
        node,
        ...(elapsedMs !== undefined && { elapsedMs }),
      };
      // Bounded, and a repeat of the last line changes nothing (agent/runLog.ts).
      setState((prev) => {
        const logs = appendLog(prev.logs, log);
        return logs === prev.logs ? prev : { ...prev, logs };
      });
    },
    [],
  );

  /**
   * Ends the run with an error the user can retry. `elapsedMs`: the time since the run started
   * that the server's event the error comes from was sent with, when it sent one.
   */
  const fail = useCallback(
    (run: Run, message: string, code?: string, elapsedMs?: number) => {
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
      addLog(`Error: ${message}`, 'SYS-ERROR', undefined, elapsedMs);
    },
    [addLog],
  );

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    runRef.current.controller.abort();
    runRef.current = newRun('');
    moreFactsRef.current = null;
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
          addLog('Connected to the analysis server', 'SYS-INIT', undefined, data.elapsedMs);
          break;

        case 'status':
          // The API's notice that this run replays a recording: the progress that follows
          // was recorded, and the screens say so.
          if (data.node === 'replay' && !run.replay) {
            run.replay = true;
            setState((prev) => ({ ...prev, isReplay: true }));
          }
          // The server's own words, with its code and the time since the run started (a
          // replay's is the recorded run's), as on every line a server event writes; a status
          // without words adds no line.
          if (data.message) {
            addLog(data.message, data.code as LogCode | undefined, data.node, data.elapsedMs);
          }
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
          // line, unless the picker shows another number of rows (a candidate this page could
          // not read, a track id sent twice), when the line counts the rows shown.
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
          addLog(question, undefined, 'scout', data.elapsedMs);
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
            undefined,
            data.elapsedMs,
          );
          break;
        }

        case 'error': {
          close();
          // The API refused the run's token: it is not sent again (a retry asks for a new one).
          if (data.code === 'auth_expired') dropToken(run.token);
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
          fail(run, data.error || 'The analysis failed.', data.code, data.elapsedMs);
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
            fail(
              run,
              'The analysis ended without a result.',
              CLIENT_ERROR_CODES.noResult,
              data.elapsedMs,
            );
          break;
      }
    },
    [addLog, dropToken, fail],
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

      let opened = false;
      source.onopen = () => {
        opened = true;
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
      // server: close instead and let the user retry. A stream closed before it opened was
      // answered with an error status (the browser gives up at once): the API refused the
      // request, most often its run token, which is not sent again.
      source.onerror = () => {
        if (!opened && source.readyState === EVENT_SOURCE_CLOSED) {
          dropToken(run.token);
          lose('The analysis server did not accept the request.', CLIENT_ERROR_CODES.streamRefused);
          return;
        }
        lose('Lost the connection to the analysis.', CLIENT_ERROR_CODES.connectionLost);
      };
    },
    [dropToken, fail, handleStreamEvent],
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
      moreFactsRef.current = null;

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

      // Every analysis starts with a token of its own (agent/runToken.ts).
      try {
        run.token = await newRunToken(run.controller.signal);
      } catch (error) {
        if (runRef.current !== run) return;
        const { message, code } = tokenFailure(error, CLIENT_ERROR_CODES.streamOpenFailed);
        fail(run, message, code);
        return;
      }
      if (runRef.current !== run) return;
      tokenRef.current = run.token;

      try {
        // With a track id (a clicked suggestion) the API analyses that very track.
        // An id that is not a Spotify track id (a placeholder) is not sent: the text is searched.
        const byId = isSpotifyTrackId(options.trackId);
        const trackId = byId ? `&trackId=${encodeURIComponent(options.trackId as string)}` : '';
        const how = byId && options.pickedBy ? `&pickedBy=${options.pickedBy}` : '';
        const url = withRunToken(
          `${API_BASE_URL}/analyze/stream?query=${encodeURIComponent(query)}${trackId}${how}`,
          run.token,
        );
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
        // The run's own token: only the token a run started with resumes it. One that has
        // expired is sent all the same, and the API says so in the stream.
        if (!run.token) throw new Error('The run has no run token');
        const how = pickedBy ? `&pickedBy=${pickedBy}` : '';
        const url = withRunToken(
          `${API_BASE_URL}/analyze/stream/resume?threadId=${encodeURIComponent(run.threadId)}&selectedTrackId=${encodeURIComponent(candidateId)}${how}`,
          run.token,
        );
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
   * "More facts" about a result: the next round of the factoid stream (agent/moreFacts.ts), asked
   * for with the result's own run id and the round the last answer named. The facts and their
   * claims are kept in `moreFacts` as they come, each once by id, and the promise resolves with
   * the facts this answer added. Once every round has been asked no request is made, and it
   * resolves with none. A fact that could not be written is kept in `moreFacts.failed` by its
   * index; the other facts of the answer are kept.
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
  const moreFactoidsStream = useCallback(
    (result: TrackData, { signal, onUnavailable }: MoreFactsOptions = {}): Promise<Factoid[]> => {
      return new Promise((resolve, reject) => {
        // A new analysis or a reset ends the stream, as does the caller's signal.
        const runSignal = runRef.current.controller.signal;
        if (runSignal.aborted || signal?.aborted) {
          reject(abortError());
          return;
        }
        if (moreFactsOf(result, moreFactsRef.current).finished) {
          resolve([]);
          return;
        }

        const open = (token: RunToken) => {
          // What this result already has; another result's facts are let go.
          const before = moreFactsOf(result, moreFactsRef.current);
          const url = moreFactsUrl(result, before, token);
          setMoreFacts({ ...before, failed: [], answerFailed: false });

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
          const update = (change: (moreFacts: MoreFacts) => MoreFacts) =>
            setMoreFacts(change(moreFactsOf(result, moreFactsRef.current)));
          // The answer failed as a whole: the Player says so, and the round is asked again.
          const answerFailed = () => update((moreFacts) => ({ ...moreFacts, answerFailed: true }));
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
                const kept = moreFactsOf(result, moreFactsRef.current);
                const next = withFact(kept, factoid, data.claim);
                answer.facts++;
                // A fact already kept (by id) is not added again.
                if (next.factoids !== kept.factoids) added.push(factoid);
                setMoreFacts(next);
                break;
              }

              case 'heartbeat':
                watchdog.heartbeat();
                break;

              case 'done':
                stop();
                update((moreFacts) => withAnswer(moreFacts, { ...answer, runId: events.runId }));
                resolve(added);
                break;

              case 'error':
                // One fact that failed (an index) is kept as failed; the stream goes on, and
                // the other facts are kept. The rate limit, a paused budget, live calls switched
                // off and a recording no longer served are also reported to the caller, which
                // says why; other failures of the whole request are logged. Either way the
                // answer did not write what it asked for, so its round is asked again.
                if (data.index !== undefined) {
                  const failure = { index: data.index, code: data.code };
                  answer.failed++;
                  update((moreFacts) => withFailure(moreFacts, failure));
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
                  if (data.code === 'auth_expired') dropToken(token);
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
            dropToken(token);
            reject(new Error('Factoid stream connection failed'));
          };
        };

        // The stream is opened once the code that reads it is loaded, with the latest run token
        // while it may still be sent, or else a new one.
        const held = tokenRef.current;
        let tokenFailed = false;
        const token = isUsable(held)
          ? held
          : newRunToken(eitherSignal(runSignal, signal)).then(
              (fresh) => {
                tokenRef.current = fresh;
                return fresh;
              },
              (error: unknown) => {
                tokenFailed = true;
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
            if (tokenFailed) {
              const kept = moreFactsOf(result, moreFactsRef.current);
              setMoreFacts({ ...kept, failed: [], answerFailed: true });
            }
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    [dropToken, setMoreFacts],
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
      moreFactoidsStream,
      searchSuggest,
      reset,
    }),
    [state, analyze, selectCandidate, retry, moreFactoidsStream, searchSuggest, reset],
  );
}

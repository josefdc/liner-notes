/**
 * What each event of a run's analysis or resume stream does to the run: its lifecycle
 * (run.ts), what the hook shows (state.ts) and its log. A result or an error is final; a pick
 * whose resume was refused for live calls replays the recording of the very track picked, when
 * there is one.
 */

import { pickerQuestion, pickerRows } from '../../components/search/pickerRows';
import { isLiveUnavailable } from '../../liveUnavailable';
import type { LogCode } from '../../types';
import { isWholeRecording } from '../../utils/recording';
import { fetchReplays, type RunToken } from './apiClient';
import type { AnalysisEvent } from './events';
import { CLIENT_ERROR_CODES, OUTDATED_ERROR } from './failure';
import { PICK_FALLBACK, reportStep } from './progress';
import { advance, type Run } from './run';
import type { AgentAction } from './state';
import type { AnalyzeOptions } from './types';

export interface RunEventContext {
  dispatch: (action: AgentAction) => void;
  /** Adds a line to the run's log, with the time since the run started it was sent with. */
  log: (message: string, code?: LogCode, node?: string, elapsedMs?: number) => void;
  /** Ends the run with an error the user can retry (the hook's `fail`). */
  fail: (
    run: Run,
    message: string,
    code?: string,
    elapsedMs?: number,
    retryAfterMs?: number,
  ) => void;
  /** True while `run` is the latest run. */
  isLatest: (run: Run) => boolean;
  /** Stops sending a run token the API refused. */
  dropToken: (token: RunToken | null) => void;
  /** Starts a new analysis (the hook's `analyze`). */
  analyze: (
    query: string,
    options: AnalyzeOptions & { note?: string; expectedTrackId?: string },
  ) => unknown;
}

/** Handles one event of the run's current stream. `close` closes that stream. */
export function handleRunEvent(
  run: Run,
  data: AnalysisEvent,
  close: () => void,
  { dispatch, log, fail, isLatest, dropToken, analyze }: RunEventContext,
): void {
  // A result or an error is final. Later events change nothing; the stream is closed
  // when it ends.
  if (run.life.phase === 'complete' || run.life.phase === 'failed') {
    if (data.type === 'done' || data.type === 'error') close();
    return;
  }

  switch (data.type) {
    case 'connected':
      advance(run, { type: 'connected', threadId: data.threadId });
      log('Connected to the analysis server', 'SYS-INIT', undefined, data.elapsedMs);
      break;

    case 'status': {
      // The API's notice that this run replays a recording: the progress that follows
      // was recorded, and the screens say so.
      if (data.node === 'replay' && !run.life.replay) {
        advance(run, { type: 'replayNoticed' });
        dispatch({ type: 'replayNoticed' });
      }
      // The server's own words, with its code and the time since the run started (a
      // replay's is the recorded run's), as on every line a server event writes; a status
      // without words adds no line.
      if (data.message) {
        log(data.message, data.code as LogCode | undefined, data.node, data.elapsedMs);
      }
      const { branches, step } = reportStep(run.life.branches, data.node, data.code, data.message);
      advance(run, { type: 'branchesChanged', branches });
      if (step) dispatch({ type: 'stepReported', step });
      break;
    }

    // `interrupt` (with the thread and the candidates, sent only here) opens the picker
    // once the run is paused.
    case 'interrupt': {
      const { candidates } = data;
      if (candidates.length === 0) {
        close();
        fail(run, 'No matching songs were found.', CLIENT_ERROR_CODES.noMatch);
        break;
      }
      advance(run, { type: 'pickerOpened', threadId: data.threadId, candidates });
      // The server counts the candidates it sent ("One possible track…"): its words are the
      // line, unless the picker shows another number of rows (a candidate this page could
      // not read, a track id sent twice), when the line counts the rows shown.
      const shown = pickerRows(candidates).length;
      const question =
        shown === data.sentCount ? data.message || PICK_FALLBACK : pickerQuestion(shown);
      dispatch({
        type: 'pickerOpened',
        candidates: run.life.candidates ?? candidates,
        question,
      });
      log(question, undefined, 'scout', data.elapsedMs);
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
      advance(run, { type: 'completed', wholeRecording: isWholeRecording(data.data?.run) });
      const replay = run.life.replay;
      dispatch({ type: 'completed', trackData: data.data, replay });
      log(
        replay ? 'Recorded analysis replayed. Nothing was analyzed live.' : 'Analysis complete.',
        'SYS-READY',
        undefined,
        data.elapsedMs,
      );
      break;
    }

    case 'error': {
      close();
      // The API refused the run's token: it is not sent again (a retry asks for a new one).
      if (data.code === 'auth_expired') dropToken(run.life.token);
      // The pick could not resume live (the budget tripped while the picker was open, or
      // live analysis is off). When the very track picked has a recording, that recording
      // is replayed; another take with the same title and artist is not the track picked,
      // so anything else ends with the refusal.
      const picked = run.life.picked;
      if (picked && isLiveUnavailable(data.code) && isLatest(run)) {
        const refusal = { message: data.error || 'The analysis failed.', code: data.code };
        fetchReplays()
          .then(
            (tracks) => tracks.find((track) => track.id === picked.id) ?? null,
            () => null,
          )
          .then((recording) => {
            if (!isLatest(run)) return;
            if (!recording) {
              fail(run, refusal.message, refusal.code);
              return;
            }
            // The recording's own title and artist name it alone (no two recordings share
            // them); the result is still checked against the picked id.
            void analyze(`${recording.title} ${recording.artist}`, {
              note: 'Live analysis is unavailable: replaying the recording of the selected track.',
              trackId: picked.id,
              expectedTrackId: picked.id,
            });
          });
        break;
      }
      fail(run, data.error || 'The analysis failed.', data.code, data.elapsedMs, data.retryAfterMs);
      break;
    }

    case 'unreadable':
      close();
      fail(run, OUTDATED_ERROR.message, OUTDATED_ERROR.code);
      break;

    case 'done':
      close();
      // A stream that ends without a result, an error or a picker has nothing to show.
      if (run.life.phase === 'running')
        fail(
          run,
          'The analysis ended without a result.',
          CLIENT_ERROR_CODES.noResult,
          data.elapsedMs,
        );
      break;
  }
}

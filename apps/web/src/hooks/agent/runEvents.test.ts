import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisEvent } from './events';
import { CLIENT_ERROR_CODES, OUTDATED_ERROR } from './failure';
import { advance, newRun, type Run } from './run';
import { handleRunEvent } from './runEvents';
import { newLog } from './runLog';
import { agentReducer, agentStateOf, INITIAL_PIECES } from './state';

const candidates = [
  { id: 'c1', title: 'Hurt', artist: 'Johnny Cash', album: 'A', coverUrl: '' },
  { id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails', album: 'B', coverUrl: '' },
];
const track = { id: 'c2', title: 'Hurt', artist: 'NIN', album: 'B', coverUrl: '' };
const token = { runToken: 'token-1', expiresAt: 1 };
const envelope = { runId: 't1', seq: 0 };
const event = (data: Record<string, unknown>) => ({ ...envelope, ...data }) as AnalysisEvent;

/**
 * A page that follows one run as the hook does: every action goes through the hook's reducers,
 * and `fail` ends the run as the hook's own does (without its wait, which failure.ts covers).
 * `send` hands it an event; the test then reads the state the page would show.
 */
function page(run: Run = newRun('Hurt')) {
  let pieces = agentReducer(INITIAL_PIECES, { type: 'started' });
  let closed = false;
  const failures: Array<{ closedFirst: boolean; elapsedMs?: number; retryAfterMs?: number }> = [];
  const dropped: unknown[] = [];
  const analyzed: unknown[] = [];
  const context = {
    dispatch: (action: Parameters<typeof agentReducer>[1]) => {
      pieces = agentReducer(pieces, action);
    },
    log: (
      message: string,
      code?: Parameters<typeof newLog>[1],
      node?: string,
      elapsedMs?: number,
    ) => context.dispatch({ type: 'logged', log: newLog(message, code, node, elapsedMs) }),
    fail: (
      failed: Run,
      message: string,
      code?: string,
      elapsedMs?: number,
      retryAfterMs?: number,
    ) => {
      if (failed.life.phase === 'failed') return;
      failures.push({ closedFirst: closed, elapsedMs, retryAfterMs });
      advance(failed, { type: 'failed' });
      context.dispatch({ type: 'failed', message, code: code ?? null, retryAt: null });
      context.log(`Error: ${message}`, 'SYS-ERROR', undefined, elapsedMs);
    },
    isLatest: () => true,
    dropToken: (dropped_: unknown) => dropped.push(dropped_),
    analyze: (query: string, options: unknown) => analyzed.push({ query, options }),
  };
  return {
    run,
    send(data: AnalysisEvent) {
      handleRunEvent(run, data, () => (closed = true), context);
    },
    get state() {
      return agentStateOf(pieces);
    },
    /** The log as the page shows it: words, code, node and time. */
    get lines() {
      return agentStateOf(pieces).logs.map(({ message, code, node, elapsedMs }) => ({
        message,
        ...(code !== undefined && { code }),
        ...(node !== undefined && { node }),
        ...(elapsedMs !== undefined && { elapsedMs }),
      }));
    },
    get closed() {
      return closed;
    },
    failures,
    dropped,
    analyzed,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('handleRunEvent', () => {
  it('connected: keeps the thread and logs the connection', () => {
    const p = page();
    p.send(event({ type: 'connected', threadId: 't1', elapsedMs: 3 }));
    expect(p.run.life.threadId).toBe('t1');
    expect(p.lines).toEqual([
      { message: 'Connected to the analysis server', code: 'SYS-INIT', elapsedMs: 3 },
    ]);
    expect(p.state.status).toBe('connecting');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, object[]]>([
    [
      'a step with words',
      { node: 'scout', code: 'NET-100', message: 'Searching' },
      { status: 'searching', statusNote: null, isReplay: false },
      [{ message: 'Searching', code: 'NET-100', node: 'scout' }],
    ],
    [
      'a step without words adds no line',
      { node: 'scout', message: '' },
      { status: 'searching', statusNote: null },
      [],
    ],
    [
      'a line that is no step',
      { node: 'research_tool', message: 'Found' },
      { status: 'connecting' },
      [{ message: 'Found', node: 'research_tool' }],
    ],
    [
      'the replay notice',
      { node: 'replay', code: 'SYS-INIT', message: 'Replaying' },
      { status: 'connecting', isReplay: true },
      [{ message: 'Replaying', code: 'SYS-INIT', node: 'replay' }],
    ],
  ])('status: %s', (_name, fields, state, lines) => {
    const p = page();
    p.send(event({ type: 'status', ...fields }));
    expect(p.state).toMatchObject(state);
    expect(p.lines).toEqual(lines);
  });

  it('status: the replay notice marks the run itself as a replay', () => {
    const p = page();
    p.send(event({ type: 'status', node: 'replay', code: 'SYS-INIT', message: 'Replaying' }));
    expect(p.run.life.replay).toBe(true);
  });

  it('status: counts what the branches said for the next line', () => {
    const p = page();
    p.send(event({ type: 'status', node: 'engineer', code: 'AUDIO-INIT', message: 'm' }));
    expect(p.state.status).toBe('measuring');
    // The historian does not replace the measurement under way, but is counted.
    p.send(event({ type: 'status', node: 'historian', message: '' }));
    expect(p.state.status).toBe('measuring');
    expect(p.run.life.branches.researched).toBe(true);
    // Once the measurement ends, the research beside it is what is left.
    p.send(event({ type: 'status', node: 'engineer', code: 'AUDIO-DONE', message: '' }));
    expect(p.state.status).toBe('researching');
  });

  it('interrupt: opens the picker with the server question and waits', () => {
    const p = page();
    p.send(
      event({ type: 'interrupt', threadId: 't1', candidates, sentCount: 2, message: 'Which one?' }),
    );
    expect(p.run.life).toMatchObject({ phase: 'awaiting-selection', threadId: 't1', candidates });
    expect(p.state).toMatchObject({
      status: 'disambiguation',
      statusNote: 'Which one?',
      candidates,
      isLoading: false,
    });
    expect(p.lines).toEqual([{ message: 'Which one?', node: 'scout' }]);
  });

  it('interrupt: counts the rows shown when the server sent more', () => {
    const p = page();
    p.send(
      event({ type: 'interrupt', threadId: 't1', candidates, sentCount: 3, message: 'Which one?' }),
    );
    expect(p.state.statusNote).not.toBe('Which one?');
    expect(p.lines).toEqual([{ message: p.state.statusNote, node: 'scout' }]);
  });

  it('interrupt: without candidates ends the run with no_match, its stream closed first', () => {
    const p = page();
    p.send(event({ type: 'interrupt', threadId: 't1', candidates: [], sentCount: 0, message: '' }));
    expect(p.state).toMatchObject({
      status: 'error',
      error: 'No matching songs were found.',
      errorCode: CLIENT_ERROR_CODES.noMatch,
      candidates: null,
    });
    expect(p.failures).toEqual([{ closedFirst: true }]);
  });

  it('complete: shows the result and logs it', () => {
    const p = page();
    p.send(event({ type: 'complete', data: track, elapsedMs: 9 }));
    expect(p.run.life.phase).toBe('complete');
    expect(p.state).toMatchObject({
      status: 'complete',
      trackData: track,
      isComplete: true,
      isReplay: false,
      isLoading: false,
    });
    expect(p.lines).toEqual([{ message: 'Analysis complete.', code: 'SYS-READY', elapsedMs: 9 }]);
  });

  it('complete: after the replay notice, a result that does not say it is a recording is a replay', () => {
    const p = page();
    p.send(event({ type: 'status', node: 'replay', code: 'SYS-INIT', message: 'Replaying' }));
    p.send(event({ type: 'complete', data: track }));
    expect(p.state.isReplay).toBe(true);
    expect(p.lines.map((line) => line.message)).toEqual([
      'Replaying',
      'Recorded analysis replayed. Nothing was analyzed live.',
    ]);
  });

  it('complete: another track than the one asked for is not shown', () => {
    const p = page(newRun('Hurt', { expectedTrackId: 'c1' }));
    p.send(event({ type: 'complete', data: track }));
    expect(p.state).toMatchObject({
      status: 'error',
      errorCode: CLIENT_ERROR_CODES.wrongTrack,
      trackData: null,
    });
    expect(p.failures).toEqual([{ closedFirst: true }]);
  });

  it.each<[string, Record<string, unknown>, object, object, unknown[]]>([
    [
      'error: ends the run with its words, code and wait',
      { error: 'Slow down', code: 'rate_limited', retryAfterMs: 5000, elapsedMs: 4 },
      { error: 'Slow down', errorCode: 'rate_limited' },
      { closedFirst: true, elapsedMs: 4, retryAfterMs: 5000 },
      [],
    ],
    [
      'error without words',
      { error: '', code: 'failed' },
      { error: 'The analysis failed.', errorCode: 'failed' },
      { closedFirst: true },
      [],
    ],
    [
      'auth_expired: the run token is not sent again',
      { error: 'Expired', code: 'auth_expired' },
      { error: 'Expired', errorCode: 'auth_expired' },
      { closedFirst: true },
      [token],
    ],
  ])('%s', (_name, fields, state, failure, dropped) => {
    const run = newRun('Hurt');
    advance(run, { type: 'tokenIssued', token });
    const p = page(run);
    p.send(event({ type: 'error', ...fields }));
    expect(p.state).toMatchObject({ status: 'error', ...state });
    expect(p.failures).toEqual([failure]);
    expect(p.dropped).toEqual(dropped);
  });

  it('error: a refused resume of a picked track with a recording replays that recording', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          replays: [{ id: 'c2', title: 'Hurt', artist: 'NIN', album: 'B', recordedAt: 'x' }],
        }),
      ),
    );
    const run = newRun('Hurt');
    advance(run, { type: 'connected', threadId: 't1' });
    advance(run, { type: 'pickerOpened', threadId: 't1', candidates });
    advance(run, { type: 'picked', candidate: candidates[1] });
    const p = page(run);
    p.send(event({ type: 'error', error: 'Paused', code: 'budget_exhausted' }));
    await vi.waitFor(() => expect(p.analyzed).toHaveLength(1));
    expect(p.closed).toBe(true);
    expect(p.failures).toEqual([]);
    expect(p.analyzed).toEqual([
      {
        query: 'Hurt NIN',
        options: {
          note: 'Live analysis is unavailable: replaying the recording of the selected track.',
          trackId: 'c2',
          expectedTrackId: 'c2',
        },
      },
    ]);
  });

  it('unreadable: ends the run with the reload hint', () => {
    const p = page();
    p.send({ type: 'unreadable', event: 'complete', runId: 't1' });
    expect(p.state).toMatchObject({
      status: 'error',
      error: OUTDATED_ERROR.message,
      errorCode: OUTDATED_ERROR.code,
    });
    expect(p.failures).toEqual([{ closedFirst: true }]);
  });

  it('done: a stream that ends without anything to show is an error', () => {
    const p = page();
    p.send(event({ type: 'done', elapsedMs: 7 }));
    expect(p.state).toMatchObject({ status: 'error', errorCode: CLIENT_ERROR_CODES.noResult });
    expect(p.lines.at(-1)).toEqual({
      message: 'Error: The analysis ended without a result.',
      code: 'SYS-ERROR',
      elapsedMs: 7,
    });
    expect(p.failures).toEqual([{ closedFirst: true, elapsedMs: 7 }]);
  });

  it('done: after the picker opened, only closes the stream', () => {
    const p = page();
    p.send(event({ type: 'interrupt', threadId: 't1', candidates, sentCount: 2, message: 'Pick' }));
    const before = p.state;
    p.send(event({ type: 'done' }));
    expect(p.closed).toBe(true);
    expect(p.state).toEqual(before);
  });

  it.each(['complete', 'failed'] as const)(
    'after the run is %s, later events change nothing, and only done and error close the stream',
    (phase) => {
      const run = newRun('Hurt');
      page(run).send(
        phase === 'complete' ? event({ type: 'complete', data: track }) : event({ type: 'done' }),
      );
      for (const [later, closes] of [
        [event({ type: 'status', node: 'scout', message: 'x' }), false],
        [event({ type: 'complete', data: { ...track, id: 'other' } }), false],
        [event({ type: 'done' }), true],
        [event({ type: 'error', error: 'e', code: 'c' }), true],
      ] as const) {
        const p = page(run);
        const before = p.state;
        p.send(later);
        expect(p.state).toEqual(before);
        expect(p.closed).toBe(closes);
        expect(p.failures).toEqual([]);
      }
    },
  );
});

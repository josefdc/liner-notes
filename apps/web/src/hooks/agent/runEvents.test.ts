import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisEvent } from './events';
import { CLIENT_ERROR_CODES, OUTDATED_ERROR } from './failure';
import { advance, newRun, type Run } from './run';
import { handleRunEvent } from './runEvents';
import type { AgentAction } from './state';

const candidates = [
  { id: 'c1', title: 'Hurt', artist: 'Johnny Cash', album: 'A', coverUrl: '' },
  { id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails', album: 'B', coverUrl: '' },
];
const track = { id: 'c2', title: 'Hurt', artist: 'NIN', album: 'B', coverUrl: '' };
const token = { runToken: 'token-1', expiresAt: 1 };
const envelope = { runId: 't1', seq: 0 };
const event = (data: Record<string, unknown>) => ({ ...envelope, ...data }) as AnalysisEvent;

/** What handling `data` did: the actions, log lines, failures and other calls, in order. */
function handle(data: AnalysisEvent, run: Run = newRun('Hurt')) {
  const calls: unknown[] = [];
  const close = vi.fn(() => calls.push('close'));
  handleRunEvent(run, data, close, {
    dispatch: (action: AgentAction) => calls.push(action),
    log: (message, code, node, elapsedMs) => calls.push({ log: message, code, node, elapsedMs }),
    fail: (_run, message, code, elapsedMs, retryAfterMs) =>
      calls.push({ fail: message, code, elapsedMs, retryAfterMs }),
    isLatest: () => true,
    dropToken: (dropped) => calls.push({ drop: dropped }),
    analyze: (query, options) => calls.push({ analyze: query, options }),
  });
  return { calls, run };
}

afterEach(() => vi.unstubAllGlobals());

describe('handleRunEvent', () => {
  it('connected: keeps the thread and logs the connection', () => {
    const { calls, run } = handle(event({ type: 'connected', threadId: 't1', elapsedMs: 3 }));
    expect(run.life.threadId).toBe('t1');
    expect(calls).toEqual([
      { log: 'Connected to the analysis server', code: 'SYS-INIT', node: undefined, elapsedMs: 3 },
    ]);
  });

  it.each<[string, Record<string, unknown>, unknown[]]>([
    [
      'a step with words',
      { node: 'scout', code: 'NET-100', message: 'Searching' },
      [
        { log: 'Searching', code: 'NET-100', node: 'scout', elapsedMs: undefined },
        { type: 'stepReported', step: { status: 'searching', note: null } },
      ],
    ],
    [
      'a step without words adds no line',
      { node: 'scout', message: '' },
      [{ type: 'stepReported', step: { status: 'searching', note: null } }],
    ],
    [
      'a line that is no step',
      { node: 'research_tool', message: 'Found' },
      [{ log: 'Found', code: undefined, node: 'research_tool', elapsedMs: undefined }],
    ],
    [
      'the replay notice',
      { node: 'replay', code: 'SYS-INIT', message: 'Replaying' },
      [
        { type: 'replayNoticed' },
        { log: 'Replaying', code: 'SYS-INIT', node: 'replay', elapsedMs: undefined },
      ],
    ],
  ])('status: %s', (_name, fields, expected) => {
    expect(handle(event({ type: 'status', ...fields })).calls).toEqual(expected);
  });

  it('status: counts what the branches said for the next line', () => {
    const run = newRun('Hurt');
    handle(event({ type: 'status', node: 'engineer', code: 'AUDIO-INIT', message: 'm' }), run);
    expect(run.life.branches.measuring).toBe(true);
    // The historian does not replace the measurement under way.
    const { calls } = handle(event({ type: 'status', node: 'historian', message: '' }), run);
    expect(calls).toEqual([]);
    expect(run.life.branches.researched).toBe(true);
  });

  it('interrupt: opens the picker with the server question and waits', () => {
    const { calls, run } = handle(
      event({ type: 'interrupt', threadId: 't1', candidates, sentCount: 2, message: 'Which one?' }),
    );
    expect(run.life).toMatchObject({ phase: 'awaiting-selection', threadId: 't1', candidates });
    expect(calls).toEqual([
      { type: 'pickerOpened', candidates, question: 'Which one?' },
      { log: 'Which one?', code: undefined, node: 'scout', elapsedMs: undefined },
    ]);
  });

  it('interrupt: counts the rows shown when the server sent more', () => {
    const { calls } = handle(
      event({ type: 'interrupt', threadId: 't1', candidates, sentCount: 3, message: 'Which one?' }),
    );
    expect(calls[0]).toMatchObject({
      type: 'pickerOpened',
      question: expect.not.stringMatching('Which one?'),
    });
  });

  it('interrupt: without candidates ends the run with no_match', () => {
    const { calls } = handle(
      event({ type: 'interrupt', threadId: 't1', candidates: [], sentCount: 0, message: '' }),
    );
    expect(calls).toEqual([
      'close',
      {
        fail: 'No matching songs were found.',
        code: CLIENT_ERROR_CODES.noMatch,
        elapsedMs: undefined,
        retryAfterMs: undefined,
      },
    ]);
  });

  it('complete: shows the result and logs it', () => {
    const { calls, run } = handle(event({ type: 'complete', data: track, elapsedMs: 9 }));
    expect(run.life.phase).toBe('complete');
    expect(calls).toEqual([
      { type: 'completed', trackData: track, replay: false },
      { log: 'Analysis complete.', code: 'SYS-READY', node: undefined, elapsedMs: 9 },
    ]);
  });

  it('complete: a replayed run says nothing was analysed live', () => {
    const run = newRun('Hurt');
    advance(run, { type: 'replayNoticed' });
    const { calls } = handle(event({ type: 'complete', data: track }), run);
    expect(calls[0]).toEqual({ type: 'completed', trackData: track, replay: true });
    expect(calls[1]).toMatchObject({
      log: 'Recorded analysis replayed. Nothing was analyzed live.',
    });
  });

  it('complete: another track than the one asked for is not shown', () => {
    const run = newRun('Hurt', { expectedTrackId: 'c1' });
    const { calls } = handle(event({ type: 'complete', data: track }), run);
    expect(run.life.phase).toBe('running');
    expect(calls).toEqual([
      'close',
      expect.objectContaining({ code: CLIENT_ERROR_CODES.wrongTrack }),
    ]);
  });

  it.each<[string, Record<string, unknown>, unknown[]]>([
    [
      'error: ends the run with its words, code and wait',
      { error: 'Slow down', code: 'rate_limited', retryAfterMs: 5000, elapsedMs: 4 },
      ['close', { fail: 'Slow down', code: 'rate_limited', elapsedMs: 4, retryAfterMs: 5000 }],
    ],
    [
      'error without words',
      { error: '', code: 'failed' },
      [
        'close',
        {
          fail: 'The analysis failed.',
          code: 'failed',
          elapsedMs: undefined,
          retryAfterMs: undefined,
        },
      ],
    ],
    [
      'auth_expired: the run token is not sent again',
      { error: 'Expired', code: 'auth_expired' },
      [
        'close',
        { drop: token },
        { fail: 'Expired', code: 'auth_expired', elapsedMs: undefined, retryAfterMs: undefined },
      ],
    ],
  ])('%s', (_name, fields, expected) => {
    const run = newRun('Hurt');
    advance(run, { type: 'tokenIssued', token });
    expect(handle(event({ type: 'error', ...fields }), run).calls).toEqual(expected);
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
    const { calls } = handle(
      event({ type: 'error', error: 'Paused', code: 'budget_exhausted' }),
      run,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      'close',
      {
        analyze: 'Hurt NIN',
        options: {
          note: 'Live analysis is unavailable: replaying the recording of the selected track.',
          trackId: 'c2',
          expectedTrackId: 'c2',
        },
      },
    ]);
  });

  it('unreadable: ends the run with the reload hint', () => {
    const { calls } = handle({ type: 'unreadable', event: 'complete', runId: 't1' });
    expect(calls).toEqual([
      'close',
      {
        fail: OUTDATED_ERROR.message,
        code: OUTDATED_ERROR.code,
        elapsedMs: undefined,
        retryAfterMs: undefined,
      },
    ]);
  });

  it('done: a stream that ends without anything to show is an error', () => {
    const { calls } = handle(event({ type: 'done', elapsedMs: 7 }));
    expect(calls).toEqual([
      'close',
      {
        fail: 'The analysis ended without a result.',
        code: CLIENT_ERROR_CODES.noResult,
        elapsedMs: 7,
        retryAfterMs: undefined,
      },
    ]);
  });

  it('done: after the picker opened, only closes the stream', () => {
    const run = newRun('Hurt');
    advance(run, { type: 'pickerOpened', threadId: 't1', candidates });
    expect(handle(event({ type: 'done' }), run).calls).toEqual(['close']);
  });

  it.each(['complete', 'failed'] as const)(
    'after the run is %s, only done and error close the stream',
    (phase) => {
      const run = newRun('Hurt');
      advance(
        run,
        phase === 'complete' ? { type: 'completed', wholeRecording: false } : { type: 'failed' },
      );
      expect(handle(event({ type: 'status', node: 'scout', message: 'x' }), run).calls).toEqual([]);
      expect(handle(event({ type: 'complete', data: track }), run).calls).toEqual([]);
      expect(handle(event({ type: 'done' }), run).calls).toEqual(['close']);
      expect(handle(event({ type: 'error', error: 'e', code: 'c' }), run).calls).toEqual(['close']);
    },
  );
});

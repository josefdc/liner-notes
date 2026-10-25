import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEventSchemas, resetSkippedReports } from './agent/events';
import { OUTDATED_ERROR, STREAM_INACTIVITY_TIMEOUT_MS, useAgent } from './useAgent';

/**
 * An EventSource the test drives by hand. `send` adds what the API's stream adds to each event:
 * the run id (`t1`; null on a factoid stream) and `seq` (0, 1, 2… per stream; none on a
 * heartbeat), unless the event names its own.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private seq = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  close() {
    this.closed = true;
  }

  /**
   * A `data:` event. `late` delivers it even after close (it was already queued); `raw` sends
   * it without the run id and `seq`.
   */
  send(data: { type: string; [field: string]: unknown }, { late = false, raw = false } = {}) {
    if (this.closed && !late) return;
    const runId = this.url.includes('/factoids/') ? null : 't1';
    const event = raw
      ? data
      : { runId, ...(data.type === 'heartbeat' ? {} : { seq: this.seq++ }), ...data };
    act(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) })));
  }

  /** A named event (`event: <type>`). */
  sendNamed(type: string, data: object = { type }) {
    if (this.closed) return;
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }

  fail() {
    if (this.closed) return;
    act(() => this.onerror?.(new Event('error')));
  }
}

const streams = () => FakeEventSource.instances;
const lastStream = () => streams()[streams().length - 1];
const candidates = [
  { id: 'c1', title: 'Hurt', artist: 'Johnny Cash', album: 'A', coverUrl: '' },
  { id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails', album: 'B', coverUrl: '' },
];
/** A result as the API sends it (a TrackAnalysis). */
const track = {
  id: 'c2',
  title: 'Hurt',
  artist: 'Nine Inch Nails',
  album: 'B',
  coverUrl: '',
  bpm: null,
  genealogy: { nodes: [], links: [] },
};
const interrupt = (list: typeof candidates = candidates) => ({
  type: 'interrupt',
  reason: 'disambiguation',
  threadId: 't1',
  candidates: list,
  message: 'Multiple songs found. Please select the correct one.',
});
const factoid = (id: string) => ({ id, title: `Fact ${id}`, content: 'Content.', type: 'trivia' });
const completeLogs = (logs: Array<{ message: string }>) =>
  logs.filter((log) => log.message.startsWith('Analysis complete')).length;

let fetchSpy: ReturnType<typeof vi.fn>;

// The stream reader is a chunk of its own; once it is loaded, streams open at once.
beforeAll(() => loadEventSchemas());

beforeEach(() => {
  FakeEventSource.instances = [];
  resetSkippedReports();
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchSpy = vi.fn(async () => new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function startAnalysis(query = 'Hurt') {
  const hook = renderHook(() => useAgent());
  act(() => {
    hook.result.current.analyze(query);
  });
  return hook;
}

function openPicker() {
  const hook = startAnalysis();
  const analysis = lastStream();
  analysis.send({ type: 'connected', threadId: 't1' });
  analysis.send(interrupt());
  return { hook, analysis };
}

describe('useAgent stream errors', () => {
  it('shows an error on a broken stream and never re-runs the analysis', () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.fail();

    expect(result.current.status).toBe('error');
    expect(result.current.isLoading).toBe(false);
    expect(analysis.closed).toBe(true);
    expect(streams()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks for a clicked suggestion by its track id, and a typed search by text only', () => {
    const hook = renderHook(() => useAgent());
    act(() => {
      hook.result.current.analyze('Hurt Johnny Cash', { trackId: '28cnXtME493VX9NOw9cIUh' });
    });
    expect(lastStream().url).toContain(
      '/api/analyze/stream?query=Hurt%20Johnny%20Cash&trackId=28cnXtME493VX9NOw9cIUh',
    );

    // A retry asks for the same track again.
    lastStream().fail();
    act(() => hook.result.current.retry());
    expect(lastStream().url).toContain('&trackId=28cnXtME493VX9NOw9cIUh');

    act(() => {
      hook.result.current.analyze('Hurt');
    });
    expect(lastStream().url).not.toContain('trackId');
    // An id that is not a Spotify track id is not sent.
    act(() => {
      hook.result.current.analyze('Hurt', { trackId: 'c1' });
    });
    expect(lastStream().url).not.toContain('trackId');
  });

  it('retries by opening a new stream for the same query', () => {
    const { result } = startAnalysis('Hurt');
    lastStream().fail();
    act(() => result.current.retry());

    expect(streams()).toHaveLength(2);
    expect(lastStream().url).toContain('/api/analyze/stream?query=Hurt');
    expect(result.current.status).toBe('connecting');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ends the run with the reload hint on a complete event it cannot read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = startAnalysis();
    lastStream().send({ type: 'complete' });

    expect(result.current.status).toBe('error');
    expect(result.current.trackData).toBeNull();
    expect(result.current.errorCode).toBe(OUTDATED_ERROR.code);
    expect(result.current.error).toMatch(/out of date.*Reload/);
    expect(lastStream().closed).toBe(true);
  });

  it('treats a stream that ends without a result as an error', () => {
    const { result } = startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    lastStream().send({ type: 'done' });

    expect(result.current.status).toBe('error');
  });
});

describe('useAgent results', () => {
  it('ignores a duplicate complete for the same thread', () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'complete', data: track });
    analysis.send({ type: 'complete', data: { ...track, title: 'Changed' } });
    analysis.send({ type: 'status', node: 'composer', message: 'late status' });
    analysis.send({ type: 'error', code: 'failed', error: 'late failure' });
    analysis.send({ type: 'done' });

    expect(result.current.status).toBe('complete');
    expect(result.current.trackData?.title).toBe('Hurt');
    expect(completeLogs(result.current.logs)).toBe(1);
    expect(analysis.closed).toBe(true);
  });

  it('keeps a closed analysis from touching a newer run', () => {
    const { result } = startAnalysis('first');
    const first = lastStream();
    act(() => {
      result.current.analyze('second');
    });
    expect(first.closed).toBe(true);

    // An event of the first run that was already on its way.
    first.send({ type: 'complete', data: track }, { late: true });
    expect(result.current.status).toBe('connecting');
    expect(result.current.trackData).toBeNull();
  });
});

describe('useAgent track picker', () => {
  it('keeps the picker when the analysis stream ends after the interrupt', () => {
    const { hook, analysis } = openPicker();
    analysis.send({ type: 'done' });
    analysis.fail();

    expect(hook.result.current.status).toBe('disambiguation');
    expect(hook.result.current.candidates).toHaveLength(2);
    expect(analysis.closed).toBe(true);
  });

  it('opens the picker on the interrupt only: a candidates event is not part of the protocol', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'candidates', candidates });
    expect(hook.result.current.candidates).toBeNull();
    expect(hook.result.current.status).not.toBe('disambiguation');

    analysis.send(interrupt([...candidates]));
    expect(hook.result.current.status).toBe('disambiguation');
    expect(hook.result.current.candidates?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it.each([
    ['click', '&pickedBy=click'],
    ['countdown', '&pickedBy=countdown'],
  ] as const)('says the row was picked by %s when it resumes', async (pickedBy, param) => {
    const { hook } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2', pickedBy);
    });

    const [resume] = streams().filter((s) => s.url.includes('/resume'));
    expect(resume.url).toContain(`selectedTrackId=c2${param}`);
  });

  it('without a thread, asks for the picked row by id with the searched text and how it was picked', async () => {
    const hook = startAnalysis('Hurt');
    const analysis = lastStream();
    const rows = candidates.map((c, i) => ({ ...c, id: `28cnXtME493VX9NOw9cIU${i}` }));
    analysis.send({ type: 'connected', threadId: '' });
    analysis.send({ ...interrupt(rows), threadId: '' });

    await act(async () => {
      await hook.result.current.selectCandidate(rows[1].id, 'countdown');
    });

    expect(lastStream().url).toContain(
      `/api/analyze/stream?query=Hurt&trackId=${rows[1].id}&pickedBy=countdown`,
    );
    // A retry asks the same way.
    lastStream().fail();
    act(() => hook.result.current.retry());
    expect(lastStream().url).toContain(`&trackId=${rows[1].id}&pickedBy=countdown`);
  });

  it('opens one resume per picker and closes the analysis stream', async () => {
    const { hook, analysis } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
      await hook.result.current.selectCandidate('c2');
      await hook.result.current.selectCandidate('c1');
    });

    const resumes = streams().filter((s) => s.url.includes('/resume'));
    expect(resumes).toHaveLength(1);
    expect(resumes[0].url).toContain('threadId=t1&selectedTrackId=c2');
    expect(analysis.closed).toBe(true);
  });

  /** GET /api/replays answers with these recordings. */
  const recordings = (...replays: Array<{ id: string; title: string; artist: string }>) =>
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            replays: replays.map((r) => ({ ...r, album: 'A', recordedAt: '2026-10-22T14:03:00Z' })),
          }),
          { status: 200 },
        ),
    );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  it('replays the recording of the very track picked when its resume is refused', async () => {
    // Recorded under its own title, which the query names alone.
    recordings({ id: 'c2', title: 'Hurt (Recorded)', artist: 'Nine Inch Nails' });
    const { hook } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    const resume = lastStream();
    resume.send({ type: 'error', code: 'budget_exhausted', error: 'paused' });
    await settle();

    const search = lastStream();
    expect(search).not.toBe(resume);
    expect(search.url).toContain('/analyze/stream?query=Hurt%20(Recorded)%20Nine%20Inch%20Nails');
    expect(hook.result.current.status).not.toBe('error');
    // The reason stays in the log of the new run.
    expect(hook.result.current.logs.map((log) => log.message)).toContain(
      'Live analysis is unavailable: replaying the recording of the track you picked.',
    );
    search.send({ type: 'complete', data: track });
    expect(hook.result.current.status).toBe('complete');
  });

  it('never shows another take than the one picked', async () => {
    // c1 shares the picked track's title, but only c1 is recorded.
    recordings({ id: 'c1', title: 'Hurt', artist: 'Nine Inch Nails' });
    const { hook } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    lastStream().send({ type: 'error', code: 'budget_exhausted', error: 'paused' });
    await settle();
    expect(streams()).toHaveLength(2);
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.errorCode).toBe('budget_exhausted');

    // And when the recordings cannot be listed: the refusal as well.
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 503 }));
    const second = openPicker();
    await act(async () => {
      await second.hook.result.current.selectCandidate('c2');
    });
    lastStream().send({ type: 'error', code: 'live_disabled', error: 'off' });
    await settle();
    expect(second.hook.result.current.errorCode).toBe('live_disabled');
  });

  it('does not show a replayed result of another track than the one asked for', async () => {
    recordings({ id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails' });
    const { hook } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    lastStream().send({ type: 'error', code: 'budget_exhausted', error: 'paused' });
    await settle();
    lastStream().send({ type: 'complete', data: { ...track, id: 'someone-else' } });
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.trackData).toBeNull();
  });

  it('says a run is a replay from the replay notice on, and ends it as a replay', () => {
    const { result } = startAnalysis('Hurt Nine Inch Nails');
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    expect(result.current.isReplay).toBe(false);
    analysis.send({ type: 'status', node: 'replay', code: 'SYS-INIT', message: 'Replaying' });
    expect(result.current.isReplay).toBe(true);
    analysis.send({
      type: 'complete',
      data: {
        ...track,
        run: {
          id: 't1',
          mode: 'replay',
          recordedAt: '2026-10-22T14:03:00.000Z',
          commit: 'abc1234',
          analyzerVersion: null,
        },
      },
    });
    expect(result.current.isReplay).toBe(true);
    expect(result.current.logs.at(-1)?.message).toBe(
      'Recorded analysis replayed. Nothing was analysed live.',
    );
    expect(completeLogs(result.current.logs)).toBe(0);
    act(() => {
      result.current.analyze('Another');
    });
    expect(result.current.isReplay).toBe(false);
  });

  it('does not take a run whose model answers came from stored answers for a recording', () => {
    const { result } = startAnalysis('Hurt Nine Inch Nails');
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    // A live run in development with model cassettes: "replay", but no recording time or commit.
    analysis.send({
      type: 'complete',
      data: {
        ...track,
        run: { id: 't1', mode: 'replay', recordedAt: null, commit: null, analyzerVersion: null },
      },
    });
    expect(result.current.isReplay).toBe(false);
    expect(completeLogs(result.current.logs)).toBe(1);

    // Stored answers that say when and where they were recorded: still not a recording.
    act(() => {
      result.current.analyze('Hurt Nine Inch Nails');
    });
    const again = lastStream();
    again.send({ type: 'connected', threadId: 't1' });
    again.send({
      type: 'complete',
      data: {
        ...track,
        run: {
          id: 't1',
          mode: 'replay',
          replayed: 'model_answers',
          recordedAt: '2026-03-01T10:00:00.000Z',
          commit: 'abc123def456',
          analyzerVersion: null,
        },
      },
    });
    expect(result.current.isReplay).toBe(false);
  });

  it("does not let the analysis stream's late done close the resume stream", async () => {
    const { hook, analysis } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    const resume = lastStream();

    analysis.send({ type: 'done' }, { late: true });
    expect(resume.closed).toBe(false);

    resume.send({ type: 'complete', data: track });
    resume.send({ type: 'done' });
    expect(hook.result.current.status).toBe('complete');
    expect(completeLogs(hook.result.current.logs)).toBe(1);
    expect(resume.closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows an error with no fallback request when the resume stream breaks', async () => {
    const { hook } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    lastStream().fail();

    expect(hook.result.current.status).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useAgent inactivity watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('times out after 45 s', () => {
    expect(STREAM_INACTIVITY_TIMEOUT_MS).toBe(45_000);
  });

  it('never times out a stream that has sent no heartbeat', () => {
    const { result } = startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    act(() => vi.advanceTimersByTime(10 * 60_000));

    expect(result.current.status).not.toBe('error');
    expect(lastStream().closed).toBe(false);
  });

  it('stays quiet while heartbeats arrive and fails after a silence once armed', () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.sendNamed('heartbeat');
    for (let i = 0; i < 8; i++) {
      act(() => vi.advanceTimersByTime(15_000));
      analysis.sendNamed('heartbeat');
    }
    expect(result.current.status).not.toBe('error');

    act(() => vi.advanceTimersByTime(STREAM_INACTIVITY_TIMEOUT_MS - 1));
    expect(result.current.status).not.toBe('error');
    act(() => vi.advanceTimersByTime(1));

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/stopped responding/);
    expect(analysis.closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts other events as activity once armed', () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.sendNamed('heartbeat');
    act(() => vi.advanceTimersByTime(40_000));
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing' });
    act(() => vi.advanceTimersByTime(40_000));

    expect(result.current.status).toBe('analyzing');
  });

  it('does not fail a run that already has its result', () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.sendNamed('heartbeat');
    analysis.send({ type: 'complete', data: track });
    act(() => vi.advanceTimersByTime(STREAM_INACTIVITY_TIMEOUT_MS));

    expect(result.current.status).toBe('complete');
    expect(analysis.closed).toBe(true);
  });
});

describe('useAgent factoid stream', () => {
  it('closes the stream and rejects when a new analysis starts', async () => {
    const { result } = startAnalysis();
    lastStream().send({ type: 'complete', data: track });
    const onFactoid = vi.fn();
    const pending = result.current.decryptMoreFactoidsStream('Hurt', 'NIN', [], onFactoid);
    const decrypt = lastStream();
    decrypt.send({ type: 'factoid', data: factoid('f1') });

    act(() => result.current.reset());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(decrypt.closed).toBe(true);
    decrypt.send({ type: 'factoid', data: factoid('f2') }, { late: true });
    expect(onFactoid).toHaveBeenCalledTimes(1);
  });

  it("closes the stream when the caller's signal aborts", async () => {
    const { result } = renderHook(() => useAgent());
    const controller = new AbortController();
    const pending = result.current.decryptMoreFactoidsStream(
      'Hurt',
      'NIN',
      [],
      () => {},
      controller.signal,
    );
    const decrypt = lastStream();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(decrypt.closed).toBe(true);
  });

  it('reports the rate limit and a paused budget to the caller, and goes on', async () => {
    const { result } = renderHook(() => useAgent());
    const onUnavailable = vi.fn();
    const onFactoid = vi.fn();
    const pending = result.current.decryptMoreFactoidsStream(
      'Hurt',
      'NIN',
      [],
      onFactoid,
      undefined,
      onUnavailable,
    );
    const decrypt = lastStream();
    decrypt.send({ type: 'error', code: 'rate_limited', error: 'busy', index: 0 });
    decrypt.send({ type: 'error', code: 'budget_exhausted', error: 'paused', index: 1 });
    decrypt.send({ type: 'error', code: 'failed', error: 'x', index: 2 });
    decrypt.send({ type: 'factoid', data: factoid('f1') });
    decrypt.send({ type: 'done' });

    await pending;
    expect(onUnavailable.mock.calls).toEqual([['rate_limited'], ['budget_exhausted']]);
    expect(onFactoid).toHaveBeenCalledTimes(1);
  });

  it('reports a replayed result whose recording is no longer served', async () => {
    const { result } = renderHook(() => useAgent());
    const onUnavailable = vi.fn();
    const pending = result.current.decryptMoreFactoidsStream(
      'Hurt',
      'NIN',
      [],
      () => {},
      undefined,
      onUnavailable,
      'replay',
    );
    lastStream().send({ type: 'error', code: 'not_found', error: 'gone' });
    lastStream().send({ type: 'done' });
    await pending;
    expect(onUnavailable.mock.calls).toEqual([['not_found']]);
  });

  it("sends the result's run mode, so more facts stay on its side", async () => {
    const { result } = renderHook(() => useAgent());
    const pending = result.current.decryptMoreFactoidsStream(
      'Hurt',
      'NIN',
      ['f1'],
      () => {},
      undefined,
      undefined,
      'replay',
    );
    const decrypt = lastStream();
    expect(new URL(decrypt.url, 'http://x').searchParams.get('mode')).toBe('replay');
    decrypt.send({ type: 'done' });
    await pending;
    const older = result.current.decryptMoreFactoidsStream('Hurt', 'NIN', [], () => {});
    expect(new URL(lastStream().url, 'http://x').searchParams.has('mode')).toBe(false);
    lastStream().send({ type: 'done' });
    await older;
  });

  it('reports live calls switched off (a server that replays recordings only)', async () => {
    const { result } = renderHook(() => useAgent());
    const onUnavailable = vi.fn();
    const pending = result.current.decryptMoreFactoidsStream(
      'Hurt',
      'NIN',
      [],
      () => {},
      undefined,
      onUnavailable,
    );
    const decrypt = lastStream();
    decrypt.send({ type: 'error', code: 'live_disabled', error: 'off' });
    decrypt.send({ type: 'done' });

    await pending;
    expect(onUnavailable.mock.calls).toEqual([['live_disabled']]);
  });

  it('resolves on done', async () => {
    const { result } = renderHook(() => useAgent());
    const pending = result.current.decryptMoreFactoidsStream('Hurt', 'NIN', [], () => {});
    lastStream().send({ type: 'done' });

    await expect(pending).resolves.toBeUndefined();
    expect(lastStream().closed).toBe(true);
  });
});

describe('useAgent search suggestions', () => {
  it('rejects when the suggestion request fails, so the failure can be shown', async () => {
    const { result } = renderHook(() => useAgent());
    await expect(result.current.searchSuggest('Hurt')).rejects.toThrow(/HTTP 503/);
  });

  it('returns the suggestions of a successful request', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, suggestions: candidates }), { status: 200 }),
    );
    const { result } = renderHook(() => useAgent());
    await expect(result.current.searchSuggest('Hurt')).resolves.toEqual(candidates);
  });
});

// The API's stream protocol: heartbeats as data messages, the picker announced by `interrupt`
// alone, and refusals sent as an `error` with a code, followed by `done`.
describe('useAgent with the interrupt-only protocol', () => {
  it('arms the watchdog on heartbeats sent as data messages', () => {
    vi.useFakeTimers();
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    for (let i = 0; i < 6; i++) {
      act(() => vi.advanceTimersByTime(15_000));
      analysis.send({ type: 'heartbeat' });
    }
    expect(result.current.status).not.toBe('error');

    act(() => vi.advanceTimersByTime(STREAM_INACTIVITY_TIMEOUT_MS));
    expect(result.current.status).toBe('error');
    expect(analysis.closed).toBe(true);
  });

  it('opens the picker on an interrupt without a candidates event and resumes', async () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'status', node: 'scout', message: 'Searching' });
    analysis.send(interrupt());
    analysis.send({ type: 'done' });
    expect(result.current.status).toBe('disambiguation');
    expect(result.current.candidates).toHaveLength(2);
    expect(analysis.closed).toBe(true);

    await act(async () => {
      await result.current.selectCandidate('c2');
    });
    const resume = lastStream();
    expect(resume.url).toContain('threadId=t1&selectedTrackId=c2');
    resume.send({ type: 'heartbeat' });
    resume.send({ type: 'resuming', threadId: 't1' });
    resume.send({ type: 'complete', data: track });
    resume.send({ type: 'heartbeat' });
    resume.send({ type: 'done' });
    expect(result.current.status).toBe('complete');
    expect(completeLogs(result.current.logs)).toBe(1);
    expect(resume.closed).toBe(true);
  });

  it('shows a refused resume with its code, makes no request and retries the search', async () => {
    const { result } = startAnalysis('Hurt');
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send(interrupt());
    analysis.send({ type: 'done' });
    await act(async () => {
      await result.current.selectCandidate('c1');
    });
    const resume = lastStream();
    resume.send({
      type: 'error',
      code: 'choice_expired',
      error: 'This choice has expired or was not found. Please search again.',
    });
    resume.send({ type: 'done' });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/expired/);
    expect(result.current.errorCode).toBe('choice_expired');
    expect(resume.closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => result.current.retry());
    expect(lastStream().url).toContain('/api/analyze/stream?query=Hurt');
    expect(result.current.errorCode).toBeNull();
  });
});

// Every message is parsed with the contract's schema; repeats, events of another run and a
// second result of the run are dropped (agent/events.ts).
describe('useAgent typed events', () => {
  it('skips unknown types and events that do not fit the contract, logging each kind once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'mystery', detail: 'from a newer server' });
    analysis.send({ type: 'mystery', detail: 'again' });
    analysis.send({ type: 'status', node: 'engineer' });
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing' }, { raw: true });

    expect(result.current.status).not.toBe('error');
    expect(result.current.logs.map((log) => log.message)).toEqual([
      '🔍 Searching for "Hurt"...',
      'Connected to agent',
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('(mystery): unknown type'),
      expect.stringContaining('(status): does not fit the contract'),
    ]);

    analysis.send({ type: 'complete', data: track });
    expect(result.current.status).toBe('complete');
  });

  it('drops an event repeated with the same seq, and one that arrives out of order', () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing', seq: 5 });
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing', seq: 5 });
    analysis.send({ type: 'status', node: 'engineer', message: 'Earlier', seq: 3 });

    const messages = result.current.logs.map((log) => log.message);
    expect(messages.filter((message) => message === 'Analyzing')).toHaveLength(1);
    expect(messages).not.toContain('Earlier');
  });

  it("ignores events of another run on the run's stream", () => {
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'complete', data: { ...track, title: 'Older run' }, runId: 't0' });
    analysis.send({ type: 'error', code: 'failed', error: 'Older run failed', runId: 't0' });

    expect(result.current.status).not.toBe('complete');
    expect(result.current.status).not.toBe('error');
    analysis.send({ type: 'complete', data: track });
    expect(result.current.trackData?.title).toBe('Hurt');
  });

  it('takes one complete per run, across its analysis and resume streams', async () => {
    const { hook, analysis } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    const resume = lastStream();
    // The resume stream numbers its events from 0 again: they are not repeats.
    resume.send({ type: 'resuming', threadId: 't1' });
    resume.send({ type: 'complete', data: track });
    resume.send({ type: 'complete', data: { ...track, title: 'Second result' } });

    expect(analysis.closed).toBe(true);
    expect(hook.result.current.trackData?.title).toBe('Hurt');
    expect(completeLogs(hook.result.current.logs)).toBe(1);
  });

  it('shows a result from a newer API that this page reads leniently', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({
      type: 'complete',
      data: { ...track, run: { id: 't1', mode: 'replay-v2', fallback: false } },
    });

    expect(result.current.status).toBe('complete');
    expect(result.current.trackData?.title).toBe('Hurt');
  });

  it('opens the picker on an interrupt from a newer API', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({
      ...interrupt(),
      reason: 'disambiguation-v2',
      candidates: candidates.map((candidate) => ({ ...candidate, coverUrl: null })),
    });

    expect(result.current.status).toBe('disambiguation');
    expect(result.current.candidates?.map((candidate) => candidate.id)).toEqual(['c1', 'c2']);
  });

  it('shows a refused resume that carries a run id of its own', async () => {
    const { hook } = openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    const resume = lastStream();
    resume.send({ type: 'error', code: 'invalid_input', error: 'Bad request', runId: 'fresh' });
    resume.send({ type: 'done', runId: 'fresh' });

    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.errorCode).toBe('invalid_input');
    expect(hook.result.current.error).toBe('Bad request');
  });

  it('skips a factoid that does not fit the contract and goes on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useAgent());
    const onFactoid = vi.fn();
    const pending = result.current.decryptMoreFactoidsStream('Hurt', 'NIN', [], onFactoid);
    const decrypt = lastStream();
    decrypt.send({ type: 'connected' });
    decrypt.send({ type: 'factoid', data: { ...factoid('f1'), type: 'lyrics' } });
    decrypt.send({ type: 'factoid', data: factoid('f2') });
    decrypt.send({ type: 'factoid', data: factoid('f2'), seq: 2 });
    decrypt.send({ type: 'done' });

    await pending;
    expect(onFactoid.mock.calls.map(([data]) => data.id)).toEqual(['f2']);
  });
});

describe('useAgent before the stream reader is loaded', () => {
  // A fresh copy of the modules, so the reader is not loaded yet.
  async function freshHook() {
    vi.resetModules();
    const { useAgent: fresh } = await import('./useAgent');
    return renderHook(() => fresh());
  }

  afterEach(() => {
    vi.doUnmock('./agent/eventSchemas');
    vi.resetModules();
  });

  it('opens the stream once the reader has loaded', async () => {
    const { result } = await freshHook();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.analyze('Hurt');
    });
    expect(streams()).toHaveLength(0);
    await act(() => pending);

    expect(streams()).toHaveLength(1);
    lastStream().send({ type: 'connected', threadId: 't1' });
    lastStream().send({ type: 'complete', data: track });
    expect(result.current.status).toBe('complete');
  });

  it('ends the run with the reload hint when the reader cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('./agent/eventSchemas', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const { result } = await freshHook();
    await act(() => result.current.analyze('Hurt'));

    expect(streams()).toHaveLength(0);
    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('outdated_client');
  });
});

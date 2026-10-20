import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_INACTIVITY_TIMEOUT_MS, useAgent } from './useAgent';

/** An EventSource the test drives by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
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

  /** A `data:` event. `late` delivers it even after close (it was already queued). */
  send(data: object, { late = false } = {}) {
    if (this.closed && !late) return;
    act(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })));
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
  { id: 'c1', title: 'Hurt', artist: 'Johnny Cash', album: 'A', coverUrl: '', popularity: 0 },
  { id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails', album: 'B', coverUrl: '', popularity: 0 },
];
const track = { id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails' };
const completeLogs = (logs: Array<{ message: string }>) =>
  logs.filter((log) => log.message.startsWith('Analysis complete')).length;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
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
  analysis.send({ type: 'candidates', candidates });
  analysis.send({ type: 'interrupt', threadId: 't1', candidates });
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

  it('retries by opening a new stream for the same query', () => {
    const { result } = startAnalysis('Hurt');
    lastStream().fail();
    act(() => result.current.retry());

    expect(streams()).toHaveLength(2);
    expect(lastStream().url).toContain('/api/analyze/stream?query=Hurt');
    expect(result.current.status).toBe('connecting');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a complete event without data as an error', () => {
    const { result } = startAnalysis();
    lastStream().send({ type: 'complete' });

    expect(result.current.status).toBe('error');
    expect(result.current.trackData).toBeNull();
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
    analysis.send({ type: 'error', error: 'late failure' });
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

  it('keeps the same candidate list when candidates and interrupt repeat it', () => {
    const hook = startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'candidates', candidates });
    const shown = hook.result.current.candidates;
    analysis.send({ type: 'interrupt', threadId: 't1', candidates: [...candidates] });

    expect(hook.result.current.candidates).toBe(shown);
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
    decrypt.send({ type: 'factoid', data: { id: 'f1' } });

    act(() => result.current.reset());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(decrypt.closed).toBe(true);
    decrypt.send({ type: 'factoid', data: { id: 'f2' } }, { late: true });
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
    analysis.send({ type: 'interrupt', reason: 'disambiguation', threadId: 't1', candidates });
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
    analysis.send({ type: 'interrupt', threadId: 't1', candidates });
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

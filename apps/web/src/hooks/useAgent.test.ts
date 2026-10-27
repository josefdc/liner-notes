import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunTokenError, requestRunToken } from './agent/apiClient';
import { loadEventSchemas, resetSkippedReports } from './agent/events';
import { LOG_LIMIT } from './agent/runLog';
import type { TrackData } from '../types';
import {
  OUTDATED_ERROR,
  STREAM_INACTIVITY_TIMEOUT_MS,
  type UseAgentReturn,
  useAgent,
} from './useAgent';

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

  /** The server answers the request with an error status (a 401): closed before it opened. */
  readyState: number | undefined;
  refuse() {
    if (this.closed) return;
    this.readyState = 2;
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

// The run token every analysis, resume and factoid request carries (agent/runToken.ts): asked
// for with the development bypass's Turnstile token, since tests set no site key.
vi.mock('./agent/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent/apiClient')>()),
  requestRunToken: vi.fn(async () => ({
    runToken: `token-${++tokensIssued}`,
    expiresAt: Date.now() + 30 * 60_000,
  })),
}));
let tokensIssued = 0;

let fetchSpy: ReturnType<typeof vi.fn>;

// The stream reader is a chunk of its own; once it is loaded, streams open at once.
beforeAll(() => loadEventSchemas());

beforeEach(() => {
  tokensIssued = 0;
  vi.mocked(requestRunToken).mockClear();
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

/** Lets the hook's pending promises settle: the run token request answers at once. */
async function tokenSettled() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function startAnalysis(query = 'Hurt') {
  const hook = renderHook(() => useAgent());
  await act(async () => {
    await hook.result.current.analyze(query);
  });
  return hook;
}

async function openPicker() {
  const hook = await startAnalysis();
  const analysis = lastStream();
  analysis.send({ type: 'connected', threadId: 't1' });
  analysis.send(interrupt());
  return { hook, analysis };
}

describe('useAgent stream errors', () => {
  it('shows an error on a broken stream and never re-runs the analysis', async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.fail();

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('connection_lost');
    expect(result.current.isLoading).toBe(false);
    expect(analysis.closed).toBe(true);
    expect(streams()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks for a clicked suggestion by its track id, and a typed search by text only', async () => {
    const hook = renderHook(() => useAgent());
    await act(async () => {
      await hook.result.current.analyze('Hurt Johnny Cash', { trackId: '28cnXtME493VX9NOw9cIUh' });
    });
    expect(lastStream().url).toContain(
      '/api/analyze/stream?query=Hurt%20Johnny%20Cash&trackId=28cnXtME493VX9NOw9cIUh',
    );

    // A retry asks for the same track again.
    lastStream().fail();
    act(() => hook.result.current.retry());
    await tokenSettled();
    expect(lastStream().url).toContain('&trackId=28cnXtME493VX9NOw9cIUh');

    await act(async () => {
      await hook.result.current.analyze('Hurt');
    });
    expect(lastStream().url).not.toContain('trackId');
    // An id that is not a Spotify track id is not sent.
    await act(async () => {
      await hook.result.current.analyze('Hurt', { trackId: 'c1' });
    });
    expect(lastStream().url).not.toContain('trackId');
  });

  it('retries by opening a new stream for the same query', async () => {
    const { result } = await startAnalysis('Hurt');
    lastStream().fail();
    act(() => result.current.retry());
    await tokenSettled();

    expect(streams()).toHaveLength(2);
    expect(lastStream().url).toContain('/api/analyze/stream?query=Hurt');
    expect(result.current.status).toBe('connecting');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ends the run with the reload hint on a complete event it cannot read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await startAnalysis();
    lastStream().send({ type: 'complete' });

    expect(result.current.status).toBe('error');
    expect(result.current.trackData).toBeNull();
    expect(result.current.errorCode).toBe(OUTDATED_ERROR.code);
    expect(result.current.error).toMatch(/out of date.*Reload/);
    expect(lastStream().closed).toBe(true);
  });

  it('treats a stream that ends without a result as an error', async () => {
    const { result } = await startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    lastStream().send({ type: 'done' });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('no_result');
  });

  it('gives a search without candidates the no_match code', async () => {
    const { result } = await startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    lastStream().send(interrupt([]));

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('no_match');
  });

  it('gives a stream that cannot be opened its own code', async () => {
    vi.stubGlobal(
      'EventSource',
      class {
        constructor() {
          throw new TypeError('Failed to fetch');
        }
      },
    );
    const { result } = await startAnalysis();

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('stream_open_failed');
  });

  it('gives a resume that cannot be opened its own code', async () => {
    const { hook } = await openPicker();
    vi.stubGlobal(
      'EventSource',
      class {
        constructor() {
          throw new TypeError('Failed to fetch');
        }
      },
    );
    await act(async () => {
      await hook.result.current.selectCandidate('c2', 'click');
    });

    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.errorCode).toBe('resume_failed');
  });
});

describe('useAgent results', () => {
  it('ignores a duplicate complete for the same thread', async () => {
    const { result } = await startAnalysis();
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

  it('keeps a closed analysis from touching a newer run', async () => {
    const { result } = await startAnalysis('first');
    const first = lastStream();
    await act(async () => {
      await result.current.analyze('second');
    });
    expect(first.closed).toBe(true);

    // An event of the first run that was already on its way.
    first.send({ type: 'complete', data: track }, { late: true });
    expect(result.current.status).toBe('connecting');
    expect(result.current.trackData).toBeNull();
  });
});

describe('useAgent progress', () => {
  it('moves to checking when the verifier reports, after composing', async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({
      type: 'status',
      node: 'composer',
      message: 'Writing the notes',
      code: 'LLM-CONNECT',
    });
    expect(result.current.status).toBe('composing');
    analysis.send({
      type: 'status',
      node: 'verifier',
      message: 'Checking the notes against their sources',
      code: 'LLM-RESPONSE',
    });

    expect(result.current.status).toBe('checking');
    expect(result.current.logs.at(-1)).toMatchObject({
      message: 'Checking the notes against their sources',
      node: 'verifier',
    });
    analysis.send({ type: 'complete', data: track });
    expect(result.current.status).toBe('complete');
  });

  it.each(['click', 'countdown'] as const)(
    'logs what happened in plain words, for a row picked by %s: no emoji and no prototype copy',
    async (pickedBy) => {
      const { hook, analysis } = await openPicker();
      await act(async () => {
        await hook.result.current.selectCandidate('c2', pickedBy);
      });
      lastStream().send({ type: 'complete', data: track });
      expect(analysis.closed).toBe(true);

      const messages = hook.result.current.logs.map((log) => log.message);
      expect(messages).toEqual([
        'Searching for "Hurt"',
        'Connected to the analysis server',
        'Multiple songs found. Please select the correct one.',
        'Resuming the analysis with the selected track',
        'Analysis complete.',
      ]);
      for (const message of messages) {
        expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(message).not.toMatch(/Ready for deployment|Connected to agent|Processing\.\.\./);
      }
    },
  );

  it("logs the picker with the server's own words, as a Spotify step and not a warning", async () => {
    const hook = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    const message = 'One possible track from Spotify; confirm it or search again';
    analysis.send({ ...interrupt(candidates.slice(0, 1)), message });

    expect(hook.result.current.status).toBe('disambiguation');
    expect(hook.result.current.statusNote).toBe(message);
    const last = hook.result.current.logs.at(-1);
    expect(last).toMatchObject({ message, node: 'scout' });
    expect(last?.code).toBeUndefined();
    expect(hook.result.current.logs.map((log) => log.message).join('\n')).not.toMatch(
      /Several tracks|Multiple matches/,
    );
  });

  it('keeps the time since the run started that a status line was sent with, and none without', async () => {
    const hook = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1', elapsedMs: 0 });
    analysis.send({
      type: 'status',
      message: 'Reading the track from Spotify',
      node: 'scout',
      elapsedMs: 24,
    });
    analysis.send({ type: 'status', message: 'Measuring tempo and key', node: 'engineer' });

    const logs = hook.result.current.logs;
    expect(logs.find((log) => log.message === 'Reading the track from Spotify')?.elapsedMs).toBe(
      24,
    );
    const untimed = logs.find((log) => log.message === 'Measuring tempo and key');
    expect(untimed).toBeDefined();
    expect(untimed).not.toHaveProperty('elapsedMs');
    // The page's own line, written before the stream opened, carries no time of the run.
    expect(logs.find((log) => log.message.startsWith('Searching for'))).not.toHaveProperty(
      'elapsedMs',
    );
  });

  it('gives every line a server event writes the time that event was sent with', async () => {
    const timeOf = (logs: Array<{ message: string; elapsedMs?: number }>, start: string) =>
      logs.find((log) => log.message.startsWith(start))?.elapsedMs;

    const { hook, analysis } = await openPicker();
    expect(timeOf(hook.result.current.logs, 'Connected')).toBeUndefined();
    analysis.send({ type: 'done' });

    const timed = await startAnalysis();
    const stream = lastStream();
    stream.send({ type: 'connected', threadId: 't1', elapsedMs: 0 });
    stream.send({ ...interrupt(), elapsedMs: 312 });
    expect(timeOf(timed.result.current.logs, 'Connected')).toBe(0);
    expect(timed.result.current.logs.at(-1)?.elapsedMs).toBe(312);

    const done = await startAnalysis();
    const result = lastStream();
    result.send({ type: 'connected', threadId: 't1', elapsedMs: 0 });
    result.send({ type: 'complete', data: track, elapsedMs: 20_167 });
    expect(timeOf(done.result.current.logs, 'Analysis complete')).toBe(20_167);
    expect(timeOf(done.result.current.logs, 'Searching for')).toBeUndefined();

    const failed = await startAnalysis();
    const errored = lastStream();
    errored.send({ type: 'connected', threadId: 't1', elapsedMs: 0 });
    errored.send({ type: 'error', code: 'timeout', error: 'Took too long.', elapsedMs: 90_000 });
    expect(timeOf(failed.result.current.logs, 'Error: ')).toBe(90_000);

    const ended = await startAnalysis();
    const cut = lastStream();
    cut.send({ type: 'connected', threadId: 't1', elapsedMs: 0 });
    cut.send({ type: 'done', elapsedMs: 4_250 });
    expect(timeOf(ended.result.current.logs, 'Error: The analysis ended without a result')).toBe(
      4_250,
    );
  });

  it('logs a neutral picker line when the server sends no words', async () => {
    const hook = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ ...interrupt(candidates.slice(0, 1)), message: '' });

    expect(hook.result.current.logs.at(-1)?.message).toBe('Pick the track to analyze');
    expect(hook.result.current.statusNote).toBe('Pick the track to analyze');
  });

  it('asks about one track when only one of the candidates sent can be read', async () => {
    const hook = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({
      ...interrupt(),
      candidates: [candidates[0], { title: 'Hurt', artist: 'Leona Lewis' }],
      message: '2 possible tracks from Spotify; choose one',
    });

    const question = 'One possible track from Spotify; confirm it or search again';
    expect(hook.result.current.statusNote).toBe(question);
    expect(hook.result.current.logs.at(-1)?.message).toBe(question);
  });

  it('counts the rows shown when the page cannot read one of the candidates sent', async () => {
    const hook = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({
      ...interrupt(),
      // The third has no id: it cannot be shown or picked.
      candidates: [...candidates, { title: 'Hurt', artist: 'Leona Lewis' }],
      message: '3 possible tracks from Spotify; choose one',
    });

    const question = '2 possible tracks from Spotify; choose one';
    expect(hook.result.current.candidates).toHaveLength(2);
    expect(hook.result.current.statusNote).toBe(question);
    expect(hook.result.current.logs.at(-1)?.message).toBe(question);
  });

  it("keeps the server's question for every row it sends, rows sharing an ISRC too", async () => {
    const hook = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    // Words that are not the picker's own count: kept only if the page did not rewrite them.
    const message = 'Pick one of these';
    const cash = {
      ...candidates[0],
      isrc: 'USUM70207211',
      releaseDate: '2002-11-05',
      explicit: false,
      durationMs: 218_000,
    };
    analysis.send({
      ...interrupt(),
      candidates: [cash, { ...cash, id: 'c3', album: 'C', releaseDate: '2008' }],
      message,
    });

    expect(hook.result.current.statusNote).toBe(message);
    expect(hook.result.current.candidates).toHaveLength(2);
  });

  // The API's order, from the recorded demo run: the historian reports before any await, the
  // engineer only after its health probe and preview lookup (research at 328 ms, AUDIO-INIT at
  // 753 ms, the engineer's result at 10 877 ms).
  async function realOrder() {
    const hook = await startAnalysis();
    const analysis = lastStream();
    const send = (node: string, message: string, code?: string) =>
      analysis.send({ type: 'status', node, message, ...(code ? { code } : {}) });
    analysis.send({ type: 'connected', threadId: 't1' });
    send('scout', 'Reading the track from Spotify', 'NET-100');
    send('scout', 'Found the track on Spotify: One More Time by Daft Punk', 'SPOTIFY-FOUND');
    return { hook, analysis, send };
  }

  it('shows the measurement while research runs, in the order the API sends them', async () => {
    const { hook, send } = await realOrder();
    const status = () => hook.result.current.status;
    send('historian', 'Starting the research: Last.fm, MusicBrainz', 'RESEARCH-START');
    expect(status()).toBe('researching');
    send('engineer', 'Measuring tempo and key from the preview clip', 'AUDIO-INIT');
    expect(status()).toBe('measuring');
    send('research_manager', 'Starting the research steps');
    send('research_tool', 'Searching: sample history on the web');
    send('research_manager', 'Choosing follow-up step 1 of at most 2');
    expect(status()).toBe('measuring');
    send(
      'engineer',
      'Measured 123 BPM; key not given: one pitch line without stable notes',
      'AUDIO-ERROR',
    );
    // The measurement is over and the research goes on.
    expect(status()).toBe('researching');
    send('composer', 'Writing the liner notes', 'LLM-CONNECT');
    expect(status()).toBe('composing');
  });

  it('keeps measuring for the whole measurement after a research cache hit', async () => {
    const { hook, send } = await realOrder();
    const stored = 'Using the research stored by an earlier run';
    send('historian', stored, 'RESEARCH-FOUND');
    expect(hook.result.current.status).toBe('researching');
    expect(hook.result.current.statusNote).toBe(stored);
    send('engineer', 'Measuring tempo and key from the preview clip', 'AUDIO-INIT');
    expect(hook.result.current.status).toBe('measuring');
    // A historian line during the measurement does not hide it.
    send('historian', 'Sources read', 'RESEARCH-FOUND');
    expect(hook.result.current.status).toBe('measuring');
    send('engineer', 'Measured from the preview: 123 BPM, A minor', 'AUDIO-COMPLETE');
    expect(hook.result.current.status).toBe('researching');
  });

  it('measures first when the engineer reports before the historian, as older runs did', async () => {
    const { hook, send } = await realOrder();
    send('engineer', 'Measuring tempo and key from the preview clip', 'AUDIO-INIT');
    expect(hook.result.current.status).toBe('measuring');
    send('historian', 'Starting the research', 'RESEARCH-START');
    expect(hook.result.current.status).toBe('measuring');
    send('engineer', 'Measured from the preview: 123 BPM, A minor', 'AUDIO-COMPLETE');
    expect(hook.result.current.status).toBe('researching');
  });

  it('never says it measures on an audio cache hit', async () => {
    const { hook, send } = await realOrder();
    send('engineer', 'Measured in an earlier run: 123 BPM, A minor', 'AUDIO-COMPLETE');
    expect(hook.result.current.status).toBe('analyzing');
    send('historian', 'Starting the research', 'RESEARCH-START');
    expect(hook.result.current.status).toBe('researching');
  });

  // The engineer and the historian run side by side: their lines arrive in any order. Whatever
  // the order, the run never goes back from the research (or the measurement beside it) to
  // reading the audio. (The bar's own guard is pinned in console/progress.test.ts.)
  it.each([
    ['a measurement', ['AUDIO-INIT', 'AUDIO-COMPLETE']],
    ['a partial measurement', ['AUDIO-INIT', 'AUDIO-ERROR']],
    ['an audio cache hit', ['AUDIO-COMPLETE']],
  ])(
    'never moves the step back, whatever the order of the engineer and historian (%s)',
    async (_, audio) => {
      const RANK: Partial<Record<string, number>> = {
        searching: 1,
        analyzing: 2,
        measuring: 3,
        researching: 3,
        composing: 4,
      };
      const research = ['RESEARCH-START', 'RESEARCH-FOUND'];
      // Every interleaving of the two branches' lines, each branch in its own order.
      const orders: string[][] = [];
      const merge = (a: string[], b: string[], done: string[]) => {
        if (a.length === 0 && b.length === 0) orders.push(done);
        if (a.length > 0) merge(a.slice(1), b, [...done, a[0]]);
        if (b.length > 0) merge(a, b.slice(1), [...done, b[0]]);
      };
      merge(audio, research, []);
      expect(orders.length).toBeGreaterThan(2);

      for (const order of orders) {
        const { hook, send } = await realOrder();
        const seen: string[] = [hook.result.current.status];
        for (const code of [...order, 'LLM-CONNECT']) {
          const node = code.startsWith('AUDIO')
            ? 'engineer'
            : code.startsWith('RESEARCH')
              ? 'historian'
              : 'composer';
          send(node, `${node} ${code}`, code);
          seen.push(hook.result.current.status);
        }
        const ranks = seen.map((status) => RANK[status] ?? 0);
        for (let n = 1; n < ranks.length; n++) {
          expect(ranks[n], `${order.join(' ')}: ${seen.join(' > ')}`).toBeGreaterThanOrEqual(
            ranks[n - 1],
          );
        }
        expect(seen.at(-1)).toBe('composing');
        hook.unmount();
      }
    },
  );

  it('says it reads the selected track after a pick, not that it reads the audio', async () => {
    const { hook } = await openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2', 'countdown');
    });
    expect(hook.result.current.status).toBe('analyzing');
    expect(hook.result.current.statusNote).toBe('Reading the track you selected...');
  });

  it("checks only on the verifier's model lines, not on its cover-art lookup", async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    const verifier = (code: string, message: string) =>
      analysis.send({ type: 'status', node: 'verifier', code, message });
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'status', node: 'composer', code: 'LLM-CONNECT', message: 'Writing' });
    verifier('GRAPH-ENRICH', 'Looking up cover art on Spotify for the genealogy');
    expect(result.current.status).toBe('composing');
    verifier('LLM-CONNECT', 'Checking the notes against their sources');
    expect(result.current.status).toBe('checking');
  });

  it("says the composer's fallback in the server's words, not that notes are being written", async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'status', node: 'composer', code: 'LLM-CONNECT', message: 'Writing' });
    expect(result.current.statusNote).toBeNull();
    const fallback = 'The model did not answer; showing source data only, with no written notes';
    analysis.send({ type: 'status', node: 'composer', code: 'LLM-ERROR', message: fallback });
    expect(result.current.status).toBe('composing');
    expect(result.current.statusNote).toBe(fallback);
  });
});

describe('useAgent run log', () => {
  const status = (message: string, code?: string) => ({
    type: 'status',
    node: 'research_tool',
    message,
    ...(code ? { code } : {}),
  });

  it('shows a line the server sends twice in a row once, without a new state', async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send(status('Searching: sample history on the web'));
    const before = result.current;
    analysis.send(status('Searching: sample history on the web'));
    expect(result.current).toBe(before);
    expect(
      result.current.logs.filter((log) => log.message === 'Searching: sample history on the web'),
    ).toHaveLength(1);
    // The same words again later, after another line, are a new line.
    analysis.send(status('Searching: Last.fm similar artists'));
    analysis.send(status('Searching: sample history on the web'));
    expect(result.current.logs.map((log) => log.message).slice(-3)).toEqual([
      'Searching: sample history on the web',
      'Searching: Last.fm similar artists',
      'Searching: sample history on the web',
    ]);
  });

  it("keeps the run's latest lines only, numbered in the run", async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    for (let n = 0; n < LOG_LIMIT + 10; n++) analysis.send(status(`Line ${n}`));
    const { logs } = result.current;
    expect(logs).toHaveLength(LOG_LIMIT);
    expect(logs.at(-1)?.message).toBe(`Line ${LOG_LIMIT + 9}`);
    // "Searching for…" and "Connected…" come first: 12 lines were dropped.
    expect(logs[0].index).toBe(12);
  });

  it('starts the numbering again for a new run', async () => {
    const { result } = await startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    await act(async () => {
      await result.current.analyze('Another song');
    });
    expect(result.current.logs.map((log) => [log.message, log.index])).toEqual([
      ['Searching for "Another song"', 0],
    ]);
  });
});

describe('useAgent track picker', () => {
  it('keeps the picker when the analysis stream ends after the interrupt', async () => {
    const { hook, analysis } = await openPicker();
    analysis.send({ type: 'done' });
    analysis.fail();

    expect(hook.result.current.status).toBe('disambiguation');
    expect(hook.result.current.candidates).toHaveLength(2);
    expect(analysis.closed).toBe(true);
  });

  it('opens the picker on the interrupt only: a candidates event is not part of the protocol', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = await startAnalysis();
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
    const { hook } = await openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2', pickedBy);
    });

    const [resume] = streams().filter((s) => s.url.includes('/resume'));
    expect(resume.url).toContain(`selectedTrackId=c2${param}`);
  });

  it('without a thread, asks for the picked row by id with the searched text and how it was picked', async () => {
    const hook = await startAnalysis('Hurt');
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
    await tokenSettled();
    expect(lastStream().url).toContain(`&trackId=${rows[1].id}&pickedBy=countdown`);
  });

  it('without a thread, ends with an error for a row that has no Spotify id', async () => {
    const hook = await startAnalysis('Hurt');
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: '' });
    analysis.send({ ...interrupt(), threadId: '' });
    const opened = streams().length;

    await act(async () => {
      await hook.result.current.selectCandidate('c2', 'click');
    });

    // The ambiguous text is not searched again.
    expect(streams()).toHaveLength(opened);
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error).toContain('could not be found again');
    expect(hook.result.current.errorCode).toBe('choice_lost');
  });

  it('opens one resume per picker and closes the analysis stream', async () => {
    const { hook, analysis } = await openPicker();
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
    const { hook } = await openPicker();
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
      'Live analysis is unavailable: replaying the recording of the selected track.',
    );
    search.send({ type: 'complete', data: track });
    expect(hook.result.current.status).toBe('complete');
  });

  it('never shows another take than the one picked', async () => {
    // c1 shares the picked track's title, but only c1 is recorded.
    recordings({ id: 'c1', title: 'Hurt', artist: 'Nine Inch Nails' });
    const { hook } = await openPicker();
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
    const second = await openPicker();
    await act(async () => {
      await second.hook.result.current.selectCandidate('c2');
    });
    lastStream().send({ type: 'error', code: 'live_disabled', error: 'off' });
    await settle();
    expect(second.hook.result.current.errorCode).toBe('live_disabled');
  });

  it('does not show a replayed result of another track than the one asked for', async () => {
    recordings({ id: 'c2', title: 'Hurt', artist: 'Nine Inch Nails' });
    const { hook } = await openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2');
    });
    lastStream().send({ type: 'error', code: 'budget_exhausted', error: 'paused' });
    await settle();
    lastStream().send({ type: 'complete', data: { ...track, id: 'someone-else' } });
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.trackData).toBeNull();
  });

  it('says a run is a replay from the replay notice on, and ends it as a replay', async () => {
    const { result } = await startAnalysis('Hurt Nine Inch Nails');
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
      'Recorded analysis replayed. Nothing was analyzed live.',
    );
    expect(completeLogs(result.current.logs)).toBe(0);
    await act(async () => {
      await result.current.analyze('Another');
    });
    expect(result.current.isReplay).toBe(false);
  });

  it('does not take a run whose model answers came from stored answers for a recording', async () => {
    const { result } = await startAnalysis('Hurt Nine Inch Nails');
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
    await act(async () => {
      await result.current.analyze('Hurt Nine Inch Nails');
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
    const { hook, analysis } = await openPicker();
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
    const { hook } = await openPicker();
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

  it('never times out a stream that has sent no heartbeat', async () => {
    const { result } = await startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    act(() => vi.advanceTimersByTime(10 * 60_000));

    expect(result.current.status).not.toBe('error');
    expect(lastStream().closed).toBe(false);
  });

  it('stays quiet while heartbeats arrive and fails after a silence once armed', async () => {
    const { result } = await startAnalysis();
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
    expect(result.current.errorCode).toBe('stream_stalled');
    expect(analysis.closed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts other events as activity once armed', async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.sendNamed('heartbeat');
    act(() => vi.advanceTimersByTime(40_000));
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing' });
    act(() => vi.advanceTimersByTime(40_000));

    expect(result.current.status).toBe('analyzing');
  });

  it('does not fail a run that already has its result', async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.sendNamed('heartbeat');
    analysis.send({ type: 'complete', data: track });
    act(() => vi.advanceTimersByTime(STREAM_INACTIVITY_TIMEOUT_MS));

    expect(result.current.status).toBe('complete');
    expect(analysis.closed).toBe(true);
  });
});

describe('useAgent factoid stream', () => {
  /** A result as the Player shows it, with its own run (live) unless `run` says otherwise. */
  const result = (run: TrackData['run'] | null = { id: 'run-1', mode: 'live' }) =>
    ({
      ...track,
      factoids: [factoid('s1')],
      ...(run ? { run } : {}),
    }) as unknown as TrackData;
  const query = (stream: FakeEventSource) => new URL(stream.url, 'http://x').searchParams;
  /** A claim as the API sends one with a fact. */
  const claim = (id: string) => ({
    id,
    text: `Claim ${id}`,
    about: 'trivia',
    kind: 'inferred',
    origin: 'model',
    evidenceIds: [],
    verdict: null,
    verdictReason: null,
    numericCheck: 'n/a',
  });
  /**
   * Asks for more facts, as a click does (its state changes are applied at once), and waits for
   * the stream to open (the run token comes first). The answer is in a list, so awaiting this
   * does not wait for it.
   */
  async function ask(
    hook: { current: UseAgentReturn },
    ...args: Parameters<UseAgentReturn['moreFactoidsStream']>
  ) {
    let pending!: ReturnType<UseAgentReturn['moreFactoidsStream']>;
    act(() => {
      pending = hook.current.moreFactoidsStream(...args);
    });
    // A rejection is handled by the test that awaits it.
    pending.catch(() => {});
    await tokenSettled();
    return [pending] as const;
  }
  /** One answer: `connected` naming the next round, the events given, then `done`. */
  function answer(stream: FakeEventSource, nextRound: number | undefined, ...events: object[]) {
    stream.send({ type: 'connected', ...(nextRound === undefined ? {} : { nextRound }) });
    for (const event of events) stream.send(event as { type: string });
    stream.send({ type: 'done' });
  }

  it("asks for the first round with the result's own run id", async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [pending] = await ask(hook, result());
    const stream = lastStream();
    expect(new URL(stream.url, 'http://x').pathname).toBe('/api/factoids/more/stream');
    expect(query(stream).get('runId')).toBe('run-1');
    expect(query(stream).get('round')).toBe('0');
    expect(query(stream).get('existingIds')).toBe('s1');
    answer(stream, 1);
    await pending;
  });

  it('asks the second click for the round the first answer named, with its facts as known', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [first] = await ask(hook, result());
    answer(lastStream(), 1, { type: 'factoid', data: factoid('fc-a') });
    await first;

    const [second] = await ask(hook, result());
    expect(streams()).toHaveLength(2);
    expect(query(lastStream()).get('round')).toBe('1');
    expect(query(lastStream()).get('existingIds')).toBe('s1,fc-a');
    answer(lastStream(), 2);
    await second;
  });

  it('makes no request once every round has been asked, and says so in its state', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [first] = await ask(hook, result());
    answer(lastStream(), 1);
    await first;
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 1, finished: false });
    const [second] = await ask(hook, result());
    answer(lastStream(), 2);
    await second;
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 2, finished: true });

    const [third] = await ask(hook, result());
    expect(streams()).toHaveLength(2);
    await expect(third).resolves.toEqual([]);
  });

  it('keeps every claim once, by its id, and every fact once, across clicks', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [first] = await ask(hook, result());
    answer(lastStream(), 1, {
      type: 'factoid',
      data: { ...factoid('fc-a'), claimId: 'c-a' },
      claim: claim('c-a'),
    });
    await expect(first).resolves.toMatchObject([{ id: 'fc-a' }]);

    const [second] = await ask(hook, result());
    answer(
      lastStream(),
      2,
      { type: 'factoid', data: { ...factoid('fc-b'), claimId: 'c-b' }, claim: claim('c-b') },
      // The same fact and claim again (an older server that resends them).
      { type: 'factoid', data: { ...factoid('fc-a'), claimId: 'c-a' }, claim: claim('c-a') },
    );
    expect((await second).map((fact) => fact.id)).toEqual(['fc-b']);

    const kept = hook.current.moreFacts;
    expect(kept?.factoids.map((fact) => fact.id)).toEqual(['fc-a', 'fc-b']);
    expect(Object.keys(kept?.claims ?? {})).toEqual(['c-a', 'c-b']);
    expect(kept?.claims['c-b']).toEqual(claim('c-b'));
  });

  it('keeps the other facts when one fact of the answer failed, and says which', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result: hook } = renderHook(() => useAgent());
    const [pending] = await ask(hook, result());
    answer(
      lastStream(),
      1,
      { type: 'error', code: 'failed', error: 'This fact could not be generated.', index: 1 },
      { type: 'factoid', data: factoid('fc-a') },
      { type: 'factoid', data: factoid('fc-c') },
    );

    expect((await pending).map((fact) => fact.id)).toEqual(['fc-a', 'fc-c']);
    expect(hook.current.moreFacts?.factoids.map((fact) => fact.id)).toEqual(['fc-a', 'fc-c']);
    expect(hook.current.moreFacts?.failed).toEqual([{ index: 1, code: 'failed' }]);
    expect(hook.current.moreFacts?.nextRound).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    // The next click starts with no failure of its own.
    await ask(hook, result());
    expect(hook.current.moreFacts?.failed).toEqual([]);
  });

  /** Every fact of an answer failed with this code. */
  const allFailed = (code: string) =>
    [0, 1, 2].map((index) => ({ type: 'error', code, error: 'Not written.', index }));

  it('keeps the round when every fact of an answer failed, so the control is not spent', async () => {
    const { result: hook } = renderHook(() => useAgent());
    // The API names the next round before it writes anything (as it does).
    for (const nextRound of [1, 2]) {
      const [pending] = await ask(hook, result());
      expect(query(lastStream()).get('round')).toBe('0');
      answer(lastStream(), nextRound, ...allFailed('failed'));
      expect(await pending).toEqual([]);
    }
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 0, finished: false });
    expect(hook.current.moreFacts?.failed).toHaveLength(3);

    const [third] = await ask(hook, result());
    expect(streams()).toHaveLength(3);
    expect(query(lastStream()).get('round')).toBe('0');
    answer(lastStream(), 1);
    await third;
  });

  it.each([
    ['a paused budget for every fact', allFailed('budget_exhausted')],
    [
      'a paused budget for one fact, beside a fact written',
      [
        { type: 'factoid', data: factoid('fc-a') },
        { type: 'error', code: 'budget_exhausted', error: 'Paused.', index: 1 },
      ],
    ],
    ['an error for the whole answer', [{ type: 'error', code: 'failed', error: 'Not written.' }]],
    ['live calls switched off', [{ type: 'error', code: 'live_disabled', error: 'Off.' }]],
  ])('keeps the round after %s', async (_label, events) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result: hook } = renderHook(() => useAgent());
    for (const nextRound of [1, 2]) {
      const [pending] = await ask(hook, result());
      expect(query(lastStream()).get('round')).toBe('0');
      answer(lastStream(), nextRound, ...events);
      await pending;
    }
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 0, finished: false });
  });

  it("prefers the API's word on whether rounds are left over its own count", async () => {
    const early = renderHook(() => useAgent()).result;
    const [first] = await ask(early, result());
    lastStream().send({ type: 'connected', nextRound: 1, roundsLeft: false });
    lastStream().send({ type: 'done' });
    await first;
    expect(early.current.moreFacts).toMatchObject({ nextRound: 1, finished: true });

    const late = renderHook(() => useAgent()).result;
    const [second] = await ask(late, result());
    lastStream().send({ type: 'connected', nextRound: 2, roundsLeft: true });
    lastStream().send({ type: 'done' });
    await second;
    expect(late.current.moreFacts).toMatchObject({ nextRound: 2, finished: false });
  });

  it('asks round 0 again after the API could not write some of its facts, then round 1', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const busy = (index: number) => ({
      type: 'error',
      code: 'rate_limited',
      error: 'Busy.',
      index,
    });
    const [first] = await ask(hook, result());
    answer(lastStream(), 1, { type: 'factoid', data: factoid('fc-a') }, busy(1), busy(2));
    await first;
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 0, finished: false });

    // The API asks round 0's angles again (the round sent is the round asked).
    const [second] = await ask(hook, result());
    expect(query(lastStream()).get('round')).toBe('0');
    expect(query(lastStream()).get('existingIds')).toBe('s1,fc-a');
    lastStream().send({ type: 'connected', nextRound: 1, roundsLeft: true });
    lastStream().send({ type: 'factoid', data: factoid('fc-b') });
    lastStream().send({ type: 'done' });
    await second;
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 1, finished: false });

    const [third] = await ask(hook, result());
    expect(query(lastStream()).get('round')).toBe('1');
    lastStream().send({ type: 'connected', nextRound: 2, roundsLeft: false });
    lastStream().send({ type: 'done' });
    await third;
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 2, finished: true });
  });

  it.each([
    ['an error for the whole answer', 'error'],
    ['a stream that broke', 'broke'],
    ['a stream that stopped responding', 'silent'],
  ] as const)('says when %s, and clears it on the next click', async (_label, how) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result: hook } = renderHook(() => useAgent());
    if (how === 'silent') vi.useFakeTimers();
    const [pending] = await ask(hook, result());
    pending.catch(() => {});
    lastStream().send({ type: 'connected', nextRound: 1 });
    if (how === 'error') {
      lastStream().send({ type: 'error', code: 'failed', error: 'Not written.' });
      lastStream().send({ type: 'done' });
      await pending;
    } else if (how === 'broke') {
      lastStream().fail();
      await expect(pending).rejects.toThrow();
    } else {
      lastStream().sendNamed('heartbeat');
      act(() => {
        vi.advanceTimersByTime(STREAM_INACTIVITY_TIMEOUT_MS + 1);
      });
      await expect(pending).rejects.toThrow('stopped responding');
    }
    expect(hook.current.moreFacts).toMatchObject({ answerFailed: true, nextRound: 0 });

    await ask(hook, result());
    expect(hook.current.moreFacts?.answerFailed).toBe(false);
  });

  it('is not a failure when the caller leaves', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const controller = new AbortController();
    const [pending] = await ask(hook, result(), { signal: controller.signal });
    act(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(hook.current.moreFacts?.answerFailed).toBe(false);
  });

  it('lets the facts go on reset, also for a result with the same run id', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [first] = await ask(hook, result());
    answer(lastStream(), 1, { type: 'factoid', data: factoid('fc-a') });
    await first;

    act(() => hook.current.reset());
    expect(hook.current.moreFacts).toBeNull();
    const [again] = await ask(hook, result());
    expect(query(lastStream()).get('round')).toBe('0');
    expect(query(lastStream()).get('existingIds')).toBe('s1');
    answer(lastStream(), 1);
    await again;
  });

  it('lets the facts go when a new analysis starts, also for a result with the same run id', async () => {
    const hook = await startAnalysis();
    const [first] = await ask(hook.result, result());
    answer(lastStream(), 1, { type: 'factoid', data: factoid('fc-a') });
    await first;
    expect(hook.result.current.moreFacts?.factoids).toHaveLength(1);

    await act(async () => {
      await hook.result.current.analyze('Hurt');
    });
    expect(hook.result.current.moreFacts).toBeNull();
    lastStream().send({ type: 'complete', data: track });
    expect(hook.result.current.moreFacts).toBeNull();

    // The same track, with the same run id: nothing of the earlier page is kept or sent.
    const [again] = await ask(hook.result, result());
    expect(query(lastStream()).get('round')).toBe('0');
    expect(query(lastStream()).get('existingIds')).toBe('s1');
    expect(hook.result.current.moreFacts?.factoids).toEqual([]);
    answer(lastStream(), 1);
    await again;
  });

  it('keeps the run whose evidence the facts were checked against, or none', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [checked] = await ask(hook, result());
    const stream = lastStream();
    for (const [seq, event] of [
      { type: 'connected', nextRound: 1 },
      { type: 'factoid', data: factoid('fc-a') },
      { type: 'done' },
    ].entries()) {
      stream.send({ ...event, runId: 'run-1', seq });
    }
    await checked;
    expect(hook.current.moreFacts?.runId).toBe('run-1');

    // The API had no stored result for the run: its stream names none.
    const [unchecked] = await ask(hook, result());
    answer(lastStream(), 2, { type: 'factoid', data: factoid('fc-b') });
    await unchecked;
    expect(hook.current.moreFacts?.runId).toBeNull();
  });

  it("sends no run id for a result that names none, never the analysis thread's", async () => {
    const hook = await startAnalysis();
    lastStream().send({ type: 'connected', threadId: 't1' });
    lastStream().send({ type: 'complete', data: track });
    const [pending] = await ask(hook.result, result(null));
    expect(query(lastStream()).has('runId')).toBe(false);
    expect(query(lastStream()).get('round')).toBe('0');
    answer(lastStream(), 1);
    await pending;
  });

  it("starts from the first round for another result, and lets the first one's facts go", async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [first] = await ask(hook, result());
    answer(lastStream(), 1, { type: 'factoid', data: factoid('fc-a') });
    await first;

    const other = { ...result({ id: 'run-2', mode: 'live' }), id: 'c9' } as TrackData;
    const [pending] = await ask(hook, other);
    expect(query(lastStream()).get('round')).toBe('0');
    expect(query(lastStream()).get('runId')).toBe('run-2');
    expect(query(lastStream()).get('existingIds')).toBe('s1');
    expect(hook.current.moreFacts?.factoids).toEqual([]);
    answer(lastStream(), 1);
    await pending;
  });

  it('asks the same round again after a stream that broke', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [broken] = await ask(hook, result());
    lastStream().send({ type: 'connected', nextRound: 1 });
    lastStream().fail();
    await expect(broken).rejects.toThrow('Factoid stream connection failed');

    const [again] = await ask(hook, result());
    expect(query(lastStream()).get('round')).toBe('0');
    answer(lastStream(), 1);
    await again;
  });

  it('closes the stream and rejects when a new analysis starts', async () => {
    const { result: hook } = await startAnalysis();
    lastStream().send({ type: 'complete', data: track });
    const [pending] = await ask(hook, result());
    const more = lastStream();
    more.send({ type: 'factoid', data: factoid('f1') });

    act(() => hook.current.reset());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(more.closed).toBe(true);
    more.send({ type: 'factoid', data: factoid('f2') }, { late: true });
    expect(hook.current.moreFacts).toBeNull();
  });

  it("closes the stream when the caller's signal aborts", async () => {
    const { result: hook } = renderHook(() => useAgent());
    const controller = new AbortController();
    const [pending] = await ask(hook, result(), { signal: controller.signal });
    const more = lastStream();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(more.closed).toBe(true);
  });

  it('reports the rate limit and a paused budget to the caller, and goes on', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const onUnavailable = vi.fn();
    const [pending] = await ask(hook, result(), { onUnavailable });
    const more = lastStream();
    more.send({ type: 'error', code: 'rate_limited', error: 'busy', index: 0 });
    more.send({ type: 'error', code: 'budget_exhausted', error: 'paused', index: 1 });
    more.send({ type: 'error', code: 'failed', error: 'x', index: 2 });
    more.send({ type: 'factoid', data: factoid('f1') });
    more.send({ type: 'done' });

    expect(await pending).toHaveLength(1);
    expect(onUnavailable.mock.calls).toEqual([['rate_limited'], ['budget_exhausted']]);
    expect(hook.current.moreFacts?.failed.map((failure) => failure.index)).toEqual([0, 1, 2]);
  });

  it('reports a replayed result whose recording is no longer served', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const onUnavailable = vi.fn();
    const recorded = result({ id: 'run-1', mode: 'replay', replayed: 'run' });
    const [pending] = await ask(hook, recorded, { onUnavailable });
    lastStream().send({ type: 'error', code: 'not_found', error: 'gone' });
    lastStream().send({ type: 'done' });
    await pending;
    expect(onUnavailable.mock.calls).toEqual([['not_found']]);
  });

  it("sends the result's run mode, so more facts stay on its side", async () => {
    const { result: hook } = renderHook(() => useAgent());
    const recorded = result({ id: 'run-1', mode: 'replay', replayed: 'run' });
    const [pending] = await ask(hook, recorded);
    const more = lastStream();
    expect(query(more).get('mode')).toBe('replay');
    // Recorded facts name no round: the next click asks the same round again.
    more.send({ type: 'done' });
    await pending;
    expect(hook.current.moreFacts).toMatchObject({ nextRound: 0, finished: false });
    const [older] = await ask(hook, result(null));
    expect(query(lastStream()).has('mode')).toBe(false);
    lastStream().send({ type: 'done' });
    await older;
  });

  it('reports live calls switched off (a server that replays recordings only)', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const onUnavailable = vi.fn();
    const [pending] = await ask(hook, result(), { onUnavailable });
    const more = lastStream();
    more.send({ type: 'error', code: 'live_disabled', error: 'off' });
    more.send({ type: 'done' });

    await pending;
    expect(onUnavailable.mock.calls).toEqual([['live_disabled']]);
    expect(hook.current.moreFacts?.failed).toEqual([]);
  });

  it('resolves on done', async () => {
    const { result: hook } = renderHook(() => useAgent());
    const [pending] = await ask(hook, result());
    lastStream().send({ type: 'done' });

    await expect(pending).resolves.toEqual([]);
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
  it('arms the watchdog on heartbeats sent as data messages', async () => {
    vi.useFakeTimers();
    const { result } = await startAnalysis();
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
    const { result } = await startAnalysis();
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
    const { result } = await startAnalysis('Hurt');
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
    await tokenSettled();
    expect(lastStream().url).toContain('/api/analyze/stream?query=Hurt');
    expect(result.current.errorCode).toBeNull();
  });
});

// Every message is parsed with the contract's schema; repeats, events of another run and a
// second result of the run are dropped (agent/events.ts).
describe('useAgent typed events', () => {
  it('skips unknown types and events that do not fit the contract, logging each kind once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'mystery', detail: 'from a newer server' });
    analysis.send({ type: 'mystery', detail: 'again' });
    analysis.send({ type: 'status', node: 'engineer' });
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing' }, { raw: true });

    expect(result.current.status).not.toBe('error');
    expect(result.current.logs.map((log) => log.message)).toEqual([
      'Searching for "Hurt"',
      'Connected to the analysis server',
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('(mystery): unknown type'),
      expect.stringContaining('(status): does not fit the contract'),
    ]);

    analysis.send({ type: 'complete', data: track });
    expect(result.current.status).toBe('complete');
  });

  it('drops an event repeated with the same seq, and one that arrives out of order', async () => {
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing', seq: 5 });
    analysis.send({ type: 'status', node: 'engineer', message: 'Analyzing', seq: 5 });
    analysis.send({ type: 'status', node: 'engineer', message: 'Earlier', seq: 3 });

    const messages = result.current.logs.map((log) => log.message);
    expect(messages.filter((message) => message === 'Analyzing')).toHaveLength(1);
    expect(messages).not.toContain('Earlier');
  });

  it("ignores events of another run on the run's stream", async () => {
    const { result } = await startAnalysis();
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
    const { hook, analysis } = await openPicker();
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

  it('shows a result from a newer API that this page reads leniently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await startAnalysis();
    const analysis = lastStream();
    analysis.send({ type: 'connected', threadId: 't1' });
    analysis.send({
      type: 'complete',
      data: { ...track, run: { id: 't1', mode: 'replay-v2', fallback: false } },
    });

    expect(result.current.status).toBe('complete');
    expect(result.current.trackData?.title).toBe('Hurt');
  });

  it('opens the picker on an interrupt from a newer API', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await startAnalysis();
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
    const { hook } = await openPicker();
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
    const pending = result.current.moreFactoidsStream({
      ...track,
      factoids: [],
    } as unknown as TrackData);
    await tokenSettled();
    const more = lastStream();
    more.send({ type: 'connected' });
    more.send({ type: 'factoid', data: { ...factoid('f1'), type: 'lyrics' } });
    more.send({ type: 'factoid', data: factoid('f2') });
    more.send({ type: 'factoid', data: factoid('f2'), seq: 2 });
    more.send({ type: 'done' });

    expect((await pending).map((data) => data.id)).toEqual(['f2']);
  });
});

describe('useAgent run tokens', () => {
  const tokenOf = (stream: FakeEventSource) =>
    new URL(stream.url, 'http://x').searchParams.get('runToken');
  const moreFactsOf = () =>
    ({ ...track, factoids: [], run: { id: 'run-1', mode: 'live' } }) as unknown as TrackData;

  it('asks for a token with the bypass when no site key is set, one per analysis', async () => {
    const { result } = await startAnalysis('Hurt');
    expect(requestRunToken).toHaveBeenLastCalledWith('dev-bypass', expect.any(AbortSignal));
    expect(tokenOf(lastStream())).toBe('token-1');

    lastStream().fail();
    act(() => result.current.retry());
    await tokenSettled();
    expect(tokenOf(lastStream())).toBe('token-2');

    await act(async () => {
      await result.current.analyze('Another', { trackId: '28cnXtME493VX9NOw9cIUh' });
    });
    expect(tokenOf(lastStream())).toBe('token-3');
    expect(lastStream().url).toContain('&trackId=28cnXtME493VX9NOw9cIUh&runToken=token-3');
  });

  it("resumes with the run's own token, without asking for another", async () => {
    const { hook } = await openPicker();
    await act(async () => {
      await hook.result.current.selectCandidate('c2', 'click');
    });
    expect(lastStream().url).toContain('/analyze/stream/resume?threadId=t1&selectedTrackId=c2');
    expect(tokenOf(lastStream())).toBe('token-1');
    expect(requestRunToken).toHaveBeenCalledTimes(1);
  });

  it('asks for more facts with the latest token while it lasts, or else a new one', async () => {
    // A result shown without an analysis on this page (a stored run): a token of its own.
    const { result } = renderHook(() => useAgent());
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.moreFactoidsStream(moreFactsOf());
    });
    await tokenSettled();
    expect(tokenOf(lastStream())).toBe('token-1');
    lastStream().send({ type: 'done' });
    await act(() => pending);

    // The same token again, while it is good.
    act(() => {
      pending = result.current.moreFactoidsStream(moreFactsOf());
    });
    expect(tokenOf(lastStream())).toBe('token-1');
    lastStream().send({ type: 'done' });
    await act(() => pending);

    // After an analysis, its token.
    await act(async () => {
      await result.current.analyze('Hurt');
    });
    expect(tokenOf(lastStream())).toBe('token-2');
    act(() => {
      pending = result.current.moreFactoidsStream(moreFactsOf());
    });
    expect(tokenOf(lastStream())).toBe('token-2');
    lastStream().send({ type: 'done' });
    await act(() => pending);
    expect(requestRunToken).toHaveBeenCalledTimes(2);
  });

  it('asks for a new token for more facts once the one held is about to expire', async () => {
    vi.mocked(requestRunToken).mockResolvedValueOnce({
      runToken: 'short-lived',
      expiresAt: Date.now() + 10_000,
    });
    const { result } = await startAnalysis('Hurt');
    expect(tokenOf(lastStream())).toBe('short-lived');

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.moreFactoidsStream(moreFactsOf());
    });
    await tokenSettled();
    expect(tokenOf(lastStream())).toBe('token-1');
    lastStream().send({ type: 'done' });
    await act(() => pending);
  });

  it("ends the run with the API's refusal when no token is given, and opens no stream", async () => {
    vi.mocked(requestRunToken).mockRejectedValueOnce(
      new RunTokenError('Too many requests. Please try again later.', 'rate_limited'),
    );
    const { result } = await startAnalysis('Hurt');
    expect(streams()).toHaveLength(0);
    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('rate_limited');
    expect(result.current.error).toBe('Too many requests. Please try again later.');

    // No answer: the connection failed.
    vi.mocked(requestRunToken).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => {
      await result.current.analyze('Hurt');
    });
    expect(streams()).toHaveLength(0);
    expect(result.current.errorCode).toBe('connection_lost');

    // An answer this page cannot read (a proxy's error page).
    vi.mocked(requestRunToken).mockRejectedValueOnce(
      new RunTokenError('Run token refused (HTTP 502)', null),
    );
    await act(async () => {
      await result.current.analyze('Hurt');
    });
    expect(streams()).toHaveLength(0);
    expect(result.current.errorCode).toBe('stream_open_failed');
  });

  /** Asks for more facts and returns the stream it opened, once the token is in. */
  async function askMore(result: { current: UseAgentReturn }) {
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.moreFactoidsStream(moreFactsOf());
    });
    pending.catch(() => {});
    await tokenSettled();
    return { stream: lastStream(), pending };
  }

  it('asks for a new token, once, after the API refused the one held for more facts', async () => {
    const { result } = renderHook(() => useAgent());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await askMore(result);
    expect(tokenOf(first.stream)).toBe('token-1');
    first.stream.send({ type: 'error', code: 'auth_expired', error: 'Check again.' });
    first.stream.send({ type: 'done' });
    await act(() => first.pending);
    // Nothing is asked for by itself.
    expect(requestRunToken).toHaveBeenCalledTimes(1);

    const second = await askMore(result);
    expect(tokenOf(second.stream)).toBe('token-2');
    second.stream.send({ type: 'done' });
    await act(() => second.pending);
    const third = await askMore(result);
    expect(tokenOf(third.stream)).toBe('token-2');
    expect(requestRunToken).toHaveBeenCalledTimes(2);
  });

  it('asks for a new token after a more-facts stream failed (a 401 reads as one)', async () => {
    const { result } = renderHook(() => useAgent());
    const first = await askMore(result);
    first.stream.fail();
    await act(async () => {
      await expect(first.pending).rejects.toThrow('Factoid stream connection failed');
    });
    expect(requestRunToken).toHaveBeenCalledTimes(1);
    const second = await askMore(result);
    expect(tokenOf(second.stream)).toBe('token-2');
  });

  it('does not ask for more facts with a token the API refused on the analysis', async () => {
    const { result } = await startAnalysis('Hurt');
    lastStream().send({ type: 'error', code: 'auth_expired', error: 'Check again.' });
    expect(result.current.errorCode).toBe('auth_expired');
    const more = await askMore(result);
    expect(tokenOf(more.stream)).toBe('token-2');
  });

  it('says the server did not accept a stream it refused, and drops its token', async () => {
    const { result } = await startAnalysis('Hurt');
    lastStream().refuse();
    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('stream_refused');
    const more = await askMore(result);
    expect(tokenOf(more.stream)).toBe('token-2');

    // A resume refused the same way.
    const picker = await openPicker();
    await act(async () => {
      await picker.hook.result.current.selectCandidate('c2', 'click');
    });
    lastStream().refuse();
    expect(picker.hook.result.current.errorCode).toBe('stream_refused');
    // A connection that drops once open is still a lost connection.
    const dropped = await startAnalysis('Hurt');
    lastStream().fail();
    expect(dropped.result.current.errorCode).toBe('connection_lost');
  });

  it('says more facts could not be asked for when no token is given', async () => {
    vi.mocked(requestRunToken).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useAgent());
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.moreFactoidsStream(moreFactsOf());
    });
    await act(async () => {
      await expect(pending).rejects.toThrow('Failed to fetch');
    });
    expect(streams()).toHaveLength(0);
    expect(result.current.moreFacts?.answerFailed).toBe(true);
    expect(result.current.moreFacts?.nextRound).toBe(0);
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

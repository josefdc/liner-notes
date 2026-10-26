import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStoredRun } from './storedRun';

const ID = '4cOdK2wGLETKBW3PvgPWqT';
const run = {
  id: 'thread-stored',
  status: 'completed',
  mode: 'live',
  spotifyId: ID,
  createdAt: '2026-10-20T10:00:00.000Z',
  finishedAt: '2026-10-20T10:01:30.000Z',
};
const analysis = { id: ID, title: 'Bright Lines', artist: 'Test Artist', album: 'Lines' };

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchStoredRun', () => {
  it("reads the track's stored result from GET /api/runs/by-track/:id", async () => {
    const fetchMock = answer(200, { success: true, run, analysis });
    const result = await fetchStoredRun(ID);
    expect(fetchMock).toHaveBeenCalledWith(`/api/runs/by-track/${ID}`, {
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({ kind: 'found', track: analysis });
  });

  it('never shows a measurement the contract cannot read as measured', async () => {
    answer(200, { success: true, run, analysis: { ...analysis, audio: { bpm: 'fast' } } });
    const result = await fetchStoredRun(ID);
    expect(result).toEqual({
      kind: 'found',
      track: { ...analysis, audio: null, audioUnreadable: true },
    });
  });

  it('fails for a result whose measured copies disagree with its measurement', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // An older row: no measurement, yet BPM 105 and A minor at the top.
    answer(200, {
      success: true,
      run,
      analysis: { ...analysis, audio: null, bpm: 105, key: 'A Minor', energy: 0.8 },
    });
    expect(await fetchStoredRun(ID)).toEqual({ kind: 'failed' });
    // A measurement the contract cannot read counts as none: its copies are not shown either.
    answer(200, {
      success: true,
      run,
      analysis: { ...analysis, audio: { bpm: 'fast' }, bpm: 105 },
    });
    expect(await fetchStoredRun(ID)).toEqual({ kind: 'failed' });
  });

  it("is missing for the API's not_found, and invalid for its invalid_input", async () => {
    answer(404, { success: false, code: 'not_found', error: 'Not found.' });
    expect(await fetchStoredRun(ID)).toEqual({ kind: 'missing' });
    answer(400, { success: false, code: 'invalid_input', error: 'The request is not valid.' });
    expect(await fetchStoredRun('nope')).toEqual({ kind: 'invalid' });
  });

  it('fails for anything else, and never shows another track under this one', async () => {
    const cases: Array<[number, unknown]> = [
      [404, '<html>Not Found</html>'],
      [500, { success: false, code: 'failed', error: 'The request could not be completed.' }],
      [502, 'Bad Gateway'],
      [200, 'not json'],
      [200, { success: true, run, analysis: { ...analysis, id: '7ouMYWpwJ422jRcDASZB7P' } }],
      [200, { success: true, run, analysis: 'text' }],
    ];
    for (const [status, body] of cases) {
      answer(status, body);
      expect(await fetchStoredRun(ID), `${status} ${JSON.stringify(body)}`).toEqual({
        kind: 'failed',
      });
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await fetchStoredRun(ID)).toEqual({ kind: 'failed' });
  });

  it('is missing for a run of the track without a result of its own', async () => {
    answer(200, { success: true, run, analysis: null });
    expect(await fetchStoredRun(ID)).toEqual({ kind: 'missing' });
  });

  it('fails when the API does not answer in time, and stops waiting for it', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            seen = init?.signal;
            // A request that hangs until it is aborted, as fetch does.
            seen?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fetchStoredRun(ID, undefined, 50)).toEqual({ kind: 'failed' });
    expect(seen?.aborted).toBe(true);
  });

  it('rejects when its signal aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }),
    );
    await expect(fetchStoredRun(ID, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

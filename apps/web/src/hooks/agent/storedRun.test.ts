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
    expect(fetchMock).toHaveBeenCalledWith(`/api/runs/by-track/${ID}`, { signal: undefined });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackData } from '../../types';
import { RunTokenError, requestRunToken } from './apiClient';
import { moreFactsUrl, newMoreFacts } from './moreFacts';
import {
  DEV_BYPASS_TOKEN,
  isUsable,
  newRunToken,
  RUN_TOKEN_MARGIN_MS,
  withRunToken,
} from './runToken';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () =>
    json({ success: true, runToken: 'v1.a.b', expiresAt: '2026-10-27T12:30:00.000Z' }),
  );
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('requestRunToken', () => {
  it('posts the Turnstile token to /api/runs and reads the run token and its expiry', async () => {
    const signal = new AbortController().signal;
    expect(await requestRunToken('tt-1', signal)).toEqual({
      runToken: 'v1.a.b',
      expiresAt: Date.parse('2026-10-27T12:30:00.000Z'),
    });
    expect(fetchSpy).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'tt-1' }),
      signal,
    });
  });

  it("rejects with the API's code and message when it refuses", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ success: false, code: 'rate_limited', error: 'Too many requests.' }, 429),
    );
    const refused = requestRunToken('tt-1');
    await expect(refused).rejects.toBeInstanceOf(RunTokenError);
    await expect(refused).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Too many requests.',
    });
  });

  it('rejects an answer it cannot read, or one without a token or an expiry', async () => {
    for (const answer of [
      new Response('<html>', { status: 502 }),
      json({ success: true, expiresAt: '2026-10-27T12:30:00.000Z' }),
      json({ success: true, runToken: '', expiresAt: '2026-10-27T12:30:00.000Z' }),
      json({ success: true, runToken: 'v1.a.b', expiresAt: 'soon' }),
    ]) {
      fetchSpy.mockResolvedValueOnce(answer);
      await expect(requestRunToken('tt-1')).rejects.toMatchObject({ code: null });
    }
  });
});

describe('newRunToken', () => {
  it('asks with the development bypass when the build has no Turnstile site key', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
    await newRunToken();
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      turnstileToken: DEV_BYPASS_TOKEN,
    });
  });

  it('never sends the bypass from a build with a site key', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    await expect(newRunToken()).rejects.toBeInstanceOf(RunTokenError);
    await expect(newRunToken()).rejects.toMatchObject({ code: 'verification_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a run token on a request', () => {
  const token = { runToken: 'v1.a+b/c', expiresAt: Date.now() + 60_000 };

  it('goes in the runToken query parameter, encoded', () => {
    expect(withRunToken('/api/analyze/stream?query=Hurt', token)).toBe(
      '/api/analyze/stream?query=Hurt&runToken=v1.a%2Bb%2Fc',
    );
    expect(withRunToken('/api/x', token)).toBe('/api/x?runToken=v1.a%2Bb%2Fc');
  });

  it('is sent again only until shortly before it expires', () => {
    const now = 1_000_000;
    expect(isUsable(null, now)).toBe(false);
    expect(isUsable({ runToken: 't', expiresAt: now + RUN_TOKEN_MARGIN_MS + 1 }, now)).toBe(true);
    expect(isUsable({ runToken: 't', expiresAt: now + RUN_TOKEN_MARGIN_MS }, now)).toBe(false);
  });

  it('is carried by the factoid request', () => {
    const result = {
      id: 't1',
      title: 'Hurt',
      artist: 'NIN',
      factoids: [],
      run: { id: 'run-1', mode: 'live' },
    } as unknown as TrackData;
    const url = new URL(moreFactsUrl(result, newMoreFacts(result), token), 'http://x');
    expect(url.pathname).toBe('/api/factoids/more/stream');
    expect(url.searchParams.get('runToken')).toBe('v1.a+b/c');
    expect(url.searchParams.get('runId')).toBe('run-1');
  });
});

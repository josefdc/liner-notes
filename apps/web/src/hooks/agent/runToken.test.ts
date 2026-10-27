import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackData } from '../../types';
import {
  boundedWait,
  MAX_RETRY_WAIT_MS,
  RunTokenError,
  requestRunToken,
  retryAfterMs,
} from './apiClient';
import { moreFactsUrl, newMoreFacts } from './moreFacts';
import {
  DEV_BYPASS_TOKEN,
  isUsable,
  newRunToken,
  RUN_TOKEN_MARGIN_MS,
  withRunToken,
} from './runToken';
import type { TurnstileApi, TurnstileRenderOptions } from './turnstile';

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
  delete window.turnstile;
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

  it('reads how long a 429 says to wait, in seconds or as a date', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, code: 'rate_limited', error: 'Slow down.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '42' },
      }),
    );
    await expect(requestRunToken('tt-1')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 42_000,
    });
    // Without the header, no wait is known.
    fetchSpy.mockResolvedValueOnce(json({ success: false, code: 'rate_limited' }, 429));
    await expect(requestRunToken('tt-1')).rejects.toMatchObject({ retryAfterMs: null });

    const now = Date.parse('2026-10-27T12:00:00.000Z');
    expect(retryAfterMs('Tue, 27 Oct 2026 12:01:30 GMT', now)).toBe(90_000);
    expect(retryAfterMs('Tue, 27 Oct 2026 11:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs(' 0 ', now)).toBe(0);
    for (const unreadable of [null, '', 'soon', '-5', '1.5']) {
      expect(retryAfterMs(unreadable, now)).toBeNull();
    }
  });

  it('keeps no wait longer than an hour, however long the header says', () => {
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    expect(MAX_RETRY_WAIT_MS).toBe(60 * 60_000);
    // One day, a huge number, one too large to read as a number, and a date far ahead.
    for (const long of [
      '86400',
      '99999999999999999999',
      '9'.repeat(400),
      'Fri, 31 Dec 9999 23:59:59 GMT',
    ]) {
      expect(retryAfterMs(long, now)).toBe(MAX_RETRY_WAIT_MS);
    }
    expect(retryAfterMs('3600', now)).toBe(MAX_RETRY_WAIT_MS);
    expect(retryAfterMs('3599', now)).toBe(3_599_000);
    expect(boundedWait(Number.POSITIVE_INFINITY)).toBe(MAX_RETRY_WAIT_MS);
    expect(boundedWait(Number.NaN)).toBe(MAX_RETRY_WAIT_MS);
    expect(boundedWait(-1)).toBe(0);
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

  /** A window.turnstile that answers each widget with `answer(n)` (the nth, from 1). */
  function fakeTurnstile(answer: (n: number, options: TurnstileRenderOptions) => void) {
    const rendered: TurnstileRenderOptions[] = [];
    const api: TurnstileApi = {
      render: (_container, options) => {
        rendered.push(options);
        const n = rendered.length;
        queueMicrotask(() => answer(n, options));
        return `widget-${n}`;
      },
      remove: () => {},
    };
    window.turnstile = api;
    return rendered;
  }
  const body = (call: number) => JSON.parse(fetchSpy.mock.calls[call][1].body);

  it("asks with the Turnstile widget's token in a build with a site key", async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    const rendered = fakeTurnstile((n, options) => options.callback(`widget-token-${n}`));
    expect(await newRunToken()).toEqual({
      runToken: 'v1.a.b',
      expiresAt: Date.parse('2026-10-27T12:30:00.000Z'),
    });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      sitekey: '1x00000000000000000000AA',
      appearance: 'interaction-only',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body(0)).toEqual({ turnstileToken: 'widget-token-1' });
  });

  it('runs one new check when the API refuses the widget token, and no more', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    const rendered = fakeTurnstile((n, options) => options.callback(`widget-token-${n}`));
    const refused = () =>
      json({ success: false, code: 'auth_expired', error: 'Check again.' }, 401);
    fetchSpy.mockResolvedValueOnce(refused());
    await newRunToken();
    expect(rendered).toHaveLength(2);
    expect([body(0), body(1)]).toEqual([
      { turnstileToken: 'widget-token-1' },
      { turnstileToken: 'widget-token-2' },
    ]);

    // Refused twice: the refusal is the answer; no third check.
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => refused());
    await expect(newRunToken()).rejects.toMatchObject({ code: 'auth_expired' });
    expect(rendered).toHaveLength(4);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('asks the API nothing when the check gives no token', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    const rendered = fakeTurnstile((_n, options) => options['error-callback']('300030'));
    await expect(newRunToken()).rejects.toBeInstanceOf(RunTokenError);
    await expect(newRunToken()).rejects.toMatchObject({ code: 'verification_failed' });
    expect(rendered).toHaveLength(2);
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

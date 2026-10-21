import { describe, expect, it } from 'vitest';
import { apiProxyTarget, apiUrlProblem } from './apiUrl';

describe('apiUrlProblem', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['/api', true],
    ['/api/', true],
    ['/backend/api', false],
    ['https://api.example.test/api', true],
    ['http://localhost:3001/api/', true],
  ])('accepts %j (serving: %s)', (value, serving) => {
    expect(apiUrlProblem(value, serving)).toBeNull();
  });

  it('warns that the dev proxy forwards only /api', () => {
    expect(apiUrlProblem('/backend/api', true)).toEqual({
      level: 'warning',
      message: expect.stringContaining('forward only /api'),
    });
  });

  it.each(['api', 'example.test/api', '//example.test/api', 'ftp://example.test/api'])(
    'fails %j as neither a path nor an http(s) URL',
    (value) => {
      expect(apiUrlProblem(value, false)).toEqual({
        level: 'error',
        message: expect.stringContaining('neither a path'),
      });
    },
  );

  it('fails an absolute URL without a path', () => {
    expect(apiUrlProblem('https://api.example.test', false)).toEqual({
      level: 'error',
      message: expect.stringContaining('https://api.example.test/api'),
    });
    expect(apiUrlProblem('https://api.example.test/', true)?.level).toBe('error');
  });
});

describe('apiProxyTarget', () => {
  it('is the local API on API_PORT (default 3001) without API_PROXY_TARGET', () => {
    expect(apiProxyTarget({})).toBe('http://127.0.0.1:3001');
    expect(apiProxyTarget({ API_PORT: '3111' })).toBe('http://127.0.0.1:3111');
    expect(apiProxyTarget({ API_PROXY_TARGET: ' ', API_PORT: '3111' })).toBe(
      'http://127.0.0.1:3111',
    );
  });

  it('takes an http(s) origin from API_PROXY_TARGET', () => {
    expect(apiProxyTarget({ API_PROXY_TARGET: 'http://api.internal:3001/' })).toBe(
      'http://api.internal:3001',
    );
  });

  it.each(['api.internal:3001', 'ftp://api.internal', 'http://api.internal:3001/api'])(
    'rejects API_PROXY_TARGET=%j',
    (value) => {
      expect(() => apiProxyTarget({ API_PROXY_TARGET: value })).toThrow('API_PROXY_TARGET');
    },
  );
});

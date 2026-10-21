import { describe, expect, it } from 'vitest';
import { apiUrlWarning } from './apiUrl';

describe('apiUrlWarning', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['/api', true],
    ['/api/', true],
    ['/backend/api', false],
    ['https://api.example.test/api', true],
    ['http://localhost:3001/api/', true],
  ])('accepts %j (serving: %s)', (value, serving) => {
    expect(apiUrlWarning(value, serving)).toBeNull();
  });

  it('warns that the dev proxy forwards only /api', () => {
    expect(apiUrlWarning('/backend/api', true)).toContain('forward only /api');
  });

  it.each(['api', 'example.test/api', '//example.test/api', 'ftp://example.test/api'])(
    'rejects %j as neither a path nor an http(s) URL',
    (value) => {
      expect(apiUrlWarning(value, false)).toContain('neither a path');
    },
  );

  it('rejects an absolute URL without a path', () => {
    expect(apiUrlWarning('https://api.example.test', false)).toContain(
      'https://api.example.test/api',
    );
    expect(apiUrlWarning('https://api.example.test/', false)).toContain('has no path');
  });
});

import { describe, expect, it } from 'vitest';
import { apiBaseUrl } from './types';

describe('apiBaseUrl', () => {
  it('is /api on the web origin when VITE_API_URL is unset or empty', () => {
    expect(apiBaseUrl(undefined)).toBe('/api');
    expect(apiBaseUrl('')).toBe('/api');
    expect(apiBaseUrl('  ')).toBe('/api');
  });

  it('keeps a configured path or absolute URL without its trailing slash', () => {
    expect(apiBaseUrl('/api')).toBe('/api');
    expect(apiBaseUrl('/api/')).toBe('/api');
    expect(apiBaseUrl('https://example.test/api/')).toBe('https://example.test/api');
    expect(apiBaseUrl('http://localhost:3001/api')).toBe('http://localhost:3001/api');
  });
});

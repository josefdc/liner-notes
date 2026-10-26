import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCE_URL, sourceUrl } from './sourceUrl';

describe('sourceUrl', () => {
  it('is the public repository when VITE_SOURCE_URL is unset or empty', () => {
    expect(DEFAULT_SOURCE_URL).toBe('https://github.com/josefdc/liner-notes');
    expect(sourceUrl(undefined)).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('')).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('   ')).toBe(DEFAULT_SOURCE_URL);
  });

  it('is the address VITE_SOURCE_URL names', () => {
    expect(sourceUrl('https://git.example.org/me/liner-notes')).toBe(
      'https://git.example.org/me/liner-notes',
    );
    expect(sourceUrl(' http://localhost:8080/src ')).toBe('http://localhost:8080/src');
  });

  it('ignores a value that is not an http(s) address', () => {
    expect(sourceUrl('github.com/me/liner-notes')).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('javascript:alert(1)')).toBe(DEFAULT_SOURCE_URL);
    expect(sourceUrl('/source')).toBe(DEFAULT_SOURCE_URL);
  });
});

describe('SOURCE_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is read from VITE_SOURCE_URL at build time', async () => {
    vi.stubEnv('VITE_SOURCE_URL', 'https://git.example.org/me/liner-notes');
    vi.resetModules();
    const { SOURCE_URL } = await import('./sourceUrl');
    expect(SOURCE_URL).toBe('https://git.example.org/me/liner-notes');
  });

  it('is the public repository without it', async () => {
    vi.stubEnv('VITE_SOURCE_URL', '');
    vi.resetModules();
    const { SOURCE_URL } = await import('./sourceUrl');
    expect(SOURCE_URL).toBe(DEFAULT_SOURCE_URL);
  });
});

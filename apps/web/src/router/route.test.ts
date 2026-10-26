import { describe, expect, it } from 'vitest';
import { parseRoute, routeUrl } from './route';

describe('parseRoute', () => {
  it('reads the search and a track with or without its words', () => {
    expect(parseRoute('/', '')).toEqual({ kind: 'search' });
    expect(parseRoute('/t/4cOdK2wGLETKBW3PvgPWqT', '')).toEqual({
      kind: 'track',
      trackId: '4cOdK2wGLETKBW3PvgPWqT',
      query: null,
    });
    expect(parseRoute('/t/4cOdK2wGLETKBW3PvgPWqT/', '?q=Bright+Lines%20Test+Artist')).toEqual({
      kind: 'track',
      trackId: '4cOdK2wGLETKBW3PvgPWqT',
      query: 'Bright Lines Test Artist',
    });
  });

  it('keeps an id that is not a Spotify id, for the page to say so', () => {
    expect(parseRoute('/t/not%20a%20track', '?q=%20%20')).toEqual({
      kind: 'track',
      trackId: 'not a track',
      query: null,
    });
    expect(parseRoute('/t/%E0%A4%A', '')).toEqual({
      kind: 'track',
      trackId: '%E0%A4%A',
      query: null,
    });
  });

  it('knows no other path', () => {
    for (const path of ['', '/t', '/t/', '/t/a/b', '/tracks/a', '/index.html']) {
      expect(parseRoute(path, '')).toBeNull();
    }
  });
});

describe('routeUrl', () => {
  it('writes addresses that read back as the same route', () => {
    const routes = [
      { kind: 'search' as const },
      { kind: 'track' as const, trackId: '4cOdK2wGLETKBW3PvgPWqT', query: null },
      { kind: 'track' as const, trackId: '4cOdK2wGLETKBW3PvgPWqT', query: 'AC/DC & Co? #1' },
    ];
    for (const route of routes) {
      const url = new URL(routeUrl(route), 'https://example.org');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
    expect(routeUrl(routes[2])).toBe('/t/4cOdK2wGLETKBW3PvgPWqT?q=AC%2FDC+%26+Co%3F+%231');
  });
});

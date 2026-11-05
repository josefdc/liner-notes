import { describe, expect, it } from 'vitest';
import { basePath, parseRoute, routeUrl } from './route';

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

  it("reads a track's full-size map, apart from its track", () => {
    expect(parseRoute('/t/4cOdK2wGLETKBW3PvgPWqT/map', '')).toEqual({
      kind: 'map',
      trackId: '4cOdK2wGLETKBW3PvgPWqT',
      query: null,
    });
    expect(parseRoute('/t/4cOdK2wGLETKBW3PvgPWqT/map/', '?q=Bright+Lines')).toEqual({
      kind: 'map',
      trackId: '4cOdK2wGLETKBW3PvgPWqT',
      query: 'Bright Lines',
    });
    // A track whose id is "map" is a track, not a map.
    expect(parseRoute('/t/map', '')).toEqual({ kind: 'track', trackId: 'map', query: null });
  });

  it('knows no other path', () => {
    for (const path of [
      '',
      '/t',
      '/t/',
      '/t/a/b',
      '/tracks/a',
      '/index.html',
      '/t//map',
      '/t/a/map/x',
      '/t/a/maps',
      '/t/a/map/map',
      '/map',
    ]) {
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
      { kind: 'map' as const, trackId: '4cOdK2wGLETKBW3PvgPWqT', query: null },
      { kind: 'map' as const, trackId: '4cOdK2wGLETKBW3PvgPWqT', query: 'AC/DC & Co? #1' },
      { kind: 'track' as const, trackId: 'map', query: null },
    ];
    for (const route of routes) {
      const url = new URL(routeUrl(route), 'https://example.org');
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
    expect(routeUrl(routes[2])).toBe('/t/4cOdK2wGLETKBW3PvgPWqT?q=AC%2FDC+%26+Co%3F+%231');
    expect(routeUrl(routes[4])).toBe('/t/4cOdK2wGLETKBW3PvgPWqT/map?q=AC%2FDC+%26+Co%3F+%231');
  });
});

describe('a build served under a path', () => {
  const BASE = '/liner-notes';

  it('reads its addresses under that path', () => {
    expect(parseRoute('/liner-notes/', '', BASE)).toEqual({ kind: 'search' });
    expect(parseRoute('/liner-notes', '', BASE)).toEqual({ kind: 'search' });
    expect(parseRoute('/liner-notes/t/abc/', '?q=x', BASE)).toEqual({
      kind: 'track',
      trackId: 'abc',
      query: 'x',
    });
    expect(parseRoute('/liner-notes/t/abc/map/', '', BASE)).toEqual({
      kind: 'map',
      trackId: 'abc',
      query: null,
    });
  });

  it('knows no address outside that path', () => {
    expect(parseRoute('/', '', BASE)).toBeNull();
    expect(parseRoute('/t/abc', '', BASE)).toBeNull();
    expect(parseRoute('/liner-notes-2/t/abc', '', BASE)).toBeNull();
  });

  it('writes its addresses under that path', () => {
    expect(routeUrl({ kind: 'search' }, BASE)).toBe('/liner-notes/');
    expect(routeUrl({ kind: 'map', trackId: 'abc', query: 'x y' }, BASE)).toBe(
      '/liner-notes/t/abc/map?q=x+y',
    );
  });

  it('takes the last slash off the base', () => {
    expect(basePath('/')).toBe('');
    expect(basePath('/liner-notes/')).toBe('/liner-notes');
  });
});

import { describe, expect, it } from 'vitest';
import { AppPhase, type TrackData } from '../types';
import { parseRoute } from './route';
import { addressOf, openingScreen } from './screens';

const ID = '4cOdK2wGLETKBW3PvgPWqT';
const track = { id: ID, title: 'Bright Lines', artist: 'Test Artist' } as TrackData;
const at = (path: string) => {
  const url = new URL(path, 'https://example.org');
  return parseRoute(url.pathname, url.search);
};

describe('addressOf', () => {
  it("writes a result's full-size map at its own address, apart from its track", () => {
    expect(addressOf(AppPhase.MAP, track, null)).toBe(`/t/${ID}/map?q=Bright+Lines+Test+Artist`);
    expect(addressOf(AppPhase.PLAYER, track, null)).toBe(`/t/${ID}?q=Bright+Lines+Test+Artist`);
    expect(addressOf(AppPhase.DASHBOARD, track, null)).toBe(`/t/${ID}?q=Bright+Lines+Test+Artist`);
  });

  it("keeps a map link's address while its result loads", () => {
    const link = { trackId: ID, query: null, state: 'loading' as const };
    expect(addressOf(AppPhase.MAP, null, link)).toBe(`/t/${ID}/map`);
    expect(addressOf(AppPhase.DASHBOARD, null, link)).toBe(`/t/${ID}`);
  });

  it('gives a result no address loads again the search', () => {
    expect(addressOf(AppPhase.MAP, { ...track, id: 'recorded-run' }, null)).toBe('/');
    expect(addressOf(AppPhase.ONBOARDING, track, null)).toBe('/');
  });

  it('writes addresses the page opens on the same screen', () => {
    for (const phase of [AppPhase.MAP, AppPhase.DASHBOARD]) {
      const route = at(addressOf(phase, track, null));
      expect(openingScreen(route, null).phase).toBe(phase);
    }
  });
});

describe('openingScreen', () => {
  it("opens a map's address on the map, whatever its entry says", () => {
    const screen = openingScreen(at(`/t/${ID}/map`), null);
    expect(screen.phase).toBe(AppPhase.MAP);
    expect(screen.link).toEqual({ trackId: ID, query: null, state: 'loading' });
    expect(openingScreen(at(`/t/${ID}/map`), { phase: AppPhase.PLAYER }).phase).toBe(AppPhase.MAP);
  });

  it("opens a track's address on its Dashboard, or the Player its entry had", () => {
    expect(openingScreen(at(`/t/${ID}`), null).phase).toBe(AppPhase.DASHBOARD);
    expect(openingScreen(at(`/t/${ID}`), { phase: AppPhase.PLAYER }).phase).toBe(AppPhase.PLAYER);
    expect(openingScreen(at(`/t/${ID}`), { phase: AppPhase.MAP }).phase).toBe(AppPhase.DASHBOARD);
  });

  it("says a map link's id that is not a track's is invalid", () => {
    expect(openingScreen(at('/t/not-a-track/map'), null).link?.state).toBe('invalid');
  });

  it("brings back the entry's trail, tab and where the map was opened from", () => {
    const trail = {
      steps: [{ trackId: ID, title: 'Bright Lines', artist: null, view: 'map' }],
      earlier: 0,
    };
    const screen = openingScreen(at(`/t/${ID}/map`), {
      phase: AppPhase.MAP,
      trail,
      tab: 'genealogy',
      fromPlayer: true,
    });
    expect(screen.trail).toEqual(trail);
    expect(screen.tab).toBe('genealogy');
    expect(screen.fromPlayer).toBe(true);
    // A shared link has no entry state: no trail.
    expect(openingScreen(at(`/t/${ID}/map`), null).trail.steps).toEqual([]);
    expect(openingScreen(at(`/t/${ID}`), { fromPlayer: true }).fromPlayer).toBe(false);
  });

  it('opens anything else on the search, with no trail', () => {
    for (const path of ['/', '/t//map', `/t/${ID}/map/x`]) {
      const screen = openingScreen(at(path), { trail: { steps: [], earlier: 0 } });
      expect(screen.phase).toBe(AppPhase.ONBOARDING);
      expect(screen.link).toBeNull();
    }
  });
});

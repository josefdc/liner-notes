import { describe, expect, it } from 'vitest';
import { displayableFactoids, normalizeTrack } from './constants';
import type { TrackData } from './types';

describe('displayableFactoids', () => {
  it('drops lyric factoids from earlier versions and entries that are not factoids', () => {
    const factoids = [
      { id: 'f1', title: 'Studio', content: 'Text', type: 'production' },
      { id: 'f2', title: 'Lyrical Analysis', content: 'Text', type: 'lyrics' },
      null,
      'text',
    ];
    expect(displayableFactoids(factoids).map((f) => f.id)).toEqual(['f1']);
  });
});

describe('normalizeTrack', () => {
  it('defaults missing lists and treats "null" text as missing without filling values in', () => {
    const track = normalizeTrack({
      id: 't1',
      title: 'Song',
      artist: 'Artist',
      album: 'null',
      coverUrl: '',
      bpm: null,
      key: 'undefined',
      releaseYear: 'null',
    } as unknown as TrackData);
    expect(track.segments).toEqual([]);
    expect(track.samples).toEqual([]);
    expect(track.keyMoments).toEqual([]);
    expect(track.factoids).toEqual([]);
    expect(track.genealogy).toEqual({ nodes: [], links: [] });
    expect(track.genreProfile).toBeUndefined();
    expect(track.album).toBe('');
    expect(track.key).toBeNull();
    expect(track.releaseYear).toBeUndefined();
    expect(track.bpm).toBeNull();
  });
});

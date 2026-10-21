import { describe, expect, it } from 'vitest';
import { displayableFactoids, modelUnavailableText, normalizeTrack } from './constants';
import type { TrackData } from './types';

describe('displayableFactoids', () => {
  it('drops lyric factoids and entries that are not factoids', () => {
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

describe('factoids that repeat estimated audio values', () => {
  const track = (audioSource: string | undefined) =>
    ({
      id: 't1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverUrl: '',
      bpm: 117,
      key: 'A Minor',
      energy: 0.63,
      danceability: 0.54,
      audioSource,
      factoids: [
        {
          id: 'g1',
          title: 'Sonic Profile',
          content: '117 BPM in A Minor. Danceability: 54%.',
          type: 'production',
        },
        {
          id: 'g2',
          title: 'Track Signature',
          content: 'A positive track at 117 BPM in A Minor.',
          type: 'production',
        },
        { id: 'g3', title: 'Groove', content: 'Sits at 117 bpm.', type: 'trivia' },
        { id: 'g4', title: 'Mix', content: 'Energy around 63% of full scale.', type: 'trivia' },
        {
          id: 'g5',
          title: 'Release Info',
          content: 'Released in 1999. Popularity score: 55/100.',
          type: 'trivia',
        },
      ],
    }) as unknown as TrackData;

  it.each(['estimated', undefined])('are dropped when the audio source is %s', (source) => {
    expect(normalizeTrack(track(source)).factoids.map((f) => f.id)).toEqual(['g5']);
  });

  it('are kept when the values were measured', () => {
    expect(normalizeTrack(track('analyzed')).factoids.map((f) => f.id)).toEqual([
      'g1',
      'g2',
      'g3',
      'g4',
      'g5',
    ]);
  });
});

describe('modelUnavailableText', () => {
  it('says live model calls are paused when the budget is exhausted', () => {
    expect(modelUnavailableText('budget_exhausted')).toBe(
      'live model calls are paused, budget reached',
    );
    expect(modelUnavailableText('budget_exhausted')).not.toMatch(/did not respond/);
    // It is shown inside parentheses in the fallback notice: no parentheses of its own.
    expect(modelUnavailableText('budget_exhausted')).not.toMatch(/[()]/);
  });
});

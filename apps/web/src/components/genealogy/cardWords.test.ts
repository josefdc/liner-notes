import { describe, expect, it } from 'vitest';
import { cardName, cardWords } from './cardWords';
import { labelYear, nodesById, yearOf } from './links';

describe('a node’s year', () => {
  it('takes a label’s year only when it is one a node may carry', () => {
    expect(labelYear('Song - Artist (1984)')).toBe(1984);
    expect(labelYear('Song (0161)')).toBeNull();
    expect(labelYear('Song')).toBeNull();
  });

  it('prefers the year the API took from MusicBrainz to the one a label ends with', () => {
    const nodes = nodesById([{ id: 'a', label: 'Song - Artist (1990)', year: 1984 }]);
    expect(yearOf(nodes.get('a'))).toBe(1984);
    const unread = nodesById([{ id: 'b', label: 'Song (0161)' }]);
    expect(yearOf(unread.get('b'))).toBeNull();
  });
});

describe('cardWords and cardName', () => {
  it('names a track by its title, its artist and its year, or says it is undated', () => {
    expect(cardWords({ label: 'Sourced Sample - Someone (1984)' }, 1984)).toEqual({
      title: 'Sourced Sample - Someone',
      artist: null,
      year: 1984,
      meta: '1984',
    });
    // A label that ends with no year a node may carry keeps its brackets.
    expect(cardWords({ label: 'Song (0161)' }, null).title).toBe('Song (0161)');
    expect(cardName({ trackTitle: 'More Spell on You', trackArtist: 'Eddie Johns' }, null)).toBe(
      'More Spell on You by Eddie Johns (undated)',
    );
    expect(cardName({ label: 'Bright Lines', trackArtist: 'Test Artist' }, 2011)).toBe(
      'Bright Lines by Test Artist (2011)',
    );
  });
});

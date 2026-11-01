import { describe, expect, it } from 'vitest';
import { cardName, cardSaid, cardWords } from './cardWords';
import { labelYear, nodesById, recordYear, yearOf } from './links';
import { layoutLineage } from './lineageLayout';

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

describe('cardSaid', () => {
  const spell = { trackTitle: 'More Spell on You', trackArtist: 'Eddie Johns' };

  it('says the drawn words first, in their order, each line apart and "·" as a pause', () => {
    expect(
      cardSaid(spell, 1979, {
        title: { lines: ['More Spell on', 'You'] },
        meta: { lines: ['Eddie Johns · 1979'] },
        tag: 'Origin',
      }),
    ).toBe('More Spell on You, Eddie Johns, 1979, Origin');
  });

  it('says "undated" after the drawn words when the card shows no year', () => {
    expect(
      cardSaid(spell, null, {
        title: { lines: ['More Spell on You'] },
        meta: { lines: ['Eddie Johns'] },
        tag: null,
      }),
    ).toBe('More Spell on You, Eddie Johns, undated');
  });

  it('adds the whole name where the drawn words cut or break the title', () => {
    const long = { trackTitle: 'One More Time (Daft Punk) / Swoon (Chemical Brothers)' };
    expect(
      cardSaid(long, 2001, {
        title: { lines: ['One More Time (Daft', 'Punk) / Swoon…'] },
        meta: { lines: ['2001'] },
        tag: null,
        note: { lines: ['Title shortened'] },
      }),
    ).toBe(
      'One More Time (Daft Punk) / Swoon…, 2001, Title shortened (One More Time (Daft Punk) / Swoon (Chemical Brothers) (2001))',
    );
    // A line ending inside a word runs on into the next one, as drawn, then the word whole.
    expect(
      cardSaid({ trackTitle: 'Supercalifragilistic' }, 1964, {
        title: { lines: ['Supercali-', 'fragilistic'], hyphenated: [true, false] },
        meta: { lines: ['1964'] },
        tag: null,
      }),
    ).toBe('Supercali-fragilistic, 1964 (Supercalifragilistic (1964))');
  });
});

describe('a year only a label carries (the model writes "Title - Artist (Year)")', () => {
  const nodes = nodesById(
    [
      { id: 'current', group: 1, label: 'Song' },
      { id: 'model', group: 4, label: 'X - Y (1990)' },
      { id: 'record', group: 2, label: 'Z - W (1984)', year: 1984 },
    ],
    2011,
  );

  it('dates no card: the track goes in an "Undated" slot, its label kept in its own words', () => {
    expect(recordYear(nodes.get('model'))).toBeNull();
    expect(recordYear(nodes.get('record'))).toBe(1984);
    expect(recordYear(nodes.get('current'))).toBe(2011);
    const layout = layoutLineage(
      ['current', 'model', 'record'].map((id) => ({
        id,
        year: recordYear(nodes.get(id)),
        lane: 'influence' as const,
        width: 100,
        height: 40,
      })),
      { orientation: 'horizontal' },
    );
    expect(layout.slots.map((slot) => slot.label)).toEqual(['1984', '2011', 'Undated']);
    const undated = layout.slots.find((slot) => slot.year === null);
    const x = layout.cards.get('model')?.x ?? 0;
    expect(x).toBeGreaterThanOrEqual(undated?.start ?? 0);
    // The card prints no year line for it; the label, the model's words, is its title whole.
    expect(cardWords({ label: 'X - Y (1990)' }, null)).toMatchObject({
      title: 'X - Y (1990)',
      meta: '',
    });
    expect(cardWords({ label: 'Z - W (1984)' }, 1984)).toMatchObject({
      title: 'Z - W',
      meta: '1984',
    });
  });
});

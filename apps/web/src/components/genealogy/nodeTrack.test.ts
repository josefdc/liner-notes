import { describe, expect, it } from 'vitest';
import { nodeQuery, nodeTrack, UNTITLED_TRACK } from './nodeTrack';

// How a related track's card names it: never an artist the node does not give, never its id.
describe('nodeTrack', () => {
  it('takes the title and artist from the node’s own fields', () => {
    expect(
      nodeTrack({
        id: 'n',
        label: 'Other - Someone (1990)',
        trackTitle: 'Real',
        trackArtist: 'Band',
      }),
    ).toEqual({ title: 'Real', artist: 'Band' });
    expect(nodeTrack({ id: 'n', label: 'Song - Live at Wembley', trackArtist: 'Queen' })).toEqual({
      title: 'Song - Live at Wembley',
      artist: 'Queen',
    });
  });

  it.each([
    // "Title - Artist (Year)": only its title is read; its artist part may be no artist at all.
    ['Older Record - Someone (1984)', 'Older Record'],
    ['Song - Live at Wembley (1986)', 'Song'],
    // Any other form is the title whole, without a year at its end.
    ['Song - Live at Wembley', 'Song - Live at Wembley'],
    [
      'Bohemian Rhapsody - 2011 Remaster - Queen (1975)',
      'Bohemian Rhapsody - 2011 Remaster - Queen',
    ],
    ['Intro - Outro', 'Intro - Outro'],
    ['Bare Title', 'Bare Title'],
    ['Older Record (1984)', 'Older Record'],
    // Only 1900-2099 is a year.
    ['Title - Artist (1066)', 'Title - Artist (1066)'],
    ['Title - Artist (9999)', 'Title - Artist (9999)'],
    ['Title (0000)', 'Title (0000)'],
    ['Title - Artist (2099)', 'Title'],
  ])('reads the label %j as the title %j, with no artist', (label, title) => {
    expect(nodeTrack({ id: 'n3', label })).toEqual({ title, artist: null });
  });

  it.each([[''], ['   '], [undefined]])(
    'calls a node with no title and the label %j an untitled track, never its id',
    (label) => {
      expect(nodeTrack({ id: 'n3', label })).toEqual({ title: UNTITLED_TRACK, artist: null });
    },
  );

  it('takes its own title when the label is empty', () => {
    expect(nodeTrack({ id: 'n3', label: '', trackTitle: 'Named' })).toEqual({
      title: 'Named',
      artist: null,
    });
  });
});

// The text a related track is searched by, on the Dashboard and in the Player alike.
describe('nodeQuery', () => {
  it.each([
    // Its own title and artist.
    [{ label: 'Other - Label (1990)', trackTitle: 'Real', trackArtist: 'Band' }, 'Real Band'],
    [{ label: 'Other - Label (1990)', trackTitle: 'Real' }, 'Real'],
    // No title of its own: the label whole, never split into a title and an artist.
    [{ label: 'Older Record - Someone (1984)' }, 'Older Record - Someone (1984)'],
    [{ label: 'Song - Live at Wembley', trackArtist: 'Queen' }, 'Song - Live at Wembley Queen'],
    // Nothing to search by.
    [{ label: '   ' }, ''],
    [{ label: '', trackArtist: 'Queen' }, ''],
  ])('searches %j by %j', (node, query) => {
    expect(nodeQuery({ id: 'n', ...node })).toBe(query);
  });
});

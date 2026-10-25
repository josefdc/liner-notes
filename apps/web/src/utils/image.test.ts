import { describe, expect, it } from 'vitest';
import {
  archiveReleaseOf,
  archiveReleasePage,
  coverLabels,
  isValidImageUrl,
  releaseTitleOf,
} from './image';

describe('isValidImageUrl', () => {
  it('accepts Spotify album art', () => {
    expect(isValidImageUrl('https://i.scdn.co/image/ab67616d0000b273')).toBe(true);
    expect(isValidImageUrl('https://mosaic.scdn.co/640/abc')).toBe(true);
  });

  it.each([
    ['a host that only contains an allowed name', 'https://i.scdn.co.evil.com/x.png'],
    ['a host that ends with an allowed name', 'https://evil-i.scdn.co/x.png'],
    ['an allowed name in the path', 'https://evil.com/i.scdn.co/x.png'],
    ['credentials before an allowed name', 'https://i.scdn.co@evil.com/x.png'],
    ['plain http', 'http://i.scdn.co/image/x'],
    ['a non-default port', 'https://i.scdn.co:8443/image/x'],
    ['any other image host', 'https://images.example.com/photo-1.jpg'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['text that is not a URL', 'not a url'],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('rejects %s', (_case, url) => {
    expect(isValidImageUrl(url)).toBe(false);
  });
});

describe('archiveReleaseOf (cover)', () => {
  const MBID = 'ae103b0a-b932-4009-acb6-388db1cf890b';

  it('reads the release MBID of a Cover Art Archive cover link', () => {
    expect(archiveReleaseOf(`https://coverartarchive.org/release/${MBID}/front-500`)).toBe(MBID);
    expect(archiveReleaseOf(`https://coverartarchive.org/release/${MBID}/front`)).toBe(MBID);
    expect(archiveReleaseOf(`https://coverartarchive.org/release/${MBID}`)).toBe(MBID);
    expect(archiveReleasePage(MBID)).toBe(`https://coverartarchive.org/release/${MBID}`);
  });

  it.each([
    ['Spotify album art', 'https://i.scdn.co/image/ab67616d0000b273'],
    ['a host that ends with the archive name', `https://evil-coverartarchive.org/release/${MBID}`],
    [
      'a host that contains the archive name',
      `https://coverartarchive.org.evil.com/release/${MBID}`,
    ],
    ['credentials before the archive host', `https://coverartarchive.org@evil.com/release/${MBID}`],
    ['plain http', `http://coverartarchive.org/release/${MBID}/front-500`],
    ['a non-default port', `https://coverartarchive.org:8443/release/${MBID}/front-500`],
    ['a release group, not a release', `https://coverartarchive.org/release-group/${MBID}/front`],
    ['a path that is not an MBID', 'https://coverartarchive.org/release/not-an-mbid/front-500'],
    ['an MBID with more after it', `https://coverartarchive.org/release/${MBID}0/front-500`],
    ['an upper-case MBID', `https://coverartarchive.org/release/${MBID.toUpperCase()}/front`],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('reads no release from %s', (_case, url) => {
    expect(archiveReleaseOf(url)).toBeNull();
  });
});

describe('coverLabels (cover)', () => {
  const MBID = 'ae103b0a-b932-4009-acb6-388db1cf890b';
  const ARCHIVE = `https://coverartarchive.org/release/${MBID}/front-500`;
  const PAGE = `https://coverartarchive.org/release/${MBID}`;
  const item = (title: string, id = `musicbrainz:release/${MBID}`) => ({
    id,
    source: 'musicbrainz',
    title: `${title} — MusicBrainz release`,
  });

  it('names the shown album when the release is that album', () => {
    expect(coverLabels(ARCHIVE, 'To The Extreme', [item('to the extreme')])).toEqual({
      alt: 'Cover of To The Extreme',
      credit: { text: 'Cover: Cover Art Archive', href: PAGE },
    });
  });

  it('names the release when it is not the shown album', () => {
    expect(coverLabels(ARCHIVE, 'Greatest Hits', [item('To the Extreme')])).toEqual({
      alt: 'Cover of To the Extreme',
      credit: { text: 'Cover: To the Extreme · Cover Art Archive', href: PAGE },
    });
  });

  it('never takes an archive cover for the shown album when the evidence does not name it', () => {
    for (const evidence of [undefined, [], [item('X', 'musicbrainz:release/other')], 'junk']) {
      expect(coverLabels(ARCHIVE, 'Test Album', evidence)).toEqual({
        alt: 'Cover from the Cover Art Archive',
        credit: { text: 'Cover: Cover Art Archive', href: PAGE },
      });
    }
  });

  it('names the release when no album is shown, and falls back when it has no letters or digits', () => {
    expect(coverLabels(ARCHIVE, '', [item('To the Extreme')])).toEqual({
      alt: 'Cover of To the Extreme',
      credit: { text: 'Cover: To the Extreme · Cover Art Archive', href: PAGE },
    });
    for (const [album, title] of [
      ['', '!!!'],
      ['', '?'],
      [undefined, '...'],
      ['  ', '!!!'],
    ] as const) {
      expect(coverLabels(ARCHIVE, album, [item(title)]), `${album}/${title}`).toEqual({
        alt: 'Cover from the Cover Art Archive',
        credit: { text: 'Cover: Cover Art Archive', href: PAGE },
      });
    }
    // An album named "?" whose release is "?": that album.
    expect(coverLabels(ARCHIVE, '?', [item('?')]).alt).toBe('Cover of ?');
  });

  it('names the album for any other cover, and credits no archive', () => {
    expect(coverLabels('https://i.scdn.co/image/x', 'Test Album', [item('X')])).toEqual({
      alt: 'Cover of Test Album',
      credit: null,
    });
    expect(coverLabels(null, '', undefined)).toEqual({ alt: 'Album cover', credit: null });
  });

  it('reads the release title only from the release item the API writes', () => {
    expect(releaseTitleOf([item('Hooked')], MBID)).toBe('Hooked');
    expect(releaseTitleOf([{ ...item('Hooked'), source: 'tavily' }], MBID)).toBeNull();
    expect(releaseTitleOf([{ ...item('Hooked'), title: 'Hooked' }], MBID)).toBeNull();
    expect(releaseTitleOf([item('Hooked')], 'other')).toBeNull();
  });
});

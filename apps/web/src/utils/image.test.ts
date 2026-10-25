import { describe, expect, it } from 'vitest';
import { archiveReleaseOf, archiveReleasePage, isValidImageUrl } from './image';

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
    expect(archiveReleaseOf(`https://coverartarchive.org/release/${MBID}/front-250`)).toBe(MBID);
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
    ['plain http', `http://coverartarchive.org/release/${MBID}/front-250`],
    ['a non-default port', `https://coverartarchive.org:8443/release/${MBID}/front-250`],
    ['a release group, not a release', `https://coverartarchive.org/release-group/${MBID}/front`],
    ['a path that is not an MBID', 'https://coverartarchive.org/release/not-an-mbid/front-250'],
    ['an MBID with more after it', `https://coverartarchive.org/release/${MBID}0/front-250`],
    ['an upper-case MBID', `https://coverartarchive.org/release/${MBID.toUpperCase()}/front`],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('reads no release from %s', (_case, url) => {
    expect(archiveReleaseOf(url)).toBeNull();
  });
});

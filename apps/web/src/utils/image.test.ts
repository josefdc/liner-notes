import { describe, expect, it } from 'vitest';
import { isValidImageUrl } from './image';

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

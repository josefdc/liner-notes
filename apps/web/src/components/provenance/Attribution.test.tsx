import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import type { ShownLink } from '../genealogy/links';
import { Attribution, previewHost, previewProvider, shownProviders } from './Attribution';
import { resultClaims } from './claims';
import { claim, evidence, provenanceTrack } from './testing';

afterEach(cleanup);

const DEEZER_CLIP = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/7.mp3?hdnea=exp=1~hmac=y';
const SPOTIFY_CLIP = 'https://p.scdn.co/mp3-preview/abc';

/** A result with the given claims, evidence pack and fields. */
const track = (fields: Partial<TrackData> = {}): TrackData =>
  ({
    id: 't',
    title: 'Song',
    artist: 'Band',
    album: '',
    coverUrl: '',
    bpm: null,
    segments: [],
    samples: [],
    factoids: [],
    genealogy: { nodes: [], links: [] },
    ...fields,
  }) as TrackData;

const providersOf = (
  result: TrackData,
  links: ShownLink[] = [],
  shown: Partial<Parameters<typeof shownProviders>[0]> = {},
) =>
  shownProviders({ track: result, claims: resultClaims(result), links, ...shown }).map(
    (provider) => [provider.source, provider.href, provider.note],
  );

describe('shownProviders', () => {
  it('lists the sources the shown and rejected claims cite, once each, not the uncited ones', () => {
    const result = track({
      evidence: [
        evidence({ id: 'mb' }),
        evidence({ id: 'dg', source: 'discogs', url: 'https://www.discogs.com/release/1' }),
        evidence({ id: 'fm', source: 'lastfm', sourceTier: 'editorial', recordRef: null }),
        evidence({ id: 'gn', source: 'genius', sourceTier: 'web', recordRef: null }),
      ],
      claims: [
        claim({ id: 'a', kind: 'sourced', origin: 'code', evidenceIds: ['mb', 'fm'] }),
        claim({ id: 'b', evidenceIds: ['mb'] }),
        // Rejected: listed with the rejected claims, with its source.
        claim({ id: 'c', verdict: 'contradicted', evidenceIds: ['dg'] }),
      ],
    });
    expect(providersOf(result)).toEqual([
      ['musicbrainz', 'https://musicbrainz.org', null],
      ['discogs', 'https://www.discogs.com', null],
      ['lastfm', 'https://www.last.fm', null],
    ]);
  });

  it('lists the sources the drawn links cite', () => {
    const link = {
      citations: [{ id: 'shs', evidence: evidence({ id: 'shs', source: 'secondhandsongs' }) }],
    } as unknown as ShownLink;
    expect(providersOf(track(), [link])).toEqual([
      ['secondhandsongs', 'https://secondhandsongs.com', null],
    ]);
  });

  it('links Spotify to the track when the result does, and never to an unsafe address', () => {
    expect(providersOf(track({ spotifyUrl: 'https://open.spotify.com/track/1' }))).toEqual([
      ['spotify', 'https://open.spotify.com/track/1', 'track details'],
    ]);
    expect(providersOf(track({ spotifyUrl: 'javascript:alert(1)' }))).toEqual([]);
  });

  it('credits the provider of a preview the page plays, or measured, and only when it is known', () => {
    expect(providersOf(track({ previewUrl: DEEZER_CLIP }))).toEqual([
      ['deezer', 'https://www.deezer.com', 'preview'],
    ]);
    expect(providersOf(track({ previewUrl: SPOTIFY_CLIP }))).toEqual([
      ['spotify', 'https://open.spotify.com', 'preview'],
    ]);
    // The result names the provider: that is the one, whatever the address.
    const named = track({ previewUrl: 'https://cdn.example.org/clip.mp3' });
    (named as { preview?: unknown }).preview = { provider: 'deezer', method: 'isrc', score: null };
    expect(providersOf(named)).toEqual([['deezer', 'https://www.deezer.com', 'preview']]);
    // A clip from a host neither provider uses: said as such, never guessed.
    expect(providersOf(track({ previewUrl: 'https://cdn.example.org/clip.mp3' }))).toEqual([
      ['preview', null, 'played here; this result does not name its provider'],
    ]);
    // A provider named, but no preview played or measured.
    const unused = track();
    (unused as { preview?: unknown }).preview = { provider: 'deezer', method: 'isrc', score: null };
    expect(providersOf(unused)).toEqual([]);
  });

  it("credits the provider of a related track's preview the graph can play", () => {
    const result = track({
      genealogy: {
        nodes: [
          { id: 'current', group: 1, label: 'Song', size: 40 },
          { id: 'n', group: 4, label: 'Other', size: 22, previewUrl: DEEZER_CLIP },
        ],
        links: [],
      },
    });
    expect(providersOf(result)).toEqual([['deezer', 'https://www.deezer.com', 'preview']]);
    // A node the graph does not draw (its relation hidden) plays nothing.
    expect(providersOf(result, [], { nodes: [] })).toEqual([]);
  });

  it('says the audio was measured on a preview clip whose provider the result does not name', () => {
    const measured = track(provenanceTrack());
    expect(previewProvider(measured)).toBe('unknown');
    expect(providersOf(measured).find(([source]) => source === 'preview')).toEqual([
      'preview',
      null,
      'the audio was measured on it; this result does not name its provider',
    ]);
  });

  it('credits Spotify for the details of a track it matched, by its id', () => {
    expect(providersOf(track({ id: '0DiWol3AO6WpXZgp0goxAV' }))).toEqual([
      ['spotify', 'https://open.spotify.com', 'track details'],
    ]);
  });

  it('credits the source of the cover the page shows, and nothing for a cover not shown', () => {
    const MBID = 'ae103b0a-b932-4009-acb6-388db1cf890b';
    expect(
      providersOf(track(), [], {
        coverSrc: `https://coverartarchive.org/release/${MBID}/front-500`,
      }),
    ).toEqual([['coverartarchive', `https://coverartarchive.org/release/${MBID}`, 'cover art']]);
    expect(
      providersOf(track({ spotifyUrl: 'https://open.spotify.com/track/1' }), [], {
        coverSrc: 'https://i.scdn.co/image/abc',
      }),
    ).toEqual([['spotify', 'https://open.spotify.com/track/1', 'track details, cover art']]);
    // Not shown (none, failed to load), or from a host the page does not know: not credited.
    expect(providersOf(track(), [], { coverSrc: null })).toEqual([]);
    expect(providersOf(track(), [], { coverSrc: 'https://images.example.org/c.jpg' })).toEqual([]);
  });

  it('credits the records the cards of a result built without the model come from', () => {
    const factoids = [
      { title: 'Samples', claimId: undefined },
      { title: 'Collaboration Network', claimId: undefined },
      { title: 'Release Info', claimId: undefined },
      { title: 'Sonic Profile', claimId: undefined },
    ];
    expect(providersOf(track({ modelUnavailable: true }), [], { factoids })).toEqual([
      ['musicbrainz', 'https://musicbrainz.org', 'facts from its records'],
      ['spotify', 'https://open.spotify.com', 'facts from its records'],
    ]);
    // The same titles in a result the model wrote are the model's: no record is credited.
    expect(providersOf(track(), [], { factoids })).toEqual([]);
  });
});

describe('previewHost and previewProvider', () => {
  it('reads the provider from the clip’s host only', () => {
    expect(previewHost(DEEZER_CLIP)).toBe('deezer');
    expect(previewHost('https://e-cdns-preview-a.dzcdn.net/stream/x.mp3')).toBe('deezer');
    expect(previewHost(SPOTIFY_CLIP)).toBe('spotify');
    expect(previewHost('https://dzcdn.net.example.org/x.mp3')).toBeNull();
    expect(previewHost(undefined)).toBeNull();
    expect(previewProvider(track())).toBeNull();
  });
});

describe('Attribution', () => {
  it('lists each provider by name, linked back in a new tab, with no logo', () => {
    render(
      <Attribution
        providers={[
          {
            source: 'musicbrainz',
            name: 'MusicBrainz',
            href: 'https://musicbrainz.org',
            note: null,
          },
          { source: 'deezer', name: 'Deezer', href: 'https://www.deezer.com', note: 'preview' },
          {
            source: 'tavily',
            name: 'Web search',
            href: null,
            note: 'each page is linked beside its claim',
          },
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Data from' });
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('Data from');
    const links = within(region).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['MusicBrainz, opens in a new tab', 'https://musicbrainz.org'],
      ['Deezer, opens in a new tab', 'https://www.deezer.com'],
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(region.querySelector('img')).toBeNull();
    expect(region.textContent).toContain('Web search (each page is linked beside its claim)');
  });

  it('is left out when no provider’s data is shown', () => {
    const { container } = render(<Attribution providers={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

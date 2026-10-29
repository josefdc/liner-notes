import type { SourceId } from '@liner-notes/contract';
import { ExternalLink } from 'lucide-react';
import type React from 'react';
import { useId } from 'react';
import { showsMeasuredAudio } from '../../constants';
import type { Factoid, TrackData } from '../../types';
import { archiveReleaseOf, archiveReleasePage, isValidImageUrl } from '../../utils/image';
import { isSpotifyTrackId } from '../../utils/spotify';
import type { ShownLink } from '../genealogy/links';
import { type ResultClaims, SOURCE_NAMES, safeHref } from './claims';
import { LINE } from './ClaimChip';

// Where the data on the page comes from, provider by provider, with a link back to each:
// - the sources the listed claims and the drawn links cite (each claim keeps its own source
//   link too);
// - Spotify for the track's details, when the result is Spotify's match (today the API matches
//   every track on Spotify; a result names no other source for them);
// - the source of the cover the page actually shows: the Cover Art Archive, or Spotify;
// - the provider of the preview when the page plays it or shows what was measured on it, and a
//   preview clip of unnamed provenance said as such, never guessed;
// - for a result built without the model, the provider of each fact card taken from its records.
// Plain names and links: no logos. A provider whose data the page does not show is not listed.

/** A provider the page can credit: a source of the contract, the cover archive, or a clip. */
export type ProviderId = SourceId | 'coverartarchive' | 'preview';

/** The provider's own site, linked when there is no address of the item itself. */
const HOME: Record<ProviderId, string | null> = {
  spotify: 'https://open.spotify.com',
  deezer: 'https://www.deezer.com',
  musicbrainz: 'https://musicbrainz.org',
  coverartarchive: 'https://coverartarchive.org',
  discogs: 'https://www.discogs.com',
  secondhandsongs: 'https://secondhandsongs.com',
  listenbrainz: 'https://listenbrainz.org',
  lastfm: 'https://www.last.fm',
  genius: 'https://genius.com',
  // Search results are web pages of many sites: each is linked beside the claim citing it.
  tavily: null,
  // A clip whose provider the result does not name: there is nothing to link to.
  preview: null,
};

const NAMES: Record<ProviderId, string> = {
  ...SOURCE_NAMES,
  coverartarchive: 'Cover Art Archive',
  preview: 'A preview clip',
};

/** The order providers are listed in: record databases first, then services, then the web. */
const ORDER: readonly ProviderId[] = [
  'musicbrainz',
  'coverartarchive',
  'discogs',
  'secondhandsongs',
  'listenbrainz',
  'lastfm',
  'genius',
  'spotify',
  'deezer',
  'preview',
  'tavily',
];

/** A provider whose data the page shows. */
export interface ShownProvider {
  source: ProviderId;
  name: string;
  /** Its link back: the item's own page when known, else the provider's site; null: none. */
  href: string | null;
  /** What of its data is shown beyond the records claims cite ("track details, preview"). */
  note: string | null;
}

// Preview hosts (as the API's isPreviewUrl names them, provenance/claims.ts).
const DEEZER_PREVIEW =
  /^https?:\/\/(?:[^/?#@\s]*\.)?(?:e-)?cdn[st]-preview(?:-[a-z0-9]+)?\.dzcdn\.net(?::\d+)?(?:[/?#]|$)/i;
const SPOTIFY_PREVIEW = /^https?:\/\/p\.scdn\.co(?::\d+)?(?:[/?#]|$)/i;

/** The provider of a preview clip, by its address; null when the address names neither. */
export function previewHost(url: unknown): 'deezer' | 'spotify' | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (DEEZER_PREVIEW.test(value)) return 'deezer';
  if (SPOTIFY_PREVIEW.test(value)) return 'spotify';
  return null;
}

/**
 * The provider of the track's preview when the page uses it (plays it, or shows what was
 * measured on it): the result's `preview.provider`, else the clip's host; 'unknown' when a
 * preview is used but which provider it came from is not known (never guessed); null when no
 * preview is used.
 */
export function previewProvider(track: TrackData): 'deezer' | 'spotify' | 'unknown' | null {
  const used = Boolean(track.previewUrl) || showsMeasuredAudio(track);
  if (!used) return null;
  const match = (track as { preview?: unknown }).preview;
  if (typeof match === 'object' && match !== null) {
    const provider = (match as { provider?: unknown }).provider;
    if (provider === 'deezer' || provider === 'spotify') return provider;
  }
  return previewHost(track.previewUrl) ?? 'unknown';
}

/** Where a shown cover comes from, by its address; null for a host the page does not know. */
export function coverSource(
  src: string | null | undefined,
): { source: 'coverartarchive' | 'spotify'; href: string | null } | null {
  const mbid = archiveReleaseOf(src);
  if (mbid) return { source: 'coverartarchive', href: archiveReleasePage(mbid) };
  return isValidImageUrl(src) ? { source: 'spotify', href: null } : null;
}

/**
 * The fact cards a result built without the model writes from records (apps/api/src/agent/
 * fallback.ts), by title: the sample relations and an artist's collaborators are MusicBrainz's,
 * the release line is Spotify's. The card written from the audio measurement is not a record's.
 */
const FALLBACK_CARDS: Record<string, ProviderId> = {
  samples: 'musicbrainz',
  'sampled by': 'musicbrainz',
  'collaboration network': 'musicbrainz',
  'release info': 'spotify',
};

/** What the page shows, read for the providers it comes from. */
export interface ShownData {
  track: TrackData;
  claims: Pick<ResultClaims, 'shown' | 'rejected'>;
  /** The links the graph draws. */
  links?: readonly ShownLink[];
  /** The clips of the related tracks the graph offers a preview of (`previewTracksOf`). */
  nodePreviews?: readonly string[];
  /** The cover the page shows (null when there is none, or it failed to load). */
  coverSrc?: string | null;
  /** The fact cards shown (their titles name a fallback card's records). */
  factoids?: readonly Pick<Factoid, 'title' | 'claimId'>[];
}

/** The providers whose data the page shows, in the order they are listed. */
export function shownProviders({
  track,
  claims,
  links = [],
  nodePreviews = [],
  coverSrc = null,
  factoids = [],
}: ShownData): ShownProvider[] {
  const notes = new Map<ProviderId, Set<string>>();
  const credit = (source: ProviderId, what?: string) => {
    const list = notes.get(source) ?? new Set<string>();
    if (what) list.add(what);
    notes.set(source, list);
  };
  // The listed claims (the rejected ones are listed too, with their sources) and drawn links.
  for (const shown of [...claims.shown, ...claims.rejected]) {
    for (const item of shown.cited) credit(item.source);
  }
  for (const link of links) {
    for (const { evidence } of link.citations) if (evidence) credit(evidence.source);
  }

  // The track's own details: Spotify's match, linked to the track's page there.
  const spotifyTrack = safeHref(track.spotifyUrl);
  if (spotifyTrack || isSpotifyTrackId(track.id)) credit('spotify', 'track details');

  const cover = coverSource(coverSrc);
  if (cover) credit(cover.source, 'cover art');

  // A result built without the model: its cards without a claim come from these records.
  if (track.modelUnavailable) {
    for (const factoid of factoids) {
      const title = typeof factoid.title === 'string' ? factoid.title.trim().toLowerCase() : '';
      const source = Object.hasOwn(FALLBACK_CARDS, title) ? FALLBACK_CARDS[title] : undefined;
      if (source && !factoid.claimId) credit(source, 'facts from its records');
    }
  }

  const preview = previewProvider(track);
  if (preview === 'unknown') {
    if (track.previewUrl) credit('preview', 'played here');
    if (showsMeasuredAudio(track)) credit('preview', 'the audio was measured on it');
  } else if (preview) credit(preview, 'preview');
  // A related track's preview the graph can play (a clip of another host is not credited).
  for (const url of nodePreviews) {
    const host = previewHost(url);
    if (host) credit(host, 'preview');
  }

  const providers: ShownProvider[] = [];
  for (const source of ORDER) {
    const what = notes.get(source);
    if (!what) continue;
    const href =
      source === 'spotify' && spotifyTrack
        ? spotifyTrack
        : source === cover?.source && cover.href
          ? cover.href
          : HOME[source];
    const words = [...what];
    if (source === 'tavily') words.push('each page is linked beside its claim');
    providers.push({
      source,
      name: NAMES[source],
      href,
      note:
        source === 'preview'
          ? `${words.join(', ')}; this result does not name its provider`
          : words.length > 0
            ? words.join(', ')
            : null,
    });
  }
  return providers;
}

interface AttributionProps {
  providers: readonly ShownProvider[];
  className?: string;
}

/** The "Data from" section: each provider whose data is shown, with a link back. */
export const Attribution: React.FC<AttributionProps> = ({ providers, className = '' }) => {
  const headingId = useId();
  if (providers.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={`space-y-2 ${className}`}>
      <h2 id={headingId} className="text-xs font-mono text-text-chip uppercase tracking-widest">
        Data from
      </h2>
      <ul aria-label="Data providers" className="space-y-1">
        {providers.map((provider) => (
          <li key={provider.source} data-provider={provider.source} className={LINE}>
            {provider.href ? (
              <a
                href={provider.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-secondary underline underline-offset-2 decoration-white/30 hover:text-white hover:decoration-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber focus-visible:ring-offset-2 focus-visible:ring-offset-void rounded-sm"
              >
                <span className="whitespace-nowrap">
                  {provider.name}
                  <ExternalLink
                    size={10}
                    aria-hidden="true"
                    className="ml-1 inline-block align-baseline"
                  />
                </span>
                <span className="sr-only">, opens in a new tab</span>
              </a>
            ) : (
              <span className="text-text-secondary">{provider.name}</span>
            )}
            {provider.note && <span> ({provider.note})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default Attribution;

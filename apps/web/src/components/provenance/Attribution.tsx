import type { Evidence, SourceId } from '@liner-notes/contract';
import { ExternalLink } from 'lucide-react';
import type React from 'react';
import { useId } from 'react';
import { measuredAudioOf } from '../../constants';
import type { TrackData } from '../../types';
import type { ShownLink } from '../genealogy/links';
import { type ResultClaims, SOURCE_NAMES, safeHref } from './claims';
import { LINE } from './ClaimChip';

// Where the data on the page comes from, provider by provider, with a link back to each: the
// sources the listed claims and the drawn links cite (each claim keeps its own source link too),
// Spotify when the result links to the track there, and the provider of the preview when the
// page plays it or measured it. Plain names and links: no logos. A provider whose data the page
// does not show is not listed.

/** The provider's own site, linked when there is no address of the track itself. */
const HOME: Record<SourceId, string | null> = {
  spotify: 'https://open.spotify.com',
  deezer: 'https://www.deezer.com',
  musicbrainz: 'https://musicbrainz.org',
  discogs: 'https://www.discogs.com',
  secondhandsongs: 'https://secondhandsongs.com',
  listenbrainz: 'https://listenbrainz.org',
  lastfm: 'https://www.last.fm',
  genius: 'https://genius.com',
  // Search results are web pages of many sites: each is linked beside the claim citing it.
  tavily: null,
};

/** The order providers are listed in: record databases first, then services, then the web. */
const ORDER: readonly SourceId[] = [
  'musicbrainz',
  'discogs',
  'secondhandsongs',
  'listenbrainz',
  'lastfm',
  'genius',
  'spotify',
  'deezer',
  'tavily',
];

/** A provider whose data the page shows. */
export interface ShownProvider {
  source: SourceId;
  name: string;
  /** Its link back: the track's own page when known, else the provider's site; null: none. */
  href: string | null;
  /** What of its data is shown, when it is more than cited records ("preview"). */
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
 * measured on it): the result's `preview.provider`, else the clip's host. Null when no preview
 * is used, or when which provider it came from is not known (never guessed).
 */
export function previewProvider(track: TrackData): 'deezer' | 'spotify' | null {
  const used = Boolean(track.previewUrl) || measuredAudioOf(track) !== null;
  if (!used) return null;
  const match = (track as { preview?: unknown }).preview;
  if (typeof match === 'object' && match !== null) {
    const provider = (match as { provider?: unknown }).provider;
    if (provider === 'deezer' || provider === 'spotify') return provider;
  }
  return previewHost(track.previewUrl);
}

/** The providers whose data the page shows, in the order they are listed. */
export function shownProviders(
  track: TrackData,
  claims: Pick<ResultClaims, 'shown' | 'rejected'>,
  links: readonly ShownLink[],
  /** The tracks the graph draws (the related tracks whose preview it can play). */
  nodes: readonly unknown[] = Array.isArray(track.genealogy?.nodes) ? track.genealogy.nodes : [],
): ShownProvider[] {
  const cited = new Set<SourceId>();
  const note = (items: readonly (Evidence | null)[]) => {
    for (const item of items) if (item) cited.add(item.source);
  };
  // The listed claims (the rejected ones are listed too, with their sources) and drawn links.
  for (const shown of [...claims.shown, ...claims.rejected]) note(shown.cited);
  for (const link of links) note(link.citations.map((citation) => citation.evidence));

  const spotifyTrack = safeHref(track.spotifyUrl);
  const preview = previewProvider(track);
  // A related track's preview the graph can play.
  const nodePreviews = nodes.map((node) =>
    previewHost((node as { previewUrl?: unknown } | null)?.previewUrl),
  );
  const previews = new Set([preview, ...nodePreviews]);

  const providers: ShownProvider[] = [];
  for (const source of ORDER) {
    const listed =
      cited.has(source) ||
      (source === 'spotify' && (spotifyTrack !== null || previews.has('spotify'))) ||
      (source === 'deezer' && previews.has('deezer'));
    if (!listed) continue;
    const href = source === 'spotify' && spotifyTrack ? spotifyTrack : HOME[source];
    const notes = [
      previews.has(source as 'deezer' | 'spotify') ? 'preview' : null,
      source === 'tavily' ? 'each page is linked beside its claim' : null,
    ].filter(Boolean);
    providers.push({
      source,
      name: SOURCE_NAMES[source],
      href,
      note: notes.length > 0 ? notes.join(', ') : null,
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
                className="text-text-secondary underline underline-offset-2 decoration-white/30 hover:text-white hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber focus-visible:ring-offset-2 focus-visible:ring-offset-void rounded-sm"
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

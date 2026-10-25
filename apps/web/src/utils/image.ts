// Album art hosts the API returns (Spotify). Matched exactly: a host that merely contains one
// of these names (i.scdn.co.example.com, evil-i.scdn.co) is not accepted.
const VALID_IMAGE_HOSTS = new Set(['i.scdn.co', 'mosaic.scdn.co']);

export function isValidImageUrl(url: string | null | undefined): url is string {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      VALID_IMAGE_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const ARCHIVE_HOST = 'coverartarchive.org';
const RELEASE_PATH =
  /^\/release\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/;

/**
 * The MusicBrainz release MBID of a Cover Art Archive image link
 * (https://coverartarchive.org/release/<mbid>/front-500), or null for any other URL: another
 * host (matched exactly), plain http, a port or credentials, or a path that is not a release's.
 */
export function archiveReleaseOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hostname !== ARCHIVE_HOST
    ) {
      return null;
    }
    return RELEASE_PATH.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The Cover Art Archive's page of a release, where a credit links to. */
export const archiveReleasePage = (mbid: string) => `https://${ARCHIVE_HOST}/release/${mbid}`;

/** A title compared as names are: case, accents and punctuation aside. */
function comparable(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

const RELEASE_TITLE_SUFFIX = ' — MusicBrainz release';

/**
 * The title of the release a result's MusicBrainz evidence names, by the release's MBID: the
 * item `musicbrainz:release/<mbid>` the API writes, titled "<release> — MusicBrainz release".
 * Null when the result has no such item.
 */
export function releaseTitleOf(evidence: unknown, mbid: string): string | null {
  if (!Array.isArray(evidence)) return null;
  const item = evidence.find(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { id?: unknown }).id === `musicbrainz:release/${mbid}` &&
      (entry as { source?: unknown }).source === 'musicbrainz',
  ) as { title?: unknown } | undefined;
  const title = typeof item?.title === 'string' ? item.title : '';
  if (!title.endsWith(RELEASE_TITLE_SUFFIX)) return null;
  return title.slice(0, -RELEASE_TITLE_SUFFIX.length).trim() || null;
}

/** How a cover is named: its alt text, and its credit when it comes from the archive. */
export interface CoverLabels {
  alt: string;
  credit: { text: string; href: string } | null;
}

/**
 * The alt text and credit of a result's cover. A Cover Art Archive cover is credited to the
 * archive, linked to the release's page there; when the result's evidence names that release
 * and its title is not the album the result shows, the alt text and the credit name it, so the
 * cover is never taken for the shown album's. Any other cover is the shown album's.
 */
export function coverLabels(
  src: string | null,
  album: string | null | undefined,
  evidence: unknown,
): CoverLabels {
  const shown = typeof album === 'string' ? album.trim() : '';
  const mbid = src ? archiveReleaseOf(src) : null;
  if (!mbid) return { alt: shown ? `Cover of ${shown}` : 'Album cover', credit: null };
  const href = archiveReleasePage(mbid);
  const release = releaseTitleOf(evidence, mbid);
  const named = (title: string) => ({
    alt: `Cover of ${title}`,
    credit: { text: `Cover: ${title} · Cover Art Archive`, href },
  });
  const unnamed = {
    alt: 'Cover from the Cover Art Archive',
    credit: { text: 'Cover: Cover Art Archive', href },
  };
  if (!release) return unnamed;
  // No album shown: the release is named when its title has letters or digits to name it by.
  if (shown === '') return comparable(release) === '' ? unnamed : named(release);
  if (comparable(release) !== comparable(shown)) return named(release);
  return { alt: `Cover of ${shown}`, credit: unnamed.credit };
}

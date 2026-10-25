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
 * (https://coverartarchive.org/release/<mbid>/front-250), or null for any other URL: another
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

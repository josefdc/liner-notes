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

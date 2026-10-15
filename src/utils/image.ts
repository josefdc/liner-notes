const VALID_IMAGE_DOMAINS = ['i.scdn.co', 'mosaic.scdn.co', 'images.unsplash.com', 'picsum.photos'];

export function isValidImageUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return VALID_IMAGE_DOMAINS.some(domain => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
}

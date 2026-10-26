/** Where the app's source code is published, when the build names no other place. */
export const DEFAULT_SOURCE_URL = 'https://github.com/josefdc/liner-notes';

/**
 * The address the footer's "Source" link opens: `VITE_SOURCE_URL` at build time, so a modified
 * version served to others links to its own source, or the public repository when it is unset,
 * empty or not an http(s) address.
 */
export function sourceUrl(configured: string | undefined): string {
  const value = configured?.trim();
  if (!value) return DEFAULT_SOURCE_URL;
  try {
    const { protocol } = new URL(value);
    if (protocol === 'https:' || protocol === 'http:') return value;
  } catch {
    // Not an absolute address: the default below.
  }
  return DEFAULT_SOURCE_URL;
}

export const SOURCE_URL = sourceUrl(import.meta.env.VITE_SOURCE_URL);

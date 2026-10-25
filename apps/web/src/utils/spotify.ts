// Spotify track ids as the API accepts them with an analysis request (22 base-62 characters).

const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;

/** True for a Spotify track id; graph node ids and placeholders such as "search" are not. */
export function isSpotifyTrackId(value: string | null | undefined): value is string {
  return typeof value === 'string' && SPOTIFY_TRACK_ID.test(value);
}

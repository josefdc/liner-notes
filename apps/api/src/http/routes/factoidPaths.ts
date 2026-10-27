/**
 * The paths of the "more facts" routes (./factoids.ts), in one place: the middleware that
 * answers a stream route's failures inside the stream reads them too.
 */

/** POST: three facts at once. */
export const FACTOIDS_PATH = "/api/factoids/more";
/** GET: the facts as server-sent events. */
export const FACTOIDS_STREAM_PATH = "/api/factoids/more/stream";

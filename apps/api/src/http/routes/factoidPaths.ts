/**
 * The paths of the "more facts" routes (./factoids.ts), in one place: the middleware that
 * answers a stream route's failures inside the stream reads them too.
 */

/** POST: three facts at once. */
export const FACTOIDS_PATH = "/api/factoids/more";
/** GET: the facts as server-sent events. */
export const FACTOIDS_STREAM_PATH = "/api/factoids/more/stream";

/**
 * Deprecated: the routes' paths before they were renamed, answered exactly as the new ones for
 * one more release so a client built before the rename keeps working. Remove them in the
 * release after.
 */
export const DEPRECATED_FACTOIDS_PATH = "/api/factoids/decrypt";
/** Deprecated: see DEPRECATED_FACTOIDS_PATH. */
export const DEPRECATED_FACTOIDS_STREAM_PATH = "/api/factoids/decrypt/stream";

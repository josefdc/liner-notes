import type { RequestHandler } from "express";

/** Content codings a request body may use. The web client never compresses its bodies. */
const ACCEPTED_CODINGS = new Set(["identity", "gzip", "deflate"]);

/**
 * Refuses a request body in any other content coding with 415 `unsupported_media_type`, before
 * the body parser sees it. The JSON parser also decodes brotli, whose decoder allocates a
 * window of up to 16 MB for a body of a few bytes, well before the decoded-size limit stops it.
 * Several codings at once (e.g. "gzip, br") are refused too. A request without a body passes.
 */
export const acceptedEncodingsOnly: RequestHandler = (req, _res, next) => {
  const coding = req.headers["content-encoding"];
  // An empty header means identity, as the body parser reads it.
  const name = coding?.trim().toLowerCase() ?? "";
  if (name === "" || !hasBody(req.headers) || ACCEPTED_CODINGS.has(name)) {
    next();
    return;
  }
  // The error handler answers it as it answers the body parser's own errors.
  next(
    Object.assign(new Error(`unsupported content encoding "${coding}"`), {
      status: 415,
      type: "encoding.unsupported",
    }),
  );
};

/** As the body parser decides it: a Transfer-Encoding, or a numeric Content-Length. */
function hasBody(headers: { "transfer-encoding"?: string; "content-length"?: string }): boolean {
  return (
    headers["transfer-encoding"] !== undefined ||
    (headers["content-length"] !== undefined && !Number.isNaN(Number(headers["content-length"])))
  );
}

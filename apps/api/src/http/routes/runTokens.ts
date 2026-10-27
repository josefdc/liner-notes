import { RunTokenRequest } from "@liner-notes/contract";
import { Router } from "express";
import { logger } from "../../logger.js";
import { asyncRoute, sendError } from "../middleware/errors.js";
import type { RunTokens } from "../runToken.js";
import { MAX_TURNSTILE_TOKEN_LENGTH, type TurnstileVerifier } from "../turnstile.js";

const log = logger("HTTP");

export interface RunTokenRouterOptions {
  tokens: RunTokens;
  verifyTurnstile: TurnstileVerifier;
}

/**
 * POST /api/runs: a run token for a visitor who has passed Turnstile.
 *
 * Body: RunTokenRequest `{ "turnstileToken": "..." }` (under the development bypass, the token
 * "dev-bypass"). Returns RunTokenResponse `{ success, runToken, expiresAt }`: the token starts one
 * analysis within five minutes, and is accepted by that analysis's resume and by factoid
 * requests until `expiresAt` (http/runToken.ts). It goes in the `runToken` query parameter.
 *
 * The app checks the origin and a per-IP limit before the body is read (app.ts). Refusals: 400
 * `invalid_input` for a body that is not a RunTokenRequest; 401 `auth_expired` when Turnstile
 * rejects the token; 500 `failed` when Turnstile cannot be asked (the check fails closed).
 * Only the outcome is logged, never the body or either token.
 */
export function createRunTokenRouter({ tokens, verifyTurnstile }: RunTokenRouterOptions): Router {
  const router = Router();

  router.post(
    "/api/runs",
    asyncRoute(async (req, res) => {
      const parsed = RunTokenRequest.safeParse(req.body ?? {});
      if (!parsed.success || parsed.data.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) {
        log.info("Run token refused: invalid_input");
        sendError(res, "invalid_input");
        return;
      }
      const check = await verifyTurnstile(parsed.data.turnstileToken, req.ip);
      if (!check.ok) {
        const code = check.reason === "rejected" ? "auth_expired" : "failed";
        log.info(`Run token refused: ${code}`);
        sendError(res, code);
        return;
      }
      const { runToken, claims } = tokens.mint();
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, runToken, expiresAt: new Date(claims.expiresAt).toISOString() });
    }),
  );

  return router;
}

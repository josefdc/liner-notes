// What a committed cassette or run record must never hold: a credential in a service's own
// format (the shapes the replay recorder refuses, apps/api/src/replay/secretShapes.test.ts), a
// credential sent as a header or a field, a preview link (they are signed and expire), or a
// signed link's parameters. Preview hosts are matched with or without a scheme, so a link a
// source wrote into an error body without one is caught too. Pure: text in, rule names out.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT } from "./golden.mjs";

/** The committed directories the scan covers. */
export const SCANNED_DIRS = ["fixtures/cassettes", "evals/agent/runs"];

/** Each rule: what it finds, and the pattern. A redacted value ("[redacted]") passes. */
export const RULES = [
  // Credentials in their services' formats.
  { name: "a Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "a Stripe key", re: /\b[rs]k_live_[0-9A-Za-z]{16,}/ },
  { name: "a Turnstile secret", re: /0x4AAAAAAA[0-9A-Za-z_-]{20,}/ },
  { name: "a Hugging Face token", re: /\bhf_[A-Za-z]{30,}/ },
  { name: "a GitLab token", re: /\bglpat-[0-9A-Za-z_-]{20,}/ },
  { name: "a GitHub token", re: /\b(?:ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{40,})/ },
  { name: "a Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: "an AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "a Tavily key", re: /\btvly-[0-9A-Za-z_-]{16,}/ },
  { name: "an OpenAI-style key", re: /\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}/ },
  // Credentials as headers and fields.
  { name: "an api-key header", re: /\b(?:api-key|ocp-apim-subscription-key|x-api-key)\b/i },
  { name: "an Authorization header", re: /\bauthorization"?\s*[:=]/i },
  { name: "a bearer token", re: /\bBearer\s+(?!\[redacted\])[0-9A-Za-z._~+/-]{8,}/ },
  {
    name: "a token or secret field",
    re: /"(?:access_token|refresh_token|id_token|client_secret|api_key|apikey)"\s*:\s*"(?!\[redacted\]")[^"]+"/i,
  },
  {
    name: "a credential in a query",
    re: /[?&](?:api_key|apikey|key|token|access_token|client_secret|sig|signature)=(?!\[redacted\])[^&\s"]+/i,
  },
  // Preview links, with or without a scheme, and signed links' parameters.
  { name: "a Deezer preview host", re: /\b(?:cdn[st]-preview(?:-[0-9a-z])?\.)?dzcdn\.net\b/i },
  { name: "a Spotify CDN host", re: /\b(?:[0-9a-z-]+\.)?scdn\.co\b/i },
  {
    name: "a signed link's parameter",
    re: /\b(?:hdnea|hmac|acl|exp|Expires|Signature|Key-Pair-Id|X-Amz-[A-Za-z]+)=/,
  },
];

/** The rules a text breaks, by name. */
export function scanText(text) {
  return RULES.filter((r) => r.re.test(text)).map((r) => r.name);
}

/** Every committed file of SCANNED_DIRS that breaks a rule: [{ file, rules }]. */
export function scanCommitted(root = REPO_ROOT) {
  const out = [];
  for (const dir of SCANNED_DIRS) {
    let names;
    try {
      names = readdirSync(join(root, dir), { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(root, dir, name);
      const rules = scanText(readFileSync(path, "utf8"));
      if (rules.length) out.push({ file: relative(root, path), rules });
    }
  }
  return out;
}

/**
 * Reads and validates the API's settings from an environment. Pure: it never loads a file or
 * exits, so tests can call it with any environment. config/env.ts applies it to process.env
 * once at startup.
 */

export interface RateLimitSettings {
  /** Length of the window, in milliseconds. */
  windowMs: number;
  /** Requests allowed per IP address in one window. */
  max: number;
}

export interface HttpSettings {
  /** Origins allowed to call the API from a browser (exact `scheme://host[:port]` matches). */
  corsOrigins: string[];
  /** Number of reverse proxies in front of the API whose X-Forwarded-For is trusted; 0 = none. */
  trustProxy: number;
  /** Per-IP limit for the routes that call paid services (analysis and factoids). */
  rateLimit: RateLimitSettings;
  /** Limit shared by all clients on the same routes, over the same window. */
  globalRateLimit: RateLimitSettings;
  /** Limit for search suggestions (Spotify). */
  searchRateLimit: RateLimitSettings;
}

/** Which optional primary-record sources have a credential; the others report "missing". */
export interface SourceSettings {
  discogs: boolean;
  secondhandsongs: boolean;
  genius: boolean;
}

export interface Settings {
  production: boolean;
  /** REPLAY_MODE=only (replaying recorded runs): no Spotify or model keys are required. */
  replayOnly: boolean;
  host: string;
  port: number;
  http: HttpSettings;
  sources: SourceSettings;
}

export type SettingsResult =
  | { ok: true; settings: Settings; warnings: string[] }
  | { ok: false; errors: string[] };

/** Keys the API cannot start without, outside REPLAY_MODE=only. */
export const REQUIRED_KEYS = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"] as const;

/**
 * Optional credentials of the primary-record sources, each sent in a request header: Discogs
 * (`Authorization: Discogs token=…`), SecondHandSongs (`X-API-Key`; without it requests are
 * anonymous) and Genius (`Authorization: Bearer …`).
 */
export const SOURCE_CREDENTIALS = {
  discogs: "DISCOGS_TOKEN",
  secondhandsongs: "SHS_API_KEY",
  genius: "GENIUS_ACCESS_TOKEN",
} as const satisfies Record<keyof SourceSettings, string>;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3001;
export const DEFAULT_RATE_LIMIT: RateLimitSettings = { windowMs: 10 * 60_000, max: 30 };
export const DEFAULT_GLOBAL_RATE_LIMIT_MAX = 300;
export const DEFAULT_SEARCH_RATE_LIMIT: RateLimitSettings = { windowMs: 60_000, max: 60 };

// The web dev server's ports: 3000, the worktree slots 3100-3190 and Vite's preview port.
const DEV_WEB_PORTS = [3000, 3100, 3110, 3120, 3130, 3140, 3150, 3160, 3170, 3180, 3190, 4173];

/** Origins allowed in development when CORS_ORIGINS is not set. */
export function developmentOrigins(webPort?: string): string[] {
  const ports = new Set(DEV_WEB_PORTS.map(String));
  if (webPort && /^\d{1,5}$/.test(webPort)) ports.add(webPort);
  return [...ports].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

function parseOrigins(value: string, errors: string[]): string[] {
  const origins: string[] = [];
  for (const entry of value.split(",")) {
    const origin = entry.trim();
    if (!origin) continue;
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      // reported below
    }
    // Browsers send an origin without its scheme's default port.
    if (
      url &&
      ["http:", "https:"].includes(url.protocol) &&
      url.port === "" &&
      url.origin !== origin
    ) {
      const explicit = origin.match(/^https?:\/\/[^/]+:(\d+)$/);
      if (explicit) {
        errors.push(
          `CORS_ORIGINS: "${origin}" names the default port ${explicit[1]}, which browsers leave out of the Origin header; write "${url.origin}"`,
        );
        continue;
      }
    }
    if (!url || !["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      errors.push(
        `CORS_ORIGINS: "${origin}" is not an origin (expected scheme://host[:port], no path or trailing slash)`,
      );
      continue;
    }
    origins.push(origin);
  }
  return origins;
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${key}: expected an integer from ${min} to ${max}, got "${raw}"`);
    return fallback;
  }
  return value;
}

export function readSettings(env: NodeJS.ProcessEnv): SettingsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === "production";
  const replayMode = env.REPLAY_MODE?.trim() ?? "";
  if (!["", "off", "only"].includes(replayMode)) {
    errors.push(`REPLAY_MODE: expected "only" or "off", got "${replayMode}"`);
  }
  const replayOnly = replayMode === "only";

  if (!replayOnly) {
    const missing = REQUIRED_KEYS.filter((key) => !env[key]);
    if (missing.length > 0) {
      errors.push(`Missing required environment variables: ${missing.join(", ")}`);
    }
  }

  const host = env.HOST?.trim() || DEFAULT_HOST;
  const port = parseInteger(env, "PORT", DEFAULT_PORT, 0, 65_535, errors);

  let corsOrigins: string[];
  if (env.CORS_ORIGINS !== undefined) {
    corsOrigins = parseOrigins(env.CORS_ORIGINS, errors);
    if (corsOrigins.length === 0) {
      warnings.push("CORS_ORIGINS is empty: browsers on other origins cannot call the API");
    }
  } else if (production) {
    corsOrigins = [];
    warnings.push("CORS_ORIGINS is not set: browsers on other origins cannot call the API");
  } else {
    corsOrigins = developmentOrigins(env.WEB_PORT);
  }

  // Hop counts only: trusting every proxy would let any client choose its rate-limit key.
  const trustProxy = parseInteger(env, "TRUST_PROXY", 0, 0, 10, errors);

  const rateLimit: RateLimitSettings = {
    windowMs: parseInteger(
      env,
      "RATE_LIMIT_WINDOW_MS",
      DEFAULT_RATE_LIMIT.windowMs,
      1000,
      86_400_000,
      errors,
    ),
    max: parseInteger(env, "RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max, 1, 100_000, errors),
  };
  const globalRateLimit: RateLimitSettings = {
    windowMs: rateLimit.windowMs,
    max: parseInteger(
      env,
      "RATE_LIMIT_GLOBAL_MAX",
      DEFAULT_GLOBAL_RATE_LIMIT_MAX,
      1,
      10_000_000,
      errors,
    ),
  };
  const searchRateLimit: RateLimitSettings = {
    windowMs: parseInteger(
      env,
      "SEARCH_RATE_LIMIT_WINDOW_MS",
      DEFAULT_SEARCH_RATE_LIMIT.windowMs,
      1000,
      86_400_000,
      errors,
    ),
    max: parseInteger(
      env,
      "SEARCH_RATE_LIMIT_MAX",
      DEFAULT_SEARCH_RATE_LIMIT.max,
      1,
      100_000,
      errors,
    ),
  };

  const sources = {} as SourceSettings;
  for (const [source, key] of Object.entries(SOURCE_CREDENTIALS)) {
    const value = env[key] ?? "";
    // Sent in a header: a token is printable ASCII, with no space or line break.
    if (!/^[!-~]*$/.test(value)) {
      errors.push(`${key}: expected printable ASCII with no spaces`);
    }
    sources[source as keyof SourceSettings] = value !== "";
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    settings: {
      production,
      replayOnly,
      host,
      port,
      http: { corsOrigins, trustProxy, rateLimit, globalRateLimit, searchRateLimit },
      sources,
    },
  };
}

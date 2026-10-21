import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_RATE_LIMIT_MAX,
  DEFAULT_HOST,
  DEFAULT_RATE_LIMIT,
  developmentOrigins,
  readSettings,
  type Settings,
} from "./settings.js";

const KEYS = { SPOTIFY_CLIENT_ID: "x", SPOTIFY_CLIENT_SECRET: "x" };

function settingsOf(env: NodeJS.ProcessEnv): Settings {
  const result = readSettings(env);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.settings;
}

function errorsOf(env: NodeJS.ProcessEnv): string {
  const result = readSettings(env);
  if (result.ok) throw new Error("expected invalid settings");
  return result.errors.join("; ");
}

describe("readSettings", () => {
  it("requires the Spotify keys", () => {
    expect(errorsOf({})).toContain("SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET");
    expect(errorsOf({ SPOTIFY_CLIENT_ID: "x" })).toContain("SPOTIFY_CLIENT_SECRET");
  });

  it("needs no Spotify or model keys with REPLAY_MODE=only", () => {
    const settings = settingsOf({ REPLAY_MODE: "only" });
    expect(settings.replayOnly).toBe(true);
  });

  it("accepts REPLAY_MODE only as only, off or unset", () => {
    expect(settingsOf({ ...KEYS, REPLAY_MODE: "off" }).replayOnly).toBe(false);
    expect(settingsOf({ ...KEYS, REPLAY_MODE: "" }).replayOnly).toBe(false);
    expect(settingsOf(KEYS).replayOnly).toBe(false);
    for (const value of ["on", "ONLY", "true", "1"]) {
      expect(errorsOf({ ...KEYS, REPLAY_MODE: value })).toContain("REPLAY_MODE");
    }
  });

  it("warns when CORS_ORIGINS is set but empty", () => {
    const result = readSettings({ ...KEYS, CORS_ORIGINS: " , " });
    expect(result.ok && result.warnings.join(" ")).toContain("CORS_ORIGINS is empty");
    const listed = readSettings({ ...KEYS, CORS_ORIGINS: "http://localhost:3000" });
    expect(listed.ok && listed.warnings).toEqual([]);
  });

  it("has a limit across all clients on the paid routes, over the per-IP window", () => {
    expect(settingsOf(KEYS).http.globalRateLimit).toEqual({
      windowMs: DEFAULT_RATE_LIMIT.windowMs,
      max: DEFAULT_GLOBAL_RATE_LIMIT_MAX,
    });
    expect(
      settingsOf({ ...KEYS, RATE_LIMIT_GLOBAL_MAX: "50", RATE_LIMIT_WINDOW_MS: "60000" }).http
        .globalRateLimit,
    ).toEqual({ windowMs: 60_000, max: 50 });
    expect(errorsOf({ ...KEYS, RATE_LIMIT_GLOBAL_MAX: "0" })).toContain("RATE_LIMIT_GLOBAL_MAX");
  });

  it("binds 127.0.0.1 by default and takes HOST and PORT from the environment", () => {
    expect(settingsOf(KEYS)).toMatchObject({ host: DEFAULT_HOST, port: 3001 });
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(settingsOf({ ...KEYS, HOST: "0.0.0.0", PORT: "3111" })).toMatchObject({
      host: "0.0.0.0",
      port: 3111,
    });
  });

  it("rejects a port that is not an integer in range", () => {
    expect(errorsOf({ ...KEYS, PORT: "abc" })).toContain("PORT");
    expect(errorsOf({ ...KEYS, PORT: "70000" })).toContain("PORT");
  });

  it("allows the local web ports in development when CORS_ORIGINS is not set", () => {
    const { corsOrigins } = settingsOf(KEYS).http;
    expect(corsOrigins).toEqual(expect.arrayContaining(developmentOrigins()));
    expect(corsOrigins).toContain("http://localhost:3000");
    expect(corsOrigins).toContain("http://127.0.0.1:3110");
    expect(settingsOf({ ...KEYS, WEB_PORT: "3290" }).http.corsOrigins).toContain(
      "http://localhost:3290",
    );
  });

  it("allows no origin in production when CORS_ORIGINS is not set, with a warning", () => {
    const result = readSettings({ ...KEYS, NODE_ENV: "production" });
    expect(result.ok && result.settings.http.corsOrigins).toEqual([]);
    expect(result.ok && result.warnings.join(" ")).toContain("CORS_ORIGINS");
  });

  it("reads CORS_ORIGINS as a comma-separated list of exact origins", () => {
    const env = {
      ...KEYS,
      CORS_ORIGINS: " https://app.example , http://localhost:3110,",
      NODE_ENV: "production",
    };
    expect(settingsOf(env).http.corsOrigins).toEqual([
      "https://app.example",
      "http://localhost:3110",
    ]);
    expect(settingsOf({ ...KEYS, CORS_ORIGINS: "" }).http.corsOrigins).toEqual([]);
  });

  it.each([
    "*",
    "https://app.example/",
    "https://app.example/path",
    "app.example",
    "ftp://x.example",
  ])("rejects %s as a CORS origin", (origin) => {
    expect(errorsOf({ ...KEYS, CORS_ORIGINS: origin })).toContain("CORS_ORIGINS");
  });

  it("explains that a default port must be left out of a CORS origin", () => {
    expect(errorsOf({ ...KEYS, CORS_ORIGINS: "http://localhost:80" })).toContain(
      'default port 80, which browsers leave out of the Origin header; write "http://localhost"',
    );
    expect(errorsOf({ ...KEYS, CORS_ORIGINS: "https://app.example:443" })).toContain(
      'write "https://app.example"',
    );
  });

  it("trusts no proxy by default and takes a hop count", () => {
    expect(settingsOf(KEYS).http.trustProxy).toBe(0);
    expect(settingsOf({ ...KEYS, TRUST_PROXY: "1" }).http.trustProxy).toBe(1);
    expect(errorsOf({ ...KEYS, TRUST_PROXY: "true" })).toContain("TRUST_PROXY");
  });

  it("has rate-limit defaults and validates overrides", () => {
    expect(settingsOf(KEYS).http.rateLimit).toEqual(DEFAULT_RATE_LIMIT);
    expect(
      settingsOf({ ...KEYS, RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_MS: "60000" }).http.rateLimit,
    ).toEqual({ max: 5, windowMs: 60_000 });
    expect(errorsOf({ ...KEYS, RATE_LIMIT_MAX: "0" })).toContain("RATE_LIMIT_MAX");
    expect(errorsOf({ ...KEYS, SEARCH_RATE_LIMIT_MAX: "-1" })).toContain("SEARCH_RATE_LIMIT_MAX");
  });

  it("treats the primary-record source credentials as optional", () => {
    expect(settingsOf(KEYS).sources).toEqual({
      discogs: false,
      secondhandsongs: false,
      genius: false,
    });
    const result = readSettings({ ...KEYS, DISCOGS_TOKEN: "", GENIUS_ACCESS_TOKEN: "abc123" });
    expect(result.ok && result.warnings).toEqual([]);
    expect(result.ok && result.settings.sources).toEqual({
      discogs: false,
      secondhandsongs: false,
      genius: true,
    });
    expect(settingsOf({ ...KEYS, SHS_API_KEY: "k" }).sources.secondhandsongs).toBe(true);
  });

  it("rejects a source credential that cannot be sent in a header", () => {
    expect(errorsOf({ ...KEYS, DISCOGS_TOKEN: "abc def" })).toContain("DISCOGS_TOKEN");
    expect(errorsOf({ ...KEYS, GENIUS_ACCESS_TOKEN: "abc\n" })).toContain("GENIUS_ACCESS_TOKEN");
    expect(errorsOf({ ...KEYS, SHS_API_KEY: " abc" })).toContain("SHS_API_KEY");
    // The message names the variable, never its value.
    expect(errorsOf({ ...KEYS, DISCOGS_TOKEN: "secret value" })).not.toContain("secret");
  });
});

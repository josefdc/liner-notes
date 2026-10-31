/**
 * LLM_RUN_PURPOSE: the purpose an evaluation harness starts the API with. Every model call of
 * the process is tagged with it (the spend log's `unit`), it is refused in production and with
 * REPLAY_MODE=only, and any value but an evaluation sub-purpose is refused.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntime, defaultAgentRuntime } from "../agent/runtime.js";
import { modelClaim, trackRecord } from "../agent/verifier/testing.js";
import { judgeClaims } from "../agent/verifier/judge.js";
import { createLlm } from "../llm/invoke.js";
import { parseSpendLog } from "../llm/spendLog.js";
import { providerFetch, responseBody, testSettings } from "../llm/testing/providerStub.js";
import { readLlmSettings, readRunPurpose, readSettings } from "./settings.js";

const KEYS = { SPOTIFY_CLIENT_ID: "x", SPOTIFY_CLIENT_SECRET: "x" };
const PRODUCTION_SECRETS = {
  RUN_TOKEN_SECRET: "test-only-run-token-secret-of-at-least-32-bytes",
  TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAME: "liner-notes.example",
};

/** The startup errors of `env`, joined; "" when the API would start. */
function startupErrors(env: NodeJS.ProcessEnv): string {
  const result = readSettings(env);
  return result.ok ? "" : result.errors.join("; ");
}

describe("LLM_RUN_PURPOSE at startup", () => {
  it("accepts each evaluation sub-purpose, and is dev when unset or empty", () => {
    for (const purpose of ["eval:golden", "eval:variance", "eval:baseline", "eval:perturb"]) {
      const env = { NODE_ENV: "test", ...KEYS, LLM_RUN_PURPOSE: purpose };
      expect(startupErrors(env), purpose).toBe("");
      expect(readRunPurpose(env)).toEqual({ purpose, error: null });
    }
    expect(readRunPurpose({ NODE_ENV: "test" })).toEqual({ purpose: "dev", error: null });
    expect(readRunPurpose({ LLM_RUN_PURPOSE: " " })).toEqual({ purpose: "dev", error: null });
  });

  it("is refused when NODE_ENV=production", () => {
    const production = { NODE_ENV: "production", ...KEYS, ...PRODUCTION_SECRETS };
    // The same settings start without it.
    expect(startupErrors(production)).toBe("");
    const refused = { ...production, LLM_RUN_PURPOSE: "eval:golden" };
    expect(startupErrors(refused)).toBe(
      "LLM_RUN_PURPOSE is not allowed when NODE_ENV=production: it is for evaluation runs",
    );
    // Its calls would not be tagged with it either.
    expect(readRunPurpose(refused).purpose).toBe("dev");
  });

  it("is refused with REPLAY_MODE=only", () => {
    const replay = { NODE_ENV: "test", REPLAY_MODE: "only" };
    expect(startupErrors(replay)).toBe("");
    const refused = { ...replay, LLM_RUN_PURPOSE: "eval:golden" };
    expect(startupErrors(refused)).toBe(
      "LLM_RUN_PURPOSE is not allowed with REPLAY_MODE=only: a replay makes no model call",
    );
    expect(readRunPurpose(refused).purpose).toBe("dev");
  });

  it.each(["eval", "dev", "showcase", "eval:gold", "EVAL:GOLDEN", "U-39 S5"])(
    "refuses %s",
    (value) => {
      const env = { NODE_ENV: "test", ...KEYS, LLM_RUN_PURPOSE: value };
      expect(startupErrors(env)).toBe(
        "LLM_RUN_PURPOSE: expected one of eval:golden, eval:baseline, eval:perturb, eval:variance, or unset",
      );
      // The model layer refuses every call too, rather than tagging it with another purpose.
      expect(readLlmSettings(env).errors).toContain(readRunPurpose(env).error);
      expect(readRunPurpose(env).purpose).toBe("dev");
    },
  );
});

describe("the purpose of the API's model calls", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-purpose-"));
    log = join(dir, "spend.jsonl");
    writeFileSync(log, "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REPLAY_MODE", "");
    vi.stubGlobal("fetch", () => {
      throw new Error("network denied");
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Judges one claim with the API's default runtime and a stubbed provider; the spend lines. */
  async function judgeOnce() {
    const net = providerFetch(() =>
      Response.json(
        responseBody(
          { verdicts: [{ claimId: "c1", verdict: "supported", reason: "Excerpt e1 says so." }] },
          { input: 400, output: 60 },
        ),
      ),
    );
    const llm = createLlm({
      settings: testSettings({ LLM_SPEND_LOG: log }),
      fetch: net.fetch,
      recordUsage: () => {},
    });
    const claim = modelClaim("m1", { evidenceIds: ["e1"] });
    const track = { title: "Ice Ice Baby", artist: "Vanilla Ice", album: null, year: "1990" };
    const result = await judgeClaims([claim], [trackRecord("e1")], track, agentRuntime({ llm }), {
      runId: "run-1",
    });
    expect(result.failure).toBeNull();
    expect(net.calls).toHaveLength(1);
    return parseSpendLog(readFileSync(log, "utf8"));
  }

  it("tags every spend line with LLM_RUN_PURPOSE, and with dev when it is unset", async () => {
    vi.stubEnv("LLM_RUN_PURPOSE", "eval:golden");
    expect(defaultAgentRuntime.purpose).toBe("eval:golden");
    expect((await judgeOnce()).map((line) => [line.kind, line.unit])).toEqual([
      ["reserve", "eval:golden"],
      ["settle", "eval:golden"],
    ]);

    vi.stubEnv("LLM_RUN_PURPOSE", "");
    expect((await judgeOnce()).map((line) => [line.kind, line.unit])).toEqual([
      ["reserve", "eval:golden"],
      ["settle", "eval:golden"],
      ["reserve", "dev"],
      ["settle", "dev"],
    ]);
  });
});

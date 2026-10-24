// Only config/env.ts loads a settings file (apps/api/.env), and only entry points import it.
// Tests never read one, even when a test imports an entry point's module graph, so a developer's
// file (real credentials, a custom User-Agent, rate limits) cannot change what they check; a
// test that needs a setting sets it. The child processes that src/index.test.ts and
// src/scripts/smokeLlm.test.ts start load the file for real and pin every setting they rely on.
// CI runs the API tests once with .env.example in place.
import { vi } from "vitest";

vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { default: { config }, config };
});

// The routes read REPLAY_MODE and REPLAY_DIR on every request, so a value exported in the shell
// (such as the public default "fallback") would change what the route tests check. A test that
// needs replay mode sets it itself.
delete process.env.REPLAY_MODE;
delete process.env.REPLAY_DIR;

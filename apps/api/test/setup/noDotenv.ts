// Only config/env.ts loads a settings file (apps/api/.env), and only entry points import it.
// Tests never read one, even when a test imports an entry point's module graph, so a developer's
// file (real credentials, a custom User-Agent, rate limits) cannot change what they check; a
// test that needs a setting sets it. The child processes index.test.ts starts load the file for
// real and pin every setting they rely on. CI runs the API tests once with .env.example in place.
import { vi } from "vitest";

vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { default: { config }, config };
});

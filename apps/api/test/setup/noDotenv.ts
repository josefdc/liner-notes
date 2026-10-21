// Several API modules call dotenv.config() on import. Tests never read a settings file, so a
// developer's (real credentials, a custom User-Agent, rate limits) cannot change what they check;
// a test that needs a setting sets it. The child processes index.test.ts starts load the file for
// real and pin every setting they rely on.
import { vi } from "vitest";

vi.mock("dotenv", () => {
  const config = () => ({ parsed: {} });
  return { default: { config }, config };
});

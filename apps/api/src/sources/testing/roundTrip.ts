/**
 * Test helper: runs `run` once against a stubbed API with SOURCE_CASSETTE=record, then again
 * with SOURCE_CASSETTE=replay and no network. Returns both results and the raw text of every
 * cassette written, so a test can compare the runs and check what was recorded.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { type FetchRoute, stubFetch } from "./fetchStub.js";

export async function recordThenReplay<T>(route: FetchRoute, run: () => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "cassette-"));
  const previous = { mode: process.env.SOURCE_CASSETTE, dir: process.env.SOURCE_CASSETTE_DIR };
  process.env.SOURCE_CASSETTE_DIR = dir;
  try {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(route);
    const live = await run();

    process.env.SOURCE_CASSETTE = "replay";
    const net = stubFetch(() => undefined);
    const replayed = await run();

    const cassettes: Record<string, string> = {};
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json"))
        cassettes[file.replace(/\.json$/, "")] = readFileSync(join(dir, file), "utf8");
    }
    return { live, replayed, replayCalls: net.calls.length, cassettes };
  } finally {
    vi.unstubAllGlobals();
    if (previous.mode === undefined) delete process.env.SOURCE_CASSETTE;
    else process.env.SOURCE_CASSETTE = previous.mode;
    if (previous.dir === undefined) delete process.env.SOURCE_CASSETTE_DIR;
    else process.env.SOURCE_CASSETTE_DIR = previous.dir;
    rmSync(dir, { recursive: true, force: true });
  }
}

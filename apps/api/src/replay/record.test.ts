import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, runMigrations } from "../store/migrations.js";
import { cleanCommit, DIRTY_REFUSAL, main, recordCommit, withheldExcerptsLine } from "./record.js";
import { WITHHELD_EXCERPT } from "./recorder.js";

describe("the commit a record names", () => {
  it("is the one the run ran at", () => {
    expect(recordCommit({ stored: "aaa1111", given: null, checkout: "aaa1111" })).toEqual({
      commit: "aaa1111",
    });
    // Its uncommitted changes aside (cleanCommit judges those), the checkout is at that commit.
    expect(recordCommit({ stored: "aaa1111", given: null, checkout: "aaa1111-dirty" })).toEqual({
      commit: "aaa1111",
    });
    expect(recordCommit({ stored: "aaa1111", given: "aaa1111", checkout: null })).toEqual({
      commit: "aaa1111",
    });
  });

  it("is refused from a checkout at another commit, unless --allow-moved, then with a warning", () => {
    for (const checkout of ["bbb2222", "bbb2222-dirty"]) {
      expect(recordCommit({ stored: "aaa1111", given: null, checkout }), checkout).toMatchObject({
        refused: expect.stringMatching(
          new RegExp(`checkout is at ${checkout}, not aaa1111.*--allow-moved`),
        ),
      });
    }
    const moved = recordCommit({
      stored: "aaa1111",
      given: null,
      checkout: "bbb2222-dirty",
      allowMoved: true,
    });
    expect(moved).toMatchObject({ commit: "aaa1111" });
    expect("warning" in moved && moved.warning).toMatch(/checkout is at bbb2222-dirty/);
  });

  it("refuses a --commit that contradicts the stored one", () => {
    expect(
      recordCommit({ stored: "aaa1111", given: "bbb2222", checkout: "bbb2222" }),
    ).toMatchObject({
      refused: expect.stringMatching(/differs from the commit the run ran at \(aaa1111\)/),
    });
  });

  it("takes only an explicit --commit for a run stored without one, never the checkout's", () => {
    expect(recordCommit({ stored: null, given: null, checkout: "bbb2222" })).toMatchObject({
      refused: expect.stringMatching(/has no stored commit.*pass --commit/),
    });
    expect(recordCommit({ stored: null, given: "ccc3333", checkout: "bbb2222" })).toEqual({
      commit: "ccc3333",
    });
  });
});

describe("--commit", () => {
  it("is a commit hash, never a ref or a name", () => {
    for (const given of ["HEAD", "main", "abc", "ABC1234", "abc1234 ", "abc1234-clean"]) {
      expect(recordCommit({ stored: null, given, checkout: null }), given).toMatchObject({
        refused: expect.stringMatching(/is not a commit/),
      });
    }
    for (const given of ["abc1234", "abc1234-dirty", "0123456789abcdef0123456789abcdef01234567"]) {
      expect(recordCommit({ stored: null, given, checkout: null })).toEqual({ commit: given });
    }
  });
});

describe("a record from a dirty tree", () => {
  it("is refused when the run ran from uncommitted changes, or the checkout has them now", () => {
    for (const [commit, checkout, why] of [
      ["aaa1111-dirty", "aaa1111", "the run ran from uncommitted changes (aaa1111-dirty)"],
      ["aaa1111", "aaa1111-dirty", "the checkout has uncommitted changes (aaa1111-dirty)"],
      ["aaa1111-dirty", "aaa1111-dirty", "the run ran from uncommitted changes (aaa1111-dirty)"],
      ["aaa1111", null, "the checkout's commit cannot be read"],
    ] as const) {
      const result = cleanCommit({ commit, checkout, allowDirty: false });
      expect(result, `${commit} / ${checkout}`).toMatchObject({
        refused: expect.stringContaining(why),
      });
      expect((result as { refused: string }).refused.startsWith(DIRTY_REFUSAL)).toBe(true);
    }
  });

  it("is recorded from a clean run and checkout, unchanged", () => {
    expect(cleanCommit({ commit: "aaa1111", checkout: "aaa1111", allowDirty: false })).toEqual({
      commit: "aaa1111",
    });
  });

  it("is recorded under --allow-dirty, stamped -dirty once", () => {
    expect(cleanCommit({ commit: "aaa1111", checkout: "aaa1111-dirty", allowDirty: true })).toEqual(
      { commit: "aaa1111-dirty" },
    );
    expect(cleanCommit({ commit: "aaa1111-dirty", checkout: "aaa1111", allowDirty: true })).toEqual(
      { commit: "aaa1111-dirty" },
    );
    // A checkout whose commit cannot be read counts as dirty.
    expect(cleanCommit({ commit: "aaa1111", checkout: null, allowDirty: true })).toEqual({
      commit: "aaa1111-dirty",
    });
    expect(cleanCommit({ commit: "aaa1111", checkout: "aaa1111", allowDirty: true })).toEqual({
      commit: "aaa1111",
    });
  });
});

describe("replay:record on a database migrated before commits were kept", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "record-old-db-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses with its pass --commit message, not a database error", () => {
    const path = join(dir, "old.db");
    const db = new Database(path);
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 7),
    );
    db.prepare(
      "INSERT INTO runs (run_id, thread_id, query, status, created_at) VALUES ('old', 'old', 'q', 'completed', 1)",
    ).run();
    db.close();
    vi.stubEnv("SQLITE_DB_PATH", path);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = main(["--run", "old", "--slug", "old", "--out", dir], {
      settingsFileValues: () => ({}),
      checkout: () => "bbbbbbbbbbbb",
    });
    expect(code).toBe(1);
    expect(errors.mock.calls.map(([message]) => String(message)).join("\n")).toMatch(
      /has no stored commit.*pass --commit/,
    );
  });
});

describe("the page excerpts the record withheld", () => {
  it("are printed with their runs and the evidence items, and nothing when there is none", () => {
    expect(withheldExcerptsLine([])).toBeNull();
    expect(
      withheldExcerptsLine([{ evidenceId: "tavily:https://songs.example.com/a", runs: 1 }]),
    ).toBe(
      'Withheld the excerpt of 1 page, which held 1 long token-shaped run, as "' +
        WITHHELD_EXCERPT +
        '": tavily:https://songs.example.com/a (1)',
    );
    expect(
      withheldExcerptsLine([
        { evidenceId: "tavily:https://a.example/", runs: 2 },
        { evidenceId: "tavily:https://b.example/", runs: 1 },
      ]),
    ).toBe(
      'Withheld the excerpts of 2 pages, which held 3 long token-shaped runs, as "' +
        WITHHELD_EXCERPT +
        '": tavily:https://a.example/ (2), tavily:https://b.example/ (1)',
    );
  });
});

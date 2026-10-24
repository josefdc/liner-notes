/**
 * The commit a recording names, read from temporary repositories: never a guess, and "-dirty"
 * whenever the code differs from the commit.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutCommit, checkoutCommitOrNull } from "./checkoutCommit.js";

let dir: string;
let repo: string;

/** git in the test's own repositories, with no user or system configuration. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();

function newRepo(name: string): string {
  const path = join(dir, name);
  mkdirSync(path);
  git(path, "init", "-q");
  writeFileSync(join(path, "code.ts"), "export const a = 1;\n");
  git(path, "add", "code.ts");
  git(path, "commit", "-q", "-m", "first");
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "checkout-commit-"));
  repo = newRepo("repo");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("checkoutCommit", () => {
  it("is HEAD, 12 characters, in a clean checkout", () => {
    const head = git(repo, "rev-parse", "HEAD");
    expect(checkoutCommit(repo, { exclude: [] })).toBe(head.slice(0, 12));
    expect(checkoutCommitOrNull(repo, { exclude: [] })).toBe(head.slice(0, 12));
  });

  it("says -dirty for a changed, staged or new file", () => {
    const head = git(repo, "rev-parse", "--short=12", "HEAD");
    writeFileSync(join(repo, "code.ts"), "export const a = 2;\n");
    expect(checkoutCommit(repo, { exclude: [] })).toBe(`${head}-dirty`);
    git(repo, "add", "code.ts");
    expect(checkoutCommit(repo, { exclude: [] })).toBe(`${head}-dirty`);
    git(repo, "commit", "-q", "-m", "second");
    const second = git(repo, "rev-parse", "--short=12", "HEAD");
    expect(checkoutCommit(repo, { exclude: [] })).toBe(second);
    writeFileSync(join(repo, "new.ts"), "export const b = 1;\n");
    expect(checkoutCommit(repo, { exclude: [] })).toBe(`${second}-dirty`);
  });

  it("does not count recorded cassettes as changed code, from a subdirectory too", () => {
    const head = git(repo, "rev-parse", "--short=12", "HEAD");
    const sub = join(repo, "apps", "api");
    mkdirSync(join(sub, "cassettes", "llm"), { recursive: true });
    writeFileSync(join(sub, "cassettes", "llm", "answer.json"), "{}\n");
    const exclude = [join(sub, "cassettes")];
    expect(checkoutCommit(sub, { exclude })).toBe(head);
    expect(checkoutCommit(sub, { exclude: [] })).toBe(`${head}-dirty`);
    // A change elsewhere still counts.
    writeFileSync(join(repo, "code.ts"), "export const a = 3;\n");
    expect(checkoutCommit(sub, { exclude })).toBe(`${head}-dirty`);
  });

  it("is unknown outside a repository and without git, never a guess", () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(() => checkoutCommit(plain)).toThrow();
    expect(checkoutCommitOrNull(plain)).toBeNull();
    vi.stubEnv("PATH", join(dir, "no-git-here"));
    expect(checkoutCommitOrNull(repo)).toBeNull();
  });

  it("reads the checkout it runs in, whatever GIT_DIR or GIT_WORK_TREE say", () => {
    const other = newRepo("other");
    writeFileSync(join(other, "x.ts"), "1\n");
    git(other, "add", "x.ts");
    git(other, "commit", "-q", "-m", "other");
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);
    expect(checkoutCommit(repo, { exclude: [] })).toBe(
      git(repo, "rev-parse", "--short=12", "HEAD"),
    );
  });
});

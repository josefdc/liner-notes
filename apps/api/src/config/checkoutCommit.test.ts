/**
 * The commit a recording names, read from temporary repositories: never a guess, and "-dirty"
 * whenever the code differs from the commit.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROOT } from "./apiPackage.js";
import { checkoutCommit, checkoutCommitOrNull, recordingDirs } from "./checkoutCommit.js";

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

  it("reports changes the user's own git settings would hide", () => {
    const head = git(repo, "rev-parse", "--short=12", "HEAD");
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "ignore-all"), "*.ts\n");
    writeFileSync(
      join(home, ".gitconfig"),
      `[status]\n\tshowUntrackedFiles = no\n[core]\n\texcludesFile = ${join(home, "ignore-all")}\n`,
    );
    vi.stubEnv("HOME", home);
    writeFileSync(join(repo, "new.ts"), "export const b = 1;\n");
    expect(checkoutCommit(repo, { exclude: [] })).toBe(`${head}-dirty`);
  });

  it("gives git only PATH, HOME and LANG, never credentials", () => {
    // A stand-in git that writes the environment it was given, then fails.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const seen = join(dir, "env.txt");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nenv > ${seen}\nexit 1\n`);
    chmodSync(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
    vi.stubEnv("AZURE_OPENAI_API_KEY", "secret-key-value-123");
    vi.stubEnv("GIT_DIR", "/elsewhere/.git");
    expect(checkoutCommitOrNull(repo)).toBeNull();
    const names = readFileSync(seen, "utf8")
      .split("\n")
      .map((line) => line.split("=")[0])
      .filter((name) => name && !["PWD", "SHLVL", "_", "OLDPWD"].includes(name));
    expect(new Set(names)).toEqual(
      new Set(
        ["PATH", "HOME", "LANG", "GIT_OPTIONAL_LOCKS"].filter(
          (n) => n !== "LANG" || process.env.LANG !== undefined,
        ),
      ),
    );
    expect(readFileSync(seen, "utf8")).not.toContain("secret-key-value-123");
  });

  it("does not count recordings, by default or as configured, as code", () => {
    const dirs = recordingDirs({ LLM_CASSETTE_DIR: "./elsewhere/llm", REPLAY_DIR: "/abs/replays" });
    expect(dirs).toEqual(
      expect.arrayContaining([
        join(API_ROOT, "cassettes"),
        resolve(API_ROOT, "..", "..", "fixtures", "replays"),
        resolve(API_ROOT, "elsewhere", "llm"),
        "/abs/replays",
      ]),
    );
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileFor } from "./serve-static-demo.mjs";

const dir = mkdtempSync(join(tmpdir(), "serve-demo-"));
mkdirSync(join(dir, "t", "abc"), { recursive: true });
writeFileSync(join(dir, "index.html"), "home");
writeFileSync(join(dir, "t", "abc", "index.html"), "track");
writeFileSync(join(dir, "sitemap.xml"), "map");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the file of an address", () => {
  const BASE = "/liner-notes/";

  it("serves a file, or a folder's index.html", () => {
    expect(fileFor(dir, BASE, "/liner-notes/sitemap.xml")).toBe(join(dir, "sitemap.xml"));
    expect(fileFor(dir, BASE, "/liner-notes/")).toBe(join(dir, "index.html"));
    expect(fileFor(dir, BASE, "/liner-notes/t/abc/")).toBe(join(dir, "t", "abc", "index.html"));
    expect(fileFor(dir, BASE, "/liner-notes/t/abc")).toBe(join(dir, "t", "abc", "index.html"));
  });

  it("holds nothing outside the base or the folder", () => {
    expect(fileFor(dir, BASE, "/other/")).toBeNull();
    expect(fileFor(dir, BASE, "/liner-notes/t/none/")).toBeNull();
    expect(fileFor(dir, BASE, "/liner-notes/../../etc/passwd")).toBeNull();
    expect(fileFor(dir, BASE, "/liner-notes/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });
});

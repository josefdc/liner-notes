import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMainModule } from "./isMain.js";

describe("isMainModule", () => {
  let dir: string;
  let script: string;
  let url: string;
  beforeEach(() => {
    // Node gives a module's import.meta.url as its real path.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "is-main-")));
    mkdirSync(join(dir, "app", "dist"), { recursive: true });
    script = join(dir, "app", "dist", "report.js");
    writeFileSync(script, "");
    url = pathToFileURL(script).href;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is true for the script node was started with, by absolute or relative path", () => {
    expect(isMainModule({ url }, ["node", script])).toBe(true);
    expect(isMainModule({ url }, ["node", relative(process.cwd(), script)])).toBe(true);
  });

  it("is true when the script was started through a symbolic link to it or to a directory above", () => {
    symlinkSync(join(dir, "app"), join(dir, "linked-app"));
    symlinkSync(script, join(dir, "report-link.js"));
    expect(isMainModule({ url }, ["node", join(dir, "linked-app", "dist", "report.js")])).toBe(
      true,
    );
    expect(isMainModule({ url }, ["node", join(dir, "report-link.js")])).toBe(true);
  });

  it("is true when the script was started without its .js extension, as node allows", () => {
    expect(isMainModule({ url }, ["node", join(dir, "app", "dist", "report")])).toBe(true);
    symlinkSync(join(dir, "app"), join(dir, "linked-app"));
    expect(isMainModule({ url }, ["node", join(dir, "linked-app", "dist", "report")])).toBe(true);
  });

  it("takes node's own answer (import.meta.main) when it gives one", () => {
    expect(isMainModule({ url, main: true }, ["node", join(dir, "other.js")])).toBe(true);
    expect(isMainModule({ url, main: false }, ["node", script])).toBe(false);
  });

  it("is false for another script, a missing path or none", () => {
    const other = join(dir, "app", "dist", "index.js");
    writeFileSync(other, "");
    expect(isMainModule({ url }, ["node", other])).toBe(false);
    expect(isMainModule({ url }, ["node", join(dir, "missing.js")])).toBe(false);
    expect(isMainModule({ url }, ["node"])).toBe(false);
  });
});

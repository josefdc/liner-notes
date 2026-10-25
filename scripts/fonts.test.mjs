// The self-hosted fonts (apps/web/public/fonts) travel with their licence, and the stylesheet that
// declares them (apps/web/src/styles/fonts.css) names exactly the files that are there.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const web = join(import.meta.dirname, "..", "apps", "web");
const fontsDir = join(web, "public", "fonts");
const licence = readFileSync(join(fontsDir, "OFL.txt"), "utf8");

// sha256 of the SIL Open Font License 1.1 text, from its title line to the end, as published in
// the LICENSE files of @fontsource-variable/inter 5.3.0 and @fontsource/ibm-plex-mono 5.3.0.
// IBM's LICENSE.txt in @ibm/plex-mono 2.5.0 has the same text, with CRLF line ends and one
// trailing space.
const OFL_BODY_SHA256 = "6863ff4dc820f24756b6acfb38a2c6bc19d5b8d71b17030330a6f16eb4cee348";
const OFL_TITLE = "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007";

describe("fonts", () => {
  it("OFL.txt carries the licence text verbatim", () => {
    const start = licence.indexOf(OFL_TITLE);
    expect(start).toBeGreaterThan(0);
    const body = licence.slice(start);
    expect(createHash("sha256").update(body).digest("hex")).toBe(OFL_BODY_SHA256);
  });

  it("OFL.txt names each family with its copyright notice as published", () => {
    const header = licence.slice(0, licence.indexOf(OFL_TITLE));
    expect(header).toContain(
      "Inter (inter-*-wght-normal.woff2)\nFrom the Fontsource package @fontsource-variable/inter 5.3.0.\nCopyright 2016 The Inter Project Authors (https://github.com/rsms/inter)\n",
    );
    expect(header).toContain(
      'IBM Plex Mono (IBMPlexMono-*.woff2)\nFrom IBM\'s release package @ibm/plex-mono 2.5.0 (fonts/split/woff2).\nCopyright © 2017 IBM Corp. with Reserved Font Name "Plex"\n',
    );
  });

  it("fonts.css declares every font file in public/fonts, and only those", () => {
    const css = readFileSync(join(web, "src", "styles", "fonts.css"), "utf8");
    const declared = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((match) => match[1]);
    const files = readdirSync(fontsDir).filter((name) => name.endsWith(".woff2"));
    expect([...declared].sort()).toEqual([...files].sort());
    expect(new Set(declared).size).toBe(declared.length);
    for (const name of files) {
      expect(name).toMatch(
        /^(inter-[\w-]+-wght-normal|IBMPlexMono-[A-Za-z]+-[A-Za-z0-9]+)\.woff2$/,
      );
      expect(readFileSync(join(fontsDir, name)).subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
  });
});

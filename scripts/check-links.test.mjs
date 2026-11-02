// Tests for the Markdown link check (scripts/check-links.mjs). Run with `npm test`.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { anchorsOf, brokenLinks, linksOf, slug } from "./check-links.mjs";

const script = join(import.meta.dirname, "check-links.mjs");

/** brokenLinks over an in-memory tree: every file of `tree` is tracked. */
function check(tree, files = Object.keys(tree).filter((path) => path.endsWith(".md"))) {
  return brokenLinks(files, { read: (path) => tree[path], tracked: Object.keys(tree) });
}

describe("slug", () => {
  it("makes GitHub's anchors", () => {
    expect(slug("Run it locally")).toBe("run-it-locally");
    expect(slug("Tech stack and sources")).toBe("tech-stack-and-sources");
    expect(slug("🐳 Deploying")).toBe("-deploying");
    expect(slug("What it is: measured, sourced, inferred")).toBe(
      "what-it-is-measured-sourced-inferred",
    );
    expect(slug("`npm run eval` (replay)")).toBe("npm-run-eval-replay");
    expect(slug("**Bold** and [a link](x.md)")).toBe("bold-and-a-link");
    expect(slug("Stan (Eminem feat. Dido), `USIR10001280`")).toBe(
      "stan-eminem-feat-dido-usir10001280",
    );
    expect(slug("snake_case stays")).toBe("snake_case-stays");
    expect(slug("Ünïcode words")).toBe("ünïcode-words");
    // As github-slugger 2.0.0 gives them.
    expect(slug("Set `SHS_API_KEY`")).toBe("set-shs_api_key");
    expect(slug("snake_case_name here")).toBe("snake_case_name-here");
    expect(slug("_emphasis_ and __strong__")).toBe("emphasis-and-strong");
    expect(slug("The `/t/<id>/map` view")).toBe("the-tidmap-view");
    expect(slug("Tom &amp; Jerry")).toBe("tom--jerry");
    expect(slug("acc1² Ⓐ")).toBe("acc1-ⓐ");
  });

  it("numbers repeated headings as GitHub does", () => {
    const anchors = anchorsOf("# A\n\n## A\n\n### A\n\n## A-1\n");
    expect([...anchors]).toEqual(["a", "a-1", "a-2", "a-1-1"]);
  });

  it("reads setext headings and HTML ids, and no heading inside a code block", () => {
    const anchors = anchorsOf(
      'Title\n=====\n\nSub\n---\n\n<a id="kept"></a>\n\n```\n# not a heading\n```\n',
    );
    expect([...anchors].sort()).toEqual(["kept", "sub", "title"]);
  });
});

describe("anchorsOf, more", () => {
  it("reads a heading inside a blockquote", () => {
    expect([...anchorsOf("> ## Quoted heading\n")]).toEqual(["quoted-heading"]);
  });
});

describe("linksOf", () => {
  it("finds inline links, images, definitions and HTML attributes, outside code", () => {
    const text = [
      'See [the design](docs/design.md#evidence) and ![chart](docs/images/kinds.svg "title").',
      "[ref]: <docs/privacy.md>",
      '<img src="docs/images/search.png" alt=""> <a href="#top">top</a>',
      "Inline `[not](a-link.md)` code.",
      "```",
      "[not](in-a-fence.md)",
      "```",
      "",
      "    [not](indented-code.md)",
      "[parens](docs/a_(b).md)",
      "[^1]: A footnote, not a link definition.",
    ].join("\n");
    expect(linksOf(text)).toEqual([
      { target: "docs/design.md#evidence", line: 1 },
      { target: "docs/images/kinds.svg", line: 1 },
      { target: "docs/privacy.md", line: 2 },
      { target: "docs/images/search.png", line: 3 },
      { target: "#top", line: 3 },
      { target: "docs/a_(b).md", line: 10 },
    ]);
  });

  it("reads a list item's continuation paragraph, and code only 4 columns past its content", () => {
    expect(linksOf("1. Step\n\n    See [x](missing1.md)\n")).toEqual([
      { target: "missing1.md", line: 3 },
    ]);
    expect(linksOf("- item\n\n  See [y](missing2.md)\n\n      [code](not-read.md)\n")).toEqual([
      { target: "missing2.md", line: 3 },
    ]);
    // A paragraph back at the margin ends the list: its indented code is code again.
    expect(linksOf("- item\n\nText.\n\n    [code](not-read.md)\n")).toEqual([]);
    // A nested item continues the list, and a fence inside an item is code.
    expect(
      linksOf("- a\n\n  - b\n\n    [nested](n.md)\n\n    ```\n    [fenced](f.md)\n    ```\n"),
    ).toEqual([{ target: "n.md", line: 5 }]);
  });

  it("reads definitions with an angle-bracketed target, on the next line, or in a blockquote", () => {
    expect(linksOf('[r]: <a b.md> "title"')).toEqual([{ target: "a b.md", line: 1 }]);
    expect(linksOf("[r]:\n  next-line.md\n")).toEqual([{ target: "next-line.md", line: 2 }]);
    expect(linksOf("> [r]: quoted.md\n> > [s]: <deeper.md>\n")).toEqual([
      { target: "quoted.md", line: 1 },
      { target: "deeper.md", line: 2 },
    ]);
  });

  it("opens no fence on a line that starts with an inline code span", () => {
    expect(linksOf("```x``` and [a](gone.md)\n\nLater [b](later.md)\n")).toEqual([
      { target: "gone.md", line: 1 },
      { target: "later.md", line: 3 },
    ]);
    // A tilde fence's info string may hold backticks, and a backtick fence's may hold tildes.
    expect(linksOf("~~~ a`b\n[c](in-fence.md)\n~~~\n```js ~x\n[d](in-fence.md)\n```\n")).toEqual(
      [],
    );
  });

  it("reads unquoted HTML attributes", () => {
    expect(linksOf('<a href=x.md>x</a> <img src=docs/y.png alt="">')).toEqual([
      { target: "x.md", line: 1 },
      { target: "docs/y.png", line: 1 },
    ]);
  });
});

describe("brokenLinks", () => {
  const tree = {
    "README.md": [
      "# Liner Notes",
      "## Known limitations",
      "[design](docs/design.md#the-verifier) [limits](#known-limitations)",
      "[dir](docs/) [image](docs/images/a.png) [root](/LICENSE) [web](https://example.com/x.md)",
      "[mail](mailto:a@example.com)",
    ].join("\n"),
    "docs/design.md": "# Design\n\n## The verifier\n\n[back](../README.md#liner-notes)\n",
    "docs/images/a.png": "",
    LICENSE: "",
  };

  it("passes when every relative link and anchor resolves; external links are not read", () => {
    expect(check(tree)).toEqual([]);
  });

  it("names a missing file, a missing anchor and a path out of the repository", () => {
    const planted = {
      ...tree,
      "docs/design.md": [
        "# Design",
        "[gone](missing.md)",
        "[anchor](../README.md#no-such-heading)",
        "[self](#nowhere)",
        "[out](../../outside.md)",
        "[image](images/b.png)",
      ].join("\n"),
    };
    expect(check(planted)).toEqual([
      // README's link to docs/design.md#the-verifier now has no heading to land on.
      {
        file: "README.md",
        line: 3,
        target: "docs/design.md#the-verifier",
        reason: "docs/design.md has no anchor #the-verifier",
      },
      {
        file: "docs/design.md",
        line: 2,
        target: "missing.md",
        reason: "docs/missing.md is not a tracked file or directory",
      },
      {
        file: "docs/design.md",
        line: 3,
        target: "../README.md#no-such-heading",
        reason: "README.md has no anchor #no-such-heading",
      },
      {
        file: "docs/design.md",
        line: 4,
        target: "#nowhere",
        reason: "docs/design.md has no anchor #nowhere",
      },
      {
        file: "docs/design.md",
        line: 5,
        target: "../../outside.md",
        reason: "the path leaves the repository",
      },
      {
        file: "docs/design.md",
        line: 6,
        target: "images/b.png",
        reason: "docs/images/b.png is not a tracked file or directory",
      },
    ]);
  });

  it("fails a broken link in a list item's continuation; a spaced definition target passes", () => {
    const tree = { "a.md": "1. Step\n\n    See [x](missing1.md)\n\n[r]: <a b.md>\n", "a b.md": "" };
    expect(check(tree).map((b) => [b.line, b.target])).toEqual([[3, "missing1.md"]]);
  });

  it("does not read the anchors of a file that is not Markdown", () => {
    expect(check({ "a.md": "[x](b.txt#L3)", "b.txt": "" })).toEqual([]);
  });
});

describe("the command", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A git repository holding `tree`, every file added. */
  function repo(tree) {
    const dir = mkdtempSync(join(tmpdir(), "check-links-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    return dir;
  }

  /** Runs the script as the repository at `dir`'s own (a copy under scripts/ there). */
  function run(dir, args = []) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "check-links.mjs"), readScript());
    return spawnSync(process.execPath, [join(dir, "scripts", "check-links.mjs"), ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  }

  const readScript = () => readFileSync(script, "utf8");

  it("exits 0 on good links and 1 on a planted broken one, naming file and line", () => {
    const dir = repo({
      "README.md": "# Top\n\n[docs](docs/a.md#part)\n",
      "docs/a.md": "# A\n\n## Part\n",
    });
    const ok = run(dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("check-links: ok, 2 file(s)");

    writeFileSync(join(dir, "docs", "a.md"), "# A\n\n## Renamed\n\n[gone](b.md)\n");
    const bad = run(dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("README.md:3: docs/a.md#part: docs/a.md has no anchor #part");
    expect(bad.stdout).toContain("docs/a.md:5: b.md: docs/b.md is not a tracked file or directory");
    expect(bad.stdout).toContain("check-links: 2 broken link(s) in 2 file(s)");
  });

  it("counts a file that exists but is not tracked as missing", () => {
    const dir = repo({ "README.md": "[new](new.md)\n" });
    writeFileSync(join(dir, "new.md"), "# New\n");
    const result = run(dir, ["README.md"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("new.md is not a tracked file or directory");
  });

  it("exits 2 outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-links-"));
    dirs.push(dir);
    writeFileSync(join(dir, "README.md"), "# x\n");
    const result = run(dir);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("cannot list the tracked files");
  });
});

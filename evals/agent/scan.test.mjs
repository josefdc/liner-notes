// The secret-shape and preview-link scan of the committed cassettes, run records, reports and
// recordings
// (lib/scan.mjs): the committed tree passes, and every planted sample is caught, in a file of a
// scanned directory as well as on its own. The samples are built from parts, so no credential
// shape is written here whole. Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RULES, SCANNED_DIRS, scanCommitted, scanText } from "./lib/scan.mjs";

const chars = (n, from = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LmNb") =>
  from.repeat(Math.ceil(n / from.length)).slice(0, n);
const join2 = (...parts) => parts.join("");

/** One planted sample per rule, as a source or a model answer could carry it. */
const PLANTED = [
  ["a Google API key", `"key": "${join2("AI", "za", chars(35))}"`],
  ["a Stripe key", join2("sk", "_live_", chars(24))],
  ["a Turnstile secret", join2("0x4", "AAAAAAA", chars(25))],
  ["a Hugging Face token", join2("hf", "_", chars(34, "QWertYUiopASdfGHjklZXcvBNm"))],
  ["a GitLab token", join2("glpat", "-", chars(20))],
  ["a GitHub token", join2("gh", "p_", chars(36))],
  ["a Slack token", join2("xo", "xb-1234567890-", chars(24))],
  ["an AWS access key id", join2("AK", "IA", "IOSFODNN7EXAMPLE")],
  ["a Tavily key", join2("tv", "ly-", chars(24))],
  ["an OpenAI-style key", join2("sk", "-proj-", chars(32))],
  ["an api-key header", `{"headers": {"${join2("api", "-key")}": "x"}}`],
  ["an Authorization header", `{"${join2("Author", "ization")}": "x"}`],
  ["a bearer token", `"${join2("Bear", "er ")}${chars(40)}"`],
  ["a token or secret field", `{"${join2("access", "_token")}": "${chars(30)}"}`],
  [
    "a credential in a query",
    `https://ws.example.org/2.0/?method=x&${join2("api", "_key")}=${chars(32)}`,
  ],
  [
    "a Deezer preview host",
    `HTTP 404: no file at ${join2("cdnt-preview.", "dzcdn", ".net")}/api/1/1/a/b/c/0/abc.mp3`,
  ],
  ["a Spotify CDN host", `${join2("p.", "scdn", ".co")}/mp3-preview/${chars(40)}`],
  [
    "a signed link's parameter",
    `/api/1/1/abc.mp3?${join2("hd", "nea")}=${join2("ex", "p")}=1793479003~acl=/x`,
  ],
];

test("the committed cassettes, run records, reports and recordings hold no secret shape and no preview link", () => {
  const found = scanCommitted();
  assert.deepEqual(
    found.map((f) => `${f.file}: ${f.rules.join(", ")}`),
    [],
    "a committed file breaks a scan rule: record it again with the scrub fixed, or remove it",
  );
});

test("every rule has a planted sample, and each sample is caught by its rule", () => {
  assert.deepEqual(
    [...new Set(PLANTED.map(([name]) => name))].sort(),
    RULES.map((r) => r.name).sort(),
  );
  for (const [name, sample] of PLANTED) {
    assert.ok(scanText(sample).includes(name), `${name}: ${sample}`);
  }
});

test("a redacted value and Spotify's token type pass", () => {
  assert.deepEqual(scanText('{"access_token": "[redacted]", "token_type": "Bearer"}'), []);
  assert.deepEqual(scanText("https://www.last.fm/music/Daft+Punk/_/One+More+Time"), []);
  assert.deepEqual(scanText('{"text": "Expires in 1997, the expiry of the deal"}'), []);
});

/** A root holding each scanned directory with one clean file. */
function cleanRoot() {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  for (const dir of SCANNED_DIRS) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "clean.json"), '{"ok": true}\n');
  }
  return root;
}

test("the scan covers the cassettes, the run records, the reports and the recordings", () => {
  assert.deepEqual(SCANNED_DIRS, [
    "fixtures/cassettes",
    "evals/agent/runs",
    "evals/reports",
    "fixtures/replays",
    "fixtures/pinned",
  ]);
});

test("a planted file in a scanned directory is named with its rule, whatever its kind", () => {
  const root = cleanRoot();
  try {
    const deep = join(root, SCANNED_DIRS[1], "2026-01-01", "perturb");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "judge.json"), JSON.stringify({ excerpt: PLANTED[16][1] }));
    writeFileSync(join(root, SCANNED_DIRS[2], "agent-latest.md"), `- ${PLANTED[15][1]}\n`);
    writeFileSync(join(root, SCANNED_DIRS[1], "2026-01-01", "provenance.txt"), PLANTED[8][1]);
    writeFileSync(join(root, SCANNED_DIRS[3], "a-showcase.json"), JSON.stringify(PLANTED[17][1]));
    assert.deepEqual(scanCommitted(root), [
      {
        file: join(SCANNED_DIRS[1], "2026-01-01", "perturb", "judge.json"),
        rules: ["a Spotify CDN host"],
      },
      { file: join(SCANNED_DIRS[1], "2026-01-01", "provenance.txt"), rules: ["a Tavily key"] },
      { file: join(SCANNED_DIRS[2], "agent-latest.md"), rules: ["a Deezer preview host"] },
      { file: join(SCANNED_DIRS[3], "a-showcase.json"), rules: [PLANTED[17][0]] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scanned directory that is missing or holds no file fails the scan", () => {
  const root = cleanRoot();
  try {
    assert.deepEqual(scanCommitted(root), []);
    rmSync(join(root, SCANNED_DIRS[2]), { recursive: true, force: true });
    assert.throws(() => scanCommitted(root), /scan: evals\/reports does not exist/);
    mkdirSync(join(root, SCANNED_DIRS[2], "empty"), { recursive: true });
    assert.throws(() => scanCommitted(root), /scan: evals\/reports holds no file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

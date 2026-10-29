import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomStrings } from "./sources/testing/strings.js";
import {
  type CapturedLogs,
  captureLogsForTests,
  configureLogger,
  currentRunId,
  installConsoleBridge,
  ipHash,
  logCut,
  logger,
  MAX_LOGGED_TEXT,
  SECRET_PAIR,
  scrub,
  scrubbedSpans,
  serializeError,
  withRun,
} from "./logger.js";
import { growth, timed } from "./sources/testing/strings.js";
import { logText } from "./http/middleware/errors.js";
import { SourceError } from "./sources/http.js";

const KEY = "dummy-azure-key-0123456789";
const ENDPOINT = "https://dummy-resource.example.net";

let logs: CapturedLogs;
beforeEach(() => {
  configureLogger({ AZURE_OPENAI_API_KEY: KEY, AZURE_OPENAI_ENDPOINT: ENDPOINT });
  logs = captureLogsForTests();
});
afterEach(() => {
  logs.restore();
  configureLogger({ LOG_LEVEL: "silent" });
});

describe("scrub", () => {
  it.each([
    [
      "a Deezer preview link, signed",
      "GET https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=exp=1~acl=*~hmac=ab12 failed",
      "GET [preview link] failed",
    ],
    [
      "a Deezer preview link on another CDN host",
      "url: 'https://cdns-preview-d.dzcdn.net/stream/c-deadbeef-1.mp3'",
      "url: '[preview link]'",
    ],
    [
      "a Spotify preview link",
      "preview https://p.scdn.co/mp3-preview/abc?cid=123",
      "preview [preview link]",
    ],
    ["a Bearer token", "Authorization: Bearer abc.def-ghi", "Authorization: [redacted]"],
    ["a Bearer token alone", "sent Bearer abc.def-ghi", "sent Bearer [redacted]"],
    [
      "nothing twice",
      "Authorization: Bearer [redacted], token=[redacted]",
      "Authorization: Bearer [redacted], token=[redacted]",
    ],
    ["Basic credentials", "Basic dXNlcjpwYXNzd29yZA==", "Basic [redacted]"],
    ["a Discogs token", "Discogs token=abcdef123", "Discogs token=[redacted]"],
    ["an api-key header", '{"api-key":"k-123456"}', '{"api-key":[redacted]}'],
    [
      "a quoted Bearer token",
      'header was Authorization: Bearer "abc123def"',
      "header was Authorization: [redacted]",
    ],
    ["a quoted Bearer token alone", 'sent Bearer "abc123def" on', "sent Bearer [redacted] on"],
    [
      "a quoted password",
      'login failed with password="hunter2" for user',
      "login failed with password=[redacted] for user",
    ],
    [
      "a subscription key header",
      "Ocp-Apim-Subscription-Key: rtSubKey123456",
      "Ocp-Apim-Subscription-Key: [redacted]",
    ],
    [
      "api_sig and sk in a URL",
      "https://ws.example/2.0/?api_sig=abc123&sk=def456&x=1",
      "https://ws.example/2.0/?api_sig=[redacted]&sk=[redacted]&x=1",
    ],
    [
      "a Deezer preview link without a scheme",
      "clip cdnt-preview.dzcdn.net/api/1/1/a.mp3?hdnea=exp=1~hmac=abc ok",
      "clip [preview link] ok",
    ],
    [
      "a Spotify preview link without a scheme",
      "clip p.scdn.co/mp3-preview/abc?cid=1 ok",
      "clip [preview link] ok",
    ],
    [
      "a key in a URL",
      "https://ws.audioscrobbler.com/2.0/?method=track.getTopTags&api_key=abc123&format=json",
      "https://ws.audioscrobbler.com/2.0/?method=track.getTopTags&api_key=[redacted]&format=json",
    ],
    ["credentials in a URL", "https://user:pw@db.example/x", "https://[redacted]@db.example/x"],
    [
      "a run token in a URL",
      "GET /api/analyze/stream?query=Hurt&runToken=v1.eyJ0IjoiYSJ9.c2ln_-1 failed",
      "GET /api/analyze/stream?query=Hurt&runToken=[redacted] failed",
    ],
    [
      "a run token first in a query, in any spelling",
      "/api/factoids/more?run_token=v1.a.b&x=1 and ?RUN-TOKEN=v1.c.d",
      "/api/factoids/more?run_token=[redacted]&x=1 and ?RUN-TOKEN=[redacted]",
    ],
    ["a run token pair", "runToken: v1.eyJ0IjoiYSJ9.c2ln", "runToken: [redacted]"],
    [
      "run and Turnstile tokens in JSON",
      '{"runToken":"v1.eyJ0IjoiYSJ9.c2ln","turnstileToken":"0.AbC-dEf_123"}',
      '{"runToken":[redacted],"turnstileToken":[redacted]}',
    ],
    [
      "a Turnstile token in a URL or a pair",
      "?turnstile_token=0.AbC&a=1 turnstile-token=0.XyZ",
      "?turnstile_token=[redacted]&a=1 turnstile-token=[redacted]",
    ],
    ["a configured key", `failed with ${KEY}`, "failed with [redacted]"],
    [
      "the configured endpoint",
      `${ENDPOINT}/openai/v1/responses timed out`,
      "[provider endpoint] timed out",
    ],
    [
      "the configured endpoint's host",
      "getaddrinfo ENOTFOUND dummy-resource.example.net",
      "getaddrinfo ENOTFOUND [provider endpoint]",
    ],
    [
      "any Azure OpenAI host",
      "connect to other-res.openai.azure.com failed",
      "connect to [provider endpoint] failed",
    ],
  ])("replaces %s", (_label, text, expected) => {
    expect(scrub(text)).toBe(expected);
  });

  it("leaves ordinary text alone", () => {
    for (const text of [
      "Found 12 track tags",
      "maxTokens: 300, tokens: 12",
      "Basic info about the track",
      "https://i.scdn.co/image/ab67616d0000b273",
      "https://musicbrainz.org/ws/2/recording/abc?inc=artist-rels&fmt=json",
      "i.scdn.co/image/ab67 and scdn.co",
    ]) {
      expect(scrub(text)).toBe(text);
    }
  });

  // The slow form a regression would bring takes several seconds a run, hence the timeout.
  it("cuts text off past MAX_LOGGED_TEXT, and takes linear time on long host-like text", {
    timeout: 60_000,
  }, () => {
    const long = scrub("x".repeat(MAX_LOGGED_TEXT + 100));
    expect(long).toHaveLength(MAX_LOGGED_TEXT + "…[truncated]".length);
    expect(long.endsWith("…[truncated]")).toBe(true);
    // Host-like text as long as is scrubbed (longer is cut off first), 40 times over: an
    // expression that reads it again from each character takes several seconds on it, the
    // linear ones about ten milliseconds. The fastest of three runs, since a busy machine only adds
    // time; a run over 2.5 s is a slow form, not a busy machine, and ends the timing.
    const hostLike = ["a-".repeat(8000), "a.".repeat(8000)];
    const { ms } = timed(
      () => {
        for (let i = 0; i < 40; i++) for (const text of hostLike) scrub(text);
      },
      { runs: 3, stopAboveMs: 2_500 },
    );
    expect(ms).toBeLessThan(1000);
  });

  it("does not replace short or numeric configured values", () => {
    configureLogger({ SOME_API_KEY: "200000", SHORT_TOKEN: "abc1234", LONG_KEY: KEY });
    expect(scrub("count 200000, word abc1234")).toBe("count 200000, word abc1234");
    logger("X").info("count", { n: 200000 });
    expect(logs.entries()[0]).toMatchObject({ n: 200000 });
  });
});

describe("scrubbedSpans", () => {
  it("finds each part of a text that scrub replaces, without the quotes around a value", () => {
    const text = `token: "abc1" Bearer xyz123456 ${KEY} https://u:p@h.example/x?token=t1 api_key=k2`;
    const hidden = scrubbedSpans(text).map(([start, end]) => text.slice(start, end));
    expect(hidden).toEqual(expect.arrayContaining(["abc1", "xyz123456", KEY, "u:p", "t1", "k2"]));
    // With each span masked, scrub has nothing more to replace.
    let masked = text;
    for (const [start, end] of [...scrubbedSpans(text)].reverse()) {
      masked = `${masked.slice(0, start)}[redacted]${masked.slice(end)}`;
    }
    expect(scrub(masked)).toBe(masked);
  });

  it("replaces a host or a configured value the cap would cut through", () => {
    // Configured values are replaced before the cap, and the cap falls before a host it would
    // cut, so none is cut in two.
    for (const shift of [6, 12, 20]) {
      const host = scrub(`${"x".repeat(MAX_LOGGED_TEXT - shift)} contoso-prod.openai.azure.com`);
      expect(host).not.toContain("contoso");
      const key = scrub(`${"x".repeat(MAX_LOGGED_TEXT - shift)} ${KEY}`);
      expect(key).not.toContain(KEY.slice(0, 4));
    }
  });

  it("logs nothing past the cap, however much its links and hosts are shortened", () => {
    // The endpoint's link is replaced by a shorter marker: measured after that, the cap would
    // fall later in the text and let in what lies past it.
    const link = `"${ENDPOINT}/x?k=1a`;
    for (let past = 0; past < 30; past++) {
      const text = `${"w".repeat(MAX_LOGGED_TEXT - 200)}${link}${"y".repeat(200 - link.length + past)}M0001x tail`;
      expect(scrub(text), String(past)).not.toContain("M00");
    }
    const cookie = `${"w ".repeat(8156)}${link}Set-Cookie: s=M0000x; Path=/, t=M0001x`;
    expect(scrub(cookie)).not.toContain("M0001x");
  });

  it("finds all scrub replaces in texts of keys, hosts, links and values in any order", () => {
    const parts = [
      "token: ",
      "X-Api-Key=",
      "authorization: ",
      "Bearer ",
      "Basic abcdefgh12",
      "'Bearer abc.def1'",
      '"Basic abcdefgh12"',
      "proxy-authorization: ",
      "contoso-prod.openai.azure.com",
      "https://u:p@h.example/x?token=t1&a=b",
      "p.scdn.co/clip",
      KEY,
      ENDPOINT,
      " ",
      "\\n",
      "\n",
      "a",
      '"',
      "'",
    ];
    // Every part of the text outside the spans is written as it was, in order: scrub replaced
    // nothing else but the quotes and scheme words around a value, which the spans leave out.
    const bare = (text: string) => text.replace(/["']|(?:Bearer|Basic|Discogs)\s+/g, "");
    for (const text of randomStrings(parts, 3_000, 10)) {
      const out = bare(scrub(text));
      let at = 0;
      let kept = 0;
      for (const [start, end] of [...scrubbedSpans(text), [text.length, text.length]]) {
        const part = bare(text.slice(kept, start));
        const found = out.indexOf(part, at);
        expect(found, `${JSON.stringify(text)}: ${JSON.stringify(part)}`).not.toBe(-1);
        at = found + part.length;
        kept = end;
      }
    }
  });

  it("finds nothing in a text that scrub leaves as it is", () => {
    const text = "the token count is 5; see https://example.org/a?page=2";
    expect(scrub(text)).toBe(text);
    expect(scrubbedSpans(text)).toEqual([]);
  });
});

describe("Authorization values in quotes and at the cap", () => {
  const TOKEN = "eyJhbGciOi.secretpart";
  const CRED = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
  // What util.inspect writes for a headers object, which reaches a line as text.
  const headers = inspect({
    accept: "application/json",
    authorization: `Bearer ${TOKEN}`,
    "proxy-authorization": `Basic ${CRED}`,
  });
  /** Whether `out` shows any 4 characters of the token or the credential. */
  const shows = (out: string) =>
    [TOKEN, CRED].some((secret) =>
      Array.from({ length: secret.length - 3 }, (_, i) => secret.slice(i, i + 4)).some((part) =>
        out.includes(part),
      ),
    );

  it.each([
    ["in single quotes", `{ authorization: 'Bearer ${TOKEN}' }`, "{ authorization: [redacted] }"],
    ["in double quotes", `{ authorization: "Bearer ${TOKEN}" }`, "{ authorization: [redacted] }"],
    [
      "under proxy-authorization",
      `{ 'proxy-authorization': 'Bearer ${TOKEN}' }`,
      "{ 'proxy-authorization': [redacted] }",
    ],
    ["in JSON", `{"Authorization":"Bearer ${TOKEN}"}`, '{"Authorization":[redacted]}'],
    ["a Basic one", `{ Authorization: 'Basic ${CRED}' }`, "{ Authorization: [redacted] }"],
    ["after a tab", `{ authorization: 'Bearer\t${TOKEN}' }`, "{ authorization: [redacted] }"],
    ["after two spaces", `{ authorization: "Basic  ${CRED}" }`, "{ authorization: [redacted] }"],
    ["in backticks", `{ authorization: \`Bearer ${TOKEN}\` }`, "{ authorization: [redacted] }"],
    [
      "in a headers object util.inspect wrote",
      headers,
      "{\n  accept: 'application/json',\n  authorization: [redacted],\n  'proxy-authorization': [redacted]\n}",
    ],
  ])("leaves no part of a quoted token: %s", (_label, text, expected) => {
    expect(scrub(text)).toBe(expected);
    expect(shows(scrub(logText(text)))).toBe(false);
    logger("Probe").warn(`sent ${logText(text)} with ${text}`);
    expect(shows(logs.lines().join("\n"))).toBe(false);
  });

  it("leaves no part of a quoted token in a console line of an inspected headers object", () => {
    const target = { log: () => {}, warn: () => {} } as unknown as Console;
    const restore = installConsoleBridge(target);
    try {
      target.log(headers);
      target.warn("[Fetch] headers %s", inspect({ Authorization: `Bearer ${TOKEN}` }));
    } finally {
      restore();
    }
    expect(logs.messages()).toEqual([
      "{\n  accept: 'application/json',\n  authorization: [redacted],\n  'proxy-authorization': [redacted]\n}",
      "headers { Authorization: [redacted] }",
    ]);
  });

  it("leaves no part of a token after a scheme written twice, on every path to a line", () => {
    const token = "T9zB8yC7xD6wE5vF4uG3";
    const texts: string[] = [];
    for (const quote of ["'", '"'])
      for (const first of ["Bearer", "Basic", "bearer", "BASIC"])
        for (const between of [" ", "\t", "\n", "  "])
          for (const second of ["Bearer", "Basic", "BEARER", "basic"])
            texts.push(`authorization: ${quote}${first}${between}${second} ${token}${quote}`);
    const shown = (out: string) => out.includes(token.slice(0, 4)) || out.includes(token.slice(-4));
    const dir = mkdtempSync(join(tmpdir(), "log-twice-"));
    const target = { log: () => {} } as unknown as Console;
    try {
      const file = join(dir, "api.jsonl");
      configureLogger({ LOG_FILE: file });
      const restore = installConsoleBridge(target);
      let inspected = 0;
      try {
        for (const text of texts) {
          expect(shown(scrub(text)), text).toBe(false);
          expect(shown(scrub(logText(text))), text).toBe(false);
          expect(shown(JSON.stringify(serializeError(new Error(text)))), text).toBe(false);
          expect(shown(scrub(new SourceError("spotify", "http", text).message)), text).toBe(false);
          const log = logger("Probe");
          log.warn(text);
          log.warn("failed", { err: new Error(text), note: text });
          // util.inspect writes a tab or a line break escaped (`\t`), which is #237's.
          if (/[\t\n]/.test(text)) continue;
          const value = text.slice("authorization: '".length, -1);
          target.log("[Fetch] sent", { note: inspect({ Authorization: value }) });
          target.log(`[Fetch] sent ${inspect({ authorization: value })}`);
          inspected++;
        }
      } finally {
        restore();
      }
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(texts.length * 2 + inspected * 2);
      expect(inspected).toBe(64);
      expect(lines.filter(shown)).toEqual([]);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "a pair name after a quoted scheme",
      "{ authorization: 'Bearer token: V7qW6rE5tY4uI3oP2aS1' }",
    ],
    [
      "a quoted scheme after a quoted scheme",
      "authorization: 'Bearer \"Bearer V7qW6rE5tY4uI3oP2aS1\"'",
    ],
    [
      "a scheme in brackets after a quoted scheme",
      "authorization: 'Bearer (Bearer V7qW6rE5tY4uI3oP2aS1)'",
    ],
    ["a Discogs token after a tab", 'Authorization: "Discogs token=\tV7qW6rE5tY4uI3oP2aS1"'],
    ["a pair in backticks", "Authorization = `Basic \taccess_token='V7qW6rE5tY4uI3oP2aS1=='"],
    ["a scheme after a slash", "authorization: 'Bearer x/Bearer V7qW6rE5tY4uI3oP2aS1'"],
    ["three schemes", "authorization: Bearer Bearer Bearer V7qW6rE5tY4uI3oP2aS1"],
    ["two schemes, then Basic", "Authorization: Bearer Bearer Basic V7qW6rE5tY4uI3oP2aS1=="],
    [
      "three schemes across a line break",
      "authorization: Bearer\nBearer Bearer V7qW6rE5tY4uI3oP2aS1",
    ],
    ["three schemes, any case", "password=bearer BEARER bearer V7qW6rE5tY4uI3oP2aS1"],
    ["three schemes in quotes", "authorization: 'Bearer Bearer Bearer V7qW6rE5tY4uI3oP2aS1'"],
    // A pair's value stops at "&", the Authorization rule's does not.
    [
      "two schemes before a token with &, in a headers object",
      "{ headers: { Authorization: 'Bearer Bearer a&V7qW6rE5tY4uI3oP2aS1' } }",
    ],
    [
      "two schemes before a token with &, in JSON",
      '{"authorization":"Bearer Bearer x&V7qW6rE5tY4uI3oP2aS1"}',
    ],
    ["two schemes before a password with &", 'password: "Bearer Bearer p&V7qW6rE5tY4uI3oP2aS1"'],
    [
      "four schemes in quotes before a token with &",
      "authorization: 'Bearer Bearer Bearer Bearer abc&V7qW6rE5tY4uI3oP2aS1'",
    ],
    [
      "three schemes before a token with &",
      "authorization: Bearer Bearer Bearer abc&V7qW6rE5tY4uI3oP2aS1",
    ],
    [
      "Basic twice, then Bearer, before a token with &",
      "Authorization: Basic Basic Bearer p&V7qW6rE5tY4uI3oP2aS1 next",
    ],
    [
      "three schemes before a quoted token with &",
      'authorization: Bearer Bearer Bearer "abc&V7qW6rE5tY4uI3oP2aS1"',
    ],
    [
      "two schemes in quotes before a quoted token with &",
      "authorization: 'Bearer Bearer \"abc&V7qW6rE5tY4uI3oP2aS1\"'",
    ],
  ])("leaves no part of a token after schemes and rules in a row: %s", (_label, text) => {
    const dir = mkdtempSync(join(tmpdir(), "log-rows-"));
    const shown = (out: string) => out.includes("V7qW6r") || out.includes("oP2aS1");
    try {
      const file = join(dir, "api.jsonl");
      configureLogger({ LOG_FILE: file });
      expect(scrub(text)).not.toSatisfy(shown);
      expect(scrub(logText(text))).not.toSatisfy(shown);
      expect(JSON.stringify(serializeError(new Error(text)))).not.toSatisfy(shown);
      logger("Probe").warn(text);
      expect(readFileSync(file, "utf8")).not.toSatisfy(shown);
      expect(readFileSync(file, "utf8")).toContain("[redacted]");
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps hidden what main's pair and Authorization rules hid (generated texts)", () => {
    // main's expressions (662d2ce), frozen: what they hid in a text, scrub hides too.
    const MAIN_SECRET_PAIR =
      /\b((?:x-)?api[-_]?key|apikey|(?:ocp-apim-)?subscription[-_]?key|authorization|access[-_]?token|refresh[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|password|secret|token)(["']?\s*[:=]\s*(?!\s))(?!\s*(?:(?:Bearer|Basic|Discogs)\s+)?["']?\[redacted\])(?:(?:Bearer|Basic|Discogs)\s+)?["']?[^\s"'&,;}\]]+["']?/gi;
    const MAIN_AUTH_SCHEME =
      /\b(Bearer\s+|Discogs\s+token=)(?!["']?\[redacted\])["']?[^\s"',;}\]]+["']?|\b(Basic\s+)["']?[A-Za-z0-9+/=]{8,}["']?/gi;
    const main = (text: string) =>
      text
        .replace(MAIN_SECRET_PAIR, "$1$2[redacted]")
        .replace(
          MAIN_AUTH_SCHEME,
          (_m, scheme?: string, basic?: string) => `${scheme ?? basic}[redacted]`,
        );
    const SECRET = "M0001xAbCdEf";
    const shown = (out: string) => out.includes("M0001x") || out.includes("AbCdEf");
    const texts: string[] = [];
    for (const name of ["authorization", "Proxy-Authorization", "token", "password"])
      for (const sep of [": ", "=", '": "', " = "])
        for (const quote of ["", "'", '"', "`"])
          for (const scheme of ["Bearer", "basic", "Discogs"])
            for (const blank of [" ", "\t", "\n", "  "])
              for (const between of [
                "",
                "Bearer ",
                "Bearer Bearer ",
                "Basic ",
                "bearer\n",
                "token: ",
                "x/",
                "(",
                '"',
                "'",
                "-",
                "access_token='",
                "Discogs token=",
                "Discogs token=\t",
                "x/Bearer ",
                '"Bearer ',
                "(Bearer ",
                "password=",
                'token": ',
                "Bearer Bearer Bearer ",
                "p&",
                "Bearer Bearer p&",
                'Bearer Bearer "p&',
              ])
                texts.push(`${name}${sep}${quote}${scheme}${blank}${between}${SECRET}${quote} }`);
    const parts = [
      "authorization: ",
      "token=",
      "'",
      '"',
      "`",
      "Bearer ",
      "Basic ",
      "bearer\t",
      "Discogs token=",
      "\n",
      "  ",
      "x/",
      "(",
      ":",
      "&",
      SECRET,
    ];
    texts.push(...randomStrings(parts, 20_000, 9, 235));
    const missed = texts.filter((text) => shown(scrub(text)) && !shown(main(text)));
    expect(missed.slice(0, 5)).toEqual([]);
    // The texts hold what main hid often enough for the comparison to mean something.
    expect(
      texts.filter((text) => text.includes(SECRET) && !shown(main(text))).length,
    ).toBeGreaterThan(5_000);
  });

  it("finds the token of a quoted Authorization value, without its scheme and quotes", () => {
    const text = `{ authorization: 'Bearer ${TOKEN}', 'proxy-authorization': "Basic ${CRED}" }`;
    expect(scrubbedSpans(text).map(([start, end]) => text.slice(start, end))).toEqual([
      TOKEN,
      CRED,
    ]);
  });

  it("keeps readable text readable", () => {
    for (const text of [
      "Authorization header missing",
      "authorization missing for the request",
      "the scheme is Bearer",
      "scheme 'Basic', then 'Bearer'",
      "{ authorization: '' }",
      "{ accept: 'application/json', 'content-type': 'text/plain' }",
    ]) {
      expect(scrub(text)).toBe(text);
    }
  });

  it("keeps the words after a quoted scheme word that holds no token", () => {
    for (const [text, expected] of [
      [
        "authorization: 'Bearer' or 'Basic' expected",
        "authorization: [redacted] or 'Basic' expected",
      ],
      // A line break after a quoted scheme ends the value: the next line stays.
      [
        "authorization: 'Bearer\n    at Object.<anonymous> (app.js:1:1)'",
        "authorization: [redacted]\n    at Object.<anonymous> (app.js:1:1)'",
      ],
      [
        "password: 'Basic\n\nThe server then retried'",
        "password: [redacted]\n\nThe server then retried'",
      ],
    ]) {
      expect(scrub(text)).toBe(expected);
    }
  });

  it("does not replace a quoted value it replaced before", () => {
    for (const text of [
      "authorization: 'Bearer [redacted]'",
      'authorization: "Basic [redacted]"',
    ]) {
      expect(scrub(text)).toBe(text);
    }
  });

  it("leaves no part of a credential the cap cuts, a short Basic one included", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-cap-"));
    try {
      const file = join(dir, "api.jsonl");
      configureLogger({ LOG_FILE: file });
      for (const [scheme, quote] of [
        ["Basic ", ""],
        ["Basic ", '"'],
        ["Authorization: Basic ", ""],
        ["Bearer ", ""],
      ]) {
        const value = `${scheme}${quote}${CRED}${quote}`;
        for (let k = 1; k < CRED.length; k++) {
          const at = MAX_LOGGED_TEXT - scheme.length - quote.length - k;
          const text = `${"w".repeat(at - 1)} ${value} tail`;
          const out = scrub(text);
          expect(out.length, value).toBeLessThan(MAX_LOGGED_TEXT + 20);
          expect(out.slice(-40), `${value} cut after ${k}`).not.toContain(
            CRED.slice(0, Math.min(k, 3)),
          );
          if (k === 5) logger("Probe").warn(text);
        }
      }
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(4);
      for (const line of lines) expect(line).not.toContain(CRED.slice(0, 3));
      expect(JSON.parse(lines[0] as string).msg).toMatch(/w …\[truncated\]$/);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cuts before an Authorization value as the text came, whose scheme a pair took alone", () => {
    // The cap reads Authorization values in the text before secret pairs replace anything: here
    // the pair rule takes the quoted scheme word alone (a line break follows it), so after it no
    // rule would find the credential; the cut still falls before it.
    for (const k of [26, 30, 40]) {
      const text = `${"w".repeat(MAX_LOGGED_TEXT - k - 1)} { authorization: 'Basic\n    ${CRED}' }`;
      expect(scrub(text).slice(-30), String(k)).toBe("w { authorization: [redacted]]");
    }
  });

  it("moves a cut that moved to a credential it splits after the word Basic", () => {
    // Moved to a configured value glued to the credential, then to the start of the credential,
    // which only the text as it came holds whole; a cut through a Basic credential that nothing
    // else moved falls before the word (readPairs).
    configureLogger({ GLUED_SECRET: "S1xS2xS3xS4xS5xS6x" });
    const glued = `xx Basic M0003x=S1xS2xS3xS4xS5xS6x yy ${"z ".repeat(20)}`;
    expect(logCut(glued, glued.indexOf("S3x"))).toBe(glued.indexOf("M0003x"));
  });

  it("moves a cut through a Basic credential before a host written right before it", () => {
    // The credential's span, with its word, touches the host's: the cut falls before both, as
    // it always has, and never shows the host where it hid it before.
    configureLogger({ AZURE_OPENAI_ENDPOINT: "https://contoso-prod.openai.azure.com" });
    const text = `xx contoso-prod.openai.azure.comBasic C1xC2xC3xC4x yy ${"z ".repeat(20)}`;
    expect(logCut(text, text.indexOf("C3x"))).toBe(text.indexOf("contoso"));
  });

  /** `piece` repeated to about `size` characters, between `head` and `tail`. */
  const filled =
    (piece: string, head = "", tail = "") =>
    (size: number) =>
      head + piece.repeat(Math.ceil(size / piece.length)) + tail;
  it.each([
    ["spaces after a quoted scheme", filled(" ", "authorization: 'Bearer ", "]")],
    ["quoted schemes", filled("authorization: 'Bearer ")],
    ["quoted schemes after Basic", filled("authorization:\"Basic\t'Bearer ")],
    ["quoted tokens", filled('"authorization": "Bearer abc.def", ')],
    // The word after a scheme is read for the start of another rule and for an "&": a long one,
    // runs of schemes, and words that hold a rule's start near their end.
    ["a long word after a quoted scheme", filled("x", "authorization: 'Bearer ")],
    ["a run of schemes", filled("Bearer ", "authorization: ", "x")],
    ["a quoted run of schemes", filled("Bearer ", "authorization: '")],
    ["a pair's name after a slash", filled("authorization: 'Bearer x/token")],
    ["an & after a run of schemes", filled("authorization: 'Bearer Bearer x&")],
  ])("reads quoted Authorization values in linear time, up to 1 MB: %s", (_name, make) => {
    // The CPU time of the three readers from 128 kB to 1 MB: a text read once grows about 8 times,
    // and one read again from each value to its end about 64 times, or takes seconds on 1 MB.
    const call = (text: string) =>
      text.replace(SECRET_PAIR, "$1$2[R]").length + scrubbedSpans(text).length + scrub(text).length;
    const { ratio } = growth(make, call, { size: 1 << 17, factor: 8, maxMs: 3_000 });
    expect(ratio).toBeLessThan(20);
  });
});

describe("a configured secret that cannot be replaced safely", () => {
  it("withholds the line instead of writing the secret", () => {
    // A value that also occurs as JSON structure in every line.
    configureLogger({ ODD_SECRET: ',"time":' });
    logs = captureLogsForTests();
    logger("Probe").info("something happened", { runId: "run-1" });
    const raw = logs.lines();
    expect(raw).toHaveLength(1);
    const line = JSON.parse(raw[0]) as Record<string, unknown>;
    expect(line.msg).toBe("log line withheld: it contained a configured secret");
    expect(line.component).toBe("Probe");
    expect(raw[0]).not.toContain("something happened");
  });
});

describe("every line", () => {
  // The forms the scrubber rewrites, and characters JSON must escape, in random order.
  const PIECES = [
    '"',
    "'",
    "\\",
    '\\"',
    "\n",
    "\u0000",
    " ",
    ":",
    "=",
    ",",
    "}",
    "]",
    "Bearer ",
    "Basic ",
    "Discogs token=",
    "password=",
    "password: ",
    "token=",
    "api-key: ",
    "Authorization: ",
    "https://",
    "p.scdn.co/x",
    "cdnt-preview.dzcdn.net/a?hdnea=1",
    "dummy-resource.example.net",
    KEY,
    "[redacted]",
    "abc123",
    "é",
    "😀",
  ];

  // About a second of work on an idle machine (each line scrubs an error's stack), several on a
  // busy one, so it gets more than the default 5 s; nothing in it is timed.
  it("is valid JSON and holds no configured secret, whatever text it is given (fuzz)", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const text = () =>
      Array.from(
        { length: 1 + Math.floor(random() * 12) },
        () => PIECES[Math.floor(random() * PIECES.length)],
      ).join("");
    const log = logger("Fuzz");
    for (let i = 0; i < 10_000; i++) {
      const t = text();
      log.warn(t, { [text()]: t, note: t, err: new Error(t) });
    }
    const lines = logs.lines();
    expect(lines).toHaveLength(10_000);
    for (const line of lines) {
      expect(() => JSON.parse(line), line).not.toThrow();
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("dummy-resource");
    }
  }, 60_000);
});

describe("serializeError", () => {
  it("keeps the type, the scrubbed message and stack, code, status and cause; nothing else", () => {
    const cause = new Error(`upstream said Bearer secret-cause-token`);
    const error = Object.assign(
      new Error(`401 from ${ENDPOINT}/openai/v1 with ${KEY}`, { cause }),
      {
        name: "APIError",
        status: 401,
        code: "invalid_api_key",
        headers: { authorization: "Bearer header-token", "api-key": KEY },
        config: { apiKey: KEY, baseURL: ENDPOINT },
      },
    );
    const serialized = serializeError(error) as Record<string, unknown>;
    expect(Object.keys(serialized).sort()).toEqual([
      "cause",
      "code",
      "message",
      "stack",
      "status",
      "type",
    ]);
    expect(serialized).toMatchObject({
      type: "APIError",
      status: 401,
      code: "invalid_api_key",
      message: "401 from [provider endpoint] with [redacted]",
      cause: { type: "Error", message: "upstream said Bearer [redacted]" },
    });
    const text = JSON.stringify(serialized);
    for (const secret of [KEY, "dummy-resource", "secret-cause-token", "header-token"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("serializeError, the API's own errors", () => {
  it("keeps the kind, how long to wait, why an answer was cut off and an AggregateError's errors", () => {
    const sourceError = Object.assign(new Error("rate limited"), {
      name: "SourceError",
      kind: "rate_limited",
      source: "spotify",
      retryAfterMs: 30_000,
      body: '{"error":"secret upstream body"}',
    });
    const llmError = Object.assign(new Error("cut off"), {
      kind: "invalid_output",
      incompleteReason: "max_output_tokens",
    });
    const aggregate = new AggregateError([sourceError, new Error(`with ${KEY}`)], "both failed");
    const serialized = serializeError(aggregate) as Record<string, unknown>;
    expect(serialized).toMatchObject({
      type: "AggregateError",
      message: "both failed",
      errors: [
        { type: "SourceError", kind: "rate_limited", source: "spotify", retryAfterMs: 30_000 },
        { message: "with [redacted]" },
      ],
    });
    expect(serializeError(llmError)).toMatchObject({
      kind: "invalid_output",
      incompleteReason: "max_output_tokens",
    });
    expect(JSON.stringify(serialized)).not.toContain("secret upstream body");
  });
});

describe("a log line", () => {
  it("is one JSON object with the level, the time, the component and the fields", () => {
    logger("Scout").info("Found a match", { candidates: 2 });
    expect(logs.lines()).toHaveLength(1);
    expect(logs.entries()[0]).toMatchObject({
      level: "info",
      time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      component: "Scout",
      candidates: 2,
      msg: "Found a match",
    });
  });

  it("replaces secret fields, at any depth, and serializes errors", () => {
    logger("Engineer").warn("Lookup failed", {
      previewUrl: "https://p.scdn.co/mp3-preview/abc",
      nested: {
        headers: { Authorization: "Bearer t" },
        apiKey: KEY,
        list: [{ preview: "https://e.dzcdn.net/x" }, { token: "t-123456" }],
      },
      err: new Error(`failed: ${KEY}`),
    });
    const [entry] = logs.entries();
    expect(entry).toMatchObject({
      previewUrl: "[redacted]",
      nested: {
        headers: "[redacted]",
        apiKey: "[redacted]",
        list: [{ preview: "[redacted]" }, { token: "[redacted]" }],
      },
      err: { type: "Error", message: "failed: [redacted]" },
    });
    expect(logs.lines()[0]).not.toContain(KEY);
  });

  it("writes the typed query at debug level only; above, its length", () => {
    const log = logger("Run");
    log.info("Analysis", { query: "Midnight City" });
    log.warn("No match", { songQuery: "Midnight City" });
    log.debug("Analysis: query", { query: "Midnight City" });
    const [info, warn, debug] = logs.entries();
    expect(info).toMatchObject({ queryLength: 13 });
    expect(info).not.toHaveProperty("query");
    expect(warn).toMatchObject({ songQueryLength: 13 });
    expect(debug).toMatchObject({ query: "Midnight City" });
  });

  it("is not written below the level", () => {
    logs.restore();
    logs = captureLogsForTests({ level: "info" });
    logger("Run").debug("hidden", { query: "x" });
    logger("Run").info("shown");
    expect(logs.messages()).toEqual(["shown"]);
  });
});

describe("a log call", () => {
  it("never throws on fields it cannot read, and says so", () => {
    const odd = new Error("x");
    (odd as unknown as { message: unknown }).message = { detail: "an object" };
    Object.defineProperty(odd, "code", {
      get() {
        throw new Error("getter exploded");
      },
    });
    const throwingFields = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("field getter exploded");
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy boom");
        },
      },
    );
    const log = logger("Odd");
    expect(() => log.error("odd error", { err: odd })).not.toThrow();
    expect(() => log.error("odd fields", throwingFields)).not.toThrow();
    expect(() => log.error("proxy field", { inner: proxy })).not.toThrow();
    expect(() =>
      log.error("undefined message", { err: Object.assign(new Error(), { message: undefined }) }),
    ).not.toThrow();

    const [oddError, fields, proxied] = logs.entries();
    expect(oddError).toMatchObject({
      msg: "odd error",
      err: { type: "Error", message: "[object Object]", stack: expect.any(String) },
    });
    expect(oddError.err).not.toHaveProperty("code");
    expect(fields).toMatchObject({ component: "Odd", msg: "log line could not be written" });
    expect(proxied).toMatchObject({ msg: "proxy field", inner: "[unreadable]" });
    expect(logs.lines()).toHaveLength(4);
  });

  it("keeps numbers and booleans under secret-looking names, and redacts token lists", () => {
    logger("X").info("usage", {
      apiKeyConfigured: true,
      response: 503,
      tokensIn: 12,
      input_tokens_details: { cached_tokens: 4 },
      refreshTokens: ["rt-0123456789abcdef"],
      accessToken: "at-0123456789abcdef",
    });
    const entry = logs.entries()[0];
    expect(entry).toMatchObject({
      apiKeyConfigured: true,
      response: 503,
      tokensIn: 12,
      input_tokens_details: { cached_tokens: 4 },
      refreshTokens: "[redacted]",
      accessToken: "[redacted]",
    });
    expect(JSON.stringify(entry)).not.toContain("0123456789abcdef");
  });

  it("replaces fields whose name says they are secret, compound names included", () => {
    logger("X").info("fields", {
      spotifyAccessToken: "BQD-1",
      bearerToken: "t-2",
      secretKey: "s-3",
      azureOpenAIApiKey: "k-4",
      subscriptionKey: "k-5",
      clientPassword: "p-6",
      key: "k-7",
      spotifyPreviewUrl: "https://e.dzcdn.net/x",
      runToken: "v1.a.b",
      turnstileToken: "0.x",
      inputTokens: 900,
      tokenCount: 3,
      cacheKey: "track:1",
    });
    const [entry] = logs.entries();
    for (const name of [
      "spotifyAccessToken",
      "bearerToken",
      "secretKey",
      "azureOpenAIApiKey",
      "subscriptionKey",
      "clientPassword",
      "key",
      "spotifyPreviewUrl",
      "runToken",
      "turnstileToken",
    ]) {
      expect(entry[name], name).toBe("[redacted]");
    }
    expect(entry).toMatchObject({ inputTokens: 900, tokenCount: 3, cacheKey: "track:1" });
  });

  it("writes a query that is not a string as its length too", () => {
    logger("X").info("q", { query: ["typed a", "typed b"], q: { value: "typed obj" } });
    const [entry] = logs.entries();
    expect(entry).toMatchObject({ queryLength: 2, qLength: 21 });
    expect(logs.lines()[0]).not.toContain("typed");
  });
});

describe("the run id", () => {
  it("is on every line logged inside withRun, after awaits and timers, and on no other", async () => {
    const log = logger("Test");
    log.info("before");
    await withRun("run-a", async () => {
      log.info("sync");
      await new Promise((resolve) => setTimeout(resolve, 1));
      log.info("after a timer");
      await Promise.all([1, 2].map(async (i) => log.info(`parallel ${i}`)));
      setImmediate(() => log.info("from setImmediate"));
      await new Promise((resolve) => setImmediate(resolve));
    });
    log.info("after");
    const byMessage = Object.fromEntries(logs.entries().map((entry) => [entry.msg, entry.runId]));
    expect(byMessage).toEqual({
      before: undefined,
      sync: "run-a",
      "after a timer": "run-a",
      "parallel 1": "run-a",
      "parallel 2": "run-a",
      "from setImmediate": "run-a",
      after: undefined,
    });
  });

  it("an explicit runId field wins over the context's", () => {
    withRun("run-a", () => logger("Test").info("x", { runId: "run-b" }));
    expect(logs.entries()[0].runId).toBe("run-b");
  });

  it("survives LangGraph's async chain: parallel nodes, a timer, a checkpointer, a resume", async () => {
    const State = Annotation.Root({
      seen: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    });
    const log = logger("Node");
    const node = (name: string, wait: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, wait));
      log.info(name, { contextRunId: currentRunId() ?? null });
      return { seen: [name] };
    };
    const graph = new StateGraph(State)
      .addNode("first", node("first", 2))
      .addNode("left", node("left", 3))
      .addNode("right", node("right", 1))
      .addNode("last", node("last", 0))
      .addEdge(START, "first")
      .addEdge("first", "left")
      .addEdge("first", "right")
      .addEdge(["left", "right"], "last")
      .addEdge("last", END)
      .compile({ checkpointer: new MemorySaver(), interruptBefore: ["last"] });

    const run = (runId: string, input: Parameters<typeof graph.stream>[0]) =>
      withRun(runId, async () => {
        const stream = await graph.stream(input, {
          configurable: { thread_id: runId },
          streamMode: "updates",
        });
        for await (const _update of stream) {
          // drained
        }
      });

    // Two runs at once, each paused before its last node, then each resumed.
    await Promise.all([run("run-1", { seen: [] }), run("run-2", { seen: [] })]);
    await Promise.all([run("run-1", null), run("run-2", null)]);

    const entries = logs.entries();
    expect(entries).toHaveLength(8);
    for (const entry of entries) {
      expect(entry.runId).toMatch(/^run-[12]$/);
      expect(entry.contextRunId).toBe(entry.runId);
    }
    expect(
      entries
        .filter((entry) => entry.runId === "run-1")
        .map((entry) => entry.msg)
        .sort(),
    ).toEqual(["first", "last", "left", "right"]);
  });
});

describe("the console bridge", () => {
  it("sends console calls through the logger: JSON, level, tag as component, error as err", () => {
    const target = {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const original = target.log;
    const restore = installConsoleBridge(target);
    try {
      withRun("run-c", () => {
        target.log("🔍 [Cache] Hit for", "track-1");
        target.warn("[Store] Write failed:", new Error(`disk full near ${KEY}`));
        target.error(
          "no tag here",
          { previewUrl: "https://p.scdn.co/mp3-preview/a", note: "https://p.scdn.co/b" },
          Object.assign(new Error("second"), {
            config: { headers: { "Ocp-Apim-Subscription-Key": "rtSubKey123456" } },
          }),
          { nested: { mySecretToken: "tok-1234567" } },
        );
        target.debug("[Researcher] step 2");
      });
    } finally {
      restore();
    }
    expect(target.log).toBe(original);

    const entries = logs.entries();
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        component: "Cache",
        msg: "Hit for track-1",
        runId: "run-c",
      }),
      expect.objectContaining({
        level: "warn",
        component: "Store",
        msg: "Write failed",
        err: expect.objectContaining({ message: "disk full near [redacted]" }),
        runId: "run-c",
      }),
      expect.objectContaining({ level: "error", msg: expect.stringContaining("[preview link]") }),
      expect.objectContaining({ level: "debug", component: "Researcher", msg: "step 2" }),
    ]);
    expect(entries[2]).not.toHaveProperty("component");
    expect(logs.lines().join("\n")).not.toMatch(
      /p\.scdn\.co|dummy-azure-key|rtSubKey123456|tok-1234567/,
    );
  });
});

describe("client addresses", () => {
  it("are hashed with a key: the same address alike, another key another hash", () => {
    configureLogger({ LOG_IP_SALT: "salt-one" });
    const first = ipHash("203.0.113.7");
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(ipHash("203.0.113.7")).toBe(first);
    expect(ipHash("203.0.113.8")).not.toBe(first);
    configureLogger({ LOG_IP_SALT: "salt-two" });
    expect(ipHash("203.0.113.7")).not.toBe(first);
    // No LOG_IP_SALT: a random key for this process.
    configureLogger({});
    expect(ipHash("203.0.113.7")).not.toBe(first);
    expect(ipHash(undefined)).toBeUndefined();
  });
});

describe("configureLogger", () => {
  it("appends the lines to LOG_FILE as well", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const file = join(dir, "logs", "api.jsonl");
      expect(configureLogger({ LOG_FILE: file })).toEqual([]);
      withRun("run-f", () => logger("Run").info("to the file"));
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ msg: "to the file", runId: "run-f" }),
      ]);
      // And to stdout (here, the capture) as well.
      expect(logs.messages()).toEqual(["to the file"]);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates LOG_FILE readable by its owner only, and takes a relative path from baseDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      expect(configureLogger({ LOG_FILE: "logs/api.jsonl" }, { baseDir: dir })).toEqual([]);
      logger("Run").info("to the file");
      const file = join(dir, "logs", "api.jsonl");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toContain("to the file");
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when an existing LOG_FILE can be read by other users", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const file = join(dir, "api.jsonl");
      writeFileSync(file, "");
      chmodSync(file, 0o644);
      expect(configureLogger({ LOG_FILE: file })).toEqual([
        expect.stringContaining("can be read or written by other users (mode 644)"),
      ]);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a LOG_FILE that is not a regular file, at once (a FIFO would hold startup)", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const fifo = join(dir, "fifo");
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      expect(configureLogger({ LOG_FILE: fifo })).toEqual([
        expect.stringContaining("is not a regular file; logging to stdout only"),
      ]);
      expect(configureLogger({ LOG_FILE: dir })).toEqual([
        expect.stringContaining("is not a regular file"),
      ]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns about an unknown LOG_LEVEL and an unusable LOG_FILE, and goes on at info", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const warnings = configureLogger({ LOG_LEVEL: "loud", LOG_FILE: join(dir, "\0bad") });
      expect(warnings).toEqual([
        expect.stringContaining("LOG_LEVEL=loud is not one of"),
        expect.stringContaining("cannot be opened"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

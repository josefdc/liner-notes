/**
 * Secret shapes a recording must not hold (recorder.ts `leaks`, `linkSecret`,
 * `withoutPageTokens`), and the public values that only look like them. Precise rules (a
 * credential's own format or name) are refused in every field; heuristic ones (a hex run, a
 * base64 value with short pieces, a random base64url run) withhold a web search page's excerpt
 * and refuse a link's query or fragment, and a random mixed-case run in a path or an id. The
 * committed recordings are scanned with the same rules, and none is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplayRecord } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import {
  archiveCoverOf,
  leaks,
  PageExcerpts,
  publicTextsOf,
  recordIssues,
  WITHHELD_EXCERPT,
  withoutPageTokens,
} from "./recorder.js";
import { DEFAULT_REPLAY_DIR, loadReplays } from "./records.js";
import { PINNED_DIR, readRecording, recordingSlugs } from "./testing/recordings.js";

const check = { secrets: [], typedQuery: "", publicTexts: [] };

/** `n` characters cycled from `from`: a stand-in for a random value of that alphabet. */
const chars = (n: number, from = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LmNb") =>
  from.repeat(Math.ceil(n / from.length)).slice(0, n);

/** A random run of 44 letters and digits, as a long token is. */
const TOKEN = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7K0mNqRsTu";
/** A base64url key of 34 with "-" and "_", too short for the long-token rule. */
const URL_KEY = "Ab3dEf6hIj-9lMn2pQr5tUv_8xYz1bCd4f";
/** A key made as `openssl rand -base64 48` makes one, with every piece between "+" and "/" short. */
const SHORT_PIECES = "Kq7Rt/Xm2Kp9w+Zb4NcH8/vL3sJd6+Fy1Tg5Ae/Wu0OkPzQ+hY6rB3n/Ec9Gm2VxLs+T4w";
const HEX_32 = "5f4dcc3b5aa765d61d8327deb882cf99";
const HEX_64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const AWS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const MBID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const OTHER_MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const VALUE = "Zx9Qw3Er7Ty1Ui5Op";

/** Keys in their services' formats, built from parts. */
const VENDOR_KEYS: Array<[string, string]> = [
  ["a Google API key", `AIza${chars(35)}`],
  ["a Google API key", `AIza${chars(15)}-${chars(9)}_${chars(9)}`],
  ["a Stripe key", `sk_live_${chars(24)}`],
  ["a Stripe key", `rk_live_${chars(24)}`],
  ["a Turnstile secret", `0x4AAAAAAA${chars(25)}`],
  ["a Hugging Face token", `hf_${chars(34, "QWertYUiopASdfGHjklZXcvBNm")}`],
  ["a GitLab token", `glpat-${chars(20)}`],
  ["a GitHub token", `ghp_${chars(36)}`],
  ["a GitHub token", `github_pat_${chars(22)}_${chars(59)}`],
  ["a Slack token", `xoxb-1234567890-${chars(24)}`],
  ["a Discord bot token", `M${chars(23)}.${chars(6)}.${chars(38)}`],
  ["an AWS access key id", AWS_KEY_ID],
  ["a Tavily key", `tvly-${chars(24)}`],
];

/** A web search result at `url`, with `edit` applied. */
const webItem = (url: string, edit: Record<string, unknown> = {}) => ({
  id: `tavily:${url}`,
  source: "tavily",
  sourceTier: "web",
  url,
  title: "A page",
  retrievedAt: "2026-10-29T07:02:00.000Z",
  excerpt: "A page about the track.",
  recordRef: null,
  ...edit,
});

/**
 * What the recorder does with `record`, as `buildRecord` does: page excerpts withheld or refused
 * (`withoutPageTokens`), then the rest checked (`leaks`). Empty: the record is taken as it is.
 */
function judge(record: unknown, secrets: string[] = []) {
  const found = new PageExcerpts();
  const kept = withoutPageTokens(record, secrets, found);
  return [
    ...[...found.refused].map(([path, why]) => `${path}: ${why}`),
    ...found.withheld.map(({ path }) => `${path}: withheld`),
    ...leaks(kept, { ...check, secrets }),
  ];
}

const claim = (text: string) => ({ analysis: { claims: [{ text }] } });
const inClaim = (text: string) => judge(claim(text));
const asWebPage = (url: string) => judge({ evidence: [webItem(url)] });
const excerpt = (text: string) =>
  judge({ evidence: [webItem("https://example.org/a", { excerpt: text })] });

/** `value` in each field a record holds it in, as `[field, record]`. */
function everywhere(value: string): Array<[string, unknown]> {
  return [
    ["claim", claim(`The page says ${value} there.`)],
    ["verdictReason", { analysis: { claims: [{ text: "x", verdictReason: `see ${value}` }] } }],
    ["web title", { evidence: [webItem("https://example.org/a", { title: `Notes ${value}` })] }],
    [
      "web excerpt",
      { evidence: [webItem("https://example.org/a", { excerpt: `It printed ${value} once.` })] },
    ],
    ["web url query", { evidence: [webItem(`https://example.org/a?ref=${value}`)] }],
    ["allowed link query", claim(`See https://genius.com/x?ref=${value} now.`)],
    ["allowed link path", claim(`See https://genius.com/${value} now.`)],
    ["id", { evidence: [{ id: `genius:song/${value}` }] }],
    ["glued", claim(`apikey${value}x`)],
  ];
}

describe("precise rules: refused in every field", () => {
  it("refuses keys in their services' formats wherever they are, glued to letters too", () => {
    for (const [name, key] of VENDOR_KEYS) {
      for (const [field, record] of everywhere(key)) {
        const found = judge(record);
        expect(
          found.some((r) => r.endsWith(`: ${name}`) || r.endsWith(`: ${name} in a link`)),
          `${name} in ${field}: ${found.join("; ")}`,
        ).toBe(true);
        expect(found.join(" "), `${name} in ${field}`).not.toContain(key);
      }
    }
    // After an escaped line break, as JSON-escaped text writes one, or glued to a digit.
    for (const text of [`line\\n${AWS_KEY_ID}`, `7${AWS_KEY_ID}`]) {
      expect(inClaim(text), text).toContain("analysis.claims[0].text: an AWS access key id");
    }
    // A hashtag or a catalogue number in capitals, and a lookalike made of words.
    for (const text of [
      "#ASIATOUR2023SEOULKPOP",
      "Asia: ASIA1982GEFFENGHS2008 on vinyl",
      "Pressing AKIA0000000000000001 matrix",
      "hf_ThisIsTheHalfwayPointOfTheRecord mixes",
    ]) {
      expect(inClaim(text), text).toEqual([]);
    }
  });

  it("refuses password, secret, token and key parameters under any of their names, in links and text", () => {
    for (const name of [
      "password",
      "passwd",
      "pass",
      "pwd",
      "user_password",
      "secret",
      "client_secret",
      "client-secret",
      "api_secret",
      "app_secret",
      "secret_key",
      "access_key",
      "auth_token",
      "refresh_token",
      "id_token",
      "private_token",
      "session_token",
      "access_token",
      "token",
      "jsessionid",
      "clientSecret",
      "apiSecret",
      "dbPassword",
      "userPassword",
      "passphrase",
      "DB_PASSWORD",
      "oauth_token",
      "oauth_signature",
      "X-Goog-Signature",
      "X-Amz-Credential",
    ]) {
      for (const [field, found] of [
        ["allowed link", inClaim(`See https://genius.com/x?q=a&${name}=${VALUE} now.`)],
        ["web url", asWebPage(`https://example.org/a?q=a;${name}=${VALUE}`)],
        ["fragment", inClaim(`See https://genius.com/x#${name}=${VALUE} now.`)],
      ] as const) {
        expect(found, `${name} in ${field}`).not.toEqual([]);
      }
    }
    for (const text of [
      `auth_token=${chars(30)}`,
      `refresh_token=${chars(30)}`,
      `{"refresh_token": "${chars(30)}"}`,
      `secret_key=${chars(30)}`,
      "password=Tr0ub4dor&3",
      "Server=db.example.org;Password=Tr0ub4dor3x;",
      `apiSecret=${VALUE}`,
    ]) {
      expect(inClaim(text), text).not.toEqual([]);
    }
  });

  it("refuses any value under a password's or a token's name, and under a bare pass or secret only a credential", () => {
    for (const text of [
      "See https://genius.com/x?pwd=ab now.",
      "See https://genius.com/x?password=a now.",
      "See https://genius.com/x?db_password=x now.",
      "See https://genius.com/x?client_secret=x now.",
      "See https://genius.com/x?pass=Tr0ub4dor now.",
      "See https://genius.com/x#secret=QwErTyUiOpAsDf now.",
      "Their single secret=hunter2 remix",
    ]) {
      expect(inClaim(text), text).not.toEqual([]);
    }
    for (const text of [
      "Tickets: https://genius.com/tickets?pass=weekend-camping",
      "Festival pass=sold out in 1998",
      "Their single secret=love remix",
      "See https://en.wikipedia.org/wiki/Secret_(Madonna_song)#secret=yes now.",
    ]) {
      expect(inClaim(text), text).toEqual([]);
    }
  });

  it("reads a parameter nested in another, URL-encoded once or twice", () => {
    for (const name of [
      "password",
      "secret",
      "key",
      "sig",
      "signature",
      "X-Amz-Signature",
      "hdnea",
      "oauth_signature",
      "token",
      "api_key",
      "access_token",
      "client_secret",
    ]) {
      const once = `%2Fcb%3F${name}%3D${VALUE}`;
      const twice = once.replace(/%/g, "%25");
      for (const next of [once, twice]) {
        expect(
          inClaim(`See https://genius.com/x?next=${next} now.`),
          `${name} ${next}`,
        ).not.toEqual([]);
        expect(asWebPage(`https://example.org/a?next=${next}`), `${name} ${next}`).not.toEqual([]);
      }
    }
    // A stray "%" elsewhere, or an escape that is not UTF-8 ("%FF"), does not stop the rest of the
    // text being decoded.
    for (const text of [
      `See https://genius.com/x?off=100%&next=%2Fcb%3Fpassword%3D${VALUE} now.`,
      "See https://www.whosampled.com/sample/123/?off=50%&key=Zx9%2BQw3Er7Ty1Ui5Op2As8 now.",
      `Up 100% at /cb?a=1%26password%3D${VALUE}`,
      `See https://genius.com/x?next=%FF%26password%3D${VALUE} now.`,
    ]) {
      expect(inClaim(text), text).not.toEqual([]);
    }
    expect(
      asWebPage(`https://example.org/a?off=100%&next=%2Fcb%3Fpassword%3D${VALUE}`),
    ).not.toEqual([]);
  });

  it("refuses a password or secret field whose value looks like a credential, however it is written", () => {
    for (const text of [
      '{"password": "opensesame1"}',
      '{"password": 83746592}',
      '{"apiSecret": "opensesame1"}',
      '{"clientSecret": "opensesame1"}',
      '{"dbPassword": "opensesame1"}',
      "['userPassword' => 'opensesame1']",
      '{"passphrase": "opensesame1"}',
      "password: opensesame1",
      'password: "opensesame1"',
      "PASSWORD = opensesame1",
      ":password => 'opensesame1'",
      "<password>opensesame1</password>",
      '{"db_password": "opensesame1"}',
      '{"pass": "opensesame1"}',
      '{"pwd": "opensesame1"}',
      '{"client_secret":"opensesame1"}',
      "{&quot;password&quot;: &quot;opensesame1&quot;}",
      '{\\"password\\": \\"opensesame1\\"}',
      "{\\u0022password\\u0022: \\u0022opensesame1\\u0022}",
      "['password' => 'opensesame1']",
    ]) {
      expect(inClaim(text), text).not.toEqual([]);
      expect(excerpt(`Login: ${text}`), text).not.toEqual([]);
    }
    // Songs called "Secret" or "Password", followed by another title, a year or a time.
    for (const text of [
      'Madonna\'s 1994 single "Secret": "Bedtime Story" followed in 1995.',
      '"Secret": "Take a Bow" and "Bedtime Story" were singles.',
      "Madonna's 'Secret': 'Bedtime Story' followed in 1995",
      'Tracks: "Password": "Hidden" (remix)',
      'The single "Password": a 2009 club track.',
      'Tracklist: "Password": 3:41',
      "Secret: 1994-10-18, Maverick.",
      "Password: Swordfish, the 1999 B-side.",
    ]) {
      expect(inClaim(text), text).toEqual([]);
    }
  });

  it("refuses a key parameter that looks random: short, dotted, encoded, quoted or after #!", () => {
    for (const link of [
      `https://www.whosampled.com/sample/123/?key=Zx9Qw3Er7Ty1`,
      `https://www.whosampled.com/sample/123/?key=Zx9.Qw3Er7Ty1Ui5Op2As8`,
      `https://www.whosampled.com/sample/123/?key=Zx9%2BQw3Er7Ty1Ui5Op2As8`,
      `https://www.whosampled.com/sample/123/?key=Ab%252BCd3Ef5Gh7Ij9Kl`,
      `https://www.whosampled.com/sample/123/?key=%22${VALUE}%22`,
      `https://www.whosampled.com/sample/123/?key=%27${VALUE}%27`,
      "https://www.whosampled.com/sample/123/?key=Ab­3Cd5Ef7Gh9",
      `https://genius.com/Daft-punk-one-more-time-lyrics#!key=${VALUE}`,
      `https://genius.com/Daft-punk-one-more-time-lyrics#key=${VALUE}`,
    ]) {
      expect(inClaim(`See ${link} now.`), link).toContain("analysis.claims[0].text: a signed URL");
      expect(asWebPage(link), link).not.toEqual([]);
    }
  });

  it("refuses a bearer or basic credential in any case, and keeps the words in prose", () => {
    for (const text of [
      `authorization: bearer ${chars(30)}`,
      `BEARER ${chars(30)}`,
      `Authorization: Bearer "${VALUE}"`,
      `Bearer: ${VALUE}`,
      "Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      "authorization: basic dXNlcjpwYXNzd29yZA==",
      'Basic "dXNlcjpwYXNz"',
    ]) {
      expect(inClaim(text), text).toContain(
        "analysis.claims[0].text: a bearer or basic credential",
      );
    }
    for (const text of [
      "It needs a basic understanding of harmony to hear it.",
      "The bearer of bad news, in the second verse.",
      "Basic Channel and Phylyps Trak, 1993.",
      "a basic drum-and-bass groove",
      "built on a basic verse-chorus-verse structure",
      "a basic singer-songwriter arrangement",
      "a basic call-and-response hook",
      "a basic four-on-the-floor beat",
      "the standard bearer singer-songwriter",
      "the Basic Channel-affiliated label",
      "Basic Instructions, Basic Element12 and Basic Instinct2",
      "bearer 4u2c-the-world tour",
    ]) {
      expect(inClaim(text), text).toEqual([]);
      expect(excerpt(text), text).toEqual([]);
    }
  });

  it("reads a value split by zero-width characters or soft hyphens", () => {
    const zwsp = "​";
    const shy = "­";
    for (const [text, name] of [
      [`tvly-${chars(12)}${zwsp}${chars(12)}`, "a Tavily key"],
      [`ghp_${chars(18)}${shy}${chars(18)}`, "a GitHub token"],
      [`${HEX_32.slice(0, 16)}${zwsp}${HEX_32.slice(16)}`, "a hex key"],
    ] as const) {
      expect(inClaim(`key ${text} here`), name).toContain(`analysis.claims[0].text: ${name}`);
    }
    const configured = `0x4AAAAAAA${chars(25)}`;
    expect(
      judge(claim(`It was ${configured.slice(0, 15)}${zwsp}${configured.slice(15)}.`), [
        configured,
      ]),
    ).toContain("analysis.claims[0].text: a configured credential");
  });

  it("refuses 32 or more hex digits in free text, wherever the run starts", () => {
    for (const text of [
      `api ${HEX_32}`,
      `sum ${HEX_64}`,
      `0x${HEX_64}`,
      `0x${HEX_32}`,
      `apikey${HEX_32}`,
      `x\\n${HEX_32}`,
      `${HEX_32}g`,
      HEX_32.toUpperCase(),
    ]) {
      expect(inClaim(text), text).toEqual(["analysis.claims[0].text: a hex key"]);
    }
  });

  it("refuses a base64 value made of random bytes in free text and ids, and keeps breadcrumbs", () => {
    // As `openssl rand -base64 32` and `-base64 48` print them.
    for (const value of [
      "JwIEe7YA/GQ0oqeuJZJHWBU7vYJEHeAz3++doKpQxOE=",
      "TsY6PElmsmbs3x/A1FLvC/KFQfIzPpyG1uinpOvY5C8=",
      "Podhn+fqpAB5BMBVqZsvcWFtxOTFFvo7/pSXi3PZCTogE/tbd2hgZIc9iV9gdc5S",
      "EEuY6WF4mwQ0mR1FrLv8BQwetPR/TpyxvA/oXnvH1OEPTsTOd5r/8piiyqFJ1xt7",
    ]) {
      for (const [field, record] of [
        ["claim", claim(`The liner notes print ${value} under the credits.`)],
        ["verdictReason", { analysis: { claims: [{ text: "x", verdictReason: `see ${value}` }] } }],
        ["title", { evidence: [{ id: "musicbrainz:x", title: `Key ${value}` }] }],
        ["id", { evidence: [{ id: `genius:song/${value}` }] }],
      ] as const) {
        expect(judge(record), `${value} in ${field}`).toEqual(
          expect.arrayContaining([expect.stringMatching(/: a base64 value$/)]),
        );
      }
    }
    for (const text of [
      "Styles: Pop/Rock/Electronic/Instrumental/Soundtrack/2001",
      "Genres: Rock/AltRock/BritPop/PostPunk/NewWave/TripHop/1990s",
      "Home/TheVerve/UrbanHymns/BitterSweetSymphony/1997/Remastered2016",
      "Released on Hut/Virgin/EMI/Caroline/VUSCD82/VUSCX82/1997",
      "Home/Music/TheVerveUrbanHymns1997/Remastered2016Deluxe",
      "Discography/DaftPunk/Discovery2001OneMoreTime",
      "Music/Madonna/ConfessionsOnADanceFloor2005/HungUp",
      "Formats/CDSingle1997UK/12InchVinyl1997EU/Cassette",
      "Charts/UKSinglesChart1997/BillboardHot100/1998",
      "Samples/LastTime1965Rolling/StonesOrchestra1965Oldham",
    ]) {
      expect(inClaim(text), text).toEqual([]);
      expect(judge({ evidence: [{ id: text }] }), text).toEqual([]);
    }
  });
});

describe("heuristic shapes: only where a secret is plausible", () => {
  it("withholds a web search page's excerpt that holds a hex run, a base64 value or a random run, never refuses it for that", () => {
    for (const text of [
      `Track file checksum (MD5): 5d41402abc4b2a76b9719d911017c592`,
      `Track file checksum (MD5): ${"5d41402abc4b2a76b9719d911017c592".toUpperCase()}`,
      `Commit 3f786850e387550fdab836ed7e6dc881de23001b fixed the player.`,
      `cover ab67616d0000b2738e6551a2944708ab1f5a4bf3 loaded`,
      "Apple Music's editorial playlist pl.f4d106fed2bd41149aaacabb233eb5eb has it.",
      `Key: ${SHORT_PIECES}`,
      "Released on Hut/Virgin/EMI/Caroline/VirginRecordsAmerica/1997 in the UK.",
      "Genres: Rock/AltRock/BritPop/PostPunk/NewWave/TripHop/1990s and more.",
      `Shared as ${URL_KEY} on the forum.`,
    ]) {
      expect(excerpt(text), text).toEqual(["evidence[0].excerpt: withheld"]);
      const found = new PageExcerpts();
      const kept = withoutPageTokens(
        { evidence: [webItem("https://example.org/a", { excerpt: text })] },
        [],
        found,
      ) as { evidence: Array<{ excerpt: string }> };
      expect(kept.evidence[0].excerpt, text).toBe(WITHHELD_EXCERPT);
    }
  });

  it("refuses a page excerpt in a file that holds a token-shaped run the recorder would have withheld", () => {
    // As the loader reads a file: not through the recorder's withholding.
    for (const text of [`Key: ${SHORT_PIECES}`, `Shared as ${URL_KEY} on the forum.`]) {
      expect(
        leaks({ evidence: [webItem("https://example.org/a", { excerpt: text })] }, check),
        text,
      ).toEqual(["evidence[0].excerpt: a token-shaped run in a page excerpt"]);
    }
  });

  it("keeps slash lists, breadcrumbs and quoted titles in a claim or a source's own text", () => {
    for (const text of [
      "Styles: Pop/Rock/Electronic/Instrumental/Soundtrack/2001",
      "Released on Hut/Virgin/EMI/Caroline/VirginRecordsAmerica/1997",
      "Genres: Rock/AltRock/BritPop/PostPunk/NewWave/TripHop/1990s",
      "Home/DaftPunk/OneMoreTime/Discovery2001/",
      "Home/TheVerve/UrbanHymns/LuckyMan/OneDay/SonNet2/",
      "Music/TheVerve/UrbanHymns/01BitterSweet/02SonNet.mp3",
      'The single "Password": a 2009 club track.',
      'Tracklist: 1. "Intro": 1:02, 2. "Password": 3:41',
      `Short pieces in prose: ${SHORT_PIECES}`,
    ]) {
      expect(inClaim(text), text).toEqual([]);
      const record = webItem("https://www.discogs.com/release/1", {
        id: "discogs:release/1",
        source: "discogs",
        sourceTier: "primary-record",
        excerpt: text,
        recordRef: "release/1",
      });
      expect(judge({ evidence: [record] }), text).toEqual([]);
    }
  });

  it("refuses a hex run or a base64 value in a link's query", () => {
    expect(inClaim(`See https://www.last.fm/music/Daft+Punk?k=${HEX_32} now.`)).toEqual([
      "analysis.claims[0].text: a hex key in a link",
    ]);
    expect(asWebPage(`https://example.org/a?k=${encodeURIComponent(SHORT_PIECES)}`)).toContain(
      "evidence[0].url: a base64 value in a link",
    );
    // A share id, a click id, a search signature or a cache-buster in hex is not a key.
    for (const name of [
      "si",
      "msclkid",
      "search_sig",
      "v",
      "cb",
      "cachebust",
      "_",
      "hash",
      "etag",
      "rev",
      "version",
    ]) {
      expect(
        asWebPage(`https://soundcloud.com/x/y?in=a&${name}=${HEX_32}&utm_source=b`),
        name,
      ).toEqual([]);
    }
    // Only a hex value is let through under those names: a token there is still one.
    expect(asWebPage(`https://soundcloud.com/x/y?si=${TOKEN}`)).toContain(
      "evidence[0].url: a long token in a link",
    );
    for (const name of ["id", "k", "apisig", "si_key"]) {
      expect(asWebPage(`https://example.org/a?${name}=${HEX_32}`), name).toContain(
        "evidence[0].url: a hex key in a link",
      );
    }
    // A breadcrumb or a search with a few capitals inside words is not base64.
    for (const query of [
      "dir=Music/DaftPunk/Discovery/OneMoreTime/2001/Live",
      "q=Bitter+Sweet+Symphony+TheVerve+UrbanHymns+1997+Remastered",
    ]) {
      expect(asWebPage(`https://example.org/a?${query}`), query).toEqual([]);
    }
  });

  it("refuses a random run in a link's fragment, lower-case, a UUID or base64, and keeps section anchors", () => {
    for (const fragment of [
      "7h5n1yd0-eyq67rlg17_ly3lrwqc_4aq06tp_-lqo6k",
      MBID,
      "6ba7b810-9dad-1111-80b4-00c04fd430c8",
      "GonPdnH6Po2QwQCN/FuUOTFOcNWuq812wPrdFbSoGq==",
      `pl.${HEX_32}`,
      "Ab3dEf6hIj9lMn2pQr5t-Uv8xYz1bCd4fGh7K0mNq_RsTu",
    ]) {
      const link = `https://music.apple.com/us/playlist/x#${fragment}`;
      expect(inClaim(`See ${link} now.`), fragment).toEqual(
        expect.arrayContaining([expect.stringMatching(/: a (?:token|base64 value) in a link/)]),
      );
    }
    for (const anchor of [
      "Track_listing_and_formats_1997_UK_CD_single",
      "Charts_of_the_1960s_1970s_1980s_and_1990s",
      "UK_1960s_1970s_1980s_1990s_2000s_singles",
      "1960s_1970s_1980s_1990s_2000s_and_2010s",
    ]) {
      expect(inClaim(`See https://en.wikipedia.org/wiki/Disco#${anchor} now.`), anchor).toEqual([]);
    }
  });

  it("keeps a hex id in a link's path or an id, and refuses a random mixed-case run there", () => {
    for (const url of [
      "https://apnews.com/article/music-lawsuits-sampling-0d3f1e2c9b8a7d6e5f4a3b2c1d0e9f8a",
      "https://someone.notion.site/The-Verve-Discography-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6",
      `https://example.org/files/${HEX_32}/cover.html`,
      `https://www.last.fm/music/The+Verve/+images/${HEX_32}`,
      "https://itunes.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
      "https://embed.music.apple.com/us/playlist/hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
      "https://geo.music.apple.com/us/playlist/hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
      "https://music.apple.com/us/playlist/barry-white-sampled/pl.c93e6eaec52f47c189d19c2d88efdca5",
    ]) {
      expect(asWebPage(url), url).toEqual([]);
    }
    expect(judge({ evidence: [{ id: `genius:song/${HEX_32}` }] })).toEqual([]);
    // More than 32 hex digits alone is a key or a digest, not a page's name.
    for (const url of [
      `https://example.org/md5/${HEX_64}`,
      `https://genius.com/${HEX_64}`,
      `https://genius.com/Daft-punk-one-more-time-lyrics/${HEX_64.toUpperCase()}`,
      "https://www.semanticscholar.org/paper/3f786850e387550fdab836ed7e6dc881de23001b",
    ]) {
      expect(asWebPage(url), url).toContain("evidence[0].url: a token in a link's path");
    }
    expect(judge({ evidence: [{ id: "x", recordRef: `track/${HEX_64}` }] })).toEqual([
      "evidence[0].recordRef: a token in an id",
    ]);
    for (const value of [TOKEN, URL_KEY]) {
      expect(judge({ evidence: [{ id: `genius:song/${value}` }] }), value).toContain(
        "evidence[0].id: a token in an id",
      );
      expect(asWebPage(`https://songs.example.com/file/${value}/view`), value).toContain(
        "evidence[0].url: a token in a link's path",
      );
    }
    // Lower-case and digits glued to a file name, and a split key after a run of short pieces.
    for (const segment of [
      "report-k3m9x2p7q4w8z1v6n5b0c3r7t2y9u4h8.pdf",
      `${"ab-".repeat(30)}Ab3dEf6hIj9lMn2p-Qr5tUv8xYz1bCd4`,
    ]) {
      expect(asWebPage(`https://songs.example.com/file/${segment}`), segment).toContain(
        "evidence[0].url: a token in a link's path",
      );
    }
  });

  it('refuses a token glued to an allow-listed link\'s path by ",", ".", "-", "_" or ":"', () => {
    const longSlug =
      "Daft-punk-one-more-time-lyrics-and-credits-from-the-discovery-album-remastered";
    for (const slug of ["Daft-punk-one-more-time-lyrics", longSlug]) {
      for (const glue of [",", ".", "-", "_", ":"]) {
        for (const token of [TOKEN, URL_KEY]) {
          expect(
            inClaim(`See https://genius.com/${slug}${glue}${token} now.`),
            `${glue}${token}`,
          ).toEqual(["analysis.claims[0].text: a token in a link's path"]);
        }
      }
    }
    expect(inClaim(`See https://genius.com/${longSlug}-${URL_KEY}-${longSlug} now.`)).toEqual([
      "analysis.claims[0].text: a token in a link's path",
    ]);
  });

  it("keeps ids glued to slugs, short base62 ids and slugs of names, words and decades in a path or an id", () => {
    for (const url of [
      "https://chordu.com/chords-tabs-the-verve-bitter-sweet-symphony--id_Xk3-9_pLm2Q",
      "https://www.youtube.com/watch/Xk3-9_pLm2Q",
      "https://example-bpm.com/song/The-Verve-57iDDD9N9tTWe75x6qhStw",
      "https://www.discogs.com/release/123-2Pac-K-Ci-JoJo-B2K-UB40-U2-R2D2-B4U",
      "https://en.wikipedia.org/wiki/UK_1960s_1970s_1980s_1990s_2000s_singles",
      `https://musicbrainz.org/recording/${MBID}`,
      "https://www.whosampled.com/sample/123/2Pac-feat-Dr-Dre-California-Love-1995-Remix-1972",
    ]) {
      expect(asWebPage(url), url).toEqual([]);
    }
    for (const id of [
      "wikipedia:track/UK_1960s_1970s_1980s_1990s_2000s",
      "wikipedia:track/List_of_UK_Singles_Chart_number_ones_of_the_2000s",
      `mb-${MBID}`,
      `track/recording/${MBID}/sampled-by/recording/${OTHER_MBID}`,
    ]) {
      expect(judge({ evidence: [{ id, recordRef: id }] }), id).toEqual([]);
    }
  });

  it("keeps public ids, chord lines, musical keys, catalogue numbers, dates and anchors", () => {
    const record = {
      analysis: {
        claims: [
          {
            text: `Recording ${MBID} samples ${OTHER_MBID} (Spotify 0DiWol3AO6WpXZgp0goxAV, YouTube dQw4w9WgXcQ, ISRC GBDUW0000059).`,
            evidenceIds: [`musicbrainz:recording/${MBID}`],
          },
        ],
        evidence: [
          webItem(`https://musicbrainz.org/recording/${MBID}`, {
            id: `musicbrainz:recording/${MBID}`,
            source: "musicbrainz",
            sourceTier: "primary-record",
            recordRef: `track/recording/${MBID}/sampled-by/recording/${OTHER_MBID}`,
          }),
          webItem("https://www.discogs.com/release/1234567-Daft-Punk-One-More-Time", {
            id: "discogs:release/1234567/credit/0",
            source: "discogs",
            sourceTier: "primary-record",
            recordRef: "track/release/1234567/credit/0",
          }),
          webItem("https://genius.com/Daft-punk-one-more-time-lyrics", {
            id: "genius:work/song/50429/sampled-by/9264277",
            source: "genius",
            sourceTier: "primary-record",
            recordRef: "work/song/50429/sampled-by/9264277",
          }),
          webItem("https://www.youtube.com/watch?v=dQw4w9WgXcQ&xstg=CAMSBhUD-7L2Hw%3D%3D"),
          webItem("https://www.youtube.com/channel/UCv6ZDCi-PzyqqdmcS5KS3cA/videos"),
          webItem("https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV?si=1a2b3c4d5e6f7a8b"),
        ],
      },
    };
    expect(judge(record)).toEqual([]);
    for (const text of [
      "Intro: Am/G/Fmaj7/C/Am/G/Fmaj7/C/Dm7/G7/Em7/Am7/Dm7/G7, then the verse.",
      "Bridge: Fmaj7/Am7/Dm7/G7/Cmaj7/Em7/Bm7b5/E7/Am7/D7/G7/C7 twice.",
      "Search: Bitter+Sweet+Symphony+Remastered+2016+The+Verve lyrics and chords",
      "Transpose with ?key=G to play it in G. Settings: capo=2&Key=A minor",
      "See https://www.whosampled.com/sample/123/?key=Am now.",
      "See https://www.whosampled.com/sample/123/?key=C%23m&capo=2 now.",
      "See https://www.whosampled.com/sample/123/?key=A%20minor now.",
      "See https://www.whosampled.com/sample/123/?key=8A-A-minor now.",
      "See https://www.whosampled.com/sample/123/?key=The-Verve-Bitter-Sweet now.",
      "See https://www.whosampled.com/sample/123/?key=the-verve-bitter-sweet-symphony-1997 now.",
      "See https://www.whosampled.com/sample/123/?key=2019-05-23T12:00 now.",
      "See https://www.whosampled.com/sample/123/?key=2019-05-23T123000Z now.",
      "See https://www.whosampled.com/sample/123/?key=VUSCD82-UK1997 now.",
      "See https://www.whosampled.com/sample/123/?key=TheVerve1997 now.",
      "See https://genius.com/Daft-punk-one-more-time-lyrics#key=Am now.",
      "See https://genius.com/Daft-punk-one-more-time-lyrics, then the credits.",
      "See https://www.last.fm/music/Basic+Channel/_/Phylyps+Trak now.",
      "See https://en.wikipedia.org/wiki/2Pac_discography_1991-1996_and_1997-2004_singles now.",
      "See https://www.discogs.com/master/12345-Daft-Punk-Discovery now.",
      "Top 40 Hits of the 1980s in MP3 and 4K Video, 1080p at 60fps; the passing bassline.",
    ]) {
      expect(inClaim(text), text).toEqual([]);
    }
  });

  it("keeps the recording's own commit, short, full or dirty, and its analyzer version; another hex key is refused", () => {
    const record = structuredClone(readRecording());
    const full = "98e88946b9b5c3d2e1f0a9b8c7d6e5f4a3b2c1d0";
    const options = {
      ...check,
      publicTexts: publicTextsOf(record.analysis),
      track: record.analysis,
      allowedCover: archiveCoverOf(record.analysis),
    };
    expect(record.analyzerVersion).toMatch(/^\d+\.\d+\.\d+\+essentia\.models-[0-9a-f]{8}$/);
    for (const own of [full, `${full}-dirty`, full.slice(0, 12), `${full.slice(0, 12)}-dirty`]) {
      record.commit = own;
      record.analysis.run!.commit = own;
      record.analysis.claims![0].text = `Recorded at ${full}, from ${own}.`;
      expect(recordIssues(record, options), own).toEqual([]);
      const other = structuredClone(record);
      other.analysis.run!.commit = full.replace(/^98/, "99");
      expect(recordIssues(other, options), own).toEqual(["analysis.run.commit: a hex key"]);
    }
  });
});

describe("the committed recordings, scanned with these rules", () => {
  it("hold no secret shape: the recorder's checks refuse none, and the loader takes every one", () => {
    const records = [
      ...recordingSlugs().map((slug) => [`replays/${slug}`, readRecording(slug)] as const),
      ...recordingSlugs(PINNED_DIR).map(
        (slug) => [`pinned/${slug}`, readRecording(slug, PINNED_DIR)] as const,
      ),
    ];
    expect(records.length).toBe(5);
    for (const [name, record] of records) {
      expect(ReplayRecord.safeParse(record).success, name).toBe(true);
      const issues = recordIssues(record, {
        ...check,
        publicTexts: publicTextsOf(record.analysis),
        track: record.analysis,
        allowedCover: archiveCoverOf(record.analysis),
      });
      expect(issues, name).toEqual([]);
    }
    for (const dir of [DEFAULT_REPLAY_DIR, PINNED_DIR]) {
      const set = loadReplays(dir);
      expect(set.problems, dir).toEqual([]);
      expect(set.records.length, dir).toBe(recordingSlugs(dir).length);
    }
  });

  it("are checked in time linear in their size, a 40,000-character link included", () => {
    const juicy = readFileSync(join(DEFAULT_REPLAY_DIR, "juicy-the-notorious-big.json"), "utf8");
    for (const unit of ["x_", "a-", "aB-", "0123456789abcdef"]) {
      const record = ReplayRecord.parse(JSON.parse(juicy));
      const url = `https://www.example-lyrics.com/${unit.repeat(Math.ceil(40000 / unit.length)).slice(0, 40000)}`;
      const item = webItem(url) as never;
      record.analysis.evidence!.push(item);
      const done = record.events.find((e) => e.event.type === "complete")!.event as {
        data: { evidence: unknown[] };
      };
      done.data.evidence.push(item);
      const started = performance.now();
      recordIssues(record, {
        ...check,
        publicTexts: publicTextsOf(record.analysis),
        track: record.analysis,
        allowedCover: archiveCoverOf(record.analysis),
      });
      // Main took 14 to 27 s here; the checks take well under one.
      expect(performance.now() - started, unit).toBeLessThan(5000);
    }
  });

  it("decode a text dense in escapes that are not UTF-8 in linear time", () => {
    for (const unit of ["%E3%", "%zz", "%FF%41"]) {
      const text = unit.repeat(Math.ceil(200000 / unit.length)).slice(0, 200000);
      for (const record of [
        claim(text),
        { evidence: [{ id: text }] },
        claim(`https://genius.com/x?q=${text}`),
      ]) {
        const started = performance.now();
        leaks(record, check);
        expect(performance.now() - started, unit).toBeLessThan(1000);
      }
    }
  });
});

describe("texts that pages and records carry, scanned with these rules", () => {
  /** Links, ids and prose seen in search results and source records, and where each is held. */
  const kept: Array<{ value: string; places: string[] }> = JSON.parse(
    readFileSync(join(import.meta.dirname, "testing", "keptTexts.json"), "utf8"),
  );

  it("are kept wherever they are held", () => {
    expect(kept.length).toBeGreaterThan(200);
    const base = { commit: "0fdfdccc509c" };
    for (const { value, places } of kept) {
      for (const place of places) {
        const analysis =
          place === "text"
            ? { claims: [{ text: value }] }
            : place === "id"
              ? { evidence: [{ id: value, source: "x", sourceTier: "primary-record" }] }
              : place === "page"
                ? { evidence: [webItem(value)] }
                : place === "excerpt"
                  ? { evidence: [webItem("https://en.wikipedia.org/wiki/X", { excerpt: value })] }
                  : {
                      evidence: [
                        {
                          id: "musicbrainz:x",
                          source: "musicbrainz",
                          sourceTier: "primary-record",
                          url: "https://musicbrainz.org/recording/x",
                          excerpt: value,
                        },
                      ],
                    };
        const found = new PageExcerpts();
        const record = withoutPageTokens({ ...base, analysis }, [], found);
        expect([...found.refused, ...leaks(record, check)], `${value} (${place})`).toEqual([]);
      }
    }
  });
});

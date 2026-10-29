/**
 * Secret shapes a recording must not hold (recorder.ts `leaks`, `linkSecret`), and the public
 * values that only look like them: what the recorder refuses, and what it must keep taking. The
 * committed recordings are scanned with the same rules, and none is refused.
 */

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

/** A random run of 44 letters and digits, as a long token is. */
const TOKEN = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7K0mNqRsTu";
/** A base64url key of 34 with "-" and "_", too short for the long-token rule. */
const URL_KEY = "Ab3dEf6hIj-9lMn2pQr5tUv_8xYz1bCd4f";
/** A key made as `openssl rand -base64 48` makes one, with every piece between "+" and "/" short. */
const SHORT_PIECES = "Kq7Rt/Xm2Kp9w+Zb4NcH8/vL3sJd6+Fy1Tg5Ae/Wu0OkPzQ+hY6rB3n/Ec9Gm2VxLs+T4w";
const HEX_32 = "5f4dcc3b5aa765d61d8327deb882cf99";
const HEX_64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const AWS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const MBID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const OTHER_MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";

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

/** What `leaks` finds in a record whose one claim says `text`. */
const inClaim = (text: string) => leaks({ analysis: { claims: [{ text }] } }, check);

describe("secret shapes the recorder refuses", () => {
  it("refuses a token in an id or recordRef field, as in a link's path", () => {
    const found = leaks(
      {
        evidence: [
          webItem("https://www.discogs.com/release/1", {
            id: `discogs:release/${TOKEN}`,
            source: "discogs",
            sourceTier: "primary-record",
            recordRef: `release/${TOKEN}`,
          }),
        ],
      },
      check,
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "evidence[0].id: a token in an id",
        "evidence[0].recordRef: a token in an id",
      ]),
    );
    expect(found.join(" ")).not.toContain(TOKEN);
    // A base64url key with "-" and "_", and a hex key, in an id.
    for (const key of [URL_KEY, HEX_32]) {
      expect(leaks({ evidence: [{ id: `genius:song/${key}` }] }, check), key).toContain(
        "evidence[0].id: a token in an id",
      );
    }
  });

  it("refuses a base64 value whose pieces are all short, and withholds a page excerpt that holds one", () => {
    expect(SHORT_PIECES.length).toBeGreaterThanOrEqual(40);
    for (const piece of SHORT_PIECES.split(/[+/]/)) expect(piece.length).toBeLessThan(12);
    expect(inClaim(`The key is ${SHORT_PIECES} here.`)).toEqual([
      "analysis.claims[0].text: a base64 value",
    ]);
    const found = new PageExcerpts();
    const kept = withoutPageTokens(
      { evidence: [webItem("https://example.org/a", { excerpt: `Key: ${SHORT_PIECES}` })] },
      [],
      found,
    ) as { evidence: Array<{ excerpt: string }> };
    expect(kept.evidence[0].excerpt).toBe(WITHHELD_EXCERPT);
    expect(found.list()).toEqual([{ evidenceId: "tavily:https://example.org/a", runs: 1 }]);
  });

  it("refuses a hex key, lower or upper case, in text, in a link's query and in its path", () => {
    for (const text of [
      `api ${HEX_32}`,
      `sum ${HEX_64}`,
      `KEY_${HEX_32.toUpperCase()}`,
      `See https://www.last.fm/music/Daft+Punk?k=${HEX_32} now.`,
    ]) {
      expect(inClaim(text), text).toEqual([
        `analysis.claims[0].text: a hex key${text.includes("http") ? " in a link" : ""}`,
      ]);
    }
    expect(inClaim(`See https://www.last.fm/music/Daft+Punk/file.${HEX_32} now.`)).toEqual([
      "analysis.claims[0].text: a token in a link's path",
    ]);
  });

  it("refuses an AWS access key id", () => {
    expect(inClaim(`aws ${AWS_KEY_ID} us-east-1`)).toEqual([
      "analysis.claims[0].text: an AWS access key id",
    ]);
  });

  it("refuses a password, secret, OAuth or cloud-signature parameter in an allow-listed link", () => {
    const cases: Array<[string, string]> = [
      ["password=hunter2hunter2", "a password or secret parameter in a link"],
      ["secret=Zx9Qw3Er7Ty1", "a password or secret parameter in a link"],
      ["oauth_token=Zx9Qw3Er7Ty1", "a signed URL"],
      ["oauth_signature=wOJIO9A2W5mFwDgiDvZbTSMK%2FPY%3D", "a signed URL"],
      ["X-Goog-Signature=0a1b2c3d4e5f", "a signed URL"],
      ["X-Amz-Credential=example%2F20261029%2Fus-east-1", "a signed URL"],
    ];
    for (const [param, reason] of cases) {
      const text = `See https://www.discogs.com/release/1-One-More-Time?q=a&${param} now.`;
      expect(inClaim(text), param).toContain(`analysis.claims[0].text: ${reason}`);
    }
  });

  it("refuses a key parameter in a link's fragment", () => {
    for (const fragment of ["key=Zx9Qw3Er7Ty1Ui5Op2", "access_token=Zx9Qw3Er7Ty1"]) {
      const text = `See https://genius.com/Daft-punk-one-more-time-lyrics#${fragment} now.`;
      expect(inClaim(text), fragment).toContain("analysis.claims[0].text: a signed URL");
    }
  });

  it("refuses a key parameter that is short, dotted or has an encoded + early in it", () => {
    for (const value of ["Zx9Qw3Er7Ty1", "Zx9.Qw3Er7Ty1Ui5Op2As8", "Zx9%2BQw3Er7Ty1Ui5Op2As8"]) {
      const text = `See https://www.whosampled.com/sample/123/?key=${value} now.`;
      expect(inClaim(text), value).toContain("analysis.claims[0].text: a signed URL");
    }
  });

  it('refuses a token glued to the end of an allow-listed link\'s path by ",", ".", "-", "_" or ":"', () => {
    // A long slug too, by which a key with "-" and "_" glued on with "-" or "_" is no longer
    // random-looking as a whole: the key's own stretch is judged.
    const longSlug =
      "Daft-punk-one-more-time-lyrics-and-credits-from-the-discovery-album-remastered";
    for (const slug of ["Daft-punk-one-more-time-lyrics", longSlug]) {
      for (const glue of [",", ".", "-", "_", ":"]) {
        for (const token of [TOKEN, URL_KEY, HEX_32]) {
          const text = `See https://genius.com/${slug}${glue}${token} now.`;
          expect(inClaim(text), `${slug}${glue}${token}`).toEqual([
            "analysis.claims[0].text: a token in a link's path",
          ]);
        }
      }
    }
    // The same slug before and after the key.
    expect(inClaim(`See https://genius.com/${longSlug}-${URL_KEY}-${longSlug} now.`)).toEqual([
      "analysis.claims[0].text: a token in a link's path",
    ]);
  });

  it('refuses a web page whose path holds a base64url key with "-" or "_"', () => {
    const url = `https://songs.example.com/file/${URL_KEY}/view`;
    const found = leaks({ evidence: [webItem(url)] }, check);
    expect(found).toEqual(
      expect.arrayContaining([
        "evidence[0].url: a token in a link's path",
        "evidence[0].id: a token in a link's path",
      ]),
    );
  });

  it('refuses a JSON "password" field in any text, a page excerpt with no run too', () => {
    expect(inClaim('Sent {"password": "opensesame1"} to the API.')).toEqual([
      "analysis.claims[0].text: a password field",
    ]);
    const page = webItem("https://example.org/login", { excerpt: `Login: {'password':'abc'}` });
    expect(leaks({ evidence: [page] }, check)).toEqual(["evidence[0].excerpt: a password field"]);
  });
});

describe("public values that only look like secrets", () => {
  it("keeps MusicBrainz, Spotify, YouTube, Discogs, Genius and Apple Music ids and pages", () => {
    const record = {
      analysis: {
        claims: [
          {
            text: `Recording ${MBID} samples ${OTHER_MBID} (Spotify 0DiWol3AO6WpXZgp0goxAV, YouTube dQw4w9WgXcQ).`,
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
          // A slug of words with a year as an id: a page's name, not a token.
          webItem(
            "https://en.wikipedia.org/wiki/List_of_UK_Singles_Chart_number_ones_of_the_2000s",
            {
              id: "wikipedia:track/List_of_UK_Singles_Chart_number_ones_of_the_2000s",
              sourceTier: "editorial",
            },
          ),
          webItem("https://genius.com/Daft-punk-one-more-time-lyrics", {
            id: "genius:work/song/50429/sampled-by/9264277",
            source: "genius",
            sourceTier: "primary-record",
            recordRef: "work/song/50429/sampled-by/9264277",
          }),
          webItem("https://www.youtube.com/watch?v=dQw4w9WgXcQ&xstg=CAMSBhUD-7L2Hw%3D%3D"),
          webItem("https://www.youtube.com/channel/UCv6ZDCi-PzyqqdmcS5KS3cA/videos"),
          // Apple Music's editorial playlist id: "pl." and 32 hex digits, a public page.
          webItem(
            "https://music.apple.com/us/playlist/barry-white-sampled/pl.c93e6eaec52f47c189d19c2d88efdca5",
          ),
          webItem("https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV"),
        ],
      },
    };
    expect(leaks(record, check)).toEqual([]);
    // The same hex digits on another site, or not as Apple Music's own id, are a key.
    for (const url of [
      "https://example.org/us/playlist/barry-white-sampled/pl.c93e6eaec52f47c189d19c2d88efdca5",
      "https://music.apple.com/us/playlist/barry-white-sampled/c93e6eaec52f47c189d19c2d88efdca5",
      "https://music.apple.com/us/playlist/x/pl.c93e6eaec52f47c189d19c2d88efdca5-Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd",
    ]) {
      expect(leaks({ evidence: [webItem(url)] }, check), url).toContain(
        "evidence[0].url: a token in a link's path",
      );
    }
  });

  it("keeps the recording's own commit, whole or dirty, and its analyzer version; another hex key is refused", () => {
    const record = structuredClone(readRecording());
    const commit = "98e88946b9b5c3d2e1f0a9b8c7d6e5f4a3b2c1d0";
    for (const own of [commit, `${commit}-dirty`]) {
      record.commit = own;
      record.analysis.run!.commit = own;
      const options = {
        ...check,
        publicTexts: publicTextsOf(record.analysis),
        track: record.analysis,
        allowedCover: archiveCoverOf(record.analysis),
      };
      expect(record.analyzerVersion).toMatch(/^\d+\.\d+\.\d+\+essentia\.models-[0-9a-f]{8}$/);
      expect(recordIssues(record, options), own).toEqual([]);
      const other = structuredClone(record);
      other.analysis.run!.commit = commit.replace(/^98/, "99");
      expect(recordIssues(other, options), own).toEqual(["analysis.run.commit: a hex key"]);
    }
  });

  it("keeps chord lines, musical keys, word slugs and section anchors", () => {
    for (const text of [
      "Intro: Am/G/Fmaj7/C/Am/G/Fmaj7/C/Dm7/G7/Em7/Am7/Dm7/G7, then the verse.",
      "Bridge: Fmaj7/Am7/Dm7/G7/Cmaj7/Em7/Bm7b5/E7/Am7/D7/G7/C7 twice.",
      "Search: Bitter+Sweet+Symphony+Remastered+2016+The+Verve lyrics and chords",
      "Home/Music/Daft/Punk/Discovery/2001/One/More/Time/Lyrics and chords",
      "Home/DaftPunk/OneMoreTime/Lyrics2001/Chords",
      "Transpose with ?key=G to play it in G. Settings: capo=2&Key=A minor",
      "See https://www.whosampled.com/sample/123/?key=Am now.",
      "See https://www.whosampled.com/sample/123/?key=C%23m&capo=2 now.",
      "See https://www.whosampled.com/sample/123/?key=A%20minor now.",
      "See https://www.whosampled.com/sample/123/?key=8A now.",
      "See https://www.whosampled.com/sample/123/?key=The-Verve-Bitter-Sweet now.",
      "See https://www.whosampled.com/sample/123/?key=the-verve-bitter-sweet-symphony-1997 now.",
      "See https://genius.com/Daft-punk-one-more-time-lyrics#key=Am now.",
      "See https://genius.com/Daft-punk-one-more-time-lyrics, then the credits.",
      "See https://genius.com/Daft-punk-one-more-time-lyrics: the credits.",
      "See https://www.last.fm/music/Basic+Channel/_/Phylyps+Trak now.",
      "See https://en.wikipedia.org/wiki/Bitter_Sweet_Symphony#Track_listing_and_formats_1997_UK_CD_single now.",
      "See https://en.wikipedia.org/wiki/Billboard_charts#Charts_of_the_1960s_1970s_1980s_and_1990s now.",
      "See https://en.wikipedia.org/wiki/Disco#1960s_1970s_1980s_1990s_2000s_and_2010s now.",
      "See https://en.wikipedia.org/wiki/2Pac_discography_1991-1996_and_1997-2004_singles now.",
      "See https://en.wikipedia.org/wiki/List_of_Billboard_Hot_100_number_ones_of_1990 now.",
      "See https://www.discogs.com/master/12345-Daft-Punk-Discovery now.",
      "See https://www.discogs.com/release/1234567-Daft-Punk-One-More-Time-Remastered-2001 now.",
      "Top 40 Hits of the 1980s in MP3 and 4K Video, 1080p at 60fps.",
    ]) {
      expect(inClaim(text), text).toEqual([]);
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
});

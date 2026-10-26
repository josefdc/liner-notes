/**
 * What the web tier keeps of a page: never a social platform page, a comment thread or profile
 * boilerplate, and never a private person's @handle in the text it stores. The same check runs
 * on the stored text when an item is written and wherever it is read back (the research cache,
 * stored results, the recorder), so anything the web tier writes is also read back.
 */

import { InMemoryStore } from "@langchain/langgraph";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Set before the search module loads, so a local .env does not supply a real key.
  process.env.TAVILY_API_KEY = "tvly-test-key";
});

import { leaks } from "../../replay/recorder.js";
import { searchSamples } from "../../sources/search.js";
import { json, stubFetch } from "../../sources/testing/fetchStub.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { readStoredResult } from "../storedResults.js";
import { restoredEvidence, type SourcedEvidence, webSearchEvidence } from "./evidencePack.js";

const AT = "2026-10-20T12:00:00.000Z";
const TRACK = { title: "One More Time", artist: "Daft Punk" };

const web = (url: string, content: string, title = "A page about the track") => ({
  result: { url, content, title },
  retrievedAt: AT,
  track: TRACK,
});

/** The research cache's check of a stored pack, for what this run read. */
const restores = (items: readonly SourcedEvidence[]) =>
  restoredEvidence(JSON.parse(JSON.stringify(items)), {
    readAt: AT,
    recordingMbid: null,
    trackIsOriginal: false,
    configured: { discogs: false, genius: false },
    track: TRACK,
  }) !== null;

const { run: _run, ...analysis } = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../../../../packages/contract/fixtures/api-payloads/composed-measured.json",
    ),
    "utf8",
  ),
);

/** Whether a stored result holding `items` as its evidence is served again. */
async function served(items: readonly SourcedEvidence[]): Promise<boolean> {
  const store = new InMemoryStore();
  const id = "0StoredTrack0000000001";
  await store.put(TRACKS_NAMESPACE, resultCacheKey(id, configuredSources()), {
    trackData: { ...analysis, id, evidence: JSON.parse(JSON.stringify(items)) },
    timestamp: Date.now(),
  });
  return (await readStoredResult(store, id, new Date())) !== null;
}

/** What the recorder refuses in a record holding `items` as its evidence. */
const recorderRefuses = (items: readonly SourcedEvidence[]) =>
  leaks({ analysis: { evidence: items } }, { secrets: [], typedQuery: "", publicTexts: [] });

/** A small seeded generator, so the cases are the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROSE = [
  "One More Time was released in November 2000 on Virgin.",
  "Thomas Bangalter produced it with Romanthony on vocals.",
  "The sample comes from More Spell on You by Eddie Johns.",
  "Daft Punk · Official channel",
  "wow",
  "Following the success of Homework, Daft Punk spent the late '90s making Discovery.",
  "Like its predecessor, the album drew on '70s disco and '80s funk.",
  "Walk Like an Egyptian topped the chart for 4 weeks.",
  "A1: One More Time A2: Aerodynamic",
  "R.E.M.: Losing My Religion, live.",
];
/** Pieces of handles, profile boilerplate and comment threads. */
const RISKY = [
  (n: number) => `@fan_${n}x`,
  (n: number) => `@josé.m${n}`,
  (n: number) => `(@band_${n})`,
  (n: number) => `@john-smith-${n}`,
  (n: number) => `聴いてる@fan_${n}`,
  (n: number) => `RT@fan_${n}:`,
  (n: number) => `user_${n}'s profile picture`,
  (n: number) => `${(n % 5) + 1}w`,
  () => "Reply",
  () => "Like",
  (n: number) => `jane_doe${n}: love it!`,
];

const URLS = [
  "https://www.example.org/news/one-more-time",
  "https://www.youtube.com/watch?v=FGBhQbmPwH8",
  "https://m.facebook.com/somepage/posts/1",
  "https://old.reddit.com/r/music/comments/abc/",
  "https://www.threads.com/@someone/post/1",
];

/** Two shapes that once passed one check and failed the other: kept when written, refused when read back. */
const COUNTEREXAMPLES = [
  `${Array.from({ length: 18 }, (_, i) => `@fan_${i}x wow`).join(" ")} ${"One More Time was released in 2000 on Virgin. ".repeat(12)}`.slice(
    0,
    800,
  ),
  Array.from({ length: 175 }, (_, i) => (i % 7 === 3 ? `@listener_${i}` : "music")).join(" "),
];

describe("anything the web tier writes is read back", () => {
  it("passes the research cache, stored results and the recorder, for generated pages", async () => {
    const next = random(130_132);
    const findings = COUNTEREXAMPLES.map((text, i) => web(`https://example.org/c/${i}`, text));
    for (let i = 0; i < 300; i++) {
      // Each page has its own share of risky pieces, so the cases fall on both sides of the rules.
      const risk = next() * 0.3;
      const words: string[] = [];
      const count = 1 + Math.floor(next() * 120);
      for (let w = 0; w < count; w++) {
        const n = Math.floor(next() * 1000);
        words.push(
          next() < risk
            ? RISKY[Math.floor(next() * RISKY.length)](n)
            : PROSE[Math.floor(next() * PROSE.length)],
        );
      }
      const url = `${URLS[Math.floor(next() * URLS.length)]}${i}`;
      const title = next() < 0.3 ? `@fan_${i} on One More Time` : `One More Time, page ${i}`;
      findings.push(web(url, words.join(" ").slice(0, 900), title));
    }

    const items = webSearchEvidence(findings);

    // Enough kept, and enough with a masked handle, for the check to say something.
    expect(items.length).toBeGreaterThan(50);
    expect(items.filter((item) => item.excerpt.includes("@…")).length).toBeGreaterThan(10);
    for (const item of items) {
      expect(restores([item]), item.excerpt).toBe(true);
      expect(await served([item]), item.excerpt).toBe(true);
      expect(recorderRefuses([item]), item.excerpt).toEqual([]);
      expect(`${item.title} ${item.excerpt}`).not.toMatch(/@[\p{L}\p{N}_]/u);
    }
  });
});

describe("the text of a web page", () => {
  it("masks every @handle in the excerpt and the title, and keeps e-mail-like text as it is", () => {
    const [item] = webSearchEvidence([
      web(
        "https://www.example.org/news/one-more-time",
        "Thomas Bangalter (@thomasbangalter) and @josé.m produced it; write to press@virgin.example.",
        "Interview with @thomasbangalter",
      ),
    ]);

    expect(item.excerpt).toBe(
      "Thomas Bangalter (@…) and @… produced it; write to press@virgin.example.",
    );
    expect(item.title).toBe("Interview with @…");
  });

  it("leaves out a comment thread: Reply and Like with relative times, or name: comment lines", () => {
    const items = webSearchEvidence([
      web(
        "https://www.example.org/post/1",
        "daftpunk • Follow One More Time turns 25 jane.doe12 3w Love this! Reply john_smith 2w Classic Reply",
      ),
      web(
        "https://www.example.org/post/2",
        "Comments jane_doe: love it! john.smith87: same here! mark99: still a banger",
      ),
      web(
        "https://www.example.org/post/3",
        "dj_someone's profile picture Love this track! The drop at 1:20 is the best part.",
      ),
      web(
        "https://www.example.org/post/4",
        "@first_user @second.user @third_user @fourth_user wow",
      ),
      web(
        "https://www.example.org/news/one-more-time",
        "One More Time was released in 2000. Producer: Thomas Bangalter. Label: Virgin.",
      ),
    ]);

    expect(items.map((item) => item.url)).toEqual(["https://www.example.org/news/one-more-time"]);
  });

  it("leaves out a forum comment thread by its byline, on any site, and keeps prose like it", () => {
    const threads = [
      "some_user on Feb 22, 2021 | parent | next (javascript:void(0)) Love it! One More Time is still the best house record.",
      "some_user 3 hours ago | parent | next [–] The sample is More Spell on You by Eddie Johns.",
      "Discovery came out in 2001. some_user 1 day ago | prev | next [–] Still a classic.",
      "some_user 2 years ago | root | parent | next [–] Romanthony sang it.",
      "someone on Sep 3, 2010 | next [–] Daft Punk recorded it in Paris.",
    ];
    const prose = [
      "Hacker News readers discussed Daft Punk's One More Time when the duo split in 2021.",
      "Daft Punk | Discovery | 2001 | Virgin Records",
      "One More Time, a review by Jane Smith on Feb 22, 2021. The single opened Discovery.",
      "Posted 3 hours ago | Music | News. Daft Punk's One More Time turns 25.",
    ];
    const items = webSearchEvidence([
      ...threads.map((text, i) => web(`https://www.example.org/thread/${i}`, text)),
      ...prose.map((text, i) => web(`https://www.example.org/page/${i}`, text)),
    ]);

    expect(items.map((item) => item.excerpt)).toEqual(prose);
  });

  it.each([
    "Posted on Feb 22, 2021 | next article: Daft Punk split",
    "Released on Mar 13, 2001 | root note is D minor",
    "Updated 3 days ago | next page of the discography",
    "Added 5 days ago | prev album: Homework",
    "Reissued on Nov 3, 2023 | parent label Virgin Records",
    "Live at Wembley on Jun 6, 2007 | next date: Paris",
    "Uploaded 2 years ago | next track: Aerodynamic",
    "Released 10 years ago | parent album Discovery",
    "Recorded 1 year ago | root of the sample chain",
    "Setlist: Rollin' & Scratchin' Played on Sep 3, 2010 | prev show",
    "Released on Mar 13, 2001 | next-gen remaster",
  ])("keeps a dated page whose next link word reads on as prose: %s", (text) => {
    expect(webSearchEvidence([web("https://www.example.org/page", text)])).toHaveLength(1);
  });

  it.each([
    "Posted on February 22, 2021 | prev | next Daft Punk announced their split with the video Epilogue.",
    "Daft Punk announced their split. Published on Feb 22, 2021 | next",
    "Daft Punk at Coachella on April 29, 2006 | prev | next",
    "The single was released on November 30 2000 | prev | next",
    "Uploaded an hour ago | next | Discovery tracklist",
    "Daft Punk | 25 years ago | next | Discovery",
    "Comments (3) | Posted on Feb 22, 2021 | context | share",
    "Reviewed on Mar 3, 2020 | prev | next",
    "Published on Oct 12, 2001 | next",
    "Posted by Jane 3 hours ago | next",
    "Released on Feb 22, 2021 | next (2001 remaster)",
    "Released a year ago | parent label Virgin Records",
  ])("keeps a dated page with a blog's prev and next links: %s", (text) => {
    expect(webSearchEvidence([web("https://www.example.org/page", text)])).toHaveLength(1);
  });

  it.each([
    ["the end of the text", "some_user 3 hours ago | parent"],
    ["the end of the text after a context link", "some_user on Feb 22, 2021 | context | flag"],
    [
      "a script link (a top-level comment as the search returns it)",
      "| | | | | --- | | | some_user on Feb 22, 2021 | next (javascript:void(0)) Love it! One More Time is still the best house record.",
    ],
    ["an age of 'a day'", "some_user a day ago | parent | next [–] Still a classic."],
    ["an age of 'an hour'", "some_user an hour ago | prev | next [–] Still a classic."],
    ["a date without a comma", "some_user on Feb 2 2021 | parent | next [–] Love it!"],
    ["a vote link", "some_user 18 hours ago | unvote | prev | next [–] Romanthony sang it."],
  ])("leaves out a forum comment byline at %s", (_name, text) => {
    expect(webSearchEvidence([web("https://www.example.org/thread", text)])).toEqual([]);
  });

  it.each([
    ["a [flagged] marker", "some_user 3 hours ago [flagged] [–] nice sample"],
    ["a [dead] marker", "some_user 3 hours ago [dead] | parent | next [–] the drop is great"],
    ["a flag chain", "some_user 3 hours ago | flag | favorite [–] the drop is great"],
    ["Algolia's order", "some_user | 3 hours ago | parent | context | on: One More Time"],
    ["a fullwidth pipe", "some_user 3 hours ago ｜ parent ｜ next [–] Romanthony sang it."],
    // A user name need not look like a handle: many have no digit or "_".
    ["a full month name", "listener on February 22, 2021 | parent | next [–] Love it!"],
  ])("leaves out a forum comment byline with %s", (_name, text) => {
    expect(webSearchEvidence([web("https://www.example.org/thread", text)])).toEqual([]);
  });

  it("refuses a forum comment byline or a Hacker News page when read back (written by older code)", async () => {
    const [item] = webSearchEvidence([
      web("https://www.example.org/news/one-more-time", "A page about the song."),
    ]);
    const older = {
      ...item,
      excerpt: "some_user on Feb 22, 2021 | parent | next (javascript:void(0)) Love it!",
    } as SourcedEvidence;
    const onForum = { ...item, url: "https://news.ycombinator.com/item?id=26214151" };

    expect(restores([older])).toBe(false);
    expect(restores([onForum])).toBe(false);
    expect(await served([older])).toBe(false);
    expect(await served([onForum])).toBe(false);
    expect(recorderRefuses([older])).toEqual(["analysis.evidence[0].excerpt: a comment thread"]);
    expect(recorderRefuses([onForum])).toContain(
      "analysis.evidence[0].url: a social platform page",
    );
  });

  it("keeps a YouTube video's title and its channel's name: the channel is the publisher", () => {
    const [item] = webSearchEvidence([
      web(
        "https://www.youtube.com/watch?v=FGBhQbmPwH8",
        "Daft Punk · 9.1M subscribers. Official video for One More Time by Daft Punk, from Discovery (2001).",
        "Daft Punk - One More Time (Official Video) - YouTube",
      ),
    ]);

    expect(item).toMatchObject({
      title: "Daft Punk - One More Time (Official Video) - YouTube",
      excerpt:
        "Daft Punk · 9.1M subscribers. Official video for One More Time by Daft Punk, from Discovery (2001).",
    });
  });

  it("is refused when read back with a handle that was not masked (written by older code)", async () => {
    const [item] = webSearchEvidence([
      web("https://www.example.org/news/one-more-time", "A page about the song."),
    ]);
    const older = { ...item, excerpt: "Thomas Bangalter (@thomasbangalter) produced it." };

    expect(
      restoredEvidence([older], {
        readAt: AT,
        recordingMbid: null,
        trackIsOriginal: false,
        configured: { discogs: false, genius: false },
        track: TRACK,
      }),
    ).toBeNull();
    expect(await served([older as SourcedEvidence])).toBe(false);
    expect(recorderRefuses([older as SourcedEvidence])).toEqual([
      "analysis.evidence[0].excerpt: a private @handle",
    ]);
  });
});

/** Ordinary music writing, which reads in places like a comment thread but is not one. */
const MUSIC_PROSE: Array<[string, string]> = [
  [
    "an album's history",
    "Following the success of Homework, Daft Punk spent the late '90s making Discovery. Like its predecessor, the album drew on '70s disco and '80s funk, and One More Time opened it.",
  ],
  [
    "a song named with Like",
    "Smells Like Teen Spirit, the lead single from Nevermind, buried '80s hair metal and defined the '90s. Cobain said he wrote Smells Like Teen Spirit trying to write the ultimate pop song.",
  ],
  [
    "Like and Following with decades",
    "Walk Like an Egyptian was the Bangles' biggest hit of the '80s. Following its release in 1986 it topped the Billboard Hot 100 for 4 weeks; in the '90s it was briefly banned from radio.",
  ],
  [
    "Like a Prayer",
    "Like a Prayer is a song by Madonna. Following Like a Virgin, it defined the late 80s, and remained a staple in the 90s.",
  ],
  [
    "a long song",
    "Like a Rolling Stone (1965) changed rock in the 60s and 70s. Like many of Dylan's songs it runs over 6 min.",
  ],
  [
    "Follow You Follow Me",
    "Follow You Follow Me is a song by Genesis, their first UK top 10 hit, a soft rock staple of the 70s and 80s.",
  ],
  [
    "record formats",
    "The single was pressed on 7-inch 45s and 12s for clubs. Like the album version, Following its release it charted.",
  ],
  [
    "durations",
    "The album version runs 5 min 20 s; the radio edit, 3 min 55 s. Following the single, Like Da Funk returned to the charts.",
  ],
  [
    "a tracklist",
    "Discovery tracklist A1: One More Time A2: Aerodynamic B1: Digital Love B2: Harder, Better, Faster, Stronger",
  ],
  [
    "a box set",
    "CD1: Homework remastered. CD2: Live 1997, recorded in Birmingham. 01: Daftendirekt.",
  ],
  ["band names", "Best covers of the year. R.E.M.: Losing My Religion, live. U2: One, unplugged."],
  [
    "a quoted artist",
    "In an interview will.i.am: 'We wanted it to feel like a party.' Later, will.i.am: 'It just clicked.'",
  ],
  [
    "news of a band's profile picture",
    "In 2021 the band changed Daft Punk's profile picture on Instagram to an hourglass, a day before Epilogue.",
  ],
  [
    "a video description",
    "Daft Punk - One More Time (Official Video). Follow Daft Punk: Like us on Facebook. 3:55 runtime. Released 2000.",
  ],
  [
    "a label page",
    "Virgin Records: Follow us. New releases this week. Daft Punk, One More Time, 12 inch single, 2000.",
  ],
  ["a review", "Rating: 5 stars. Reviewed 2y ago by staff. Likes: 120. Replies: 4."],
  [
    "a chart run",
    "Released 30 Nov 2000. Peaked at No. 1 in France for 5 w. Like Da Funk, it was a hit. Follow-up Aerodynamic.",
  ],
  [
    "a K-pop song",
    "Like OOH-AHH by TWICE (2015) 4 min. Like Ooh-Ahh debut; Following in 2016 Cheer Up 3 min.",
  ],
];

describe("ordinary music writing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(MUSIC_PROSE)("keeps %s in the evidence", (_name, text) => {
    expect(webSearchEvidence([web("https://www.example.org/page", text)])).toHaveLength(1);
  });

  it("keeps all of it in the search's answer", async () => {
    const results = MUSIC_PROSE.map(([, content], i) => ({
      title: `Page ${i}`,
      url: `https://www.example.org/page/${i}`,
      content,
    }));
    stubFetch((call) =>
      call.url === "https://api.tavily.com/search" ? json({ results }) : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "One More Time",
      artistName: "Daft Punk",
    });

    expect(JSON.parse(text).results).toHaveLength(MUSIC_PROSE.length);
  });
});

describe("handles masked whole", () => {
  it("masks hyphenated handles, handles after other scripts or RT, and keeps e-mail addresses", () => {
    const [item] = webSearchEvidence([
      web(
        "https://www.example.org/news/one-more-time",
        "One More Time was released in November 2000 on Virgin, with a video by Leiji Matsumoto. @john-smith-1987 and @jane-doe.bsky.social liked it. 今日も聴いてる@someone_jp. RT@fan_page: wow. Write to press@virgin.example.",
      ),
    ]);

    expect(item.excerpt).toBe(
      "One More Time was released in November 2000 on Virgin, with a video by Leiji Matsumoto. @… and @… liked it. 今日も聴いてる@…. RT@…: wow. Write to press@virgin.example.",
    );
  });

  it("cuts a long title before it is checked or stored", () => {
    const [item] = webSearchEvidence([
      web(
        "https://www.example.org/news/one-more-time",
        "A page about the song.",
        "t.".repeat(5000),
      ),
    ]);

    expect(item.title.length).toBeLessThanOrEqual(300);
  });
});

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
import { FORUM_LIMITS, FORUM_THREADS } from "../../sources/testing/forumThreads.js";
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
/** Pieces of forum thread layouts (forumThread): quotes, post headers, bylines and signatures. */
const FORUM_PIECES = [
  (n: number) => `Fan${n} said: ↑`,
  (n: number) => `Fan${n} said:`,
  () => "Click to expand...",
  (n: number) => `Feb ${(n % 28) + 1}, 2021 #${n}`,
  (n: number) => `Joined Mar ${(n % 28) + 1}, 2010`,
  (n: number) => `Messages: ${n}`,
  (n: number) => `Quote: Originally Posted by Fan${n}`,
  () => "Reply With Quote",
  (n: number) => `Posts: ${n}`,
  () => "share | improve this answer | follow",
  (n: number) => `answered Feb 21, 2021 at 10:${String(n % 60).padStart(2, "0")}`,
  (n: number) => `sure? – Fan${n} Feb 22 '21 at 16:01`,
  (n: number) => `posted by Fan${n} at 6:47 AM on February 22, 2021`,
  (n: number) => `[${n} favorites]`,
  (n: number) => `Fan${n} February 22, 2021, 3:15pm #${n}`,
  (n: number) => `Post by Fan${n} » Mon Feb 22, 2021 3:${String(n % 60).padStart(2, "0")} pm`,
  (n: number) => `Fan${n} • ${(n % 9) + 1}y ago`,
  () => "Reply Share",
  (n: number) => `${n} Reply`,
  (n: number) => `#${n} 22nd February 2021`,
  (n: number) => `Fan from Ohio Oct ${(n % 28) + 1}, 2009:`,
  (n: number) => `Reviewed in the United States on February ${(n % 28) + 1}, 2021`,
];
/** A forum piece in a kept excerpt: forumThread decided on it, and the readers must agree. */
const FORUM_PIECE =
  /said:|Click to expand|\d #\d|Joined Mar|Messages: |Originally Posted by|Reply With Quote|Posts: |improve this answer|answered Feb|'21 at|posted by Fan|favorites\]|pm #|» Mon|y ago|Reply Share|\d Reply|22nd February|from Ohio|Reviewed in/;

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
            ? next() < 0.5
              ? RISKY[Math.floor(next() * RISKY.length)](n)
              : FORUM_PIECES[Math.floor(next() * FORUM_PIECES.length)](n)
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
    expect(items.filter((item) => FORUM_PIECE.test(item.excerpt)).length).toBeGreaterThan(10);
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

describe("forum thread layouts", () => {
  it.each(FORUM_THREADS)("leaves out %s on any site, as text or title", (_name, text) => {
    expect(webSearchEvidence([web("https://www.example.org/thread", text)])).toEqual([]);
    expect(webSearchEvidence([web("https://www.example.org/thread", "A page.", text)])).toEqual([]);
  });

  it.each(FORUM_LIMITS)("keeps %s, a known limit: %s", (_name, _why, text) => {
    expect(webSearchEvidence([web("https://www.example.org/thread", text)])).toHaveLength(1);
  });

  it("refuses a forum thread when read back (written by older code)", async () => {
    const [item] = webSearchEvidence([
      web("https://www.example.org/news/one-more-time", "A page about the song."),
    ]);
    for (const [, text] of FORUM_THREADS) {
      const older = { ...item, excerpt: text } as SourcedEvidence;
      expect(restores([older]), text).toBe(false);
      expect(await served([older]), text).toBe(false);
      expect(recorderRefuses([older]), text).toEqual([
        "analysis.evidence[0].excerpt: a comment thread",
      ]);
    }
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
  // Quoting prose: "said:", "Joined:" or a dash before a name and a date read like a forum's.
  [
    "an article quoting the artists",
    "As Thomas Bangalter said: 'We wanted it to feel like a party.' Pharrell said: 'we jammed for days, and Nile Rodgers said: keep it simple.' Click to expand the full interview.",
  ],
  [
    "an interview",
    "Q: How did One More Time come together? Thomas Bangalter: We met Romanthony in Chicago. Q: And the sample? Guy-Manuel de Homem-Christo said: we never talk about samples. Interview by Jane Smith, posted by Mixmag at 9:00 AM on Feb 22, 2021.",
  ],
  [
    "liner notes",
    "Written by T. Bangalter, G-M. de Homem-Christo and A. Moore. Produced by Daft Punk. Recorded at Daft House, Paris. Vocals: Romanthony. Mastered at Translab. Messages: thanks to everyone at Virgin. Joined: Romanthony on vocals. Originally released 2000.",
  ],
  [
    "a press release",
    "PARIS, Nov 13, 2000 /PRNewswire/ -- Virgin Records today released One More Time. 'It is a celebration,' Thomas Bangalter said. Originally posted by Virgin Records. Posted by Virgin Records at 9:00 AM. Posted by Virgin Records at 4:30 PM. Share | Improve your playlist.",
  ],
  [
    "a chart history",
    "Billboard Dance Club Songs. Week of Feb 24, 2001 #1 One More Time. Week of Mar 3, 2001 #1 One More Time. Week of Mar 10, 2001 #2 One More Time.",
  ],
  [
    "a tour's dates",
    "Alive 2007 – Bercy Jun 14, 2007 at 20:00 Alive 2007 – Wembley Jun 16, 2007 at 19:30. When asked Feb 22, 2021 about the split, the label said: no comment.",
  ],
  // Signed journalism and listings, which read like a Stack Exchange comment's signature.
  [
    "signed news with an update",
    "Daft Punk have split after 28 years. – Jane Doe, Feb 22, 2021 at 10:00 Update: a representative confirmed the news. – John Roe, Feb 22, 2021 at 12:30",
  ],
  [
    "a list with signed blurbs",
    "47. Daft Punk: One More Time. A filter house anthem built on Eddie Johns. – Jane Doe, Oct 2, 2023 at 9:00 46. The Avalanches: Since I Left You. A record built entirely of samples. – John Roe, Oct 2, 2023 at 9:00",
  ],
  [
    "a live-blog",
    "Daft Punk have announced their split with an eight-minute video, Epilogue. – Jane Doe, Feb 22, 2021 at 15:02 Nile Rodgers tweeted his thanks. – Jane Doe, Feb 22, 2021 at 15:40 Pharrell paid tribute on Instagram. – John Roe, Feb 22, 2021 at 16:10",
  ],
  [
    "a tour list with venues in brackets",
    "Alive 2007 tour dates: Paris (Bercy) – London Wembley Arena Jun 16, 2007 at 19:30 (sold out) – Dublin The O2 Jun 18, 2007 at 20:00 (sold out) – Glasgow SECC Jun 20, 2007 at 19:00.",
  ],
  [
    "a tour list with weekdays",
    "Alive 2007 dates. Bercy, Paris. – Sat Jun 14, 2007 at 20:00 Wembley Arena, London. – Sat Jun 16, 2007 at 19:30",
  ],
  // Asked, answered and edited notes, which read like a Stack Exchange post's.
  [
    "a signed article with a correction note",
    "Discovery is a joy. – Jane Doe, Feb 22, 2021 at 10:00 (This article was edited Feb 23, 2021 at 9:00 to add a quote.)",
  ],
  [
    "a write-up of a Q&A session",
    "Fans asked Feb 22 at 10:00 whether Romanthony would return. The duo answered Feb 22 at 10:45: 'We will always love him.' Producer Todd Edwards also answered Feb 22 at 11:30 about the cut-up vocal style.",
  ],
  [
    "an advice column",
    "Q. How did Daft Punk get the One More Time vocal? asked Feb 22, 2021 at 10:00 by a reader. A. The vocal was run through a vocoder and Auto-Tune. answered Feb 23, 2021 at 9:00 by a staff writer.",
  ],
  [
    "a setlist's edit history",
    "Daft Punk Setlist at Wembley Arena, London on June 16, 2007. Robot Rock / Oh Yeah. Last updated: Feb 22, 2021. edited Feb 22, 2021 at 10:00 by a user; edited Feb 23, 2021 at 9:15 by a user.",
  ],
  [
    "a fact page with an edit note",
    "The vocalist is Romanthony. edited Feb 22, 2021 at 10:00 by staff. This was asked Feb 21, 2021 at 9:15 by a reader: is it a sample? Yes, More Spell on You by Eddie Johns.",
  ],
  // Dated stamps, set times and logs after a dash, which read like a Stack Exchange signature.
  [
    "a live-blog's update stamps",
    "Daft Punk have split after 28 years. — Updated Feb 22, 2021 at 10:00 The duo posted an eight-minute video, Epilogue. — Updated Feb 22, 2021 at 12:30 Nile Rodgers paid tribute.",
  ],
  [
    "news with its published and updated stamps",
    "Daft Punk announce their split. – Published Feb 22, 2021 at 10:00 The duo formed in 1993. – Updated Feb 22, 2021 at 12:30",
  ],
  [
    "a live-blog's key events",
    "Key events. – Updated Feb 22 at 15:02 Nile Rodgers tweeted his thanks. – Updated Feb 22 at 15:40 Pharrell paid tribute.",
  ],
  [
    "a festival's set times",
    "Friday line-up announced. – Daft Punk Jul 14 at 22:00. – Justice Jul 14 at 23:30. – Cassius Jul 15 at 01:00.",
  ],
  [
    "a festival's stages",
    "Coachella 2006, Sahara tent. – Daft Punk Apr 29 at 21:00 The pyramid debuted here. – Depeche Mode Apr 29 at 22:30 on the main stage.",
  ],
  [
    "a tour list without commas",
    "Alive 2007 tour. – Bercy Jun 14, 2007 at 20:00 Sold out. – Wembley Jun 16, 2007 at 19:30 Sold out. – Dublin Jun 18, 2007 at 20:00",
  ],
  [
    "a radio log",
    "Most played this week. – Daft Punk Feb 22 at 10:00 One More Time. – Daft Punk Feb 22 at 14:00 Digital Love.",
  ],
  // A song named Messages beside a dated chart position, which reads like a XenForo post card.
  [
    "a chart run of a song named Messages",
    "Orchestral Manoeuvres in the Dark – Messages 1980 single, from their debut album. UK Singles Chart: entered Oct 25, 1980 #13, its peak position.",
  ],
  [
    "a discography with a song named Messages",
    "Electricity 1979. Red Frame/White Light 1980. Messages 1980 – peaked Nov 1, 1980 #13. Enola Gay 1980.",
  ],
  [
    "a chart run of Messages, day first",
    "Messages 25 Oct 1980 – entered the UK chart; 1 Nov 1980 #13, its peak.",
  ],
  [
    "a blog whose theme writes a lowercase byline",
    "Daft Punk split: what One More Time meant. posted by admin at 9:00 AM on February 22, 2021. The Romanthony story. posted by admin at 3:15 PM on February 23, 2021. [2 comments]",
  ],
  [
    "a band's line-up",
    "Line-up. Thomas Bangalter Joined: 1993. Guy-Manuel de Homem-Christo Joined: 1993. Posts: drums, keys. Quote: 'We are robots.' Join Date: 1993.",
  ],
  // Bylines, ages, reviews and quoted comments, which read like a comment widget's or a forum's.
  [
    "an interview with its age in the byline",
    "Interview by Jane Smith • 3y ago. Thomas Bangalter on One More Time: 'We wanted it to feel like a party.' Share this interview with a friend.",
  ],
  [
    "a list of articles with their ages",
    "Daft Punk's Thomas Bangalter: the interview · 3y ago · 8 min read. Read next: Nile Rodgers on Get Lucky • 2y ago. Romanthony remembered • 4y ago.",
  ],
  [
    "a review site's editorial review",
    "Daft Punk – Discovery review. Rating: 4.5 out of 5 stars. Reviewed by Jane Smith on February 22, 2021. One More Time opens the album with Romanthony's vocal. Verified by our editors.",
  ],
  [
    "liner notes with Posted by",
    "Liner notes. Posted by Virgin Records at 9:00 AM. Written by T. Bangalter and G-M. de Homem-Christo. Posted by Virgin Records at 4:30 PM: the remaster notes.",
  ],
  [
    "a group blog's capitalised bylines",
    "Posted by Jane Doe at 9:00 AM on February 22, 2021. Daft Punk split. Posted by John Roe at 3:15 PM on February 23, 2021. The Romanthony story.",
  ],
  [
    "an article quoting a YouTube comment once",
    "One fan wrote under the video 3 years ago: 'This song never gets old.' The comment has 1.2K likes and 45 replies, more than the label's own post.",
  ],
  [
    "an article quoting a YouTube comment with its button",
    "A YouTube comment from 3 years ago, 'This song never gets old', shows 1.2K Reply. In 2015 Reply 1988, the Korean series, used the song.",
  ],
  [
    "a blog's bylines with an arrow and no time",
    "Daft Punk split: the story by Jane Doe » February 22, 2021. One More Time and the Romanthony vocal, by John Roe » February 23, 2021.",
  ],
  ["a breadcrumb", "Home » News » Daft Punk » Feb 22, 2021 Daft Punk have split after 28 years."],
  [
    "a chart run that falls one place a week",
    "UK Singles Chart run. Week of Feb 24, 2001 #1 One More Time. Week of Mar 3, 2001 #2 One More Time. Week of Mar 10, 2001 #3 One More Time.",
  ],
  [
    "a magazine issue's number and date",
    "Sound On Sound, #1 22nd February 2021 issue: how Daft Punk made Discovery. #2 1st March 2021 issue: the vocoder.",
  ],
  [
    "a mention of a forum's member title",
    "Fans on the Gearspace forum, where one Gear Addict asked about the vocoder, guessed a DigiTech Talker. A Forum Resident at another board agreed.",
  ],
  [
    "a Songfacts page's facts above an undated comment",
    "One More Time by Daft Punk. Songfacts: The vocal is Romanthony's, heavily processed with Auto-Tune. Comments: 1 Jane from Ohio This is the best.",
  ],
  [
    "a dateline",
    "News from Paris Feb 22, 2021: Daft Punk have split after 28 years, with a video.",
  ],
  // Pages a first version of these layouts left out: each read like one layout's two marks.
  [
    "a news byline's age beside a contest's points",
    "By Jane Doe · 6 months ago. Eurovision 2024: Loreen, who won with 583 points a year ago, returns to open the show in Malmö.",
  ],
  [
    "a contest's points beside a byline's age",
    "Måneskin, who won Eurovision with 524 points 3 years ago, play Rome tonight. Jane Doe • 2 years ago",
  ],
  [
    "contest news with a related list's ages",
    "Loreen won Eurovision with 583 points a year ago in Liverpool, the second performer ever to win twice. More Eurovision news • 1y ago Käärijä's Cha Cha Cha tops the Finnish chart • 2y ago Måneskin sign a worldwide deal",
  ],
  [
    "a game score's level beside a related list's age",
    "Koji Kondo wrote the level 1 theme · 3 notes repeat before the bass enters, and the overworld theme became the most covered game tune. Related: Inside the Zelda score • 3y ago",
  ],
  [
    "a news card with Reply and Share under a byline",
    "Jane Doe • 2 years ago Why the Amen break is the most sampled drum loop in history: a six-second solo from the Winstons' 1969 B-side. Reply Share this story with a friend",
  ],
  [
    "a trends page with a bullet age and Reply Share",
    "r/Music trends: Daft Punk's One More Time · 3 yr. ago became the most streamed French song; Reply Share",
  ],
  [
    "one writer's blog archive with an arrow, a date and a time",
    "by Mark Smith » February 22, 2021 3:15 pm Kid A turns 21. by Mark Smith » March 1, 2021 9:00 am Amnesiac's Pyramid Song was built on a Mingus record.",
  ],
  [
    "a blog's category bylines with an arrow",
    "Posted by admin in Reviews » 22 Feb 2021, 15:15 Daft Punk's Discovery samples Edwin Birdsong. Posted by admin in News » 23 Feb 2021, 10:00 Romanthony sang One More Time.",
  ],
  [
    "one week's chart in two countries",
    "On the charts dated Feb 24, 2001 #1 in the UK and Feb 24, 2001 #2 in Ireland, Daft Punk's One More Time was at its peak.",
  ],
  [
    "one week's peaks in two countries",
    "One More Time peaked on Dec 2, 2000 #1 in France and Dec 2, 2000 #2 in the UK.",
  ],
  [
    "one week's chart with ordinal dates",
    "The Official Chart of #1 26th February 2000 was All Saints; #2 26th February 2000 was Craig David's Fill Me In.",
  ],
  [
    "a festival's best sets with weekday times",
    "Our five best sets of Glastonbury: Saturday at 10:15 PM #1 Coldplay, Saturday at 8:00 PM #2 Burna Boy, Sunday at 9:30 PM #3 SZA.",
  ],
  [
    "a festival live-blog with weekday times",
    "Glastonbury 2024 live: Friday at 9:45 PM #1 Dua Lipa's headline set began, after Friday at 7:00 PM #2 Michael Kiwanuka.",
  ],
  [
    "a festival's running order with weekday times",
    "Woodstock running order: Saturday at 9:00 PM #1 Santana; Saturday at 10:30 PM #2 Grateful Dead; Sunday at 9:00 AM #3 Jimi Hendrix.",
  ],
  [
    "a tour's infobox with a chart week",
    "The Eras Tour Start date March 17, 2023 End date December 8, 2024 No. of shows 149. It led Billboard Boxscore on Dec 9, 2023 #1 among all tours.",
  ],
  [
    "a tour's infobox and its box office",
    "The Eras Tour Start date March 17, 2023 End date December 8, 2024 Legs 5 No. of shows 149 Box office $2.077 billion. Billboard Boxscore chart dated Dec 9, 2023 #1 for the year.",
  ],
  [
    "a tour's infobox beside a trending list",
    "Start date March 17, 2023 End date December 8, 2024. Trending 3 hours ago #1 Taylor Swift ends The Eras Tour.",
  ],
  [
    "an article quoting one Amazon review",
    "One fan's review captures it: '5.0 out of 5 stars A classic. Reviewed in the United States on February 22, 2021. Verified Purchase. The vocoder still sounds like the future.' The album has sold four million copies.",
  ],
  [
    "an article quoting one Amazon review without its badge",
    "A fan wrote: '5.0 out of 5 stars Masterpiece. Reviewed in the United States on February 22, 2021.' Another called it overrated.",
  ],
  [
    "a metareview with dated star ratings",
    "Critics: AllMusic Mar 12 2001 4.50 stars; Rolling Stone Mar 29 2001 4.00 stars; Pitchfork gave it 6.4.",
  ],
  [
    "two writers' lowercase blog bylines",
    "posted by jane at 9:00 AM on February 22, 2021 Discovery turns 20. posted by mark at 10:00 AM on February 23, 2021 Homework's Da Funk was a b-side first.",
  ],
  [
    "liner notes with Live from datelines",
    "Disc 1 – Live from Wembley Stadium, London, July 13, 1985: Status Quo, Queen, David Bowie. Disc 2 – Live from JFK Stadium, Philadelphia, July 13, 1985: Led Zeppelin, Madonna.",
  ],
  [
    "a live album's Live from sections",
    "Live from the Royal Albert Hall May 2, 1966: Tell Me, Baby. Live from the Free Trade Hall May 17, 1966: Like a Rolling Stone.",
  ],
  [
    "liner notes quoting dated letters",
    "Letter from Brian Epstein, London, October 2, 1963: the boys will record on the 17th. Letter from George Martin, London, October 18, 1963: I Want to Hold Your Hand is finished.",
  ],
  [
    "a tour diary's datelines",
    "Notes from Tokyo March 3, 2024: the Budokan show sold out in an hour. Notes from Osaka March 5, 2024: we added a second encore.",
  ],
  [
    "a related tracks list with glued ages beside Like",
    "Daft Punk - Veridis Quo (Edit) 3y Like Repost Daft Punk - Aerodynamic (Live) 2mo Like Repost 12.3K plays",
  ],
  [
    "a related artists list with glued ages beside Follow",
    "Daft Punk 3y Follow · Justice 1y Follow · Air 2mo Follow — artists you may like.",
  ],
  [
    "an artist card with ages beside Follow",
    "Daft Punk Artist 23,456,789 monthly listeners Follow 3y ago released Random Access Memories (10th Anniversary Edition). Popular releases 2mo ago Follow",
  ],
  [
    "an article naming a forum title and a start date",
    "Steve Hoffman's board gave him the title Forum Resident; his remasters of Discovery are discussed with Start date Feb 22, 2021 in the trade press.",
  ],
  [
    "a gear magazine's issue number with gear words",
    "Sound On Sound: Lives for gear? The DigiTech Talker that Daft Punk used on Digital Love. Report Post-production notes follow. #1 22nd February 2001 issue.",
  ],
  [
    "an interview with a clock, a number and a last reply",
    "February 22, 2021, 3:15pm #1 single of the week. Bangalter created the vocal as his last reply to critics of Homework.",
  ],
  [
    "a feature quoting two YouTube comments with their likes",
    "Fans still argue about the vocal. 'It is Romanthony, not a vocoder' 3 years ago 1.2K Reply and 'This is the best house record ever' 2 years ago 300 Reply, read two top comments.",
  ],
  [
    "an article quoting two YouTube comments with their likes",
    "Two comments sum up the reaction: 'Romanthony forever' 3 years ago 1.2K Reply and 'Still my favourite' 2 years ago 845 Reply.",
  ],
  [
    "an author box with a join date and a post count",
    "About the author: Jane Doe Joined: Mon Mar 03, 2010 Posts: 245. Jane has written about house music since 1997.",
  ],
  [
    "an article quoting four YouTube comments with their likes",
    "Four comments sum up the reaction: 'Romanthony forever' 3 years ago 1.2K Reply, 'Still my favourite' 2 years ago 845 Reply, 'One more time' 1 year ago 300 Reply, and 'RIP' 4 years ago 120 Reply.",
  ],
  [
    "a video page with one top comment",
    "Daft Punk - One More Time (Official Video) 245M views 13 years ago. Top comment 3 years ago Romanthony's voice is the reason this works 1.2K Reply",
  ],
  [
    "a festival's best sets with the artists before their times",
    "Our top three Glastonbury sets: Coldplay Saturday at 10:15 PM #1 Burna Boy Saturday at 8:00 PM #2 SZA Sunday at 9:30 PM #3",
  ],
  [
    "a drama's title after an episode number",
    "Reply 1988 rewatch diary. Started 3 years ago with episode 1 Reply 1988 and its OST; finished 2 years ago with episode 20 Reply 1988, still the best soundtrack.",
  ],
  [
    "two albums' peaks on different days",
    "Daft Punk's albums in France: Homework Jan 20, 1997 #1 and Discovery Mar 12, 2001 #2.",
  ],
  // Pages that read like a forum's marks beside a page's own: a chart row, a stamp, a comment count.
  [
    "concert review, stage times, rating, Comments footer",
    "Live review: LCD Soundsystem, Brixton Academy, Friday 12 April 2024. Doors were at 7:00 PM, Jayda G played from 8:15 PM and James Murphy's band came on at 9:30 PM sharp. The two-hour set opened with Us v Them and closed, as ever, on All My Friends. Rating: 4.5 out of 5 stars. Comments: 6",
  ],
  [
    "concert review opening with a Live from dateline, Comments footer",
    "Live from the Barrowland, Glasgow, March 3, 2024: Blur's first Scottish show in nine years sold out in four minutes. Damon Albarn told the crowd it was the loudest night of the tour, and the sprung floor bounced through Song 2. Setlist: St. Charles Square, There's No Other Way, Popscene, Beetlebum, Tender. Comments: 14",
  ],
  [
    "tour diary postcards, Comments footer",
    "Tour diary, part three. Postcard from Glasgow March 3, 2024: the Barrowland's sprung floor was bouncing by the second chorus of Song 2. Postcard from Manchester March 5, 2024: a quieter crowd, but This Is a Low got the biggest singalong of the run. Comments: 3",
  ],
  [
    "gig guide with weekday times and numbered picks",
    "This weekend's best gigs in London. Friday at 8:00 PM #1 pick: Jungle at the O2, with their full live band. Saturday at 7:30 PM #2 pick: Arlo Parks at the Roundhouse. Sunday at 6:00 PM #3 pick: Ezra Collective at the Barbican.",
  ],
  [
    "festival live blog, dash update stamps, comments plugin",
    "Glastonbury 2024 live: Dua Lipa headlines the Pyramid. The crowd stretched back to the Other Stage. – Updated Jun 28 at 21:45. Dua opened with Training Season and Levitating, then brought out Elton John for Cold Heart. – Updated Jun 28 at 22:30. 0 Comments Sort by Newest Add a comment... Facebook Comments Plugin",
  ],
  [
    "tour dates after dashes, comments plugin",
    "Justice announce the Hyperdrama world tour. Tickets go on sale Friday at 10:00. – Zénith Paris Mar 14 at 20:00. – O2 Academy Brixton Mar 21 at 19:30. – Brooklyn Mirage May 2 at 21:00. Add a comment...",
  ],
  [
    "bootleg list of a two-show night",
    "Grateful Dead, February 1970 tapes. Fillmore East Feb 13, 1970 #1 (early show): Dark Star > That's It for the Other One. Fillmore East Feb 13, 1970 #2 (late show): the Dark Star > Spanish Jam that tapers rank among the best. Both were issued on Dick's Picks Volume 4.",
  ],
  [
    "Bandcamp album with fan notes",
    "Discovery (Remastered) by Daft Punk. Digital Album. Streaming + Download. Includes unlimited streaming via the free Bandcamp app, plus high-quality download in MP3, FLAC and more. Buy Digital Album €9.99 EUR or more. Supported by marc_dj Favorite track: Digital Love. Still sounds like the future. sophie.k Favorite track: Something About Us. That bassline! released March 12, 2001. Tags: electronic, french house, Paris.",
  ],
  [
    "Bandcamp album with about text and credits",
    "Ambient Works Vol. 3 by Lumen. 1. Drift 04:12 2. Harbour Lights 06:30 3. Low Tide 05:02. about: Recorded live from the Harbour Studio, Bristol, February 22, 2021: one take, no overdubs. supported by 120 fans who also own Ambient Works Vol. 2. tom_w Favorite track: Harbour Lights. credits: released February 22, 2021. Lumen: synths, field recordings. Mastered by Jane Doe.",
  ],
  [
    "Discogs release with notes and credits",
    "Daft Punk – Discovery. Label: Virgin – 7243 8 49606 2 6. Format: CD, Album. Country: Europe. Released: 12 Mar 2001. Genre: Electronic. Style: House, Disco, Synth-pop. Tracklist 1 One More Time 5:20 2 Aerodynamic 3:27 3 Digital Love 4:58. Credits: Vocals – Romanthony (tracks: 1, 13), Todd Edwards (tracks: 9). Notes: Recorded at Daft House, Paris, 1997–2000. Includes a Daft Club card. Have: 24,512 Want: 8,901 Avg Rating: 4.52 / 5 Ratings: 3,120 Last Sold: Feb 22, 2021",
  ],
  [
    "Discogs reissue with two reviews",
    "Daft Punk – Homework (2xLP, Album, Reissue). Released: 2 Feb 2014. Notes: Cut by Kevin Gray at Cohearent Audio. Reviews: Reviewed by vinyl_head on February 22, 2021: quiet pressing, Da Funk sounds huge. Reviewed by tom.b on March 3, 2021: some surface noise on side C. Have: 12,034 Want: 2,210",
  ],
  [
    "session notes with a dated log",
    "Miles Davis – Kind of Blue. Recorded March 2, 1959 (tracks A1, A2, B1) and April 22, 1959 (A3, B2) at Columbia 30th Street Studio, New York. Credits: Bass – Paul Chambers. Drums – Jimmy Cobb. Piano – Bill Evans, Wynton Kelly (A2). Tenor Saxophone – John Coltrane. Notes from the session log, March 2, 1959: Freddie Freeloader was the first full take.",
  ],
  [
    "press bio",
    "Biography. Justice are Gaspard Augé and Xavier de Rosnay. Formed in Paris in 2003, the duo signed to Ed Banger Records after their remix of Simian's Never Be Alone won a student radio contest. Their debut album † (Cross) came out on June 11, 2007 and was nominated for a Grammy. Hyperdrama, their fourth, followed on April 26, 2024 with Tame Impala's Kevin Parker on two tracks.",
  ],
  [
    "news story with a Posted stamp and an author box post count",
    "Posted: Feb 22, 2021 3:15 pm. PARIS — Daft Punk have announced their split in an eight-minute video, Epilogue, taken from their 2006 film Electroma. The duo formed in 1993. About the author: Jane Doe has covered electronic music since 1997. Posts: 1,204",
  ],
  [
    "label news with a Posted stamp and an author join date",
    "Posted: Mon Feb 22, 2021 3:15 pm. Ed Banger Records confirms Justice's new single, Generator, for Friday. Written by Jane Doe, staff writer. Joined: Mon Mar 03, 2010.",
  ],
  [
    "podcast transcript with timestamps",
    "Song Exploder, episode 201: Daft Punk, Touch. Transcript. [00:00:12] Hrishikesh Hirway: You're listening to Song Exploder. [00:01:45] Thomas Bangalter: We wanted Paul Williams to sound like he was singing from space. [00:03:20] Hrishikesh Hirway: How did that begin? [00:03:24] Thomas Bangalter: With a modular synth patch we left running for days.",
  ],
  [
    "podcast episode page with chapters",
    "Episode 312 · 3 years ago · 1h 12m. Nile Rodgers on Get Lucky and the Chic sound. Chapters: 00:00 Intro 04:12 The Power Station 31:40 Meeting Daft Punk 58:02 Random Access Memories. 245 Reply All listeners voted it the best episode of the year.",
  ],
  [
    "song-meaning page quoting an annotation",
    "What does One More Time mean? Genius annotation (verified by Daft Punk's label): 'The vocal is Romanthony's, run through Auto-Tune and a vocoder.' Bangalter told Remix magazine in 2001 that the effect was meant to feel like a party on a Friday night. Upvote 245 Downvote. 3 contributors.",
  ],
  [
    "annotation page with two helpful counts",
    "One More Time meaning. [Chorus: Romanthony] 'One more time, we're gonna celebrate.' Annotation by 4 contributors · last edited 3 years ago. The line nods to Chicago house, where 'one more time' was the DJ's call for an encore. 12 people found this helpful. Was this annotation helpful? 3 people found this helpful.",
  ],
  [
    "liner notes with credits",
    "Liner notes. 1. One More Time (Bangalter, de Homem-Christo, Moore) 5:20. Vocals: Romanthony. 2. Aerodynamic 3:27. 3. Digital Love (Bangalter, de Homem-Christo, Jordan) 4:58: contains a sample of I Love You More by George Duke. Recorded at Daft House, Paris, 1997–2000. Mastered by Nilesh Patel at The Exchange, London. Thanks to Pedro Winter.",
  ],
  [
    "box set notes with session datelines",
    "The Esher Demos. Demos from Kinfauns, Esher, May 28, 1968: Cry Baby Cry, Child of Nature, The Continuing Story of Bungalow Bill. Session from Abbey Road, London, May 30, 1968: the first take of Revolution 1, ten minutes long. Notes by Kevin Howlett.",
  ],
  [
    "live album notes for a two-show night",
    "Live at the Fillmore East, March 7, 1970. Disc 1 is the early show, disc 2 the late one. Credits: Miles Davis – trumpet; Chick Corea – electric piano; Dave Holland – bass; Jack DeJohnette – drums. Fillmore East Mar 7, 1970 #1 runs 42 minutes; Fillmore East Mar 7, 1970 #2 adds Spanish Key.",
  ],
  [
    "chart week table, flattened",
    "Official Singles Chart Top 100, 24 February 2001 – 2 March 2001. Pos LW Title Artist Label 1 1 It Wasn't Me Shaggy feat. Rikrok MCA 2 2 Whole Again Atomic Kitten Innocent 3 New Uptown Girl Westlife RCA 4 3 Rollin' Limp Bizkit Interscope 5 5 Stuck in the Middle with You Louise EMI.",
  ],
  [
    "chart rows with the date on each row",
    "Billboard Hot 100 archive, top three. Shaggy Mar 3, 2001 #1 It Wasn't Me (MCA). OutKast Mar 3, 2001 #2 Ms. Jackson (LaFace). Crazy Town Mar 3, 2001 #3 Butterfly (Columbia).",
  ],
  [
    "chart rows with an ordinal date on each row",
    "UK Singles Chart, top three: #1 26th February 2000 All Saints – Pure Shores (London). #2 26th February 2000 Craig David – Fill Me In (Wildstar). #3 26th February 2000 Gabrielle – Rise (Go! Beat).",
  ],
  [
    "peak positions by country in one week",
    "One More Time peaked in its second week. Peak positions: France Nov 25, 2000 #1, UK Nov 25, 2000 #2, Belgium Nov 25, 2000 #3, Netherlands Dec 2, 2000 #4.",
  ],
  [
    "year-end countdown with peak weeks",
    "Our 2021 countdown. Each entry links to the week it peaked. Olivia Rodrigo – drivers license, peaked Jan 16, 2021 #1. The Weeknd – Save Your Tears, peaked Apr 10, 2021 #1. Dua Lipa – Levitating, peaked Mar 27, 2021 #2.",
  ],
  [
    "journalism citing a forum post number and member title",
    "Collectors spotted the mastering error first. On the Steve Hoffman Music Forums, one Forum Resident noted on Feb 22, 2021 #47 in the Discovery remaster thread that the new vinyl cuts Digital Love short by four seconds. Warner later confirmed a corrected pressing.",
  ],
  [
    "journalism quoting a Reddit score",
    "The theory took off on Reddit, where a post titled 'Epilogue is the Electroma ending' had 4,512 points 3 years ago and drew more than 900 comments. 'They told us in 2006,' wrote one user. The post still shows Upvote 4.5K Downvote today.",
  ],
  [
    "journalism naming forum titles",
    "Gearheads have argued about the vocoder for twenty years. On Gearspace, a self-described Gear Addict posted a teardown of the DigiTech Talker in the long-running Daft Punk thread, and a Well-Known Member at the Hoffman board pointed out that Thomas Bangalter also used a Roland SVC-350.",
  ],
  [
    "journalism citing two posts by date and number",
    "As one Forum Resident put it (Feb 22, 2021 #12): 'This is the cut to own.' Another disagreed two posts later (Feb 22, 2021 #14): 'The 2001 Virgin pressing is warmer.'",
  ],
  [
    "journalism quoting one phpBB post",
    "The earliest mention we found is on a German fan board: 'Post by marc » Mon Feb 22, 1999 3:15 pm — new Daft Punk album next year, Romanthony on vocals.' Asked about it, Pedro Winter said he never posted there.",
  ],
  [
    "Wikipedia song lead and infobox",
    "One More Time (Daft Punk song). 'One More Time' is a song by French duo Daft Punk, released as the lead single from their second studio album, Discovery, on 13 November 2000. Released 13 November 2000 Recorded 1998 Studio Daft House, Paris Genre French house, disco Length 5:20 (album version) Label Virgin Songwriter(s) Thomas Bangalter, Guy-Manuel de Homem-Christo, Anthony Moore Producer(s) Daft Punk.",
  ],
  [
    "Wikipedia tour infobox",
    "Alive 2007 was a concert tour by Daft Punk. Start date 14 June 2006 End date 14 December 2007 Legs 4 No. of shows 48. Associated album Human After All. The tour began at Coachella on 29 April 2006 #1 among the festival's most talked-about sets, and the Bercy show of 14 June 2007 was released as Alive 2007.",
  ],
  [
    "album review with a dispatch dateline and Comments footer",
    "Album review: Fontaines D.C. – Romance. Dispatch from Dublin August 23, 2024: the band's fourth album arrived to queues outside Tower Records on Wicklow Street. Grian Chatten's voice has never sounded this intimate, and Favourite is the best song they have written. Rating: 9/10. Comments: 27",
  ],
  [
    "critics roundup with arrow bylines",
    "Critic reviews for Discovery. Pitchfork, by Ryan Schreiber » 13 Mar 2001, 09:00 — 6.4. NME, by John Mulvey » 12 Mar 2001, 12:00 — 8/10. Rolling Stone, by Joshua Klein » 29 Mar 2001, 10:30 — 3.5/5.",
  ],
  [
    "radio station recently-played log",
    "Recently played on Radio Nova: One More Time by Daft Punk » 22 Feb 2021, 15:15 · Midnight City by M83 » 22 Feb 2021, 15:19 · D.A.N.C.E. by Justice » 22 Feb 2021, 15:24 · Pursuit of Happiness by Kid Cudi » 22 Feb 2021, 15:28",
  ],
  [
    "setlist page with song numbers",
    "Daft Punk setlist at Coachella 2006, Apr 29, 2006 #1 Robot Rock / Oh Yeah #2 Steam Machine #3 Around the World / Harder, Better, Faster, Stronger #4 Television Rules the Nation / Crescendolls. Edit setlist. Show stats. 1,245 users attended this show.",
  ],
  [
    "live setlist tracker with clock times",
    "Eras Tour live setlist tracker, Wembley night one. 21 June 2024, 19:55 #1 Miss Americana & The Heartbreak Prince. 21 June 2024, 20:01 #2 Cruel Summer. 21 June 2024, 20:05 #3 The Man. Surprise songs at 21:40.",
  ],
  [
    "label release countdown with weekday times",
    "Ed Banger Records release schedule. Friday at 12:00 AM #1 in our Hyperdrama countdown: Generator. Friday at 12:00 AM #2: One Night/All Night with Tame Impala. Friday at 12:00 AM #3: Neverender.",
  ],
  [
    "news list with ages and comment counts",
    "Latest music news. Justice announce Hyperdrama tour • 2 hours ago • 14 comments. Daft Punk's Discovery gets a 25th anniversary reissue • 1 day ago • 245 comments. Romanthony's estate releases unheard demos • 3 days ago • 31 comments.",
  ],
  [
    "live blog with numbered updates on one day",
    "Daft Punk split: live updates. Update Feb 22, 2021 #1: the duo posted Epilogue, an eight-minute clip from Electroma. Update Feb 22, 2021 #2: their publicist confirmed the split to Pitchfork. Update Feb 23, 2021 #3: tributes from Pharrell and Nile Rodgers.",
  ],
  [
    "video page description with a comment prompt",
    "Daft Punk - Something About Us (Official Video) 12,345,678 views 13 years ago. Music video by Daft Punk performing Something About Us. (C) 2001 Daft Life Ltd. under exclusive license to Parlophone. 245K Like Share Download Clip Save 3,201 Comments Add a comment...",
  ],
  [
    "radio show page with a tracklist and a 2h duration",
    "Gilles Peterson Worldwide, 22 Feb 2021 · 2h · 1,204 plays. Tracklist: Daft Punk – One More Time; Justice – Genesis; Romanthony – Hold On. 12 Reply guy jokes aside, the Daft Punk tribute hour was the show's most shared.",
  ],
  [
    "listicle quoting two one-star reviews",
    "The funniest one-star reviews of classic albums. On Abbey Road: '1.0 out of 5 stars Overrated. Reviewed in the United Kingdom on 3 March 2015.' On Discovery: '1.0 out of 5 stars Robots can't sing. Reviewed in the United States on February 22, 2021.'",
  ],
  [
    "contest news with a level and a bullet age",
    "Eurovision 2024 explained. Switzerland's Nemo won with 591 points 6 months ago. The stage design had level 2 lighting · 3 years ago Loreen used the same rig. Read more • 1y ago",
  ],
  [
    "peaks in two countries as a list",
    "One More Time peaks: France Dec 2, 2000 #1; UK Dec 2, 2000 #2.",
  ],
  [
    "a chart's top two as table rows",
    "The Official Chart, top two: #1 26th February 2000 All Saints – Pure Shores; #2 26th February 2000 Craig David – Fill Me In.",
  ],
  [
    "a dateline with a blog's comment count",
    "News from Paris Feb 22, 2021: Daft Punk have split after 28 years, with a video. Comments: 2",
  ],
  [
    "an author box beside the story's posted stamp",
    "Posted: Feb 22, 2021 3:15 pm. Daft Punk split. About the author: Jane Doe Joined: Mon Mar 03, 2010 Posts: 245. Jane has written about house music since 1997.",
  ],
  [
    "set times after a dash",
    "Festival guide. – Daft Punk Jul 14 at 22:00. – Justice Jul 14 at 20:30.",
  ],
  [
    "set times after a dash with a comment prompt",
    "Festival guide. – Daft Punk Jul 14 at 22:00. – Justice Jul 14 at 20:30. Add a comment",
  ],
  [
    "news with an Instagram embed and an update stamp",
    "Pharrell paid tribute on Instagram. View this post on Instagram A post shared by Pharrell Williams. Add a comment... The label has not commented. — Updated: Feb 22, 2021 at 4:30 PM",
  ],
  [
    "a festival's clashes at one time",
    "Glastonbury 2024 clashes: Coldplay Saturday at 9:00 PM #1 vs SZA Saturday at 9:00 PM #2, and Burna Boy Sunday at 8:00 PM #3.",
  ],
  [
    "a critics' roundup with arrow bylines under a story stamp",
    "Posted: Mar 14, 2001 9:00 am. Critic reviews for Discovery. Pitchfork, by Ryan Schreiber » 13 Mar 2001, 09:00 — 6.4. NME, by John Mulvey » 12 Mar 2001, 12:00 — 8/10.",
  ],
  [
    "one writer's posts with a forum theme's byline",
    "Post by admin » Mon Feb 22, 2021 3:15 pm Discovery turns 20. Post by admin » Tue Feb 23, 2021 9:00 am Homework's Da Funk was a b-side first.",
  ],
  [
    "an advice column's question with a comment prompt",
    "Q. How did Daft Punk get the One More Time vocal? asked Feb 22, 2021 at 10:00 by a reader. A. Through a vocoder and Auto-Tune. Add a comment",
  ],
  [
    "a podcast's episode ages",
    "Episode 12 • 3 years ago: the making of Discovery. Episode 13 • 2 years ago: Romanthony. Listen and Share.",
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

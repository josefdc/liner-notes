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
];
/** A forum piece in a kept excerpt: forumThread decided on it, and the readers must agree. */
const FORUM_PIECE =
  /said:|Click to expand|\d #\d|Joined Mar|Messages: |Originally Posted by|Reply With Quote|Posts: |improve this answer|answered Feb|'21 at|posted by Fan|favorites\]/;

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

/**
 * Forum threads as a search returns them (each page's text on one line), one layout per forum
 * software, with the users' names made up: plain words, as many forums show them.
 */
const FORUM_THREADS: Array<[string, string]> = [
  [
    "a XenForo thread (the Steve Hoffman forums)",
    "Discussion in 'Music Corner' started by RecordFan, Feb 22, 2021. RecordFan Forum Resident Thread Starter Joined: Mar 3, 2010 Messages: 4,512 Daft Punk split today. Feb 22, 2021 #1 DiscoHead Forum Resident Joined: Jun 1, 2012 Messages: 1,203 RecordFan said: ↑ Daft Punk split today. Click to expand... One More Time still holds up.",
  ],
  [
    "XenForo quotes",
    "RecordFan said: ↑ The vocal is Romanthony. Click to expand... Yes, and the sample is More Spell on You. DiscoHead said: The drop is the best part. Click to expand… Agreed.",
  ],
  [
    "a XenForo post header",
    "One More Time still holds up. Feb 22, 2021 #12 DiscoHead Joined: Jun 1, 2012 The sample is More Spell on You.",
  ],
  [
    "a vBulletin thread",
    "Quote: Originally Posted by RecordFan The vocal is Romanthony. Yes, and the sample is More Spell on You. Reply With Quote 02-22-2021, 03:15 PM #3 DiscoHead Join Date: Mar 2005 Posts: 1,234 Still a classic.",
  ],
  [
    "vBulletin quotes",
    "Quote: Originally Posted by RecordFan The vocal is Romanthony. True. Quote: Originally Posted by DiscoHead The drop is great. Agreed.",
  ],
  [
    "a Stack Exchange answer",
    "It samples More Spell on You by Eddie Johns. share | improve this answer | follow edited Feb 22, 2021 at 15:00 answered Feb 21, 2021 at 10:12 Jane Q 1,234 5 12",
  ],
  [
    "a Stack Exchange comment chain",
    "Are you sure? The credits list no sample. – Listener Feb 22 '21 at 16:01 Yes, it was cleared in 2001. – Jane Q Feb 22 '21 at 16:20",
  ],
  [
    "a XenForo 2 thread, its user cards without colons",
    "RecordFan Joined Mar 3, 2010 Messages 4,512 Reaction score 9,000 Feb 22, 2021 #1 The vocal is Romanthony. DiscoHead Joined Jun 1, 2012 Messages 1,203 Feb 22, 2021 #2 RIP.",
  ],
  [
    "a single XenForo quote with its arrow",
    "RecordFan said: ↑ The vocal is Romanthony, I met him in 1999. Click to expand... Yes, and the sample is More Spell on You.",
  ],
  ["a XenForo quote's arrow alone", "RecordFan said: ↑ The vocal is Romanthony."],
  [
    "a MetaFilter thread",
    "Daft Punk have split. posted by member at 6:47 AM on February 22, 2021 [3 favorites] One More Time still sounds like the future. posted by MusicLover at 7:02 AM on February 22, 2021 [12 favorites]",
  ],
];

describe("forum thread layouts", () => {
  it.each(FORUM_THREADS)("leaves out %s on any site, as text or title", (_name, text) => {
    expect(webSearchEvidence([web("https://www.example.org/thread", text)])).toEqual([]);
    expect(webSearchEvidence([web("https://www.example.org/thread", "A page.", text)])).toEqual([]);
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
  [
    "a blog whose theme writes a lowercase byline",
    "Daft Punk split: what One More Time meant. posted by admin at 9:00 AM on February 22, 2021. The Romanthony story. posted by admin at 3:15 PM on February 23, 2021. [2 comments]",
  ],
  [
    "a band's line-up",
    "Line-up. Thomas Bangalter Joined: 1993. Guy-Manuel de Homem-Christo Joined: 1993. Posts: drums, keys. Quote: 'We are robots.' Join Date: 1993.",
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

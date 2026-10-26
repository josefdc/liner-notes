/**
 * What the web tier keeps of a page: never a social platform page, a comment thread or profile
 * boilerplate, and never a private person's @handle in the text it stores. The same check runs
 * on the stored text when an item is written and wherever it is read back (the research cache,
 * stored results, the recorder), so anything the web tier writes is also read back.
 */

import { InMemoryStore } from "@langchain/langgraph";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leaks } from "../../replay/recorder.js";
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
];
/** Pieces of handles, profile boilerplate and comment threads. */
const RISKY = [
  (n: number) => `@fan_${n}x`,
  (n: number) => `@josé.m${n}`,
  (n: number) => `(@band_${n})`,
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

/** The two texts the reviewers found: kept when written, refused when read back. */
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
        "Comments jane_doe: love it! john.smith: same here! mark99: still a banger",
      ),
      web(
        "https://www.example.org/news/one-more-time",
        "One More Time was released in 2000. Producer: Thomas Bangalter. Label: Virgin.",
      ),
    ]);

    expect(items.map((item) => item.url)).toEqual(["https://www.example.org/news/one-more-time"]);
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

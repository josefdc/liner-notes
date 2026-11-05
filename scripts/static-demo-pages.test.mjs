import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  fitDescription,
  homePage,
  isoDuration,
  jsonForScript,
  mapPage,
  relationsOf,
  renderNotFound,
  renderPage,
  shownClaims,
  sitemapXml,
  sourcesOf,
  trackPage,
} from "./static-demo-pages.mjs";

const SITE = "https://example.test/demo";
const ANALYSIS = {
  id: "abc",
  title: "Song <One>",
  artist: "Artist & Co",
  album: "Album",
  releaseYear: "2001",
  isrc: "GBXXX0000001",
  durationSeconds: 320,
  spotifyUrl: "https://open.spotify.com/track/abc",
  genealogy: {
    nodes: [
      { id: "current", trackTitle: "Song", trackArtist: "Artist", year: 2000 },
      { id: "up", trackTitle: "Older", trackArtist: "Elder", year: 1979 },
      { id: "down", trackTitle: "Newer", trackArtist: "Younger", year: 2010 },
      { id: "guess", label: "Guess", year: 1990 },
    ],
    links: [
      { source: "guess", target: "current", type: "influence", kind: "inferred" },
      { source: "current", target: "down", type: "sample", kind: "sourced" },
      { source: "up", target: "current", type: "sample", kind: "sourced" },
      { source: "up", target: "down", type: "sample", kind: "sourced" },
    ],
  },
  claims: [
    { text: "Kept claim", kind: "sourced", verdict: "supported" },
    { text: "Rejected claim", kind: "inferred", verdict: "contradicted" },
  ],
  evidence: [
    { url: "https://musicbrainz.org/recording/1", title: "A record" },
    { url: "https://musicbrainz.org/recording/1", title: "The same record" },
    { title: "No address" },
  ],
  audio: {
    tempo: { bpm: 122.86 },
    loudness: { rmsMean: 0.187354 },
    window: { durationSeconds: 29.99 },
  },
  run: { recordedAt: "2026-10-31T20:22:06.229Z" },
};
const TEMPLATE =
  '<html><head><title>Old</title>\n<meta name="description" content="old" />\n' +
  '<meta property="og:title" content="old" /></head><body><div id="root"></div></body></html>';

describe("the text of a page", () => {
  it("escapes what it writes", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    expect(jsonForScript({ a: "</script>" })).toBe('{"a":"\\u003c/script>"}');
  });

  it("cuts a description at a word", () => {
    expect(fitDescription("short  text")).toBe("short text");
    const cut = fitDescription(`${"word ".repeat(50)}`, 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("word…")).toBe(true);
  });

  it("writes a duration as ISO 8601", () => {
    expect(isoDuration(320)).toBe("PT5M20S");
  });
});

describe("what a result gives a page", () => {
  it("lists the track's own relations, sourced and sampled ones first", () => {
    expect(relationsOf(ANALYSIS).map((row) => row.title)).toEqual(["Older", "Newer", "Guess"]);
    expect(relationsOf(ANALYSIS)[0]).toMatchObject({ upstream: true, kind: "sourced" });
  });

  it("leaves out the claims found contradicted and repeated sources", () => {
    expect(shownClaims(ANALYSIS).map((claim) => claim.text)).toEqual(["Kept claim"]);
    expect(sourcesOf(ANALYSIS).map((item) => item.title)).toEqual(["A record"]);
  });
});

describe("the pages", () => {
  it("gives a track's page its own address, title and recording data", () => {
    const page = trackPage(SITE, ANALYSIS);
    expect(page.path).toBe("t/abc/index.html");
    expect(page.url).toBe(`${SITE}/t/abc/`);
    expect(page.title).toContain("samples, credits and history");
    expect(page.description.length).toBeLessThanOrEqual(155);
    expect(page.description).toContain("draws on “Older” by Elder");
    expect(page.data).toMatchObject({
      "@type": "MusicRecording",
      isrcCode: "GBXXX0000001",
      duration: "PT5M20S",
    });
    expect(page.article).toContain("Song &lt;One&gt; by Artist &amp; Co");
    expect(page.article).toContain("tempo 122.9 BPM, loudness -14.5 dBFS RMS");
    expect(page.article).toContain("Kept claim [sourced]");
    expect(page.article).not.toContain("Rejected claim");
  });

  it("gives the map its own address and links back to the notes", () => {
    const page = mapPage(SITE, ANALYSIS);
    expect(page.path).toBe("t/abc/map/index.html");
    expect(page.url).toBe(`${SITE}/t/abc/map/`);
    expect(page.article).toContain(`href="${SITE}/t/abc/"`);
  });

  it("lists the recorded tracks on the first page", () => {
    const page = homePage(SITE, [ANALYSIS]);
    expect(page.path).toBe("index.html");
    expect(page.data["@type"]).toBe("SoftwareSourceCode");
    expect(page.article).toContain(`href="${SITE}/t/abc/"`);
  });

  it("replaces the template's head and fills its root", () => {
    const html = renderPage(TEMPLATE, trackPage(SITE, ANALYSIS));
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).not.toContain("<title>Old");
    expect(html).not.toContain('content="old"');
    expect(html).toContain(`<link rel="canonical" href="${SITE}/t/abc/" />`);
    expect(html).toContain(`<meta property="og:image" content="${SITE}/og/abc.png" />`);
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('<div id="root"><article class="static-article">');
  });

  it("keeps the not-found page out of indexes", () => {
    expect(renderNotFound(TEMPLATE, SITE)).toContain('<meta name="robots" content="noindex" />');
  });

  it("lists the pages in the sitemap", () => {
    const xml = sitemapXml([trackPage(SITE, ANALYSIS)], "2026-11-05");
    expect(xml).toContain(`<loc>${SITE}/t/abc/</loc><lastmod>2026-11-05</lastmod>`);
  });
});

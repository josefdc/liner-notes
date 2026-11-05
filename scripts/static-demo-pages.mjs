// The static demo's pages, as text: for each address, the head a crawler or a link preview reads
// and a plain article with what the page shows, read by search engines and by a visitor without
// JavaScript (scripts/build-static-demo.mjs writes the files). The app replaces the article when it
// starts. Everything here comes from a recorded result; nothing is written by hand per track.

const SITE_NAME = "Liner Notes";
export const SITE_DESCRIPTION =
  "Open-source AI agent that traces a song's samples, credits and history, and labels every " +
  "claim as measured, sourced or inferred. Try the live demo.";
const REPOSITORY = "https://github.com/josefdc/liner-notes";
const DESCRIPTION_LIMIT = 155;

const RELATION_WORDS = {
  sample: "Sample",
  cover: "Cover",
  remix: "Remix",
  interpolation: "Interpolation",
  influence: "Influence",
};

/** `text` safe inside HTML text and attribute values. */
export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A value as JSON safe inside a script element. */
export function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** `text` cut at a word to fit a search result's description. */
export function fitDescription(text, limit = DESCRIPTION_LIMIT) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > 0 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** An ISO 8601 duration of `seconds`. */
export function isoDuration(seconds) {
  const whole = Math.round(seconds);
  return `PT${Math.floor(whole / 60)}M${whole % 60}S`;
}

/** The links of a result's map, each with the track on its other side, the sampled ones first. */
export function relationsOf(analysis) {
  const nodes = new Map(analysis.genealogy.nodes.map((node) => [node.id, node]));
  const rows = [];
  for (const link of analysis.genealogy.links) {
    const upstream = link.target === "current";
    const other = nodes.get(upstream ? link.source : link.target);
    if (!other || (link.source !== "current" && link.target !== "current")) continue;
    rows.push({
      type: link.type,
      kind: link.kind,
      upstream,
      title: other.trackTitle ?? other.label,
      artist: other.trackArtist ?? null,
      year: other.year ?? null,
    });
  }
  const rank = (row) => (row.kind === "sourced" ? 0 : 2) + (row.upstream ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/** The claims a page shows as notes: none the verifier found contradicted. */
export function shownClaims(analysis) {
  return analysis.claims.filter((claim) => claim.verdict !== "contradicted");
}

/** The sources a result cites, once each. */
export function sourcesOf(analysis) {
  const seen = new Map();
  for (const item of analysis.evidence) {
    if (item.url && !seen.has(item.url)) seen.set(item.url, item);
  }
  return [...seen.values()];
}

/** A one-line account of a relation, as the page's description and article use it. */
function relationLine(row) {
  const who = row.artist ? `“${row.title}” by ${row.artist}` : `“${row.title}”`;
  const year = row.year ? ` (${row.year})` : "";
  const word = RELATION_WORDS[row.type] ?? row.type;
  return row.upstream ? `${word} of ${who}${year}` : `${word}: ${who}${year}`;
}

/** The dBFS of a mean RMS, as the page gives it. */
function dbfs(rms) {
  return (20 * Math.log10(rms)).toFixed(1);
}

function trackSummary(analysis) {
  const relations = relationsOf(analysis);
  const claims = shownClaims(analysis);
  const lead = relations.find((row) => row.upstream && row.kind === "sourced");
  const opening = lead
    ? `${analysis.title} by ${analysis.artist} draws on “${lead.title}”${lead.artist ? ` by ${lead.artist}` : ""}.`
    : `${analysis.title} by ${analysis.artist}.`;
  return fitDescription(
    `${opening} ${relations.length} song relations and ${claims.length} claims, each labelled ` +
      "measured, sourced or inferred, with the records behind them.",
  );
}

function listItems(items) {
  return items.map((item) => `<li>${item}</li>`).join("");
}

function relationsSection(analysis, heading) {
  const relations = relationsOf(analysis);
  if (relations.length === 0) return "";
  return (
    `<h2>${heading}</h2><ul>` +
    listItems(relations.map((row) => `${escapeHtml(relationLine(row))} [${row.kind}]`)) +
    "</ul>"
  );
}

function measuredLine(analysis) {
  const parts = [];
  const { tempo, loudness, window: clip } = analysis.audio ?? {};
  if (tempo?.bpm) parts.push(`tempo ${tempo.bpm.toFixed(1)} BPM`);
  if (loudness?.rmsMean) parts.push(`loudness ${dbfs(loudness.rmsMean)} dBFS RMS`);
  if (parts.length === 0) return "";
  const from = clip?.durationSeconds ? ` from a ${Math.round(clip.durationSeconds)} s preview` : "";
  return `<p>Measured${from}: ${parts.join(", ")}.</p>`;
}

function recordedLine(analysis) {
  const when = analysis.run?.recordedAt?.slice(0, 10);
  return `<p>Recorded run${when ? ` of ${when}` : ""}, replayed in the browser with no model calls.</p>`;
}

function nav(site, entries) {
  const links = entries.map(
    ({ href, text }) =>
      `<a href="${escapeHtml(new URL(href, `${site}/`).href)}">${escapeHtml(text)}</a>`,
  );
  return `<nav>${links.join(" · ")}</nav>`;
}

function trackLinks(track, current) {
  return [
    { href: "./", text: SITE_NAME, skip: false },
    { href: `t/${track.id}/`, text: `${track.title}: notes`, skip: current === "track" },
    { href: `t/${track.id}/map/`, text: `${track.title}: map`, skip: current === "map" },
    { href: REPOSITORY, text: "Source code", skip: false },
  ].filter((entry) => !entry.skip);
}

/** The JSON-LD of a recording. */
function recordingData(analysis, url) {
  return {
    "@context": "https://schema.org",
    "@type": "MusicRecording",
    name: analysis.title,
    url,
    byArtist: { "@type": "MusicGroup", name: analysis.artist },
    ...(analysis.album && { inAlbum: { "@type": "MusicAlbum", name: analysis.album } }),
    ...(analysis.releaseYear && { datePublished: analysis.releaseYear }),
    ...(analysis.isrc && { isrcCode: analysis.isrc }),
    ...(analysis.durationSeconds && { duration: isoDuration(analysis.durationSeconds) }),
    ...(analysis.spotifyUrl && { sameAs: [analysis.spotifyUrl] }),
  };
}

/** What a track's address holds: its head and its article. */
export function trackPage(site, analysis) {
  const url = `${site}/t/${analysis.id}/`;
  const sources = sourcesOf(analysis);
  const notes = shownClaims(analysis).map((claim) => `${escapeHtml(claim.text)} [${claim.kind}]`);
  return {
    path: `t/${analysis.id}/index.html`,
    url,
    title: `${analysis.title} by ${analysis.artist}: samples, credits and history | ${SITE_NAME}`,
    description: trackSummary(analysis),
    image: `${site}/og/${analysis.id}.png`,
    data: recordingData(analysis, url),
    article:
      `<h1>${escapeHtml(analysis.title)} by ${escapeHtml(analysis.artist)}</h1>` +
      `<p>${[analysis.album, analysis.releaseYear].filter(Boolean).map(escapeHtml).join(", ")}</p>` +
      recordedLine(analysis) +
      measuredLine(analysis) +
      relationsSection(analysis, "Song relations") +
      (notes.length ? `<h2>Notes, with how each is known</h2><ul>${listItems(notes)}</ul>` : "") +
      (sources.length
        ? `<h2>Sources</h2><ul>${listItems(
            sources.map(
              (item) =>
                `<a href="${escapeHtml(item.url)}" rel="nofollow noopener">${escapeHtml(item.title ?? item.url)}</a>`,
            ),
          )}</ul>`
        : "") +
      nav(site, trackLinks(analysis, "track")),
  };
}

/** What a track's map address holds. */
export function mapPage(site, analysis) {
  const url = `${site}/t/${analysis.id}/map/`;
  const count = relationsOf(analysis).length;
  return {
    path: `t/${analysis.id}/map/index.html`,
    url,
    title: `${analysis.title} by ${analysis.artist}: song relations map | ${SITE_NAME}`,
    description: fitDescription(
      `The samples, covers and remixes around ${analysis.title} by ${analysis.artist} on a ` +
        `timeline: ${count} relations, each sourced from a record or labelled inferred.`,
    ),
    image: `${site}/og/${analysis.id}.png`,
    data: recordingData(analysis, url),
    article:
      `<h1>Song relations map: ${escapeHtml(analysis.title)} by ${escapeHtml(analysis.artist)}</h1>` +
      recordedLine(analysis) +
      relationsSection(analysis, "Relations on the map") +
      nav(site, trackLinks(analysis, "map")),
  };
}

/** What the demo's first address holds. */
export function homePage(site, analyses) {
  const url = `${site}/`;
  return {
    path: "index.html",
    url,
    title: `${SITE_NAME}: trace a song's samples, credits and history, with evidence`,
    description: fitDescription(SITE_DESCRIPTION),
    image: `${site}/og/home.png`,
    data: {
      "@context": "https://schema.org",
      "@type": "SoftwareSourceCode",
      name: SITE_NAME,
      url,
      description: SITE_DESCRIPTION,
      codeRepository: REPOSITORY,
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      programmingLanguage: ["TypeScript", "Python"],
      author: { "@type": "Person", name: "Jose Felipe Duarte", url: "https://github.com/josefdc" },
    },
    article:
      `<h1>${SITE_NAME}</h1><p>${escapeHtml(SITE_DESCRIPTION)}</p>` +
      "<h2>Recorded tracks in this demo</h2><ul>" +
      listItems(
        analyses.map(
          (analysis) =>
            `<a href="${escapeHtml(`${site}/t/${analysis.id}/`)}">${escapeHtml(analysis.title)} by ${escapeHtml(analysis.artist)}</a>`,
        ),
      ) +
      "</ul>" +
      nav(site, [{ href: REPOSITORY, text: "Source code" }]),
  };
}

function headTags(page) {
  return [
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(page.url)}" />`,
    `<meta name="theme-color" content="#050505" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeHtml(page.url)}" />`,
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:image" content="${escapeHtml(page.image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<script type="application/ld+json">${jsonForScript(page.data)}</script>`,
  ].join("\n    ");
}

// The article stays hidden for a moment: on a normal load the app replaces it before it shows, and
// on a slow one, or without JavaScript, it appears by itself.
const ARTICLE_STYLE =
  "<style>.static-article{max-width:44rem;margin:0 auto;padding:2rem 1rem;color:#fff;" +
  "font:16px/1.6 Inter,system-ui,sans-serif;opacity:0;animation:static-article 0s 1.5s forwards}" +
  ".static-article h1{font-size:2rem;line-height:1.2}.static-article h2{font-size:1.15rem;margin-top:2rem}" +
  ".static-article a{color:#00f0ff}@keyframes static-article{to{opacity:1}}</style>";

/** The built page `template` as the file of `page`. */
export function renderPage(template, page) {
  const withoutOldHead = template
    .replace(/\s*<title>[\s\S]*?<\/title>/, "")
    .replace(/\s*<meta name="description"[^>]*>/, "")
    .replace(/\s*<meta property="og:[^>]*>/g, "");
  const withHead = withoutOldHead.replace(
    "</head>",
    `    ${headTags(page)}\n    ${ARTICLE_STYLE}\n  </head>`,
  );
  return withHead.replace(
    '<div id="root"></div>',
    `<div id="root"><article class="static-article">${page.article}</article></div>`,
  );
}

/** The address not found page: the app, which says what it can do, marked to stay out of indexes. */
export function renderNotFound(template, site) {
  const page = {
    path: "404.html",
    url: `${site}/`,
    title: `Page not found | ${SITE_NAME}`,
    description: fitDescription(SITE_DESCRIPTION),
    image: `${site}/og/home.png`,
    data: { "@context": "https://schema.org", "@type": "WebPage", name: SITE_NAME },
    article: `<h1>${SITE_NAME}</h1><p>This address holds no page.</p>`,
  };
  return renderPage(template, page).replace(
    "</head>",
    '  <meta name="robots" content="noindex" />\n  </head>',
  );
}

/** The sitemap of `pages`. */
export function sitemapXml(pages, lastModified) {
  const urls = pages.map(
    (page) => `  <url><loc>${escapeHtml(page.url)}</loc><lastmod>${lastModified}</lastmod></url>`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${urls.join("\n")}\n</urlset>\n`
  );
}

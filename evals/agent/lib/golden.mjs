// Reading the golden set (evals/golden.jsonl) for the agent evals: rows, the file's sha256, the
// live subset and the CI replay subset, and the gold targets of a row (one per distinct target,
// however many sources back it; see evals/README.md, "Scoring edges").

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { artistMatches, titleMatches } from "../../scripts/coverage.mjs";

export const EVALS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_ROOT = resolve(EVALS_DIR, "..");
export const GOLDEN_PATH = resolve(EVALS_DIR, "golden.jsonl");

export const STRATA = [
  "documented-samples",
  "no-sample-controls",
  "ambiguous-titles",
  "non-english",
  "obscure",
];
export const RELATIONS = ["sample", "interpolation", "cover"];

/**
 * The CI replay subset: six live rows that cover every scored path (documented samples with
 * held-out edges, a no-sample control, an ambiguous title that needs the clarification step, and
 * a non-English title).
 */
export const CI_SUBSET = [
  "GBDUW0000053", // One More Time, Daft Punk
  "USBB40000359", // Juicy, The Notorious B.I.G.
  "GBAAA9700049", // Bitter Sweet Symphony, The Verve
  "USWB19900178", // Dreams, Fleetwood Mac
  "USDJ20200650", // Hurt, Johnny Cash
  "JPP301900716", // 夜に駆ける, YOASOBI
];

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** Reads and checks the golden file. Throws with every problem found, one per line. */
export function readGolden(path = GOLDEN_PATH) {
  const text = readFileSync(path, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const problems = [];
  const rows = [];
  const seen = new Set();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      problems.push(`line ${i + 1}: not JSON (${error.message})`);
      return;
    }
    if (!ISRC_RE.test(row.isrc ?? "")) problems.push(`line ${i + 1}: bad isrc ${row.isrc}`);
    else if (seen.has(row.isrc)) problems.push(`line ${i + 1}: duplicate isrc ${row.isrc}`);
    seen.add(row.isrc);
    if (!STRATA.includes(row.stratum)) {
      problems.push(`line ${i + 1}: unknown stratum ${row.stratum}`);
    }
    if (!row.labels || !Array.isArray(row.labels.edges)) {
      problems.push(`line ${i + 1}: labels.edges missing`);
    }
    rows.push(row);
  });
  if (problems.length) throw new Error(`invalid golden file ${path}:\n${problems.join("\n")}`);
  return { path, sha256, rows };
}

export const liveRows = (golden) => golden.rows.filter((r) => r.liveSubset);

/** The rows a `--subset` names: `ci` (CI_SUBSET) or `all` (the live subset). */
export function subsetRows(golden, subset) {
  if (subset === "all") return liveRows(golden);
  if (subset === "ci") {
    const byIsrc = new Map(golden.rows.map((r) => [r.isrc, r]));
    return CI_SUBSET.map((isrc) => {
      const row = byIsrc.get(isrc);
      if (!row?.liveSubset) throw new Error(`CI subset row ${isrc} is not a live golden row`);
      return row;
    });
  }
  throw new Error(`unknown subset "${subset}" (ci or all)`);
}

/** Host name, lower case, without "www." or a trailing dot. */
export const host = (url) =>
  new URL(url).hostname
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^www\./, "");

// Second-level labels under a two-letter country code that are not a site of their own
// (news.bbc.co.uk is bbc.co.uk).
const SHARED_SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);

const siteOfHost = (h) => {
  const labels = h.split(".");
  if (labels.length <= 2) return labels.join(".");
  const tld = labels.at(-1);
  const second = labels.at(-2);
  const take = tld.length === 2 && SHARED_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
};

/**
 * The site a URL belongs to: its registrable domain (en.wikipedia.org and de.wikipedia.org are
 * both wikipedia.org; news.bbc.co.uk is bbc.co.uk).
 */
export const site = (url) => siteOfHost(host(url));

/** What citedSite returns for a page whose site cannot be known offline: it cites every site. */
export const ANY_SITE = "*";
const SHORTENERS = new Set(
  "bit.ly t.co tinyurl.com goo.gl ow.ly buff.ly is.gd lnkd.in rebrand.ly cutt.ly rb.gy tiny.cc shorturl.at".split(
    " ",
  ),
);
const ARCHIVE_TODAY = new Set(
  "archive.ph archive.is archive.today archive.li archive.vn archive.md archive.fo".split(" "),
);

/** The original URL inside an archive or cache URL ("…/web/2020/https://x/…"), or null. */
function wrapped(u, h) {
  const inner = `${u.pathname}${u.search}`.match(/(https?):\/\/?(.+)$/i);
  const unwrap = inner ? `${inner[1]}://${inner[2]}` : null;
  if (h === "web.archive.org" || h === "archive.org" || h === "wayback.archive.org") return unwrap;
  if (ARCHIVE_TODAY.has(h)) return unwrap;
  if (h === "webcache.googleusercontent.com") {
    const q = u.searchParams
      .get("q")
      ?.replace(/^cache:[^:]*:/, "")
      .replace(/^cache:/, "");
    return q ? (/^https?:/i.test(q) ? q : `https://${q}`) : null;
  }
  // Google Translate's proxy: en-m-wikipedia-org.translate.goog is en.m.wikipedia.org.
  if (h.endsWith(".translate.goog")) return `https://${decodeLabel(h.split(".")[0])}${u.pathname}`;
  if (/^translate\.google\.[a-z.]+$/.test(h) || h === "translate.googleusercontent.com") {
    const inner = u.searchParams.get("u") ?? u.searchParams.get("url");
    return inner ? (/^https?:/i.test(inner) ? inner : `https://${inner}`) : null;
  }
  // AMP caches: www-latimes-com.cdn.ampproject.org/c/s/www.latimes.com/x.
  if (h.endsWith(".cdn.ampproject.org") || h.endsWith(".ampproject.net")) {
    const path = u.pathname.match(/^\/(?:[cvi]\/)?(?:s\/)?([^/]+\.[^/]+)(\/.*)?$/);
    return path
      ? `https://${path[1]}${path[2] ?? "/"}`
      : `https://${decodeLabel(h.split(".")[0])}/`;
  }
  return undefined; // not a wrapper
}

/** A proxy's encoded host label ("www-latimes-com") as the host ("www.latimes.com"). */
const decodeLabel = (label) => label.replace(/--/g, "\0").replace(/-/g, ".").replace(/\0/g, "-");

// Mirrors that republish another site's pages under their own host.
const MIRRORS = new Map([
  ["wikiwand.com", "wikipedia.org"],
  ["wikiwand.org", "wikipedia.org"],
  ["wiki2.org", "wikipedia.org"],
  ["wikizero.com", "wikipedia.org"],
  ["everybodywiki.com", "wikipedia.org"],
]);

// A path or query that carries another URL: a proxy or wrapper the rule does not know.
const EMBEDS_URL =
  /(?:https?:\/\/|https?%3a%2f%2f|[=/](?:www\.|[a-z0-9-]+\.(?:com|org|net|co\.uk)\/))/i;

/**
 * The site a cited page counts as, failing closed for the held-out rule: an archive, cache,
 * translation proxy or AMP copy counts as the page it copies, and a Wikipedia mirror (Wikiwand…)
 * as Wikipedia; a URL that cannot be parsed, a host with no dot, a link shortener, a wrapper
 * whose original cannot be read offline, or any other URL whose path or query carries another
 * URL counts as citing every site (ANY_SITE).
 */
export function citedSite(url) {
  let u;
  try {
    const text = String(url ?? "").trim();
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return ANY_SITE;
  }
  const h = u.hostname
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^www\./, "");
  if (!h.includes(".") || SHORTENERS.has(h)) return ANY_SITE;
  const inner = wrapped(u, h);
  if (inner === null) return ANY_SITE;
  if (inner !== undefined) return citedSite(inner);
  if (EMBEDS_URL.test(`${u.pathname}${u.search}`)) return ANY_SITE;
  const s = siteOfHost(h);
  return MIRRORS.get(s) ?? s;
}

/** Do two record descriptions name the same recording (ISRC or MBID, else title and artist)? */
export function sameRecording(gold, proposed) {
  if (gold.isrc && proposed.isrc && gold.isrc === proposed.isrc) return true;
  if (gold.mbid && proposed.mbid && gold.mbid === proposed.mbid) return true;
  if (!proposed.title || !proposed.artist) return false;
  return titleMatches(gold.title, proposed.title) && artistMatches(gold.artist, [proposed.artist]);
}

/**
 * The gold targets of a row: edges grouped by target. Each target keeps every relation its
 * sources accept and every source edge (with its site and held-out flag).
 */
export function goldTargets(row) {
  const targets = [];
  for (const edge of row.labels.edges) {
    let target = targets.find((t) => sameRecording(t.target, edge.target));
    if (!target) {
      target = {
        key: `${row.isrc}→${edge.target.title} / ${edge.target.artist}`,
        target: { ...edge.target },
        relations: new Set(),
        sources: [],
      };
      targets.push(target);
    }
    for (const field of ["isrc", "mbid"]) {
      if (!target.target[field] && edge.target[field]) target.target[field] = edge.target[field];
    }
    target.relations.add(edge.relation);
    for (const r of edge.relationAlternatives ?? []) target.relations.add(r);
    target.sources.push({
      url: edge.sourceUrl,
      site: site(edge.sourceUrl),
      heldOut: edge.sourceQueriedByPipeline === false,
      retrieved: edge.retrieved,
    });
  }
  return targets;
}

/** The documented relations gold deliberately does not score (left out of precision). */
export const otherDocumented = (row) => row.labels.otherDocumentedTargets ?? [];

/**
 * Where gold comes from, for the report: the sites its edges and control checks cite, with the
 * range of retrieval dates. Gold is described by its sources, never as human-labelled.
 */
export function goldSources(rows) {
  const bySite = new Map();
  const add = (url, retrieved) => {
    const s = site(url);
    const entry = bySite.get(s) ?? { site: s, refs: 0, first: retrieved, last: retrieved };
    entry.refs++;
    if (retrieved < entry.first) entry.first = retrieved;
    if (retrieved > entry.last) entry.last = retrieved;
    bySite.set(s, entry);
  };
  for (const row of rows) {
    for (const e of row.labels.edges) add(e.sourceUrl, e.retrieved);
    for (const s of row.labels.noSampleSources ?? []) add(s.sourceUrl, s.retrieved);
  }
  return [...bySite.values()].sort(
    (a, b) => b.refs - a.refs || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0),
  );
}

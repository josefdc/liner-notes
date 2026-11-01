// Writes evals/showcase-styles.json: each golden-run row's style, as MusicBrainz's genre votes
// give it, so the showcase can be chosen across styles without reading model text or the audio
// service's style classifier.
//
//   node evals/agent/fetch-styles.mjs [--out evals/showcase-styles.json]
//
// The one script under evals/agent that reads the network, and only MusicBrainz's public API
// (keyless, https://musicbrainz.org/ws/2/…&fmt=json): at most one request per second, with a
// User-Agent naming the project, and one retry after a 503. It is run by hand and its output is
// committed; CI and the tests read the committed file and never run this.
//
// The rule, for each row of the golden set's live subset (the rows the golden run analysed), by
// the row's gold MusicBrainz recording:
//   1. the recording's own genres;
//   2. else the genres of the release group of the recording's earliest release (every release
//      of the recording, browsed 100 at a time; the earliest release date, a release with no
//      date last, ties by release-group id);
//   3. else the genres of the recording's first credited artist.
// At the first level with a genre that has at least one vote, the style is its top-voted genre
// (ties by name), kept with the level, its vote count and the URL of the lookup that gave it. A
// row with no genre at any level is kept with a null style. Each row keeps every lookup it made,
// in order: its URL, how many requests it took (a retry after a 503 counts), and what the rule
// read of it (a genre lookup's whole genre list, name and vote count, as MusicBrainz answered
// it; a page of releases, how many it held and the earliest release group so far), so the
// choice can be checked again from the committed file alone. The file's `requests` counts every
// request sent, retries included.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { liveRows, readGolden, REPO_ROOT } from "./lib/golden.mjs";

export const STYLES_PATH = join(REPO_ROOT, "evals/showcase-styles.json");
export const MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
export const USER_AGENT = "liner-notes-evals/0.1 ( https://github.com/josefdc/liner-notes )";
export const SPACING_MS = 1100;
const RETRY_AFTER_MS = 3000;
const TIMEOUT_MS = 20_000;
const MAX_RELEASES = 2000;

export const recordingUrl = (mbid) =>
  `${MUSICBRAINZ_API}/recording/${mbid}?inc=genres+artist-credits&fmt=json`;
/** The recording's releases, a page of 100 (a lookup's linked releases stop at 25). */
export const releasesUrl = (mbid, offset = 0) =>
  `${MUSICBRAINZ_API}/release?recording=${mbid}&inc=release-groups&limit=100&offset=${offset}&fmt=json`;
export const releaseGroupUrl = (mbid) =>
  `${MUSICBRAINZ_API}/release-group/${mbid}?inc=genres&fmt=json`;
export const artistUrl = (mbid) => `${MUSICBRAINZ_API}/artist/${mbid}?inc=genres&fmt=json`;

/** A MusicBrainz entity's genres as the file keeps them: name and vote count, as answered. */
export const genreList = (entity) =>
  (entity?.genres ?? []).map((genre) => ({
    name: genre?.name ?? null,
    count: genre?.count ?? null,
  }));

/** The top-voted genre of a MusicBrainz entity (ties by name), or null when none has a vote. */
export function topGenre(entity) {
  const genres = (entity?.genres ?? []).filter(
    (g) => typeof g?.name === "string" && g.name.trim() && Number.isInteger(g.count) && g.count > 0,
  );
  genres.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return genres.length ? { name: genres[0].name, count: genres[0].count } : null;
}

/**
 * The release-group id of the earliest of a recording's releases (MusicBrainz release objects): the earliest date ("1997" before
 * "1997-06-01" before "1998"), a release with no date last, ties by release-group id; null when
 * no release names its group.
 */
export function earliestReleaseGroup(releaseList) {
  const releases = (releaseList ?? []).filter((r) => r?.["release-group"]?.id);
  const key = (r) => (typeof r.date === "string" && r.date ? r.date : "9999");
  releases.sort((a, b) => {
    const [da, db] = [key(a), key(b)];
    if (da !== db) return da < db ? -1 : 1;
    const [ga, gb] = [a["release-group"].id, b["release-group"].id];
    return ga < gb ? -1 : ga > gb ? 1 : 0;
  });
  return releases[0]?.["release-group"].id ?? null;
}

/** The recording's first credited artist's id, or null. */
export const firstArtist = (recording) => recording?.["artist-credit"]?.[0]?.artist?.id ?? null;

/**
 * One row's style entry, from a `get(url)` that answers a MusicBrainz lookup's JSON. Pure but for
 * `get`; `retrievedAt` is the time the entry's last lookup answered.
 */
export async function styleEntry(row, get, now = () => new Date().toISOString()) {
  const base = { isrc: row.isrc, mbid: row.mbid, title: row.title, artist: row.artist };
  const lookups = [];
  const read = async (url) => {
    const lookup = { url };
    lookups.push(lookup);
    const body = await get(url);
    if (url.includes("inc=genres")) lookup.genres = genreList(body);
    else lookup.releases = (body?.releases ?? []).length;
    return body;
  };
  const found = (level, genre, url) => ({
    ...base,
    style: genre.name,
    level,
    votes: genre.count,
    url,
    retrievedAt: now(),
    lookups,
  });

  const recUrl = recordingUrl(row.mbid);
  const recording = await read(recUrl);
  const own = topGenre(recording);
  if (own) return found("recording", own, recUrl);
  const releases = [];
  for (let offset = 0; ; ) {
    const page = await read(releasesUrl(row.mbid, offset));
    const list = page?.releases ?? [];
    releases.push(...list);
    offset += list.length;
    if (list.length === 0 || offset >= (page?.["release-count"] ?? 0)) break;
    if (offset >= MAX_RELEASES) throw new Error(`${row.isrc}: more than ${MAX_RELEASES} releases`);
  }
  const group = earliestReleaseGroup(releases);
  lookups.at(-1).earliestReleaseGroup = group;
  if (group) {
    const url = releaseGroupUrl(group);
    const genre = topGenre(await read(url));
    if (genre) return found("release-group", genre, url);
  }
  const artist = firstArtist(recording);
  if (artist) {
    const url = artistUrl(artist);
    const genre = topGenre(await read(url));
    if (genre) return found("artist", genre, url);
  }
  return { ...base, style: null, level: null, votes: null, url: null, retrievedAt: now(), lookups };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * A paced MusicBrainz client: one request per SPACING_MS, one retry after a 503. `requests()`
 * counts every request sent, retries included; `requestsOf(url)`, those sent for one URL.
 */
export function musicBrainzClient({
  fetchImpl = fetch,
  spacing = SPACING_MS,
  retryAfter = RETRY_AFTER_MS,
} = {}) {
  let last = 0;
  let requests = 0;
  const byUrl = new Map();
  async function once(url) {
    const wait = last + spacing - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    requests++;
    byUrl.set(url, (byUrl.get(url) ?? 0) + 1);
    return fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  }
  async function get(url) {
    if (!url.startsWith(`${MUSICBRAINZ_API}/`))
      throw new Error(`not a MusicBrainz API URL: ${url}`);
    let res = await once(url);
    if (res.status === 503) {
      await sleep(retryAfter);
      res = await once(url);
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  return { get, requests: () => requests, requestsOf: (url) => byUrl.get(url) ?? 0 };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { values } = parseArgs({ options: { out: { type: "string", default: STYLES_PATH } } });
  const golden = readGolden();
  const client = musicBrainzClient();
  const rows = [];
  for (const row of liveRows(golden)) {
    const entry = await styleEntry(row, client.get);
    for (const lookup of entry.lookups) lookup.requests = client.requestsOf(lookup.url);
    rows.push(entry);
    console.log(
      `${row.isrc} ${row.title}: ${entry.style ?? "no genre"}` +
        (entry.level ? ` (${entry.level}, ${entry.votes} votes)` : ""),
    );
  }
  const file = {
    version: 1,
    source:
      "MusicBrainz genre votes (https://musicbrainz.org/ws/2, inc=genres), read by evals/agent/fetch-styles.mjs",
    rule: "the top-voted genre of the gold recording, else of the release group of its earliest release, else of its first credited artist",
    golden: { sha256: golden.sha256 },
    requests: client.requests(),
    rows,
  };
  writeFileSync(resolve(values.out), `${JSON.stringify(file, null, 2)}\n`);
  const missing = rows.filter((r) => r.style === null).map((r) => r.isrc);
  const lookups = rows.reduce((n, r) => n + r.lookups.length, 0);
  console.log(
    `${client.requests()} requests (${lookups} lookups, ${client.requests() - lookups} retries); ${rows.length} rows; without a genre: ${missing.length ? missing.join(", ") : "none"}`,
  );
}

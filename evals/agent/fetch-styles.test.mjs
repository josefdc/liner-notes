import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artistUrl,
  earliestReleaseGroup,
  musicBrainzClient,
  recordingUrl,
  releaseGroupUrl,
  releasesUrl,
  styleEntry,
  topGenre,
  USER_AGENT,
} from "./fetch-styles.mjs";

const ROW = { isrc: "GBAAA0000001", mbid: "rec-1", title: "Song", artist: "Band" };
const NOW = () => "2026-10-31T00:00:00.000Z";

/** A get() over fixed answers by URL; an unknown URL fails the test. */
function answers(map) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    if (!(url in map)) throw new Error(`unexpected ${url}`);
    return map[url];
  };
  return { get, asked };
}

test("topGenre takes the most votes, ties by name, and ignores genres without a vote", () => {
  assert.deepEqual(
    topGenre({
      genres: [
        { name: "rock", count: 2 },
        { name: "britpop", count: 3 },
        { name: "alternative rock", count: 3 },
        { name: "pop", count: 0 },
      ],
    }),
    { name: "alternative rock", count: 3 },
  );
  assert.equal(topGenre({ genres: [{ name: "pop", count: 0 }] }), null);
  assert.equal(topGenre({}), null);
});

test("earliestReleaseGroup orders by date, puts undated releases last and ties by group id", () => {
  const rel = (date, group) => ({ date, "release-group": { id: group } });
  assert.equal(earliestReleaseGroup([rel("1998", "b"), rel("1997-06-01", "c"), rel("", "a")]), "c");
  assert.equal(earliestReleaseGroup([rel("1997", "z"), rel("1997", "y")]), "y");
  assert.equal(earliestReleaseGroup([rel("", "q")]), "q");
  assert.equal(earliestReleaseGroup([{ date: "1990" }]), null);
});

test("a recording's own genre is used first, with its URL and votes", async () => {
  const { get, asked } = answers({
    [recordingUrl("rec-1")]: { genres: [{ name: "house", count: 4 }] },
  });
  const entry = await styleEntry(ROW, get, NOW);
  assert.deepEqual(entry, {
    ...ROW,
    style: "house",
    level: "recording",
    votes: 4,
    url: recordingUrl("rec-1"),
    retrievedAt: NOW(),
    lookups: [{ url: recordingUrl("rec-1"), genres: [{ name: "house", count: 4 }] }],
  });
  assert.equal(asked.length, 1);
});

test("then the earliest release's group, reading every page of releases", async () => {
  const { get } = answers({
    [recordingUrl("rec-1")]: { genres: [], "artist-credit": [{ artist: { id: "art-1" } }] },
    [releasesUrl("rec-1", 0)]: {
      "release-count": 2,
      releases: [{ date: "2001", "release-group": { id: "rg-late" } }],
    },
    [releasesUrl("rec-1", 1)]: {
      "release-count": 2,
      releases: [{ date: "1999", "release-group": { id: "rg-early" } }],
    },
    [releaseGroupUrl("rg-early")]: { genres: [{ name: "trip hop", count: 1 }] },
  });
  const entry = await styleEntry(ROW, get, NOW);
  assert.equal(entry.style, "trip hop");
  assert.equal(entry.level, "release-group");
  assert.equal(entry.url, releaseGroupUrl("rg-early"));
  // Every lookup, with what the rule read of it: each genre list whole, each page's size.
  assert.deepEqual(entry.lookups, [
    { url: recordingUrl("rec-1"), genres: [] },
    { url: releasesUrl("rec-1", 0), releases: 1 },
    { url: releasesUrl("rec-1", 1), releases: 1, earliestReleaseGroup: "rg-early" },
    { url: releaseGroupUrl("rg-early"), genres: [{ name: "trip hop", count: 1 }] },
  ]);
});

test("then the first credited artist, and a row with no genre anywhere is kept with none", async () => {
  const base = {
    [recordingUrl("rec-1")]: { "artist-credit": [{ artist: { id: "art-1" } }] },
    [releasesUrl("rec-1", 0)]: {
      "release-count": 1,
      releases: [{ date: "1990", "release-group": { id: "rg-1" } }],
    },
    [releaseGroupUrl("rg-1")]: { genres: [] },
  };
  const byArtist = await styleEntry(
    ROW,
    answers({ ...base, [artistUrl("art-1")]: { genres: [{ name: "j-pop", count: 6 }] } }).get,
    NOW,
  );
  assert.deepEqual([byArtist.style, byArtist.level, byArtist.votes], ["j-pop", "artist", 6]);
  const none = await styleEntry(ROW, answers({ ...base, [artistUrl("art-1")]: {} }).get, NOW);
  assert.deepEqual([none.style, none.level, none.url], [null, null, null]);
  assert.equal(none.lookups.length, 4);
});

test("the client sends the User-Agent, retries a 503 once and refuses any other host", async () => {
  const calls = [];
  const statuses = [503, 200];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers["user-agent"] });
    const status = statuses.shift();
    return { status, ok: status === 200, json: async () => ({ genres: [] }) };
  };
  const client = musicBrainzClient({ fetchImpl, spacing: 0, retryAfter: 0 });
  assert.deepEqual(await client.get(recordingUrl("rec-1")), { genres: [] });
  assert.equal(client.requests(), 2);
  assert.equal(client.requestsOf(recordingUrl("rec-1")), 2);
  assert.ok(calls.every((c) => c.ua === USER_AGENT));
  await assert.rejects(client.get("https://example.org/x"), /not a MusicBrainz API URL/);
  assert.equal(client.requests(), 2);
});

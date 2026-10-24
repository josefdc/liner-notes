/**
 * The 45 tracks of the golden set (evals/golden.jsonl) through the scout's decision, with search
 * results built to mislead: a karaoke track, a piano cover and the artist's own live take come
 * before the right recording, and another song by the artist follows it. With and without an
 * unmarked recording of the same title by someone else, each query either selects the right
 * recording or asks; none selects another.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SpotifyData } from "./state.js";
import { needsChoice, rankTracks } from "./trackMatch.js";

interface GoldenRow {
  title: string;
  artist: string;
}

const golden: GoldenRow[] = readFileSync(
  join(import.meta.dirname, "../../../../evals/golden.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

let next = 0;
function track(title: string, artistNames: string[]): SpotifyData {
  next++;
  return {
    id: `t${next}`,
    title,
    artist: artistNames.join(", "),
    artistNames,
    artistIds: [],
    album: "",
    releaseDate: "",
    coverUrl: "",
    duration: "",
    durationMs: 0,
    explicit: null,
    spotifyUrl: "",
    previewUrl: null,
  };
}

/** The title spelt differently: its last word with an "s" added ("Hurts" for "Hurt"). */
const respelt = (title: string) => `${title}s`;

/**
 * The title spelt differently another way: the last letter of its last Latin word of four
 * letters or more dropped ("Believin" for "Believing"); an "s" added when there is none.
 */
function clipped(title: string): string {
  const last = [...title.matchAll(/\p{Script=Latin}{4,}/gu)].pop();
  if (!last || last.index === undefined) return respelt(title);
  const end = last.index + last[0].length;
  return `${title.slice(0, end - 1)}${title.slice(end)}`;
}

type Cover = "none" | "unmarked" | "respelt" | "respelt first" | "clipped first";

/**
 * The search results for a golden track, and the right one among them. An unmarked cover by
 * someone else has the same title and comes early; a respelt one carries the query's spelling
 * and comes after the original, as Spotify usually lists them, or first.
 */
function results(row: GoldenRow, cover: Cover) {
  const artists = row.artist.split(/ feat\. | & /);
  const right = track(row.title, artists);
  const list = [
    track(`${row.title} (Karaoke Version)`, ["Ameritz Karaoke"]),
    track(`${row.title} - Piano Cover`, ["Piano Dreamers"]),
    track(`${row.title} - Live`, artists),
    right,
    track("Another Song Entirely", [artists[0]]),
  ];
  if (cover === "unmarked") list.splice(1, 0, track(row.title, ["Somebody Else"]));
  if (cover === "respelt") list.splice(4, 0, track(respelt(row.title), ["Somebody Else"]));
  // Spotify's order is not relied on: the cover may come first.
  if (cover === "respelt first") list.unshift(track(respelt(row.title), ["Somebody Else"]));
  if (cover === "clipped first") list.unshift(track(clipped(row.title), ["Somebody Else"]));
  return { artists, right, list };
}

type Tally = { selected: number; asked: number; wrong: string[] };

function tally(form: (row: GoldenRow, artists: string[]) => string, cover: Cover) {
  const out: Tally = { selected: 0, asked: 0, wrong: [] };
  for (const row of golden) {
    const { artists, right, list } = results(row, cover);
    const query = form(row, artists);
    const ranked = rankTracks(query, list);
    if (needsChoice(ranked)) out.asked++;
    else if (ranked[0].track.id === right.id) out.selected++;
    else out.wrong.push(`${query} -> ${ranked[0].track.title} / ${ranked[0].track.artist}`);
  }
  return out;
}

// The web searches for "<title> <artists joined by ', '>" when a suggestion is picked.
const web = (row: GoldenRow, artists: string[]) => `${row.title} ${artists.join(", ")}`;
const titleOnly = (row: GoldenRow) => row.title;
const respeltTitle = (row: GoldenRow) => respelt(row.title);
const clippedTitle = (row: GoldenRow) => clipped(row.title);
const artistDashTitle = (row: GoldenRow, artists: string[]) => `${artists[0]} - ${row.title}`;

describe("the golden set through the scout's decision", () => {
  it("has 45 tracks", () => {
    expect(golden).toHaveLength(45);
  });

  it.each([
    ["the web's query", "none", web, { selected: 45, asked: 0, wrong: [] }],
    ["the web's query", "unmarked", web, { selected: 45, asked: 0, wrong: [] }],
    ["the artist and the title", "none", artistDashTitle, { selected: 45, asked: 0, wrong: [] }],
    [
      "the artist and the title",
      "unmarked",
      artistDashTitle,
      { selected: 45, asked: 0, wrong: [] },
    ],
    // A query that names no artist always asks.
    ["the title alone", "none", titleOnly, { selected: 0, asked: 45, wrong: [] }],
    ["the title alone", "unmarked", titleOnly, { selected: 0, asked: 45, wrong: [] }],
    ["the title spelt differently", "respelt", respeltTitle, { selected: 0, asked: 45, wrong: [] }],
    [
      "the title spelt differently",
      "respelt first",
      respeltTitle,
      { selected: 0, asked: 45, wrong: [] },
    ],
    [
      "the title with a letter dropped",
      "clipped first",
      clippedTitle,
      { selected: 0, asked: 45, wrong: [] },
    ],
  ] as const)("%s (cover by someone else: %s)", (_label, cover, form, expected) => {
    expect(tally(form, cover)).toEqual(expected);
  });

  it("the web's query is an exact match for every golden track", () => {
    for (const row of golden) {
      const { artists, right } = results(row, "none");
      expect(rankTracks(web(row, artists), [right])[0].match, row.title).toBe("exact");
    }
  });
});

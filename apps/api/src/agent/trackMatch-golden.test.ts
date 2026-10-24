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

/** The search results for a golden track, and the right one among them. */
function results(row: GoldenRow, withUnmarkedCover: boolean) {
  const artists = row.artist.split(/ feat\. | & /);
  const right = track(row.title, artists);
  const list = [
    track(`${row.title} (Karaoke Version)`, ["Ameritz Karaoke"]),
    track(`${row.title} - Piano Cover`, ["Piano Dreamers"]),
    track(`${row.title} - Live`, artists),
    right,
    track("Another Song Entirely", [artists[0]]),
  ];
  if (withUnmarkedCover) list.splice(1, 0, track(row.title, ["Somebody Else"]));
  return { artists, right, list };
}

type Tally = { selected: number; asked: number; wrong: string[] };

function tally(form: (row: GoldenRow, artists: string[]) => string, withUnmarkedCover: boolean) {
  const out: Tally = { selected: 0, asked: 0, wrong: [] };
  for (const row of golden) {
    const { artists, right, list } = results(row, withUnmarkedCover);
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
const artistDashTitle = (row: GoldenRow, artists: string[]) => `${artists[0]} - ${row.title}`;

describe("the golden set through the scout's decision", () => {
  it("has 45 tracks", () => {
    expect(golden).toHaveLength(45);
  });

  it.each([
    ["the web's query", web, false, { selected: 45, asked: 0, wrong: [] }],
    ["the web's query", web, true, { selected: 45, asked: 0, wrong: [] }],
    ["the artist and the title", artistDashTitle, false, { selected: 45, asked: 0, wrong: [] }],
    ["the artist and the title", artistDashTitle, true, { selected: 45, asked: 0, wrong: [] }],
    ["the title alone", titleOnly, false, { selected: 45, asked: 0, wrong: [] }],
    // Another artist's recording of the title makes the title alone a choice.
    ["the title alone", titleOnly, true, { selected: 0, asked: 45, wrong: [] }],
  ] as const)("%s (unmarked cover by someone else: %s)", (_label, form, cover, expected) => {
    expect(tally(form, cover)).toEqual(expected);
  });

  it("the web's query is an exact match for every golden track", () => {
    for (const row of golden) {
      const { artists, right } = results(row, false);
      expect(rankTracks(web(row, artists), [right])[0].match, row.title).toBe("exact");
    }
  });
});

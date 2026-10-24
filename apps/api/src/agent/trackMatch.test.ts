/**
 * Query matching: text of every script is compared after normalisation, a word is matched
 * whole ("Angel" is not "Angelito"), the query may carry the artist, and live takes, remixes
 * and karaoke count as other versions unless the query asks for them.
 */

import { describe, expect, it } from "vitest";
import type { SpotifyData } from "./state.js";
import { matchTrack, needsChoice, rankTracks, words } from "./trackMatch.js";

function track(title: string, ...artistNames: string[]): SpotifyData {
  return {
    id: `${title}/${artistNames.join(",")}`,
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

describe("words", () => {
  it.each([
    ["Don't Stop Me Now", ["dont", "stop", "me", "now"]],
    ["Despacíto", ["despacito"]],
    ["Earth, Wind & Fire", ["earth", "wind", "and", "fire"]],
    ["夜に駆ける", ["夜に駆ける"]],
    ["Где-то", ["где", "то"]],
    ["!!!", []],
  ])("%s", (text, expected) => {
    expect(words(text)).toEqual(expected);
  });
});

describe("matchTrack", () => {
  it.each([
    ["angel", track("Angel", "Shaggy"), "exact"],
    ["angel", track("Angelito", "Don Omar"), "none"],
    ["hurt by nine inch nails", track("Hurt", "Nine Inch Nails"), "exact"],
    ["hey jude beatles", track("Hey Jude - Remastered 2015", "The Beatles"), "exact"],
    ["夜に駆ける", track("夜に駆ける", "YOASOBI"), "exact"],
    ["夜に駆ける", track("群青", "YOASOBI"), "none"],
    ["bohemian", track("Bohemian Rhapsody", "Queen"), "partial"],
    ["queen", track("Bohemian Rhapsody", "Queen"), "artist"],
    ["hurt live", track("Hurt - Live", "Johnny Cash"), "exact"],
  ] as const)("%s ~ %s", (query, candidate, expected) => {
    expect(matchTrack(query, candidate).match).toBe(expected);
  });

  it("marks another version unless the query asks for it", () => {
    expect(matchTrack("hurt", track("Hurt - Live", "Johnny Cash")).otherVersion).toBe(true);
    expect(matchTrack("hurt live", track("Hurt - Live", "Johnny Cash")).otherVersion).toBe(false);
    expect(matchTrack("hurt", track("Hurt", "Karaoke Hits Band")).otherVersion).toBe(true);
    expect(
      matchTrack("hey jude", track("Hey Jude - Remastered 2015", "The Beatles")).otherVersion,
    ).toBe(false);
    // A word of the title itself is not a version marker.
    expect(matchTrack("live and let die", track("Live And Let Die", "Wings")).otherVersion).toBe(
      false,
    );
  });
});

describe("needsChoice", () => {
  it("asks when two songs match equally, not for versions or re-releases of one song", () => {
    const query = "hurt";
    expect(
      needsChoice(
        rankTracks(query, [track("Hurt", "Johnny Cash"), track("Hurt", "Nine Inch Nails")]),
      ),
    ).toBe(true);
    expect(
      needsChoice(
        rankTracks(query, [
          track("Hurt", "Johnny Cash"),
          track("Hurt - Live", "Johnny Cash"),
          track("Hurt", "Johnny Cash"),
        ]),
      ),
    ).toBe(false);
  });

  it("asks when nothing matches, even for a single result", () => {
    expect(needsChoice(rankTracks("qwzx vlorp", [track("xStep", "DJVI")]))).toBe(true);
  });
});

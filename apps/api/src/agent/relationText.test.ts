/**
 * How a statement is split into sentences for marking (`sentencesOf`): after a full stop, a
 * semicolon or an exclamation mark followed by a space, but not after a known abbreviation or a
 * single initial, and not inside a quoted title.
 */

import { describe, expect, it } from "vitest";
import { sentencesOf } from "./relationText.js";

describe("sentencesOf", () => {
  it("splits after a full stop, a semicolon or an exclamation mark and a space", () => {
    expect(sentencesOf("Juicy samples Juicy Fruit. The bass line is looped.")).toEqual([
      "Juicy samples Juicy Fruit.",
      "The bass line is looped.",
    ]);
    expect(sentencesOf("A loop; a break! An end")).toEqual(["A loop;", "a break!", "An end"]);
    expect(sentencesOf("Version 2.0 samples it.")).toEqual(["Version 2.0 samples it."]);
  });

  it("never splits after an abbreviation or a single initial", () => {
    for (const text of [
      "X samples Y feat. Z by Them.",
      "X samples Y ft. Z by Them.",
      "Song samples Mr. Brightside by Them.",
      "St. Elsewhere samples Them vs. Us.",
      "Hung Up samples Stand by Me by Ben E. King.",
      "Juicy by The Notorious B.I.G. samples Juicy Fruit.",
    ]) {
      expect(sentencesOf(text), text).toEqual([text]);
    }
    expect(sentencesOf("Song samples U2. It loops.")).toEqual(["Song samples U2.", "It loops."]);
  });

  it("never splits inside a quoted title", () => {
    expect(
      sentencesOf(
        "Hung Up samples “Gimme! Gimme! Gimme! (A Man After Midnight)” by ABBA; it loops.",
      ),
    ).toEqual([
      "Hung Up samples “Gimme! Gimme! Gimme! (A Man After Midnight)” by ABBA;",
      "it loops.",
    ]);
    expect(sentencesOf('Hung Up samples "Gimme! Gimme! Gimme!" by ABBA! It loops.')).toEqual([
      'Hung Up samples "Gimme! Gimme! Gimme!" by ABBA!',
      "It loops.",
    ]);
  });
});

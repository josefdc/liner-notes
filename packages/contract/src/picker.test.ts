/**
 * The picker's shared rules: the question's wording, and which rows are one recording (the
 * API's candidates and the search box's suggestions).
 */

import { describe, expect, it } from "vitest";
import { choiceMessage, oneRowPerRecording, type RecordingRow } from "./picker.js";

/** A release of one recording (one ISRC), clean and 3:38 long unless changed. */
const row = (id: string, change: Partial<RecordingRow> = {}): RecordingRow => ({
  id,
  isrc: "USUM70207211",
  explicit: false,
  durationMs: 218_000,
  ...change,
});
const ids = (rows: RecordingRow[]) => oneRowPerRecording(rows).map((kept) => kept.id);

/** Every order of `list`. */
const orders = <T>(list: T[]): T[][] =>
  list.length <= 1
    ? [list]
    : list.flatMap((item, index) =>
        orders([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest]),
      );

describe("choiceMessage", () => {
  it("counts the tracks offered, in the words the API and the web both use", () => {
    expect(choiceMessage(1)).toBe("One possible track from Spotify; confirm it or search again");
    expect(choiceMessage(2)).toBe("2 possible tracks from Spotify; choose one");
    expect(choiceMessage(5)).toBe("5 possible tracks from Spotify; choose one");
  });
});

describe("oneRowPerRecording", () => {
  it("merges a remaster with the same ISRC, explicit value and a length within 2 s", () => {
    expect(
      ids([
        row("album", { releaseDate: "2002-11-05" }),
        row("remaster", { releaseDate: "2014", durationMs: 219_500 }),
      ]),
    ).toEqual(["album"]);
  });

  it("merges at exactly 2000 ms apart, and keeps rows 2001 ms apart", () => {
    expect(ids([row("a"), row("b", { durationMs: 220_000 })])).toEqual(["a"]);
    expect(ids([row("a"), row("b", { durationMs: 220_001 })])).toEqual(["a", "b"]);
  });

  it("keeps an explicit and a clean version apart, though they share an ISRC", () => {
    expect(ids([row("clean"), row("explicit", { explicit: true })])).toEqual(["clean", "explicit"]);
    // Neither known is the same value.
    expect(ids([row("a", { explicit: null }), row("b", { explicit: undefined })])).toEqual(["a"]);
  });

  it("keeps two edits apart (3:30 and 5:10), though they share an ISRC", () => {
    expect(
      ids([row("edit", { durationMs: 210_000 }), row("full", { durationMs: 310_000 })]),
    ).toEqual(["edit", "full"]);
  });

  it("never merges a row without an ISRC or a known length", () => {
    expect(ids([row("a", { durationMs: undefined }), row("b", { durationMs: undefined })])).toEqual(
      ["a", "b"],
    );
    expect(ids([row("a", { durationMs: 0 }), row("b", { durationMs: 0 })])).toEqual(["a", "b"]);
    expect(ids([row("a", { isrc: null }), row("b", { isrc: null })])).toEqual(["a", "b"]);
  });

  it("reads an ISRC whatever its case and spacing", () => {
    expect(ids([row("a"), row("b", { isrc: " usum70207211 " })])).toEqual(["a"]);
  });

  it("keeps the earliest known release, listed first or not, in the place of the first listed", () => {
    const album = row("album", { releaseDate: "2002-11-05" });
    const compilation = row("compilation", { releaseDate: "2008" });
    const other = row("nin", { isrc: "USIR19400001" });
    expect(ids([album, other, compilation])).toEqual(["album", "nin"]);
    expect(ids([compilation, other, album])).toEqual(["album", "nin"]);
  });

  it('prefers a dated release to one dated "0000" or not at all', () => {
    for (const unknown of [
      row("unknown", { releaseDate: "0000" }),
      row("unknown", { releaseDate: null }),
      // A date of "0000" is unknown, and the year is not read in its place.
      row("unknown", { releaseDate: "0000-00-00", releaseYear: "1990" }),
    ]) {
      for (const order of orders([unknown, row("dated", { releaseDate: "2002" })])) {
        expect(ids(order)).toEqual(["dated"]);
      }
    }
  });

  it("reads a recorded track's year when it has no release date", () => {
    expect(
      ids([row("later", { releaseDate: "2016-04-08" }), row("recorded", { releaseYear: "2011" })]),
    ).toEqual(["recorded"]);
  });

  it("prefers a precise date to its year alone, whatever the order", () => {
    const day = row("day", { releaseDate: "2002-11-05" });
    const year = row("year", { releaseDate: "2002" });
    expect(ids([day, year])).toEqual(["day"]);
    expect(ids([year, day])).toEqual(["day"]);
  });

  it("keeps the same one of two undated rows whatever the order (by track id)", () => {
    expect(ids([row("b"), row("a")])).toEqual(["a"]);
    expect(ids([row("a"), row("b")])).toEqual(["a"]);
  });

  it("gives the same rows in every order: 200.0 s, 201.5 s and 203.0 s are one recording", () => {
    // The probe that showed the order mattering: A 2008, B 2002, C 2010, all one ISRC.
    const a = row("A", { releaseDate: "2008", durationMs: 200_000 });
    const b = row("B", { releaseDate: "2002", durationMs: 201_500 });
    const c = row("C", { releaseDate: "2010", durationMs: 203_000 });
    expect(ids([a, b, c])).toEqual(["B"]);
    expect(ids([a, c, b])).toEqual(["B"]);
    for (const order of orders([a, b, c])) expect(ids(order)).toEqual(["B"]);
  });

  it("merges a row only into a kept row near its length, never through a chain of rows", () => {
    // 201.9 s is near both, but 203.8 s is 3.8 s from the kept row (2002).
    const kept = row("kept", { releaseDate: "2002", durationMs: 200_000 });
    const near = row("near", { releaseDate: "2005", durationMs: 201_900 });
    const far = row("far", { releaseDate: "2008", durationMs: 203_800 });
    for (const order of orders([kept, near, far])) {
      expect([...ids(order)].sort()).toEqual(["far", "kept"]);
    }
    // The reviewer's case: 200.0 s, 201.9 s and 198.1 s, the earliest at 198.1 s.
    const early = row("early", { releaseDate: "1999", durationMs: 198_100 });
    const middle = row("middle", { releaseDate: "2004", durationMs: 200_000 });
    const late = row("late", { releaseDate: "2006", durationMs: 201_900 });
    for (const order of orders([early, middle, late])) {
      expect([...ids(order)].sort()).toEqual(["early", "late"]);
    }
  });

  it("merges nothing further when run on its own result", () => {
    const rows = [100, 101.5, 103, 104.5, 106, 107.5].map((seconds, index) =>
      row(`r${index}`, { releaseDate: `200${index}`, durationMs: seconds * 1000 }),
    );
    const once = oneRowPerRecording(rows);
    expect(oneRowPerRecording(once)).toEqual(once);
    expect(once.map((kept) => kept.id)).toEqual(["r0", "r2", "r4"]);
  });

  it("lists a track id once", () => {
    expect(ids([row("a", { isrc: null }), row("a", { isrc: null })])).toEqual(["a"]);
  });
});

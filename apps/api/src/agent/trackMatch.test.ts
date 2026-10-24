/**
 * Query matching: text of every script is compared after normalisation, a word is matched
 * whole ("Angel" is not "Angelito"), the query may carry every credited artist, and live takes,
 * remixes and karaoke count as other versions unless the query asks for them. The scout selects
 * a track without asking only when it is clearly the song the query names.
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

/** What the scout does with the results: "ask", or "auto <title / artists>" and the match. */
function decide(query: string, tracks: SpotifyData[]): string {
  const ranked = rankTracks(query, tracks);
  return needsChoice(ranked) ? "ask" : `auto ${ranked[0].track.id} (${ranked[0].match})`;
}

type Case = [string, string, SpotifyData[], string];

// Each row was decided wrongly by the first version of these rules; the label names the
// review finding it comes from.
const corrected: Case[] = [
  [
    "a romanised query names YOASOBI: their song is offered, not a marked piano cover",
    "Yoru ni Kakeru YOASOBI",
    [
      track("夜に駆ける", "YOASOBI"),
      track("Yoru ni Kakeru (Piano Cover)", "Animenz"),
      track("Yoru ni Kakeru - Piano Cover", "Pianella Piano"),
      track("群青", "YOASOBI"),
    ],
    "ask",
  ],
  [
    "a romanised query names YOASOBI: an unmarked cover with the romanised title is not selected",
    "Yoru ni Kakeru YOASOBI",
    [
      track("夜に駆ける", "YOASOBI"),
      track("Yoru ni Kakeru", "Rainych"),
      track("ハルジオン", "YOASOBI"),
    ],
    "ask",
  ],
  [
    "a transliterated title and artist: the Latin-titled cover is not selected",
    "Gruppa Krovi Kino",
    [track("Группа крови", "Кино"), track("Gruppa Krovi", "Lumen"), track("Кукушка", "Кино")],
    "ask",
  ],
  [
    "a spelling variant names Journey: a karaoke track is not selected",
    "Dont Stop Believing Journey",
    [
      track("Don't Stop Believin'", "Journey"),
      track("Don't Stop Believing (Karaoke Version)", "Ameritz Karaoke"),
      track("Any Way You Want It", "Journey"),
    ],
    "ask",
  ],
  [
    "a spelling variant names Journey: neither karaoke nor a live take is selected",
    "Dont Stop Believing Journey",
    [
      track("Don't Stop Believin' - 2022 Remaster", "Journey"),
      track("Don't Stop Believing (Karaoke Version)", "Ameritz Karaoke"),
      track("Don't Stop Believin' - Live", "Journey"),
    ],
    "ask",
  ],
  [
    "a Korean query selects PSY's song over a karaoke track with the Korean title",
    "강남스타일",
    [
      track("Gangnam Style (강남스타일)", "PSY"),
      track("강남스타일 (Karaoke Version)", "Ameritz K-Pop Karaoke"),
    ],
    "auto Gangnam Style (강남스타일)/PSY (exact)",
  ],
  [
    "a Korean query matches the Korean title in brackets",
    "강남스타일",
    [track("Gangnam Style (강남스타일)", "PSY")],
    "auto Gangnam Style (강남스타일)/PSY (exact)",
  ],
  [
    "an artist-only query does not select another artist's song named after them (Rihanna)",
    "Rihanna",
    [
      track("Umbrella", "Rihanna", "JAY-Z"),
      track("Diamonds", "Rihanna"),
      track("Rihanna", "Yxng Bane"),
      track("Stay", "Rihanna", "Mikky Ekko"),
    ],
    "ask",
  ],
  [
    "part of an artist's name does not select another artist's song with that title (Kanye)",
    "Kanye",
    [
      track("Stronger", "Kanye West"),
      track("Kanye", "The Chainsmokers", "SirenXX"),
      track("Heartless", "Kanye West"),
    ],
    "ask",
  ],
  [
    "an artist-only query does not select another artist's song named after them (Madonna)",
    "Madonna",
    [track("Hung Up", "Madonna"), track("Like a Prayer", "Madonna"), track("Madonna", "Drake")],
    "ask",
  ],
  [
    "a band called Little Mix is not a remix: two songs called Black Magic are a choice",
    "Black Magic",
    [
      track("Black Magic", "Little Mix"),
      track("Black Magic", "Jonas Blue", "Liam Payne"),
      track("Black Magic Woman", "Santana"),
    ],
    "ask",
  ],
  [
    "a band called Live is not a live take: two songs called Lightning Crashes are a choice",
    "Lightning Crashes",
    [track("Lightning Crashes", "Live"), track("Lightning Crashes", "Some Covers Band")],
    "ask",
  ],
  [
    "a band called Little Mix is not a remix: an unmarked cover is not selected over it",
    "Shout Out to My Ex",
    [track("Shout Out to My Ex", "Little Mix"), track("Shout Out to My Ex", "Sam Tsui")],
    "ask",
  ],
  [
    "a live take that is another song (Frampton's) is still a rival",
    "Show Me the Way",
    [track("Show Me the Way - Live", "Peter Frampton"), track("Show Me the Way", "Styx")],
    "ask",
  ],
  [
    "an Original Mix is the original recording, so two songs called Strobe are a choice",
    "Strobe",
    [track("Strobe - Original Mix", "deadmau5"), track("Strobe", "Some Indie Band")],
    "ask",
  ],
  [
    "a credit in brackets is not a version: two songs called Wings are a choice",
    "Wings",
    [track("Wings (feat. Little Mix)", "Some DJ"), track("Wings", "Birdy")],
    "ask",
  ],
  [
    "a live take by another artist with the title is a rival",
    "Pressure",
    [track("Pressure", "Billy Joel"), track("Pressure - Live", "Paramore")],
    "ask",
  ],
  [
    "the query names R. Kelly but not a remix: his remix is not selected without asking",
    "Ignition R. Kelly",
    [track("Ignition - Remix", "R. Kelly"), track("Ignition", "TobyMac")],
    "ask",
  ],
  [
    "a query that asks for the remix selects the remix",
    "Blinding Lights remix",
    [
      track("Blinding Lights", "The Weeknd"),
      track("Blinding Lights (with ROSALÍA) - Remix", "The Weeknd", "ROSALÍA"),
    ],
    "auto Blinding Lights (with ROSALÍA) - Remix/The Weeknd,ROSALÍA (exact)",
  ],
  [
    "a query that asks for a live take selects the live take",
    "Hotel California live",
    [
      track("Hotel California - 2013 Remaster", "Eagles"),
      track("Hotel California - Live On MTV, 1994", "Eagles"),
    ],
    "auto Hotel California - Live On MTV, 1994/Eagles (exact)",
  ],
  [
    "the artist with a title nothing matches is a choice, not that artist's only song",
    "Daft Punk One More Tim",
    [track("Around the World", "Daft Punk"), track("One More Time", "Some Cover Band")],
    "ask",
  ],
  [
    "a title that matches only in part is a choice",
    "Adele Rolling Deep",
    [track("Rolling in the Deep", "Adele"), track("Deep", "Someone Else")],
    "ask",
  ],
  [
    "a query with the artist written against CJK text names the artist",
    "夜に駆けるYOASOBI",
    [track("夜に駆ける", "YOASOBI")],
    "auto 夜に駆ける/YOASOBI (exact)",
  ],
  [
    "the web's query names every credited artist (Coolio, L.V.)",
    "Gangsta's Paradise Coolio, L.V.",
    [
      track("Gangsta's Paradise", "Coolio", "L.V."),
      track("Gangsta's Paradise", "Postmodern Jukebox"),
    ],
    "auto Gangsta's Paradise/Coolio,L.V. (exact)",
  ],
  [
    "the web's query names every credited artist (Luis Fonsi, Daddy Yankee)",
    "Despacito Luis Fonsi, Daddy Yankee",
    [track("Despacito", "Luis Fonsi", "Daddy Yankee")],
    "auto Despacito/Luis Fonsi,Daddy Yankee (exact)",
  ],
  [
    "two songs with the title that share only a featured artist are a choice",
    "Run",
    [track("Run", "Artist One", "Guest"), track("Run", "Artist Two", "Guest")],
    "ask",
  ],
  [
    "AC/DC is named as ACDC",
    "Thunderstruck ACDC",
    [track("Thunderstruck", "AC/DC"), track("Thunderstruck", "Steve'n'Seagulls")],
    "auto Thunderstruck/AC/DC (exact)",
  ],
  [
    "the web's query for Under Pressure selects Queen and David Bowie's recording",
    "Under Pressure Queen, David Bowie",
    [
      track("Under Pressure - Remastered 2011", "Queen", "David Bowie"),
      track("Under Pressure", "My Chemical Romance", "The Used"),
    ],
    "auto Under Pressure - Remastered 2011/Queen,David Bowie (exact)",
  ],
  [
    "the web's query for STAY selects The Kid LAROI's recording",
    "STAY (with Justin Bieber) The Kid LAROI, Justin Bieber",
    [
      track("STAY (with Justin Bieber)", "The Kid LAROI", "Justin Bieber"),
      track("Stay", "Rihanna", "Mikky Ekko"),
    ],
    "auto STAY (with Justin Bieber)/The Kid LAROI,Justin Bieber (exact)",
  ],
];

// Rows the first version already decided rightly; they keep it so.
const kept: Case[] = [
  [
    "a query that asks for an acoustic take selects it",
    "Creep acoustic Radiohead",
    [track("Creep", "Radiohead"), track("Creep - Acoustic", "Radiohead")],
    "auto Creep - Acoustic/Radiohead (exact)",
  ],
  [
    "three songs called Hurt are a choice",
    "Hurt",
    [
      track("Hurt", "Johnny Cash"),
      track("Hurt", "Nine Inch Nails"),
      track("Hurt", "Christina Aguilera"),
    ],
    "ask",
  ],
  [
    "naming Johnny Cash selects his Hurt",
    "Hurt Johnny Cash",
    [track("Hurt", "Nine Inch Nails"), track("Hurt", "Johnny Cash")],
    "auto Hurt/Johnny Cash (exact)",
  ],
  [
    "three songs called Angel are a choice",
    "Angel",
    [
      track("Angel", "Shaggy", "Rayvon"),
      track("Angel", "Sarah McLachlan"),
      track("Angel", "Massive Attack"),
    ],
    "ask",
  ],
  [
    "two songs called Hello are a choice",
    "Hello",
    [track("Hello", "Adele"), track("Hello", "Lionel Richie")],
    "ask",
  ],
  [
    "one song called Crazy is selected",
    "Crazy",
    [
      track("Crazy", "Gnarls Barkley"),
      track("Crazy in Love (feat. Jay-Z)", "Beyoncé", "JAY-Z"),
      track("Crazy Little Thing Called Love", "Queen"),
    ],
    "auto Crazy/Gnarls Barkley (exact)",
  ],
  [
    "two recordings of 99 Luftballons are a choice",
    "99 Luftballons",
    [
      track("99 Luftballons", "Nena"),
      track("99 Red Balloons", "Goldfinger"),
      track("99 Luftballons", "Kaleida"),
    ],
    "ask",
  ],
  [
    "two songs called 1999 are a choice",
    "1999",
    [track("1999", "Prince"), track("1999", "Charli xcx", "Troye Sivan")],
    "ask",
  ],
  [
    "a remix of the same song is not a rival",
    "Despacito",
    [
      track("Despacito - Remix", "Luis Fonsi", "Daddy Yankee", "Justin Bieber"),
      track("Despacito", "Luis Fonsi", "Daddy Yankee"),
    ],
    "auto Despacito/Luis Fonsi,Daddy Yankee (exact)",
  ],
  [
    "a misspelt title is a choice",
    "Bohemian Rapsody",
    [track("Bohemian Rhapsody - Remastered 2011", "Queen")],
    "ask",
  ],
  [
    "two songs called The Last Time are a choice",
    "The Last Time",
    [
      track("The Last Time", "The Rolling Stones"),
      track("The Last Time", "The Andrew Oldham Orchestra"),
    ],
    "ask",
  ],
  [
    "naming Jake Holmes selects his Dazed and Confused",
    "Dazed and Confused Jake Holmes",
    [
      track("Dazed and Confused - Remaster", "Led Zeppelin"),
      track("Dazed and Confused", "Jake Holmes"),
    ],
    "auto Dazed and Confused/Jake Holmes (exact)",
  ],
  [
    "naming Leonard Cohen selects his Hallelujah",
    "Hallelujah Leonard Cohen",
    [track("Hallelujah", "Jeff Buckley"), track("Hallelujah", "Leonard Cohen")],
    "auto Hallelujah/Leonard Cohen (exact)",
  ],
  [
    "a remix that is another song (R. Kelly's Ignition) is still a rival",
    "Ignition",
    [
      track("Ignition - Remix", "R. Kelly"),
      track("Ignition", "TobyMac"),
      track("Ignition (Hotel Lounge)", "R. Kelly"),
    ],
    "ask",
  ],
  [
    "a query naming two credited artists is a choice between their songs with the title",
    "Hurt Johnny Cash Nine Inch Nails",
    [track("Hurt", "Nine Inch Nails"), track("Hurt", "Johnny Cash")],
    "ask",
  ],
  [
    "another title names Kyu Sakamoto: another artist's song with that title is not selected",
    "Sukiyaki Kyu Sakamoto",
    [
      track("上を向いて歩こう", "Kyu Sakamoto"),
      track("Sukiyaki", "A Taste Of Honey"),
      track("Sukiyaki - Remastered", "4 P.M."),
    ],
    "ask",
  ],
  [
    "a title that contains the artist's name selects that artist's recording, not a cover",
    "Killer Queen",
    [
      track("Killer Queen", "5 Seconds of Summer"),
      track("Killer Queen - Remastered 2011", "Queen"),
    ],
    "auto Killer Queen - Remastered 2011/Queen (exact)",
  ],
];

describe("the scout's decision", () => {
  it.each(corrected)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(kept)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });

  it("names an artist written differently: MØ, Florence + The Machine", () => {
    expect(matchTrack("Lean On MO", track("Lean On", "Major Lazer", "MØ")).artistNamed).toBe(true);
    expect(
      matchTrack(
        "Dog Days Are Over Florence and the Machine",
        track("Dog Days Are Over", "Florence + The Machine"),
      ),
    ).toMatchObject({ match: "exact", artistNamed: true });
  });

  it("keeps the marks of non-Latin letters", () => {
    expect(words("が")).toEqual(["が"]);
    expect(words("Мой")).toEqual(["мой"]);
    expect(words("Ｆｕｌｌｗｉｄｔｈ")).toEqual(["fullwidth"]);
  });
});

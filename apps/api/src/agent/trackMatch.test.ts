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
];

// Rows a further review found decided wrongly by the second version of these rules.
const second: Case[] = [
  [
    "A1 spelling, title only",
    "Dont Stop Believing",
    [
      track("Don't Stop Believin'", "Journey"),
      track("Don't Stop Believin' - 2022 Remaster", "Journey"),
      track("Don't Stop Believin' (Glee Cast Version)", "Glee Cast"),
      track("Don't Stop Believing", "Petra Haden"),
      track("Any Way You Want It", "Journey"),
      track("Faithfully", "Journey"),
      track("Separate Ways (Worlds Apart)", "Journey"),
      track("Open Arms", "Journey"),
      track("Wheel in the Sky", "Journey"),
      track("Lights", "Journey"),
    ],
    "ask",
  ],
  [
    "A2 common misspelling",
    "Sweet Child of Mine",
    [
      track("Sweet Child O' Mine", "Guns N' Roses"),
      track("Sweet Child O' Mine", "Taken by Trees"),
      track("Sweet Child of Mine", "Sheryl Crow"),
      track("Welcome To The Jungle", "Guns N' Roses"),
      track("November Rain", "Guns N' Roses"),
      track("Paradise City", "Guns N' Roses"),
      track("Knockin' On Heaven's Door", "Guns N' Roses"),
      track("Patience", "Guns N' Roses"),
      track("Don't Cry", "Guns N' Roses"),
      track("Civil War", "Guns N' Roses"),
    ],
    "ask",
  ],
  [
    "A3 longer common title",
    "Hit Me Baby One More Time",
    [
      track("...Baby One More Time", "Britney Spears"),
      track("Toxic", "Britney Spears"),
      track("Hit Me Baby One More Time", "Chris Cornell Tribute Acoustic"),
      track("Hit Me Baby One More Time", "Max Raabe"),
      track("Oops!...I Did It Again", "Britney Spears"),
      track("Womanizer", "Britney Spears"),
    ],
    "ask",
  ],
  [
    "A3b longer common title, one cover",
    "Hit Me Baby One More Time",
    [
      track("...Baby One More Time", "Britney Spears"),
      track("Toxic", "Britney Spears"),
      track("Hit Me Baby One More Time", "Max Raabe"),
      track("Oops!...I Did It Again", "Britney Spears"),
    ],
    "ask",
  ],
  [
    "A4 numerals",
    "Nothing Compares to You",
    [
      track("Nothing Compares 2 U", "Sinéad O'Connor"),
      track("Nothing Compares 2 U", "Prince"),
      track("Nothing Compares to You", "Chris Cornell"),
      track("The Emperor's New Clothes", "Sinéad O'Connor"),
    ],
    "ask",
  ],
  [
    "A5 romanised title only",
    "Yoru ni Kakeru",
    [
      track("夜に駆ける", "YOASOBI"),
      track("Yoru ni Kakeru", "Rainych"),
      track("Into The Night", "YOASOBI"),
      track("群青", "YOASOBI"),
      track("アイドル", "YOASOBI"),
    ],
    "ask",
  ],
  [
    "A6 romanised title only",
    "Gurenge",
    [
      track("紅蓮華", "LiSA"),
      track("Gurenge", "Raon"),
      track("炎", "LiSA"),
      track("unravel", "TK from Ling tosite sigure"),
    ],
    "ask",
  ],
  [
    "A7 transliterated title only",
    "Gruppa Krovi",
    [track("Группа крови", "Кино"), track("Gruppa Krovi", "Lumen"), track("Кукушка", "Кино")],
    "ask",
  ],
  [
    "A8 thank u next",
    "thank you next",
    [
      track("thank u, next", "Ariana Grande"),
      track("7 rings", "Ariana Grande"),
      track("Thank You Next", "Kidz Bop Kids"),
    ],
    "ask",
  ],
  [
    "B1 artist == title of another's song",
    "Bad Religion",
    [
      track("Bad Religion", "Frank Ocean"),
      track("Punk Rock Song", "Bad Religion"),
      track("Bad Religion", "Bad Religion"),
      track("21st Century (Digital Boy)", "Bad Religion"),
      track("Pyramids", "Frank Ocean"),
    ],
    "ask",
  ],
  [
    "B2 Talk Talk",
    "talk talk",
    [
      track("Talk talk", "Charli xcx"),
      track("Talk Talk", "Talk Talk"),
      track("It's My Life", "Talk Talk"),
      track("360", "Charli xcx"),
    ],
    "ask",
  ],
  [
    "B3 act named after the song (tribute w/o marker)",
    "Hotel California",
    [
      track("Hotel California - 2013 Remaster", "Eagles"),
      track("Hotel California", "Gipsy Kings"),
      track("Hotel California", "Hotel California"),
    ],
    "ask",
  ],
  [
    "B3b act named after the song, original only otherwise",
    "Dancing Queen",
    [
      track("Dancing Queen", "ABBA"),
      track("Dancing Queen", "Dancing Queen"),
      track("Mamma Mia", "ABBA"),
    ],
    "ask",
  ],
  [
    "B4 title-word artist covers title (loophole)",
    "Bennie and the Jets",
    [
      track("Bennie And The Jets - Remastered 2014", "Elton John"),
      track("Bennie and the Jets", "The Jets"),
    ],
    "ask",
  ],
  [
    "B5 partial-name artist with exact title",
    "Angel",
    [
      track("Angel", "Shaggy", "Rayvon"),
      track("Angel", "Sarah McLachlan"),
      track("Angel", "Angel Olsen"),
    ],
    "ask",
  ],
  [
    "B7 Prince Ali w/ Prince tracks",
    "Prince Ali",
    [
      track("Prince Ali", "Robin Williams"),
      track("Purple Rain", "Prince"),
      track("Prince Ali - Reprise", "Robin Williams"),
    ],
    "auto Prince Ali/Robin Williams (exact)",
  ],
  [
    "B8 word-artist inside title, Love",
    "Crazy in Love",
    [track("Crazy In Love (feat. Jay-Z)", "Beyoncé", "JAY-Z"), track("Alone Again Or", "Love")],
    "auto Crazy In Love (feat. Jay-Z)/Beyoncé,JAY-Z (exact)",
  ],
  [
    "B9 Future in title",
    "Future Nostalgia",
    [track("Future Nostalgia", "Dua Lipa"), track("Mask Off", "Future")],
    "auto Future Nostalgia/Dua Lipa (exact)",
  ],
  [
    "B11 artist-only self-titled",
    "Iron Maiden",
    [
      track("The Trooper - 2015 Remaster", "Iron Maiden"),
      track("Iron Maiden", "Iron Maiden"),
      track("Run to the Hills", "Iron Maiden"),
    ],
    "ask",
  ],
  [
    "D1 Taylor's Version first, original second, named",
    "Love Story Taylor Swift",
    [
      track("Love Story (Taylor's Version)", "Taylor Swift"),
      track("Love Story", "Taylor Swift"),
      track("Love Story", "Indila"),
    ],
    "auto Love Story/Taylor Swift (exact)",
  ],
  [
    "D4 Re-Recorded first",
    "Kung Fu Fighting Carl Douglas",
    [
      track("Kung Fu Fighting (Re-Recorded)", "Carl Douglas"),
      track("Kung Fu Fighting", "Carl Douglas"),
    ],
    "auto Kung Fu Fighting/Carl Douglas (exact)",
  ],
  [
    "D5 Rerecorded dash",
    "Kung Fu Fighting Carl Douglas",
    [
      track("Kung Fu Fighting - Rerecorded", "Carl Douglas"),
      track("Kung Fu Fighting", "Carl Douglas"),
    ],
    "auto Kung Fu Fighting/Carl Douglas (exact)",
  ],
  [
    "D6 Stripped first",
    "Chandelier Sia",
    [track("Chandelier - Stripped", "Sia"), track("Chandelier", "Sia")],
    "auto Chandelier/Sia (exact)",
  ],
  [
    "D7 Orchestral first",
    "Bitter Sweet Symphony The Verve",
    [
      track("Bitter Sweet Symphony - Orchestral Version", "The Verve"),
      track("Bitter Sweet Symphony", "The Verve"),
    ],
    "auto Bitter Sweet Symphony/The Verve (exact)",
  ],
  [
    "D8 acapella",
    "Toxic Britney Spears",
    [track("Toxic - A Cappella", "Britney Spears"), track("Toxic", "Britney Spears")],
    "auto Toxic/Britney Spears (exact)",
  ],
  [
    "D9 Spanish version",
    "Despacito Luis Fonsi",
    [
      track("Despacito - Versión Pop", "Luis Fonsi"),
      track("Despacito", "Luis Fonsi", "Daddy Yankee"),
    ],
    "auto Despacito/Luis Fonsi,Daddy Yankee (exact)",
  ],
  [
    "D12 sessions",
    "Wonderwall Oasis",
    [track("Wonderwall - BBC Session", "Oasis"), track("Wonderwall - Remastered", "Oasis")],
    "auto Wonderwall - Remastered/Oasis (exact)",
  ],
  [
    "D14 VIP / Bootleg / Rework",
    "Levels Avicii",
    [
      track("Levels - Skrillex Remix", "Avicii"),
      track("Levels - Rework", "Avicii"),
      track("Levels", "Avicii"),
    ],
    "auto Levels/Avicii (exact)",
  ],
  [
    "D16 version phrase in title base",
    "Remix to Ignition",
    [track("Ignition - Remix", "R. Kelly"), track("Remix to Ignition", "Some Band")],
    "ask",
  ],
  [
    "other songs whose title holds the query make a title-only query a choice (Crazy in Love)",
    "Crazy",
    [
      track("Crazy", "Gnarls Barkley"),
      track("Crazy in Love (feat. Jay-Z)", "Beyoncé", "JAY-Z"),
      track("Crazy Little Thing Called Love", "Queen"),
    ],
    "ask",
  ],
  [
    "a title that contains an artist's name does not name the artist: Killer Queen by Queen or 5SOS is a choice",
    "Killer Queen",
    [
      track("Killer Queen", "5 Seconds of Summer"),
      track("Killer Queen - Remastered 2011", "Queen"),
    ],
    "ask",
  ],
  [
    'a title-only query asks when another artist\'s title is within the query ("Baby" for "Ice Ice Baby")',
    "ice ice baby",
    [track("Ice Ice Baby", "Vanilla Ice"), track("Baby", "Justin Bieber", "Ludacris")],
    "ask",
  ],
];

// Rows of that review the second version already decided rightly.
const secondKept: Case[] = [
  [
    "B6 partial-name artist, no exact",
    "Yellow",
    [
      track("Yellow", "Coldplay"),
      track("Shotgun", "Yellow Claw"),
      track("Yellow - Live", "Coldplay"),
    ],
    "ask",
  ],
  [
    "B10 Seal as artist named in query",
    "Kiss from a Rose",
    [track("Kiss from a Rose", "Seal"), track("Kiss from a Rose", "Kidz Bop Kids")],
    "ask",
  ],
  [
    "C1 Hurt neither named",
    "Hurt",
    [
      track("Hurt", "Johnny Cash"),
      track("Hurt", "Nine Inch Nails"),
      track("Hurt - Live", "Johnny Cash"),
    ],
    "ask",
  ],
  [
    "C2 Hallelujah",
    "Hallelujah",
    [
      track("Hallelujah", "Jeff Buckley"),
      track("Hallelujah", "Leonard Cohen"),
      track("Hallelujah", "Pentatonix"),
    ],
    "ask",
  ],
  [
    "C3 Watchtower",
    "All Along the Watchtower",
    [
      track("All Along the Watchtower", "Jimi Hendrix"),
      track("All Along the Watchtower", "Bob Dylan"),
    ],
    "ask",
  ],
  [
    "C4 Watchtower named Dylan",
    "All Along the Watchtower Bob Dylan",
    [
      track("All Along the Watchtower", "Jimi Hendrix"),
      track("All Along the Watchtower", "Bob Dylan"),
    ],
    "auto All Along the Watchtower/Bob Dylan (exact)",
  ],
  [
    "C5 only cover present (original absent)",
    "Hurt",
    [track("Hurt", "Johnny Cash"), track("Personal Jesus", "Johnny Cash")],
    "auto Hurt/Johnny Cash (exact)",
  ],
  [
    "C6 cover by catalogue w/ version label",
    "Don't Stop Believin'",
    [
      track("Don't Stop Believin' (Glee Cast Version)", "Glee Cast"),
      track("Don't Stop Believin'", "Journey"),
    ],
    "ask",
  ],
  [
    "D2 original first",
    "Love Story Taylor Swift",
    [track("Love Story", "Taylor Swift"), track("Love Story (Taylor's Version)", "Taylor Swift")],
    "auto Love Story/Taylor Swift (exact)",
  ],
  [
    "D3 asks TV",
    "Love Story Taylor's Version",
    [track("Love Story", "Taylor Swift"), track("Love Story (Taylor's Version)", "Taylor Swift")],
    "auto Love Story (Taylor's Version)/Taylor Swift (exact)",
  ],
  [
    "D10 remaster vs original (same recording)",
    "Bohemian Rhapsody Queen",
    [
      track("Bohemian Rhapsody - Remastered 2011", "Queen"),
      track("Bohemian Rhapsody", "Queen"),
      track("Bohemian Rhapsody", "Panic! At The Disco"),
    ],
    "auto Bohemian Rhapsody - Remastered 2011/Queen (exact)",
  ],
  [
    "D11 Live without marker (MTV Unplugged album) named",
    "The Man Who Sold the World Nirvana",
    [
      track("The Man Who Sold The World", "Nirvana"),
      track("The Man Who Sold the World - 2015 Remaster", "David Bowie"),
    ],
    "auto The Man Who Sold The World/Nirvana (exact)",
  ],
  [
    "D13 Edit",
    "Strobe deadmau5",
    [track("Strobe - Radio Edit", "deadmau5"), track("Strobe", "deadmau5")],
    "auto Strobe - Radio Edit/deadmau5 (exact)",
  ],
  [
    "D15 demo word in base?",
    "Live Forever Oasis",
    [track("Live Forever - Remastered", "Oasis"), track("Live Forever", "Oasis")],
    "auto Live Forever - Remastered/Oasis (exact)",
  ],
  [
    "E1 soundtrack credit",
    "Let It Go",
    [
      track('Let It Go - From "Frozen"/Soundtrack Version', "Idina Menzel"),
      track("Let It Go - Single Version", "Demi Lovato"),
      track("Let It Go", "James Bay"),
    ],
    "ask",
  ],
  [
    "E2 soundtrack named",
    "Let It Go Idina Menzel",
    [
      track('Let It Go - From "Frozen"/Soundtrack Version', "Idina Menzel"),
      track("Let It Go - Single Version", "Demi Lovato"),
    ],
    'auto Let It Go - From "Frozen"/Soundtrack Version/Idina Menzel (exact)',
  ],
  [
    "E4 classical, named performer",
    "Clair de Lune Seong-Jin Cho",
    [
      track("Clair de Lune", "Debussy", "Lang Lang"),
      track("Suite bergamasque, L. 75: III. Clair de lune", "Debussy", "Seong-Jin Cho"),
    ],
    "ask",
  ],
  [
    "E5 classical composer named",
    "Moonlight Sonata Beethoven",
    [
      track("Moonlight Sonata", "Ludwig van Beethoven", "Daniel Barenboim"),
      track("Moonlight Sonata", "Ludwig van Beethoven", "Valentina Lisitsa"),
      track(
        'Piano Sonata No. 14 in C-Sharp Minor, Op. 27 No. 2 "Moonlight": I. Adagio sostenuto',
        "Ludwig van Beethoven",
        "Wilhelm Kempff",
      ),
    ],
    "ask",
  ],
  [
    "E6 performer-first classical",
    "Clair de Lune",
    [track("Clair de Lune", "Isao Tomita"), track("Clair de Lune", "Debussy", "Lang Lang")],
    "ask",
  ],
  [
    "F1 feat. in query, with in credit",
    "Stay feat Justin Bieber",
    [
      track("STAY (with Justin Bieber)", "The Kid LAROI", "Justin Bieber"),
      track("Stay", "Rihanna", "Mikky Ekko"),
    ],
    "auto STAY (with Justin Bieber)/The Kid LAROI,Justin Bieber (exact)",
  ],
  [
    "F2 feat artist only remix",
    "Despacito Justin Bieber",
    [
      track("Despacito - Remix", "Luis Fonsi", "Daddy Yankee", "Justin Bieber"),
      track("Despacito", "Luis Fonsi", "Daddy Yankee"),
    ],
    "ask",
  ],
  [
    "F3 Old Town Road Billy Ray",
    "Old Town Road Billy Ray Cyrus",
    [
      track("Old Town Road (feat. Billy Ray Cyrus) - Remix", "Lil Nas X", "Billy Ray Cyrus"),
      track("Old Town Road", "Lil Nas X"),
    ],
    "ask",
  ],
  [
    "F4 feat artist named only, other song by feat artist",
    "Lean On MO",
    [
      track("Lean On (feat. MØ & DJ Snake)", "Major Lazer", "MØ", "DJ Snake"),
      track("Final Song", "MØ"),
    ],
    "auto Lean On (feat. MØ & DJ Snake)/Major Lazer,MØ,DJ Snake (exact)",
  ],
  [
    "G1 Latin title + Hangul artist",
    "Gangnam Style 싸이",
    [track("Gangnam Style (강남스타일)", "PSY")],
    "ask",
  ],
  [
    "G2 Japanese title + romanised artist",
    "夜に駆ける YOASOBI",
    [track("夜に駆ける", "YOASOBI"), track("Yoru ni Kakeru", "Rainych")],
    "auto 夜に駆ける/YOASOBI (exact)",
  ],
  [
    "G3 Cyrillic title + Latin artist",
    "Группа крови Kino",
    [track("Группа крови", "Кино"), track("Группа крови", "Би-2")],
    "ask",
  ],
  [
    "H1 Blinding Lights",
    "Blinding Lights",
    [
      track("Blinding Lights", "The Weeknd"),
      track("Blinding Lights (with ROSALÍA) - Remix", "The Weeknd", "ROSALÍA"),
      track("Blinding Lights - Chromatics Remix", "The Weeknd", "Chromatics"),
      track("Save Your Tears", "The Weeknd"),
      track("Blinding Lights", "KIDZ BOP Kids"),
      track("Blinding Lights - Sped Up", "Blinding Lights Sped Up"),
      track("Starboy", "The Weeknd", "Daft Punk"),
      track("The Hills", "The Weeknd"),
      track("Die For You", "The Weeknd"),
      track("After Hours", "The Weeknd"),
    ],
    "ask",
  ],
  [
    "H1b Blinding Lights no catalogue cover",
    "Blinding Lights",
    [
      track("Blinding Lights", "The Weeknd"),
      track("Blinding Lights (with ROSALÍA) - Remix", "The Weeknd", "ROSALÍA"),
      track("Save Your Tears", "The Weeknd"),
      track("Starboy", "The Weeknd", "Daft Punk"),
    ],
    "auto Blinding Lights/The Weeknd (exact)",
  ],
  [
    "H2 bad guy",
    "bad guy",
    [
      track("bad guy", "Billie Eilish"),
      track("bad guy (with Justin Bieber)", "Billie Eilish", "Justin Bieber"),
      track("Bad Guy", "Eminem"),
      track("Bad Guy (feat. Gerald Ellis)", "Hunna"),
      track("ocean eyes", "Billie Eilish"),
    ],
    "ask",
  ],
  [
    "H2b bad guy no rival",
    "bad guy",
    [
      track("bad guy", "Billie Eilish"),
      track("bad guy (with Justin Bieber)", "Billie Eilish", "Justin Bieber"),
      track("everything i wanted", "Billie Eilish"),
      track("Bad Habits", "Ed Sheeran"),
    ],
    "auto bad guy/Billie Eilish (exact)",
  ],
  [
    "H3 Despacito",
    "Despacito",
    [
      track("Despacito", "Luis Fonsi", "Daddy Yankee"),
      track("Despacito - Remix", "Luis Fonsi", "Daddy Yankee", "Justin Bieber"),
      track("Despacito", "KIDZ BOP Kids"),
      track("Echame La Culpa", "Luis Fonsi", "Demi Lovato"),
    ],
    "ask",
  ],
  [
    "H4 Shape of You",
    "Shape of You",
    [
      track("Shape of You", "Ed Sheeran"),
      track("Shape of You (feat. Stormzy) - Remix", "Ed Sheeran", "Stormzy"),
      track("Shape of You - Acoustic", "Ed Sheeran"),
      track("Shape of You", "Boyce Avenue"),
      track("Perfect", "Ed Sheeran"),
    ],
    "ask",
  ],
  [
    "H5 Bohemian Rhapsody",
    "Bohemian Rhapsody",
    [
      track("Bohemian Rhapsody - Remastered 2011", "Queen"),
      track("Bohemian Rhapsody - Live Aid", "Queen"),
      track("Bohemian Rhapsody", "Panic! At The Disco"),
      track("Bohemian Rhapsody", "Pentatonix"),
    ],
    "ask",
  ],
  [
    "H6 Smells Like Teen Spirit",
    "Smells Like Teen Spirit",
    [
      track("Smells Like Teen Spirit", "Nirvana"),
      track("Smells Like Teen Spirit - Remastered 2021", "Nirvana"),
      track("Come As You Are", "Nirvana"),
    ],
    "auto Smells Like Teen Spirit/Nirvana (exact)",
  ],
  [
    "H7 web form hit",
    "Blinding Lights The Weeknd",
    [track("Blinding Lights", "The Weeknd"), track("Blinding Lights", "KIDZ BOP Kids")],
    "auto Blinding Lights/The Weeknd (exact)",
  ],
  [
    "I1 two named artists, one exact",
    "Under Pressure Queen David Bowie",
    [
      track("Under Pressure - Remastered 2011", "Queen", "David Bowie"),
      track("Under Pressure", "Queen"),
    ],
    "auto Under Pressure - Remastered 2011/Queen,David Bowie (exact)",
  ],
  [
    "I2 named artist exact + named artist other song same title",
    "Angel Massive Attack",
    [track("Angel", "Massive Attack"), track("Angel - Mad Professor Remix", "Massive Attack")],
    "auto Angel/Massive Attack (exact)",
  ],
  [
    "I3 The Cure",
    "The Cure",
    [track("The Cure", "Lady Gaga"), track("Just Like Heaven", "The Cure")],
    "ask",
  ],
  [
    "I4 query only 'Live'",
    "Live",
    [track("Live", "Some Artist"), track("Lightning Crashes", "Live")],
    "ask",
  ],
  [
    "I5 artist name equals version word, query names",
    "Lightning Crashes Live",
    [track("Lightning Crashes", "Live"), track("Lightning Crashes - Live", "Some Band")],
    "auto Lightning Crashes/Live (exact)",
  ],
  [
    "I6 feat. on rival shared lead",
    "Run",
    [track("Run", "Snow Patrol"), track("Run", "Leona Lewis", "Snow Patrol")],
    "auto Run/Snow Patrol (exact)",
  ],
];

// A cover spelt like the query that Spotify lists before the original: the original's
// title, spelt another way or in another script, still makes it a choice.
const coverFirst: Case[] = [
  [
    "Petra Haden's cover listed before Journey's original",
    "Dont Stop Believing",
    [
      track("Don't Stop Believing", "Petra Haden"),
      track("Don't Stop Believin'", "Journey"),
      track("Any Way You Want It", "Journey"),
    ],
    "ask",
  ],
  [
    "Sheryl Crow's cover listed before Guns N' Roses' original",
    "Sweet Child of Mine",
    [
      track("Sweet Child of Mine", "Sheryl Crow"),
      track("Sweet Child O' Mine", "Guns N' Roses"),
      track("November Rain", "Guns N' Roses"),
    ],
    "ask",
  ],
  [
    "Chris Cornell's cover listed before Sinéad O'Connor's recording",
    "Nothing Compares to You",
    [
      track("Nothing Compares to You", "Chris Cornell"),
      track("Nothing Compares 2 U", "Sinéad O'Connor"),
    ],
    "ask",
  ],
  [
    "a cover with the romanised title listed before the Japanese original",
    "Yoru ni Kakeru",
    [track("Yoru ni Kakeru", "Rainych"), track("夜に駆ける", "YOASOBI")],
    "ask",
  ],
  [
    "a cover spelt out listed before Ariana Grande's original",
    "thank you next",
    [track("Thank You Next", "Kidz Bop Kids"), track("thank u, next", "Ariana Grande")],
    "ask",
  ],
  [
    "the artist's own songs in other spellings do not make a choice",
    "Dont Stop Believing",
    [track("Don't Stop Believing", "Journey"), track("Don't Stop Believin' - Live", "Journey")],
    "auto Don't Stop Believing/Journey (exact)",
  ],
];

describe("the scout's decision", () => {
  it.each(corrected)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(kept)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(second)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(secondKept)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(coverFirst)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });

  it.each([
    [
      "Yellow",
      [
        track("Shotgun", "Yellow Claw"),
        track("Yellow", "Coldplay"),
        track("Yellow - Live", "Coldplay"),
      ],
      ["Yellow/Coldplay", "Yellow - Live/Coldplay", "Shotgun/Yellow Claw"],
    ],
    [
      "The Cure",
      [track("Just Like Heaven", "The Cure"), track("The Cure", "Lady Gaga")],
      ["The Cure/Lady Gaga", "Just Like Heaven/The Cure"],
    ],
  ])(
    "lists title matches for %j before songs that match only by artist",
    (query, tracks, order) => {
      expect(rankTracks(query, tracks).map((r) => r.track.id)).toEqual(order);
      expect(needsChoice(rankTracks(query, tracks))).toBe(true);
    },
  );

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

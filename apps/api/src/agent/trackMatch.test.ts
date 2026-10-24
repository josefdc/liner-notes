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
    const query = "hurt johnny cash";
    expect(
      needsChoice(
        rankTracks("hurt", [track("Hurt", "Johnny Cash"), track("Hurt", "Nine Inch Nails")]),
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

// Covers, karaoke and other recordings that looked like the requested song, and queries that
// name an artist in ways the matching has to read.
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
    "a Korean title with the artist selects PSY's song over a karaoke track with that title",
    "강남스타일 PSY",
    [
      track("Gangnam Style (강남스타일)", "PSY"),
      track("강남스타일 (Karaoke Version)", "Ameritz K-Pop Karaoke"),
    ],
    "auto Gangnam Style (강남스타일)/PSY (exact)",
  ],
  [
    "a Korean title with the artist matches the Korean title in brackets",
    "강남스타일 PSY",
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
    "Blinding Lights remix The Weeknd",
    [
      track("Blinding Lights", "The Weeknd"),
      track("Blinding Lights (with ROSALÍA) - Remix", "The Weeknd", "ROSALÍA"),
    ],
    "auto Blinding Lights (with ROSALÍA) - Remix/The Weeknd,ROSALÍA (exact)",
  ],
  [
    "a query that asks for a live take selects the live take",
    "Hotel California live Eagles",
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

// Same-title songs, named artists and versions the query asks for.
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
    "Despacito Luis Fonsi",
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

// Titles spelt otherwise than the original, artists whose name is a title, and
// re-recordings.
const second: Case[] = [
  [
    "spelling, title only",
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
    "common misspelling",
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
    "longer common title",
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
    "longer common title, one cover",
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
    "numerals",
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
    "romanised title only",
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
    "romanised title only, another song",
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
    "transliterated title only",
    "Gruppa Krovi",
    [track("Группа крови", "Кино"), track("Gruppa Krovi", "Lumen"), track("Кукушка", "Кино")],
    "ask",
  ],
  [
    "thank u next",
    "thank you next",
    [
      track("thank u, next", "Ariana Grande"),
      track("7 rings", "Ariana Grande"),
      track("Thank You Next", "Kidz Bop Kids"),
    ],
    "ask",
  ],
  [
    "artist == title of another's song",
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
    "Talk Talk",
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
    "act named after the song (tribute without a marker)",
    "Hotel California",
    [
      track("Hotel California - 2013 Remaster", "Eagles"),
      track("Hotel California", "Gipsy Kings"),
      track("Hotel California", "Hotel California"),
    ],
    "ask",
  ],
  [
    "act named after the song, original only otherwise",
    "Dancing Queen",
    [
      track("Dancing Queen", "ABBA"),
      track("Dancing Queen", "Dancing Queen"),
      track("Mamma Mia", "ABBA"),
    ],
    "ask",
  ],
  [
    "title-word artist covers title",
    "Bennie and the Jets",
    [
      track("Bennie And The Jets - Remastered 2014", "Elton John"),
      track("Bennie and the Jets", "The Jets"),
    ],
    "ask",
  ],
  [
    "partial-name artist with exact title",
    "Angel",
    [
      track("Angel", "Shaggy", "Rayvon"),
      track("Angel", "Sarah McLachlan"),
      track("Angel", "Angel Olsen"),
    ],
    "ask",
  ],
  [
    "Prince Ali with Prince tracks",
    "Prince Ali",
    [
      track("Prince Ali", "Robin Williams"),
      track("Purple Rain", "Prince"),
      track("Prince Ali - Reprise", "Robin Williams"),
    ],
    "ask",
  ],
  [
    "word-artist inside title, Love",
    "Crazy in Love",
    [track("Crazy In Love (feat. Jay-Z)", "Beyoncé", "JAY-Z"), track("Alone Again Or", "Love")],
    "ask",
  ],
  [
    "Future in title",
    "Future Nostalgia",
    [track("Future Nostalgia", "Dua Lipa"), track("Mask Off", "Future")],
    "ask",
  ],
  [
    "artist-only self-titled",
    "Iron Maiden",
    [
      track("The Trooper - 2015 Remaster", "Iron Maiden"),
      track("Iron Maiden", "Iron Maiden"),
      track("Run to the Hills", "Iron Maiden"),
    ],
    "ask",
  ],
  [
    "Taylor's Version first, original second, named",
    "Love Story Taylor Swift",
    [
      track("Love Story (Taylor's Version)", "Taylor Swift"),
      track("Love Story", "Taylor Swift"),
      track("Love Story", "Indila"),
    ],
    "auto Love Story/Taylor Swift (exact)",
  ],
  [
    "Re-Recorded first",
    "Kung Fu Fighting Carl Douglas",
    [
      track("Kung Fu Fighting (Re-Recorded)", "Carl Douglas"),
      track("Kung Fu Fighting", "Carl Douglas"),
    ],
    "auto Kung Fu Fighting/Carl Douglas (exact)",
  ],
  [
    "Rerecorded dash",
    "Kung Fu Fighting Carl Douglas",
    [
      track("Kung Fu Fighting - Rerecorded", "Carl Douglas"),
      track("Kung Fu Fighting", "Carl Douglas"),
    ],
    "auto Kung Fu Fighting/Carl Douglas (exact)",
  ],
  [
    "Stripped first",
    "Chandelier Sia",
    [track("Chandelier - Stripped", "Sia"), track("Chandelier", "Sia")],
    "auto Chandelier/Sia (exact)",
  ],
  [
    "Orchestral first",
    "Bitter Sweet Symphony The Verve",
    [
      track("Bitter Sweet Symphony - Orchestral Version", "The Verve"),
      track("Bitter Sweet Symphony", "The Verve"),
    ],
    "auto Bitter Sweet Symphony/The Verve (exact)",
  ],
  [
    "acapella",
    "Toxic Britney Spears",
    [track("Toxic - A Cappella", "Britney Spears"), track("Toxic", "Britney Spears")],
    "auto Toxic/Britney Spears (exact)",
  ],
  [
    "Spanish version",
    "Despacito Luis Fonsi",
    [
      track("Despacito - Versión Pop", "Luis Fonsi"),
      track("Despacito", "Luis Fonsi", "Daddy Yankee"),
    ],
    "auto Despacito/Luis Fonsi,Daddy Yankee (exact)",
  ],
  [
    "sessions",
    "Wonderwall Oasis",
    [track("Wonderwall - BBC Session", "Oasis"), track("Wonderwall - Remastered", "Oasis")],
    "auto Wonderwall - Remastered/Oasis (exact)",
  ],
  [
    "VIP / Bootleg / Rework",
    "Levels Avicii",
    [
      track("Levels - Skrillex Remix", "Avicii"),
      track("Levels - Rework", "Avicii"),
      track("Levels", "Avicii"),
    ],
    "auto Levels/Avicii (exact)",
  ],
  [
    "version phrase in title base",
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

// More titles, artists and versions: classical, soundtrack and mixed-script queries.
const secondKept: Case[] = [
  [
    "partial-name artist, no exact",
    "Yellow",
    [
      track("Yellow", "Coldplay"),
      track("Shotgun", "Yellow Claw"),
      track("Yellow - Live", "Coldplay"),
    ],
    "ask",
  ],
  [
    "Seal as artist named in query",
    "Kiss from a Rose",
    [track("Kiss from a Rose", "Seal"), track("Kiss from a Rose", "Kidz Bop Kids")],
    "ask",
  ],
  [
    "Hurt neither named",
    "Hurt",
    [
      track("Hurt", "Johnny Cash"),
      track("Hurt", "Nine Inch Nails"),
      track("Hurt - Live", "Johnny Cash"),
    ],
    "ask",
  ],
  [
    "Hallelujah",
    "Hallelujah",
    [
      track("Hallelujah", "Jeff Buckley"),
      track("Hallelujah", "Leonard Cohen"),
      track("Hallelujah", "Pentatonix"),
    ],
    "ask",
  ],
  [
    "Watchtower",
    "All Along the Watchtower",
    [
      track("All Along the Watchtower", "Jimi Hendrix"),
      track("All Along the Watchtower", "Bob Dylan"),
    ],
    "ask",
  ],
  [
    "Watchtower named Dylan",
    "All Along the Watchtower Bob Dylan",
    [
      track("All Along the Watchtower", "Jimi Hendrix"),
      track("All Along the Watchtower", "Bob Dylan"),
    ],
    "auto All Along the Watchtower/Bob Dylan (exact)",
  ],
  [
    "only cover present (original absent)",
    "Hurt",
    [track("Hurt", "Johnny Cash"), track("Personal Jesus", "Johnny Cash")],
    "ask",
  ],
  [
    "cover by catalogue with version label",
    "Don't Stop Believin'",
    [
      track("Don't Stop Believin' (Glee Cast Version)", "Glee Cast"),
      track("Don't Stop Believin'", "Journey"),
    ],
    "ask",
  ],
  [
    "original first",
    "Love Story Taylor Swift",
    [track("Love Story", "Taylor Swift"), track("Love Story (Taylor's Version)", "Taylor Swift")],
    "auto Love Story/Taylor Swift (exact)",
  ],
  [
    "asks TV",
    "Love Story Taylor's Version",
    [track("Love Story", "Taylor Swift"), track("Love Story (Taylor's Version)", "Taylor Swift")],
    "ask",
  ],
  [
    "remaster vs original (same recording)",
    "Bohemian Rhapsody Queen",
    [
      track("Bohemian Rhapsody - Remastered 2011", "Queen"),
      track("Bohemian Rhapsody", "Queen"),
      track("Bohemian Rhapsody", "Panic! At The Disco"),
    ],
    "auto Bohemian Rhapsody - Remastered 2011/Queen (exact)",
  ],
  [
    "Live without marker (MTV Unplugged album) named",
    "The Man Who Sold the World Nirvana",
    [
      track("The Man Who Sold The World", "Nirvana"),
      track("The Man Who Sold the World - 2015 Remaster", "David Bowie"),
    ],
    "auto The Man Who Sold The World/Nirvana (exact)",
  ],
  [
    "Edit",
    "Strobe deadmau5",
    [track("Strobe - Radio Edit", "deadmau5"), track("Strobe", "deadmau5")],
    "auto Strobe - Radio Edit/deadmau5 (exact)",
  ],
  [
    "demo word in base?",
    "Live Forever Oasis",
    [track("Live Forever - Remastered", "Oasis"), track("Live Forever", "Oasis")],
    "auto Live Forever - Remastered/Oasis (exact)",
  ],
  [
    "soundtrack credit",
    "Let It Go",
    [
      track('Let It Go - From "Frozen"/Soundtrack Version', "Idina Menzel"),
      track("Let It Go - Single Version", "Demi Lovato"),
      track("Let It Go", "James Bay"),
    ],
    "ask",
  ],
  [
    "soundtrack named",
    "Let It Go Idina Menzel",
    [
      track('Let It Go - From "Frozen"/Soundtrack Version', "Idina Menzel"),
      track("Let It Go - Single Version", "Demi Lovato"),
    ],
    'auto Let It Go - From "Frozen"/Soundtrack Version/Idina Menzel (exact)',
  ],
  [
    "classical, named performer",
    "Clair de Lune Seong-Jin Cho",
    [
      track("Clair de Lune", "Debussy", "Lang Lang"),
      track("Suite bergamasque, L. 75: III. Clair de lune", "Debussy", "Seong-Jin Cho"),
    ],
    "ask",
  ],
  [
    "classical composer named",
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
    "performer-first classical",
    "Clair de Lune",
    [track("Clair de Lune", "Isao Tomita"), track("Clair de Lune", "Debussy", "Lang Lang")],
    "ask",
  ],
  [
    "feat. in query, with in credit",
    "Stay feat Justin Bieber",
    [
      track("STAY (with Justin Bieber)", "The Kid LAROI", "Justin Bieber"),
      track("Stay", "Rihanna", "Mikky Ekko"),
    ],
    "auto STAY (with Justin Bieber)/The Kid LAROI,Justin Bieber (exact)",
  ],
  [
    "feat artist only remix",
    "Despacito Justin Bieber",
    [
      track("Despacito - Remix", "Luis Fonsi", "Daddy Yankee", "Justin Bieber"),
      track("Despacito", "Luis Fonsi", "Daddy Yankee"),
    ],
    "ask",
  ],
  [
    "Old Town Road Billy Ray",
    "Old Town Road Billy Ray Cyrus",
    [
      track("Old Town Road (feat. Billy Ray Cyrus) - Remix", "Lil Nas X", "Billy Ray Cyrus"),
      track("Old Town Road", "Lil Nas X"),
    ],
    "ask",
  ],
  [
    "feat artist named only, other song by feat artist",
    "Lean On MO",
    [
      track("Lean On (feat. MØ & DJ Snake)", "Major Lazer", "MØ", "DJ Snake"),
      track("Final Song", "MØ"),
    ],
    "auto Lean On (feat. MØ & DJ Snake)/Major Lazer,MØ,DJ Snake (exact)",
  ],
  [
    "Latin title + Hangul artist",
    "Gangnam Style 싸이",
    [track("Gangnam Style (강남스타일)", "PSY")],
    "ask",
  ],
  [
    "Japanese title + romanised artist",
    "夜に駆ける YOASOBI",
    [track("夜に駆ける", "YOASOBI"), track("Yoru ni Kakeru", "Rainych")],
    "auto 夜に駆ける/YOASOBI (exact)",
  ],
  [
    "Cyrillic title + Latin artist",
    "Группа крови Kino",
    [track("Группа крови", "Кино"), track("Группа крови", "Би-2")],
    "ask",
  ],
  [
    "Blinding Lights",
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
    "Blinding Lights no catalogue cover",
    "Blinding Lights",
    [
      track("Blinding Lights", "The Weeknd"),
      track("Blinding Lights (with ROSALÍA) - Remix", "The Weeknd", "ROSALÍA"),
      track("Save Your Tears", "The Weeknd"),
      track("Starboy", "The Weeknd", "Daft Punk"),
    ],
    "ask",
  ],
  [
    "bad guy",
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
    "bad guy no rival",
    "bad guy",
    [
      track("bad guy", "Billie Eilish"),
      track("bad guy (with Justin Bieber)", "Billie Eilish", "Justin Bieber"),
      track("everything i wanted", "Billie Eilish"),
      track("Bad Habits", "Ed Sheeran"),
    ],
    "ask",
  ],
  [
    "Despacito",
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
    "Shape of You",
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
    "Bohemian Rhapsody",
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
    "Smells Like Teen Spirit",
    "Smells Like Teen Spirit",
    [
      track("Smells Like Teen Spirit", "Nirvana"),
      track("Smells Like Teen Spirit - Remastered 2021", "Nirvana"),
      track("Come As You Are", "Nirvana"),
    ],
    "ask",
  ],
  [
    "web form hit",
    "Blinding Lights The Weeknd",
    [track("Blinding Lights", "The Weeknd"), track("Blinding Lights", "KIDZ BOP Kids")],
    "auto Blinding Lights/The Weeknd (exact)",
  ],
  [
    "two named artists, one exact",
    "Under Pressure Queen David Bowie",
    [
      track("Under Pressure - Remastered 2011", "Queen", "David Bowie"),
      track("Under Pressure", "Queen"),
    ],
    "auto Under Pressure - Remastered 2011/Queen,David Bowie (exact)",
  ],
  [
    "named artist exact + named artist other song same title",
    "Angel Massive Attack",
    [track("Angel", "Massive Attack"), track("Angel - Mad Professor Remix", "Massive Attack")],
    "auto Angel/Massive Attack (exact)",
  ],
  [
    "The Cure",
    "The Cure",
    [track("The Cure", "Lady Gaga"), track("Just Like Heaven", "The Cure")],
    "ask",
  ],
  [
    "query only 'Live'",
    "Live",
    [track("Live", "Some Artist"), track("Lightning Crashes", "Live")],
    "ask",
  ],
  [
    "artist name equals version word, query names",
    "Lightning Crashes Live",
    [track("Lightning Crashes", "Live"), track("Lightning Crashes - Live", "Some Band")],
    "auto Lightning Crashes/Live (exact)",
  ],
  [
    "feat. on rival shared lead",
    "Run",
    [track("Run", "Snow Patrol"), track("Run", "Leona Lewis", "Snow Patrol")],
    "ask",
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
    "ask",
  ],
];

// A version word inside the title, the named artist featured on another recording, take
// labels the rules do not know, and titles alone (which always ask).
const third: Case[] = [
  [
    "live take, studio credited to Wings",
    "Live and Let Die Paul McCartney",
    [
      track("Live And Let Die - Live", "Paul McCartney"),
      track("Live And Let Die - 2018 Remaster", "Wings"),
      track("Live and Let Die", "Guns N' Roses"),
      track("Live And Let Die - Live At Amoeba", "Paul McCartney"),
      track("Hey Jude - Live", "Paul McCartney"),
      track("Band On The Run - 2010 Remaster", "Wings"),
      track("Jet - 2010 Remaster", "Wings"),
      track("Maybe I'm Amazed - Remastered 2011", "Paul McCartney"),
      track("Let It Be - Live", "Paul McCartney"),
      track("Live And Let Die - Live / Remastered", "Wings"),
    ],
    "ask",
  ],
  [
    "live first, studio credited to both",
    "Live and Let Die Paul McCartney",
    [
      track("Live And Let Die - Live", "Paul McCartney"),
      track("Live And Let Die - 2018 Remaster", "Paul McCartney", "Wings"),
      track("Live and Let Die", "Guns N' Roses"),
    ],
    "auto Live And Let Die - 2018 Remaster/Paul McCartney,Wings (exact)",
  ],
  [
    "same, live first (asks for nothing live)",
    "Live and Let Die Wings",
    [
      track("Live And Let Die - Live", "Paul McCartney", "Wings"),
      track("Live And Let Die - 2018 Remaster", "Paul McCartney", "Wings"),
    ],
    "auto Live And Let Die - 2018 Remaster/Paul McCartney,Wings (exact)",
  ],
  [
    "Live Forever, Knebworth first",
    "Live Forever Oasis",
    [
      track("Live Forever (Live at Knebworth, 10 August '96)", "Oasis"),
      track("Live Forever - Remastered", "Oasis"),
      track("Wonderwall - Remastered", "Oasis"),
    ],
    "auto Live Forever - Remastered/Oasis (exact)",
  ],
  [
    "title only, all Oasis, Knebworth first",
    "Live Forever",
    [
      track("Live Forever (Live at Knebworth, 10 August '96)", "Oasis"),
      track("Live Forever - Remastered", "Oasis"),
      track("Wonderwall - Remastered", "Oasis"),
      track("Champagne Supernova - Remastered", "Oasis"),
    ],
    "ask",
  ],
  [
    "Live Wire",
    "Live Wire Motley Crue",
    [track("Live Wire - Live", "Mötley Crüe"), track("Live Wire", "Mötley Crüe")],
    "auto Live Wire/Mötley Crüe (exact)",
  ],
  [
    "Acoustic #3 acoustic take",
    "Acoustic #3 Goo Goo Dolls",
    [
      track("Acoustic #3 - Acoustic", "The Goo Goo Dolls"),
      track("Acoustic #3", "The Goo Goo Dolls"),
    ],
    "auto Acoustic #3/The Goo Goo Dolls (exact)",
  ],
  [
    "Higher Love, Kygo first",
    "Higher Love Whitney Houston",
    [
      track("Higher Love", "Kygo", "Whitney Houston"),
      track("Higher Love", "Whitney Houston"),
      track("Higher Love", "Steve Winwood"),
      track("Higher Love", "James Vincent McMorrow"),
      track("I Wanna Dance with Somebody (Who Loves Me)", "Whitney Houston"),
      track("Firestone", "Kygo", "Conrad Sewell"),
    ],
    "ask",
  ],
  [
    "Unforgettable duet first",
    "Unforgettable Nat King Cole",
    [
      track("Unforgettable", "Natalie Cole", "Nat King Cole"),
      track("Unforgettable", "Nat King Cole"),
      track("Unforgettable", "French Montana", "Swae Lee"),
      track("L-O-V-E", "Nat King Cole"),
    ],
    "ask",
  ],
  [
    "Wonderful World Kenny G first",
    "What a Wonderful World Louis Armstrong",
    [
      track("What A Wonderful World", "Kenny G", "Louis Armstrong"),
      track("What A Wonderful World", "Louis Armstrong"),
    ],
    "ask",
  ],
  [
    "RPO overdub first",
    "If I Can Dream Elvis Presley",
    [
      track(
        "If I Can Dream (with the Royal Philharmonic Orchestra)",
        "Elvis Presley",
        "Royal Philharmonic Orchestra",
      ),
      track("If I Can Dream", "Elvis Presley"),
    ],
    "ask",
  ],
  [
    "RPO overdub first, title only",
    "If I Can Dream",
    [
      track(
        "If I Can Dream (with the Royal Philharmonic Orchestra)",
        "Elvis Presley",
        "Royal Philharmonic Orchestra",
      ),
      track("If I Can Dream", "Elvis Presley"),
      track("Burning Love", "Elvis Presley"),
    ],
    "ask",
  ],
  [
    "RPO, Can't Help Falling, named",
    "Can't Help Falling in Love Elvis Presley",
    [
      track(
        "Can't Help Falling in Love (with the Royal Philharmonic Orchestra)",
        "Elvis Presley",
        "Royal Philharmonic Orchestra",
      ),
      track("Can't Help Falling in Love", "Elvis Presley"),
      track("Can't Help Falling in Love", "Kina Grannis"),
      track("Can't Help Falling In Love", "UB40"),
    ],
    "ask",
  ],
  [
    "Tom's Diner DNA first, named Vega",
    "Tom's Diner Suzanne Vega",
    [
      track("Tom's Diner", "DNA", "Suzanne Vega"),
      track("Tom's Diner", "Suzanne Vega"),
      track("Tom's Diner", "AnnenMayKantereit", "Giant Rooks"),
      track("Luka", "Suzanne Vega"),
    ],
    "ask",
  ],
  [
    "Run cover credits original",
    "Run Snow Patrol",
    [track("Run", "Leona Lewis", "Snow Patrol"), track("Run", "Snow Patrol")],
    "ask",
  ],
  [
    "orchestra credit bracket, LSO",
    "Bohemian Rhapsody Queen",
    [
      track(
        "Bohemian Rhapsody (feat. London Symphony Orchestra)",
        "Queen",
        "London Symphony Orchestra",
      ),
      track("Bohemian Rhapsody - Remastered 2011", "Queen"),
    ],
    "ask",
  ],
  [
    "Def Leppard forgery (2012)",
    "Pour Some Sugar on Me Def Leppard",
    [
      track("Pour Some Sugar On Me (2012)", "Def Leppard"),
      track("Pour Some Sugar On Me", "Def Leppard"),
    ],
    "ask",
  ],
  [
    "Re-Recording",
    "Tainted Love Soft Cell",
    [track("Tainted Love (Re-Recording)", "Soft Cell"), track("Tainted Love", "Soft Cell")],
    "ask",
  ],
  [
    "Re-Record",
    "Tainted Love Soft Cell",
    [track("Tainted Love - Re-Record", "Soft Cell"), track("Tainted Love", "Soft Cell")],
    "ask",
  ],
  [
    "Spotify Studios",
    "Dancing On My Own Robyn",
    [
      track("Dancing On My Own - Recorded at Spotify Studios NYC", "Robyn"),
      track("Dancing On My Own", "Robyn"),
    ],
    "ask",
  ],
  [
    "Spotify Singles",
    "Ocean Eyes Billie Eilish",
    [track("ocean eyes - Spotify Singles", "Billie Eilish"), track("ocean eyes", "Billie Eilish")],
    "ask",
  ],
  [
    "Alternate take",
    "Strawberry Fields Forever The Beatles",
    [
      track("Strawberry Fields Forever - Take 7", "The Beatles"),
      track("Strawberry Fields Forever - Remastered 2009", "The Beatles"),
    ],
    "ask",
  ],
  [
    "New recording",
    "Total Eclipse of the Heart Bonnie Tyler",
    [
      track("Total Eclipse of the Heart (New Recording)", "Bonnie Tyler"),
      track("Total Eclipse of the Heart", "Bonnie Tyler"),
    ],
    "ask",
  ],
  [
    "Home recording / outtake",
    "Yesterday The Beatles",
    [
      track("Yesterday - Outtake", "The Beatles"),
      track("Yesterday - Remastered 2009", "The Beatles"),
    ],
    "ask",
  ],
  [
    "Re-recording title only, artist-only list",
    "Tainted Love",
    [
      track("Tainted Love (Re-Recording)", "Soft Cell"),
      track("Tainted Love", "Soft Cell"),
      track("Say Hello, Wave Goodbye", "Soft Cell"),
    ],
    "ask",
  ],
  [
    "YMCA cover first",
    "YMCA",
    [
      track("YMCA", "The Party Hits Band"),
      track("Y.M.C.A.", "Village People"),
      track("In the Navy", "Village People"),
      track("Macho Man", "Village People"),
    ],
    "ask",
  ],
  [
    "Skater Boy",
    "Skater Boy",
    [
      track("Skater Boy", "Pop Punk Kids"),
      track("Sk8er Boi", "Avril Lavigne"),
      track("Complicated", "Avril Lavigne"),
    ],
    "ask",
  ],
  [
    "Gangster's Paradise",
    "Gangsters Paradise",
    [track("Gangster's Paradise", "Some Covers"), track("Gangsta's Paradise", "Coolio", "L.V.")],
    "ask",
  ],
  [
    "Numa Numa",
    "Numa Numa",
    [track("Numa Numa", "Party DJs"), track("Dragostea Din Tei", "O-Zone")],
    "ask",
  ],
  [
    "PYT",
    "PYT",
    [track("PYT", "Some Band"), track("P.Y.T. (Pretty Young Thing)", "Michael Jackson")],
    "ask",
  ],
  [
    "Wanna Be",
    "Wanna Be",
    [track("Wanna Be", "Some Band"), track("Wannabe", "Spice Girls")],
    "ask",
  ],
  [
    "Sukiyaki translated",
    "Sukiyaki",
    [track("Sukiyaki", "A Taste of Honey"), track("Ue O Muite Arukou", "Kyu Sakamoto")],
    "ask",
  ],
  [
    "Ketchup Song",
    "The Ketchup Song",
    [track("The Ketchup Song", "Party Hits"), track("Aserejé", "Las Ketchup")],
    "ask",
  ],
  [
    "More Money More Problems",
    "More Money More Problems",
    [
      track("More Money More Problems", "Some Rapper"),
      track(
        "Mo Money Mo Problems (feat. Puff Daddy & Mase)",
        "The Notorious B.I.G.",
        "Puff Daddy",
        "Mase",
      ),
    ],
    "ask",
  ],
  [
    "Sk8er Boi with translit",
    "Sk8ter Boy",
    [track("Sk8ter Boy", "X"), track("Sk8er Boi", "Avril Lavigne")],
    "ask",
  ],
  [
    "Ievan Polkka",
    "Leva's Polka",
    [track("Leva's Polka", "Hatsune Miku"), track("Ievan Polkka", "Loituma")],
    "ask",
  ],
];

// Same-name artists, tribute acts and titles that hold an artist's name.
const thirdKept: Case[] = [
  [
    "studio first, live second, credited to both",
    "Live and Let Die Wings",
    [
      track("Live And Let Die - 2018 Remaster", "Paul McCartney", "Wings"),
      track("Live And Let Die - Live", "Paul McCartney", "Wings"),
    ],
    "auto Live And Let Die - 2018 Remaster/Paul McCartney,Wings (exact)",
  ],
  [
    "control: Wonderwall live first",
    "Wonderwall Oasis",
    [
      track("Wonderwall (Live at Knebworth, 10 August '96)", "Oasis"),
      track("Wonderwall - Remastered", "Oasis"),
    ],
    "auto Wonderwall - Remastered/Oasis (exact)",
  ],
  [
    "Piano Man piano cover first, named",
    "Piano Man Billy Joel",
    [track("Piano Man - Piano Version", "Billy Joel"), track("Piano Man", "Billy Joel")],
    "auto Piano Man/Billy Joel (exact)",
  ],
  [
    "Mix tape word",
    "Mixtape Butch Walker",
    [track("Mixtape - Remix", "Butch Walker"), track("Mixtape", "Butch Walker")],
    "auto Mixtape/Butch Walker (exact)",
  ],
  [
    "cover act + original featured, title only",
    "Hurt",
    [track("Hurt", "The Cash Brothers", "Johnny Cash"), track("Hurt", "Johnny Cash")],
    "ask",
  ],
  [
    "Extended",
    "Blue Monday New Order",
    [track("Blue Monday '88 - Extended", "New Order"), track("Blue Monday", "New Order")],
    "auto Blue Monday/New Order (exact)",
  ],
  [
    "YMCA original first",
    "YMCA",
    [track("Y.M.C.A.", "Village People"), track("YMCA", "The Party Hits Band")],
    "ask",
  ],
  [
    "Smells Like Teen Spirit misspelt",
    "Smells Like Teen Sprit",
    [track("Smells Like Teen Sprit", "Some Band"), track("Smells Like Teen Spirit", "Nirvana")],
    "ask",
  ],
  [
    "Every Breath (one word dropped)",
    "Every Breath You Take",
    [
      track("Every Breath You Take", "Some Band"),
      track("Every Breath You Take - Remastered 2003", "The Police"),
    ],
    "ask",
  ],
  [
    "Dont Stop Me Now cover first",
    "Dont Stop Me Now",
    [track("Dont Stop Me Now", "Some Band"), track("Don't Stop Me Now - Remastered 2011", "Queen")],
    "ask",
  ],
  [
    "same-name cover act",
    "Hurt Johnny Cash",
    [track("Hurt", "Johnny Cash"), track("Hurt", "Johnny Cash")],
    "auto Hurt/Johnny Cash (exact)",
  ],
  [
    "Various Artists named query",
    "Hurt Johnny Cash",
    [track("Hurt", "Various Artists"), track("Hurt", "Johnny Cash")],
    "auto Hurt/Johnny Cash (exact)",
  ],
  [
    "Various Artists title only",
    "Hurt",
    [track("Hurt", "Various Artists"), track("Hurt - 2002", "Johnny Cash")],
    "ask",
  ],
  [
    "tribute credits original as lead",
    "Hurt Johnny Cash",
    [track("Hurt", "Johnny Cash", "Johnny Cash Tribute Band"), track("Hurt", "Johnny Cash")],
    "auto Hurt/Johnny Cash (exact)",
  ],
  [
    "named artist covers another's song, original present",
    "Valerie Amy Winehouse",
    [
      track("Valerie", "The Zutons"),
      track("Valerie (Version Revisited)", "Mark Ronson", "Amy Winehouse"),
      track("Valerie - Live at BBC", "Amy Winehouse"),
    ],
    "ask",
  ],
  [
    "named artist only has cover; query means own different song",
    "Hallelujah Paramore",
    [track("Hallelujah", "Paramore"), track("Hallelujah", "Jeff Buckley")],
    "auto Hallelujah/Paramore (exact)",
  ],
  [
    "named partial vs named exact",
    "Yesterday Beatles",
    [
      track("Yesterday Once More", "The Beatles"),
      track("Yesterday - Remastered 2009", "The Beatles"),
    ],
    "auto Yesterday - Remastered 2009/The Beatles (exact)",
  ],
  [
    "artist word inside another title (span from another result)",
    "Queen of Hearts Queen",
    [track("Queen of Hearts", "Juice Newton"), track("Killer Queen - Remastered 2011", "Queen")],
    "ask",
  ],
  [
    "longest span from another result swallows the artist",
    "Hurt Johnny Cash",
    [
      track("Hurt", "Johnny Cash"),
      track("Hurt Johnny Cash", "Tribute Kids"),
      track("Hurt", "Nine Inch Nails"),
    ],
    "ask",
  ],
  [
    "query equals the title of the named artist's other song",
    "Johnny Cash",
    [track("Johnny Cash", "Sons of Bill"), track("Hurt", "Johnny Cash")],
    "ask",
  ],
  [
    "feat in query names the cover's lead only",
    "Hurt with Johnny Cash",
    [track("Hurt", "Johnny Cash"), track("Hurt", "Nine Inch Nails")],
    "auto Hurt/Johnny Cash (exact)",
  ],
  [
    "version asked, named, original marked mix",
    "Strobe Original Mix deadmau5",
    [track("Strobe - Original Mix", "deadmau5"), track("Strobe - Radio Edit", "deadmau5")],
    "ask",
  ],
];

// Modelled top tens for hits searched by title alone: each is a choice, whatever it holds.
const titleOnlyHits: [string, SpotifyData[]][] = [
  [
    "Blinding Lights",
    [
      track("Blinding Lights", "The Weeknd"),
      track("Save Your Tears", "The Weeknd"),
      track("Starboy", "The Weeknd", "Daft Punk"),
      track("Blinding Lights (with ROSALÍA) - Remix", "The Weeknd", "ROSALÍA"),
      track("The Hills", "The Weeknd"),
      track("Die For You", "The Weeknd"),
      track("In Your Eyes", "The Weeknd"),
      track("Blinding Lights - Sped Up", "Tazzy"),
      track("After Hours", "The Weeknd"),
      track("Earned It", "The Weeknd"),
    ],
  ],
  [
    "bad guy",
    [
      track("bad guy", "Billie Eilish"),
      track("bad guy (with Justin Bieber)", "Billie Eilish", "Justin Bieber"),
      track("ocean eyes", "Billie Eilish"),
      track("lovely (with Khalid)", "Billie Eilish", "Khalid"),
      track("Bad Guy", "Eminem"),
      track("Happier Than Ever", "Billie Eilish"),
      track("when the party's over", "Billie Eilish"),
      track("BIRDS OF A FEATHER", "Billie Eilish"),
      track("Bad Habits", "Ed Sheeran"),
      track("Bad Guy", "Necry Talkie"),
    ],
  ],
  [
    "Hurt",
    [
      track("Hurt", "Johnny Cash"),
      track("Hurt", "Nine Inch Nails"),
      track("Hurt", "Christina Aguilera"),
      track("Hurts", "Emeli Sandé"),
      track("Personal Jesus", "Johnny Cash"),
      track("Hurt", "Oliver Tree"),
      track("Hurt Me", "Låpsley"),
      track("Hurt - Live", "Johnny Cash"),
      track("Hurt", "NewJeans"),
      track("Folsom Prison Blues", "Johnny Cash"),
    ],
  ],
  [
    "Smells Like Teen Spirit",
    [
      track("Smells Like Teen Spirit", "Nirvana"),
      track("Come As You Are", "Nirvana"),
      track("Heart-Shaped Box", "Nirvana"),
      track("Smells Like Teen Spirit", "Malia J"),
      track("Lithium", "Nirvana"),
      track("Smells Like Teen Spirit - Live", "Nirvana"),
      track("Something In The Way", "Nirvana"),
      track("In Bloom", "Nirvana"),
      track("Smells Like Teen Spirit", "Tori Amos"),
      track("Polly", "Nirvana"),
    ],
  ],
  [
    "Wonderwall",
    [
      track("Wonderwall - Remastered", "Oasis"),
      track("Don't Look Back In Anger - Remastered", "Oasis"),
      track("Champagne Supernova - Remastered", "Oasis"),
      track("Wonderwall", "Ryan Adams"),
      track("Live Forever - Remastered", "Oasis"),
      track("Stop Crying Your Heart Out", "Oasis"),
      track("Wonderwall (Live at Knebworth, 10 August '96)", "Oasis"),
      track("Stand By Me - Remastered", "Oasis"),
      track("Half The World Away", "Oasis"),
      track("Supersonic - Remastered", "Oasis"),
    ],
  ],
  [
    "Bohemian Rhapsody",
    [
      track("Bohemian Rhapsody - Remastered 2011", "Queen"),
      track("Don't Stop Me Now - Remastered 2011", "Queen"),
      track("Another One Bites The Dust - Remastered 2011", "Queen"),
      track("Bohemian Rhapsody - Live Aid", "Queen"),
      track("Under Pressure - Remastered 2011", "Queen", "David Bowie"),
      track("We Will Rock You - Remastered 2011", "Queen"),
      track("Bohemian Rhapsody", "Panic! At The Disco"),
      track("Killer Queen - Remastered 2011", "Queen"),
      track("Somebody To Love - Remastered 2011", "Queen"),
      track("Radio Ga Ga - Remastered 2011", "Queen"),
    ],
  ],
  [
    "Hey Jude",
    [
      track("Hey Jude - Remastered 2015", "The Beatles"),
      track("Let It Be - Remastered 2009", "The Beatles"),
      track("Here Comes The Sun - Remastered 2009", "The Beatles"),
      track("Yesterday - Remastered 2009", "The Beatles"),
      track("Hey Jude - Remastered 2009", "The Beatles"),
      track("Come Together - Remastered 2009", "The Beatles"),
      track("Hey Jude", "Wilson Pickett"),
      track("Something - Remastered 2009", "The Beatles"),
      track("Twist And Shout - Remastered 2009", "The Beatles"),
      track("Help! - Remastered 2009", "The Beatles"),
    ],
  ],
  [
    "Imagine",
    [
      track("Imagine - Remastered 2010", "John Lennon"),
      track("imagine", "Ariana Grande"),
      track("Imagine", "Carrie Underwood"),
      track("Imagine Dragons Mix", "Various"),
      track("Jealous Guy - Remastered 2010", "John Lennon"),
      track("Imagine", "A Perfect Circle"),
      track("Woman - Remastered 2010", "John Lennon"),
      track("Imagine", "Ben Platt"),
      track("Stand By Me - Remastered 2010", "John Lennon"),
      track("Imagination", "Shawn Mendes"),
    ],
  ],
  [
    "Jolene",
    [
      track("Jolene", "Dolly Parton"),
      track("JOLENE", "Beyoncé"),
      track("Jolene", "The White Stripes"),
      track("9 to 5", "Dolly Parton"),
      track("Jolene - Live", "Dolly Parton"),
      track("Jolene", "Miley Cyrus"),
      track("I Will Always Love You", "Dolly Parton"),
      track("Coat of Many Colors", "Dolly Parton"),
      track("Jolene", "Ray LaMontagne"),
      track("Islands in the Stream", "Kenny Rogers", "Dolly Parton"),
    ],
  ],
  [
    "Shape of You",
    [
      track("Shape of You", "Ed Sheeran"),
      track("Perfect", "Ed Sheeran"),
      track("Photograph", "Ed Sheeran"),
      track("Thinking out Loud", "Ed Sheeran"),
      track("Shape of You (feat. Stormzy) - Remix", "Ed Sheeran", "Stormzy"),
      track("Bad Habits", "Ed Sheeran"),
      track("Shivers", "Ed Sheeran"),
      track("Castle on the Hill", "Ed Sheeran"),
      track("Galway Girl", "Ed Sheeran"),
      track("Shape of You - Acoustic", "Ed Sheeran"),
    ],
  ],
  [
    "Levitating",
    [
      track("Levitating", "Dua Lipa"),
      track("Levitating (feat. DaBaby)", "Dua Lipa", "DaBaby"),
      track("Don't Start Now", "Dua Lipa"),
      track("Physical", "Dua Lipa"),
      track("New Rules", "Dua Lipa"),
      track("Houdini", "Dua Lipa"),
      track(
        "Levitating - The Blessed Madonna Remix",
        "Dua Lipa",
        "The Blessed Madonna",
        "Madonna",
        "Missy Elliott",
      ),
      track("Break My Heart", "Dua Lipa"),
      track("One Kiss", "Calvin Harris", "Dua Lipa"),
      track("Levitate", "Twenty One Pilots"),
    ],
  ],
  [
    "Anti-Hero",
    [
      track("Anti-Hero", "Taylor Swift"),
      track("Cruel Summer", "Taylor Swift"),
      track("Lavender Haze", "Taylor Swift"),
      track("Karma", "Taylor Swift"),
      track("Anti-Hero (feat. Bleachers)", "Taylor Swift", "Bleachers"),
      track("Midnight Rain", "Taylor Swift"),
      track("Anti-Hero", "Lil Peep"),
      track("Bejeweled", "Taylor Swift"),
      track("Maroon", "Taylor Swift"),
      track("Snow On The Beach", "Taylor Swift", "Lana Del Rey"),
    ],
  ],
  [
    "As It Was",
    [
      track("As It Was", "Harry Styles"),
      track("Watermelon Sugar", "Harry Styles"),
      track("Late Night Talking", "Harry Styles"),
      track("Satellite", "Harry Styles"),
      track("Adore You", "Harry Styles"),
      track("Sign of the Times", "Harry Styles"),
      track("As It Was - Sped Up", "Harry Styles"),
      track("As It Was", "Cimorelli"),
      track("Matilda", "Harry Styles"),
      track("Music For a Sushi Restaurant", "Harry Styles"),
    ],
  ],
  [
    "Heat Waves",
    [
      track("Heat Waves", "Glass Animals"),
      track("Heat Waves - Sped Up", "Glass Animals"),
      track("Gooey", "Glass Animals"),
      track("Heat Waves (with iann dior)", "Glass Animals", "iann dior"),
      track("Tokyo Drifting", "Glass Animals", "Denzel Curry"),
      track("Your Love (Déjà Vu)", "Glass Animals"),
      track("Heatwave", "Martha Reeves & The Vandellas"),
      track("Heat Waves - Slowed", "Glass Animals"),
      track("Space Ghost Coast To Coast", "Glass Animals"),
      track("Heat Wave", "Snail Mail"),
    ],
  ],
  [
    "Creep",
    [
      track("Creep", "Radiohead"),
      track("Creep", "TLC"),
      track("Karma Police", "Radiohead"),
      track("No Surprises", "Radiohead"),
      track("Creep - Acoustic", "Radiohead"),
      track("Creep", "Scala & Kolacny Brothers"),
      track("Creepin' (with The Weeknd & 21 Savage)", "Metro Boomin", "The Weeknd", "21 Savage"),
      track("High and Dry", "Radiohead"),
      track("Creep", "Postmodern Jukebox", "Haley Reinhart"),
      track("Fake Plastic Trees", "Radiohead"),
    ],
  ],
  [
    "Hello",
    [
      track("Hello", "Adele"),
      track("Hello", "Lionel Richie"),
      track("Hello", "Evanescence"),
      track("Someone Like You", "Adele"),
      track("Hello", "OMFG"),
      track("Hello (feat. A Boogie Wit da Hoodie)", "Pop Smoke", "A Boogie Wit da Hoodie"),
      track("Easy On Me", "Adele"),
      track("Hello Kitty", "Avril Lavigne"),
      track("Hello Goodbye - Remastered 2009", "The Beatles"),
      track("Hellohello", "Kristian Kostov"),
    ],
  ],
  [
    "Believer",
    [
      track("Believer", "Imagine Dragons"),
      track("Thunder", "Imagine Dragons"),
      track("Demons", "Imagine Dragons"),
      track("Radioactive", "Imagine Dragons"),
      track("Believer", "Lil Wayne"),
      track("Bones", "Imagine Dragons"),
      track("Enemy", "Imagine Dragons", "JID"),
      track("Believe", "Cher"),
      track("Natural", "Imagine Dragons"),
      track("Believer - Kaskade Remix", "Imagine Dragons", "Kaskade"),
    ],
  ],
  [
    "Toxic",
    [
      track("Toxic", "Britney Spears"),
      track("Womanizer", "Britney Spears"),
      track("Toxic", "BoyWithUke"),
      track("Gimme More", "Britney Spears"),
      track("...Baby One More Time", "Britney Spears"),
      track("Toxic - Y2K & Alexander Lewis Remix", "Britney Spears", "Y2K", "Alexander Lewis"),
      track("Toxic", "Melanie Martinez"),
      track("Circus", "Britney Spears"),
      track("Toxicity", "System Of A Down"),
      track("Oops!...I Did It Again", "Britney Spears"),
    ],
  ],
  [
    "Thriller",
    [
      track("Thriller", "Michael Jackson"),
      track("Billie Jean", "Michael Jackson"),
      track("Beat It", "Michael Jackson"),
      track("Smooth Criminal - 2012 Remaster", "Michael Jackson"),
      track("Thriller - Single Version", "Michael Jackson"),
      track("Bad - 2012 Remaster", "Michael Jackson"),
      track("Thriller", "Fall Out Boy"),
      track("Human Nature", "Michael Jackson"),
      track("P.Y.T. (Pretty Young Thing)", "Michael Jackson"),
      track("Rock with You - Single Version", "Michael Jackson"),
    ],
  ],
  [
    "Flowers",
    [
      track("Flowers", "Miley Cyrus"),
      track("Flowers", "Lauren Spencer Smith"),
      track("Wrecking Ball", "Miley Cyrus"),
      track("Flowers - Demo", "Miley Cyrus"),
      track("Party In The U.S.A.", "Miley Cyrus"),
      track("Flowers", "Sweet Female Attitude"),
      track("Used To Be Young", "Miley Cyrus"),
      track("Flowers (in the rain)", "The Move"),
      track("Malibu", "Miley Cyrus"),
      track("Flowers", "Jhené Aiko"),
    ],
  ],
  [
    "Dancing Queen",
    [
      track("Dancing Queen", "ABBA"),
      track("Mamma Mia", "ABBA"),
      track("Gimme! Gimme! Gimme! (A Man After Midnight)", "ABBA"),
      track("The Winner Takes It All", "ABBA"),
      track("Dancing Queen", "Cher"),
      track("Waterloo", "ABBA"),
      track("Dancing Queen", "Lily James", "Amanda Seyfried"),
      track("Lay All Your Love On Me", "ABBA"),
      track("Chiquitita", "ABBA"),
      track("Super Trouper", "ABBA"),
    ],
  ],
  [
    "Sweet Caroline",
    [
      track("Sweet Caroline", "Neil Diamond"),
      track("Cracklin' Rosie", "Neil Diamond"),
      track("Song Sung Blue", "Neil Diamond"),
      track("Sweet Caroline - Single Version", "Neil Diamond"),
      track("I'm A Believer", "Neil Diamond"),
      track("America", "Neil Diamond"),
      track("Forever in Blue Jeans", "Neil Diamond"),
      track("Sweet Caroline", "Mylan"),
      track("Red Red Wine", "Neil Diamond"),
      track("Solitary Man", "Neil Diamond"),
    ],
  ],
];

/** A result with the fields that tell takes apart: album, ISRC and duration. */
function take(title: string, artists: string[], extra: Partial<SpotifyData>): SpotifyData {
  return { ...track(title, ...artists), ...extra };
}

// Takes of one song that the title alone does not tell apart, and titles that differ only by a
// joining word or a mix label.
const takes: Case[] = [
  [
    "a re-recording with another ISRC listed before the original",
    "I Walk the Line Johnny Cash",
    [
      take("I Walk The Line", ["Johnny Cash"], { isrc: "USSM16400001", durationMs: 165_000 }),
      take("I Walk the Line", ["Johnny Cash"], { isrc: "USA2P0500001", durationMs: 166_000 }),
    ],
    "ask",
  ],
  [
    "a take of the same length and ISRC listed twice is one take",
    "I Walk the Line Johnny Cash",
    [
      take("I Walk The Line", ["Johnny Cash"], { isrc: "USA2P0500001", durationMs: 165_000 }),
      take("I Walk the Line", ["Johnny Cash"], { isrc: "USA2P0500001", durationMs: 166_000 }),
    ],
    "auto I Walk The Line/Johnny Cash (exact)",
  ],
  [
    "a track on a live album is a live take",
    "Hotel California Eagles",
    [
      take("Hotel California", ["Eagles"], { album: "Eagles Live" }),
      track("Hotel California - 2013 Remaster", "Eagles"),
    ],
    "auto Hotel California - 2013 Remaster/Eagles (exact)",
  ],
  [
    "an early take is the only one",
    "Yesterday The Beatles",
    [
      track("Yesterday - Take 1", "The Beatles"),
      track("Let It Be - Remastered 2009", "The Beatles"),
    ],
    "ask",
  ],
  [
    "a live take marked in Spanish is the only one",
    "Rayando el Sol Mana",
    [track("Rayando el Sol - En Vivo", "Maná"), track("Oye Mi Amor", "Maná")],
    "ask",
  ],
  [
    "a live take marked in Portuguese is listed before the studio take",
    "Evidencias Chitaozinho & Xororo",
    [
      track("Evidências - Ao Vivo", "Chitãozinho & Xororó"),
      track("Evidências", "Chitãozinho & Xororó"),
    ],
    "auto Evidências/Chitãozinho & Xororó (exact)",
  ],
  [
    "a club mix is another version",
    "Pump Up the Jam Technotronic",
    [track("Pump Up the Jam - Club Mix", "Technotronic"), track("Pump Up the Jam", "Technotronic")],
    "auto Pump Up the Jam/Technotronic (exact)",
  ],
  [
    "an extended mix alone is another version",
    "Blue Monday New Order",
    [track("Blue Monday - Extended Mix", "New Order"), track("Blue Monday '88", "New Order")],
    "ask",
  ],
  [
    "a featured artist's credit need not be in the query",
    "Crazy in Love Beyonce",
    [track("Crazy In Love (feat. Jay-Z)", "Beyoncé", "JAY-Z")],
    "auto Crazy In Love (feat. Jay-Z)/Beyoncé,JAY-Z (exact)",
  ],
  [
    "a source named in the title need not be in the query",
    "Let It Go Idina Menzel",
    [track('Let It Go - From "Frozen"/Soundtrack Version', "Idina Menzel")],
    'auto Let It Go - From "Frozen"/Soundtrack Version/Idina Menzel (exact)',
  ],
  [
    "With You is not You",
    "With You Chris Brown",
    [track("You", "Chris Brown"), track("With You", "Chris Brown")],
    "auto With You/Chris Brown (exact)",
  ],
  [
    "X&Y is not Y",
    "X&Y Coldplay",
    [track("Y", "Coldplay"), track("X&Y", "Coldplay")],
    "auto X&Y/Coldplay (exact)",
  ],
  [
    "a karaoke track credited to the named artist is not a rival",
    "Hurt Johnny Cash",
    [track("Hurt", "Johnny Cash"), track("Hurt (Karaoke Version)", "Karaoke Hits", "Johnny Cash")],
    "auto Hurt/Johnny Cash (exact)",
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
  it.each(third)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(thirdKept)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(takes)("%s", (_label, query, tracks, expected) => {
    expect(decide(query, tracks)).toBe(expected);
  });
  it.each(titleOnlyHits)("asks for %j, a title alone", (query, tracks) => {
    expect(decide(query, tracks)).toBe("ask");
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

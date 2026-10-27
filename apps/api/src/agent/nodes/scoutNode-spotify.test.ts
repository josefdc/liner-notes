/**
 * Scout over the real Spotify client with a stubbed Web API: results are judged on how their
 * title and artists match the query, since Spotify gives this app no popularity. Popularity may
 * be null or missing without dropping a result; an exact title ranks first and the original
 * recording before live takes, remixes and karaoke; one clear match for a title and artist is
 * selected without asking; a title alone, or a query nothing matches, is always a choice; the
 * ISRC reaches the state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, stubFetch } from "../../sources/testing/fetchStub.js";

vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
});

import { Command, END, InMemoryStore, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { SpotifyAuthManager } from "../../sources/spotify.js";
import { SonicAgentState } from "../state.js";
import { clarificationNode } from "./clarificationNode.js";
import { scoutNode } from "./scoutNode.js";

const SEARCH = "https://api.spotify.com/v1/search?";

let next = 0;
/** A track as Spotify's search returns it; `popularity` is left out unless given. */
function spotifyTrack(name: string, artists: string[], extra: Record<string, unknown> = {}) {
  next++;
  const id = `trk${String(next).padStart(19, "0")}`;
  return {
    id,
    name,
    artists: artists.map((artist, i) => ({
      id: `art${String(next * 10 + i).padStart(19, "0")}`,
      name: artist,
    })),
    album: {
      name: `${name} (album)`,
      release_date: "1994-03-08",
      images: [{ url: "https://i.scdn.co/image/x" }],
    },
    duration_ms: 218_000,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    ...extra,
  };
}

/** Spotify answering every search with `items`; returns the recorded requests. */
function spotifySearch(items: unknown[]) {
  return stubFetch((call: FetchCall) => {
    if (call.url === "https://accounts.spotify.com/api/token") {
      return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (call.url.startsWith(SEARCH)) return json({ tracks: { items, total: items.length } });
    return undefined;
  });
}

function scout(songQuery: string, store = new InMemoryStore()) {
  const graph = new StateGraph(SonicAgentState)
    .addNode("scout", scoutNode)
    .addEdge(START, "scout")
    .addEdge("scout", END)
    .compile({ store });
  return graph.invoke({ songQuery });
}

const ids = (rows: { id: string }[] | null | undefined) => (rows ?? []).map((row) => row.id);

beforeEach(() => {
  SpotifyAuthManager.getInstance().clearToken();
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scoutNode with Spotify results that carry no popularity", () => {
  it.each([
    ["null", { popularity: null }],
    ["missing", {}],
  ])(
    "keeps every result when popularity is %s and ranks exact titles first",
    async (_label, popularity) => {
      // Spotify lists "Angelito" first; two songs titled "Angel" by different artists follow.
      const angelito = spotifyTrack("Angelito", ["Don Omar"], popularity);
      const shaggy = spotifyTrack("Angel", ["Shaggy", "Rayvon"], popularity);
      const sarah = spotifyTrack("Angel", ["Sarah McLachlan"], popularity);
      spotifySearch([angelito, shaggy, sarah]);

      const out = await scout("Angel");

      expect(out.error ?? null).toBeNull();
      expect(ids(out.candidates)).toEqual([shaggy.id, sarah.id, angelito.id]);
      for (const candidate of out.candidates ?? [])
        expect(candidate).not.toHaveProperty("popularity");
      expect(out.queryMatch).toBe("exact");
    },
  );

  it("selects the song whose artist the query names", async () => {
    const angelito = spotifyTrack("Angelito", ["Don Omar"]);
    const sarah = spotifyTrack("Angel", ["Sarah McLachlan"]);
    const shaggy = spotifyTrack("Angel", ["Shaggy", "Rayvon"]);
    spotifySearch([angelito, sarah, shaggy]);

    const out = await scout("angel shaggy");

    expect(out.candidates ?? null).toBeNull();
    expect(out.spotifyData?.id).toBe(shaggy.id);
  });

  it("keeps the original artist of 'Hurt' among the candidates, ahead of other versions", async () => {
    const items = [
      spotifyTrack("Hurt", ["Johnny Cash"]),
      spotifyTrack("Hurt (Originally Performed by Johnny Cash) [Karaoke Version]", [
        "Ameritz Karaoke",
      ]),
      spotifyTrack("Hurt - Live", ["Johnny Cash"]),
      spotifyTrack("Hurts So Good", ["John Mellencamp"]),
      spotifyTrack("Hurt", ["Christina Aguilera"]),
      spotifyTrack("Hurt - Remix", ["DJ Somebody"]),
      spotifyTrack("Hurt Me", ["Somebody Else"]),
      spotifyTrack("Hurt", ["Nine Inch Nails"]),
    ];
    const net = spotifySearch(items);

    const out = await scout("Hurt");

    const offered = (out.candidates ?? []).map(
      (c: { title: string; artist: string }) => `${c.title} / ${c.artist}`,
    );
    expect(offered).toEqual([
      "Hurt / Johnny Cash",
      "Hurt / Christina Aguilera",
      "Hurt / Nine Inch Nails",
      "Hurt (Originally Performed by Johnny Cash) [Karaoke Version] / Ameritz Karaoke",
      "Hurt - Live / Johnny Cash",
    ]);
    // As many results as Spotify gives, so the original is not cut off before ranking.
    const search = net.calls.find((call) => call.url.startsWith(SEARCH));
    expect(new URL(search?.url ?? SEARCH).searchParams.get("limit")).toBe("10");
  });

  it("selects the original recording rather than a live take of the same song", async () => {
    const live = spotifyTrack("Bohemian Rhapsody - Live Aid", ["Queen"]);
    const original = spotifyTrack("Bohemian Rhapsody - Remastered 2011", ["Queen"]);
    const karaoke = spotifyTrack("Bohemian Rhapsody (Karaoke Version)", ["Karaoke Hits Band"]);
    spotifySearch([live, original, karaoke]);

    const out = await scout("bohemian rhapsody queen");

    expect(out.candidates ?? null).toBeNull();
    expect(out.spotifyData?.id).toBe(original.id);
  });

  const iceIceBaby = () => {
    const hit = spotifyTrack("Ice Ice Baby", ["Vanilla Ice"], {
      external_ids: { isrc: "USAT29900609" },
      preview_url: "https://p.scdn.co/mp3-preview/abc",
    });
    spotifySearch([
      hit,
      spotifyTrack("Ice Ice Baby (Karaoke Version)", ["Karaoke Hits Band"]),
      spotifyTrack("Baby", ["Justin Bieber", "Ludacris"]),
      spotifyTrack("Ice Cream", ["BLACKPINK", "Selena Gomez"]),
    ]);
    return hit;
  };

  it("asks for a title alone, even with one clear match, and lists that match first", async () => {
    const hit = iceIceBaby();

    const out = await scout("ice ice baby");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
    expect(ids(out.candidates)[0]).toBe(hit.id);
    expect(out.queryMatch).toBe("exact");
  });

  it("selects one clear match for the title and artist without asking and records its ISRC", async () => {
    const hit = iceIceBaby();

    const out = await scout("ice ice baby vanilla ice");

    expect(out.candidates ?? null).toBeNull();
    expect(out.spotifyData).toMatchObject({
      id: hit.id,
      isrc: "USAT29900609",
      previewUrl: "https://p.scdn.co/mp3-preview/abc",
    });
    expect(out.isrc).toBe("USAT29900609");
    expect(out.queryMatch).toBe("exact");
    // A clear match: its result may answer the next search of the same text.
    expect(out.selectedBy).toBe("match");
  });

  it("selects a non-Latin title that matches the query", async () => {
    const yoru = spotifyTrack("夜に駆ける", ["YOASOBI"]);
    spotifySearch([spotifyTrack("群青", ["YOASOBI"]), yoru, spotifyTrack("アイドル", ["YOASOBI"])]);

    const out = await scout("夜に駆ける YOASOBI");

    expect(out.candidates ?? null).toBeNull();
    expect(out.spotifyData?.id).toBe(yoru.id);
  });

  it("does not select a result on its own when nothing matches the query", async () => {
    const unrelated = spotifyTrack("xStep", ["DJVI"]);
    spotifySearch([unrelated]);

    const out = await scout("qwzx vlorp blenk");

    expect(out.spotifyData ?? null).toBeNull();
    expect(ids(out.candidates)).toEqual([unrelated.id]);
    expect(out.queryMatch).toBe("none");
  });
});

describe("scoutNode never selects another recording on its own", () => {
  it("offers YOASOBI's song instead of selecting a piano cover with the romanised title", async () => {
    const original = spotifyTrack("夜に駆ける", ["YOASOBI"], {
      external_ids: { isrc: "JPP302000245" },
    });
    spotifySearch([
      original,
      spotifyTrack("Yoru ni Kakeru (Piano Cover)", ["Animenz"], {
        external_ids: { isrc: "QZFZ32012345" },
      }),
      spotifyTrack("Yoru ni Kakeru - Piano Cover", ["Pianella Piano"]),
      spotifyTrack("群青", ["YOASOBI"]),
    ]);

    const out = await scout("Yoru ni Kakeru YOASOBI");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
    expect(ids(out.candidates)[0]).toBe(original.id);
  });

  it("offers Journey's song instead of selecting a karaoke track spelt like the query", async () => {
    const original = spotifyTrack("Don't Stop Believin'", ["Journey"]);
    spotifySearch([
      original,
      spotifyTrack("Don't Stop Believing (Karaoke Version)", ["Ameritz Karaoke"], {
        external_ids: { isrc: "GBTVB1100001" },
      }),
      spotifyTrack("Any Way You Want It", ["Journey"]),
    ]);

    const out = await scout("Dont Stop Believing Journey");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
    expect(ids(out.candidates)[0]).toBe(original.id);
  });

  it("asks for an artist-only query instead of selecting another artist's song named after them", async () => {
    spotifySearch([
      spotifyTrack("Umbrella", ["Rihanna", "JAY-Z"]),
      spotifyTrack("Diamonds", ["Rihanna"]),
      spotifyTrack("Rihanna", ["Yxng Bane"]),
    ]);

    const out = await scout("Rihanna");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.candidates).toHaveLength(3);
    // The title match is listed first, then the songs of the artist the query names.
    expect(out.candidates?.[0]).toMatchObject({ title: "Rihanna", artist: "Yxng Bane" });
  });

  it("selects PSY's song for the Korean title and the artist, as an exact match", async () => {
    const psy = spotifyTrack("Gangnam Style (강남스타일)", ["PSY"], {
      external_ids: { isrc: "KRA381200450" },
    });
    spotifySearch([psy]);

    const out = await scout("강남스타일 PSY");

    expect(out.spotifyData?.id).toBe(psy.id);
    expect(out.isrc).toBe("KRA381200450");
    expect(out.queryMatch).toBe("exact");
  });

  it("reads the web's query with every credited artist as an exact match", async () => {
    const hit = spotifyTrack("Gangsta's Paradise", ["Coolio", "L.V."], {
      external_ids: { isrc: "usto10500102" },
    });
    spotifySearch([hit, spotifyTrack("Gangsta's Paradise", ["Postmodern Jukebox"])]);

    const out = await scout("Gangsta's Paradise Coolio, L.V.");

    expect(out.spotifyData?.id).toBe(hit.id);
    expect(out.isrc).toBe("USTO10500102");
    expect(out.queryMatch).toBe("exact");
  });
});

describe("a pick from the track picker", () => {
  it("is not reused: after one user picks a karaoke track for Hurt, the next search asks", async () => {
    const cash = spotifyTrack("Hurt", ["Johnny Cash"], { external_ids: { isrc: "USUM70207211" } });
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"]);
    const karaoke = spotifyTrack("Hurt (Karaoke Version)", ["Ameritz Karaoke"]);
    stubFetch((call: FetchCall) => {
      if (call.url === "https://accounts.spotify.com/api/token") {
        return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
      }
      if (call.url.startsWith(SEARCH)) {
        return json({ tracks: { items: [cash, nin, karaoke], total: 3 } });
      }
      if (call.url === `https://api.spotify.com/v1/tracks/${karaoke.id}`) return json(karaoke);
      return undefined;
    });
    const store = new InMemoryStore();
    const graph = new StateGraph(SonicAgentState)
      .addNode("scout", scoutNode)
      .addNode("clarification", clarificationNode)
      .addEdge(START, "scout")
      .addConditionalEdges("scout", (state) => (state.candidates ? "clarification" : END))
      .addEdge("clarification", END)
      .compile({ store, checkpointer: new MemorySaver() });
    const thread = { configurable: { thread_id: "first-user" } };

    await graph.invoke({ songQuery: "Hurt" }, thread);
    const picked = await graph.invoke(new Command({ resume: karaoke.id }), thread);
    const next = await graph.invoke(
      { songQuery: "hurt" },
      { configurable: { thread_id: "next-user" } },
    );

    expect(picked.spotifyData?.id).toBe(karaoke.id);
    expect(picked.selectedBy).toBe("user");
    expect(next.spotifyData ?? null).toBeNull();
    expect(ids(next.candidates)[0]).toBe(cash.id);
  });
});

describe("scoutNode with a query spelt unlike the original, or that is only a title", () => {
  it("asks instead of selecting a cover spelt like the query when Spotify lists the original first", async () => {
    const original = spotifyTrack("Don't Stop Believin'", ["Journey"], {
      external_ids: { isrc: "USSM18100116" },
    });
    spotifySearch([
      original,
      spotifyTrack("Don't Stop Believin' - 2022 Remaster", ["Journey"]),
      spotifyTrack("Don't Stop Believin' (Glee Cast Version)", ["Glee Cast"]),
      spotifyTrack("Any Way You Want It", ["Journey"]),
      spotifyTrack("Don't Stop Believing", ["Petra Haden"], {
        external_ids: { isrc: "USA2B1900001" },
      }),
    ]);

    const out = await scout("Dont Stop Believing");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
    expect(ids(out.candidates)).toContain(original.id);
  });

  it("asks instead of selecting a cover spelt like the query that Spotify lists first", async () => {
    const original = spotifyTrack("Sweet Child O' Mine", ["Guns N' Roses"], {
      external_ids: { isrc: "USGF18714801" },
    });
    spotifySearch([
      spotifyTrack("Sweet Child of Mine", ["Sheryl Crow"], {
        external_ids: { isrc: "USIR19900001" },
      }),
      original,
      spotifyTrack("November Rain", ["Guns N' Roses"]),
    ]);

    const out = await scout("Sweet Child of Mine");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
    expect(ids(out.candidates)).toContain(original.id);
  });

  it("asks instead of selecting a cover with the romanised title of a Japanese original", async () => {
    const original = spotifyTrack("夜に駆ける", ["YOASOBI"], {
      external_ids: { isrc: "JPP302000245" },
    });
    spotifySearch([
      original,
      spotifyTrack("Into The Night", ["YOASOBI"]),
      spotifyTrack("Yoru ni Kakeru", ["Rainych"], { external_ids: { isrc: "QZES52000002" } }),
    ]);

    const out = await scout("Yoru ni Kakeru");

    expect(out.spotifyData ?? null).toBeNull();
    expect(ids(out.candidates)).toContain(original.id);
  });

  it("asks when the query is a title that is also an artist's name", async () => {
    const frank = spotifyTrack("Bad Religion", ["Frank Ocean"]);
    const band = spotifyTrack("Bad Religion", ["Bad Religion"], {
      external_ids: { isrc: "USEP48100001" },
    });
    spotifySearch([frank, spotifyTrack("Punk Rock Song", ["Bad Religion"]), band]);

    const out = await scout("Bad Religion");

    expect(out.spotifyData ?? null).toBeNull();
    expect(ids(out.candidates).slice(0, 2)).toEqual([frank.id, band.id]);
  });

  it("selects the original recording over a re-recording Spotify lists first", async () => {
    const original = spotifyTrack("Love Story", ["Taylor Swift"], {
      external_ids: { isrc: "USCJY0803275" },
    });
    spotifySearch([
      spotifyTrack("Love Story (Taylor's Version)", ["Taylor Swift"], {
        external_ids: { isrc: "USUG12100342" },
      }),
      original,
      spotifyTrack("Love Story", ["Indila"]),
    ]);

    const out = await scout("Love Story Taylor Swift");

    expect(out.spotifyData?.id).toBe(original.id);
    expect(out.isrc).toBe("USCJY0803275");
  });
});

describe("scoutNode with a named artist and several recordings of the song", () => {
  const isrc = (code: string) => ({ external_ids: { isrc: code } });

  it("does not select a live take because the title holds the word live", async () => {
    spotifySearch([
      spotifyTrack("Live And Let Die - Live", ["Paul McCartney"], isrc("GBCCS0900002")),
      spotifyTrack(
        "Live And Let Die - 2018 Remaster",
        ["Paul McCartney", "Wings"],
        isrc("GBCCS1800001"),
      ),
      spotifyTrack("Live and Let Die", ["Guns N' Roses"]),
    ]);

    const out = await scout("Live and Let Die Paul McCartney");

    expect(out.spotifyData?.title).toBe("Live And Let Die - 2018 Remaster");
    expect(out.isrc).toBe("GBCCS1800001");
  });

  it("asks when the studio take is credited to Wings and a live take to Paul McCartney", async () => {
    spotifySearch([
      spotifyTrack("Live And Let Die - 2018 Remaster", ["Wings"], isrc("GBCCS1800001")),
      spotifyTrack("Live And Let Die - Live", ["Paul McCartney"], isrc("GBCCS0900002")),
      spotifyTrack("Live and Let Die", ["Guns N' Roses"]),
    ]);

    const out = await scout("Live and Let Die Paul McCartney");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
  });

  it("asks instead of selecting a remix that only features the named artist", async () => {
    const original = spotifyTrack("Tom's Diner", ["Suzanne Vega"], isrc("USAM18700001"));
    spotifySearch([
      spotifyTrack("Tom's Diner", ["DNA", "Suzanne Vega"], isrc("GBAAA9000123")),
      original,
      spotifyTrack("Luka", ["Suzanne Vega"]),
    ]);

    const out = await scout("Tom's Diner Suzanne Vega");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
    expect(ids(out.candidates)).toContain(original.id);
  });

  it("asks when the artist has a take with a label that is not a known one ((2012))", async () => {
    spotifySearch([
      spotifyTrack("Pour Some Sugar On Me (2012)", ["Def Leppard"], isrc("GBUM71200001")),
      spotifyTrack("Pour Some Sugar On Me", ["Def Leppard"], isrc("GBF088700001")),
    ]);

    const out = await scout("Pour Some Sugar on Me Def Leppard");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
  });

  it("asks for YMCA, a title alone, even with a cover spelt like the query listed first", async () => {
    const original = spotifyTrack("Y.M.C.A.", ["Village People"], isrc("FRX207800001"));
    spotifySearch([
      spotifyTrack("YMCA", ["The Party Hits Band"], isrc("QZAAA2300001")),
      original,
      spotifyTrack("In the Navy", ["Village People"]),
    ]);

    const out = await scout("YMCA");

    expect(out.spotifyData ?? null).toBeNull();
    expect(ids(out.candidates)).toContain(original.id);
  });
});

describe("the first candidate, which the picker's countdown takes", () => {
  const first = async (query: string, items: unknown[]) => {
    spotifySearch(items);
    const out = await scout(query);
    expect(out.spotifyData ?? null).toBeNull();
    const [top] = out.candidates ?? [];
    return top ? `${top.title} / ${top.artist}` : null;
  };

  it("is the original spelt otherwise, not a cover spelt like the query", async () => {
    expect(
      await first("Dont Stop Believing", [
        spotifyTrack("Don't Stop Believin'", ["Journey"]),
        spotifyTrack("Don't Stop Believing", ["Petra Haden"]),
        spotifyTrack("Any Way You Want It", ["Journey"]),
      ]),
    ).toBe("Don't Stop Believin' / Journey");
  });

  it("is the original among a top ten of covers, karaoke and a Glee version", async () => {
    expect(
      await first("Dont Stop Believing", [
        spotifyTrack("Don't Stop Believin'", ["Journey"]),
        spotifyTrack("Don't Stop Believin' - 2022 Remaster", ["Journey"]),
        spotifyTrack("Don't Stop Believin' (Glee Cast Version)", ["Glee Cast"]),
        spotifyTrack("Don't Stop Believing", ["Petra Haden"]),
        spotifyTrack("Don't Stop Believing (Karaoke Version)", ["Ameritz Karaoke"]),
        spotifyTrack("Don't Stop Believing", ["Kidz Bop Kids"]),
        spotifyTrack("Don't Stop Believing - Piano Version", ["Piano Dreamers"]),
        spotifyTrack("Don't Stop Believing", ["The Hit Crew"]),
        spotifyTrack("Don't Stop Believin' - Live", ["Journey"]),
        spotifyTrack("Don't Stop Believing (In the Style of Journey) [Karaoke Version]", [
          "Sing Karaoke",
        ]),
      ]),
    ).toBe("Don't Stop Believin' / Journey");
  });

  it("is the Japanese original for a romanised title, not a romanised cover", async () => {
    expect(
      await first("Yoru ni Kakeru", [
        spotifyTrack("夜に駆ける", ["YOASOBI"]),
        spotifyTrack("Yoru ni Kakeru", ["Rainych"]),
        spotifyTrack("Yoru ni Kakeru (Piano Cover)", ["Animenz"]),
        spotifyTrack("Yoru ni Kakeru", ["Lefty Hand Cream"]),
        spotifyTrack("Yoru ni Kakeru - Acoustic", ["Some Singer"]),
        spotifyTrack("Yoru ni Kakeru", ["Covers Inc"]),
        spotifyTrack("群青", ["YOASOBI"]),
      ]),
    ).toBe("夜に駆ける / YOASOBI");
    expect(
      await first("Gurenge", [
        spotifyTrack("紅蓮華", ["LiSA"]),
        spotifyTrack("Gurenge", ["Raon"]),
        spotifyTrack("Gurenge", ["Akano"]),
        spotifyTrack("Gurenge (Demon Slayer)", ["Anime Covers"]),
        spotifyTrack("Gurenge - Piano", ["Animenz"]),
        spotifyTrack("Gurenge", ["Amalee"]),
      ]),
    ).toBe("紅蓮華 / LiSA");
  });

  it("is the named artist's song spelt otherwise, not one of several covers", async () => {
    expect(
      await first("Dont Stop Believing Journey", [
        spotifyTrack("Don't Stop Believin'", ["Journey"]),
        spotifyTrack("Don't Stop Believin' - 2022 Remaster", ["Journey"]),
        spotifyTrack("Don't Stop Believing", ["Petra Haden"]),
        spotifyTrack("Don't Stop Believing", ["Kidz Bop Kids"]),
        spotifyTrack("Don't Stop Believing", ["The Hit Crew"]),
        spotifyTrack("Don't Stop Believing", ["Boyce Avenue"]),
        spotifyTrack("Don't Stop Believing", ["Vitamin String Quartet"]),
        spotifyTrack("Any Way You Want It", ["Journey"]),
      ]),
    ).toBe("Don't Stop Believin' / Journey");
    expect(
      await first("Yoru ni Kakeru YOASOBI", [
        spotifyTrack("夜に駆ける", ["YOASOBI"]),
        spotifyTrack("Yoru ni Kakeru", ["Rainych"]),
        spotifyTrack("Yoru ni Kakeru", ["Lefty Hand Cream"]),
        spotifyTrack("Yoru ni Kakeru", ["Covers Inc"]),
        spotifyTrack("Yoru ni Kakeru", ["Amalee"]),
        spotifyTrack("Yoru ni Kakeru", ["Raon"]),
        spotifyTrack("群青", ["YOASOBI"]),
      ]),
    ).toBe("夜に駆ける / YOASOBI");
  });

  it("is the named artist's song spelt otherwise, even when Spotify lists covers first", async () => {
    expect(
      await first("Dont Stop Believing Journey", [
        spotifyTrack("Don't Stop Believing", ["Petra Haden"]),
        spotifyTrack("Don't Stop Believing", ["Kidz Bop Kids"]),
        spotifyTrack("Don't Stop Believin'", ["Journey"]),
      ]),
    ).toBe("Don't Stop Believin' / Journey");
  });

  it("keeps Spotify's first for three songs called Hurt", async () => {
    expect(
      await first("Hurt", [
        spotifyTrack("Hurt", ["Nine Inch Nails"]),
        spotifyTrack("Hurt", ["Johnny Cash"]),
        spotifyTrack("Hurt", ["Christina Aguilera"]),
      ]),
    ).toBe("Hurt / Nine Inch Nails");
  });
});

describe("scoutNode with takes of one song that Spotify titles alike", () => {
  it("selects the album take of Come As You Are, not the MTV Unplugged take listed first", async () => {
    spotifySearch([
      spotifyTrack("Come As You Are", ["Nirvana"], {
        album: { name: "MTV Unplugged In New York", release_date: "1994-11-01", images: [] },
        duration_ms: 253_000,
        external_ids: { isrc: "USGF19463206" },
      }),
      spotifyTrack("Come As You Are", ["Nirvana"], {
        album: { name: "Nevermind", release_date: "1991-09-24", images: [] },
        duration_ms: 219_000,
        external_ids: { isrc: "USGF19942503" },
      }),
      spotifyTrack("Lithium", ["Nirvana"]),
    ]);

    const out = await scout("Come As You Are Nirvana");

    // The Unplugged take is a live recording (its album says so): the album take is selected.
    expect(out.spotifyData?.album).toBe("Nevermind");
    expect(out.isrc).toBe("USGF19942503");
  });

  it("asks when two takes with the same title differ in length", async () => {
    spotifySearch([
      spotifyTrack("Come As You Are", ["Nirvana"], { duration_ms: 253_000 }),
      spotifyTrack("Come As You Are", ["Nirvana"], { duration_ms: 219_000 }),
    ]);

    const out = await scout("Come As You Are Nirvana");

    expect(out.spotifyData ?? null).toBeNull();
  });

  it("asks when the only take carries words the query does not hold", async () => {
    spotifySearch([
      spotifyTrack("Rayando el Sol - En Vivo", ["Maná"], {
        external_ids: { isrc: "USWB19900001" },
      }),
      spotifyTrack("Oye Mi Amor", ["Maná"]),
      spotifyTrack("Rayando el Sol", ["Some Cover Band"]),
    ]);

    const out = await scout("Rayando el Sol Maná");

    expect(out.spotifyData ?? null).toBeNull();
    expect(out.isrc ?? null).toBeNull();
  });
});

describe("the picker's candidates: ISRC, release date, and one row per recording", () => {
  const released = (date: string, isrc?: string) => ({
    album: {
      name: `Album of ${date}`,
      release_date: date,
      images: [{ url: "https://i.scdn.co/image/x" }],
    },
    ...(isrc ? { external_ids: { isrc } } : {}),
  });

  /** The scout's run on `query`: its state and the question it sent with the candidates. */
  async function scoutStream(query: string) {
    const graph = new StateGraph(SonicAgentState)
      .addNode("scout", scoutNode)
      .addEdge(START, "scout")
      .addEdge("scout", END)
      .compile({ store: new InMemoryStore() });
    const sent: { candidates: unknown[]; message: string }[] = [];
    let state: Record<string, unknown> = {};
    const stream = await graph.stream({ songQuery: query }, { streamMode: ["custom", "values"] });
    for await (const [mode, data] of stream as AsyncIterable<[string, Record<string, unknown>]>) {
      if (mode === "values") state = data;
      else if (data.type === "candidates") {
        sent.push(data as unknown as { candidates: unknown[]; message: string });
      }
    }
    return { state: state as { candidates?: Array<Record<string, unknown>> }, sent };
  }

  it("carries each track's ISRC and full release date as Spotify gave them", async () => {
    const cash = spotifyTrack("Hurt", ["Johnny Cash"], released("2002-11-05", "usum70207211"));
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"], released("1994-03"));
    spotifySearch([cash, nin]);

    const out = await scout("Hurt");

    expect(out.candidates).toEqual([
      expect.objectContaining({
        id: cash.id,
        isrc: "USUM70207211",
        releaseDate: "2002-11-05",
        releaseYear: "2002",
      }),
      expect.objectContaining({
        id: nin.id,
        isrc: null,
        releaseDate: "1994-03",
        releaseYear: "1994",
      }),
    ]);
  });

  it("sends the rows of one recording as one, the earliest release, and counts what it sends", async () => {
    // Spotify lists Cash's "Hurt" from a compilation first, then from its album: one ISRC.
    const compilation = spotifyTrack(
      "Hurt",
      ["Johnny Cash"],
      released("2008-05-01", "USUM70207211"),
    );
    const album = spotifyTrack("Hurt", ["Johnny Cash"], released("2002-11-05", "USUM70207211"));
    // A live take is another recording: another ISRC.
    const live = spotifyTrack("Hurt", ["Johnny Cash"], released("2003", "USUM70300001"));
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"], released("1994-03-08", "USIR19400001"));
    spotifySearch([compilation, album, live, nin]);

    const { state, sent } = await scoutStream("Hurt");

    const offered = (state.candidates ?? []).map((candidate) => candidate.id);
    expect(offered).toHaveLength(3);
    expect(offered).toContain(album.id);
    expect(offered).not.toContain(compilation.id);
    expect(offered).toEqual(expect.arrayContaining([live.id, nin.id]));
    // The album's row takes the compilation's place, the first of the two listed.
    expect(offered.indexOf(album.id)).toBeLessThan(offered.indexOf(live.id));
    expect(sent).toHaveLength(1);
    expect(sent[0].candidates).toHaveLength(3);
    expect(sent[0].message).toBe("3 possible tracks from Spotify; choose one");
  });

  it("keeps the first listed of one recording when a release date is unknown", async () => {
    const first = spotifyTrack("Hurt", ["Johnny Cash"], released("0000", "USUM70207211"));
    const second = spotifyTrack("Hurt", ["Johnny Cash"], released("2002-11-05", "USUM70207211"));
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"], released("1994-03-08"));
    spotifySearch([first, second, nin]);

    const out = await scout("Hurt");

    expect(ids(out.candidates)).toEqual([first.id, nin.id]);
  });

  it("never merges rows without an ISRC, even with the same title and artist", async () => {
    const studio = spotifyTrack("Hurt", ["Johnny Cash"], released("2002-11-05"));
    const other = spotifyTrack("Hurt", ["Johnny Cash"], released("2003"));
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"], released("1994-03-08"));
    spotifySearch([studio, other, nin]);

    const { state, sent } = await scoutStream("Hurt");

    expect(state.candidates).toHaveLength(3);
    expect(sent[0].message).toBe("3 possible tracks from Spotify; choose one");
  });

  it('gives a candidate dated "0000" no release year, and keeps the date as Spotify sent it', async () => {
    const unknown = spotifyTrack("Hurt", ["Johnny Cash"], released("0000", "USUM70207211"));
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"], released("1994-03-08"));
    spotifySearch([unknown, nin]);

    const out = await scout("Hurt");

    const candidate = out.candidates?.find((row: { id: string }) => row.id === unknown.id);
    expect(candidate).toMatchObject({ releaseDate: "0000" });
    expect(candidate).not.toHaveProperty("releaseYear");
  });
});

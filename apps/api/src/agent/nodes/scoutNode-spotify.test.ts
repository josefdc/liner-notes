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

import { END, InMemoryStore, START, StateGraph } from "@langchain/langgraph";
import { SpotifyAuthManager } from "../../sources/spotify.js";
import { SonicAgentState } from "../state.js";
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

describe("scoutNode's remembered choice", () => {
  const remember = async (query: string, picked: string, offered: string[]) => {
    const store = new InMemoryStore();
    await store.put(["disambiguation"], query, {
      selectedTrackId: picked,
      candidateIds: [...offered].sort().join(","),
    });
    return store;
  };

  it("records the ISRC of the remembered track", async () => {
    const cash = spotifyTrack("Hurt", ["Johnny Cash"], { external_ids: { isrc: "USUM70207211" } });
    const nin = spotifyTrack("Hurt", ["Nine Inch Nails"]);
    spotifySearch([cash, nin]);

    const out = await scout("Hurt", await remember("hurt", cash.id, [cash.id, nin.id]));

    expect(out.spotifyData?.id).toBe(cash.id);
    expect(out.isrc).toBe("USUM70207211");
    expect(out.queryMatch).toBe("exact");
  });

  it("is not used when nothing matches the query", async () => {
    const unrelated = spotifyTrack("xStep", ["DJVI"]);
    spotifySearch([unrelated]);

    const out = await scout(
      "qwzx vlorp blenk",
      await remember("qwzx vlorp blenk", unrelated.id, [unrelated.id]),
    );

    expect(out.spotifyData ?? null).toBeNull();
    expect(ids(out.candidates)).toEqual([unrelated.id]);
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

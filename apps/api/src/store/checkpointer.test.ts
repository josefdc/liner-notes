/**
 * The graph's checkpointer never saves a preview URL: a node later in the run still reads the
 * clip from memory, but neither the saved checkpoints nor the saved node writes hold it.
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PreviewFreeSqliteSaver } from "./checkpointer.js";

const CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/c.mp3?hdnea=exp=1761300000~hmac=abc";
const SPOTIFY_CLIP = "https://p.scdn.co/mp3-preview/abc";

const State = Annotation.Root({
  previewUrl: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  spotifyData: Annotation<Record<string, unknown> | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  trackData: Annotation<Record<string, unknown> | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  note: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
});

/** Every saved checkpoint and node write, as text. */
function savedText(db: Database.Database): string {
  const rows = [
    ...db.prepare("SELECT checkpoint AS blob FROM checkpoints").all(),
    ...db.prepare("SELECT value AS blob FROM writes").all(),
  ] as Array<{ blob: Buffer | string }>;
  return rows.map((row) => row.blob.toString()).join("\n");
}

describe("PreviewFreeSqliteSaver", () => {
  it("keeps the run's clip in memory for the next node but saves none", async () => {
    const db = new Database(":memory:");
    let composerSaw: string | null = null;
    const graph = new StateGraph(State)
      .addNode("scout", () => ({
        spotifyData: { id: "x", title: "Ice Ice Baby", previewUrl: SPOTIFY_CLIP },
        note: "kept",
      }))
      .addNode("engineer", () => ({ previewUrl: CLIP }))
      .addNode("composer", (state) => {
        composerSaw = state.previewUrl;
        return {
          trackData: {
            id: "x",
            previewUrl: state.previewUrl,
            genealogy: { nodes: [{ id: "n", img: CLIP }] },
          },
        };
      })
      .addEdge(START, "scout")
      .addEdge("scout", "engineer")
      .addEdge("engineer", "composer")
      .addEdge("composer", END)
      .compile({ checkpointer: new PreviewFreeSqliteSaver(db) });

    const config = { configurable: { thread_id: "t-1" } };
    const out = await graph.invoke({}, config);

    expect(composerSaw).toBe(CLIP);
    expect(out.trackData?.previewUrl).toBe(CLIP);

    const saved = savedText(db);
    expect(saved).toContain("Ice Ice Baby");
    expect(saved).toContain("kept");
    expect(saved).not.toContain("dzcdn.net");
    expect(saved).not.toContain("hdnea");
    expect(saved).not.toContain("p.scdn.co");

    const state = await graph.getState(config);
    expect(state.values.previewUrl).toBeNull();
    expect(state.values.spotifyData).toEqual({ id: "x", title: "Ice Ice Baby" });
    expect(state.values.trackData).toEqual({
      id: "x",
      genealogy: { nodes: [{ id: "n", img: "" }] },
    });
    expect(state.values.note).toBe("kept");
  });
});

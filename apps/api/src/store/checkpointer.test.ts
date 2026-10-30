/**
 * The graph's checkpointer never saves a preview URL: a node later in the run still reads the
 * clip from memory, but neither the saved checkpoints nor the saved node writes hold it.
 */

import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { describe, expect, it, vi } from "vitest";
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
            genealogy: {
              nodes: [
                { id: "n", img: CLIP },
                // A genealogy node's own clip (Spotify's, or Deezer's by ISRC).
                { id: "m", spotifyId: "y", previewUrl: CLIP },
              ],
            },
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
    expect(out.trackData?.genealogy).toMatchObject({ nodes: [{}, { previewUrl: CLIP }] });

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
      genealogy: {
        nodes: [
          { id: "n", img: "" },
          { id: "m", spotifyId: "y" },
        ],
      },
    });
    expect(state.values.note).toBe("kept");
  });

  it("saves the composer's draft without a clip, whatever it holds", async () => {
    const db = new Database(":memory:");
    const Drafted = Annotation.Root({
      draft: Annotation<Record<string, unknown> | null>({
        reducer: (_, next) => next,
        default: () => null,
      }),
    });
    let verifierSaw: unknown = null;
    const graph = new StateGraph(Drafted)
      .addNode("composer", () => ({
        draft: {
          claims: [{ id: "c1", text: "kept text" }],
          genealogy: { nodes: [{ id: "n", previewUrl: CLIP, label: `see ${SPOTIFY_CLIP}` }] },
        },
      }))
      .addNode("verifier", (state) => {
        verifierSaw = state.draft;
        return {};
      })
      .addEdge(START, "composer")
      .addEdge("composer", "verifier")
      .addEdge("verifier", END)
      .compile({ checkpointer: new PreviewFreeSqliteSaver(db) });

    const config = { configurable: { thread_id: "t-draft" } };
    await graph.invoke({}, config);

    // The next node reads the draft as written; nothing saved holds a clip.
    expect(JSON.stringify(verifierSaw)).toContain("dzcdn.net");
    const saved = savedText(db);
    expect(saved).toContain("kept text");
    expect(saved).not.toContain("dzcdn.net");
    expect(saved).not.toContain("hdnea");
    expect(saved).not.toContain("p.scdn.co");
    const state = await graph.getState(config);
    expect(JSON.stringify(state.values.draft)).not.toMatch(/dzcdn|p\.scdn\.co/);
  });

  it("saves no clip from the interrupt payload or inside an error text, and resumes", async () => {
    const db = new Database(":memory:");
    const Paused = Annotation.Root({
      candidates: Annotation<Array<Record<string, unknown>> | null>({
        reducer: (_, next) => next,
        default: () => null,
      }),
      audioFeatures: Annotation<Record<string, unknown> | null>({
        reducer: (_, next) => next,
        default: () => null,
      }),
      picked: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
    });
    let offered: unknown = null;
    const graph = new StateGraph(Paused)
      .addNode("scout", () => ({
        candidates: [{ id: "a", title: "Ice Ice Baby", previewUrl: SPOTIFY_CLIP }],
      }))
      .addNode("clarification", (state) => {
        offered = state.candidates;
        return { picked: interrupt({ candidates: state.candidates }) as string };
      })
      .addNode("engineer", () => ({
        audioFeatures: { unavailableDetail: `Could not read ${CLIP}` },
      }))
      .addEdge(START, "scout")
      .addEdge("scout", "clarification")
      .addEdge("clarification", "engineer")
      .addEdge("engineer", END)
      .compile({ checkpointer: new PreviewFreeSqliteSaver(db) });
    const config = { configurable: { thread_id: "t-2" } };

    await graph.invoke({}, config);
    const paused = savedText(db);
    expect(paused).toContain("Ice Ice Baby");
    expect(paused).not.toContain("p.scdn.co");

    const pending = await graph.getState(config);
    expect(pending.tasks[0]?.interrupts[0]?.value).toEqual({
      candidates: [{ id: "a", title: "Ice Ice Baby" }],
    });

    const out = await graph.invoke(new Command({ resume: "a" }), config);
    expect(out.picked).toBe("a");
    expect(offered).toEqual([{ id: "a", title: "Ice Ice Baby" }]);
    const resumed = savedText(db);
    expect(resumed).toContain("Could not read [preview]");
    expect(resumed).not.toContain("dzcdn.net");
    expect(resumed).not.toContain("hdnea");
  });

  it("passes on every argument of a checkpoint write after the checkpoint", async () => {
    const base = vi.spyOn(SqliteSaver.prototype, "put").mockResolvedValue({});
    const saver = new PreviewFreeSqliteSaver(new Database(":memory:"));
    const checkpoint = { channel_values: { previewUrl: CLIP, note: "kept" } };
    const newVersions = { previewUrl: 2 };

    await (saver.put as (...args: unknown[]) => Promise<unknown>)(
      { configurable: { thread_id: "t-3" } },
      checkpoint,
      { source: "loop" },
      newVersions,
    );

    expect(base.mock.calls[0]?.[1]).toMatchObject({
      channel_values: { previewUrl: null, note: "kept" },
    });
    expect(base.mock.calls[0]?.slice(2)).toEqual([{ source: "loop" }, newVersions]);
    base.mockRestore();
  });

  it("passes on the task id and the task path of a node write", async () => {
    const base = vi.spyOn(SqliteSaver.prototype, "putWrites").mockResolvedValue();
    const saver = new PreviewFreeSqliteSaver(new Database(":memory:"));

    await saver.putWrites(
      { configurable: { thread_id: "t-4", checkpoint_id: "c-1" } },
      [["previewUrl", CLIP]],
      "task-1",
      "~__pregel_pull, engineer",
    );

    expect(base.mock.calls[0]?.slice(1)).toEqual([
      [["previewUrl", null]],
      "task-1",
      "~__pregel_pull, engineer",
    ]);
    base.mockRestore();
  });
});

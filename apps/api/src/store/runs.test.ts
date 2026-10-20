import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./migrations.js";
import { getRun, settleOpenRuns, startRun, updateRun } from "./runs.js";
import { isWaitingAtInterrupt } from "./threads.js";

/** A one-node graph that pauses for a choice when the query is "ambiguous". */
function pausingGraph(db: Database.Database) {
  const State = Annotation.Root({
    query: Annotation<string>(),
    choice: Annotation<string | undefined>(),
  });
  return new StateGraph(State)
    .addNode("clarification", (state) =>
      state.query === "ambiguous"
        ? { choice: interrupt({ candidates: [{ id: "a" }, { id: "b" }] }) as string }
        : { choice: "only" },
    )
    .addEdge(START, "clarification")
    .addEdge("clarification", END)
    .compile({ checkpointer: new SqliteSaver(db) });
}

const thread = (id: string) => ({ configurable: { thread_id: id } });

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("isWaitingAtInterrupt", () => {
  it("is true only while the thread is paused at the interrupt", async () => {
    const graph = pausingGraph(db);
    await graph.invoke({ query: "ambiguous" }, thread("paused"));
    await graph.invoke({ query: "clear" }, thread("finished"));

    expect(await isWaitingAtInterrupt(db, "paused")).toBe(true);
    expect(await isWaitingAtInterrupt(db, "finished")).toBe(false);
    expect(await isWaitingAtInterrupt(db, "unknown")).toBe(false);

    await graph.invoke(new Command({ resume: "a" }), thread("paused"));
    expect(await isWaitingAtInterrupt(db, "paused")).toBe(false);
  });
});

describe("isWaitingAtInterrupt, from the checkpoint alone", () => {
  /** Saves one checkpoint for the thread with a pending write on `channel`. */
  async function pendingWrite(threadId: string, channel: string) {
    const saver = new SqliteSaver(db);
    const config = await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
      emptyCheckpoint(),
      { source: "loop", step: 1, parents: {} },
    );
    await saver.putWrites(config, [[channel, { value: "x" }]], "task-1");
  }

  it("is true for a pending __interrupt__ write and false for any other pending write", async () => {
    await pendingWrite("interrupted", "__interrupt__");
    await pendingWrite("writing", "query");
    await pendingWrite("erred", "__error__");

    expect(await isWaitingAtInterrupt(db, "interrupted")).toBe(true);
    expect(await isWaitingAtInterrupt(db, "writing")).toBe(false);
    expect(await isWaitingAtInterrupt(db, "erred")).toBe(false);
  });
});

describe("settleOpenRuns", () => {
  it("marks open runs interrupted when their thread waits for a choice, otherwise cancelled", async () => {
    const graph = pausingGraph(db);
    await graph.invoke({ query: "ambiguous" }, thread("paused"));
    await graph.invoke({ query: "clear" }, thread("finished"));
    startRun(db, { runId: "paused", threadId: "paused", query: "ambiguous" });
    startRun(db, { runId: "finished", threadId: "finished", query: "clear" });
    startRun(db, { runId: "lost", threadId: "lost", query: "q" });
    startRun(db, { runId: "done", threadId: "done", query: "q" });
    updateRun(db, "done", { status: "completed" });
    const doneBefore = getRun(db, "done");

    const settled = await settleOpenRuns(db, (threadId) => isWaitingAtInterrupt(db, threadId));

    expect(settled).toEqual({ interrupted: 1, cancelled: 2 });
    expect(getRun(db, "paused")).toMatchObject({ status: "interrupted", finishedAt: null });
    expect(getRun(db, "finished")).toMatchObject({ status: "cancelled" });
    expect(getRun(db, "finished")?.finishedAt).toEqual(expect.any(Number));
    expect(getRun(db, "lost")).toMatchObject({ status: "cancelled" });
    expect(getRun(db, "done")).toEqual(doneBefore);
  });

  it("cancels a run whose thread cannot be read", async () => {
    startRun(db, { runId: "r", threadId: "t", query: "q" });

    const settled = await settleOpenRuns(db, async () => {
      throw new Error("unreadable");
    });

    expect(settled).toEqual({ interrupted: 0, cancelled: 1 });
    expect(getRun(db, "r")?.status).toBe("cancelled");
  });

  it("keeps an outcome the run recorded while it was being settled", async () => {
    startRun(db, { runId: "r", threadId: "t", query: "q" });

    const settled = await settleOpenRuns(db, async () => {
      updateRun(db, "r", { status: "completed" });
      return false;
    });

    expect(settled).toEqual({ interrupted: 0, cancelled: 0 });
    expect(getRun(db, "r")?.status).toBe("completed");
  });
});

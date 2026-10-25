/**
 * Node timings: every time a node of the graph runs, one log line says how long it took and
 * how it ended, under the run's id, and holds nothing of the node's input or output. The nodes
 * are stubs; the graph is the real one (buildSonicAgentGraph).
 */

import {
  Command,
  interrupt,
  type LangGraphRunnableConfig,
  MemorySaver,
} from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests, withRun } from "../logger.js";
import { buildSonicAgentGraph } from "./graph.js";
import { agentRuntime } from "./runtime.js";
import type { SonicAgentStateType } from "./state.js";

const stub = vi.hoisted(() => ({
  /** What each node does; a test replaces one to make it pause, fail or interrupt. */
  scout: null as null | ((state: unknown, config: unknown) => Promise<unknown>),
  engineer: null as null | ((state: unknown, config: unknown) => Promise<unknown>),
  historian: null as null | ((state: unknown, config: unknown) => Promise<unknown>),
}));

vi.mock("./nodes/index.js", () => {
  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const composer = async (state: State) => ({
    trackData: { id: "t", title: "OUTPUT-MARKER", spotify: state.spotifyData },
  });
  return {
    scoutNode: async (state: State, config: Config) =>
      stub.scout
        ? stub.scout(state, config)
        : { spotifyData: { id: "t", title: "OUTPUT-MARKER", artist: "A" } },
    clarificationNode: async () => {
      const choice = interrupt({ candidates: [{ id: "a" }, { id: "b" }] });
      return { selectedTrackId: choice };
    },
    engineerNode: async (state: State, config: Config) => {
      if (stub.engineer) return stub.engineer(state, config);
      await pause(30);
      return {};
    },
    historianNode: async (state: State, config: Config) =>
      stub.historian ? stub.historian(state, config) : {},
    composerNode: composer,
    createComposerNode: () => composer,
  };
});

const INPUT = { songQuery: "INPUT-MARKER typed text" };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settles once `signal` aborts, rejecting with its reason. */
const aborted = (signal: AbortSignal | undefined) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

let logs: CapturedLogs;

beforeEach(() => {
  stub.scout = null;
  stub.engineer = null;
  stub.historian = null;
  logs = captureLogsForTests({ level: "debug" });
});
afterEach(() => {
  logs.restore();
});

/** The timing lines, in the order they were written. */
const timings = () => logs.entries().filter((entry) => entry.component === "Graph");

describe("node timings", () => {
  it("logs one line per node: component, node, runId, durationMs and outcome", async () => {
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await graph.invoke(INPUT, { configurable: { thread_id: "thread-1" } });

    const lines = timings();
    expect(lines.map((line) => line.node).sort()).toEqual(
      ["composer", "engineer", "historian", "scout"].sort(),
    );
    expect(lines[0].node).toBe("scout");
    expect(lines.at(-1)?.node).toBe("composer");
    for (const line of lines) {
      // The exact shape of a timing line.
      expect(Object.keys(line).sort()).toEqual(
        [
          "component",
          "durationMs",
          "level",
          "msg",
          "node",
          "outcome",
          "pid",
          "runId",
          "time",
        ].sort(),
      );
      expect(line).toMatchObject({ level: "info", component: "Graph", runId: "thread-1" });
      expect(line.outcome).toBe("ok");
      expect(typeof line.durationMs).toBe("number");
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
      expect(line.msg).toBe(`Node ${line.node}: ok in ${line.durationMs} ms`);
    }
    // The engineer waits 30 ms.
    expect(lines.find((line) => line.node === "engineer")?.durationMs).toBeGreaterThanOrEqual(25);
    // Nothing of the input or the output.
    const text = logs.lines().join("\n");
    expect(text).not.toContain("INPUT-MARKER");
    expect(text).not.toContain("OUTPUT-MARKER");
  });

  it("carries the id of the run the lines belong to", async () => {
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await withRun("run-from-route", () =>
      graph.invoke(INPUT, { configurable: { thread_id: "run-from-route" } }),
    );

    const lines = timings();
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.runId).toBe("run-from-route");
  });

  it("carries the run's id when it differs from the thread's", async () => {
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await withRun("ctx-id", () =>
      graph.invoke(INPUT, { configurable: { thread_id: "thread-id" } }),
    );

    const lines = timings();
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.runId).toBe("ctx-id");
  });

  it("outside a thread, carries the run id the scout sets", async () => {
    const ids = ["run-from-runtime"];
    const runtime = agentRuntime({ newId: () => ids.shift() ?? "another-id" });
    const graph = buildSonicAgentGraph({ runtime });

    await graph.invoke(INPUT);

    const lines = timings();
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.runId).toBe("run-from-runtime");
  });

  it("logs an interrupted clarification, and again when it runs on resume", async () => {
    stub.scout = async () => ({
      candidates: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    });
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });
    const thread = { configurable: { thread_id: "thread-hitl" } };

    await graph.invoke(INPUT, thread);
    expect(timings().map((line) => [line.node, line.outcome])).toEqual([
      ["scout", "ok"],
      ["clarification", "interrupted"],
    ]);

    logs.clear();
    stub.scout = null;
    await graph.invoke(new Command({ resume: "a" }), thread);
    const resumed = timings();
    expect(resumed[0]).toMatchObject({
      node: "clarification",
      outcome: "ok",
      runId: "thread-hitl",
    });
    expect(resumed.map((line) => line.node).sort()).toEqual(
      ["clarification", "composer", "engineer", "historian"].sort(),
    );
  });

  it("logs a node that throws, or returns an error, as an error", async () => {
    stub.engineer = async () => {
      throw new Error("engineer bug with OUTPUT-MARKER");
    };
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await expect(
      graph.invoke(INPUT, { configurable: { thread_id: "thread-throws" } }),
    ).rejects.toThrow();
    expect(timings().find((line) => line.node === "engineer")).toMatchObject({
      outcome: "error",
      runId: "thread-throws",
    });
    expect(logs.lines().join("\n")).not.toContain("OUTPUT-MARKER");

    logs.clear();
    stub.engineer = null;
    stub.scout = async () => ({ error: "No track found for OUTPUT-MARKER" });
    await graph.invoke(INPUT, { configurable: { thread_id: "thread-reports" } });
    expect(timings()).toEqual([
      expect.objectContaining({ node: "scout", outcome: "error", runId: "thread-reports" }),
    ]);
    expect(logs.lines().join("\n")).not.toContain("OUTPUT-MARKER");
  });

  it("logs a node of a cancelled run as cancelled", async () => {
    const controller = new AbortController();
    stub.historian = async (_state, config) => {
      const { signal } = config as LangGraphRunnableConfig;
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(() => controller.abort(), 10);
      });
      return {};
    };
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await expect(
      graph.invoke(INPUT, {
        configurable: { thread_id: "thread-cancelled" },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(timings().find((line) => line.node === "historian")).toMatchObject({
      outcome: "cancelled",
      runId: "thread-cancelled",
    });
  });

  it("does not count the time the run waits for the user's choice", async () => {
    stub.scout = async () => ({ candidates: [{ id: "a" }, { id: "b" }] });
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });
    const thread = { configurable: { thread_id: "thread-picker" } };

    await graph.invoke(INPUT, thread);
    await wait(150); // the user choosing
    stub.scout = null;
    await graph.invoke(new Command({ resume: "a" }), thread);

    const clarification = timings().filter((line) => line.node === "clarification");
    expect(clarification.map((line) => line.outcome)).toEqual(["interrupted", "ok"]);
    for (const line of clarification) expect(line.durationMs).toBeLessThan(100);
  });

  it("logs a node stopped because another node of its step failed as aborted", async () => {
    stub.engineer = async () => {
      await wait(5);
      throw new Error("engineer bug");
    };
    stub.historian = async (_state, config) => aborted((config as LangGraphRunnableConfig).signal);
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await expect(
      graph.invoke(INPUT, { configurable: { thread_id: "thread-sibling" } }),
    ).rejects.toThrow("engineer bug");
    await wait(20);

    const outcomes = Object.fromEntries(timings().map((line) => [line.node, line.outcome]));
    expect(outcomes).toEqual({ scout: "ok", engineer: "error", historian: "aborted" });
  });

  it("logs a node that returns after its run was cancelled as cancelled, not ok", async () => {
    const controller = new AbortController();
    // Ignores the signal and returns once the run is over.
    stub.engineer = async () => {
      await wait(60);
      return {};
    };
    stub.historian = async (_state, config) => {
      setTimeout(() => controller.abort(), 10);
      return aborted((config as LangGraphRunnableConfig).signal);
    };
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await expect(
      graph.invoke(INPUT, {
        configurable: { thread_id: "thread-late" },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await wait(120);

    const outcomes = Object.fromEntries(timings().map((line) => [line.node, line.outcome]));
    expect(outcomes).toEqual({ scout: "ok", engineer: "cancelled", historian: "cancelled" });
  });
});

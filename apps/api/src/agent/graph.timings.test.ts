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
});

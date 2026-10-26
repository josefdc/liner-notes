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
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests, withRun } from "../logger.js";
import { buildSonicAgentGraph } from "./graph.js";
import { agentRuntime } from "./runtime.js";
import type { SonicAgentStateType } from "./state.js";

const stub = vi.hoisted(() => ({
  /** What each node does; a test replaces one to make it pause, fail or interrupt. */
  scout: null as null | ((state: unknown, config: unknown) => Promise<unknown>),
  engineer: null as null | ((state: unknown, config: unknown) => Promise<unknown>),
  historian: null as null | ((state: unknown, config: unknown) => Promise<unknown>),
  /** What the clarification does with the choice, once the run resumes. */
  chosen: null as null | ((config: unknown) => Promise<unknown>),
}));

vi.mock("./nodes/index.js", () => {
  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const composer = async (state: State) => ({
    draft: { title: "OUTPUT-MARKER", spotify: state.spotifyData },
  });
  return {
    scoutNode: async (state: State, config: Config) =>
      stub.scout
        ? stub.scout(state, config)
        : { spotifyData: { id: "t", title: "OUTPUT-MARKER", artist: "A" } },
    clarificationNode: async (_state: State, config: Config) => {
      const choice = interrupt({ candidates: [{ id: "a" }, { id: "b" }] });
      // The real node fetches the chosen track here.
      if (stub.chosen) await stub.chosen(config);
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
vi.mock("./verifier/index.js", () => {
  const verifier = async (state: SonicAgentStateType) => ({
    trackData: { id: "t", title: "OUTPUT-MARKER", draft: state.draft },
  });
  return { verifierNode: verifier, createVerifierNode: () => verifier };
});

const INPUT = { songQuery: "INPUT-MARKER typed text" };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Invokes `graph` as the analyze routes run it: in the run's context, with the run's signal
 * (`controller`'s) both there and in the invoke's config.
 */
const runAs = (
  graph: ReturnType<typeof buildSonicAgentGraph>,
  input: Parameters<ReturnType<typeof buildSonicAgentGraph>["invoke"]>[0],
  threadId: string,
  controller: AbortController,
) =>
  withRun(
    threadId,
    () => graph.invoke(input, { configurable: { thread_id: threadId }, signal: controller.signal }),
    { signal: controller.signal },
  );

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
  stub.chosen = null;
  logs = captureLogsForTests({ level: "debug" });
});
afterEach(() => {
  logs.restore();
});

/** The timing lines, in the order they were written. */
const timings = () => logs.entries().filter((entry) => entry.component === "Graph");

/**
 * Waits until each of `nodes` has its timing line. A node that outlives its run (it ignores the
 * signal, or LangGraph stops it after the run has rejected) logs after the run has settled; a
 * test that ended before then would leave the line to the next test's capture.
 */
const loggedFor = (...nodes: string[]) =>
  vi.waitFor(
    () => expect(timings().map((line) => line.node)).toEqual(expect.arrayContaining(nodes)),
    { timeout: 4000, interval: 5 },
  );

describe("node timings", () => {
  it("logs one line per node: component, node, runId, durationMs and outcome", async () => {
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await graph.invoke(INPUT, { configurable: { thread_id: "thread-1" } });

    const lines = timings();
    expect(lines.map((line) => line.node).sort()).toEqual(
      ["composer", "engineer", "historian", "scout", "verifier"].sort(),
    );
    expect(lines[0].node).toBe("scout");
    expect(lines.at(-1)?.node).toBe("verifier");
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
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.runId).toBe("run-from-route");
  });

  it("carries the run's id when it differs from the thread's", async () => {
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await withRun("ctx-id", () =>
      graph.invoke(INPUT, { configurable: { thread_id: "thread-id" } }),
    );

    const lines = timings();
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line.runId).toBe("ctx-id");
  });

  it("outside a thread, carries the run id the scout sets", async () => {
    const ids = ["run-from-runtime"];
    const runtime = agentRuntime({ newId: () => ids.shift() ?? "another-id" });
    const graph = buildSonicAgentGraph({ runtime });

    await graph.invoke(INPUT);

    const lines = timings();
    expect(lines).toHaveLength(5);
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
      ["clarification", "composer", "engineer", "historian", "verifier"].sort(),
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
    // Ignores its signal and returns once the run is cancelled, whenever that is.
    stub.engineer = async () => {
      await new Promise((resolve) =>
        controller.signal.addEventListener("abort", resolve, { once: true }),
      );
      return {};
    };
    stub.historian = async (_state, config) => {
      const { signal } = config as LangGraphRunnableConfig;
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(() => controller.abort(), 10);
      });
      return {};
    };
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await expect(runAs(graph, INPUT, "thread-cancelled", controller)).rejects.toThrow();
    // The engineer returns after the cancel: it is cancelled too.
    await loggedFor("historian", "engineer");
    for (const node of ["historian", "engineer"]) {
      expect(timings().find((line) => line.node === node)).toMatchObject({
        outcome: "cancelled",
        runId: "thread-cancelled",
      });
    }
  });

  it("does not count the time the run waits for the user's choice", async () => {
    // Durations are read on a fake clock that only the test moves: the user's minute of
    // choosing and the 7 ms the clarification works on resume, however busy the machine is.
    vi.useFakeTimers({ toFake: ["hrtime"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    stub.scout = async () => ({ candidates: [{ id: "a" }, { id: "b" }] });
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });
    const thread = { configurable: { thread_id: "thread-picker" } };

    await graph.invoke(INPUT, thread);
    vi.advanceTimersByTime(60_000); // the user choosing
    stub.scout = null;
    stub.chosen = async () => {
      vi.advanceTimersByTime(7); // fetching the chosen track
    };
    await graph.invoke(new Command({ resume: "a" }), thread);

    const clarification = timings().filter((line) => line.node === "clarification");
    expect(clarification.map((line) => [line.outcome, line.durationMs])).toEqual([
      ["interrupted", 0],
      ["ok", 7],
    ]);
  });

  it("logs the first node of a resumed run that is cancelled as cancelled", async () => {
    stub.scout = async () => ({ candidates: [{ id: "a" }, { id: "b" }] });
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });
    await runAs(graph, INPUT, "thread-resumed", new AbortController());
    logs.clear();

    // The client leaves while the clarification fetches the chosen track.
    const controller = new AbortController();
    stub.chosen = async (config) => {
      setTimeout(() => controller.abort(), 10);
      await aborted((config as LangGraphRunnableConfig).signal);
    };
    await expect(
      runAs(graph, new Command({ resume: "a" }), "thread-resumed", controller),
    ).rejects.toThrow();

    expect(timings().map((line) => [line.node, line.outcome, line.runId])).toEqual([
      ["clarification", "cancelled", "thread-resumed"],
    ]);
  });

  it("logs a node stopped because another node of its step failed as aborted", async () => {
    stub.engineer = async () => {
      await wait(5);
      throw new Error("engineer bug");
    };
    stub.historian = async (_state, config) => aborted((config as LangGraphRunnableConfig).signal);
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    // Run as the routes run it: the run's own signal is never aborted.
    await expect(runAs(graph, INPUT, "thread-sibling", new AbortController())).rejects.toThrow(
      "engineer bug",
    );
    await loggedFor("historian");

    const outcomes = Object.fromEntries(timings().map((line) => [line.node, line.outcome]));
    expect(outcomes).toEqual({ scout: "ok", engineer: "error", historian: "aborted" });
  });

  it("logs a node that returns after its run was cancelled as cancelled, not ok", async () => {
    const controller = new AbortController();
    // Ignores the signal and returns once the run is over (the test says when).
    let runOver!: () => void;
    const over = new Promise<void>((resolve) => {
      runOver = resolve;
    });
    stub.engineer = async () => {
      await over;
      return {};
    };
    stub.historian = async (_state, config) => {
      setTimeout(() => controller.abort(), 10);
      return aborted((config as LangGraphRunnableConfig).signal);
    };
    const graph = buildSonicAgentGraph({ checkpointer: new MemorySaver() });

    await expect(runAs(graph, INPUT, "thread-late", controller)).rejects.toThrow();
    runOver();
    await loggedFor("engineer");

    const outcomes = Object.fromEntries(timings().map((line) => [line.node, line.outcome]));
    expect(outcomes).toEqual({ scout: "ok", engineer: "cancelled", historian: "cancelled" });
  });
});

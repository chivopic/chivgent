import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { EMPTY_STATE, reduce, type ViewState } from "../src/tui/state.js";

/** Folds a whole script, so a test reads as the sequence a run produces. */
function run(events: readonly AgentEvent[], now = 1_000): ViewState {
  return events.reduce(
    (state, event) => reduce(state, event, now),
    EMPTY_STATE,
  );
}

function assistant(content: string) {
  return { role: "assistant" as const, content, toolCalls: [] };
}

const start: AgentEvent = {
  type: "agent_start",
  prompt: "go",
  maxTurns: 8,
};

describe("reduce", () => {
  it("has nothing alive between runs", () => {
    expect(EMPTY_STATE.run).toBeUndefined();
    expect(run([start, { type: "agent_end", status: "completed", turnCount: 1, messages: [] }]).run).toBeUndefined();
  });

  it("ignores an event that arrives outside a run", () => {
    // Inventing a run from a mid-stream event would show one whose beginning
    // was never seen.
    expect(run([{ type: "turn_start", turn: 1 }])).toBe(EMPTY_STATE);
  });

  it("accumulates assistant text, because message_update is a delta", () => {
    const state = run([
      start,
      { type: "turn_start", turn: 1 },
      { type: "message_start", turn: 1 },
      { type: "message_update", turn: 1, delta: "Hello" },
      { type: "message_update", turn: 1, delta: " world" },
    ]);

    expect(state.run?.text).toBe("Hello world");
  });

  it("replaces tool progress, because tool_execution_update is a snapshot", () => {
    const state = run([
      start,
      { type: "tool_execution_start", turn: 1, toolCallId: "a", toolName: "bash", arguments: { command: "npm test" } },
      { type: "tool_execution_update", turn: 1, toolCallId: "a", toolName: "bash", content: "line 1\nline 2" },
      { type: "tool_execution_update", turn: 1, toolCallId: "a", toolName: "bash", content: "line 2\nline 3" },
    ]);

    // Appending would give "line 1\nline 2line 2\nline 3" — output that was
    // never produced, because the snapshot has already had its front dropped.
    expect(state.run?.running[0]?.progress).toBe("line 2\nline 3");
  });

  it("takes the authoritative message at the end of the turn", () => {
    // Covers the non-streaming case, where no delta ever arrives.
    const state = run([
      start,
      { type: "message_start", turn: 1 },
      { type: "message_end", turn: 1, message: assistant("the whole answer") },
    ]);

    expect(state.run?.text).toBe("the whole answer");
  });

  it("keeps concurrent tools apart", () => {
    // The current renderer redraws one progress line with a carriage return,
    // so two tools running at once overwrite each other. This is the model
    // that makes showing both possible.
    const state = run([
      start,
      { type: "tool_execution_start", turn: 1, toolCallId: "a", toolName: "bash", arguments: { command: "npm test" } },
      { type: "tool_execution_start", turn: 1, toolCallId: "b", toolName: "search_text", arguments: { pattern: "x" } },
      { type: "tool_execution_update", turn: 1, toolCallId: "a", toolName: "bash", content: "from a" },
      { type: "tool_execution_update", turn: 1, toolCallId: "b", toolName: "search_text", content: "from b" },
    ]);

    expect(state.run?.running.map((tool) => [tool.name, tool.progress])).toEqual([
      ["bash", "from a"],
      ["search_text", "from b"],
    ]);
  });

  it("keeps the target of a call so the region can say which file", () => {
    const state = run([
      start,
      { type: "tool_execution_start", turn: 1, toolCallId: "a", toolName: "read_file", arguments: { path: "src/agent.ts" } },
      { type: "tool_execution_start", turn: 1, toolCallId: "b", toolName: "list_files", arguments: {} },
    ]);

    expect(state.run?.running[0]?.target).toBe("src/agent.ts");
    expect(state.run?.running[1]).not.toHaveProperty("target");
  });

  it("removes a tool when it finishes, and only that one", () => {
    const state = run([
      start,
      { type: "tool_execution_start", turn: 1, toolCallId: "a", toolName: "bash", arguments: {} },
      { type: "tool_execution_start", turn: 1, toolCallId: "b", toolName: "read_file", arguments: {} },
      { type: "tool_execution_end", turn: 1, toolCallId: "a", toolName: "bash", content: "done", isError: false },
    ]);

    expect(state.run?.running.map((tool) => tool.toolCallId)).toEqual(["b"]);
    expect(state.run?.status).toBe("running-tools");
  });

  it("goes back to thinking once the last tool finishes", () => {
    const state = run([
      start,
      { type: "tool_execution_start", turn: 1, toolCallId: "a", toolName: "bash", arguments: {} },
      { type: "tool_execution_end", turn: 1, toolCallId: "a", toolName: "bash", content: "done", isError: false },
    ]);

    expect(state.run?.status).toBe("thinking");
  });

  it("clears the turn when it ends, since scrollback now owns it", () => {
    const state = run([
      start,
      { type: "turn_start", turn: 1 },
      { type: "message_update", turn: 1, delta: "text" },
      { type: "tool_execution_start", turn: 1, toolCallId: "a", toolName: "bash", arguments: {} },
      { type: "turn_end", turn: 1, message: assistant("text"), toolResults: [] },
    ]);

    expect(state.run?.text).toBe("");
    expect(state.run?.running).toEqual([]);
    // The run itself continues; only the turn was flushed.
    expect(state.run).toBeDefined();
  });

  it("adds up what the turns reported, and flags a turn that reported nothing", () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const withUsage = run([
      start,
      { type: "message_end", turn: 1, message: assistant("a"), usage },
      { type: "message_end", turn: 2, message: assistant("b"), usage },
    ]);
    expect(withUsage.run?.usage?.usage.totalTokens).toBe(24);
    expect(withUsage.run?.usage?.complete).toBe(true);

    const missing = run([
      start,
      { type: "message_end", turn: 1, message: assistant("a"), usage },
      { type: "message_end", turn: 2, message: assistant("b") },
    ]);
    expect(missing.run?.usage?.complete).toBe(false);
  });

  it("leaves usage absent when no turn ever reported any", () => {
    // Absent and zero are different: one means nothing was spent, the other
    // that nothing was said.
    const state = run([start, { type: "message_end", turn: 1, message: assistant("a") }]);

    expect(state.run).not.toHaveProperty("usage");
  });

  it("never mutates the state it was given", () => {
    const before = run([start, { type: "message_update", turn: 1, delta: "a" }]);
    const snapshot = JSON.stringify(before);

    reduce(before, { type: "message_update", turn: 1, delta: "b" }, 2_000);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

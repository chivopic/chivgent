import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import type { Tool, ToolOutput } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import {
  assistant,
  FakeLLMClient,
  FakeStreamingLLMClient,
  readOnlyWorkspaceWrites,
} from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() {
    return {
      content: "contents",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    };
  },
  async listFiles() {
    return { entries: [], truncated: false };
  },
  async searchText() {
    return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
  },
};

function tool(
  name: string,
  execute: (value: unknown) => Promise<ToolOutput>,
): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" },
    async execute(value) {
      return execute(value);
    },
  };
}

function createAgent(
  llm: FakeLLMClient,
  events: AgentEvent[],
  tools: readonly Tool[] = [],
  streaming = true,
): Agent {
  return new Agent({
    systemPrompt: "System prompt",
    maxTurns: 4,
    llm,
    tools,
    workspace,
    onEvent: (event) => events.push(event),
    streaming,
  });
}

describe("Agent runtime events", () => {
  it("emits a complete lifecycle for a tool-calling run", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "echo", arguments: { value: 1 } }]),
      assistant("Done."),
    ]);
    const agent = createAgent(
      llm,
      events,
      [tool("echo", async () => ({ content: "echoed", isError: false }))],
      false,
    );

    await agent.run("Question");

    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });

  it("reports tool arguments and results on the tool events", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [
        { id: "call-1", name: "echo", arguments: { value: "x" } },
      ]),
      assistant("Done."),
    ]);
    const agent = createAgent(
      llm,
      events,
      [tool("echo", async () => ({ content: "failed", isError: true }))],
      false,
    );

    await agent.run("Question");

    expect(events).toContainEqual({
      type: "tool_execution_start",
      turn: 1,
      toolCallId: "call-1",
      toolName: "echo",
      arguments: { value: "x" },
    });
    expect(events).toContainEqual({
      type: "tool_execution_end",
      turn: 1,
      toolCallId: "call-1",
      toolName: "echo",
      content: "failed",
      isError: true,
    });
  });

  it("streams assistant text as message_update deltas", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeStreamingLLMClient(
      [assistant("Hello world")],
      new Map([[0, ["Hello", " ", "world"]]]),
    );
    const agent = createAgent(llm, events);

    const result = await agent.run("Question");

    expect(
      events
        .filter((event) => event.type === "message_update")
        .map((event) => event.delta),
    ).toEqual(["Hello", " ", "world"]);
    expect(result.status).toBe("completed");
  });

  it("does not stream when streaming is disabled", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeStreamingLLMClient([assistant("Hello world")]);
    const agent = createAgent(llm, events, [], false);

    await agent.run("Question");

    expect(events.some((event) => event.type === "message_update")).toBe(false);
  });

  it("reports max_turns on the final event", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient(
      Array.from({ length: 4 }, (_unused, index) =>
        assistant("", [
          { id: `call-${index}`, name: "echo", arguments: {} },
        ]),
      ),
    );
    const agent = createAgent(
      llm,
      events,
      [tool("echo", async () => ({ content: "echoed", isError: false }))],
      false,
    );

    await agent.run("Question");

    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      status: "max_turns",
      turnCount: 4,
    });
  });

  it("reports an error status before rethrowing", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([assistant("", [])]);
    const agent = createAgent(llm, events, [], false);

    await expect(agent.run("Question")).rejects.toThrow(
      "no text or tool calls",
    );
    expect(events.at(-1)).toMatchObject({ type: "agent_end", status: "error" });
  });

  it("isolates a listener that throws", async () => {
    const llm = new FakeLLMClient([assistant("Done.")]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 4,
      llm,
      tools: [],
      workspace,
      onEvent: () => {
        throw new Error("renderer crashed");
      },
      streaming: false,
    });

    await expect(agent.run("Question")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("hands listeners a copy they cannot use to mutate the transcript", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "echo", arguments: {} }]),
      assistant("Done."),
    ]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 4,
      llm,
      tools: [tool("echo", async () => ({ content: "echoed", isError: false }))],
      workspace,
      onEvent: (event) => {
        if (event.type === "message_end") {
          (event.message as { content: string }).content = "tampered";
        }
      },
      streaming: false,
    });

    const result = await agent.run("Question");

    expect(result.status).toBe("completed");
    expect(result.status === "completed" && result.finalMessage.content).toBe(
      "Done.",
    );
  });
});

describe("Agent cancellation", () => {
  it("returns an aborted result instead of throwing", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "stop", arguments: {} }]),
      assistant("Never reached."),
    ]);
    const agent = createAgent(
      llm,
      events,
      [
        tool("stop", async () => {
          controller.abort();
          return { content: "stopped", isError: false };
        }),
      ],
      false,
    );

    const result = await agent.run("Question", { signal: controller.signal });

    expect(result.status).toBe("aborted");
    expect(result.turnCount).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      status: "aborted",
    });
  });

  it("does not start a turn once the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([assistant("Never reached.")]);
    const agent = createAgent(llm, events, [], false);

    const result = await agent.run("Question", { signal: controller.signal });

    expect(result.status).toBe("aborted");
    expect(result.turnCount).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it("keeps prior history in front of the new prompt", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([assistant("Second answer.")]);
    const agent = createAgent(llm, events, [], false);

    await agent.run("Second question", {
      history: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer.", toolCalls: [] },
      ],
    });

    expect(llm.requests[0]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer.", toolCalls: [] },
      { role: "user", content: "Second question" },
    ]);
  });
});

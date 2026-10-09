import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import type { Tool } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() {
    return { content: "ok", startLine: 1, endLine: 1, totalLines: 1, truncated: false };
  },
  async listFiles() {
    return { entries: [], truncated: false };
  },
  async searchText() {
    return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
  },
};

function makeAgent(llm: FakeLLMClient, tools: readonly Tool[] = [], onEvent?: (event: AgentEvent) => void) {
  return new Agent({
    systemPrompt: "test",
    maxTurns: 3,
    llm,
    tools,
    workspace,
    streaming: false,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

function makeTool(name: string, run: () => Promise<string>): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    async execute() {
      return { content: await run(), isError: false };
    },
  };
}

describe("interrupted tool-call recovery", () => {
  it("closes unfinished calls without running them after cancellation", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let secondExecuted = false;
    const llm = new FakeLLMClient([
      assistant("", [
        { id: "one", name: "first", arguments: {} },
        { id: "two", name: "second", arguments: {} },
      ]),
      assistant("continued"),
    ]);
    const agent = makeAgent(llm, [
      makeTool("first", async () => {
        controller.abort();
        return "first completed";
      }),
      makeTool("second", async () => {
        secondExecuted = true;
        return "should not run";
      }),
    ], (event) => events.push(event));

    const first = await agent.run("run both tools", { signal: controller.signal });
    expect(first.status).toBe("aborted");
    expect(secondExecuted).toBe(false);
    expect(first.messages.slice(-2)).toEqual([
      { role: "tool", toolCallId: "one", toolName: "first", content: "first completed", isError: false },
      { role: "tool", toolCallId: "two", toolName: "second", content: "Tool execution interrupted before completion.", isError: true },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", status: "aborted", messages: first.messages });

    await agent.run("try another question", { history: first.messages });
    const followup = llm.requests[1]?.messages ?? [];
    expect(followup).toEqual([...first.messages, { role: "user", content: "try another question" }]);
  });

  it("records failure for an in-flight tool that throws AbortError", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [{ id: "abort-1", name: "blocked", arguments: {} }]),
    ]);
    const tool = makeTool("blocked", async () => {
      controller.abort();
      const error = new Error("Aborted");
      error.name = "AbortError";
      throw error;
    });
    const result = await makeAgent(llm, [tool], (event) => events.push(event))
      .run("run blocked tool", { signal: controller.signal });

    expect(result.status).toBe("aborted");
    expect(result.messages.at(-1)).toMatchObject({
      role: "tool", toolCallId: "abort-1", isError: true,
    });
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "agent_end", status: "aborted" });
  });

  it("repairs old transcripts with missing tool outputs before a later user message", async () => {
    const llm = new FakeLLMClient([assistant("new answer")]);
    const oldHistory = [
      { role: "user" as const, content: "old" },
      { role: "assistant" as const, content: "", toolCalls: [
        { id: "orphan", name: "old_tool", arguments: {} },
      ] },
      { role: "user" as const, content: "continue without tool" },
    ];
    const result = await makeAgent(llm).run("one more question", { history: oldHistory });

    expect(result.status).toBe("completed");
    expect(llm.requests[0]?.messages).toEqual([
      oldHistory[0],
      oldHistory[1],
      { role: "tool", toolCallId: "orphan", toolName: "old_tool", content: "Tool execution interrupted before completion.", isError: true },
      oldHistory[2],
      { role: "user", content: "one more question" },
    ]);
    expect(oldHistory).toHaveLength(3);
  });

  it("does not turn a late Provider response into an answer after cancellation", async () => {
    const controller = new AbortController();
    class LateProvider extends FakeLLMClient {
      override async complete(request: Parameters<FakeLLMClient["complete"]>[0]) {
        const response = await super.complete(request);
        controller.abort();
        return response;
      }
    }
    const llm = new LateProvider([assistant("late answer")]);
    const result = await makeAgent(llm).run("question", { signal: controller.signal });

    expect(result.status).toBe("aborted");
    expect(result.messages).toEqual([{ role: "user", content: "question" }]);
  });
});

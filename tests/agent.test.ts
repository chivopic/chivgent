import { describe, expect, it } from "vitest";
import { Agent, AgentProtocolError } from "../src/agent.js";
import { ListFilesTool } from "../src/tools/list-files.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { SearchTextTool } from "../src/tools/search-text.js";
import type { Tool, ToolOutput } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import {
  assistant,
  FakeLLMClient,
  readOnlyWorkspaceWrites,
} from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile(path) {
    return {
      content: `contents:${path}`,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    };
  },
  async listFiles() {
    return {
      entries: [
        { path: "package.json", type: "file" },
        { path: "src/", type: "directory" },
        { path: "src/agent.ts", type: "file" },
      ],
      truncated: false,
    };
  },
  async searchText() {
    return {
      matches: [
        { path: "src/agent.ts", line: 46, preview: "export class Agent" },
      ],
      truncated: false,
      scannedFiles: 3,
      skippedFiles: 0,
    };
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
  tools: readonly Tool[] = [],
  maxTurns = 4,
): Agent {
  return new Agent({
    systemPrompt: "Test prompt",
    maxTurns,
    llm,
    tools,
    workspace,
  });
}

describe("Agent", () => {
  it("finishes when the assistant returns text without tool calls", async () => {
    const llm = new FakeLLMClient([assistant("Final answer")]);

    const result = await createAgent(llm).run("Question");

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.finalMessage.content).toBe("Final answer");
      expect(result.turnCount).toBe(1);
    }
  });

  it("executes a tool and sends its result into the next LLM call", async () => {
    const continuation = { responseId: "response-1" };
    const llm = new FakeLLMClient([
      assistant("", [
        { id: "call-1", name: "read_file", arguments: { path: "src/a.ts" } },
      ], continuation),
      assistant("The file exports a function."),
    ]);
    const read = tool("read_file", async (value) => ({
      content: `read:${JSON.stringify(value)}`,
      isError: false,
    }));

    const result = await createAgent(llm, [read]).run("Explain src/a.ts");

    expect(result.status).toBe("completed");
    expect(llm.requests[1]?.continuation).toEqual(continuation);
    expect(llm.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: 'read:{"path":"src/a.ts"}',
      isError: false,
    });
  });

  it("returns tool failures to the LLM instead of stopping the loop", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "fail", arguments: {} }]),
      assistant("I could not read the file."),
    ]);
    const failingTool = tool("fail", async () => {
      throw new Error("secret internal details");
    });

    await createAgent(llm, [failingTool]).run("Question");

    expect(llm.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      isError: true,
      content: "Tool execution failed: fail",
    });
  });

  it("returns an error result for an unknown tool", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "missing", arguments: {} }]),
      assistant("The tool is unavailable."),
    ]);

    await createAgent(llm).run("Question");

    expect(llm.requests[1]?.messages.at(-1)).toMatchObject({
      toolName: "missing",
      content: "Unknown tool: missing",
      isError: true,
    });
  });

  it("executes multiple tool calls sequentially", async () => {
    const order: number[] = [];
    const sequentialTool = tool("sequence", async (value) => {
      const sequence = (value as { sequence: number }).sequence;
      order.push(sequence);
      return { content: String(sequence), isError: false };
    });
    const llm = new FakeLLMClient([
      assistant("", [
        { id: "call-1", name: "sequence", arguments: { sequence: 1 } },
        { id: "call-2", name: "sequence", arguments: { sequence: 2 } },
      ]),
      assistant("Done"),
    ]);

    await createAgent(llm, [sequentialTool]).run("Question");

    expect(order).toEqual([1, 2]);
    expect(llm.requests[1]?.messages.slice(-2).map((message) => message.role === "tool" ? message.toolCallId : "")).toEqual([
      "call-1",
      "call-2",
    ]);
  });

  it("rejects duplicate tool call ids", async () => {
    const llm = new FakeLLMClient([
      assistant("", [
        { id: "duplicate", name: "read_file", arguments: {} },
        { id: "duplicate", name: "read_file", arguments: {} },
      ]),
    ]);

    await expect(createAgent(llm).run("Question")).rejects.toBeInstanceOf(
      AgentProtocolError,
    );
  });

  it("rejects empty assistant responses", async () => {
    const llm = new FakeLLMClient([assistant("")]);

    await expect(createAgent(llm).run("Question")).rejects.toThrow(
      "no text or tool calls",
    );
  });

  it("stops deterministically at maxTurns", async () => {
    const call = (id: string) =>
      assistant("", [{ id, name: "read_file", arguments: { path: "a.ts" } }]);
    const llm = new FakeLLMClient([call("call-1"), call("call-2")]);
    const read = tool("read_file", async () => ({ content: "x", isError: false }));

    const result = await createAgent(llm, [read], 2).run("Question");

    expect(result).toMatchObject({ status: "max_turns", turnCount: 2 });
    expect(llm.requests).toHaveLength(2);
  });

  it("rejects duplicate tool names during construction", () => {
    const same = tool("same", async () => ({ content: "", isError: false }));

    expect(() => createAgent(new FakeLLMClient([]), [same, same])).toThrow(
      "Duplicate tool name",
    );
  });

  it("discovers an unfamiliar project before answering", async () => {
    const llm = new FakeLLMClient([
      assistant("", [
        {
          id: "call-list",
          name: "list_files",
          arguments: { path: ".", max_depth: 4 },
        },
      ]),
      assistant("", [
        {
          id: "call-package",
          name: "read_file",
          arguments: {
            path: "package.json",
            start_line: 1,
            line_count: 200,
          },
        },
      ]),
      assistant("", [
        {
          id: "call-search",
          name: "search_text",
          arguments: {
            query: "class Agent",
            path: "src",
            max_results: 50,
          },
        },
      ]),
      assistant("", [
        {
          id: "call-read",
          name: "read_file",
          arguments: {
            path: "src/agent.ts",
            start_line: 46,
            line_count: 120,
          },
        },
      ]),
      assistant("The project contains a tool-calling Agent runtime."),
    ]);

    const result = await createAgent(
      llm,
      [new ListFilesTool(), new SearchTextTool(), new ReadFileTool()],
      6,
    ).run("What does this project do?");

    expect(result).toMatchObject({ status: "completed", turnCount: 5 });
    expect(
      llm.requests
        .slice(1)
        .map((request) => request.messages.at(-1))
        .filter((message) => message?.role === "tool")
        .map((message) => (message?.role === "tool" ? message.toolName : "")),
    ).toEqual(["list_files", "read_file", "search_text", "read_file"]);
  });
});

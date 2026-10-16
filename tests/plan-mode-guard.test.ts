import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { FakeLLMClient, assistant, readOnlyWorkspaceWrites } from "./fakes.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import type { Workspace } from "../src/workspace.js";
import type { Tool } from "../src/tools/tool.js";

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() { return { content: "ok", startLine: 1, endLine: 1, totalLines: 1, truncated: false }; },
  async listFiles() { return { entries: [], truncated: false }; },
  async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
};

describe("Plan Mode execution guard", () => {
  it("filters schemas and blocks a malicious write call even with a provider continuation", async () => {
    const execute = vi.fn(async () => ({ content: "changed", isError: false }));
    const writeLike: Tool = { name: "write_file", description: "write", inputSchema: { type: "object" }, execute };
    const llm = new FakeLLMClient([
      assistant("", [{ id: "bad-call", name: "write_file", arguments: { path: "x", content: "bad" } }], { responseId: "old-chain" }),
      assistant("I will wait for Plan Mode to end."),
    ]);
    const agent = new Agent({ systemPrompt: "system", maxTurns: 3, llm, tools: [new ReadFileTool(), writeLike], workspace, streaming: false });

    const result = await agent.run("Inspect and plan", { planMode: true });

    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(llm.requests[0]?.tools.map(tool => tool.name)).toEqual(["read_file"]);
    expect(llm.requests[0]?.systemPrompt).toContain("Plan Mode is active");
    expect(llm.requests[1]?.continuation).toEqual({ responseId: "old-chain" });
    expect(result.messages.find(message => message.role === "tool" && message.toolCallId === "bad-call")).toMatchObject({ isError: true, content: expect.stringContaining("Plan Mode blocked") });
  });
});

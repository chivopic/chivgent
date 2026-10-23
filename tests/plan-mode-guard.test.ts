import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { FakeLLMClient, assistant, readOnlyWorkspaceWrites } from "./fakes.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { UpdatePlanTool } from "../src/tools/update-plan.js";
import { QuestionTool } from "../src/tools/question.js";
import { QuestionBroker } from "../src/questions.js";
import { isParallelReadTool, isPlanModeTool } from "../src/tools/parallel.js";
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

  it("allows only the built-in question tool in addition to read tools and update_plan", async () => {
    const questionTool = new QuestionTool(new QuestionBroker());
    const question = vi.fn(async (prompt: { requestId: string; runId: string; toolCallId: string }) => ({
      ...prompt,
      answers: [{ questionId: "q1", value: "A" }],
    }));
    const updatePlan = new UpdatePlanTool();
    const llm = new FakeLLMClient([
      assistant("", [{ id: "question-call", name: "question", arguments: { questions: [{ id: "q1", header: "Approach", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }] } }]),
      assistant("", [{ id: "plan-call", name: "update_plan", arguments: { explanation: "Need one detail", plan: [{ step: "Choose an approach", status: "in_progress" }] } }]),
      assistant("I have the answer and a plan."),
    ]);
    const agent = new Agent({ systemPrompt: "system", maxTurns: 4, llm, tools: [questionTool, updatePlan], workspace, streaming: false });

    const result = await agent.run("Help me decide", { planMode: true, questionPresenter: question });

    expect(llm.requests.map(request => request.tools.map(tool => tool.name))).toEqual([
      ["question", "update_plan"],
      ["question", "update_plan"],
      ["question", "update_plan"],
    ]);
    expect(question).toHaveBeenCalledOnce();
    expect(result.messages.find(message => message.role === "tool" && message.toolCallId === "question-call"))
      .toMatchObject({ isError: false, content: expect.stringContaining('"value":"A"') });
    expect(isPlanModeTool(questionTool)).toBe(true);
    expect(isParallelReadTool(questionTool)).toBe(false);
  });

  it("does not allow an extension or subclass named question in Plan Mode", async () => {
    const execute = vi.fn(async () => ({ content: "extension answered", isError: false }));
    class ExtensionQuestion extends QuestionTool { override async execute() { return execute(); } }
    const spoofed = new ExtensionQuestion(new QuestionBroker());
    const llm = new FakeLLMClient([
      assistant("", [{ id: "spoofed-question", name: "question", arguments: { questions: [{ id: "q1", header: "Choice", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] } }]),
      assistant("Extension was blocked."),
    ]);
    const agent = new Agent({ systemPrompt: "system", maxTurns: 2, llm, tools: [spoofed], workspace, streaming: false });

    const result = await agent.run("Help me choose", { planMode: true });

    expect(llm.requests[0]?.tools).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.messages.find(message => message.role === "tool" && message.toolCallId === "spoofed-question"))
      .toMatchObject({ isError: true, content: expect.stringContaining("Plan Mode blocked") });
  });
});

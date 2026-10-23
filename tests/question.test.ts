import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { QuestionBroker, validateQuestions, type QuestionPresenter } from "../src/questions.js";
import { QuestionTool } from "../src/tools/question.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace", ...readOnlyWorkspaceWrites,
  async readTextFile() { return { content: "", startLine: 1, endLine: 1, totalLines: 0, truncated: false }; },
  async listFiles() { return { entries: [], truncated: false }; },
  async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
};

const questions = [
  { id: "mode", header: "Mode", question: "Which mode?", options: [{ label: "Quick" }, { label: "Careful" }] },
  { id: "parts", header: "Parts", question: "Which parts?", options: [{ label: "Docs" }, { label: "Code" }], multiple: true },
  { id: "detail", header: "Detail", question: "Any detail?" },
];

describe("structured questions", () => {
  it("rejects empty and oversized requests before opening an interactive request", () => {
    expect(() => validateQuestions({ questions: [] })).toThrow("Question count");
    expect(() => validateQuestions({ questions: [{ id: "x", header: "x", question: "x".repeat(2_001) }] })).toThrow("Question text");
  });

  it("does not invoke the presenter for malformed requests", async () => {
    const presenter = vi.fn(async () => ({ status: "cancelled" as const }));
    const result = await new QuestionBroker().ask({ runId: "r", toolCallId: "t" }, { questions: [] }, presenter);
    expect(result.status).toBe("unavailable");
    expect(presenter).not.toHaveBeenCalled();
  });

  it("continues the same run with paired results for single, multiple, and free-text answers", async () => {
    const broker = new QuestionBroker();
    const questionTool = new QuestionTool(broker);
    const llm = new FakeLLMClient([
      assistant("", [{ id: "ask-1", name: "question", arguments: { questions } }], { responseId: "question-chain" }),
      assistant("I will use the selected approach."),
    ]);
    const presenter: QuestionPresenter = vi.fn(async prompt => ({
      ...prompt,
      answers: [
        { questionId: "mode", value: "Careful" },
        { questionId: "parts", value: ["Docs", "Code"] },
        { questionId: "detail", value: "中文补充说明" },
      ],
    }));
    const agent = new Agent({ systemPrompt: "system", maxTurns: 3, llm, tools: [questionTool], workspace, streaming: false });

    const result = await agent.run("Help me choose", { questionPresenter: presenter });

    expect(result.status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.continuation).toEqual({ responseId: "question-chain" });
    const resultMessage = result.messages.find(message => message.role === "tool" && message.toolCallId === "ask-1");
    expect(resultMessage).toMatchObject({ role: "tool", toolName: "question", isError: false });
    expect(JSON.parse(resultMessage?.role === "tool" ? resultMessage.content : "{}")).toEqual({ answers: [
      { questionId: "mode", value: "Careful" },
      { questionId: "parts", value: ["Docs", "Code"] },
      { questionId: "detail", value: "中文补充说明" },
    ] });
    expect(presenter).toHaveBeenCalledOnce();
  });

  it("rejects stale and cross-run replies, then accepts only the current bound reply", async () => {
    const broker = new QuestionBroker();
    const input = { questions: [{ id: "q", header: "Pick", question: "Choose?", options: [{ label: "A" }, { label: "B" }] }] };
    const stale: QuestionPresenter = async prompt => ({ ...prompt, runId: "another-run", answers: [{ questionId: "q", value: "A" }] });
    expect(await broker.ask({ runId: "run-1", toolCallId: "call-1" }, input, stale)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("did not match") });
    const current: QuestionPresenter = async prompt => ({ ...prompt, answers: [{ questionId: "q", value: "B" }] });
    expect(await broker.ask({ runId: "run-2", toolCallId: "call-2" }, input, current)).toEqual({ status: "answered", answers: [{ questionId: "q", value: "B" }] });
  });

  it("returns distinct cancellation and unavailable results without waiting for a channel", async () => {
    const broker = new QuestionBroker();
    const binding = { runId: "run", toolCallId: "call" };
    expect(await broker.ask(binding, { questions }, undefined)).toMatchObject({ status: "unavailable" });
    expect(await broker.ask(binding, { questions }, async () => ({ status: "cancelled" }))).toEqual({ status: "cancelled", reason: "user" });
  });

  it("returns an immediate tool error when a headless run has no presenter", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "headless-question", name: "question", arguments: { questions: [questions[0]] } }]),
      assistant("The question channel is unavailable here."),
    ]);
    const agent = new Agent({ systemPrompt: "system", maxTurns: 2, llm, tools: [new QuestionTool(new QuestionBroker())], workspace, streaming: false });
    const result = await agent.run("Choose a mode");
    expect(llm.requests).toHaveLength(2);
    expect(result.messages.find(message => message.role === "tool" && message.toolCallId === "headless-question"))
      .toMatchObject({ isError: true, content: expect.stringContaining("unavailable") });
  });
});

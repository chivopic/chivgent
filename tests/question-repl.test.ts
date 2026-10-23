import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { QuestionBroker } from "../src/questions.js";
import { QuestionTool } from "../src/tools/question.js";
import { runRepl } from "../src/repl.js";
import { displayWidth } from "../src/tui/text.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";
import { terminalHarness } from "./helpers/terminal.js";

const workspace: Workspace = {
  root: "/workspace", ...readOnlyWorkspaceWrites,
  async readTextFile() { return { content: "", startLine: 1, endLine: 1, totalLines: 0, truncated: false }; },
  async listFiles() { return { entries: [], truncated: false }; },
  async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
};

function makeSession(responses: ConstructorParameters<typeof FakeLLMClient>[0]) {
  return new AgentSession({ id: "question-session", agent: {
    systemPrompt: "test", maxTurns: 4, streaming: false,
    llm: new FakeLLMClient(responses), tools: [new QuestionTool(new QuestionBroker())], workspace,
  } });
}

it("routes a multi-question answer in simple REPL and restores the next prompt", async () => {
  const llmResponses = [
    assistant("", [{ id: "ask", name: "question", arguments: { questions: [
      { id: "mode", header: "Mode", question: "Which mode?", options: [{ label: "Fast" }, { label: "Careful" }] },
      { id: "parts", header: "Parts", question: "Which parts?", options: [{ label: "Docs" }, { label: "Code" }], multiple: true },
      { id: "detail", header: "Detail", question: "Add details?" },
    ] } }]),
    assistant("Decision recorded."),
    assistant("Second prompt received."),
  ];
  const session = makeSession(llmResponses);
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
  const done = runRepl({ session, input, output, stderr: output });
  try {
    input.write("choose\r");
    await vi.waitFor(() => expect(printed).toContain("Question 1/3"));
    expect(printed).toContain("Type /cancel to cancel this question.");
    expect(printed).not.toContain("press Esc");
    input.write("2\r");
    await vi.waitFor(() => expect(printed).toContain("Question 2/3"));
    input.write("1,2\r");
    await vi.waitFor(() => expect(printed).toContain("Question 3/3"));
    input.write("中文补充\r");
    await vi.waitFor(() => expect(session.messages.some(message => message.role === "assistant" && message.content === "Decision recorded.")).toBe(true));
    input.write("again\r");
    await vi.waitFor(() => expect(session.turns).toBe(2));
    expect(session.messages.some(message => message.role === "tool" && message.toolCallId === "ask" && message.content.includes('"Careful"'))).toBe(true);
    input.write("\x04");
    expect(await done).toBe(0);
  } finally { input.end(); output.destroy(); await done; }
});

it("renders a narrow TUI question and cancels it with Escape without accepting a late answer", async () => {
  vi.stubEnv("TERM", "xterm-256color");
  const screen = terminalHarness(24, 9);
  const session = makeSession([
    assistant("", [{ id: "ask-cancel", name: "question", arguments: { questions: [{ id: "q", header: "Mode", question: "Choose a path?", options: [{ label: "Fast" }, { label: "Careful" }] }] } }]),
    assistant("I will wait for another prompt."),
    assistant("Composer was restored."),
  ]);
  const done = runRepl({ session, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
  try {
    screen.input.write("choose\r");
    await vi.waitFor(async () => {
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("Choose a path?");
      expect(screen.visible().join("\n")).toContain("1. Fast");
    });
    expect(screen.visible().every(line => line.length <= 24)).toBe(true);
    screen.input.write("\u001b");
    await vi.waitFor(() => expect(session.messages.some(message => message.role === "tool" && message.toolCallId === "ask-cancel" && message.isError && message.content.includes("cancelled by the user"))).toBe(true));
    expect(screen.input.raw).toBe(true);
    screen.input.write("again\r");
    await vi.waitFor(() => expect(session.turns).toBe(2));
    expect(session.messages.some(message => message.role === "assistant" && message.content === "Composer was restored.")).toBe(true);
    screen.input.write("\x04");
    expect(await done).toBe(0);
  } finally { screen.input.end(); await done; screen.dispose(); vi.unstubAllEnvs(); }
});

it("routes a keyboard option answer through the rich TUI and restores its composer", async () => {
  vi.stubEnv("TERM", "xterm-256color");
  const screen = terminalHarness(32, 12);
  const session = makeSession([
    assistant("", [{ id: "ask-tui", name: "question", arguments: { questions: [{ id: "q", header: "Mode", question: "Choose?", options: [{ label: "Fast" }, { label: "Careful" }] }] } }]),
    assistant("TUI answer recorded."),
    assistant("TUI composer restored."),
  ]);
  const done = runRepl({ session, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
  try {
    screen.input.write("choose\r");
    await vi.waitFor(async () => {
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("Choose?");
    });
    screen.input.write("2\r");
    await vi.waitFor(() => expect(session.messages.some(message => message.role === "assistant" && message.content === "TUI answer recorded.")).toBe(true));
    expect(session.messages.some(message => message.role === "tool" && message.toolCallId === "ask-tui" && message.content.includes('"Careful"'))).toBe(true);
    screen.input.write("again\r");
    await vi.waitFor(() => expect(session.turns).toBe(2));
    expect(session.messages.some(message => message.role === "assistant" && message.content === "TUI composer restored.")).toBe(true);
    screen.input.write("\x04");
    expect(await done).toBe(0);
  } finally { screen.input.end(); await done; screen.dispose(); vi.unstubAllEnvs(); }
});


it("keeps multiline question and option text visible above the answer prompt in a narrow terminal", async () => {
  vi.stubEnv("TERM", "xterm-256color");
  const screen = terminalHarness(20, 12);
  const session = makeSession([
    assistant("", [{ id: "ask-multiline", name: "question", arguments: { questions: [{
      id: "q", header: "方向", question: "Which direction?\n请结合当前项目说明你想先处理的重点。", options: [
        { label: "Fast path\n快速方案", description: "先做可验证的最小改动" },
        { label: "Careful path", description: "先梳理边界再实施" },
      ] }] } }]),
    assistant("Multiline choice recorded."),
  ]);
  const done = runRepl({ session, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
  try {
    screen.input.write("choose\r");
    await vi.waitFor(async () => {
      await screen.flush();
      const rendered = screen.history().join("\n");
      expect(rendered).toContain("Which direction?");
      expect(rendered).toContain("请结合当前项目说明");
      expect(rendered).toContain("你想先处理的重点。");
      expect(rendered).toContain("快速方案");
      expect(rendered).toContain("先做可验");
      expect(rendered).toContain("证的最小改动");
      expect(screen.visible().join("\n")).toContain("answer>");
    });
    expect(screen.history().every(line => displayWidth(line) <= 20)).toBe(true);
    screen.input.write("2\r");
    await vi.waitFor(() => expect(session.messages.some(message => message.role === "assistant" && message.content === "Multiline choice recorded.")).toBe(true));
    expect(session.messages.some(message => message.role === "tool" && message.toolCallId === "ask-multiline" && message.content.includes('"Careful path"'))).toBe(true);
    screen.input.write("\x04");
    expect(await done).toBe(0);
  } finally { screen.input.end(); await done; screen.dispose(); vi.unstubAllEnvs(); }
});

it("Ctrl+C aborts a pending question without leaking a partial answer into the next prompt", async () => {
  vi.stubEnv("TERM", "xterm-256color");
  const screen = terminalHarness(80, 20);
  const llm = new FakeLLMClient([
    assistant("", [{ id: "question-cancel", name: "question", arguments: { questions: [{ id: "q", header: "Pick", question: "Which direction?", options: [{ label: "A" }, { label: "B" }] }] } }]),
    assistant("Next prompt completed."),
  ]);
  const session = new AgentSession({ id: "question-cancel-session", agent: {
    systemPrompt: "test", maxTurns: 4, llm, tools: [new QuestionTool(new QuestionBroker())], workspace, streaming: false,
  } });
  const endings: string[] = [];
  session.subscribe(event => { if (event.type === "agent_end") endings.push(event.status); });
  const done = runRepl({ session, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
  try {
    screen.input.write("choose\r");
    await vi.waitFor(() => expect(screen.bytes()).toContain("answer>"));
    screen.input.write("1");
    screen.input.write("\x03");
    await vi.waitFor(() => expect(endings).toEqual(["aborted"]));
    expect(llm.requests).toHaveLength(1);
    screen.input.write("again\r");
    await vi.waitFor(() => expect(endings).toEqual(["aborted", "completed"]));
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.messages.at(-1)).toEqual({ role: "user", content: "again" });
    expect(session.messages.some(message => message.role === "tool" && message.toolCallId === "question-cancel" && message.content.includes('"A"'))).toBe(false);
    screen.input.write("\x04");
    expect(await done).toBe(0);
  } finally { screen.input.end(); await done; screen.dispose(); vi.unstubAllEnvs(); }
});

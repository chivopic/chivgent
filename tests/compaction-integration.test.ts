import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { ContextManager, SUMMARY_MARKER } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import type { LLMResponse } from "../src/llm.js";
import type { Tool } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import { AgentSession } from "../src/session.js";
import { assistant, FakeLLMClient } from "./fakes.js";
import { handleSlashCommand } from "../src/repl.js";

const workspace: Workspace = {
  root: "/workspace",
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

/** Returns a tool result big enough to blow a small context budget. */
function bulkyTool(): Tool {
  return {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    async execute() {
      return { content: "x".repeat(12_000), isError: false };
    },
  };
}

function usage(response: LLMResponse, input: number, output: number): LLMResponse {
  return { ...response, usage: { inputTokens: input, outputTokens: output } };
}

describe("compaction inside the Agent Loop", () => {
  it("compacts before the request once the transcript outgrows the budget", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [
        { id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
      ]),
      assistant("Done."),
    ]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 5,
      llm,
      tools: [bulkyTool()],
      workspace,
      streaming: false,
      onEvent: (event) => events.push(event),
      context: new ContextManager({
        maxInputTokens: 2_000,
        maxToolResultTokens: 50,
        summarise: async () => "Read a.ts.",
      }),
    });

    const result = await agent.run("Question");

    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "compaction_start")).toBe(true);
    const end = events.find((event) => event.type === "compaction_end");
    expect(end?.type === "compaction_end" && end.afterTokens).toBeLessThan(
      end?.type === "compaction_end" ? end.beforeTokens : 0,
    );
    // A single prompt cannot be summarised away, so the bulky tool result is
    // what gets trimmed, and the trimmed copy is what reaches the Provider.
    expect(end?.type === "compaction_end" && end.shrunkToolResults).toBe(1);
    expect(
      llm.requests.at(-1)?.messages.some((message) =>
        message.role === "tool"
          ? message.content.includes("trimmed to fit the context budget")
          : false,
      ),
    ).toBe(true);
  });

  it("summarises earlier prompts once a session has more than one", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "read_file", arguments: {} }]),
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const context = new ContextManager({
      maxInputTokens: 2_000,
      keepRecentPrompts: 1,
      // High enough that trimming cannot help, so the second run has to reach
      // for the summary instead.
      maxToolResultTokens: 10_000,
      summarise: async () => "Earlier: read a.ts.",
    });
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 5,
      llm,
      tools: [bulkyTool()],
      workspace,
      streaming: false,
      context,
    });

    const first = await agent.run("First question");
    await agent.run("Second question", { history: first.messages });

    expect(
      llm.requests.at(-1)?.messages.some((message) =>
        message.role === "user" ? message.content.includes(SUMMARY_MARKER) : false,
      ),
    ).toBe(true);
  });

  it("keeps the Provider continuation while no compaction happens", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "read_file", arguments: {} }], {
        provider: "fake",
        token: "first",
      }),
      assistant("Done.", [], { provider: "fake", token: "second" }),
    ]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 5,
      llm,
      tools: [bulkyTool()],
      workspace,
      streaming: false,
      context: new ContextManager({ maxInputTokens: 100_000 }),
    });

    await agent.run("Question");

    expect(llm.requests[1]?.continuation).toEqual({
      provider: "fake",
      token: "first",
    });
  });

  it("drops the Provider continuation after compacting", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "read_file", arguments: {} }], {
        provider: "fake",
        token: "first",
      }),
      assistant("Done.", [], { provider: "fake", token: "second" }),
    ]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 5,
      llm,
      tools: [bulkyTool()],
      workspace,
      streaming: false,
      context: new ContextManager({
        maxInputTokens: 2_000,
        maxToolResultTokens: 50,
        summarise: async () => "Summary.",
      }),
    });

    await agent.run("Question");

    // The Provider's own copy of the history no longer matches the compacted
    // transcript, so the next request must be rebuilt from scratch.
    expect(llm.requests[1]?.continuation).toBeUndefined();
  });

  it("leaves the transcript alone while it fits", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([assistant("Done.")]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 5,
      llm,
      tools: [],
      workspace,
      streaming: false,
      onEvent: (event) => events.push(event),
      context: new ContextManager({ maxInputTokens: 100_000 }),
    });

    await agent.run("Question");

    expect(events.some((event) => event.type.startsWith("compaction"))).toBe(
      false,
    );
  });

  it("adds up Provider-reported usage across turns", async () => {
    const llm = new FakeLLMClient([
      usage(
        assistant("", [{ id: "call-1", name: "read_file", arguments: {} }]),
        100,
        10,
      ),
      usage(assistant("Done."), 250, 20),
    ]);
    const agent = new Agent({
      systemPrompt: "System prompt",
      maxTurns: 5,
      llm,
      tools: [bulkyTool()],
      workspace,
      streaming: false,
    });

    const result = await agent.run("Question");

    expect(result.usage).toEqual({ inputTokens: 350, outputTokens: 30 });
  });
});

describe("session context surface", () => {
  function createSession(maxInputTokens = 2_000): AgentSession {
    return new AgentSession({
      agent: {
        systemPrompt: "System prompt",
        maxTurns: 5,
        llm: new FakeLLMClient([
          usage(assistant("Answer."), 120, 8),
          usage(assistant("Answer again."), 130, 9),
        ]),
        tools: [bulkyTool()],
        workspace,
        streaming: false,
        context: new ContextManager({
          maxInputTokens,
          keepRecentPrompts: 1,
          summarise: async () => "Summary.",
        }),
      },
      id: "session-under-test",
      cwd: "/workspace",
    });
  }

  it("reports context status and accumulated usage", async () => {
    const session = createSession();

    await session.prompt("First question");
    await session.prompt("Second question");

    expect(session.usage).toEqual({ inputTokens: 250, outputTokens: 17 });
    const status = session.contextStatus();
    expect(status?.maxInputTokens).toBe(2_000);
    expect(status?.estimatedTokens).toBeGreaterThan(0);
  });

  it("has no context status when no budget is configured", () => {
    const session = new AgentSession({
      agent: {
        systemPrompt: "System prompt",
        maxTurns: 5,
        llm: new FakeLLMClient([assistant("Answer.")]),
        tools: [],
        workspace,
        streaming: false,
      },
      cwd: "/workspace",
    });

    expect(session.contextStatus()).toBeUndefined();
  });

  it("compacts on demand and emits the events", async () => {
    const session = createSession(100_000);
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.prompt("First question");
    await session.prompt("Second question");
    const compacted = await session.compact();

    expect(compacted?.summarisedMessages).toBeGreaterThan(0);
    expect(session.messages[0]?.content).toContain(SUMMARY_MARKER);
    expect(
      events.filter((event) => event.type === "compaction_start"),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("compaction_end");
  });

  it("returns nothing from /compact when there is no budget", async () => {
    const session = new AgentSession({
      agent: {
        systemPrompt: "System prompt",
        maxTurns: 5,
        llm: new FakeLLMClient([assistant("Answer.")]),
        tools: [],
        workspace,
        streaming: false,
      },
      cwd: "/workspace",
    });

    await expect(session.compact()).resolves.toBeUndefined();
  });
});

describe("REPL context commands", () => {
  function session(): AgentSession {
    return new AgentSession({
      agent: {
        systemPrompt: "System prompt",
        maxTurns: 5,
        llm: new FakeLLMClient([assistant("Answer.")]),
        tools: [],
        workspace,
        streaming: false,
        context: new ContextManager({ maxInputTokens: 50_000 }),
      },
      id: "session-under-test",
      cwd: "/workspace",
    });
  }

  it("shows the context budget and token totals", () => {
    let output = "";
    const outcome = handleSlashCommand("/context", {
      session: session(),
      write: (text) => (output += text),
    });

    expect(outcome).toBe("handled");
    expect(output).toContain("50.0k");
    expect(output).toContain("40.0k");
    expect(output).toContain("usage:");
  });

  it("says so when no budget is configured", () => {
    let output = "";
    handleSlashCommand("/context", {
      session: new AgentSession({
        agent: {
          systemPrompt: "System prompt",
          maxTurns: 5,
          llm: new FakeLLMClient([assistant("Answer.")]),
          tools: [],
          workspace,
          streaming: false,
        },
        cwd: "/workspace",
      }),
      write: (text) => (output += text),
    });

    expect(output).toContain("no budget configured");
  });

  it("defers /compact to the loop instead of handling it inline", () => {
    const outcome = handleSlashCommand("/compact", {
      session: session(),
      write: () => {},
    });

    expect(outcome).toBe("compact");
  });

  it("documents both commands in /help", () => {
    let output = "";
    handleSlashCommand("/help", { session: session(), write: (t) => (output += t) });

    expect(output).toContain("/context");
    expect(output).toContain("/compact");
  });
});

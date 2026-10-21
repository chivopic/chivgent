import { describe, expect, it, vi } from "vitest";
import type { Message } from "../src/messages.js";
import { HeuristicTokenEstimator } from "../src/context/token-estimator.js";
import {
  Compactor,
  CompactionResultError,
  estimateCompactionRequestTokens,
  parseSummary,
  renderCompactionState,
  type CompactionState,
} from "../src/context/compaction.js";
import {
  ContextManager,
  findSplitIndex,
  type AppliedCompaction,
} from "../src/context/context-manager.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../src/llm.js";
import type { AgentEvent } from "../src/events.js";
import { Agent } from "../src/agent.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";

function user(content: string): Message {
  return { role: "user", content };
}

function assistantWithCall(name: string, filePath: string, id: string): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: { path: filePath } }],
  };
}

function toolResult(id: string, name: string, content: string): Message {
  return {
    role: "tool",
    toolCallId: id,
    toolName: name,
    content,
    isError: false,
  };
}

/** Returns a fixed summary and counts how often it was asked for one. */
function summarisingClient(content: string): LLMClient & { calls: number } {
  const client = {
    calls: 0,
    async complete(): Promise<LLMResponse> {
      client.calls += 1;
      return { message: { role: "assistant", content, toolCalls: [] } };
    },
  };
  return client;
}

function recordingSummarisingClient(
  contents: readonly string[],
): LLMClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      return {
        message: assistant(contents[requests.length - 1] ?? "summary").message,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    },
  };
}

describe("HeuristicTokenEstimator", () => {
  it("grows with content length", () => {
    const estimator = new HeuristicTokenEstimator();

    expect(estimator.estimateMessage(user("x".repeat(400)))).toBeGreaterThan(
      estimator.estimateMessage(user("x".repeat(40))),
    );
  });

  it("counts tool call arguments, not just prose", () => {
    const estimator = new HeuristicTokenEstimator();
    const bare: Message = { role: "assistant", content: "", toolCalls: [] };

    expect(
      estimator.estimateMessage(assistantWithCall("read_file", "src/a.ts", "1")),
    ).toBeGreaterThan(estimator.estimateMessage(bare));
  });

  it("rejects a nonsensical ratio", () => {
    expect(() => new HeuristicTokenEstimator(0)).toThrow(TypeError);
  });
});

describe("findSplitIndex", () => {
  const estimator = new HeuristicTokenEstimator();

  it("never splits a tool result away from its call", () => {
    const messages: Message[] = [
      user("first"),
      assistantWithCall("read_file", "a.ts", "1"),
      toolResult("1", "read_file", "x".repeat(4000)),
      user("second"),
    ];

    // A budget that lands mid-group must move forward past the whole group.
    for (let keep = 1; keep < 3000; keep += 137) {
      const index = findSplitIndex(messages, estimator, keep);
      expect(messages[index]?.role).not.toBe("tool");
    }
  });

  it("keeps at least one message after the summary", () => {
    const messages: Message[] = [user("a"), user("b"), user("c")];

    expect(findSplitIndex(messages, estimator, 1)).toBe(messages.length - 1);
  });

  it("drops nothing when everything fits", () => {
    const messages: Message[] = [user("a"), user("b")];

    expect(findSplitIndex(messages, estimator, 10_000)).toBe(0);
  });

  it("advances past ordinary trailing messages when choosing a recent tail", () => {
    const messages: Message[] = [user("old"), user("active")];

    expect(findSplitIndex(messages, estimator, 1)).toBe(1);
  });
});

describe("ContextManager", () => {
  it("rejects an empty automatic summary and retains its Provider usage", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const client = {
      async complete(): Promise<LLMResponse> {
        return { message: { role: "assistant", content: " \n ", toolCalls: [] }, usage };
      },
    };
    const manager = new ContextManager({
      contextWindow: 5_000, reserveTokens: 100, keepRecentTokens: 100,
      compactor: new Compactor(client),
    });

    await expect(manager.build([user("old".repeat(1_000)), user("continue")], { fixedMessages: [user("f".repeat(18_000))] }))
      .rejects.toMatchObject({
        name: "ContextCompactionError",
        compactionUsage: usage,
        compactionUsageComplete: true,
      });
  });

  it("rejects an automatic summary returned after cancellation and keeps its usage", async () => {
    const controller = new AbortController();
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const client = {
      async complete(): Promise<LLMResponse> {
        controller.abort();
        return { message: { role: "assistant", content: "valid summary", toolCalls: [] }, usage };
      },
    };
    const manager = new ContextManager({
      contextWindow: 5_000, reserveTokens: 100, keepRecentTokens: 100,
      compactor: new Compactor(client),
    });

    await expect(manager.build([user("old".repeat(1_000)), user("continue")], { fixedMessages: [user("f".repeat(18_000))], signal: controller.signal }))
      .rejects.toMatchObject({
        name: "ContextCompactionError",
        compactionUsage: usage,
        compactionUsageComplete: true,
      });
  });

  it("counts a rejected automatic summary in the Agent run without installing it", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const llm = new FakeLLMClient([]);
    let endEvent: Extract<AgentEvent, { type: "agent_end" }> | undefined;
    const agentWorkspace: Workspace = {
      root: "/workspace", ...readOnlyWorkspaceWrites,
      async readTextFile() { return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false }; },
      async listFiles() { return { entries: [], truncated: false }; },
      async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
    };
    const agent = new Agent({
      systemPrompt: "t".repeat(18_000), maxTurns: 2, llm, tools: [], workspace: agentWorkspace,
      onEvent: (event) => { if (event.type === "agent_end") endEvent = event; },
      contextManager: new ContextManager({
        contextWindow: 5_000, reserveTokens: 100, keepRecentTokens: 100,
        compactor: new Compactor({
          async complete(): Promise<LLMResponse> {
            return { message: { role: "assistant", content: "  ", toolCalls: [] }, usage };
          },
        }),
      }),
    });

    await expect(agent.run("continue", {
      history: [user("old".repeat(5_000)), { role: "assistant", content: "older answer", toolCalls: [] }],
    })).rejects.toThrow(/empty/i);

    expect(endEvent?.usage).toEqual({ usage, complete: true });
    expect(endEvent?.compaction).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
  });

  it("keeps an automatic checkpoint and accounts for usage when pending tasks overflow", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const previous: AppliedCompaction = {
      state: {
        summary: "previous checkpoint", readFiles: [], modifiedFiles: [], decisions: [],
        pendingTasks: Array.from({ length: 32 }, (_, index) => `old-${index}`),
      },
      splitIndex: 0,
    };
    const agentWorkspace: Workspace = {
      root: "/workspace", ...readOnlyWorkspaceWrites,
      async readTextFile() { return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false }; },
      async listFiles() { return { entries: [], truncated: false }; },
      async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
    };
    let endEvent: Extract<AgentEvent, { type: "agent_end" }> | undefined;
    // Keep the checkpoint/history summarizable; this fixed prompt makes the
    // full request exceed budget so the pending-task overflow path runs.
    const agent = new Agent({
      systemPrompt: "s".repeat(1_400), maxTurns: 2, llm: new FakeLLMClient([assistant("Must not run after overflow")]), tools: [], workspace: agentWorkspace,
      onEvent: event => { if (event.type === "agent_end") endEvent = event; },
      contextManager: new ContextManager({
        contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 100,
        compactor: new Compactor({ async complete(): Promise<LLMResponse> {
          return { ...assistant('{"summary":"candidate","pendingTasks":["new-task"]}'), usage };
        } }),
      }),
    });

    await expect(agent.run("continue", {
      history: [user("old".repeat(600)), assistant("older answer").message],
      compaction: previous,
    })).rejects.toThrow(/pending/i);

    expect(endEvent?.compaction).toEqual(previous);
    expect(endEvent?.usage?.usage).toEqual(usage);
    expect(endEvent?.usage?.complete).toBe(true);
  });

  it("does not install a completed automatic candidate if cancellation arrives before Agent commits it", async () => {
    const controller = new AbortController();
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const llm = new FakeLLMClient([]);
    let endEvent: Extract<AgentEvent, { type: "agent_end" }> | undefined;
    const agentWorkspace: Workspace = {
      root: "/workspace", ...readOnlyWorkspaceWrites,
      async readTextFile() { return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false }; },
      async listFiles() { return { entries: [], truncated: false }; },
      async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
    };
    const agent = new Agent({
      systemPrompt: "t".repeat(18_000), maxTurns: 2, llm, tools: [], workspace: agentWorkspace,
      onEvent: (event) => { if (event.type === "agent_end") endEvent = event; },
      contextManager: new ContextManager({
        contextWindow: 5_000, reserveTokens: 100, keepRecentTokens: 100,
        compactor: new Compactor({
          async complete(): Promise<LLMResponse> {
            return { message: { role: "assistant", content: "valid summary", toolCalls: [] }, usage };
          },
        }),
        onCompaction: () => controller.abort(),
      }),
    });

    const result = await agent.run("continue", {
      history: [user("old".repeat(5_000)), { role: "assistant", content: "older answer", toolCalls: [] }],
      signal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    expect(endEvent?.compaction).toBeUndefined();
    expect(endEvent?.usage).toEqual({ usage, complete: true });
    expect(llm.requests).toHaveLength(0);
  });

  it("rejects an empty manual summary without replacing the previous checkpoint", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const manager = new ContextManager({
      compactor: new Compactor({
        async complete(): Promise<LLMResponse> {
          return { message: { role: "assistant", content: "\t ", toolCalls: [] }, usage };
        },
      }),
    });
    const previous: AppliedCompaction = {
      state: { summary: "keep this checkpoint", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: [] },
      splitIndex: 0,
    };

    await expect(manager.compactHistory([user("old"), user("new")], previous))
      .rejects.toMatchObject({
        name: "ContextCompactionError",
        compactionUsage: usage,
        compactionUsageComplete: true,
      });
    expect(previous.state.summary).toBe("keep this checkpoint");
  });

  it("keeps usage when a manual candidate exceeds the context budget", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const manager = new ContextManager({
      contextWindow: 600, reserveTokens: 100,
      compactor: new Compactor({
        async complete(): Promise<LLMResponse> {
          return { message: { role: "assistant", content: '{"summary":"' + "x".repeat(2_000) + '"}', toolCalls: [] }, usage };
        },
      }),
    });

    await expect(manager.compactHistory([user("old".repeat(60)), user("new")]))
      .rejects.toMatchObject({
        name: "ContextBudgetError",
        compactionUsage: usage,
        compactionUsageComplete: true,
      });
  });

  it("refuses the first automatic summary request when its system prompt and rendered history exceed the budget", async () => {
    const client = recordingSummarisingClient(['{"summary":"replacement"}']);
    const manager = new ContextManager({
      contextWindow: 2_700, reserveTokens: 500, keepRecentTokens: 1_105,
      estimator: new HeuristicTokenEstimator(1),
      compactor: new Compactor(client),
    });
    const messages: Message[] = [
      user("o".repeat(1_600)),
      user("m".repeat(200)),
      user("r".repeat(1_000)),
    ];

    await expect(manager.build(messages)).rejects.toMatchObject({
      name: "ContextBudgetError",
      message: expect.stringMatching(/summary request.*exceeding.*context budget/i),
    });
    expect(client.requests).toHaveLength(0);
  });

  it("includes a previous summary in an automatic repeated-compaction request", async () => {
    const client = recordingSummarisingClient(['{"summary":"replacement"}']);
    const manager = new ContextManager({
      contextWindow: 2_500, reserveTokens: 500, keepRecentTokens: 1_105,
      estimator: new HeuristicTokenEstimator(1),
      compactor: new Compactor(client),
    });
    const previous: AppliedCompaction = {
      state: {
        summary: "prior summary ".repeat(80),
        readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: [],
      },
      splitIndex: 1,
    };

    await expect(manager.build([
      user("original history"), user("m".repeat(200)), user("r".repeat(1_000)),
    ], { previous })).rejects.toMatchObject({ name: "ContextBudgetError" });
    expect(client.requests).toHaveLength(0);
  });

  it("still compacts a near-window request when the actual summary request fits", async () => {
    const client = recordingSummarisingClient(['{"summary":"earlier work"}']);
    const manager = new ContextManager({
      contextWindow: 2_600, reserveTokens: 500, keepRecentTokens: 1_105,
      estimator: new HeuristicTokenEstimator(1),
      compactor: new Compactor(client),
    });

    const context = await manager.build([
      user("o".repeat(1_100)),
      user("n".repeat(1_100)),
    ]);

    expect(context.compacted).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.systemPrompt).toContain("compacting an engineering conversation");
    expect(client.requests[0]?.messages[0]?.content).toContain(`user: ${"o".repeat(1_100)}`);
  });

  it("allows a summary request at the exact budget and refuses one estimated token over", async () => {
    const estimator = new HeuristicTokenEstimator(1);
    const exactInput = [user("old")];
    const exactBudget = estimateCompactionRequestTokens(exactInput, estimator);
    const allowedClient = recordingSummarisingClient(['{"summary":"done"}']);
    const allowed = new ContextManager({
      contextWindow: exactBudget + 1,
      reserveTokens: 1,
      estimator,
      compactor: new Compactor(allowedClient),
    });

    await expect(allowed.compactHistory([...exactInput, user("current")])).resolves.toMatchObject({ compacted: true });
    expect(allowedClient.requests).toHaveLength(1);

    const overClient = recordingSummarisingClient(['{"summary":"must not be requested"}']);
    const over = new ContextManager({
      contextWindow: exactBudget + 1,
      reserveTokens: 1,
      estimator,
      compactor: new Compactor(overClient),
    });

    await expect(over.compactHistory([user("old!"), user("current")])).rejects.toMatchObject({
      name: "ContextBudgetError",
      message: expect.stringMatching(/exceeding the available context budget/i),
    });
    expect(overClient.requests).toHaveLength(0);
  });

  it("checks each automatic summary pass before sending it", async () => {
    const client = recordingSummarisingClient([
      `{"summary":"${"s".repeat(650)}"}`,
      '{"summary":"second pass"}',
    ]);
    const manager = new ContextManager({
      contextWindow: 2_750, reserveTokens: 500, keepRecentTokens: 2_010,
      estimator: new HeuristicTokenEstimator(1),
      compactor: new Compactor(client),
    });
    const messages = Array.from({ length: 5 }, () => user("h".repeat(600)));

    await expect(manager.build(messages)).rejects.toMatchObject({
      name: "ContextBudgetError",
      compactionUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      compactionUsageComplete: true,
    });
    expect(client.requests).toHaveLength(1);
  });

  it("checks manual first and repeated compaction requests against the same budget", async () => {
    const client = recordingSummarisingClient([
      '{"summary":"first"}',
      '{"summary":"second"}',
    ]);
    const manager = new ContextManager({
      contextWindow: 2_500, reserveTokens: 500, keepRecentTokens: 1_105,
      estimator: new HeuristicTokenEstimator(1),
      compactor: new Compactor(client),
    });
    const previous: AppliedCompaction = {
      state: {
        summary: "previous summary ".repeat(80),
        readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: [],
      },
      splitIndex: 1,
    };

    await expect(manager.compactHistory([
      user("o".repeat(1_600)), user("m".repeat(200)), user("r".repeat(1_000)),
    ])).rejects.toMatchObject({ name: "ContextBudgetError" });
    expect(client.requests).toHaveLength(0);

    await expect(manager.compactHistory([
      user("original"), user("m".repeat(200)), user("r".repeat(1_000)),
    ], previous)).rejects.toMatchObject({ name: "ContextBudgetError" });
    expect(client.requests).toHaveLength(0);
  });

  it("keeps the active prompt and complete recent tool pairs while compacting a long run", async () => {
    const client = summarisingClient('{"summary":"earlier tool work"}');
    const manager = new ContextManager({
      contextWindow: 1_400, reserveTokens: 100, keepRecentTokens: 600,
      compactor: new Compactor(client),
    });
    const messages: Message[] = [user("Keep this instruction")];
    for (let index = 0; index < 30; index += 1) {
      messages.push(assistantWithCall("read_file", `f${index}.ts`, `call-${index}`));
      messages.push({ role: "tool", toolCallId: `call-${index}`, toolName: "read_file", content: `result ${index} ${"x".repeat(120)}`, isError: false });
    }
    const first = await manager.build(messages);
    expect(first.compacted).toBe(true);
    expect(first.compaction?.anchorIndex).toBe(0);
    expect(first.messages[0]).toEqual(user("Keep this instruction"));
    expect(first.messages[1]?.content).toContain("earlier tool work");
    for (let index = 2; index < first.messages.length; index += 1) {
      const current = first.messages[index];
      if (current?.role === "assistant" && current.toolCalls.length > 0) {
        expect(first.messages[index + 1]).toMatchObject({ role: "tool", toolCallId: current.toolCalls[0]?.id });
      }
      if (current?.role === "tool") {
        expect(first.messages[index - 1]).toMatchObject({ role: "assistant" });
      }
    }
    for (let index = 30; index < 45; index += 1) {
      messages.push(assistantWithCall("read_file", `f${index}.ts`, `call-${index}`));
      messages.push({ role: "tool", toolCallId: `call-${index}`, toolName: "read_file", content: `result ${index} ${"y".repeat(120)}`, isError: false });
    }
    const second = await manager.build(messages, { previous: first.compaction });
    expect(second.compacted).toBe(true);
    expect(second.compaction?.anchorIndex).toBe(0);
    expect(second.messages[0]).toEqual(user("Keep this instruction"));
    const resumed = await manager.build(messages, { previous: second.compaction });
    expect(resumed.compacted).toBe(false);
    expect(resumed.messages).toEqual(second.messages);
    expect(client.calls).toBe(2);
  });

  const long = "x".repeat(8_000);

  it("passes the transcript through when it fits", async () => {
    const manager = new ContextManager({
      contextWindow: 10_000,
      compactor: new Compactor(summarisingClient("{}")),
    });
    const messages = [user("short")];

    const context = await manager.build(messages);

    expect(context.compacted).toBe(false);
    expect(context.messages).toEqual(messages);
  });

  it("reports an over-budget request when compaction is disabled", async () => {
    const manager = new ContextManager({ contextWindow: 1_000 });
    const messages = [user(long), user(long)];

    await expect(manager.build(messages)).rejects.toThrow(/compaction is disabled/);
  });

  it("replaces old history with a summary once over budget", async () => {
    const client = summarisingClient(
      '{"summary":"did the thing","decisions":["keep paths relative"],"pendingTasks":["add tests"]}',
    );
    const manager = new ContextManager({
      contextWindow: 1_150,
      reserveTokens: 500,
      keepRecentTokens: 250,
      compactor: new Compactor(client),
    });
    const messages = [user("x".repeat(1_300)), user("older"), user("m".repeat(950)), user("most recent")];

    // Fixed request context makes the full input exceed budget while leaving
    // the actual summary request within the same limit.
    const context = await manager.build(messages, { fixedMessages: [user("f".repeat(1_000))] });

    expect(context.compacted).toBe(true);
    expect(context.messages.length).toBeLessThan(messages.length);
    expect(context.messages[0]?.content).toContain("did the thing");
    expect(context.messages[0]?.content).toContain("keep paths relative");
    expect(context.messages.at(-1)).toEqual(user("most recent"));
    expect(context.estimatedTokens).toBeLessThan(2_000);
  });

  it("reuses an existing summary instead of summarising again", async () => {
    const client = summarisingClient('{"summary":"first pass"}');
    const manager = new ContextManager({
      contextWindow: 1_150,
      reserveTokens: 500,
      keepRecentTokens: 250,
      compactor: new Compactor(client),
    });
    const messages = [user("x".repeat(1_300)), user("older"), user("m".repeat(950)), user("recent")];
    // Reuse the same fixed request context so only the first build compacts.
    const fixedMessages = [user("f".repeat(1_000))];

    const first = await manager.build(messages, { fixedMessages });
    expect(client.calls).toBe(1);

    const second = await manager.build([...messages, user("newer")], {
      ...(first.compaction === undefined ? {} : { previous: first.compaction }),
      fixedMessages,
    });

    expect(client.calls).toBe(1);
    expect(second.compacted).toBe(false);
    expect(second.messages[0]?.content).toContain("first pass");
    expect(second.messages.at(-1)).toEqual(user("newer"));
  });

  it("budgets static repository instruction messages before compacting", async () => {
    const client = summarisingClient('{"summary":"scoped"}');
    const manager = new ContextManager({
      contextWindow: 2_000, reserveTokens: 500, keepRecentTokens: 250,
      compactor: new Compactor(client),
    });
    const messages = [user("x".repeat(1_000)), user("recent")];
    const without = await manager.build(messages);
    expect(without.compacted).toBe(false);
    const guidance = [user("guide".repeat(2_000))];
    await expect(manager.build(messages, { prefixMessages: guidance })).rejects.toThrow(/System prompt and tool definitions/);
    const roomy = new ContextManager({ contextWindow: 3_200, reserveTokens: 500, keepRecentTokens: 250, compactor: new Compactor(client) });
    const withGuidance = await roomy.build(messages, { prefixMessages: guidance });
    expect(withGuidance.compacted).toBe(true);
    expect(client.calls).toBe(1);
  });

  it("counts large tool schemas as fixed request context", async () => {
    const manager = new ContextManager({ contextWindow: 1_000, reserveTokens: 200 });
    await expect(manager.build([user("short")], {
      fixedMessages: [user(JSON.stringify({ inputSchema: "x".repeat(5_000) }))],
    })).rejects.toThrow(/System prompt and tool definitions/);
  });

  it("never summarizes the active user request to handle an oversized context", async () => {
    const manager = new ContextManager({
      contextWindow: 1_000, reserveTokens: 200,
      compactor: new Compactor(summarisingClient('{"summary":"must not replace active prompt"}')),
    });
    await expect(manager.build([user("active".repeat(2_000))])).rejects.toThrow(/no safely removable history/);
  });

  it("compacts older history when the split lands immediately after the active user", async () => {
    const client = summarisingClient('{"summary":"older history"}');
    const manager = new ContextManager({
      contextWindow: 1_000,
      reserveTokens: 100,
      keepRecentTokens: 200,
      compactor: new Compactor(client),
    });

    const messages: Message[] = [
      user("o".repeat(2_400)),
      { role: "assistant", content: "old answer", toolCalls: [] },
      user("n".repeat(600)),
      assistantWithCall("read_file", "a", "c"),
      toolResult("c", "read_file", "r".repeat(600)),
    ];

    const context = await manager.build(messages);

    expect(context.compacted).toBe(true);
    expect(context.compaction?.splitIndex).toBe(3);
    expect(context.compaction?.anchorIndex).toBe(2);
    expect(context.messages[0]).toEqual(messages[2]);
    expect(context.messages[1]?.content).toContain("older history");
    expect(context.messages[2]).toEqual(messages[3]);
    expect(context.messages[3]).toEqual(messages[4]);
  });

  it("shrinks the retained tail when fixed request context consumes the budget", async () => {
    const client = summarisingClient('{"summary":"old history"}');
    const manager = new ContextManager({
      contextWindow: 1_100,
      reserveTokens: 100,
      keepRecentTokens: 400,
      compactor: new Compactor(client),
    });

    const messages: Message[] = [
      user("x".repeat(2_000)),
      { role: "assistant", content: "a".repeat(700), toolCalls: [] },
      user("older"),
      { role: "assistant", content: "b".repeat(700), toolCalls: [] },
      user("continue"),
    ];

    const context = await manager.build(messages, {
      fixedMessages: [user("schema".repeat(440))],
    });

    expect(context.compacted).toBe(true);
    expect(context.messages.at(-1)).toEqual(messages[4]);
    expect(context.messages.some((message) => message.content.includes("old history"))).toBe(true);
    expect(context.estimatedTokens).toBeLessThanOrEqual(1_000);
    expect(client.calls).toBe(2);
  });

  it("does not split an active tool exchange when the exchange cannot fit", async () => {
    const client = summarisingClient('{"summary":"should not run"}');
    const manager = new ContextManager({
      contextWindow: 2_000,
      reserveTokens: 400,
      keepRecentTokens: 200,
      compactor: new Compactor(client),
    });
    const messages: Message[] = [
      user("please read a.ts"),
      assistantWithCall("read_file", "a.ts", "1"),
      toolResult("1", "read_file", "x".repeat(20_000)),
    ];

    await expect(manager.build(messages)).rejects.toThrow(/no safely removable history/);
    expect(client.calls).toBe(0);
  });

  it("carries an existing summary forward across an anchor-only cut", async () => {
    const client = summarisingClient('{"summary":"new summary"}');
    const manager = new ContextManager({
      contextWindow: 480,
      reserveTokens: 10,
      keepRecentTokens: 35,
      compactor: new Compactor(client),
    });
    const messages: Message[] = [
      user("old transcript"),
      user("active"),
      { role: "assistant", content: "suffix".repeat(8), toolCalls: [] },
    ];
    const previous: AppliedCompaction = {
      state: {
        summary: "old history ".repeat(24),
        readFiles: [],
        modifiedFiles: [],
        decisions: [],
        pendingTasks: [],
      },
      splitIndex: 2,
      anchorIndex: 1,
    };

    // The prior checkpoint summary fits the summary-call budget; fixed request
    // context forces the anchor-only replacement path to run.
    const context = await manager.build(messages, {
      previous,
      fixedMessages: [user("f".repeat(1_600))],
    });

    expect(context.compacted).toBe(true);
    expect(context.messages[0]).toEqual(messages[1]);
    expect(context.messages[1]?.content).toContain("new summary");
    expect(context.messages[1]?.content).not.toContain("old history");
    expect(context.messages[2]).toEqual(messages[2]);
    expect(context.compaction?.splitIndex).toBe(2);
    expect(context.compaction?.anchorIndex).toBe(1);
  });

  it("preserves first summary usage when the bounded retry fails", async () => {
    const failedRetry = new Error("retry unavailable");
    let calls = 0;
    const compactor = {
      async compact() {
        calls += 1;
        if (calls === 2) throw failedRetry;
        return {
          state: { summary: "first summary", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: [] },
          usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        };
      },
    } as unknown as Compactor;
    const manager = new ContextManager({
      contextWindow: 1_100, reserveTokens: 100, keepRecentTokens: 400, compactor,
    });
    const messages: Message[] = [
      user("x".repeat(2_000)), user("a".repeat(700)), user("older"),
      { role: "assistant", content: "b".repeat(700), toolCalls: [] }, user("continue"),
    ];

    await expect(manager.build(messages, { fixedMessages: [user("schema".repeat(440))] }))
      .rejects.toMatchObject({
        name: "ContextCompactionError",
        compactionUsage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        compactionUsageComplete: false,
      });
    expect(calls).toBe(2);
  });

  it("adds known usage from a rejected bounded retry to the first summary", async () => {
    let calls = 0;
    const compactor = {
      async compact() {
        calls += 1;
        if (calls === 1) {
          return {
            state: { summary: "first summary", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: [] },
            usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
          };
        }
        throw new CompactionResultError("The compaction summary was empty.", {
          inputTokens: 30, outputTokens: 6, totalTokens: 36,
        });
      },
    } as unknown as Compactor;
    const manager = new ContextManager({
      contextWindow: 1_100, reserveTokens: 100, keepRecentTokens: 400, compactor,
    });
    const messages: Message[] = [
      user("x".repeat(2_000)), user("a".repeat(700)), user("older"),
      { role: "assistant", content: "b".repeat(700), toolCalls: [] }, user("continue"),
    ];

    await expect(manager.build(messages, { fixedMessages: [user("schema".repeat(460))] }))
      .rejects.toMatchObject({
        name: "ContextCompactionError",
        compactionUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        compactionUsageComplete: true,
      });
    expect(calls).toBe(2);
  });

  it("reports what it dropped", async () => {
    const events: number[] = [];
    const manager = new ContextManager({
      contextWindow: 1_150,
      reserveTokens: 500,
      keepRecentTokens: 250,
      compactor: new Compactor(summarisingClient('{"summary":"s"}')),
      onCompaction: (event) => events.push(event.droppedMessages),
    });

    await manager.build(
      [user("x".repeat(1_300)), user("older"), user("m".repeat(950)), user("recent")],
      { fixedMessages: [user("f".repeat(1_000))] },
    );

    expect(events).toEqual([2]);
  });

  it("refuses a reserve larger than the window", () => {
    expect(
      () => new ContextManager({ contextWindow: 100, reserveTokens: 100 }),
    ).toThrow(TypeError);
  });
});

describe("Compactor", () => {
  it.each(['{"summary":""}', '{"summary":"   "}'])("rejects an empty JSON summary field: %s", async (content) => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const compactor = new Compactor({
      async complete(): Promise<LLMResponse> {
        return { message: { role: "assistant", content, toolCalls: [] }, usage };
      },
    });

    await expect(compactor.compact([user("old history")])).rejects.toMatchObject({
      name: "CompactionResultError",
      usage,
      usageComplete: true,
    });
  });

  it("accepts a non-JSON prose summary", async () => {
    const compactor = new Compactor(summarisingClient("Earlier work established the required API behavior."));

    const { state } = await compactor.compact([user("old history")]);

    expect(state.summary).toBe("Earlier work established the required API behavior.");
  });

  it("derives file lists from tool calls rather than from prose", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"s"}'));
    const messages: Message[] = [
      assistantWithCall("read_file", "src/read-only.ts", "1"),
      toolResult("1", "read_file", "contents"),
      assistantWithCall("edit_file", "src/changed.ts", "2"),
      toolResult("2", "edit_file", "edited"),
    ];

    const { state } = await compactor.compact(messages);

    expect(state.readFiles).toEqual(["src/read-only.ts"]);
    expect(state.modifiedFiles).toEqual(["src/changed.ts"]);
  });

  it("counts a file it both read and changed as changed", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"s"}'));
    const messages: Message[] = [
      assistantWithCall("read_file", "src/a.ts", "1"),
      toolResult("1", "read_file", "original"),
      assistantWithCall("write_file", "src/a.ts", "2"),
      toolResult("2", "write_file", "updated"),
    ];

    const { state } = await compactor.compact(messages);

    expect(state.readFiles).toEqual([]);
    expect(state.modifiedFiles).toEqual(["src/a.ts"]);
  });
  it("does not claim a failed edit changed a file", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"attempt failed"}'));
    const messages: Message[] = [
      assistantWithCall("edit_file", "src/broken.ts", "fail"),
      { role: "tool", toolCallId: "fail", toolName: "edit_file", content: "no match", isError: true },
      assistantWithCall("read_file", "src/verified.ts", "ok"),
      toolResult("ok", "read_file", "contents"),
    ];
    const { state } = await compactor.compact(messages);
    expect(state.modifiedFiles).toEqual([]);
    expect(state.readFiles).toEqual(["src/verified.ts"]);
  });

  it("tracks changed paths from a successful multi-file apply_patch", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"patched"}'));
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [{
        id: "patch-one", name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Add File: src/a.ts\n+one\n*** Add File: src/b.ts\n+two\n*** End Patch" },
      }] },
      toolResult("patch-one", "apply_patch", "Patch applied"),
    ];
    const { state } = await compactor.compact(messages);
    expect(state.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("retains decisions and pending work until completion is explicit", async () => {
    const previous: CompactionState = {
      summary: "past work",
      readFiles: [],
      modifiedFiles: [],
      decisions: ["Keep existing API stable"],
      pendingTasks: ["add tests", "write docs"],
    };
    const compactor = new Compactor(summarisingClient(
      '{"summary":"tests done","decisions":["avoid breaking changes"],"pendingTasks":["review CI"],"completedTasks":["add tests"]}',
    ));
    const { state } = await compactor.compact([user("Finished tests and started review")], undefined, previous);
    expect(state.decisions).toEqual(["Keep existing API stable", "avoid breaking changes"]);
    expect(state.pendingTasks).toEqual(["write docs", "review CI"]);

    const next = new Compactor(summarisingClient('{"summary":"new turn"}'));
    const { state: after } = await next.compact([user("Proceed")], undefined, state);
    expect(after.pendingTasks).toEqual(["write docs", "review CI"]);
    expect(after.decisions).toEqual(["Keep existing API stable", "avoid breaking changes"]);
  });

  it("accepts exactly 32 active pending tasks", async () => {
    const pendingTasks = Array.from({ length: 32 }, (_, index) => `task-${index}`);
    const compactor = new Compactor(summarisingClient(JSON.stringify({ summary: "bounded", pendingTasks })));

    const { state } = await compactor.compact([user("History")]);

    expect(state.pendingTasks).toEqual(pendingTasks);
  });

  it("rejects 33 distinct active tasks and keeps the completed Provider usage", async () => {
    const usage = { inputTokens: 20, outputTokens: 4, totalTokens: 24 };
    const pendingTasks = Array.from({ length: 33 }, (_, index) => `task-${index}`);
    const compactor = new Compactor({ async complete() {
      return { ...assistant(JSON.stringify({ summary: "too many", pendingTasks })), usage };
    } });

    await expect(compactor.compact([user("History")])).rejects.toMatchObject({
      name: "CompactionResultError",
      message: expect.stringMatching(/33.*32|32.*33|pending/i),
      usage,
      usageComplete: true,
    });
  });

  it("keeps missing Provider usage unknown when rejecting overflow", async () => {
    const pendingTasks = Array.from({ length: 33 }, (_, index) => `task-${index}`);
    const compactor = new Compactor({ async complete() {
      return assistant(JSON.stringify({ summary: "too many", pendingTasks }));
    } });

    await expect(compactor.compact([user("History")])).rejects.toMatchObject({
      name: "CompactionResultError",
      usage: undefined,
      usageComplete: false,
    });
  });

  it("rejects a new task beyond 32 retained tasks without changing the previous state", async () => {
    const previous: CompactionState = {
      summary: "old", readFiles: [], modifiedFiles: [], decisions: [],
      pendingTasks: Array.from({ length: 32 }, (_, index) => `old-${index}`),
    };
    const compactor = new Compactor(summarisingClient('{"summary":"new","pendingTasks":["new-task"]}'));

    await expect(compactor.compact([user("History")], undefined, previous))
      .rejects.toThrow(/pending/i);
    expect(previous.pendingTasks).toHaveLength(32);
    expect(previous.pendingTasks).not.toContain("new-task");
  });

  it("does not reject duplicate tasks at the 32-task boundary", async () => {
    const tasks = Array.from({ length: 32 }, (_, index) => `task-${index}`);
    const previous: CompactionState = {
      summary: "old", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: tasks,
    };
    const compactor = new Compactor(summarisingClient('{"summary":"new","pendingTasks":["task-0","task-0"]}'));

    const { state } = await compactor.compact([user("History")], undefined, previous);

    expect(state.pendingTasks).toEqual(tasks);
  });

  it("applies explicit completions before enforcing the pending-task limit", async () => {
    const tasks = Array.from({ length: 32 }, (_, index) => `task-${index}`);
    const previous: CompactionState = {
      summary: "old", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: tasks,
    };
    const compactor = new Compactor(summarisingClient(
      '{"summary":"new","pendingTasks":["new-task"],"completedTasks":["task-0"]}',
    ));

    const { state } = await compactor.compact([user("History")], undefined, previous);

    expect(state.pendingTasks).toHaveLength(32);
    expect(state.pendingTasks).not.toContain("task-0");
    expect(state.pendingTasks).toContain("new-task");
  });

  it("does not truncate completion evidence before enforcing the pending-task limit", async () => {
    const tasks = Array.from({ length: 32 }, (_, index) => `task-${index}`);
    const previous: CompactionState = {
      summary: "old", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: tasks,
    };
    const completedTasks = [
      ...Array.from({ length: 32 }, (_, index) => `unrelated-${index}`),
      "task-0",
    ];
    const compactor = new Compactor(summarisingClient(JSON.stringify({
      summary: "new", pendingTasks: ["new-task"], completedTasks,
    })));

    const { state } = await compactor.compact([user("History")], undefined, previous);

    expect(state.pendingTasks).toHaveLength(32);
    expect(state.pendingTasks).not.toContain("task-0");
    expect(state.pendingTasks).toContain("new-task");
  });

  it("checks beyond redundant leading tasks instead of truncating the candidate", async () => {
    const tasks = Array.from({ length: 32 }, (_, index) => `task-${index}`);
    const previous: CompactionState = {
      summary: "old", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: tasks,
    };
    const repeated = Array.from({ length: 33 }, () => "task-0");
    repeated.push("late-active-task");
    const compactor = new Compactor(summarisingClient(
      JSON.stringify({ summary: "new", pendingTasks: repeated }),
    ));

    await expect(compactor.compact([user("History")], undefined, previous))
      .rejects.toThrow(/pending/i);
  });

  it("replaces only explicitly superseded decisions by exact match and preserves later decisions", async () => {
    const previous: CompactionState = {
      summary: "Prior API direction",
      readFiles: [],
      modifiedFiles: [],
      decisions: ["Use API v1", "Keep the public API stable", "Use API v1 with cache"],
      pendingTasks: [],
    };
    const replacement = new Compactor(summarisingClient(
      '{"summary":"API v2 selected","decisions":["Use API v2"],"supersededDecisions":["Use API v1","Use API v1 "],"pendingTasks":[]}',
    ));

    const first = await replacement.compact([user("The user explicitly replaced the API version")], undefined, previous);
    expect(first.state.decisions).toEqual([
      "Keep the public API stable",
      "Use API v1 with cache",
      "Use API v2",
    ]);

    const noReplacementListed = new Compactor(summarisingClient(
      '{"summary":"More work","decisions":[],"pendingTasks":[]}',
    ));
    const second = await noReplacementListed.compact([user("Continue")], undefined, first.state);
    expect(second.state.decisions).toEqual(first.state.decisions);

    const unmatched = new Compactor(summarisingClient(
      '{"summary":"Related wording","decisions":[],"supersededDecisions":["use api v1"],"pendingTasks":[]}',
    ));
    const unmatchedState = await unmatched.compact([user("A related phrase")], undefined, previous);
    expect(unmatchedState.state.decisions).toEqual(previous.decisions);

    const readded = new Compactor(summarisingClient(
      '{"summary":"The same choice was made again","decisions":["Use API v1"],"supersededDecisions":["Use API v1"],"pendingTasks":[]}',
    ));
    const readdedState = await readded.compact([user("The user chose API v1 again")], undefined, previous);
    expect(readdedState.state.decisions).toEqual([
      "Keep the public API stable",
      "Use API v1 with cache",
      "Use API v1",
    ]);
  });

  it("retains verified file facts across repeated compactions", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"new summary"}'));
    const previous: CompactionState = {
      summary: "previous",
      readFiles: ["src/old-read.ts"],
      modifiedFiles: ["src/old-edit.ts"],
      decisions: [],
      pendingTasks: [],
    };
    const { state } = await compactor.compact([
      assistantWithCall("read_file", "src/new.ts", "new"),
      toolResult("new", "read_file", "contents"),
    ], undefined, previous);
    expect(state.readFiles).toEqual(["src/new.ts", "src/old-read.ts"]);
    expect(state.modifiedFiles).toEqual(["src/old-edit.ts"]);
  });

});

describe("parseSummary", () => {
  it("reads the documented JSON shape", () => {
    expect(
      parseSummary('{"summary":"s","decisions":["d"],"pendingTasks":["p"]}'),
    ).toEqual({ summary: "s", decisions: ["d"], pendingTasks: ["p"] });
  });

  it("parses explicit superseded decision strings and ignores non-strings", () => {
    expect(parseSummary(
      '{"summary":"s","decisions":["new"],"supersededDecisions":["old",4,null],"pendingTasks":[]}',
    )).toEqual({
      summary: "s",
      decisions: ["new"],
      supersededDecisions: ["old"],
      pendingTasks: [],
    });
  });

  it("bounds superseded-decision evidence to 32 entries", () => {
    const decisions = Array.from({ length: 40 }, (_, index) => `decision-${index}`);
    const parsed = parseSummary(JSON.stringify({ summary: "s", supersededDecisions: decisions }));

    expect(parsed.supersededDecisions).toEqual(decisions.slice(0, 32));
  });

  it("preserves the 32-entry decision parse boundary", () => {
    const decisions = Array.from({ length: 40 }, (_, index) => `decision-${index}`);
    const supersededDecisions = Array.from({ length: 40 }, (_, index) => `old-${index}`);
    const parsed = parseSummary(JSON.stringify({ summary: "s", decisions, supersededDecisions }));

    expect(parsed.decisions).toEqual(decisions.slice(0, 32));
    expect(parsed.supersededDecisions).toEqual(supersededDecisions.slice(0, 32));
  });

  it("tolerates prose around the JSON", () => {
    expect(parseSummary('Sure!\n{"summary":"s"}\nHope that helps.')).toMatchObject(
      { summary: "s" },
    );
  });

  it("falls back to the raw text when there is no JSON", () => {
    expect(parseSummary("just a paragraph")).toEqual({
      summary: "just a paragraph",
      decisions: [],
      pendingTasks: [],
    });
  });

  it("ignores non-string list entries", () => {
    expect(parseSummary('{"summary":"s","decisions":[1,"keep",null]}')).toMatchObject(
      { decisions: ["keep"] },
    );
  });

  it("preserves an explicitly empty JSON summary for rejection by the compactor", () => {
    expect(parseSummary('{"summary":"   "}').summary).toBe("");
    expect(parseSummary('{"other":"value"}').summary).toBe('{"other":"value"}');
  });
});

describe("renderCompactionState", () => {
  it("omits sections that have nothing in them", () => {
    const state: CompactionState = {
      summary: "only a summary",
      readFiles: [],
      modifiedFiles: [],
      decisions: [],
      pendingTasks: [],
    };

    const rendered = renderCompactionState(state);

    expect(rendered).toContain("only a summary");
    expect(rendered).not.toContain("Files read");
    expect(rendered).not.toContain("Still pending");
  });
});

describe("Agent with a ContextManager", () => {
  const workspace: Workspace = {
    root: "/workspace",
    ...readOnlyWorkspaceWrites,
    async readTextFile() {
      return {
        content: "x".repeat(20_000),
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

  it("reports when an active tool exchange cannot fit without splitting it", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }], {
        provider: "fake",
      }),
      assistant("done"),
    ]);
    const manager = new ContextManager({
      contextWindow: 1_250,
      reserveTokens: 200,
      keepRecentTokens: 300,
      compactor: new Compactor(summarisingClient('{"summary":"read a.ts"}')),
    });
    const agent = new Agent({
      systemPrompt: "test",
      maxTurns: 4,
      llm,
      tools: [new ReadFileTool()],
      workspace,
      contextManager: manager,
    });

    await expect(agent.run("please read a.ts")).rejects.toThrow(/no safely removable history/);
    expect(llm.requests).toHaveLength(1);
  });

  it("keeps the continuation when nothing needed compacting", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }], {
        provider: "fake",
      }),
      assistant("done"),
    ]);
    const agent = new Agent({
      systemPrompt: "test",
      maxTurns: 4,
      llm,
      tools: [new ReadFileTool()],
      workspace,
      contextManager: new ContextManager({ contextWindow: 1_000_000 }),
    });

    await agent.run("please read a.ts");

    expect(llm.requests[1]).toHaveProperty("continuation");
  });

  it("sends only the replaced decision in the next request after real context compaction", async () => {
    const oldDecision = "Use API v1";
    const newDecision = "Use API v2";
    const compactLlm = new FakeLLMClient([assistant(JSON.stringify({
      summary: "The user explicitly selected API v2.",
      decisions: [newDecision],
      supersededDecisions: [oldDecision],
      pendingTasks: [],
    }))]);
    const llm = new FakeLLMClient([assistant("done")]);
    const agent = new Agent({
      systemPrompt: "test",
      maxTurns: 2,
      llm,
      tools: [],
      workspace,
      streaming: false,
      contextManager: new ContextManager({
        contextWindow: 5_500,
        reserveTokens: 750,
        keepRecentTokens: 1_800,
        compactor: new Compactor(compactLlm),
      }),
    });
    const previous = {
      state: {
        summary: "Previous instructions",
        readFiles: [],
        modifiedFiles: [],
        decisions: [oldDecision],
        pendingTasks: [],
      },
      splitIndex: 0,
    };

    const result = await agent.run("Continue", {
      history: [
        user("The user now explicitly chooses API v2."),
        ...Array.from({ length: 55 }, () => user("old transcript ".repeat(27))),
      ],
      compaction: previous,
    });

    expect(result.status).toBe("completed");
    expect(compactLlm.requests).toHaveLength(1);
    expect(JSON.stringify(compactLlm.requests[0]?.messages)).toContain("The user now explicitly chooses API v2.");
    expect(llm.requests).toHaveLength(1);
    const requestMessages = JSON.stringify(llm.requests[0]?.messages);
    expect(requestMessages).toContain(newDecision);
    expect(requestMessages).not.toContain(oldDecision);
  });

  it("drops Provider continuation when a long tool run compacts its history", async () => {
    const mediumWorkspace: Workspace = {
      ...workspace,
      async readTextFile() {
        return { content: "m".repeat(1_600), startLine: 1, endLine: 1, totalLines: 1, truncated: false };
      },
    };
    const responses = Array.from({ length: 7 }, (_, index) => assistant(
      "", [{ id: `medium-${index}`, name: "read_file", arguments: { path: "a.ts" } }], { provider: "fake" },
    ));
    responses.push(assistant("done"));
    const llm = new FakeLLMClient(responses);
    const agent = new Agent({
      systemPrompt: "test", maxTurns: 10, llm, tools: [new ReadFileTool()], workspace: mediumWorkspace,
      streaming: false,
      contextManager: new ContextManager({
        contextWindow: 2_000, reserveTokens: 400, keepRecentTokens: 200,
        compactor: new Compactor(summarisingClient('{"summary":"earlier reads"}')),
      }),
    });
    const result = await agent.run("read a.ts repeatedly");
    expect(result.status).toBe("completed");
    expect(llm.requests.some((request, index) => index > 0 && !("continuation" in request))).toBe(true);
    expect(llm.requests.some((request, index) => index > 0 && "continuation" in request)).toBe(true);
  });

  it("preserves the full transcript even after compacting", async () => {
    const llm = new FakeLLMClient([assistant("done")]);
    const manager = new ContextManager({
      contextWindow: 2_000,
      reserveTokens: 400,
      keepRecentTokens: 200,
      compactor: new Compactor(summarisingClient('{"summary":"s"}')),
    });
    const agent = new Agent({
      systemPrompt: "test",
      maxTurns: 4,
      llm,
      tools: [new ReadFileTool()],
      workspace,
      contextManager: manager,
    });

    const result = await agent.run("please continue", {
      history: [
        user("x".repeat(3_500)),
        { role: "assistant", content: "old", toolCalls: [] },
        user("r".repeat(1_000)),
      ],
    });

    // The session keeps what happened; only the request was shortened.
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
    ]);
    expect(result.messages[0]?.content).toBe("x".repeat(3_500));
  });
});

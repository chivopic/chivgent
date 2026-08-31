import { describe, expect, it, vi } from "vitest";
import {
  ContextManager,
  createLLMSummariser,
  recentPromptBoundary,
  renderTranscript,
  SUMMARY_MARKER,
} from "../src/context.js";
import type { LLMClient } from "../src/llm.js";
import type { Message } from "../src/messages.js";
import { estimateRequestTokens } from "../src/tokens.js";
import { assistant } from "./fakes.js";

const tools = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
  },
];

function conversation(turns: number, bodyLength = 4_000): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: `Question ${turn}` });
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: `call-${turn}`, name: "read_file", arguments: { path: "a.ts" } },
      ],
    });
    messages.push({
      role: "tool",
      toolCallId: `call-${turn}`,
      toolName: "read_file",
      content: "x".repeat(bodyLength),
      isError: false,
    });
    messages.push({
      role: "assistant",
      content: `Answer ${turn}`,
      toolCalls: [],
    });
  }
  return messages;
}

function shape(messages: readonly Message[]) {
  return { systemPrompt: "System prompt", messages, tools };
}

describe("context status", () => {
  it("reports the budget as a fraction of the window", () => {
    const manager = new ContextManager({
      maxInputTokens: 1_000,
      compactAtRatio: 0.5,
    });

    const status = manager.status(shape([{ role: "user", content: "hi" }]));

    expect(status.maxInputTokens).toBe(1_000);
    expect(status.budgetTokens).toBe(500);
    expect(status.overBudget).toBe(false);
  });

  it("flags a transcript over the budget", () => {
    const manager = new ContextManager({ maxInputTokens: 1_000 });

    expect(manager.status(shape(conversation(4))).overBudget).toBe(true);
  });

  it("rejects a nonsensical window", () => {
    expect(() => new ContextManager({ maxInputTokens: 0 })).toThrow(
      "maxInputTokens",
    );
  });
});

describe("compaction", () => {
  it("does nothing while the transcript fits", async () => {
    const manager = new ContextManager({ maxInputTokens: 100_000 });

    await expect(
      manager.compact(shape(conversation(1))),
    ).resolves.toBeUndefined();
  });

  it("compacts anyway when forced", async () => {
    const manager = new ContextManager({
      maxInputTokens: 100_000,
      summarise: async () => "A summary.",
    });

    const result = await manager.compact(shape(conversation(3)), {
      force: true,
    });

    expect(result?.summarisedMessages).toBeGreaterThan(0);
  });

  it("folds older turns into one summary message and keeps recent prompts", async () => {
    const manager = new ContextManager({
      maxInputTokens: 2_000,
      keepRecentPrompts: 2,
      summarise: async () => "Earlier: read a.ts, answered twice.",
    });
    const messages = conversation(4);

    const result = await manager.compact(shape(messages));

    expect(result).toBeDefined();
    expect(result?.messages[0]).toEqual({
      role: "user",
      content: `${SUMMARY_MARKER}\nEarlier: read a.ts, answered twice.`,
    });
    expect(result?.afterTokens).toBeLessThan(result?.beforeTokens ?? 0);
    expect(result?.degraded).toBe(false);
    // The last two prompts survive verbatim.
    expect(
      result?.messages.filter(
        (message) => message.role === "user" && message.content === "Question 3",
      ),
    ).toHaveLength(1);
  });

  it("leaves a sequence a Provider will accept", async () => {
    const manager = new ContextManager({
      maxInputTokens: 1_500,
      summarise: async () => "Summary.",
    });

    const result = await manager.compact(shape(conversation(5)));

    const compacted = result?.messages ?? [];
    expect(compacted[0]?.role).toBe("user");
    for (const [index, message] of compacted.entries()) {
      if (message.role !== "tool") {
        continue;
      }
      // Every tool result still follows the assistant message that called it.
      const owner = compacted
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      expect(owner?.role === "assistant" && owner.toolCalls.length).toBeTruthy();
    }
  });

  it("trims stale tool results when the summary is not enough", async () => {
    const manager = new ContextManager({
      maxInputTokens: 900,
      keepRecentPrompts: 3,
      maxToolResultTokens: 20,
      summarise: async () => "Summary.",
    });

    const result = await manager.compact(shape(conversation(4, 8_000)));

    expect(result?.shrunkToolResults).toBeGreaterThan(0);
    expect(
      result?.messages.some((message) =>
        message.role === "tool"
          ? message.content.includes("trimmed to fit the context budget")
          : false,
      ),
    ).toBe(true);
  });

  it("drops the oldest messages as a last resort but keeps the final prompt", async () => {
    const manager = new ContextManager({
      maxInputTokens: 1_100,
      // Keeping every prompt leaves nothing to summarise, and long prompts
      // cannot be shrunk the way tool results can, so only dropping is left.
      keepRecentPrompts: 8,
      maxToolResultTokens: 20,
      summarise: async () => "Summary.",
    });
    const messages: Message[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      messages.push({
        role: "user",
        content: `Question ${turn} ${"q".repeat(4_000)}`,
      });
      messages.push({
        role: "assistant",
        content: `Answer ${turn}`,
        toolCalls: [],
      });
    }

    const result = await manager.compact(shape(messages));

    expect(result?.droppedMessages).toBeGreaterThan(0);
    expect(result?.messages[0]?.role).toBe("user");
    expect(
      result?.messages.some(
        (message) =>
          message.role === "user" && message.content.startsWith("Question 5"),
      ),
    ).toBe(true);
  });

  it("keeps the summary when it has to drop messages as well", async () => {
    const manager = new ContextManager({
      maxInputTokens: 1_200,
      keepRecentPrompts: 2,
      maxToolResultTokens: 20,
      summarise: async () => "Earlier: inspected a.ts.",
    });
    const messages: Message[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      messages.push({
        role: "user",
        content: `Question ${turn} ${"q".repeat(3_000)}`,
      });
      messages.push({
        role: "assistant",
        content: `Answer ${turn}`,
        toolCalls: [],
      });
    }

    const result = await manager.compact(shape(messages));

    // The summary is the densest message in the transcript; dropping it would
    // throw away the work the summarisation step just paid for.
    expect(result?.droppedMessages).toBeGreaterThan(0);
    expect(result?.messages[0]?.content).toContain(SUMMARY_MARKER);
    expect(result?.messages[0]?.content).toContain("inspected a.ts");
  });

  it("falls back to a digest when the summariser fails", async () => {
    const manager = new ContextManager({
      maxInputTokens: 1_500,
      summarise: async () => {
        throw new Error("Provider unavailable");
      },
    });

    const result = await manager.compact(shape(conversation(4)));

    expect(result?.degraded).toBe(true);
    expect(result?.messages[0]?.content).toContain("Earlier requests:");
    expect(result?.messages[0]?.content).toContain("read_file");
  });

  it("falls back to a digest when the summariser returns nothing", async () => {
    const manager = new ContextManager({
      maxInputTokens: 1_500,
      summarise: async () => "   ",
    });

    const result = await manager.compact(shape(conversation(4)));

    expect(result?.degraded).toBe(true);
  });

  it("works with no summariser at all", async () => {
    const manager = new ContextManager({ maxInputTokens: 1_500 });

    const result = await manager.compact(shape(conversation(4)));

    expect(result?.degraded).toBe(true);
    expect(result?.afterTokens).toBeLessThan(result?.beforeTokens ?? 0);
  });

  it("accounts for the system prompt and tool schemas, not just messages", async () => {
    const manager = new ContextManager({
      maxInputTokens: 2_000,
      summarise: async () => "Summary.",
    });
    const messages = conversation(3);
    const bigTools = [
      {
        name: "read_file",
        description: "d".repeat(4_000),
        inputSchema: { type: "object" },
      },
    ];

    const withSmallTools = await manager.compact(shape(messages));
    const withBigTools = await manager.compact({
      systemPrompt: "System prompt",
      messages,
      tools: bigTools,
    });

    expect(withBigTools?.afterTokens ?? 0).toBeLessThanOrEqual(
      (withSmallTools?.afterTokens ?? 0) +
        estimateRequestTokens({ systemPrompt: "", messages: [], tools: bigTools }),
    );
    expect(withBigTools?.summarisedMessages).toBeGreaterThan(0);
  });
});

describe("recentPromptBoundary", () => {
  it("returns the index of the nth-from-last user message", () => {
    const messages = conversation(3);

    expect(recentPromptBoundary(messages, 1)).toBe(8);
    expect(recentPromptBoundary(messages, 2)).toBe(4);
  });

  it("returns 0 when there is nothing older to fold", () => {
    expect(recentPromptBoundary(conversation(1), 2)).toBe(0);
    expect(recentPromptBoundary([], 2)).toBe(0);
  });

  it("never returns an index that splits a tool call from its result", () => {
    const messages = conversation(3);

    expect(messages[recentPromptBoundary(messages, 2)]?.role).toBe("user");
  });
});

describe("LLM summariser", () => {
  it("summarises through the Provider with no tools", async () => {
    const complete = vi.fn().mockResolvedValue(assistant("A summary."));
    const llm = { complete } as unknown as LLMClient;

    const summary = await createLLMSummariser(llm)(conversation(2), {});

    expect(summary).toBe("A summary.");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ tools: [] }),
    );
    const request = complete.mock.calls[0]?.[0];
    expect(request.systemPrompt).toContain("compress");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].role).toBe("user");
  });

  it("passes the abort signal through", async () => {
    const controller = new AbortController();
    const complete = vi.fn().mockResolvedValue(assistant("A summary."));
    const llm = { complete } as unknown as LLMClient;

    await createLLMSummariser(llm)(conversation(1), {
      signal: controller.signal,
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("transcript rendering", () => {
  it("renders each role and truncates long tool output", () => {
    const rendered = renderTranscript([
      { role: "user", content: "Explain src/agent.ts" },
      {
        role: "assistant",
        content: "Looking.",
        toolCalls: [
          { id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        content: "y".repeat(5_000),
        isError: false,
      },
    ]);

    expect(rendered).toContain("user: Explain src/agent.ts");
    expect(rendered).toContain("assistant: Looking.");
    expect(rendered).toContain('assistant calls read_file({"path":"a.ts"})');
    expect(rendered).toContain("read_file returned:");
    expect(rendered.length).toBeLessThan(2_000);
  });

  it("marks a failed tool result as failed", () => {
    const rendered = renderTranscript([
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        content: "File not found",
        isError: true,
      },
    ]);

    expect(rendered).toContain("read_file failed: File not found");
  });
});

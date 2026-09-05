import { describe, expect, it, vi } from "vitest";
import type { Message } from "../src/messages.js";
import { HeuristicTokenEstimator } from "../src/context/token-estimator.js";
import {
  Compactor,
  parseSummary,
  renderCompactionState,
  type CompactionState,
} from "../src/context/compaction.js";
import {
  ContextManager,
  findSplitIndex,
} from "../src/context/context-manager.js";
import type { LLMClient, LLMResponse } from "../src/llm.js";
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
});

describe("ContextManager", () => {
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

  it("passes through when no compactor is configured", async () => {
    const manager = new ContextManager({ contextWindow: 1_000 });
    const messages = [user(long), user(long)];

    const context = await manager.build(messages);

    expect(context.compacted).toBe(false);
    expect(context.messages).toHaveLength(2);
  });

  it("replaces old history with a summary once over budget", async () => {
    const client = summarisingClient(
      '{"summary":"did the thing","decisions":["keep paths relative"],"pendingTasks":["add tests"]}',
    );
    const manager = new ContextManager({
      contextWindow: 2_000,
      reserveTokens: 500,
      keepRecentTokens: 300,
      compactor: new Compactor(client),
    });
    const messages = [user(long), user(long), user("most recent")];

    const context = await manager.build(messages);

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
      contextWindow: 2_000,
      reserveTokens: 500,
      keepRecentTokens: 300,
      compactor: new Compactor(client),
    });
    const messages = [user(long), user(long), user("recent")];

    const first = await manager.build(messages);
    expect(client.calls).toBe(1);

    const second = await manager.build([...messages, user("newer")], {
      ...(first.compaction === undefined ? {} : { previous: first.compaction }),
    });

    expect(client.calls).toBe(1);
    expect(second.compacted).toBe(false);
    expect(second.messages[0]?.content).toContain("first pass");
    expect(second.messages.at(-1)).toEqual(user("newer"));
  });

  it("reports what it dropped", async () => {
    const events: number[] = [];
    const manager = new ContextManager({
      contextWindow: 2_000,
      reserveTokens: 500,
      keepRecentTokens: 300,
      compactor: new Compactor(summarisingClient('{"summary":"s"}')),
      onCompaction: (event) => events.push(event.droppedMessages),
    });

    await manager.build([user(long), user(long), user("recent")]);

    expect(events).toEqual([2]);
  });

  it("refuses a reserve larger than the window", () => {
    expect(
      () => new ContextManager({ contextWindow: 100, reserveTokens: 100 }),
    ).toThrow(TypeError);
  });
});

describe("Compactor", () => {
  it("derives file lists from tool calls rather than from prose", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"s"}'));
    const messages: Message[] = [
      assistantWithCall("read_file", "src/read-only.ts", "1"),
      toolResult("1", "read_file", "contents"),
      assistantWithCall("edit_file", "src/changed.ts", "2"),
      toolResult("2", "edit_file", "edited"),
    ];

    const state = await compactor.compact(messages);

    expect(state.readFiles).toEqual(["src/read-only.ts"]);
    expect(state.modifiedFiles).toEqual(["src/changed.ts"]);
  });

  it("counts a file it both read and changed as changed", async () => {
    const compactor = new Compactor(summarisingClient('{"summary":"s"}'));
    const messages: Message[] = [
      assistantWithCall("read_file", "src/a.ts", "1"),
      assistantWithCall("write_file", "src/a.ts", "2"),
    ];

    const state = await compactor.compact(messages);

    expect(state.readFiles).toEqual([]);
    expect(state.modifiedFiles).toEqual(["src/a.ts"]);
  });
});

describe("parseSummary", () => {
  it("reads the documented JSON shape", () => {
    expect(
      parseSummary('{"summary":"s","decisions":["d"],"pendingTasks":["p"]}'),
    ).toEqual({ summary: "s", decisions: ["d"], pendingTasks: ["p"] });
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

  it("drops the Provider continuation when it compacts", async () => {
    // Turn 1 reads a large file and hands back a continuation; turn 2 must not
    // reuse it, or the Provider would replay the history just summarised.
    const llm = new FakeLLMClient([
      assistant("", [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }], {
        provider: "fake",
      }),
      assistant("done"),
    ]);
    const manager = new ContextManager({
      contextWindow: 2_000,
      reserveTokens: 400,
      keepRecentTokens: 200,
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

    const result = await agent.run("please read a.ts");

    expect(result.status).toBe("completed");
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]).not.toHaveProperty("continuation");
    // The second request compacted, so the continuation from turn 1 is gone.
    expect(llm.requests[1]).not.toHaveProperty("continuation");
    expect(llm.requests[1]?.messages[0]?.content).toContain("read a.ts");
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

  it("preserves the full transcript even after compacting", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }]),
      assistant("done"),
    ]);
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

    const result = await agent.run("please read a.ts");

    // The session keeps what happened; only the request was shortened.
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  addUsage,
  formatTokens,
  fromChatCompletionsUsage,
  fromResponsesUsage,
} from "../src/providers/usage.js";
import { Agent } from "../src/agent.js";
import { Compactor } from "../src/context/compaction.js";
import { ContextManager } from "../src/context/context-manager.js";
import { formatTable, toJsonReport } from "../src/evals/report.js";
import { AgentSession } from "../src/session.js";
import { handleSlashCommand } from "../src/repl.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";
import type { LLMClient, LLMRequest, LLMResponse, Usage } from "../src/llm.js";
import type { AgentEvent } from "../src/events.js";
import type { Workspace } from "../src/workspace.js";

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() {
    return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false };
  },
  async listFiles() {
    return { entries: [], truncated: false };
  },
  async searchText() {
    return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
  },
};

/** A client that reports whatever usage the test hands it, turn by turn. */
class MeteredClient implements LLMClient {
  private index = 0;

  constructor(
    private readonly responses: readonly LLMResponse[],
  ) {}

  async complete(): Promise<LLMResponse> {
    const response = this.responses[this.index];
    if (response === undefined) {
      throw new Error("No metered response configured.");
    }
    this.index += 1;
    return structuredClone(response);
  }
}

function usage(input: number, output: number, extra: Partial<Usage> = {}): Usage {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, ...extra };
}

describe("reading usage off a Provider response", () => {
  it("reads Chat Completions field names", () => {
    expect(
      fromChatCompletionsUsage({
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      }),
    ).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  });

  it("reads the Responses API's different field names", () => {
    expect(
      fromResponsesUsage({ input_tokens: 10, output_tokens: 4, total_tokens: 14 }),
    ).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it("picks up cached and reasoning tokens where a Provider reports them", () => {
    expect(
      fromChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toMatchObject({ cachedInputTokens: 64, reasoningTokens: 20 });
  });

  it("reads DeepSeek's top-level cache-hit field", () => {
    expect(
      fromChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 96,
      }),
    ).toMatchObject({ cachedInputTokens: 96 });
  });

  it("returns undefined, never zeroes, when nothing was reported", () => {
    // Zeroes would be indistinguishable from a genuinely free call and would
    // quietly understate every total containing them.
    for (const value of [undefined, null, {}, "usage", { foo: 1 }]) {
      expect(fromChatCompletionsUsage(value)).toBeUndefined();
      expect(fromResponsesUsage(value)).toBeUndefined();
    }
  });

  it("derives the total when the Provider omits it", () => {
    expect(fromChatCompletionsUsage({ prompt_tokens: 7, completion_tokens: 3 })).toMatchObject({
      totalTokens: 10,
    });
  });
});

describe("adding usage up", () => {
  it("sums each field", () => {
    const total = addUsage(addUsage(undefined, usage(10, 5)), usage(20, 1));

    expect(total).toEqual({
      usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
      complete: true,
    });
  });

  it("marks a total incomplete when a call reported nothing", () => {
    const total = addUsage(addUsage(undefined, usage(10, 5)), undefined);

    expect(total.complete).toBe(false);
    // The known part is kept: it is a floor, not a guess.
    expect(total.usage.totalTokens).toBe(15);
  });

  it("stays incomplete once a call has gone unreported", () => {
    let total = addUsage(undefined, undefined);
    total = addUsage(total, usage(4, 2));

    expect(total.complete).toBe(false);
    expect(total.usage.totalTokens).toBe(6);
  });

  it("sums cached and reasoning tokens only when present", () => {
    const total = addUsage(
      addUsage(undefined, usage(10, 5, { cachedInputTokens: 8 })),
      usage(10, 5),
    );

    expect(total.usage.cachedInputTokens).toBe(8);
    expect(total.usage.reasoningTokens).toBeUndefined();
  });
});

describe("formatTokens", () => {
  it("stays readable across magnitudes", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("an Agent run's total", () => {
  function agentWith(responses: readonly LLMResponse[], events: AgentEvent[] = []): Agent {
    return new Agent({
      systemPrompt: "system",
      maxTurns: 6,
      llm: new MeteredClient(responses),
      tools: [],
      workspace,
      onEvent: (event) => events.push(event),
    });
  }

  it("adds up every turn", async () => {
    const call = { id: "c1", name: "missing_tool", arguments: {} };
    const result = await agentWith([
      { ...assistant("", [call]), usage: usage(100, 10) },
      { ...assistant("done"), usage: usage(150, 20) },
    ]).run("go");

    expect(result.usage).toEqual({
      usage: { inputTokens: 250, outputTokens: 30, totalTokens: 280 },
      complete: true,
    });
  });

  it("carries the per-turn figure on message_end", async () => {
    const events: AgentEvent[] = [];
    await agentWith([{ ...assistant("done"), usage: usage(9, 1) }], events).run("go");

    const messageEnd = events.find((event) => event.type === "message_end");
    expect(messageEnd).toMatchObject({ usage: { totalTokens: 10 } });
  });

  it("reports the total on agent_end", async () => {
    const events: AgentEvent[] = [];
    await agentWith([{ ...assistant("done"), usage: usage(9, 1) }], events).run("go");

    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      usage: { usage: { totalTokens: 10 }, complete: true },
    });
  });

  it("flags the total when a Provider reported nothing", async () => {
    const result = await agentWith([assistant("done")]).run("go");

    expect(result.usage).toMatchObject({ complete: false });
  });

  it("stays complete on a run that had a context manager but never compacted", async () => {
    // A turn that did not need compacting spends nothing extra, which is not
    // the same as a Provider failing to report — only the latter is a gap.
    const events: AgentEvent[] = [];
    const agent = new Agent({
      systemPrompt: "system",
      maxTurns: 4,
      llm: new MeteredClient([{ ...assistant("done"), usage: usage(20, 5) }]),
      tools: [],
      workspace,
      onEvent: (event) => events.push(event),
      contextManager: new ContextManager({
        contextWindow: 100_000,
        compactor: new Compactor(new MeteredClient([])),
      }),
    });

    const result = await agent.run("short question");

    expect(result.usage).toEqual({
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      complete: true,
    });
  });

  it("counts what compaction itself spent", async () => {
    // Compaction trades a call now against smaller inputs later; leaving its
    // cost out would make that trade impossible to judge.
    const summariser = new MeteredClient([
      { ...assistant('{"summary":"earlier work"}'), usage: usage(500, 40) },
    ]);
    const events: AgentEvent[] = [];
    const agent = new Agent({
      systemPrompt: "system",
      maxTurns: 4,
      llm: new MeteredClient([{ ...assistant("done"), usage: usage(20, 5) }]),
      tools: [],
      workspace,
      onEvent: (event) => events.push(event),
      contextManager: new ContextManager({
        contextWindow: 1000,
        reserveTokens: 100,
        keepRecentTokens: 20,
        compactor: new Compactor(summariser),
      }),
    });

    // Compaction needs a history worth summarising: a lone message has
    // nothing to cut, and the manager correctly declines to compact it.
    const history = [
      { role: "user" as const, content: "x".repeat(4000) },
      { role: "assistant" as const, content: "y".repeat(4000), toolCalls: [] },
      { role: "user" as const, content: "z".repeat(4000) },
    ];
    const result = await agent.run("and now the last question", { history });

    // 25 for the answer plus 540 for the summarising call.
    expect(result.usage?.usage.totalTokens).toBe(565);
  });
});

describe("a session's running total", () => {
  it("accumulates across prompts and shows up in /session", async () => {
    const session = new AgentSession({
      agent: {
        systemPrompt: "system",
        maxTurns: 4,
        llm: new MeteredClient([
          { ...assistant("one"), usage: usage(10, 2) },
          { ...assistant("two"), usage: usage(30, 4) },
        ]),
        tools: [],
        workspace,
      },
      cwd: "/workspace",
    });

    await session.prompt("first");
    await session.prompt("second");

    expect(session.usage?.usage.totalTokens).toBe(46);

    let output = "";
    handleSlashCommand("/session", { session, write: (text) => (output += text) });
    expect(output).toContain("46 total");
    expect(output).toContain("40 in");
  });

  it("says nothing about tokens when no Provider reported any", async () => {
    const session = new AgentSession({
      agent: {
        systemPrompt: "system",
        maxTurns: 4,
        llm: new FakeLLMClient([assistant("done")]),
        tools: [],
        workspace,
      },
      cwd: "/workspace",
    });
    await session.prompt("first");

    let output = "";
    handleSlashCommand("/session", { session, write: (text) => (output += text) });

    expect(output).not.toContain("tokens:");
  });
});

describe("the eval report's token column", () => {
  const attempt = (tokens?: number) => ({
    attempt: 1,
    passed: true,
    status: "completed" as const,
    turnCount: 2,
    durationMs: 1000,
    toolsUsed: ["read_file"],
    toolCalls: [{ name: "read_file", ok: true }],
    failures: [],
    ...(tokens === undefined
      ? {}
      : {
          usage: {
            usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens },
            complete: true,
          },
        }),
  });

  it("shows the median per task and the run total", () => {
    const table = formatTable([
      { task: "alpha", total: 2, passed: 2, attempts: [attempt(1000), attempt(3000)] },
    ]);

    expect(table).toContain("tokens");
    expect(table).toContain("2.0k");
    expect(table).toContain("4.0k tokens");
  });

  it("shows a dash rather than zero when nothing was reported", () => {
    const table = formatTable([
      { task: "alpha", total: 1, passed: 1, attempts: [attempt()] },
    ]);

    expect(table).toContain("-");
    expect(table).not.toContain("0 tokens");
  });

  it("puts per-attempt usage in the JSON report", () => {
    const json = toJsonReport(
      [{ task: "alpha", total: 1, passed: 1, attempts: [attempt(1500)] }],
      { provider: "deepseek", model: "m", version: "0.15.0", startedAt: "now" },
    ) as Record<string, any>;

    expect(json.tasks[0].totalTokens).toBe(1500);
    expect(json.tasks[0].attempts[0].usage.usage.totalTokens).toBe(1500);
    expect(json.overall.totalTokens).toBe(1500);
  });
});

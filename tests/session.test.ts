import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { AgentSession } from "../src/session.js";
import { ContextManager } from "../src/context/context-manager.js";
import { Compactor } from "../src/context/compaction.js";
import {
  createSessionId,
  defaultSessionHome,
  FileSessionStore,
  parseTranscript,
  type SessionStore,
} from "../src/session-store.js";
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

function tool(name: string, output: ToolOutput): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" },
    async execute() {
      return output;
    },
  };
}

function createSession(
  llm: FakeLLMClient,
  overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {},
): AgentSession {
  return new AgentSession({
    agent: {
      systemPrompt: "System prompt",
      maxTurns: 4,
      llm,
      tools: [tool("echo", { content: "echoed", isError: false })],
      workspace,
      streaming: false,
    },
    cwd: "/workspace",
    ...overrides,
  });
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "chivgent-session-"));
}

describe("AgentSession", () => {
  it("ignores malformed optional checkpoint usage without losing the transcript", () => {
    const parsed = parseTranscript([
      JSON.stringify({ type: "session", version: 1, id: "legacy", timestamp: "now", cwd: "/workspace" }),
      JSON.stringify({ type: "agent_end", status: "completed", turnCount: 1, messages: [{ role: "user", content: "kept" }], usage: {}, sessionUsage: {} }),
    ].join("\n"));
    expect(parsed?.messages).toEqual([{ role: "user", content: "kept" }]);
    expect(parsed?.usage).toEqual({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, complete: false });
  });

  it("rebuilds cumulative usage from older agent_end records", () => {
    const header = { type: "session", version: 1, id: "legacy-usage", timestamp: "now", cwd: "/workspace" };
    const end = (tokens: number) => ({
      type: "agent_end", status: "completed", turnCount: 1, messages: [],
      usage: { usage: { inputTokens: tokens, outputTokens: 1, totalTokens: tokens + 1 }, complete: true },
    });
    const parsed = parseTranscript([JSON.stringify(header), JSON.stringify(end(4)), JSON.stringify(end(7))].join("\n"));
    expect(parsed?.usage).toEqual({
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 }, complete: true,
    });
  });

  it("preserves incomplete usage when rebuilding older records", () => {
    const header = { type: "session", version: 1, id: "legacy-incomplete", timestamp: "now", cwd: "/workspace" };
    const parsed = parseTranscript([JSON.stringify(header), JSON.stringify({
      type: "agent_end", status: "completed", turnCount: 1, messages: [],
      usage: { usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }, complete: false },
    })].join("\n"));
    expect(parsed?.usage).toEqual({
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }, complete: false,
    });
  });

  it("carries the transcript into the next prompt", async () => {
    const llm = new FakeLLMClient([
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const session = createSession(llm);

    await session.prompt("First question");
    await session.prompt("Second question");

    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer.", toolCalls: [] },
      { role: "user", content: "Second question" },
    ]);
    expect(session.turns).toBe(2);
    expect(session.messages).toHaveLength(4);
  });

  it("forgets the transcript on clear but keeps the session id", async () => {
    const llm = new FakeLLMClient([
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const session = createSession(llm);
    const { id } = session;

    await session.prompt("First question");
    session.clear();
    expect(session.turns).toBe(0);
    expect(session.usage).toBeUndefined();
    await session.prompt("Second question");

    expect(session.id).toBe(id);
    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "Second question" },
    ]);
  });

  it("restores an empty transcript after clear without another prompt", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    const session = createSession(new FakeLLMClient([assistant("Before clear.")]), {
      store,
      id: "cleared-session",
    });

    await session.prompt("Old question");
    session.clear();
    await store.flush();

    expect((await store.read("cleared-session"))?.messages).toEqual([]);
    expect((await store.read("cleared-session"))?.prompts).toEqual([]);

    const resumed = createSession(new FakeLLMClient([assistant("Fresh answer.")]), {
      store,
      id: "cleared-session",
      resumed: true,
      messages: (await store.read("cleared-session"))?.messages,
    });
    await resumed.prompt("Fresh question");
    expect(resumed.messages).toEqual([
      { role: "user", content: "Fresh question" },
      { role: "assistant", content: "Fresh answer.", toolCalls: [] },
    ]);
  });

  it("delivers events to every subscriber and survives a failing one", async () => {
    const llm = new FakeLLMClient([assistant("Answer.")]);
    const session = createSession(llm);
    const seen: string[] = [];
    session.subscribe(() => {
      throw new Error("subscriber crashed");
    });
    session.subscribe((event: AgentEvent) => seen.push(event.type));

    await session.prompt("Question");

    expect(seen).toContain("agent_start");
    expect(seen.at(-1)).toBe("agent_end");
  });

  it("stops delivering to an unsubscribed listener", async () => {
    const llm = new FakeLLMClient([
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const session = createSession(llm);
    const seen: string[] = [];
    const unsubscribe = session.subscribe((event) => seen.push(event.type));

    await session.prompt("First question");
    const afterFirst = seen.length;
    unsubscribe();
    await session.prompt("Second question");

    expect(seen).toHaveLength(afterFirst);
  });

  it("records a header and the run events, but not deltas", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "echo", arguments: {} }]),
      assistant("Answer."),
    ]);
    const session = createSession(llm, { store, id: "session-under-test" });

    await session.prompt("Question");

    const contents = await readFile(store.location(session.id), "utf8");
    const types = contents
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types[0]).toBe("session");
    expect(types).toContain("tool_execution_start");
    expect(types).not.toContain("message_update");
    expect(types.at(-1)).toBe("agent_end");
  });

  it("restores a recorded transcript", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    const first = createSession(new FakeLLMClient([assistant("First answer.")]), {
      store,
      id: "restored-session",
    });
    await first.prompt("First question");

    const transcript = await store.read("restored-session");
    const resumedLlm = new FakeLLMClient([assistant("Second answer.")]);
    const resumed = createSession(resumedLlm, {
      store,
      id: "restored-session",
      resumed: true,
      ...(transcript === undefined ? {} : { messages: transcript.messages }),
    });
    await resumed.prompt("Second question");

    expect(resumedLlm.requests[0]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer.", toolCalls: [] },
      { role: "user", content: "Second question" },
    ]);
    const contents = await readFile(store.location("restored-session"), "utf8");
    const headers = contents
      .trim()
      .split("\n")
      .filter((line) => (JSON.parse(line) as { type: string }).type === "session");
    expect(headers).toHaveLength(1);
  });

  it("restores prompt count and cumulative usage across a process restart", async () => {
    const store = new FileSessionStore(await temporaryHome());
    const first = createSession(new FakeLLMClient([
      { ...assistant("one"), usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
    ]), { store, id: "usage-restore" });
    await first.prompt("first");
    const saved = await store.read("usage-restore");
    expect(saved?.promptCount).toBe(1);
    expect(saved?.usage?.usage.totalTokens).toBe(15);

    const resumed = createSession(new FakeLLMClient([
      { ...assistant("two"), usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
    ]), {
      store, id: "usage-restore", resumed: true,
      messages: saved?.messages, promptCount: saved?.promptCount, usage: saved?.usage,
    });
    await resumed.prompt("second");
    expect(resumed.turns).toBe(2);
    expect(resumed.usage?.usage.totalTokens).toBe(27);
    expect((await store.read("usage-restore"))?.promptCount).toBe(2);
  });

  it("persists a compaction checkpoint and reuses it after resume", async () => {
    const store = new FileSessionStore(await temporaryHome());
    const makeAgent = (llm: FakeLLMClient, compactLlm: FakeLLMClient) => ({
      systemPrompt: "system", maxTurns: 2, llm,
      tools: [tool("echo", { content: "echoed", isError: false })], workspace, streaming: false,
      contextManager: new ContextManager({
        contextWindow: 700, reserveTokens: 100, keepRecentTokens: 100,
        compactor: new Compactor(compactLlm),
      }),
    });
    const summary = () => new FakeLLMClient([assistant('{"summary":"Earlier requests","decisions":[],"pendingTasks":[]}')]);
    const first = new AgentSession({
      agent: makeAgent(new FakeLLMClient([assistant("a"), assistant("b"), assistant("c")]), summary()),
      store, id: "checkpoint-resume", cwd: "/workspace",
    });
    await first.prompt("one".repeat(200));
    await first.prompt("two".repeat(200));
    await first.prompt("three".repeat(200));
    const saved = await store.read("checkpoint-resume");
    expect(saved?.compaction).toBeDefined();
    expect(saved?.compaction?.splitIndex).toBeGreaterThan(0);
    const lines = (await readFile(store.location("checkpoint-resume"), "utf8")).trim().split("\n");
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    last.compactionTranscriptHash = "stale";
    lines[lines.length - 1] = JSON.stringify(last);
    const damaged = parseTranscript(lines.join("\n"));
    expect(damaged?.compaction).toBeUndefined();
    expect(damaged?.messages).toEqual(saved?.messages);

    const resumedLlm = new FakeLLMClient([assistant("d")]);
    const resumed = new AgentSession({
      agent: makeAgent(resumedLlm, summary()), store, id: "checkpoint-resume", cwd: "/workspace",
      resumed: true, messages: saved?.messages, compaction: saved?.compaction,
      promptCount: saved?.promptCount, usage: saved?.usage,
    });
    await resumed.prompt("four");
    expect(resumedLlm.requests[0]?.messages[0]?.content).toContain("Earlier requests");
    expect((await store.read("checkpoint-resume"))?.promptCount).toBe(4);
  });

  it("restores an anchored long-run checkpoint after multiple prompts and repeated compaction", async () => {
    const store = new FileSessionStore(await temporaryHome());
    let summaryCalls = 0;
    const summaryClient = {
      async complete() {
        summaryCalls += 1;
        return assistant('{"summary":"prior tool work","decisions":[],"pendingTasks":[]}');
      },
    };
    const contextManager = new ContextManager({
      contextWindow: 1_770, reserveTokens: 120, keepRecentTokens: 600,
      compactor: new Compactor(summaryClient),
    });
    const longTool: Tool = {
      name: "echo",
      description: "Return a recorded result",
      inputSchema: { type: "object" },
      async execute() { return { content: "tool-result ".repeat(45), isError: false }; },
    };
    const agentOptions = (llm: FakeLLMClient) => ({
      systemPrompt: "system", maxTurns: 32, llm, tools: [longTool], workspace, streaming: false,
      contextManager,
    });
    const first = new AgentSession({
      agent: agentOptions(new FakeLLMClient([assistant("first answer")])),
      store, id: "anchored-long-run", cwd: "/workspace",
    });
    await first.prompt("first prompt");

    const toolResponses = Array.from({ length: 24 }, (_, index) => assistant("", [{
      id: `long-${index}`, name: "echo", arguments: {},
    }]));
    const secondLlm = new FakeLLMClient([...toolResponses, assistant("second answer")]);
    const running = new AgentSession({ agent: agentOptions(secondLlm), store, id: first.id, cwd: first.cwd, resumed: true,
      messages: first.messages, promptCount: first.turns, usage: first.usage });
    await running.prompt("second prompt; keep this instruction");
    const saved = await store.read(first.id);
    expect(saved?.compaction).toBeDefined();
    expect(saved?.compaction?.anchorIndex).toBeGreaterThan(0);
    expect(summaryCalls).toBeGreaterThanOrEqual(2);

    const expected = await contextManager.build(
      [...(saved?.messages ?? []), { role: "user", content: "third prompt" }],
      { previous: saved?.compaction },
    );
    const resumedLlm = new FakeLLMClient([assistant("third answer")]);
    const resumed = new AgentSession({
      agent: agentOptions(resumedLlm), store, id: first.id, cwd: first.cwd, resumed: true,
      messages: saved?.messages, compaction: saved?.compaction,
      promptCount: saved?.promptCount, usage: saved?.usage,
    });
    await resumed.prompt("third prompt");
    expect(resumedLlm.requests[0]?.messages).toEqual(expected.messages);
    expect(resumedLlm.requests[0]?.messages.some((message) =>
      message.role === "user" && message.content === "second prompt; keep this instruction")).toBe(true);
  });

  it("keeps the error-ending transcript in memory and on disk for the next prompt", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    class FailsSecondRequest extends FakeLLMClient {
      private requestsSeen = 0;

      override async complete(request: Parameters<FakeLLMClient["complete"]>[0]) {
        this.requestsSeen += 1;
        if (this.requestsSeen === 2) {
          throw new Error("Provider temporarily unavailable");
        }
        return super.complete(request);
      }
    }
    const llm = new FailsSecondRequest([
      assistant("", [{ id: "tool-1", name: "echo", arguments: {} }]),
      assistant("Recovered answer."),
    ]);
    const session = createSession(llm, { store, id: "error-recovery" });

    await expect(session.prompt("Original prompt")).rejects.toThrow("temporarily unavailable");
    const persisted = await store.read("error-recovery");
    expect(persisted?.messages).toEqual(session.messages);
    expect(session.messages.map(message => message.role)).toEqual([
      "user", "assistant", "tool",
    ]);

    await session.prompt("Follow-up prompt");
    expect(llm.requests[1]?.messages).toEqual([
      ...persisted!.messages,
      { role: "user", content: "Follow-up prompt" },
    ]);
    expect((await store.read("error-recovery"))?.messages).toEqual(session.messages);
  });

  it("rejects overlapping prompts and clearing while a prompt is running", async () => {
    let notifyStart: (() => void) | undefined;
    let unblock: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStart = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    class GatedModel extends FakeLLMClient {
      override async complete(request: Parameters<FakeLLMClient["complete"]>[0]) {
        notifyStart?.();
        await blocked;
        return super.complete(request);
      }
    }

    const llm = new GatedModel([assistant("Answer."), assistant("Next answer.")]);
    const session = createSession(llm);
    const pending = session.prompt("First");
    await started;

    await expect(session.prompt("Second")).rejects.toThrow(/already running/);
    expect(() => session.clear()).toThrow(/while a prompt is running/);
    unblock?.();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    await session.prompt("Second");
    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "First" },
      { role: "assistant", content: "Answer.", toolCalls: [] },
      { role: "user", content: "Second" },
    ]);
  });

  it("keeps Agent results successful when persistence is unavailable", async () => {
    let appendCalls = 0;
    const unavailableStore: SessionStore = {
      async append() {
        appendCalls += 1;
        throw new Error("disk unavailable");
      },
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
      location() {
        return "/unavailable/session.jsonl";
      },
      async flush() {
        throw new Error("disk unavailable");
      },
    };
    const session = createSession(new FakeLLMClient([assistant("Answer.")]), {
      store: unavailableStore,
      id: "unavailable-session",
    });

    await expect(session.prompt("Question")).resolves.toMatchObject({
      status: "completed",
    });
    expect(session.messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer.", toolCalls: [] },
    ]);
    // A failed header disables event persistence for that run.
    expect(appendCalls).toBe(1);
  });
});

describe("FileSessionStore", () => {
  it("lists sessions for a workspace, newest first", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    for (const [id, cwd, prompt] of [
      ["session-a", "/workspace", "Question A"],
      ["session-b", "/elsewhere", "Question B"],
    ] as const) {
      const session = createSession(new FakeLLMClient([assistant("Answer.")]), {
        store,
        id,
        cwd,
      });
      await session.prompt(prompt);
    }

    const listed = await store.list({ cwd: "/workspace" });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "session-a",
      cwd: "/workspace",
      promptCount: 1,
      lastPrompt: "Question A",
    });
  });

  it("returns nothing for an unknown session or an empty home", async () => {
    const store = new FileSessionStore(await temporaryHome());

    await expect(store.read("missing-session")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects a session id that could escape the session directory", () => {
    const store = new FileSessionStore("/tmp/chivgent-home");

    expect(() => store.location("../../etc/passwd")).toThrow(
      "Invalid session id",
    );
  });

  it("ignores unparsable and non-session files", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    await mkdir(path.join(home, "sessions"), { recursive: true });
    await writeFile(path.join(home, "sessions", "broken.jsonl"), "{oops\n");
    await writeFile(path.join(home, "sessions", "notes.txt"), "ignored");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("recovers the write queue after an append fails", async () => {
    const home = await temporaryHome();
    const blockedHome = path.join(home, "blocked-home");
    await writeFile(blockedHome, "not a directory");
    const store = new FileSessionStore(blockedHome);
    const header = {
      type: "session" as const,
      version: 1,
      id: "session-a",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/workspace",
    };

    await expect(store.append("session-a", header)).rejects.toBeDefined();

    await rm(blockedHome);
    await mkdir(blockedHome);
    await expect(store.append("session-a", header)).resolves.toBeUndefined();
    await expect(store.flush()).resolves.toBeUndefined();

    const contents = await readFile(store.location("session-a"), "utf8");
    expect(contents.trim()).toBe(JSON.stringify(header));
  });

  it("keeps the last complete run when the file ends mid-line", () => {
    const transcript = parseTranscript(
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "session-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({ type: "agent_start", prompt: "Question", maxTurns: 8 }),
        JSON.stringify({
          type: "agent_end",
          status: "completed",
          turnCount: 1,
          messages: [{ role: "user", content: "Question" }],
        }),
        '{"type":"agent_start","prompt":"Truncat',
      ].join("\n"),
    );

    expect(transcript?.messages).toEqual([
      { role: "user", content: "Question" },
    ]);
    expect(transcript?.prompts).toEqual(["Question"]);
  });

  it("derives the session home from the environment", () => {
    expect(defaultSessionHome({ CHIVGENT_HOME: "/custom/home" })).toBe(
      "/custom/home",
    );
    expect(defaultSessionHome({})).toMatch(/\.chivgent$/);
  });

  it("creates sortable, filesystem-safe session ids", () => {
    const id = createSessionId(new Date("2026-08-25T17:38:00.000Z"));

    expect(id).toMatch(/^2026-08-25T17-38-00-000Z-[a-z0-9]+$/);
  });
});

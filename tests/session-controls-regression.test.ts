import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import { Compactor } from "../src/context/compaction.js";
import type { LLMClient, LLMResponse } from "../src/llm.js";
import { AgentSession } from "../src/session.js";
import { FileSessionStore, type SessionRecord, type SessionStore } from "../src/session-store.js";
import { handleSlashCommand } from "../src/repl.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace", ...readOnlyWorkspaceWrites,
  async readTextFile() { return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false }; },
  async listFiles() { return { entries: [], truncated: false }; },
  async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function prepared(compactorClient: LLMClient) {
  const home = await mkdtemp(path.join(os.tmpdir(), "chivgent-controls-"));
  directories.push(home);
  const store = new FileSessionStore(home);
  const contextManager = new ContextManager({ compactor: new Compactor(compactorClient) });
  const agent = { systemPrompt: "Follow user constraints", maxTurns: 3, workspace,
    tools: [], streaming: false, contextManager,
    llm: new FakeLLMClient([assistant("First answer"), assistant("Second answer"), assistant("Unexpected concurrent answer")]) };
  const session = new AgentSession({ agent, store, cwd: workspace.root });
  await session.prompt("Keep the public API stable.");
  await session.prompt("Inspect the next module.");
  return { session, store, agent };
}

describe("session control regression checks", () => {
  it("reports the currently selected model instead of the startup model", async () => {
    const { session } = await prepared(new FakeLLMClient([]));
    let output = "";
    handleSlashCommand("/status", {
      session, modelName: "startup-model", providerName: "startup-provider",
      write: text => { output += text; },
      providers: {
        provider: "active-provider", model: "active-model",
        describe: () => "", providerIds: () => [],
        select: async () => ({ ok: true, message: "" }),
        changeModel: async () => ({ ok: true, message: "" }),
        changeEndpoint: async () => ({ ok: true, message: "" }),
      },
    });
    expect(output).toContain("active-model");
    expect(output).toContain("active-provider");
    expect(output).not.toContain("startup-model");
  });

  it("persists manual compaction separately from the full transcript and uses it after resume", async () => {
    const summarizer = new FakeLLMClient([assistant('{"summary":"Keep the public API stable."}')]);
    const { session, store, agent } = await prepared(summarizer);
    const original = structuredClone(session.messages);
    await session.compact();
    const saved = await store.read(session.id);
    expect(saved?.messages).toEqual(original);
    expect(saved?.compaction?.state.summary).toContain("public API stable");
    expect(saved?.promptCount).toBe(2);
    expect(summarizer.requests).toHaveLength(1);
    const nextClient = new FakeLLMClient([assistant("Continued")]);
    const resumed = new AgentSession({ ...saved, id: session.id, cwd: workspace.root,
      resumed: true, store, agent: { ...agent, llm: nextClient } });
    await resumed.prompt("Continue the inspection.");
    const request = nextClient.requests[0]!;
    expect(request.messages.some(message => message.content === "First answer")).toBe(false);
    expect(request.messages.some(message => message.content.includes("public API stable"))).toBe(true);
    expect(request.messages.some(message => message.content === "Inspect the next module.")).toBe(true);
    expect(resumed.messages.slice(0, original.length)).toEqual(original);
  });

  it("keeps a valid checkpoint and accounts for usage when a later summary is empty", async () => {
    let calls = 0;
    const summarizer: LLMClient = {
      async complete() {
        calls += 1;
        return calls === 1
          ? { ...assistant('{"summary":"first valid summary"}'), usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
          : { ...assistant("  \n"), usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } };
      },
    };
    const { session, store, agent } = await prepared(summarizer);
    await session.compact();
    const checkpoint = session.compactionCheckpoint;
    await session.prompt("Continue after the checkpoint.");
    const transcript = structuredClone(session.messages);

    await expect(session.compact()).rejects.toThrow(/empty|summary/i);

    expect(session.compactionCheckpoint).toEqual(checkpoint);
    expect(session.messages).toEqual(transcript);
    expect(session.usage?.usage.totalTokens).toBe(35);
    const saved = await store.read(session.id);
    expect(saved?.compaction).toEqual(checkpoint);
    expect(saved?.usage?.usage.totalTokens).toBe(35);
    const resumed = new AgentSession({ ...saved!, id: session.id, cwd: workspace.root, resumed: true, store, agent });
    expect(resumed.compactionCheckpoint).toEqual(checkpoint);
    expect(resumed.usage?.usage.totalTokens).toBe(35);
  });

  it("keeps the previous checkpoint and records overflow usage across session resume", async () => {
    let calls = 0;
    const summarizer: LLMClient = {
      async complete() {
        calls += 1;
        const pendingTasks = calls === 1
          ? Array.from({ length: 32 }, (_, index) => `old-${index}`)
          : ["new-task"];
        const usage = calls === 1
          ? { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
          : { inputTokens: 20, outputTokens: 3, totalTokens: 23 };
        return { ...assistant(JSON.stringify({ summary: `summary ${calls}`, pendingTasks })), usage };
      },
    };
    const { session, store, agent } = await prepared(summarizer);
    await session.compact();
    const checkpoint = structuredClone(session.compactionCheckpoint);
    expect(checkpoint?.state.pendingTasks).toHaveLength(32);
    await session.prompt("Record one more unfinished item.");
    const transcript = structuredClone(session.messages);

    await expect(session.compact()).rejects.toThrow(/pending/i);

    expect(session.compactionCheckpoint).toEqual(checkpoint);
    expect(session.messages).toEqual(transcript);
    expect(session.usage?.usage.totalTokens).toBe(35);
    const saved = await store.read(session.id);
    expect(saved?.compaction).toEqual(checkpoint);
    expect(saved?.usage?.usage.totalTokens).toBe(35);
    const resumed = new AgentSession({ ...saved!, id: session.id, cwd: workspace.root, resumed: true, store, agent });
    expect(resumed.compactionCheckpoint).toEqual(checkpoint);
    expect(resumed.usage?.usage.totalTokens).toBe(35);
  });

  it("roundtrips legacy decision checkpoints and carries explicit replacements through resume", async () => {
    const oldDecision = "Use API v1";
    const newDecision = "Use API v2";
    const summarizer = new FakeLLMClient([
      assistant(JSON.stringify({ summary: "Old choice", decisions: [oldDecision], pendingTasks: [] })),
      assistant(JSON.stringify({
        summary: "The user explicitly replaced API v1 with API v2.",
        decisions: [newDecision],
        supersededDecisions: [oldDecision],
        pendingTasks: [],
      })),
    ]);
    const { session, store, agent } = await prepared(summarizer);

    await session.compact();
    const legacyCheckpoint = await store.read(session.id);
    expect(legacyCheckpoint?.compaction?.state.decisions).toEqual([oldDecision]);
    expect(Object.hasOwn(legacyCheckpoint?.compaction?.state ?? {}, "supersededDecisions")).toBe(false);

    await session.prompt("The user explicitly replaces API v1 with API v2.");
    await session.compact();
    const updatedCheckpoint = await store.read(session.id);
    expect(updatedCheckpoint?.compaction?.state.decisions).toEqual([newDecision]);
    expect(Object.hasOwn(updatedCheckpoint?.compaction?.state ?? {}, "supersededDecisions")).toBe(false);
    expect(summarizer.requests[1]?.systemPrompt).toContain("supersededDecisions");
    expect(summarizer.requests[1]?.systemPrompt).toContain("omission or [] means no prior decision is revoked.");

    const legacyClient = new FakeLLMClient([assistant("Legacy checkpoint loaded")]);
    const legacyResume = new AgentSession({ ...legacyCheckpoint, id: session.id, cwd: workspace.root,
      resumed: true, agent: { ...agent, llm: legacyClient } });
    await legacyResume.prompt("Continue with the old checkpoint.");
    const legacyRequest = JSON.stringify(legacyClient.requests[0]?.messages);
    expect(legacyRequest).toContain(oldDecision);

    const updatedClient = new FakeLLMClient([assistant("Use the current rule")]);
    const updatedResume = new AgentSession({ ...updatedCheckpoint, id: session.id, cwd: workspace.root,
      resumed: true, agent: { ...agent, llm: updatedClient } });
    await updatedResume.prompt("Continue with the updated checkpoint.");
    const updatedRequest = JSON.stringify(updatedClient.requests[0]?.messages);
    expect(updatedRequest).toContain(newDecision);
    expect(updatedRequest).not.toContain(oldDecision);
  });

  it("does not pay for another summary when no new history can be compacted", async () => {
    const summarizer = new FakeLLMClient([assistant('{"summary":"First summary"}'), assistant('{"summary":"Unnecessary summary"}')]);
    const { session, store } = await prepared(summarizer);
    await session.compact();
    const checkpoint = (await store.read(session.id))?.compaction;
    await session.compact();
    expect(summarizer.requests).toHaveLength(1);
    expect((await store.read(session.id))?.compaction).toEqual(checkpoint);
  });

  it("rejects a late summary after cancellation even if the provider ignores the signal", async () => {
    const controller = new AbortController();
    const { session, store } = await prepared({ async complete() {
      controller.abort();
      return assistant('{"summary":"Must not be installed"}');
    } });
    const before = structuredClone(session.messages);
    await expect(session.compact(controller.signal)).rejects.toThrow(/cancel|abort/i);
    expect(session.messages).toEqual(before);
    expect((await store.read(session.id))?.compaction).toBeUndefined();
  });

  it("keeps the old checkpoint and paid usage when cancellation arrives before checkpoint append", async () => {
    const previous = {
      state: { summary: "Old checkpoint", readFiles: [], modifiedFiles: [], decisions: [], pendingTasks: [] },
      splitIndex: 0,
    };
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    let releaseHeader!: () => void;
    let notifyHeaderStarted!: () => void;
    const headerStarted = new Promise<void>(resolve => { notifyHeaderStarted = resolve; });
    const headerGate = new Promise<void>(resolve => { releaseHeader = resolve; });
    const records: SessionRecord[] = [];
    const store: SessionStore = {
      async append(_id, record) {
        records.push(record);
        if (record.type === "session") {
          notifyHeaderStarted();
          await headerGate;
        }
      },
      async read() { return undefined; },
      async list() { return []; },
      location() { return "memory"; },
    };
    const agent = {
      systemPrompt: "Follow user constraints", maxTurns: 1, workspace, tools: [], streaming: false,
      contextManager: new ContextManager({ compactor: new Compactor({ async complete() {
        return { ...assistant('{"summary":"New checkpoint"}'), usage };
      } }) }),
      llm: new FakeLLMClient([]),
    };
    const session = new AgentSession({
      id: "cancel-before-checkpoint", agent, store, cwd: workspace.root,
      messages: [
        { role: "user", content: "older request" }, { role: "assistant", content: "older answer", toolCalls: [] },
        { role: "user", content: "latest request" },
      ],
      compaction: previous,
    });
    const controller = new AbortController();
    const pending = session.compact(controller.signal);
    await headerStarted;
    controller.abort();
    releaseHeader();

    await expect(pending).rejects.toThrow(/cancel|abort/i);
    expect(session.compactionCheckpoint).toEqual(previous);
    expect(session.usage?.usage).toEqual(usage);
    expect(records.some(record => record.type === "session_compaction")).toBe(false);
    expect(records.some(record => record.type === "session_usage")).toBe(true);
  });

  it("locks the transcript while a manual summary is in flight and releases it afterwards", async () => {
    let finish!: (value: LLMResponse) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const { session } = await prepared({ async complete() {
      notifyStarted();
      return new Promise<LLMResponse>(resolve => { finish = resolve; });
    } });
    const pending = session.compact();
    await started;
    try {
      await expect(session.prompt("Do not race the summary")).rejects.toThrow();
      expect(() => session.clear()).toThrow();
      await expect(session.setPlanMode(true)).rejects.toThrow();
    } finally {
      finish(assistant('{"summary":"Saved history"}'));
      await pending;
    }
    await expect(session.setPlanMode(true)).resolves.toBeUndefined();
    expect(session.planMode).toBe(true);
  });
});

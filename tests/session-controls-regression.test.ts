import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextManager } from "../src/context/context-manager.js";
import { Compactor } from "../src/context/compaction.js";
import type { LLMClient, LLMResponse } from "../src/llm.js";
import { AgentSession } from "../src/session.js";
import { FileSessionStore } from "../src/session-store.js";
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

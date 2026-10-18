import { mkdtempSync, mkdirSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopSession } from "@chivgent/runtime/desktop-runtime.ts";
import type { LLMRequest } from "@chivgent/llm.ts";
import { HostService, type HostServiceOptions } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chivgent-runtime-test-")));
  temporaryRoots.push(root);
  return root;
}

function fixture() {
  const root = temporaryProject();
  const first = join(root, "first project 中文");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "facts.txt"), "first-project-fact\n");
  writeFileSync(join(second, "facts.txt"), "second-project-fact\n");
  writeFileSync(join(root, "outside.txt"), "outside-secret\n");
  symlinkSync(join(root, "outside.txt"), join(first, "escape.txt"));
  const messages: HostToMain[] = [];
  const requests: LLMRequest[] = [];
  let call = 0;
  const service = new HostService({
    send: (message) => messages.push(message),
    createAgent: () => { throw new Error("The real path must never fall back to the demo."); },
    createSession: async (cwd, provider, model, history) => {
      const result = await createDesktopSession({
        cwd, provider, model, messages: history,
        environment: { CHIVGENT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "fixture-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1" },
        authFile: join(root, "absent-auth.json"),
        createClient: () => ({ async complete(request) {
          requests.push({ ...request, messages: structuredClone(request.messages) });
          const last = request.messages.at(-1);
          if (last?.role === "tool") {
            return { message: { role: "assistant", content: last.content, toolCalls: [] } };
          }
          const prompt = last?.role === "user" ? last.content : "";
          const path = prompt === "escape" ? "../outside.txt" : prompt === "symlink" ? "escape.txt" : "facts.txt";
          return { message: { role: "assistant", content: "Reading selected project.", toolCalls: [{
            id: `read-${++call}`, name: "read_file", arguments: { path, start_line: 1, line_count: 20 },
          }] } };
        } }),
      });
      expect(result.session.toolNames.slice().sort()).toEqual(["list_files", "read_file", "search_text", "update_plan"]);
      return result;
    },
  });
  return { root, first, second, messages, requests, service };
}

async function select(service: HostService, messages: HostToMain[], path: string, requestId = "project") {
  service.handle({ type: "select-project", requestId, path });
  await until(() => messages.some((item) => item.type === "project-selected" && item.requestId === requestId));
}

async function run(service: HostService, messages: HostToMain[], requestId: string, prompt: string, model = "fixture-model") {
  service.handle({ type: "start", requestId, prompt, provider: "openai-compatible", model });
  const started = messages.find((item) => item.type === "started" && item.requestId === requestId);
  expect(started?.type).toBe("started");
  if (started?.type !== "started") throw new Error(`Start rejected: ${JSON.stringify(messages.at(-1))}`);
  await until(() => messages.some((item) => item.type === "event" && item.runId === started.runId && item.event.type === "agent_end"));
  await new Promise(setImmediate);
  return messages.filter((item) => item.type === "event" && item.runId === started.runId);
}

describe("desktop real runtime", () => {
  it("reads the selected project's bytes and rejects traversal and symlink escapes with no writes", async () => {
    const f = fixture();
    await select(f.service, f.messages, f.first);
    const read = await run(f.service, f.messages, "read", "read project");
    expect(read).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "tool_execution_end", content: expect.stringContaining("first-project-fact"), isError: false,
    }) }));
    for (const prompt of ["escape", "symlink"]) {
      const events = await run(f.service, f.messages, prompt, prompt);
      expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
        type: "tool_execution_end", content: expect.stringContaining("escapes the workspace"), isError: true,
      }) }));
      expect(JSON.stringify(events)).not.toContain("outside-secret");
    }
    expect(readdirSync(f.first).sort()).toEqual(["escape.txt", "facts.txt"]);
    expect(readdirSync(f.root).sort()).toEqual(["first project 中文", "outside.txt", "second"]);
    await f.service.shutdown();
  });

  it("keeps context when changing model and clears it when selecting a different project", async () => {
    const f = fixture();
    await select(f.service, f.messages, f.first);
    await run(f.service, f.messages, "first", "remember this project");
    await run(f.service, f.messages, "next", "follow up", "different-model");
    expect(f.requests.at(-2)?.messages).toContainEqual(expect.objectContaining({ role: "user", content: "remember this project" }));
    expect(JSON.stringify(f.requests.at(-2)?.messages)).toContain("first-project-fact");
    await select(f.service, f.messages, f.second, "project-second");
    const second = await run(f.service, f.messages, "second", "read second project");
    expect(JSON.stringify(f.requests.at(-2)?.messages)).not.toContain("remember this project");
    expect(JSON.stringify(second)).toContain("second-project-fact");
    expect(JSON.stringify(second)).not.toContain("first-project-fact");
    await f.service.shutdown();
  });

  it("replays an identical start and rejects changed model or project under the same requestId", async () => {
    const f = fixture();
    await select(f.service, f.messages, f.first);
    await run(f.service, f.messages, "same", "read");
    const calls = f.requests.length;
    f.service.handle({ type: "start", requestId: "same", prompt: "read", provider: "openai-compatible", model: "fixture-model" });
    expect(f.messages.at(-1)).toMatchObject({ type: "started", replayed: true });
    expect(f.requests.length).toBe(calls);
    f.service.handle({ type: "start", requestId: "same", prompt: "read", provider: "openai-compatible", model: "changed" });
    expect(f.messages.at(-1)).toMatchObject({ type: "error", code: "request_conflict" });
    await select(f.service, f.messages, f.second, "new-project");
    f.service.handle({ type: "start", requestId: "same", prompt: "read", provider: "openai-compatible", model: "fixture-model" });
    expect(f.messages.at(-1)).toMatchObject({ type: "error", code: "request_conflict" });
    await f.service.shutdown();
  });

  it("reports missing credentials without touching the auth directory or constructing a Provider", async () => {
    const cwd = temporaryProject();
    let constructed = false;
    await expect(createDesktopSession({ cwd, provider: "openai", environment: {}, authFile: join(cwd, "auth.json"),
      createClient: () => { constructed = true; throw new Error("No key must mean no Provider."); },
    })).rejects.toThrow("API key");
    expect(constructed).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("does not forward an OpenAI startup key when switching to a compatible endpoint", async () => {
    const cwd = temporaryProject();
    const authFile = join(cwd, "auth.json");
    const environment = { OPENAI_API_KEY: "openai-only-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1" };
    let selectedKey: string | undefined;
    const createClient = (config: { apiKey: string }) => {
      selectedKey = config.apiKey;
      return { async complete() { return { message: { role: "assistant" as const, content: "", toolCalls: [] } }; } };
    };
    const config = { cwd, provider: "openai-compatible", model: "fixture", environment, authFile, createClient };
    await expect(createDesktopSession(config)).rejects.toThrow("API key");
    expect(selectedKey).toBeUndefined();
    writeFileSync(authFile, JSON.stringify({ "openai-compatible": "compatible-only-key" }));
    await createDesktopSession(config);
    expect(selectedKey).toBe("compatible-only-key");
  });

  it("cancels initialization immediately and ignores a late factory result after switching projects", async () => {
    const first = temporaryProject();
    const second = temporaryProject();
    const messages: HostToMain[] = [];
    const resolvers: Array<(value: Awaited<ReturnType<NonNullable<HostServiceOptions["createSession"]>>>) => void> = [];
    const prompted: string[] = [];
    let attempts = 0;
    const service = new HostService({
      send: (message) => messages.push(message),
      createAgent: () => { throw new Error("No fallback"); },
      createSession: async () => {
        if (++attempts === 1) throw new Error("initialization failed");
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });
    await select(service, messages, first);
    service.handle({ type: "start", requestId: "failed", prompt: "first" });
    await until(() => messages.some((item) => item.type === "error" && item.requestId === "failed"));
    await new Promise(setImmediate);
    service.handle({ type: "start", requestId: "cancel", prompt: "second" });
    const started = messages.find((item) => item.type === "started" && item.requestId === "cancel");
    expect(started?.type).toBe("started");
    if (started?.type !== "started") throw new Error("Initialization retry was rejected");
    service.handle({ type: "select-project", requestId: "busy-project", path: second });
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "busy" });
    service.handle({ type: "interrupt", requestId: "stop", runId: started.runId });
    await until(() => messages.some((item) => item.type === "error" && item.requestId === "cancel" && item.code === "cancelled"));
    await new Promise(setImmediate);
    await select(service, messages, second, "after-stop-project");
    resolvers[0]!({ provider: "openai", model: "late", session: {
      messages: [], subscribe: () => () => {}, prompt: async (text) => { prompted.push(text); },
    } });
    await new Promise(setImmediate);
    expect(messages.some((item) => item.type === "runtime-config" && item.model === "late")).toBe(false);
    service.handle({ type: "start", requestId: "after", prompt: "new project" });
    expect(attempts).toBe(3);
    // This late factory is cancelled by shutdown below; neither factory may run a prompt.
    await service.shutdown();
    resolvers[1]!({ provider: "openai", model: "after-shutdown", session: {
      messages: [], subscribe: () => () => {}, prompt: async (text) => { prompted.push(text); },
    } });
    await new Promise(setImmediate);
    expect(prompted).toEqual([]);
  });
  it("exposes startup Provider and compatible endpoint before any prompt, without URL credentials", () => {
    const messages: HostToMain[] = [];
    const service = new HostService({
      send: (message) => messages.push(message),
      createAgent: () => { throw new Error("not used"); },
      defaultProvider: "openai-compatible",
      compatibleBaseURL: "https://user:password@proxy.example.test/v1?token=secret",
    });
    service.handle({ type: "initialize", requestId: "boot" });
    expect(messages[0]).toMatchObject({
      type: "initialized",
      defaultProvider: "openai-compatible",
      compatibleBaseURL: "https://proxy.example.test/v1",
    });
    expect(JSON.stringify(messages[0])).not.toContain("password");
    expect(JSON.stringify(messages[0])).not.toContain("secret");
  });

  it("keeps accepting real project prompts after the 100-request demo limit", async () => {
    const first = temporaryProject();
    const second = temporaryProject();
    const messages: HostToMain[] = [];
    const service = new HostService({
      send: (message) => messages.push(message),
      createAgent: () => { throw new Error("demo fallback"); },
      createSession: async () => ({
        provider: "openai", model: "fixture",
        session: { messages: [], subscribe: () => () => {}, prompt: async () => {} },
      }),
    });
    await select(service, messages, first);
    for (let i = 0; i < 105; i++) {
      service.handle({ type: "start", requestId: `prompt-${i}`, prompt: "hello" });
      await new Promise(setImmediate);
    }
    await select(service, messages, second, "switch-project");
    service.handle({ type: "start", requestId: "after-switch", prompt: "still works" });
    await new Promise(setImmediate);
    expect(messages.filter((message) => message.type === "started")).toHaveLength(106);
    expect(messages.some((message) => message.type === "error" && message.code === "request_log_full")).toBe(false);
    await service.shutdown();
  });

});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected host event did not arrive.");
}

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
          if (prompt === "question") {
            return { message: { role: "assistant", content: "", toolCalls: [{
              id: `question-${++call}`, name: "question", arguments: { questions: [{
                id: "choice", header: "Approach", question: "Which approach?", options: [{ label: "Fast" }, { label: "Careful" }],
              }] },
            }] } };
          }
          const path = prompt === "escape" ? "../outside.txt" : prompt === "symlink" ? "escape.txt" : "facts.txt";
          return { message: { role: "assistant", content: "Reading selected project.", toolCalls: [{
            id: `read-${++call}`, name: "read_file", arguments: { path, start_line: 1, line_count: 20 },
          }] } };
        } }),
      });
      expect(result.session.toolNames.slice().sort()).toEqual(["list_files", "question", "read_file", "search_text", "update_plan"]);
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

  it("returns an immediate unavailable result without waiting for UI or adding capabilities", async () => {
    const f = fixture();
    await select(f.service, f.messages, f.first);
    const events = await run(f.service, f.messages, "desktop-question", "question");

    const firstRequest = f.requests[0];
    expect(firstRequest?.tools.map(tool => tool.name).sort()).toEqual([
      "list_files", "question", "read_file", "search_text", "update_plan",
    ]);
    expect(firstRequest?.tools.map(tool => tool.name)).not.toContain("bash");
    expect(firstRequest?.tools.map(tool => tool.name)).not.toContain("write_file");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool", toolName: "question", isError: true,
      content: expect.stringContaining("unavailable"),
    });
    expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "tool_execution_end", toolName: "question", isError: true, content: expect.stringContaining("unavailable"),
    }) }));
    expect(events.at(-1)).toMatchObject({ event: { type: "agent_end", status: "completed" } });
    await f.service.shutdown();
  });

  it("keeps context when changing model and clears it when selecting a different project", async () => {
    const f = fixture();
    await select(f.service, f.messages, f.first);
    await run(f.service, f.messages, "first", "remember this project");
    expect(f.requests[0]?.systemPrompt).toContain('"provider":"openai-compatible","model":"fixture-model"');
    await run(f.service, f.messages, "next", "follow up", "different-model");
    expect(f.requests.at(-2)?.systemPrompt).toContain('"provider":"openai-compatible","model":"different-model"');
    expect(f.requests.at(-2)?.systemPrompt).not.toContain("fixture-model");
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

  it("keeps every accepted request id for the real createSession path", async () => {
    const f = fixture();
    await select(f.service, f.messages, f.first);
    for (let index = 0; index < 100; index += 1) {
      await run(f.service, f.messages, `request-${index}`, `prompt-${index}`);
    }
    const calls = f.requests.length;
    f.service.handle({ type: "start", requestId: "request-100", prompt: "prompt-100", provider: "openai-compatible", model: "fixture-model" });
    expect(f.messages.at(-1)).toMatchObject({ type: "error", code: "request_log_full" });
    f.service.handle({ type: "start", requestId: "request-0", prompt: "prompt-0", provider: "openai-compatible", model: "fixture-model" });
    expect(f.messages.at(-1)).toMatchObject({ type: "started", requestId: "request-0", replayed: true });
    expect(f.requests.length).toBe(calls);
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

  it("never forwards a compatible startup key to the OpenAI API after switching providers", async () => {
    const cwd = temporaryProject();
    const authFile = join(cwd, "auth.json");
    const environment = {
      CHIVGENT_PROVIDER: "openai-compatible",
      OPENAI_BASE_URL: "https://private.example.test/v1",
      OPENAI_API_KEY: "private-endpoint-key",
    };
    const keys: string[] = [];
    const createClient = ({ apiKey }: { apiKey: string }) => {
      keys.push(apiKey);
      return { async complete() { return { message: { role: "assistant" as const, content: "", toolCalls: [] } }; } };
    };
    const config = { cwd, provider: "openai", environment, authFile, createClient };
    await expect(createDesktopSession(config)).rejects.toThrow("API key");
    expect(keys).toEqual([]);
    writeFileSync(authFile, JSON.stringify({ openai: "openai-only-key" }));
    await createDesktopSession(config);
    expect(keys).toEqual(["openai-only-key"]);
    keys.length = 0;
    await createDesktopSession({ ...config, provider: "openai-compatible", model: "compatible-model" });
    expect(keys).toEqual(["private-endpoint-key"]);
  });

  it("passes a compacted conversation checkpoint into a replacement model session", async () => {
    const root = temporaryProject();
    const outbound: HostToMain[] = [];
    const handoffs: unknown[] = [];
    const checkpoint = { state: {
      summary: "important-compacted-decision", readFiles: ["facts.txt"],
      modifiedFiles: [], decisions: ["Do not overwrite."], pendingTasks: ["Explain the entry point."],
    }, splitIndex: 1 };
    const service = new HostService({
      send: (event) => outbound.push(event),
      createAgent: () => { throw new Error("real path only"); },
      createSession: async (...args) => {
        handoffs.push((args as unknown[])[4]);
        return { provider: "openai", model: String(args[2]), session: {
          messages: [{ role: "user" as const, content: "original user message" }],
          compactionCheckpoint: checkpoint,
          subscribe: () => () => {},
          prompt: async () => {},
        } };
      },
    });
    await select(service, outbound, root);
    service.handle({ type: "start", requestId: "first-model", prompt: "hello", model: "model-a" });
    await until(() => outbound.some((e) => e.type === "runtime-config" && e.model === "model-a"));
    await new Promise(setImmediate);
    service.handle({ type: "start", requestId: "second-model", prompt: "continue", model: "model-b" });
    await until(() => outbound.some((e) => e.type === "runtime-config" && e.model === "model-b"));
    expect(handoffs[1]).toEqual(checkpoint);
    await service.shutdown();

    // A real AgentSession/ContextManager should use the checkpoint rather than replay the discarded prose.
    const requests: LLMRequest[] = [];
    const config = { cwd: root, provider: "openai-compatible", model: "fixture",
      environment: { CHIVGENT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "http://127.0.0.1:1/v1" },
      authFile: join(root, "absent.json"),
      messages: [{ role: "user" as const, content: "discarded original prose" }, { role: "assistant" as const, content: "answer", toolCalls: [] }],
      compaction: checkpoint,
      createClient: () => ({ async complete(request: LLMRequest) {
        requests.push(request);
        return { message: { role: "assistant" as const, content: "done", toolCalls: [] } };
      } }),
    };
    const runtime = await createDesktopSession(config as unknown as Parameters<typeof createDesktopSession>[0]);
    await runtime.session.prompt("continue");
    expect(JSON.stringify(requests[0]?.messages)).toContain("important-compacted-decision");
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("discarded original prose");
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

  it("retains real request ids and refuses starts after the 100-request limit", async () => {
    const first = temporaryProject();
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
    for (let i = 0; i < 100; i++) {
      service.handle({ type: "start", requestId: `prompt-${i}`, prompt: "hello" });
      await new Promise(setImmediate);
    }
    service.handle({ type: "start", requestId: "overflow", prompt: "must be refused" });
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "request_log_full" });
    const beforeReplay = messages.length;
    service.handle({ type: "start", requestId: "prompt-0", prompt: "hello" });
    expect(messages.at(-1)).toMatchObject({ type: "started", requestId: "prompt-0", replayed: true });
    expect(messages.length).toBe(beforeReplay + 1);
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

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMAbortError, type LLMRequest } from "../src/llm.js";
import { runRepl } from "../src/repl.js";
import { AgentSession } from "../src/session.js";
import { LocalWorkspace } from "../src/workspace.js";
import { createLiveRegion } from "../src/tui/live.js";
import { TuiInput } from "../src/tui/input.js";
import { displayWidth, fitLine, fitLineTail, terminalText } from "../src/tui/text.js";
import { welcome } from "../src/tui/welcome.js";

afterEach(() => vi.unstubAllEnvs());

class Input extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(enabled: boolean) { this.raw = enabled; return this; }
}

it("fits terminal cells without splitting graphemes or executing controls", () => {
  expect(fitLine("中文测试", 5)).toBe("中文…");
  expect(fitLine("👩‍💻👩‍💻x", 3)).toBe("👩‍💻…");
  expect(fitLine("e\u0301e\u0301xy", 3)).toBe("e\u0301e\u0301…");
  expect(fitLine("hello", 1)).toBe("…");
  expect(fitLine("hello", 0)).toBe("");
  expect(terminalText("\x1b[2Jhello\r\nworld\x07")).toBe("hello\nworld");
  expect(fitLine("a\tb\rc\n", 20)).not.toMatch(/[\t\r\n]/);
  expect(fitLineTail("前面👩‍💻结尾", 7)).toBe("…👩‍💻结尾");
  expect(fitLineTail("hello", 1)).toBe("…");
  expect(fitLineTail("\x1b[2Jold/new", 5)).toBe("…/new");
});

it("keeps the welcome panel within very narrow and Unicode terminal widths", () => {
  for (const width of [5, 12, 30, 80, 140]) {
    const banner = welcome({ version: "test", provider: "demo", model: "模型😀", cwd: "/项目/测试", resumed: true, signedOut: true, width });
    expect(banner.split("\n").every((line) => displayWidth(line) < width)).toBe(true);
  }
});

it("shows a compact wordmark without a session id", () => {
  const banner = welcome({ version: "test", provider: "openai", model: "gpt-test", cwd: "/project", resumed: false, signedOut: true, width: 80 });
  expect(banner).toContain("Start with /provider");
  expect(banner).not.toContain("╭");
  expect(banner).not.toContain("demo");
  expect(banner.split("\n").filter(Boolean)).toHaveLength(8);
  expect(welcome({ version: "test", provider: "openai", model: "gpt-test", cwd: "/project", resumed: false, signedOut: true, width: 80, color: true }))
    .toContain("\u001b[1;36m");
});

it("keeps the workspace name visible when the welcome path is long", () => {
  const banner = welcome({ version: "test", provider: "demo", model: "model", cwd: "/very/long/parent/directory/chivgent", resumed: false, signedOut: false, width: 40 });
  expect(banner).toContain("chivgent");
  expect(banner).toContain("…");
});

it("keeps reading Ctrl+C while dropping busy input and restores raw mode", async () => {
  const source = new Input();
  const gate = new TuiInput(source);
  let received = "";
  gate.on("data", (chunk) => { received += chunk.toString(); });
  gate.setRawMode(true);
  source.write("hello");
  gate.setBusy(true);
  source.write("ignored\n");
  source.write(Buffer.from("ignored\x03more"));
  gate.setBusy(false);
  source.write("again");
  expect(received).toBe("hello\x03again");
  gate.dispose();
  expect(source.raw).toBe(false);
  expect(source.listenerCount("data")).toBe(0);
});

it("latches submission across chunks and consumes a split CRLF only once", () => {
  const source = new Input();
  const gate = new TuiInput(source);
  let received = "";
  gate.on("data", (chunk) => { received += chunk.toString(); });
  try {
    source.write("first\r");
    source.write("queued\r");
    expect(received).toBe("first\r");
    gate.acceptLine();
    source.write("second\r");
    gate.acceptLine();
    source.write("\nthird\r\nfourth\n");
    source.write("also queued\n");
    expect(received).toBe("first\rsecond\rthird\r");
    gate.acceptLine();
    source.write("final\n");
    expect(received).toBe("first\rsecond\rthird\rfinal\n");
  } finally { gate.dispose(); }
});

describe("TUI REPL", () => {
  it("exits on Ctrl+C while idle", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true });
    try {
      input.write("\x03");
      expect(await result).toBe(130);
      expect(input.raw).toBe(false);
    } finally { input.end(); await result; }
  });

  it("does not open suggestions for a pasted complete command", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true });
    try {
      input.write("/session\r");
      await vi.waitFor(() => expect(screen).toContain("workspace:"));
      expect(screen).not.toContain("/provider");
      input.write("/exit\r");
      expect(await result).toBe(0);
    } finally { input.end(); await result; }
  });

  it("shows slash commands on / without changing the draft", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      extensionCommands: [{ name: "inspect", description: "Inspect the session", source: "test",
        run: () => undefined }],
    });
    try {
      input.write("/");
      await vi.waitFor(() => expect(screen).toContain("/provider"));
      expect(screen).toContain("/model");
      expect(screen).toContain("/inspect");
      input.write("help\r");
      await vi.waitFor(() => expect(screen).toContain("Commands:"));
      expect(session.turns).toBe(0);
      input.write("/exit\r");
      expect(await result).toBe(0);
    } finally { input.end(); await result; }
  });

  it("exits cleanly when Ctrl+D closes the API key prompt", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: { provider: "openai", authFile: "/unused", ready: () => false,
        submit: async () => { throw new Error("Key should not be submitted"); } },
    });
    try {
      input.write("/login\r");
      await vi.waitFor(() => expect(screen).toContain("API key for openai"));
      input.write("\x04");
      expect(await result).toBe(0);
      expect(input.raw).toBe(false);
    } finally { input.end(); await result; }
  });

  it("exits on Ctrl+C at the API key prompt without saving a key", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: { provider: "openai", authFile: "/unused", ready: () => false,
        submit: async () => { throw new Error("Key should not be submitted"); } },
    });
    try {
      input.write("/login\r");
      await vi.waitFor(() => expect(screen).toContain("API key for openai"));
      input.write("partial-secret");
      input.write("\x03");
      expect(await result).toBe(130);
      expect(screen).not.toContain("partial-secret");
      expect(input.raw).toBe(false);
    } finally { input.end(); await result; }
  });

  it("switches the login target and model without leaving the session", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const submitted: string[] = [];
    let provider = "openai";
    let model = "initial";
    let connected = true;
    const control = {
      get provider() { return provider; },
      get model() { return model; },
      authFile: "/unused",
      ready: () => connected,
      submit: async (key: string) => { submitted.push(`${provider}:${key}`); connected = true; return undefined; },
      describe: () => "openai · deepseek\n",
      providerIds: () => ["openai", "deepseek"],
      select: async (argument: string) => {
        provider = argument;
        connected = provider === "openai";
        return { ok: true, message: `Selected ${provider}\n` };
      },
      changeModel: async (value: string) => {
        model = value;
        return { ok: true, message: `Selected model ${model}\n` };
      },
      changeEndpoint: async () => ({ ok: true, message: "endpoint changed\n" }),
    };
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: control, providers: control });
    try {
      input.write("/provider\r");
      await vi.waitFor(() => expect(screen).toContain("○ deepseek"));
      input.write("\u001b[B\r");
      await vi.waitFor(() => expect(screen).toContain("API key for deepseek"));
      input.write("secret-for-test\r");
      await vi.waitFor(() => expect(submitted).toEqual(["deepseek:secret-for-test"]));
      expect(screen).not.toContain("secret-for-test");
      expect(screen).not.toContain("› /login");
      input.write("/model next-model\r");
      await vi.waitFor(() => expect(screen).toContain("Selected model next-model"));
      input.write("/exit\r");
      expect(await result).toBe(0);
    } finally { input.end(); await result; }
  });

  it("skips the API key prompt when a selected Provider already has credentials", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    let provider = "openai";
    const control = {
      get provider() { return provider; }, model: "model",
      authFile: "/unused", ready: () => true, needsApiKey: async () => false,
      submit: async () => { throw new Error("No key should be requested"); },
      describe: () => "providers\n", providerIds: () => ["openai", "deepseek"],
      select: async (id: string) => { provider = id; return { ok: true, message: `Selected ${id}\n` }; },
      changeModel: async () => ({ ok: true, message: "model changed\n" }),
      changeEndpoint: async () => ({ ok: true, message: "endpoint changed\n" }),
    };
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: control, providers: control });
    try {
      input.write("/provider deepseek\r");
      await vi.waitFor(() => expect(screen).toContain("Selected deepseek"));
      expect(screen).not.toContain("API key for deepseek");
      input.write("/exit\r");
      expect(await result).toBe(0);
    } finally { input.end(); await result; }
  });

  it("keeps /login entry hidden and restores the prompt afterwards", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const submitted: string[] = [];
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: { provider: "demo", authFile: "/unused", ready: () => false,
        submit: async (key) => { submitted.push(key); return undefined; },
      },
    });
    try {
      input.write("/login\r");
      await vi.waitFor(() => expect(screen).toContain("API key for demo"));
      input.write("/demo-key-no-network\r");
      await vi.waitFor(() => expect(screen).toContain("Stored the key"));
      expect(submitted).toEqual(["/demo-key-no-network"]);
      expect(screen).not.toContain("/demo-key-no-network");
      input.write("/exit\r");
      expect(await result).toBe(0);
      expect(input.raw).toBe(false);
    } finally {
      input.end();
      await result;
    }
  });

  it("completes commands, cancels a run, ignores busy typing, and accepts another prompt", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const requests: string[] = [];
    let running = false;
    const session = new AgentSession({ cwd: process.cwd(), agent: {
      systemPrompt: "demo", maxTurns: 3, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete(request: LLMRequest) {
        requests.push(request.messages.at(-1)?.content ?? "");
        if (requests.length === 1) {
          running = true;
          await new Promise<void>((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(new LLMAbortError()), { once: true });
          });
        }
        return { message: { role: "assistant" as const, content: "answer", toolCalls: [] } };
      } },
    } });
    const region = createLiveRegion({ stream: output, width: () => 80 });
    session.subscribe(region.listener);
    const result = runRepl({ session, input, output, stderr: output, tui: true });
    try {
      input.write("/he");
      input.write("\t");
      input.write("\r");
      await vi.waitFor(() => expect(screen).toContain("Commands:"));
      input.write("first\r");
      await vi.waitFor(() => expect(running).toBe(true));
      input.write("DO_NOT_ECHO\r");
      expect(screen).not.toContain("DO_NOT_ECHO");
      input.write("\x03");
      await vi.waitFor(() => expect(screen).toContain("Stopped"));
      input.write("second\r");
      await vi.waitFor(() => expect(screen).toContain("Completed"));
      expect(requests).toEqual(["first", "second"]);
      input.write("\x04");
      expect(await result).toBe(0);
      expect(input.raw).toBe(false);
      expect(input.listenerCount("data")).toBe(0);
    } finally {
      input.end();
      region.stop();
      await result;
    }
  });
});

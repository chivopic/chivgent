import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMAbortError, type LLMRequest } from "../src/llm.js";
import { PermissionPolicy } from "../src/permissions.js";
import { BUILT_IN_COMMANDS, runRepl, type ProviderControl } from "../src/repl.js";
import { AgentSession } from "../src/session.js";
import { LocalWorkspace } from "../src/workspace.js";
import { createLiveRegion } from "../src/tui/live.js";
import { TuiInput } from "../src/tui/input.js";
import { displayWidth, fitLine, fitLineTail, terminalText } from "../src/tui/text.js";
import { writeFooterFields } from "../src/tui/footer-preferences.js";
import { welcome } from "../src/tui/welcome.js";
import { terminalHarness } from "./helpers/terminal.js";

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

it("shows a compact wordmark without a session id, provider, or model", () => {
  const banner = welcome({ version: "test", provider: "openai", model: "gpt-test", cwd: "/project", resumed: false, signedOut: true, width: 80 });
  const lines = banner.split("\n").filter(Boolean);
  expect(lines[0]).toContain("◆ chivgent vtest");
  expect(lines[1]).toBe("/project");
  expect(banner).toContain("Set up a Provider with /provider");
  expect(banner).not.toContain("╭");
  expect(banner).not.toContain("openai");
  expect(banner).not.toContain("gpt-test");
  expect(banner).not.toContain("unknown model");
  expect(banner).not.toContain("session-");
  expect(lines).toHaveLength(3);
  expect(welcome({ version: "test", provider: "openai", model: "gpt-test", cwd: "/project", resumed: false, signedOut: true, width: 80, color: true }))
    .toContain("\u001b[1;36m");
});

it("keeps one setup hint and leaves the provider and model off the welcome", () => {
  const base = { version: "test", provider: "openai", model: "gpt-test", cwd: "/project", resumed: false, width: 80 };
  const banners = [
    welcome({ ...base, signedOut: true }),
    welcome({ ...base, signedOut: false, setupIssue: "model" }),
    welcome({ ...base, signedOut: false, setupIssue: "base-url" }),
  ];
  expect(banners[0]).toContain("Set up a Provider with /provider");
  expect(banners[1]).toContain("Set a model with /model MODEL");
  expect(banners[2]).toContain("Set the API URL with /endpoint URL");
  for (const banner of banners) {
    expect(banner.split("\n").filter(Boolean)).toHaveLength(3);
    expect(banner.split("\n").filter(Boolean)[1]).toBe("/project");
    expect(banner).not.toContain("gpt-test");
    expect(banner).not.toContain("unknown model");
  }
  const ready = welcome({ ...base, signedOut: false });
  expect(ready.split("\n").filter(Boolean)).toEqual(["◆ chivgent vtest", "/project"]);
});

it("keeps the workspace name visible when the welcome path is long", () => {
  const cwd = `/very/long/parent/directory/${"nested/".repeat(8)}chivgent`;
  const banner = welcome({ version: "test", provider: "demo", model: "model", cwd, resumed: false, signedOut: false, width: 40 });
  const pathLine = banner.split("\n").filter(Boolean)[1] ?? "";
  expect(pathLine).toContain("chivgent");
  expect(pathLine).toContain("…");
  expect(pathLine).not.toContain("/very/long");
  expect(pathLine).not.toContain("demo");
  expect(pathLine).not.toContain("~");
  expect(displayWidth(pathLine)).toBeLessThan(40);
  const narrow = welcome({ version: "test", provider: "a-very-long-provider", model: "a-very-long-model", cwd: "/parent/chivgent", resumed: false, signedOut: false, width: 24 });
  const narrowLines = narrow.split("\n").filter(Boolean);
  expect(narrowLines).toHaveLength(2);
  expect(narrowLines[1]).toBe("/parent/chivgent");
  expect(narrow).not.toContain("a-very-long-provider");
});

it("leaves a home path absolute on the welcome line", () => {
  const cwd = "/home/chiv/developer/chivgent";
  const banner = welcome({ version: "test", provider: "openai", model: "gpt-test", cwd, resumed: false, signedOut: false, width: 80 });
  expect(banner.split("\n").filter(Boolean)[1]).toBe(cwd);
  expect(banner).not.toContain("~");
  expect(banner).not.toContain("gpt-test");
});

it("sanitizes workspace control characters before displaying the welcome", () => {
  const banner = welcome({ version: "test", provider: "demo", model: "model", cwd: "/safe/\u001b[2Jworkspace", resumed: false, signedOut: false, width: 60 });
  expect(banner).toContain("workspace");
  expect(banner).not.toContain("\u001b[2J");
});

describe("idle composer footer", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  function session(cwd: string, id?: string): AgentSession {
    return new AgentSession({ cwd, ...(id === undefined ? {} : { id }), agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(cwd),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
  }

  function providers(model: string | undefined): ProviderControl {
    return {
      provider: "openai",
      get model() { return model; },
      describe: () => "openai\n",
      providerIds: () => ["openai"],
      select: async () => ({ ok: true, message: "" }),
      changeModel: async () => ({ ok: true, message: "" }),
      changeEndpoint: async () => ({ ok: true, message: "" }),
    };
  }

  it("shows the live provider and model under the composer and still cycles modes", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-footer-"));
    roots.push(cwd);
    const screen = terminalHarness(80, 24);
    const repl = runRepl({
      session: session(cwd), ...screen, stderr: screen.output, tui: true, inlineComposer: true,
      permissionPolicy: new PermissionPolicy("ask-first"),
      providerName: "startup-provider", modelName: "startup-model",
      providers: providers("gpt-test"),
    });
    try {
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("openai · gpt-test"));
      const idle = screen.visible().join("\n");
      expect(idle).toContain("Ask for me · Shift+Tab Plan · /help");
      expect(idle).toContain("Ask chivgent to do anything");
      expect(idle).not.toContain("startup-model");
      expect(idle).not.toContain("unknown model");
      screen.input.write("\u001b[Z");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Plan · Shift+Tab Auto mode · /help"));
      expect(screen.visible().join("\n")).toContain("openai · gpt-test");
      expect(screen.visible().join("\n")).toContain("Ask chivgent to do anything");
      screen.input.write("\u0004");
      await expect(repl).resolves.toBe(0);
    } finally {
      screen.input.end();
      await repl;
      screen.dispose();
    }
  });

  it("does not invent a footer model when the live provider has none", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-footer-"));
    roots.push(cwd);
    const screen = terminalHarness(80, 24);
    const repl = runRepl({
      session: session(cwd), ...screen, stderr: screen.output, tui: true, inlineComposer: true,
      permissionPolicy: new PermissionPolicy("ask-first"),
      providerName: "startup-provider", modelName: "startup-model",
      providers: providers(undefined),
    });
    try {
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Ask for me · Shift+Tab Plan · /help"));
      const idle = screen.visible().join("\n");
      expect(idle).not.toContain("startup-model");
      expect(idle).not.toContain("unknown model");
      expect(idle).not.toContain("openai ·");
      screen.input.write("\u0004");
      await expect(repl).resolves.toBe(0);
    } finally {
      screen.input.end();
      await repl;
      screen.dispose();
    }
  });

  it("keeps the help hint in rich TUI sessions without a named permission policy", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-footer-legacy-"));
    roots.push(cwd);
    const screen = terminalHarness(80, 24);
    const repl = runRepl({ session: session(cwd), ...screen, stderr: screen.output, tui: true, inlineComposer: true });
    try {
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("/help for shortcuts"));
      screen.input.write("\u0004");
      await expect(repl).resolves.toBe(0);
    } finally {
      screen.input.end();
      await repl;
      screen.dispose();
    }
  });

  it("does not advertise Shift+Tab in legacy Plan Mode without a permission policy", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-footer-plan-legacy-"));
    roots.push(cwd);
    const current = session(cwd);
    await current.setPlanMode(true);
    const screen = terminalHarness(80, 24);
    const repl = runRepl({ session: current, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
    try {
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Plan · /help"));
      expect(screen.visible().join("\n")).not.toContain("Shift+Tab Auto mode");
      screen.input.write("\u0004");
      await expect(repl).resolves.toBe(0);
    } finally {
      screen.input.end();
      await repl;
      screen.dispose();
    }
  });

  it("persists explicit footer field changes and reads Git only after per-query approval", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-footer-settings-"));
    roots.push(cwd);
    const preferencesFile = path.join(cwd, "statusline.json");
    const screen = terminalHarness(80, 24);
    let gitReads = 0;
    const repl = runRepl({
      session: session(cwd, "sess-footer"), ...screen, stderr: screen.output, tui: true, inlineComposer: true,
      permissionPolicy: new PermissionPolicy("ask-first"),
      providers: providers("gpt-test"),
      contextWindow: 64_000,
      footerPreferencesFile: preferencesFile,
      gitStatusReader: async () => { gitReads += 1; return "main\n"; },
    });
    try {
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Ask for me · Shift+Tab Plan · /help"));
      screen.input.write("/statusline show context\n");
      await vi.waitFor(async () => expect(await readFile(preferencesFile, "utf8")).toContain("context"));
      expect(screen.visible().join("\n")).toContain("Footer fields: identity, mode, context");
      screen.resize(40, 12);
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Ask for me · Shift+Tab Plan · /help"));
      screen.resize(80, 24);
      screen.input.write("/statusline order session,context,identity\n");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Footer fields: session, context, identity"));
      const orderedFrame = screen.visible().join("\n");
      expect(orderedFrame.indexOf("sess-")).toBeLessThan(orderedFrame.indexOf("ctx 64.0k"));
      expect(orderedFrame.indexOf("ctx 64.0k")).toBeLessThan(orderedFrame.indexOf("openai · gpt-test"));

      screen.input.write("/status --git\n");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("status-git>"));
      expect(gitReads).toBe(0);
      screen.input.write("n");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("no process started"));
      expect(gitReads).toBe(0);
      screen.input.write("/status --git\n");
      await vi.waitFor(() => expect(screen.visible().join("\n").match(/status-git>/g)?.length).toBeGreaterThan(1));
      screen.input.write("y");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("branch:    main"));
      expect(gitReads).toBe(1);
      screen.input.write("\u0004");
      await expect(repl).resolves.toBe(0);
    } finally {
      screen.input.end();
      await repl;
      screen.dispose();
    }
  });

  it("loads saved footer order into runRepl and keeps it on the real busy live region", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-footer-live-"));
    roots.push(cwd);
    const preferencesFile = path.join(cwd, "statusline.json");
    await writeFooterFields(preferencesFile, ["session", "context", "identity"]);
    const screen = terminalHarness(80, 24);
    let providerStarted!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const current = new AgentSession({ cwd, id: "sess-persisted-footer", agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(cwd),
      llm: { complete(request) {
        providerStarted();
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new LLMAbortError()), { once: true });
        });
      } },
    } });
    const liveRegion = createLiveRegion({
      stream: screen.output,
      width: () => screen.output.columns,
      height: () => screen.output.rows,
      tickMs: 5,
    });
    const detach = current.subscribe(liveRegion.listener);
    const repl = runRepl({
      session: current, ...screen, stderr: screen.output, tui: true, inlineComposer: true,
      permissionPolicy: new PermissionPolicy("ask-first"),
      providers: providers("gpt-test"), contextWindow: 64_000,
      footerPreferencesFile: preferencesFile, liveRegion,
    });
    try {
      await vi.waitFor(() => {
        const frame = screen.visible().join("\n");
        expect(frame.indexOf("sess-persisted-footer")).toBeLessThan(frame.indexOf("ctx 64.0k"));
        expect(frame.indexOf("ctx 64.0k")).toBeLessThan(frame.indexOf("openai · gpt-test"));
      });
      expect(screen.visible().join("\n")).not.toContain("Ask for me");

      screen.input.write("go\r");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("thinking"));
      await started;
      await screen.flush();
      const busy = screen.visible().join("\n");
      expect(busy).toContain("sess-persisted-footer");
      expect(busy).toContain("ctx 64.0k");
      expect(busy).toContain("openai · gpt-test");
      expect(busy).not.toContain("Ask for me");
      expect(busy).toContain("ctrl+c to stop");

      screen.input.write("\x03");
      await vi.waitFor(() => expect(screen.history().join("\n")).toContain("Stopped"));
      screen.input.write("\x04");
      await expect(repl).resolves.toBe(0);
    } finally {
      screen.input.write("\x03\x04");
      screen.input.end();
      detach();
      liveRegion.stop();
      await repl;
      screen.dispose();
    }
  });
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
      // /inspect is below the menu's initial 16-row viewport. Arrow through
      // the suggestions to prove it remains reachable without choosing it.
      input.write("\x1b[B".repeat(BUILT_IN_COMMANDS.length));
      await vi.waitFor(() => expect(screen).toContain("/inspect"));
      input.write("\x1b");
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

  it("asks /login which Provider to use before prompting for its key", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const selected: string[] = [];
    const submitted: string[] = [];
    let provider = "openai";
    const control = {
      get provider() { return provider; },
      authFile: "/unused",
      ready: () => false,
      submit: async (key: string) => { submitted.push(`${provider}:${key}`); return undefined; },
      describe: () => "openai · deepseek\n",
      providerIds: () => ["openai", "deepseek"],
      select: async (argument: string) => {
        selected.push(argument);
        provider = argument;
        return { ok: true as const, message: `Selected ${provider}\n` };
      },
      changeModel: async (value: string) => ({ ok: true as const, message: `Selected model ${value}\n` }),
      changeEndpoint: async () => ({ ok: true as const, message: "endpoint changed\n" }),
    };
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: control, providers: control });
    try {
      input.write("/login\r");
      await vi.waitFor(() => expect(screen).toContain("Select a Provider for /login"));
      // The hidden key prompt must not appear for the previously active
      // Provider before the user has chosen one.
      expect(screen).not.toContain("API key for openai");
      input.write("\u001b[B\r");
      await vi.waitFor(() => expect(screen).toContain("API key for deepseek"));
      input.write("secret-for-test\r");
      await vi.waitFor(() => expect(submitted).toEqual(["deepseek:secret-for-test"]));
      expect(selected).toEqual(["deepseek"]);
      expect(screen).not.toContain("secret-for-test");
      input.write("/exit\r");
      expect(await result).toBe(0);
    } finally { input.end(); await result; }
  });

  it("cancels the /login Provider picker on Escape without switching or storing", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const selected: string[] = [];
    const submitted: string[] = [];
    let provider = "openai";
    const control = {
      get provider() { return provider; },
      authFile: "/unused",
      ready: () => false,
      submit: async (key: string) => { submitted.push(key); return undefined; },
      describe: () => "openai · deepseek\n",
      providerIds: () => ["openai", "deepseek"],
      select: async (argument: string) => {
        selected.push(argument);
        provider = argument;
        return { ok: true as const, message: `Selected ${provider}\n` };
      },
      changeModel: async (value: string) => ({ ok: true as const, message: `Selected model ${value}\n` }),
      changeEndpoint: async () => ({ ok: true as const, message: "endpoint changed\n" }),
    };
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: control, providers: control });
    try {
      input.write("/login\r");
      await vi.waitFor(() => expect(screen).toContain("Select a Provider for /login"));
      input.write("\u001b");
      await vi.waitFor(() => expect(screen).toContain("No Provider selected; no key was stored."));
      expect(selected).toEqual([]);
      expect(submitted).toEqual([]);
      expect(provider).toBe("openai");
      expect(screen).not.toContain("API key for");
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

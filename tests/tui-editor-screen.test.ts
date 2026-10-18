import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { LocalWorkspace } from "../src/workspace.js";
import type { LLMRequest } from "../src/llm.js";
import { terminalHarness } from "./helpers/terminal.js";

afterEach(() => vi.unstubAllEnvs());

function fixture(prompts: string[]) {
  return new AgentSession({ agent: {
    systemPrompt: "test", maxTurns: 1, tools: [],
    workspace: new LocalWorkspace(process.cwd()),
    llm: { async complete(request: LLMRequest) {
      const message = request.messages.at(-1);
      if (message?.role === "user") prompts.push(message.content);
      return { message: { role: "assistant" as const, content: "OK", toolCalls: [] } };
    } },
  } });
}

describe("interactive TUI editor", () => {
  it("shows filtered command suggestions and requires a second Enter to dispatch", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(56, 14);
    const prompts: string[] = [];
    const session = fixture(prompts);
    const run = runRepl({ session, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
      screen.input.write("/he");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("› /help"));
      screen.input.write("\r");
      await screen.flush();
      expect(prompts).toEqual([]);
      expect(screen.visible().join("\n")).toContain("/help");
      screen.input.write("\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Commands"));
      expect(prompts).toEqual([]);
      screen.input.write("\u0004");
      expect(await run).toBe(0);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("picks a Provider for /login before reading the hidden key", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(56, 18);
    const prompts: string[] = [];
    const session = fixture(prompts);
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
    const run = runRepl({ session, ...screen, stderr: screen.output, tui: true,
      inlineComposer: true, signIn: control, providers: control });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
      screen.input.write("/login\r");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Select a Provider for /login"));
      expect(screen.bytes()).not.toContain("API key for openai");
      screen.input.write("\u001b[B\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("API key for deepseek"));
      screen.input.write("sk-inline\r");
      await vi.waitFor(() => expect(submitted).toEqual(["deepseek:sk-inline"]));
      expect(selected).toEqual(["deepseek"]);
      expect(screen.bytes()).not.toContain("sk-inline");
      screen.input.write("\u0004");
      expect(await run).toBe(0);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("releases mouse tracking when the wheel is over the transcript", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(56, 16);
    const prompts: string[] = [];
    const session = fixture(prompts);
    const run = runRepl({ session, ...screen, stderr: screen.output, tui: true, inlineComposer: true });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
      await screen.flush();
      // Answer the composer's cursor-position query so it can map screen rows.
      const cursor = screen.terminal.buffer.active;
      screen.input.write(`\u001b[${cursor.cursorY + 1};${cursor.cursorX + 1}R`);
      await screen.flush();
      screen.input.write("draft");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("draft"));

      const beforeWheel = screen.bytes().length;
      screen.input.write("\u001b[<64;3;1M"); // wheel-up over the transcript
      await screen.flush();
      const handoff = screen.bytes().slice(beforeWheel);
      expect(handoff).toContain("\u001b[?1006l");
      expect(handoff).not.toContain("\u001b[6n");
      expect(screen.visible().join("\n")).toContain("draft");

      const beforeKey = screen.bytes().length;
      screen.input.write("X");
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("draftX"));
      expect(screen.bytes().slice(beforeKey)).toContain("\u001b[?1000h");
      expect(prompts).toEqual([]);

      // Ctrl+D only exits an empty composer.
      screen.input.write("\u007f".repeat("draftX".length));
      await screen.flush();
      screen.input.write("\u0004");
      expect(await run).toBe(0);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("edits earlier rows, submits with Ctrl+S, and restores readline input", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(56, 18);
    const prompts: string[] = [];
    const session = fixture(prompts);
    const run = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("/editor\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Ctrl+S send"));
      screen.input.write("first\rsecond\rthird");
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("third");
      screen.input.write("\u001b[A\u001b[HEDIT ");
      screen.input.write("\u0013");
      await vi.waitFor(() => expect(prompts).toEqual(["first\nEDIT second\nthird"]));
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("prompts:   1"));
      screen.input.write("\u0004");
      expect(await run).toBe(0);
      expect(screen.input.raw).toBe(false);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("Escape cancels only the editor, not the outer REPL", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(40, 12);
    const prompts: string[] = [];
    const session = fixture(prompts);
    const run = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("/editor\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Ctrl+S send"));
      screen.input.write("unsent draft");
      screen.input.write("\u001b");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Draft discarded"));
      expect(prompts).toEqual([]);
      screen.input.write("another task\r");
      await vi.waitFor(() => expect(prompts).toEqual(["another task"]));
      screen.input.write("\u0004");
      expect(await run).toBe(0);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("reflows the editor in narrow terminals and retains pasted Unicode", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(42, 14);
    const prompts: string[] = [];
    const session = fixture(prompts);
    const run = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("/editor\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Ctrl+S send"));
      screen.input.write("\u001b[200~中文👩‍💻\r\nsecond\u001b[201~");
      await screen.flush();
      screen.resize(24, 10);
      await screen.flush();
      screen.input.write("\u0013");
      await vi.waitFor(() => expect(prompts).toEqual(["中文👩‍💻\nsecond"]));
      screen.input.write("\u0004");
      expect(await run).toBe(0);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });
});

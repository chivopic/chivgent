import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { LocalWorkspace } from "../src/workspace.js";
import { terminalHarness } from "./helpers/terminal.js";
import type { LLMRequest } from "../src/llm.js";

afterEach(() => vi.unstubAllEnvs());

function setup(prompts: string[]) {
  return new AgentSession({
    cwd: process.cwd(),
    agent: {
      systemPrompt: "test", tools: [], maxTurns: 1,
      workspace: new LocalWorkspace(process.cwd()),
      llm: {
        async complete(request: LLMRequest) {
          const message = request.messages.at(-1);
          if (message?.role === "user") prompts.push(message.content);
          return { message: { role: "assistant" as const, content: "done", toolCalls: [] } };
        },
      },
    },
  });
}

describe("default inline TUI composer in a real terminal", () => {
  it("accepts normal Enter submission and a multi-line Ctrl+O draft", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(75, 22);
    const prompts: string[] = [];
    const session = setup(prompts);
    const result = runRepl({ session, ...screen, tui: true, inlineComposer: true, stderr: screen.output });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("Enter send"));
      screen.input.write("first line\u000fsecond line\r");
      await vi.waitFor(() => expect(prompts).toEqual(["first line\nsecond line"]));
      await vi.waitFor(() => expect(session.messages.some(message => message.role === "assistant")).toBe(true));
      await new Promise<void>(resolve => setImmediate(resolve));
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("prompts:   1"));
      screen.input.write("\u0004");
      expect(await result).toBe(0);
      expect(screen.input.raw).toBe(false);
    } finally { screen.input.end(); await result; screen.dispose(); }
  });

  it("recalls a previous submitted prompt via Ctrl+R, without sending twice on selection", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 20);
    const prompts: string[] = [];
    const session = setup(prompts);
    const result = runRepl({ session, ...screen, tui: true, inlineComposer: true, stderr: screen.output });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("Enter send"));
      screen.input.write("Refactor API\r");
      await vi.waitFor(() => expect(prompts).toEqual(["Refactor API"]));
      await vi.waitFor(() => expect(session.messages.some(message => message.role === "assistant")).toBe(true));
      await new Promise<void>(resolve => setImmediate(resolve));
      screen.input.write("\u0012API");
      await vi.waitFor(() => expect(screen.bytes()).toContain("History"));
      expect(prompts).toHaveLength(1);
      screen.input.write("\r"); // load the matched history; do not submit
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(prompts).toHaveLength(1);
      screen.input.write("\r"); // a separate submit action
      await vi.waitFor(() => expect(prompts).toEqual(["Refactor API", "Refactor API"]));
      screen.input.write("\u0004");
      expect(await result).toBe(0);
    } finally { screen.input.end(); await result; screen.dispose(); }
  });

  it("Esc cancels an unsent draft without exiting; Ctrl+D exits at empty prompt", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(55, 18);
    const prompts: string[] = [];
    const result = runRepl({ session: setup(prompts), ...screen,
      tui: true, inlineComposer: true, stderr: screen.output });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("Enter send"));
      screen.input.write("do not send");
      const beforeCancel = screen.bytes().split("Enter send").length;
      screen.input.write("\u001b");
      await vi.waitFor(() => expect(screen.bytes().split("Enter send").length).toBeGreaterThan(beforeCancel));
      expect(prompts).toEqual([]);
      screen.input.write("\u0004");
      await vi.waitFor(() => expect(screen.input.raw).toBe(false)).catch(() => {
        throw new Error(`Terminal exit diagnostic: ${JSON.stringify(screen.bytes().slice(-1400))}`);
      });
      expect(await result).toBe(0);
    } finally { screen.input.end(); await result; screen.dispose(); }
  });
});

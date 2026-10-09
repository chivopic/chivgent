import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { LocalWorkspace } from "../src/workspace.js";
import { terminalHarness } from "./helpers/terminal.js";
import type { LLMRequest } from "../src/llm.js";

afterEach(() => vi.unstubAllEnvs());

function sessionWithPrompts(prompts: string[]) {
  return new AgentSession({ agent: {
    systemPrompt: "test", tools: [], maxTurns: 1,
    workspace: new LocalWorkspace(process.cwd()),
    llm: { async complete(request: LLMRequest) {
      const text = request.messages.at(-1);
      if (text?.role === "user") prompts.push(text.content);
      return { message: { role: "assistant" as const, content: "Completed", toolCalls: [] } };
    } },
  } });
}

describe("multiline compose REPL", () => {
  it("submits exact multiline code, blank lines and slash-prefixed content once", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const prompts: string[] = [];
    const session = sessionWithPrompts(prompts);
    const done = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    const line = async (text: string, promptCount: number) => {
      screen.input.write(text + "\r");
      await vi.waitFor(() => expect(screen.bytes().split("  │ ").length - 1).toBeGreaterThanOrEqual(promptCount));
    };
    try {
      screen.input.write("/compose\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Compose prompt"));
      await line("Review this snippet:", 2);
      await line("", 3);
      await line("  if (ready) {", 4);
      await line("    return true;", 5);
      await line("  }", 6);
      await line("//send", 7); // literal /send in the prompt
      screen.input.write("/send\r");
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toBe("Review this snippet:\n\n  if (ready) {\n    return true;\n  }\n/send");
      expect(session.turns).toBe(1);
      screen.input.write("/exit\r");
      expect(await done).toBe(0);
    } finally { screen.input.end(); await done; screen.dispose(); }
  });

  it("preserves a multi-line paste delivered as one terminal chunk", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const prompts: string[] = [];
    const session = sessionWithPrompts(prompts);
    const done = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("/compose\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Compose prompt"));
      screen.input.write("first line\rsecond line\r\nthird line\r/send\r");
      await vi.waitFor(() => expect(prompts).toEqual(["first line\nsecond line\nthird line"])).catch(() => {
        throw new Error(`Paste diagnostic: prompts=${JSON.stringify(prompts)} terminal=${JSON.stringify(screen.bytes().slice(-2300))}`);
      });
      screen.input.write("/exit\r");
      expect(await done).toBe(0);
    } finally { screen.input.end(); await done; screen.dispose(); }
  });

  it("discards a compose draft without any provider request", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const prompts: string[] = [];
    const session = sessionWithPrompts(prompts);
    const done = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("/compose\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Compose prompt"));
      screen.input.write("throw this away\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("throw this away"));
      screen.input.write("/cancel\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Draft discarded"));
      expect(prompts).toEqual([]);
      screen.input.write("/exit\r");
      expect(await done).toBe(0);
    } finally { screen.input.end(); await done; screen.dispose(); }
  });

  it("Ctrl+C cancels composition but keeps the REPL alive", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const prompts: string[] = [];
    const session = sessionWithPrompts(prompts);
    const done = runRepl({ session, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("/compose\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Compose prompt"));
      screen.input.write("draft\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("draft"));
      screen.input.write("\x03");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Draft discarded"));
      screen.input.write("second prompt\r");
      await vi.waitFor(() => expect(prompts).toEqual(["second prompt"]));
      screen.input.write("/exit\r");
      expect(await done).toBe(0);
    } finally { screen.input.end(); await done; screen.dispose(); }
  });
});

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

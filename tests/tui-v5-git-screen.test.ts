import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { LocalWorkspace } from "../src/workspace.js";
import { terminalHarness } from "./helpers/terminal.js";

afterEach(() => vi.unstubAllEnvs());

function session() {
  return new AgentSession({ agent: {
    systemPrompt: "test", tools: [], maxTurns: 1,
    workspace: new LocalWorkspace(process.cwd()),
    llm: { async complete() {
      return {message: {role: "assistant" as const, content: "done", toolCalls: []}};
    }},
  }});
}

describe("consent and real-terminal git diff review", () => {
  it("does not execute git diff without a positive user decision", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(84, 24);
    const read = vi.fn(async () => "+changed");
    const repl = runRepl({session:session(), ...screen, tui:true, inlineComposer:true,
      stderr:screen.output, gitDiffReader:read});
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("Enter send"));
      screen.input.write("/gitdiff\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      screen.input.write("n"); // single-key denial
      await vi.waitFor(() => expect(screen.bytes()).toContain("review denied"));
      expect(read).not.toHaveBeenCalled();
      screen.input.write("\u0004");
      expect(await repl).toBe(0);
    } finally {screen.input.end(); await repl; screen.dispose();}
  });

  it("starts a single read-only diff only after y, then exits review with q", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(84, 24);
    const read = vi.fn(async (_cwd:string, _mode:string) =>
      "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new");
    const repl = runRepl({session:session(), ...screen, tui:true, inlineComposer:true,
      stderr:screen.output, gitDiffReader:read});
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("Enter send"));
      screen.input.write("/gitdiff --staged\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      expect(read).not.toHaveBeenCalled();
      screen.input.write("y");
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(read.mock.calls[0]?.[1]).toBe("staged");
      await vi.waitFor(() => expect(screen.bytes()).toContain("live Git diff"));
      screen.input.write("q");
      await vi.waitFor(() => expect(screen.bytes().split("Enter send").length).toBeGreaterThan(2));
      screen.input.write("\u0004");
      expect(await repl).toBe(0);
    } finally {screen.input.end(); await repl; screen.dispose();}
  });
});

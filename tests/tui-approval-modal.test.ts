import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { createLiveRegion } from "../src/tui/live.js";
import { BashTool } from "../src/tools/bash.js";
import { ShellApprovalGate } from "../src/shell/approval.js";
import { LocalWorkspace } from "../src/workspace.js";
import { terminalHarness } from "./helpers/terminal.js";

afterEach(() => vi.unstubAllEnvs());

function createApprovalSession(command: string, gate: ShellApprovalGate, executed: string[]) {
  let call = 0;
  const shell = new BashTool({
    cwd: process.cwd(),
    approve: (cmd, signal) => gate.approve(cmd, signal),
    operations: {
      async exec(cmd) {
        executed.push(cmd);
        return { exitCode: 0 };
      },
    },
  });
  return new AgentSession({ agent: {
    systemPrompt: "test", tools: [shell], maxTurns: 3,
    workspace: new LocalWorkspace(process.cwd()),
    llm: {
      async complete() {
        call += 1;
        return { message: call === 1
          ? { role: "assistant" as const, content: "", toolCalls: [{
            id: "command", name: "bash", arguments: { command },
          }] }
          : { role: "assistant" as const, content: "Done.", toolCalls: [] } };
      },
    },
  } });
}

describe("TUI approval modal terminal integration", () => {
  it("pauses live output during a shell approval, denies by default and restores terminal input", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const session = createApprovalSession("npm test", gate, executed);
    const region = createLiveRegion({
      stream: screen.output,
      width: () => screen.output.columns,
      height: () => screen.output.rows,
    });
    session.subscribe(region.listener);
    const repl = runRepl({
      session, ...screen, stderr: screen.output, tui: true, shellApproval: gate,
      liveRegion: region,
    });
    try {
      screen.input.write("run tests\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("npm test");
      expect(screen.bytes()).toContain("network disabled");
      screen.input.write("\r"); // The default/Enter is DENY.
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
      expect(executed).toEqual([]);
      expect(session.messages.filter(m => m.role === "tool")[0]).toMatchObject({
        isError: true,
      });
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("prompts:   1"));
      screen.input.write("\x04");
      await repl;
      expect(screen.input.raw).toBe(false);
    } finally {
      screen.input.end();
      region.stop();
      await repl;
      screen.dispose();
    }
  });

  it("approves once on a single y keystroke, without Enter or queued input", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const session = createApprovalSession("npm test", gate, executed);
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output,
      tui: true, shellApproval: gate, liveRegion: region });
    try {
      screen.input.write("run tests\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      screen.input.write("y");
      await vi.waitFor(() => expect(executed).toEqual(["npm test"]));
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("prompts:   1"));
      screen.input.write("\x04");
      expect(await repl).toBe(0);
    } finally { screen.input.end(); region.stop(); await repl; screen.dispose(); }
  });

  it("does not let a truncated shell command reach an executable approval", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(52, 15);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const session = createApprovalSession("x".repeat(200), gate, executed);
    const region = createLiveRegion({
      stream: screen.output,
      width: () => screen.output.columns,
      height: () => screen.output.rows,
    });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output, tui: true, shellApproval: gate, liveRegion: region });
    try {
      screen.input.write("run long command\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Denied: command cannot be fully reviewed"));
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
      expect(executed).toEqual([]);
      expect(screen.bytes()).not.toContain("\x1b[2J");
      screen.input.write("\x04");
      await repl;
    } finally {
      screen.input.end();
      region.stop();
      await repl;
      screen.dispose();
    }
  });
});

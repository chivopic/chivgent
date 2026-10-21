import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { createLiveRegion } from "../src/tui/live.js";
import { BashTool } from "../src/tools/bash.js";
import { ShellApprovalGate } from "../src/shell/approval.js";
import { LocalWorkspace } from "../src/workspace.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ShellScope } from "../src/permissions.js";
import { WebSearchTool } from "../src/tools/web-search.js";
import type { LLMRequest } from "../src/llm.js";
import { terminalHarness } from "./helpers/terminal.js";

afterEach(() => vi.unstubAllEnvs());

function createApprovalSession(command: string, gate: ShellApprovalGate, executed: string[], policy?: PermissionPolicy) {
  let call = 0;
  const requests: LLMRequest[] = [];
  const shell = new BashTool({
    cwd: process.cwd(),
    approve: (cmd, signal, context) => gate.approveDecision(cmd, signal, context),
    ...(policy === undefined ? {} : {
      supportedScopes: ["workspace", "network"] as const,
      authorize: (request: { command: string; scope: ShellScope; signal?: AbortSignal; justification?: string }) =>
        policy.authorizeShell(request.command, request.scope, request.signal, request.justification),
    }),
    operations: {
      backend: "native (Seatbelt, network denied)",
      async exec(cmd) {
        executed.push(cmd);
        return { exitCode: 0 };
      },
    },
  });
  const session = new AgentSession({ agent: {
    systemPrompt: "test", tools: [shell], maxTurns: 3,
    workspace: new LocalWorkspace(process.cwd()),
    llm: {
      async complete(request) {
        requests.push(request);
        call += 1;
        return { message: call === 1
          ? { role: "assistant" as const, content: "", toolCalls: [{
            id: "command", name: "bash", arguments: { command, ...(policy === undefined ? {} : { scope: "network", justification: "fetch package metadata" }) },
          }] }
          : { role: "assistant" as const, content: "Done.", toolCalls: [] } };
      },
    },
  } });
  return { session, requests };
}

describe("TUI approval modal terminal integration", () => {
  it("pauses live output during a shell approval, denies by default and restores terminal input", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const { session } = createApprovalSession("npm test", gate, executed);
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
      expect(screen.bytes()).toContain("native (Seatbelt, network denied)");
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
    const { session } = createApprovalSession("npm test", gate, executed);
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

  it("preserves explicit newlines and repeated spaces through review and execution", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(52, 15);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const command = "printf 'one  two\\nthree'\necho  tail";
    const { session } = createApprovalSession(command, gate, executed);
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output,
      tui: true, shellApproval: gate, liveRegion: region });
    try {
      screen.input.write("run multiline command\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      await screen.flush();
      const rendered = screen.history().join("\n");
      expect(rendered).toContain("  │ printf 'one  two\\nthree'");
      expect(rendered).toContain("  │ echo  tail");
      screen.input.write("y");
      await vi.waitFor(() => expect(executed).toEqual([command]));
      screen.input.write("\x04");
      await repl;
    } finally { screen.input.end(); region.stop(); await repl; screen.dispose(); }
  });

  it("cancels a pending approval on Ctrl+C and keeps the prompt available", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const { session, requests } = createApprovalSession("npm test", gate, executed);
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output,
      tui: true, shellApproval: gate, liveRegion: region });
    try {
      screen.input.write("run tests\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      screen.input.write("\x03");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Stopped"));
      expect(executed).toEqual([]);
      screen.input.write("continue\r");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(screen.bytes()).toContain("Done.");
      screen.input.write("\x04");
      await repl;
    } finally { screen.input.end(); region.stop(); await repl; screen.dispose(); }
  });

  it("shows a complete wrapped shell command before allowing approval", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(52, 15);
    const gate = new ShellApprovalGate();
    const executed: string[] = [];
    const command = "printf '%s\\n' '" + "review-this-argument ".repeat(7) + "tail'";
    const policy = new PermissionPolicy("ask-first");
    policy.setApproval((action, signal, context) => gate.approveDecision(action, signal, context));
    const { session } = createApprovalSession(command, gate, executed, policy);
    const region = createLiveRegion({
      stream: screen.output,
      width: () => screen.output.columns,
      height: () => screen.output.rows,
    });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output, tui: true, shellApproval: gate, liveRegion: region });
    try {
      screen.input.write("run long command\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      await screen.flush();
      const rendered = screen.history().join("\n");
      for (const part of command.split(" ")) expect(rendered).toContain(part);
      expect(rendered).toContain("tail'");
      expect(rendered).toContain("Network access for this command only");
      expect(rendered).not.toContain("cannot be fully reviewed");
      screen.input.write("y");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
      expect(executed).toEqual([command]);
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

  it("reports an unsafe shell command as unreviewable without offering approval", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(52, 15);
    const gate = new ShellApprovalGate();
    const policy = new PermissionPolicy("ask-first");
    policy.setApproval((action, signal, context) => gate.approveDecision(action, signal, context));
    const executed: string[] = [];
    const command = "echo safe\x1b[2J hidden";
    const { session, requests } = createApprovalSession(command, gate, executed, policy);
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output,
      tui: true, shellApproval: gate, permissionPolicy: policy, liveRegion: region });
    try {
      screen.input.write("run unsafe command\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("cannot be safely displayed"));
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
      expect(screen.bytes()).not.toContain("Approve once?");
      expect(executed).toEqual([]);
      expect(session.messages.find(message => message.role === "tool")?.content).toContain(
        "Shell command denied: command cannot be safely displayed for approval.",
      );
      expect(requests[1]?.messages).toContainEqual(expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("command cannot be safely displayed"),
      }));
      screen.input.write("\x04");
      await repl;
    } finally { screen.input.end(); region.stop(); await repl; screen.dispose(); }
  });

  it("rechecks the current terminal width before accepting y", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 15);
    const gate = new ShellApprovalGate();
    const policy = new PermissionPolicy("workspace");
    policy.setApproval((action, signal, context) => gate.approveDecision(action, signal, context));
    const executed: string[] = [];
    const command = "x".repeat(2_000);
    const { session } = createApprovalSession(command, gate, executed, policy);
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns });
    session.subscribe(region.listener);
    const repl = runRepl({ session, ...screen, stderr: screen.output,
      tui: true, shellApproval: gate, permissionPolicy: policy, liveRegion: region });
    try {
      screen.input.write("run long command\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      screen.resize(32, 15);
      screen.resize(80, 15);
      screen.input.write("y");
      await vi.waitFor(() => expect(screen.bytes()).toContain("resized"));
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
      expect(executed).toEqual([]);
      expect(session.messages.find(message => message.role === "tool")?.content).toContain("cannot be safely displayed");
      screen.input.write("\x04");
      await repl;
    } finally { screen.input.end(); region.stop(); await repl; screen.dispose(); }
  });

  it("wraps a full web search query and approves it without truncation", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const gate = new ShellApprovalGate();
    const queries: string[] = [];
    const policy = new PermissionPolicy("ask-first");
    policy.setApproval((action, signal, context) => gate.approveDecision(action, signal, context));
    const query = "node twenty four release notes compatibility changes for current tooling";
    const tool = new WebSearchTool({
      backend: {
        name: "fake (test)",
        async search(request) {
          queries.push(request.query);
          return { provider: "fake (test)", results: [] };
        },
      },
      authorize: (value, signal) => policy.authorizeWebSearch(value, "fake (test)", signal),
    });
    let call = 0;
    const session = new AgentSession({ agent: {
      systemPrompt: "test", tools: [tool], maxTurns: 3,
      workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() {
        call += 1;
        return { message: call === 1
          ? { role: "assistant" as const, content: "", toolCalls: [{ id: "search", name: "web_search", arguments: { query } }] }
          : { role: "assistant" as const, content: "Done.", toolCalls: [] } };
      } },
    } });
    const region = createLiveRegion({
      stream: screen.output,
      width: () => screen.output.columns,
      height: () => screen.output.rows,
    });
    session.subscribe(region.listener);
    const repl = runRepl({
      session, ...screen, stderr: screen.output, tui: true,
      shellApproval: gate, permissionPolicy: policy, liveRegion: region,
    });
    try {
      screen.input.write("search for it\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      const visible = screen.visible().join(" ");
      expect(visible).toContain("Web search via fake (test)");
      for (const word of query.split(" ")) expect(visible).toContain(word);
      expect(screen.bytes()).not.toContain("cannot be fully reviewed");
      screen.input.write("y");
      await vi.waitFor(() => expect(queries).toEqual([query]));
      await vi.waitFor(() => expect(screen.bytes()).toContain("Completed"));
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

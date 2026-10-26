import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { LocalWorkspace } from "../src/workspace.js";
import { terminalHarness } from "./helpers/terminal.js";
import type { LLMRequest } from "../src/llm.js";
import { BashTool } from "../src/tools/bash.js";
import { ShellApprovalGate } from "../src/shell/approval.js";
import type { ShellOperations, ShellExecOptions } from "../src/shell/types.js";
import { ShellAbortError } from "../src/shell/types.js";

afterEach(() => vi.unstubAllEnvs());

function setup(prompts: string[], id?: string, title?: string, onClose?: () => void) {
  return new AgentSession({
    ...(id === undefined ? {} : { id }),
    ...(title === undefined ? {} : { title }),
    cwd: process.cwd(),
    agent: {
      systemPrompt: "test", tools: [], maxTurns: 1,
      workspace: new LocalWorkspace(process.cwd()),
      ...(onClose === undefined ? {} : { closeSessionData: async () => { onClose(); } }),
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
  it("runs a leading ! command directly through the approved shell tool", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(75, 22);
    const runCommand = vi.fn(async (_command: string, _cwd: string, options: ShellExecOptions) => {
      options?.onData?.(Buffer.from("shell output\n"));
      return { exitCode: _command === "exit 7" ? 7 : 0 };
    });
    const approval = new ShellApprovalGate();
    const providerRequests: LLMRequest[] = [];
    const session = new AgentSession({ agent: {
      systemPrompt: "test", maxTurns: 1, workspace: new LocalWorkspace(process.cwd()),
      tools: [new BashTool({ cwd: process.cwd(), operations: { exec: runCommand } as unknown as ShellOperations,
        approve: (command, signal, context) => approval.approve(command, signal, context) })],
      llm: { async complete(request) { providerRequests.push(request); return { message: { role: "assistant", content: `model: ${request.messages.at(-1)?.content ?? ""}`, toolCalls: [] } }; } },
    } });
    const repl = runRepl({ session, ...screen, tui: true, inlineComposer: true,
      shellApproval: approval, stderr: screen.output });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("›"));
      screen.input.write("!printf  hello   world\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("approve>"));
      screen.input.write("y\r");
      await vi.waitFor(() => expect(runCommand).toHaveBeenCalledOnce());
      expect(runCommand.mock.calls[0]?.[0]).toBe("printf  hello   world");
      await vi.waitFor(() => expect(screen.bytes()).toContain("shell output"));
      expect(session.messages.slice(-3).map(message => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(session.messages.at(-3)).toMatchObject({ role: "user", content: "!printf  hello   world" });
      expect(session.messages.at(-1)).toMatchObject({ role: "tool", toolName: "bash", content: "shell output\n" });
      expect(session.usage).toBeUndefined();
      screen.input.write("question with ! in the middle\r");
      await vi.waitFor(() => expect(session.messages.some(message => message.role === "assistant" && message.content.includes("question with !"))).toBe(true));
      expect(providerRequests[0]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "!printf  hello   world" }),
        expect.objectContaining({ role: "tool", toolName: "bash", content: "shell output\n" }),
      ]));
      screen.input.write("!printf first\u000fsecond\r");
      await vi.waitFor(() => expect(screen.bytes().split("approve>").length).toBeGreaterThan(2));
      screen.input.write("y\r");
      await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
      expect(runCommand.mock.calls[1]?.[0]).toBe("printf first\nsecond");
      expect(session.messages.at(-3)).toMatchObject({ role: "user", content: "!printf first\nsecond" });
      screen.input.write("!exit 7\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("│ exit 7"));
      await vi.waitFor(() => expect(screen.bytes().split("approve>").length).toBeGreaterThan(3));
      screen.input.write("y\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Command exited with code 7"));
      expect(runCommand).toHaveBeenCalledTimes(3);
      screen.input.write("!denied\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("│ denied"));
      await vi.waitFor(() => expect(screen.bytes().split("approve>").length).toBeGreaterThan(4));
      screen.input.write("n\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Shell command denied by user."));
      expect(runCommand).toHaveBeenCalledTimes(3);
      screen.input.write("\u0004");
      expect(await repl).toBe(0);
    } finally { screen.input.end(); await repl; screen.dispose(); }
  });

  it("shows bounded output collected before Ctrl+C cancels a direct command", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(75, 22);
    const approval = new ShellApprovalGate();
    const execute = vi.fn(async (_command: string, _cwd: string, options: ShellExecOptions) => new Promise<{ exitCode: number }>((_resolve, reject) => {
      options.onData?.(Buffer.from("partial output\n"));
      options.signal?.addEventListener("abort", () => reject(new ShellAbortError()), { once: true });
    }));
    const session = new AgentSession({ agent: {
      systemPrompt: "test", maxTurns: 1, workspace: new LocalWorkspace(process.cwd()),
      tools: [new BashTool({ cwd: process.cwd(), operations: { exec: execute } as unknown as ShellOperations,
        throttleMs: 0, approve: (command, signal, context) => approval.approve(command, signal, context) })],
      llm: { async complete() { throw new Error("shell shortcut must not call the model"); } },
    } });
    const repl = runRepl({ session, ...screen, tui: true, inlineComposer: true, shellApproval: approval, stderr: screen.output });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("›"));
      screen.input.write("!long-running\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("approve>"));
      screen.input.write("y\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Running shell command"));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      screen.input.write("\u0003");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Shell command cancelled."));
      expect(session.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("partial output") });
      screen.input.write("\u0004");
      expect(await repl).toBe(0);
    } finally { screen.input.end(); await repl; screen.dispose(); }
  });

  it("accepts normal Enter submission and a multi-line Ctrl+O draft", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(75, 22);
    const prompts: string[] = [];
    const session = setup(prompts);
    const result = runRepl({ session, ...screen, tui: true, inlineComposer: true, stderr: screen.output });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
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
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
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
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
      screen.input.write("do not send");
      screen.input.write("\u001b");
      // Wait for Escape to actually discard the draft, not the intermediate
      // repaint while it is being disambiguated from an arrow sequence.
      await vi.waitFor(async () => {
        await screen.flush();
        expect(screen.visible().join("\n")).not.toContain("do not send");
        expect(screen.visible().join("\n")).toContain("›");
      });
      expect(prompts).toEqual([]);
      screen.input.write("\u0004");
      await vi.waitFor(() => expect(screen.input.raw).toBe(false)).catch(() => {
        throw new Error(`Terminal exit diagnostic: ${JSON.stringify(screen.bytes().slice(-1400))}`);
      });
      expect(await result).toBe(0);
    } finally { screen.input.end(); await result; screen.dispose(); }
  });

  it("keeps local session IDs out of new and resume confirmations", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(75, 22);
    const prompts: string[] = [];
    const closedSessions: string[] = [];
    const result = runRepl({ session: setup(prompts, "initial", undefined, () => closedSessions.push("initial")), ...screen,
      tui: true, inlineComposer: true, stderr: screen.output,
      sessionOptions: {
        create: async () => setup(prompts, "created-id-hidden-from-normal-output", "new topic", () => closedSessions.push("new")),
        resume: async () => setup(prompts, "resumed-id-hidden-from-normal-output", "older topic", () => closedSessions.push("resumed")),
      },
    });
    try {
      screen.input.write("/new new topic\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Started a new session · new topic"));
      expect(closedSessions).toEqual(["initial"]);
      screen.input.write("/resume selected-by-user\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Resumed saved session · older topic"));
      expect(closedSessions).toEqual(["initial", "new"]);
      expect(screen.bytes()).not.toContain("created-id-hidden-from-normal-output");
      expect(screen.bytes()).not.toContain("resumed-id-hidden-from-normal-output");
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("id:        resumed-id-hidden-from-normal-output"));
      screen.input.write("\u0004");
      expect(await result).toBe(0);
      expect(closedSessions).toEqual(["initial", "new", "resumed"]);
    } finally { screen.input.end(); await result; screen.dispose(); }
  });
});

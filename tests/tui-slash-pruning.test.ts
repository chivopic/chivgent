import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_COMMANDS, BUILT_IN_DESCRIPTIONS, handleSlashCommand, runRepl } from "../src/repl.js";
import { AgentSession } from "../src/session.js";
import { LocalWorkspace } from "../src/workspace.js";
import { terminalHarness } from "./helpers/terminal.js";
import { EditorDocument, editorFrame } from "../src/tui/editor.js";
import { PermissionPolicy } from "../src/permissions.js";

function dummySession(cwd = "/workspace", id = "test-session-id") {
  return new AgentSession({
    id,
    cwd,
    agent: {
      systemPrompt: "test",
      tools: [],
      maxTurns: 1,
      workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { return { message: { role: "assistant" as const, content: "ok", toolCalls: [] } }; } },
    },
  });
}

describe("pruned TUI slash commands", () => {
  it("keeps only curated high-value commands in BUILT_IN_COMMANDS", () => {
    expect(BUILT_IN_COMMANDS).toEqual([
      "help",
      "status",
      "new",
      "resume",
      "rename",
      "diff",
      "clear",
      "compact",
      "permissions",
      "provider",
      "model",
      "endpoint",
      "login",
      "exit",
    ]);
    expect(BUILT_IN_COMMANDS).not.toContain("compose");
    expect(BUILT_IN_COMMANDS).not.toContain("editor");
    expect(BUILT_IN_COMMANDS).not.toContain("review");
    expect(BUILT_IN_COMMANDS).not.toContain("gitdiff");
    expect(BUILT_IN_COMMANDS).not.toContain("session");
    expect(BUILT_IN_COMMANDS).not.toContain("tools");
    expect(BUILT_IN_COMMANDS).not.toContain("quit");
    expect(BUILT_IN_COMMANDS).not.toContain("logout");
  });

  it("provides concise descriptions for every built-in command", () => {
    for (const name of BUILT_IN_COMMANDS) {
      expect(BUILT_IN_DESCRIPTIONS[name]).toBeDefined();
      expect(BUILT_IN_DESCRIPTIONS[name]!.length).toBeGreaterThan(5);
    }
  });

  it("unifies /session and /status output with workspace, session id, and log path", () => {
    const session = dummySession("/workspace/my-app", "sess-123");
    let statusOut = "";
    let sessionOut = "";
    handleSlashCommand("/status", {
      session,
      write: (t) => { statusOut += t; },
      sessionFile: "sessions/sess-123.jsonl",
    });
    handleSlashCommand("/session", {
      session,
      write: (t) => { sessionOut += t; },
      sessionFile: "sessions/sess-123.jsonl",
    });

    expect(statusOut).toBe(sessionOut);
    expect(statusOut).toContain("workspace: /workspace/my-app");
    expect(statusOut).toContain("id:        sess-123");
    expect(statusOut).toContain("log:       sessions/sess-123.jsonl");
    expect(statusOut).toContain("prompts:   0");
    expect(statusOut).toContain("messages:  0");
  });

  it("supports /permissions plan to switch plan mode", () => {
    const session = dummySession();
    expect(session.planMode).toBe(false);
    const onOutcome = handleSlashCommand("/permissions plan", {
      session,
      write: () => {},
      permissionPolicy: new PermissionPolicy("ask-first"),
    });
    expect(onOutcome).toEqual({ kind: "plan", enabled: true });

    const offOutcome = handleSlashCommand("/permissions plan off", {
      session,
      write: () => {},
      permissionPolicy: new PermissionPolicy("ask-first"),
    });
    expect(offOutcome).toEqual({ kind: "plan", enabled: false });
  });

  it("supports /login logout as an alias for subscription sign-out", () => {
    const outcome = handleSlashCommand("/login logout", {
      session: dummySession(),
      write: () => {},
      signIn: {
        provider: "openai",
        authFile: "test-auth.json",
        ready: () => true,
        submit: async () => undefined,
        signOut: async () => undefined,
      },
    });
    expect(outcome).toEqual({ kind: "login", providerArgument: "__logout__" });
  });

  it("caps visible suggestions in editorFrame to avoid squashing prompt editor", () => {
    const doc = new EditorDocument();
    doc.insert("A multi-line draft\nwith several lines\nready to be edited");
    const suggestions = BUILT_IN_COMMANDS.map((name) => ({
      value: name,
      label: `/${name} · ${BUILT_IN_DESCRIPTIONS[name]}`,
    }));

    // On a 24-row terminal, suggestions must be capped at 5
    const frame = editorFrame(doc, 80, 24, true, suggestions, 0);
    expect(frame.suggestionRows?.length).toBeLessThanOrEqual(5);
    // Editor body must have plenty of room
    const inputRows = frame.lines.filter((l) => l.startsWith("│ "));
    expect(inputRows.length).toBeGreaterThanOrEqual(3);
  });

  it("informs user that multiline editor is already active when /compose or /editor is called with inlineComposer", () => {
    const session = dummySession();
    let composeOut = "";
    let editorOut = "";
    handleSlashCommand("/compose", {
      session,
      write: (t) => { composeOut += t; },
      inlineComposer: true,
    });
    handleSlashCommand("/editor", {
      session,
      write: (t) => { editorOut += t; },
      inlineComposer: true,
    });
    expect(composeOut).toContain("multiline editor is already active");
    expect(editorOut).toContain("cursor-addressable multiline editor is already active");
  });

  it("routes /diff to live Git review with consent prompt in rich TUI", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const session = dummySession();
    const gitDiffReader = vi.fn(async () => "diff --git a/test b/test\n+new");
    const done = runRepl({
      session,
      ...screen,
      stderr: screen.output,
      tui: true,
      inlineComposer: true,
      gitDiffReader,
    });
    try {
      await vi.waitFor(() => expect(screen.bytes()).toContain("/help for shortcuts"));
      screen.input.write("/diff\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      screen.input.write("n");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Git diff review denied"));
      screen.input.write("/exit\r");
      expect(await done).toBe(0);
    } finally {
      screen.input.end();
      await done;
      screen.dispose();
    }
  });
});

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
      "statusline",
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

  it("shows current permission boundaries and the configured context capacity", () => {
    const session = dummySession("/workspace/my-app", "sess-123");
    let output = "";
    handleSlashCommand("/status", {
      session,
      write: (text) => { output += text; },
      providerName: "live-provider",
      modelName: "live-model",
      contextWindow: 64_000,
      permissionPolicy: new PermissionPolicy("workspace"),
    });

    expect(output).toContain("provider:  live-provider");
    expect(output).toContain("model:     live-model");
    expect(output).toContain("permissions: workspace");
    expect(output).toContain("writable roots: /workspace/my-app");
    expect(output).toContain("shell scope: workspace by default; network/host require approval");
    expect(output).toContain("context capacity: 64.0k tokens");
    expect(output).not.toContain("context used:");
  });

  it("does not invent context capacity when the active host has not supplied it", () => {
    const session = dummySession();
    let output = "";
    handleSlashCommand("/status", { session, write: (text) => { output += text; } });
    expect(output).toContain("context capacity: unavailable");
    expect(output).not.toContain("128000");
    expect(output).not.toContain("permissions: ask-first");
  });

  it("reports Plan Mode as read-only even when the process policy is unrestricted", async () => {
    const session = dummySession("/workspace/plan");
    await session.setPlanMode(true);
    let output = "";
    handleSlashCommand("/status", {
      session, write: text => { output += text; }, permissionPolicy: new PermissionPolicy("unrestricted"),
    });
    expect(output).toContain("writable roots: none (Plan Mode)");
    expect(output).toContain("shell scope: disabled (Plan Mode)");
    expect(output).toContain("network policy: disabled (Plan Mode)");
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

  it("accepts explicit footer field selection and ordering", () => {
    const session = dummySession();
    let output = "";
    const shown = handleSlashCommand("/statusline show context", {
      session, write: text => { output += text; }, footerFields: ["identity", "mode"],
    });
    expect(shown).toEqual({ kind: "footer-fields", fields: ["identity", "mode", "context"] });
    expect(handleSlashCommand("/statusline order mode,context,identity", {
      session, write: () => {}, footerFields: ["identity", "mode"],
    })).toEqual({ kind: "footer-fields", fields: ["mode", "context", "identity"] });
    expect(handleSlashCommand("/statusline order mode,mode", {
      session, write: text => { output += text; }, footerFields: ["identity", "mode"],
    })).toBe("handled");
    expect(output).toContain("Usage: /statusline order");
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

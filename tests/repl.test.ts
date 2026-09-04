import { describe, expect, it } from "vitest";
import { createJsonEventWriter } from "../src/render.js";
import { handleSlashCommand } from "../src/repl.js";
import { AgentSession } from "../src/session.js";
import type { Tool } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import {
  assistant,
  FakeLLMClient,
  readOnlyWorkspaceWrites,
} from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() {
    return {
      content: "contents",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    };
  },
  async listFiles() {
    return { entries: [], truncated: false };
  },
  async searchText() {
    return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
  },
};

function tool(name: string): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" },
    async execute() {
      return { content: "", isError: false };
    },
  };
}

function createSession(): AgentSession {
  return new AgentSession({
    agent: {
      systemPrompt: "System prompt",
      maxTurns: 4,
      llm: new FakeLLMClient([assistant("Answer.")]),
      tools: [tool("list_files"), tool("read_file")],
      workspace,
      streaming: false,
    },
    id: "session-under-test",
    cwd: "/workspace",
  });
}

function run(line: string): {
  readonly outcome: string;
  readonly output: string;
  readonly session: AgentSession;
} {
  const session = createSession();
  let output = "";
  const outcome = handleSlashCommand(line, {
    session,
    write: (text) => (output += text),
    sessionFile: "/home/user/.chivgent/sessions/session-under-test.jsonl",
  });
  return { outcome, output, session };
}

describe("REPL commands", () => {
  it("treats ordinary input as a prompt", () => {
    expect(run("What does src/agent.ts do?").outcome).toBe("not-a-command");
    expect(run("  ").outcome).toBe("not-a-command");
  });

  it("shows help", () => {
    const { outcome, output } = run("/help");

    expect(outcome).toBe("handled");
    expect(output).toContain("/session");
    expect(output).toContain("Ctrl+C");
  });

  it("describes the session, including its log file", () => {
    const { output } = run("/session");

    expect(output).toContain("session-under-test");
    expect(output).toContain("/workspace");
    expect(output).toContain("sessions/session-under-test.jsonl");
  });

  it("lists the tools the model can call", () => {
    expect(run("/tools").output).toBe("  list_files\n  read_file\n");
  });

  it("clears the transcript", async () => {
    const session = createSession();
    await session.prompt("Question");
    expect(session.messages.length).toBeGreaterThan(0);

    const outcome = handleSlashCommand("/clear", {
      session,
      write: () => {},
    });

    expect(outcome).toBe("handled");
    expect(session.messages).toEqual([]);
  });

  it("exits on /exit and /quit", () => {
    expect(run("/exit").outcome).toBe("exit");
    expect(run("/quit").outcome).toBe("exit");
  });

  it("reports an unknown command instead of prompting the model", () => {
    const { outcome, output } = run("/nope");

    expect(outcome).toBe("handled");
    expect(output).toContain("Unknown command");
  });
});

describe("JSON event stream", () => {
  it("writes the header first, then one line per event", async () => {
    const session = createSession();
    let output = "";
    session.subscribe(
      createJsonEventWriter({ write: (chunk) => (output += chunk) }, session.header()),
    );

    await session.prompt("Question");

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(records[0]).toMatchObject({
      type: "session",
      version: 1,
      id: "session-under-test",
      cwd: "/workspace",
    });
    expect(records.map((record) => record.type)).toContain("agent_start");
    expect(records.at(-1)).toMatchObject({
      type: "agent_end",
      status: "completed",
    });
  });
});

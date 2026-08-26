import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { AgentSession } from "../src/session.js";
import {
  createSessionId,
  defaultSessionHome,
  FileSessionStore,
  parseTranscript,
} from "../src/session-store.js";
import type { Tool, ToolOutput } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient } from "./fakes.js";

const workspace: Workspace = {
  root: "/workspace",
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

function tool(name: string, output: ToolOutput): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" },
    async execute() {
      return output;
    },
  };
}

function createSession(
  llm: FakeLLMClient,
  overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {},
): AgentSession {
  return new AgentSession({
    agent: {
      systemPrompt: "System prompt",
      maxTurns: 4,
      llm,
      tools: [tool("echo", { content: "echoed", isError: false })],
      workspace,
      streaming: false,
    },
    cwd: "/workspace",
    ...overrides,
  });
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "chivgent-session-"));
}

describe("AgentSession", () => {
  it("carries the transcript into the next prompt", async () => {
    const llm = new FakeLLMClient([
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const session = createSession(llm);

    await session.prompt("First question");
    await session.prompt("Second question");

    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer.", toolCalls: [] },
      { role: "user", content: "Second question" },
    ]);
    expect(session.turns).toBe(2);
    expect(session.messages).toHaveLength(4);
  });

  it("forgets the transcript on clear but keeps the session id", async () => {
    const llm = new FakeLLMClient([
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const session = createSession(llm);
    const { id } = session;

    await session.prompt("First question");
    session.clear();
    await session.prompt("Second question");

    expect(session.id).toBe(id);
    expect(llm.requests[1]?.messages).toEqual([
      { role: "user", content: "Second question" },
    ]);
  });

  it("delivers events to every subscriber and survives a failing one", async () => {
    const llm = new FakeLLMClient([assistant("Answer.")]);
    const session = createSession(llm);
    const seen: string[] = [];
    session.subscribe(() => {
      throw new Error("subscriber crashed");
    });
    session.subscribe((event: AgentEvent) => seen.push(event.type));

    await session.prompt("Question");

    expect(seen).toContain("agent_start");
    expect(seen.at(-1)).toBe("agent_end");
  });

  it("stops delivering to an unsubscribed listener", async () => {
    const llm = new FakeLLMClient([
      assistant("First answer."),
      assistant("Second answer."),
    ]);
    const session = createSession(llm);
    const seen: string[] = [];
    const unsubscribe = session.subscribe((event) => seen.push(event.type));

    await session.prompt("First question");
    const afterFirst = seen.length;
    unsubscribe();
    await session.prompt("Second question");

    expect(seen).toHaveLength(afterFirst);
  });

  it("records a header and the run events, but not deltas", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    const llm = new FakeLLMClient([
      assistant("", [{ id: "call-1", name: "echo", arguments: {} }]),
      assistant("Answer."),
    ]);
    const session = createSession(llm, { store, id: "session-under-test" });

    await session.prompt("Question");

    const contents = await readFile(store.location(session.id), "utf8");
    const types = contents
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types[0]).toBe("session");
    expect(types).toContain("tool_execution_start");
    expect(types).not.toContain("message_update");
    expect(types.at(-1)).toBe("agent_end");
  });

  it("restores a recorded transcript", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    const first = createSession(new FakeLLMClient([assistant("First answer.")]), {
      store,
      id: "restored-session",
    });
    await first.prompt("First question");

    const transcript = await store.read("restored-session");
    const resumedLlm = new FakeLLMClient([assistant("Second answer.")]);
    const resumed = createSession(resumedLlm, {
      store,
      id: "restored-session",
      resumed: true,
      ...(transcript === undefined ? {} : { messages: transcript.messages }),
    });
    await resumed.prompt("Second question");

    expect(resumedLlm.requests[0]?.messages).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer.", toolCalls: [] },
      { role: "user", content: "Second question" },
    ]);
    const contents = await readFile(store.location("restored-session"), "utf8");
    const headers = contents
      .trim()
      .split("\n")
      .filter((line) => (JSON.parse(line) as { type: string }).type === "session");
    expect(headers).toHaveLength(1);
  });
});

describe("FileSessionStore", () => {
  it("lists sessions for a workspace, newest first", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    for (const [id, cwd, prompt] of [
      ["session-a", "/workspace", "Question A"],
      ["session-b", "/elsewhere", "Question B"],
    ] as const) {
      const session = createSession(new FakeLLMClient([assistant("Answer.")]), {
        store,
        id,
        cwd,
      });
      await session.prompt(prompt);
    }

    const listed = await store.list({ cwd: "/workspace" });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "session-a",
      cwd: "/workspace",
      promptCount: 1,
      lastPrompt: "Question A",
    });
  });

  it("returns nothing for an unknown session or an empty home", async () => {
    const store = new FileSessionStore(await temporaryHome());

    await expect(store.read("missing-session")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects a session id that could escape the session directory", () => {
    const store = new FileSessionStore("/tmp/chivgent-home");

    expect(() => store.location("../../etc/passwd")).toThrow(
      "Invalid session id",
    );
  });

  it("ignores unparsable and non-session files", async () => {
    const home = await temporaryHome();
    const store = new FileSessionStore(home);
    await mkdir(path.join(home, "sessions"), { recursive: true });
    await writeFile(path.join(home, "sessions", "broken.jsonl"), "{oops\n");
    await writeFile(path.join(home, "sessions", "notes.txt"), "ignored");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("keeps the last complete run when the file ends mid-line", () => {
    const transcript = parseTranscript(
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "session-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({ type: "agent_start", prompt: "Question", maxTurns: 8 }),
        JSON.stringify({
          type: "agent_end",
          status: "completed",
          turnCount: 1,
          messages: [{ role: "user", content: "Question" }],
        }),
        '{"type":"agent_start","prompt":"Truncat',
      ].join("\n"),
    );

    expect(transcript?.messages).toEqual([
      { role: "user", content: "Question" },
    ]);
    expect(transcript?.prompts).toEqual(["Question"]);
  });

  it("derives the session home from the environment", () => {
    expect(defaultSessionHome({ CHIVGENT_HOME: "/custom/home" })).toBe(
      "/custom/home",
    );
    expect(defaultSessionHome({})).toMatch(/\.chivgent$/);
  });

  it("creates sortable, filesystem-safe session ids", () => {
    const id = createSessionId(new Date("2026-08-25T17:38:00.000Z"));

    expect(id).toMatch(/^2026-08-25T17-38-00-000Z-[a-z0-9]+$/);
  });
});

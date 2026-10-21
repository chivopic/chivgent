import { describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { createLocalSession } from "../src/cli-runtime.js";
import { PermissionPolicy } from "../src/permissions.js";
import { WEB_SEARCH_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT } from "../src/prompts.js";
import { assistant, FakeLLMClient } from "./fakes.js";
import { ShellApprovalGate } from "../src/shell/approval.js";

describe("local CLI session setup", () => {
  it("exposes read tools and the permission-free plan control by default", () => {
    const session = createLocalSession({
      options: parseCliArgs([], {}),
      cwd: "/workspace",
      llm: new FakeLLMClient([]),
      restored: { resumed: false },
    });
    expect(session.toolNames).toEqual(["list_files", "search_text", "read_file", "update_plan"]);
  });

  it("adds write and shell tools only when enabled", () => {
    const session = createLocalSession({
      options: parseCliArgs(["--allow-writes", "--allow-shell"], {}),
      cwd: "/workspace",
      llm: new FakeLLMClient([]),
      restored: { resumed: false },
    });
    expect(session.toolNames).toEqual([
      "list_files", "search_text", "read_file", "update_plan", "write_file", "edit_file", "apply_patch", "bash",
    ]);
  });

  it("registers web_search only with an explicitly configured backend", () => {
    const withoutSearch = createLocalSession({
      options: parseCliArgs([], {}),
      cwd: "/workspace",
      llm: new FakeLLMClient([]),
      restored: { resumed: false },
    });
    expect(withoutSearch.toolNames).not.toContain("web_search");

    const withSearch = createLocalSession({
      options: parseCliArgs(["--web-search", "https://search.example"], {}),
      cwd: "/workspace",
      llm: new FakeLLMClient([]),
      restored: { resumed: false },
    });
    expect(withSearch.toolNames).toContain("web_search");
  });

  it("adds web search instructions and denies without approval in ask-first mode", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "s1", name: "web_search", arguments: { query: "internal notes" } }]),
      assistant("Could not search."),
    ]);
    const session = createLocalSession({
      options: parseCliArgs(["--web-search", "https://search.example"], {}),
      cwd: "/workspace",
      llm,
      permissionPolicy: new PermissionPolicy("ask-first", async () => false),
      restored: { resumed: false },
    });

    await session.prompt("Search for the notes");
    expect(llm.requests[0]?.systemPrompt).toContain(WEB_SEARCH_SYSTEM_PROMPT);
    const toolResult = session.messages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({
      isError: true,
      content: expect.stringContaining("No request was sent"),
    });
  });

  it("passes the correct capability instructions to the model", async () => {
    const llm = new FakeLLMClient([assistant("Done")]);
    const session = createLocalSession({
      options: parseCliArgs(["--allow-writes"], {}),
      cwd: "/workspace",
      llm,
      restored: { resumed: false },
    });

    await session.prompt("Edit a file");
    expect(llm.requests[0]?.systemPrompt).toContain(WRITE_SYSTEM_PROMPT);
    expect(llm.requests[0]?.systemPrompt).not.toContain("You can also run shell commands");
  });
  it("combines modern shell and web search instructions without contradictory legacy flags", async () => {
    const llm = new FakeLLMClient([assistant("Done")]);
    const session = createLocalSession({
      options: parseCliArgs(["--permission-mode", "workspace", "--web-search", "https://search.example"], {}),
      cwd: "/workspace",
      llm,
      permissionPolicy: new PermissionPolicy("workspace"),
      restored: { resumed: false },
    });

    await session.prompt("Run a test");
    const prompt = llm.requests[0]?.systemPrompt ?? "";
    expect(prompt).not.toContain("--allow-writes");
    expect(prompt).not.toContain("--shell-network");
    expect(prompt).toContain(WEB_SEARCH_SYSTEM_PROMPT);
    expect(prompt).toContain("shell commands, web search, and extension tools");
    expect(prompt).toContain('scope "network"');
    expect(prompt).toContain('scope "host"');
  });

  it("keeps network scope out of the legacy tool and rejects a direct network request", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "network", name: "bash", arguments: { command: "printf should-not-run", scope: "network", justification: "Check the scope" } }]),
      assistant("Done"),
    ]);
    const approval = vi.fn(async () => true);
    const gate = new ShellApprovalGate();
    gate.setHandler(approval);
    const session = createLocalSession({
      options: parseCliArgs(["--allow-shell"], {}),
      cwd: process.cwd(),
      llm,
      shellApproval: gate,
      restored: { resumed: false },
    });

    await session.prompt("Run a harmless shell command");

    const bash = llm.requests[0]?.tools.find(tool => tool.name === "bash");
    expect(bash?.inputSchema).toMatchObject({ properties: { scope: { enum: ["workspace"] } } });
    expect(session.messages.some(message => message.role === "tool" && message.toolName === "bash" && message.content.includes('scope "network" is unavailable'))).toBe(true);
    expect(approval).not.toHaveBeenCalled();
  });

  it("routes a modern network request through the one-command network approval", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "network", name: "bash", arguments: { command: "printf should-not-run", scope: "network", justification: "Check network access" } }]),
      assistant("Done"),
    ]);
    const approval = vi.fn(async (_command: string, _signal?: AbortSignal, _context?: string) => false);
    const session = createLocalSession({
      options: parseCliArgs(["--permission-mode", "workspace", "--shell-backend", "docker"], {}),
      cwd: process.cwd(),
      llm,
      permissionPolicy: new PermissionPolicy("workspace", approval),
      restored: { resumed: false },
    });

    await session.prompt("Run a harmless network-scoped command");

    expect(approval).toHaveBeenCalledOnce();
    expect(approval.mock.calls[0]?.[2]).toContain("Network access for this command only");
    expect(approval.mock.calls[0]?.[2]).not.toContain("Expanded host access");
    expect(session.messages.find(message => message.role === "tool" && message.toolName === "bash")?.content).toBe("Shell command denied by user.");
    expect(llm.requests[0]?.tools.find(tool => tool.name === "bash")?.inputSchema)
      .toMatchObject({ properties: { scope: { enum: ["workspace", "network", "host"] } } });
  });

  it("passes a typed denial from the shell gate to the next provider request", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "shell", name: "bash", arguments: { command: "curl https://example.test" } }]),
      assistant("The command could not be reviewed."),
    ]);
    const gate = new ShellApprovalGate();
    gate.setHandler(async () => ({ approved: false, reason: "unreviewable" }));
    const session = createLocalSession({
      options: parseCliArgs(["--allow-shell"], {}),
      cwd: process.cwd(),
      llm,
      shellApproval: gate,
      restored: { resumed: false },
    });

    await session.prompt("Run the command");

    const toolResult = session.messages.find(message => message.role === "tool" && message.toolName === "bash");
    expect(toolResult?.content).toContain("command cannot be safely displayed");
    expect(llm.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: expect.stringContaining("command cannot be safely displayed"),
    }));
  });

  it("reports a missing shell approval channel as unavailable to the provider", async () => {
    const llm = new FakeLLMClient([
      assistant("", [{ id: "shell", name: "bash", arguments: { command: "npm test" } }]),
      assistant("Approval is unavailable."),
    ]);
    const gate = new ShellApprovalGate();
    const session = createLocalSession({
      options: parseCliArgs(["--allow-shell"], {}),
      cwd: process.cwd(),
      llm,
      shellApproval: gate,
      restored: { resumed: false },
    });

    await session.prompt("Run the command");

    expect(session.messages.find(message => message.role === "tool" && message.toolName === "bash")?.content)
      .toBe("Shell command denied: approval is unavailable.");
    expect(llm.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: "Shell command denied: approval is unavailable.",
    }));
  });

  it("identifies the agent without inventing a backend model", async () => {
    const llm = new FakeLLMClient([assistant("Done")]);
    const session = createLocalSession({
      options: parseCliArgs([], {}),
      cwd: "/workspace",
      llm,
      restored: { resumed: false },
    });

    await session.prompt("Which model are you?");
    const prompt = llm.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain("You are chivgent, a coding agent");
    expect(prompt).toContain("The host chooses the provider and model.");
    expect(prompt).toContain("Do not guess or assert an unverified backend model identity.");
    expect(prompt).not.toContain("You can also change files with write_file");
    expect(prompt).not.toContain("You can also run shell commands with bash");
  });

  it("requires tool evidence and offers an executable workflow", async () => {
    const llm = new FakeLLMClient([assistant("Done")]);
    const session = createLocalSession({
      options: parseCliArgs(["--allow-writes", "--allow-shell"], {}),
      cwd: "/workspace",
      llm,
      restored: { resumed: false },
    });

    await session.prompt("Fix the bug and test it");
    const prompt = llm.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain("discovery, focused changes, and available verification");
    expect(prompt).toContain("Only use tools that are actually supplied for this run.");
    expect(prompt).toContain("Never claim a command, edit, or test succeeded unless its tool result confirms it.");
    expect(prompt).toContain(WRITE_SYSTEM_PROMPT);
    expect(prompt).toContain("You can also run shell commands with bash");
  });

  it("ignores restored compaction when --no-compaction is set", async () => {
    const llm = new FakeLLMClient([assistant("Done")]);
    const session = createLocalSession({
      options: parseCliArgs(["--no-compaction"], {}),
      cwd: "/workspace",
      llm,
      restored: {
        resumed: true,
        messages: [
          { role: "user", content: "old user" },
          { role: "assistant", content: "old assistant", toolCalls: [] },
          { role: "user", content: "latest user" },
        ],
        compaction: {
          splitIndex: 2,
          state: {
            summary: "summary",
            decisions: [],
            pendingTasks: [],
            readFiles: [],
            modifiedFiles: [],
          },
        },
      },
    });

    await session.prompt("new user");
    expect(llm.requests[0]?.messages).toEqual([
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant", toolCalls: [] },
      { role: "user", content: "latest user" },
      { role: "user", content: "new user" },
    ]);
  });
});

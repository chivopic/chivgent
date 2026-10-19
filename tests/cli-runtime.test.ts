import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { createLocalSession } from "../src/cli-runtime.js";
import { WRITE_SYSTEM_PROMPT } from "../src/prompts.js";
import { assistant, FakeLLMClient } from "./fakes.js";
import { PermissionPolicy } from "../src/permissions.js";

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
  it("passes modern permission instructions without contradictory legacy flags", async () => {
    const llm = new FakeLLMClient([assistant("Done")]);
    const session = createLocalSession({
      options: parseCliArgs(["--permission-mode", "workspace"], {}),
      cwd: "/workspace",
      llm,
      permissionPolicy: new PermissionPolicy("workspace"),
      restored: { resumed: false },
    });

    await session.prompt("Run a test");
    const prompt = llm.requests[0]?.systemPrompt ?? "";
    expect(prompt).not.toContain("--allow-writes");
    expect(prompt).not.toContain("--shell-network");
    expect(prompt).toContain('scope "network"');
    expect(prompt).toContain('scope "host"');
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

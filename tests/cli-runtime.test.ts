import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { createLocalSession } from "../src/cli-runtime.js";
import { WRITE_SYSTEM_PROMPT } from "../src/prompts.js";
import { assistant, FakeLLMClient } from "./fakes.js";

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

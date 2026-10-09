import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { createLocalSession } from "../src/cli-runtime.js";
import { WRITE_SYSTEM_PROMPT } from "../src/prompts.js";
import { assistant, FakeLLMClient } from "./fakes.js";

describe("local CLI session setup", () => {
  it("only exposes read tools by default", () => {
    const session = createLocalSession({
      options: parseCliArgs([], {}),
      cwd: "/workspace",
      llm: new FakeLLMClient([]),
      restored: { resumed: false },
    });
    expect(session.toolNames).toEqual(["list_files", "search_text", "read_file"]);
  });

  it("adds write and shell tools only when enabled", () => {
    const session = createLocalSession({
      options: parseCliArgs(["--allow-writes", "--allow-shell"], {}),
      cwd: "/workspace",
      llm: new FakeLLMClient([]),
      restored: { resumed: false },
    });
    expect(session.toolNames).toEqual([
      "list_files", "search_text", "read_file", "write_file", "edit_file", "bash",
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
});

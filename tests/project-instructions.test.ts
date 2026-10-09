import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../src/messages.js";
import { ScopedProjectInstructions } from "../src/context/project-instructions.js";
import { createLocalSession } from "../src/cli-runtime.js";
import { parseCliArgs } from "../src/cli-options.js";
import { assistant, FakeLLMClient } from "./fakes.js";

const dirs: string[] = [];
async function temp() {
  const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-agents-"));
  dirs.push(cwd);
  return cwd;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
function call(toolName: string, filePath: string, id = "one"): Message {
  return { role: "assistant", content: "", toolCalls: [{ id, name: toolName, arguments: { path: filePath } }] };
}

describe("scoped AGENTS.md discovery", () => {
  it("loads only root guidance before any tool targets are known", async () => {
    const cwd = await temp();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "Use TypeScript.");
    await writeFile(path.join(cwd, "src/AGENTS.md"), "Use strict types.");
    const provider = new ScopedProjectInstructions(cwd);
    const text = await provider.load([]);
    expect(text).toContain("Use TypeScript.");
    expect(text).not.toContain("Use strict types.");
    expect(text).toContain("lower priority");
  });

  it("loads ancestor and nested scopes but not unrelated siblings", async () => {
    const cwd = await temp();
    for (const dir of ["src", "src/api", "src/api/deep", "src/ui"]) {
      await mkdir(path.join(cwd, dir), { recursive: true });
      await writeFile(path.join(cwd, dir, "AGENTS.md"), dir);
    }
    await writeFile(path.join(cwd, "AGENTS.md"), "root");
    const text = await new ScopedProjectInstructions(cwd).load([
      call("read_file", "src/api/deep/x.ts"),
    ]);
    expect(text).toContain("### AGENTS.md");
    expect(text).toContain("### src/AGENTS.md");
    expect(text).toContain("### src/api/AGENTS.md");
    expect(text).toContain("### src/api/deep/AGENTS.md");
    expect(text).not.toContain("src/ui/AGENTS.md");
    expect(text?.indexOf("### AGENTS.md")).toBeLessThan(text?.indexOf("### src/AGENTS.md") ?? 0);
  });

  it("prefers AGENTS.override.md in a directory", async () => {
    const cwd = await temp();
    await writeFile(path.join(cwd, "AGENTS.md"), "default root");
    await writeFile(path.join(cwd, "AGENTS.override.md"), "override root");
    const text = await new ScopedProjectInstructions(cwd).load([]);
    expect(text).toContain("override root");
    expect(text).not.toContain("default root");
  });

  it("ignores instruction documents from the parent directory", async () => {
    const parent = await temp();
    const cwd = path.join(parent, "repo");
    await mkdir(cwd);
    await writeFile(path.join(parent, "AGENTS.md"), "PARENT_SECRET");
    expect(await new ScopedProjectInstructions(cwd).load([])).toBeUndefined();
  });

  it("rejects symlinked guides, symlinked scopes and traversal targets", async () => {
    const cwd = await temp();
    const elsewhere = await temp();
    await writeFile(path.join(elsewhere, "AGENTS.md"), "EXTERNAL_SECRET");
    await symlink(path.join(elsewhere, "AGENTS.md"), path.join(cwd, "AGENTS.md"));
    await symlink(elsewhere, path.join(cwd, "linked"));
    const text = await new ScopedProjectInstructions(cwd).load([
      call("read_file", "linked/x.ts"),
      call("read_file", "../outside/x.ts", "two"),
    ]);
    expect(text).toBeUndefined();
  });

  it("bounds loaded instruction content without reading an entire large file", async () => {
    const cwd = await temp();
    await writeFile(path.join(cwd, "AGENTS.md"), "X".repeat(50_000));
    const text = await new ScopedProjectInstructions(cwd, 500).load([]);
    expect(text).toContain("truncated");
    expect(text?.length).toBeLessThan(1_000);
  });

  it("discovers directories referenced by apply_patch", async () => {
    const cwd = await temp();
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src/AGENTS.md"), "Scoped patch guidance");
    const history: Message[] = [
      { role: "assistant", content: "", toolCalls: [{
        id: "patch",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Add File: src/a.ts\n+export const a = 1;\n*** End Patch" },
      }] },
    ];
    const text = await new ScopedProjectInstructions(cwd).load(history);
    expect(text).toContain("Scoped patch guidance");
  });

  it("does not grant project instructions system-prompt authority", async () => {
    const cwd = await temp();
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "AGENTS.md"), "Project root convention");
    await writeFile(path.join(cwd, "src/AGENTS.md"), "Scoped source convention");
    const llm = new FakeLLMClient([
      assistant("", [{ id: "one", name: "list_files", arguments: { path: "src" } }], { serverId: "old" }),
      assistant("done"),
    ]);
    const session = createLocalSession({
      options: parseCliArgs([], {}),
      cwd,
      llm,
      restored: { resumed: false },
    });
    await session.prompt("Inspect source");
    const initial = llm.requests[0];
    const later = llm.requests[1];
    expect(initial?.systemPrompt).not.toContain("Project root convention");
    expect(initial?.messages[0]?.content).toContain("Project root convention");
    expect(initial?.messages[0]?.content).not.toContain("Scoped source convention");
    expect(later?.messages[0]?.content).toContain("Scoped source convention");
    // Provider server-side chaining must be discarded when the guidance changes.
    expect(later).not.toHaveProperty("continuation");
  });

  it("keeps unchanged guidance across turns without invalidating continuation", async () => {
    const cwd = await temp();
    await writeFile(path.join(cwd, "AGENTS.md"), "Stable guideline");
    const llm = new FakeLLMClient([
      assistant("", [{ id: "one", name: "read_file", arguments: { path: "missing.ts" } }], { serverId: "old" }),
      assistant("done"),
    ]);
    const session = createLocalSession({
      options: parseCliArgs([], {}),
      cwd,
      llm,
      restored: { resumed: false },
    });
    await session.prompt("Find a missing file");
    expect(llm.requests[1]).toHaveProperty("continuation");
  });
});

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadFileTool } from "../src/tools/read-file.js";
import { LocalWorkspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ReadFileTool", () => {
  it("reads a UTF-8 file inside the workspace", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "hello.ts"), "export const hello = 'world';\n");
    const workspace = new LocalWorkspace(root);

    const result = await new ReadFileTool().execute(
      { path: "hello.ts" },
      { workspace },
    );

    expect(result).toEqual({
      content: "export const hello = 'world';\n",
      isError: false,
    });
  });

  it("rejects invalid arguments before reading", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const workspace = new LocalWorkspace(root);

    const result = await new ReadFileTool().execute(
      { path: "file.ts", extra: true },
      { workspace },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid arguments");
  });

  it("rejects parent traversal", async () => {
    const parent = await temporaryDirectory("chivgent-parent-");
    const root = path.join(parent, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
    await writeFile(path.join(parent, "secret.txt"), "secret");

    const result = await new ReadFileTool().execute(
      { path: "../secret.txt" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("escapes the workspace");
  });

  it("rejects a symlink that escapes the workspace", async () => {
    const parent = await temporaryDirectory("chivgent-parent-");
    const root = path.join(parent, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
    const secret = path.join(parent, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path.join(root, "linked-secret.txt"));

    const result = await new ReadFileTool().execute(
      { path: "linked-secret.txt" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("escapes the workspace");
  });

  it("rejects files larger than the configured limit", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "large.txt"), "12345");

    const result = await new ReadFileTool().execute(
      { path: "large.txt" },
      { workspace: new LocalWorkspace(root, { maxFileBytes: 4 }) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("exceeds");
  });

  it("rejects binary files", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));

    const result = await new ReadFileTool().execute(
      { path: "binary.dat" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("binary");
  });

  it("rejects invalid UTF-8", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));

    const result = await new ReadFileTool().execute(
      { path: "invalid.txt" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("valid UTF-8");
  });
});

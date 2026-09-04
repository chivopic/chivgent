import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WriteFileTool } from "../src/tools/write-file.js";
import { LocalWorkspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writableWorkspace(root: string): LocalWorkspace {
  return new LocalWorkspace(root, { allowWrites: true });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WriteFileTool", () => {
  it("creates a new file and reports it as created", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new WriteFileTool().execute(
      { path: "greet.ts", contents: "export const hello = true;\n" },
      { workspace: writableWorkspace(root) },
    );

    expect(result).toEqual({
      content: "Created greet.ts (1 lines, 27 bytes).",
      isError: false,
    });
    expect(await readFile(path.join(root, "greet.ts"), "utf8")).toBe(
      "export const hello = true;\n",
    );
  });

  it("replaces an existing file and reports it as replaced", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "greet.ts"), "old\n");

    const result = await new WriteFileTool().execute(
      { path: "greet.ts", contents: "new\nlines\n" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Replaced greet.ts (2 lines, 10 bytes).");
    expect(await readFile(path.join(root, "greet.ts"), "utf8")).toBe(
      "new\nlines\n",
    );
  });

  it("creates missing parent directories", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new WriteFileTool().execute(
      { path: "src/deep/nested.ts", contents: "ok\n" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(await readFile(path.join(root, "src/deep/nested.ts"), "utf8")).toBe(
      "ok\n",
    );
  });

  it("refuses to write when the workspace is read-only", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new WriteFileTool().execute(
      { path: "greet.ts", contents: "nope\n" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--allow-writes");
  });

  it("refuses to escape the workspace root", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new WriteFileTool().execute(
      { path: "../escaped.ts", contents: "nope\n" },
      { workspace: writableWorkspace(root) },
    );

    expect(result).toEqual({
      content: "Path escapes the workspace: ../escaped.ts",
      isError: true,
    });
  });

  it("refuses to write through a symlinked directory", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const outside = await temporaryDirectory("chivgent-outside-");
    await symlink(outside, path.join(root, "linked"), "dir");

    const result = await new WriteFileTool().execute(
      { path: "linked/escaped.ts", contents: "nope\n" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Symlinks are not followed");
  });

  it("refuses to write to sensitive paths", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await mkdir(path.join(root, ".git"));

    const result = await new WriteFileTool().execute(
      { path: ".git/config", contents: "nope\n" },
      { workspace: writableWorkspace(root) },
    );

    expect(result).toEqual({
      content: "Access to this sensitive workspace path is not allowed.",
      isError: true,
    });
  });

  it("refuses NUL bytes without touching the target", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "keep.ts"), "original\n");

    const result = await new WriteFileTool().execute(
      { path: "keep.ts", contents: "bad\0byte" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(await readFile(path.join(root, "keep.ts"), "utf8")).toBe(
      "original\n",
    );
  });

  it("rejects unknown arguments", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new WriteFileTool().execute(
      { path: "greet.ts", contents: "ok\n", mode: "append" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid arguments");
  });
});

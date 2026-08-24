import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
  it("reads and describes a UTF-8 line range", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "hello.ts"), "first\nsecond\nthird\n");

    const result = await new ReadFileTool().execute(
      { path: "hello.ts", start_line: 2, line_count: 2 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toEqual({
      content: "File: hello.ts (lines 2-3 of 3)\n---\nsecond\nthird\n",
      isError: false,
    });
  });

  it("keeps path-only calls backward compatible", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "hello.ts"), "export const hello = true;\n");

    const result = await new ReadFileTool().execute(
      { path: "hello.ts" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toEqual({
      content:
        "File: hello.ts (lines 1-1 of 1)\n---\nexport const hello = true;\n",
      isError: false,
    });
  });

  it("returns a continuation hint for a truncated range", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const contents = Array.from(
      { length: 205 },
      (_, index) => `line ${index + 1}\n`,
    ).join("");
    await writeFile(path.join(root, "long.txt"), contents);

    const result = await new ReadFileTool().execute(
      { path: "long.txt", start_line: 1, line_count: 200 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("lines 1-200 of 205");
    expect(result.content).toContain(
      '[truncated: continue with {"path":"long.txt","start_line":201,"line_count":200}]',
    );
  });

  it("preserves CRLF while counting logical lines", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "windows.txt"), "one\r\ntwo\r\nthree\r\n");

    const slice = await new LocalWorkspace(root).readTextFile("windows.txt", {
      startLine: 2,
      lineCount: 1,
    });

    expect(slice).toEqual({
      content: "two\r\n",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true,
    });
  });

  it("rejects invalid arguments before reading", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const result = await new ReadFileTool().execute(
      { path: "file.ts", start_line: 0, line_count: 501 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid arguments");
  });

  it("rejects a range beyond the end of the file", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "short.txt"), "only\n");

    const result = await new ReadFileTool().execute(
      { path: "short.txt", start_line: 2, line_count: 1 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("outside short.txt");
  });

  it("rejects parent traversal", async () => {
    const parent = await temporaryDirectory("chivgent-parent-");
    const root = path.join(parent, "workspace");
    await mkdir(root);
    await writeFile(path.join(parent, "secret.txt"), "secret");

    const result = await new ReadFileTool().execute(
      { path: "../secret.txt", start_line: 1, line_count: 200 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("escapes the workspace");
  });

  it("rejects a symlink that escapes the workspace", async () => {
    const parent = await temporaryDirectory("chivgent-parent-");
    const root = path.join(parent, "workspace");
    await mkdir(root);
    const secret = path.join(parent, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path.join(root, "linked-secret.txt"));

    const result = await new ReadFileTool().execute(
      { path: "linked-secret.txt", start_line: 1, line_count: 200 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("escapes the workspace");
  });

  it("rejects files larger than the configured limit", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "large.txt"), "12345");

    const result = await new ReadFileTool().execute(
      { path: "large.txt", start_line: 1, line_count: 200 },
      { workspace: new LocalWorkspace(root, { maxFileBytes: 4 }) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("exceeds");
  });

  it("rejects binary files", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));

    const result = await new ReadFileTool().execute(
      { path: "binary.dat", start_line: 1, line_count: 200 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("binary");
  });

  it("rejects invalid UTF-8", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));

    const result = await new ReadFileTool().execute(
      { path: "invalid.txt", start_line: 1, line_count: 200 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("valid UTF-8");
  });

  it("blocks sensitive files but allows environment templates", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(root, ".env.example"), "TOKEN=\n");
    const tool = new ReadFileTool();
    const workspace = new LocalWorkspace(root);

    const forbidden = await tool.execute(
      { path: ".env", start_line: 1, line_count: 200 },
      { workspace },
    );
    const allowed = await tool.execute(
      { path: ".env.example", start_line: 1, line_count: 200 },
      { workspace },
    );

    expect(forbidden).toMatchObject({ isError: true });
    expect(forbidden.content).toBe(
      "Access to this sensitive workspace path is not allowed.",
    );
    expect(allowed).toMatchObject({ isError: false });
    expect(allowed.content).toContain("TOKEN=");
  });

  it("keeps tool output within 64 KiB", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "wide.txt"), "界".repeat(30_000));

    const result = await new ReadFileTool().execute(
      { path: "wide.txt", start_line: 1, line_count: 1 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(result.content).toContain("line 1 truncated");
  });
});

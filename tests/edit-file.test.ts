import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditFileTool } from "../src/tools/edit-file.js";
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

describe("EditFileTool", () => {
  it("replaces a unique passage and reports the line", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(
      path.join(root, "app.ts"),
      "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    );

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "const b = 2;", new_text: "const b = 20;" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Edited app.ts at line 2 (now 3 lines, 40 bytes).");
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 20;\nconst c = 3;\n",
    );
  });

  it("deletes text when new_text is empty", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "app.ts"), "keep\nremove\nkeep\n");

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "remove\n", new_text: "" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe(
      "keep\nkeep\n",
    );
  });

  it("refuses an ambiguous match and leaves the file alone", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const original = "value\nvalue\n";
    await writeFile(path.join(root, "app.ts"), original);

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "value", new_text: "other" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears more than once");
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe(original);
  });

  it("refuses a missing match and leaves the file alone", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const original = "value\n";
    await writeFile(path.join(root, "app.ts"), original);

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "absent", new_text: "other" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not appear in app.ts");
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe(original);
  });

  it("refuses a no-op edit", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "app.ts"), "value\n");

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "value", new_text: "value" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("would change nothing");
  });

  it("reports a missing file instead of creating one", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new EditFileTool().execute(
      { path: "absent.ts", old_text: "a", new_text: "b" },
      { workspace: writableWorkspace(root) },
    );

    expect(result).toEqual({
      content: "Path does not exist: absent.ts",
      isError: true,
    });
  });

  it("refuses to edit when the workspace is read-only", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "app.ts"), "value\n");

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "value", new_text: "other" },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("--allow-writes");
  });

  it("matches LF old_text against a CRLF file and keeps CRLF", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(
      path.join(root, "crlf.ts"),
      "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n",
    );

    // A model that echoes the file back routinely normalises CRLF to LF.
    const result = await new EditFileTool().execute(
      {
        path: "crlf.ts",
        old_text: "const a = 1;\nconst b = 2;",
        new_text: "const a = 9;\nconst b = 8;",
      },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(await readFile(path.join(root, "crlf.ts"), "utf8")).toBe(
      "const a = 9;\r\nconst b = 8;\r\nconst c = 3;\r\n",
    );
  });

  it("also accepts CRLF old_text against a CRLF file", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "crlf.ts"), "a\r\nb\r\n");

    const result = await new EditFileTool().execute(
      { path: "crlf.ts", old_text: "a\r\nb", new_text: "x\r\ny" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    expect(await readFile(path.join(root, "crlf.ts"), "utf8")).toBe("x\r\ny\r\n");
  });

  it("preserves a byte order mark", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const file = path.join(root, "bom.ts");
    await writeFile(file, "\uFEFFconst a = 1;\n");

    const result = await new EditFileTool().execute(
      { path: "bom.ts", old_text: "const a = 1;", new_text: "const a = 9;" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString("utf8")).toBe("\uFEFFconst a = 9;\n");
  });

  it("leaves untouched lines alone in a file with mixed line endings", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    const file = path.join(root, "mixed.ts");
    await writeFile(file, "alpha\r\nbeta\ngamma\r\n");

    const result = await new EditFileTool().execute(
      { path: "mixed.ts", old_text: "beta", new_text: "delta" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(false);
    // Normalising the whole file would have rewritten the other two lines.
    expect(await readFile(file, "utf8")).toBe("alpha\r\ndelta\ngamma\r\n");
  });

  it("treats a CRLF-only difference as a no-op edit", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");
    await writeFile(path.join(root, "crlf.ts"), "a\r\nb\r\n");

    const result = await new EditFileTool().execute(
      { path: "crlf.ts", old_text: "a\r\nb", new_text: "a\nb" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("would change nothing");
  });

  it("rejects an empty old_text", async () => {
    const root = await temporaryDirectory("chivgent-workspace-");

    const result = await new EditFileTool().execute(
      { path: "app.ts", old_text: "", new_text: "x" },
      { workspace: writableWorkspace(root) },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid arguments");
  });
});

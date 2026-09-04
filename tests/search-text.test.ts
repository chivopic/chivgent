import { readOnlyWorkspaceWrites } from "./fakes.js";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchTextTool } from "../src/tools/search-text.js";
import { LocalWorkspace, type Workspace } from "../src/workspace.js";

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

describe("SearchTextTool", () => {
  it("finds one case-sensitive match per line in deterministic order", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await writeFile(path.join(root, "b.ts"), "Agent in b\n");
    await writeFile(path.join(root, "a.ts"), "Agent Agent in a\nagent lower\n");

    const result = await new LocalWorkspace(root).searchText({
      query: "Agent",
    });

    expect(result).toEqual({
      matches: [
        { path: "a.ts", line: 1, preview: "Agent Agent in a" },
        { path: "b.ts", line: 1, preview: "Agent in b" },
      ],
      truncated: false,
      scannedFiles: 2,
      skippedFiles: 0,
    });
  });

  it("searches an explicitly selected file", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await writeFile(path.join(root, "file.ts"), "first\nneedle here\nthird\n");

    const result = await new LocalWorkspace(root).searchText({
      query: "needle",
      path: "file.ts",
    });

    expect(result.matches).toEqual([
      { path: "file.ts", line: 2, preview: "needle here" },
    ]);
    expect(result.scannedFiles).toBe(1);
  });

  it("keeps a long-line preview bounded while retaining the match", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await writeFile(
      path.join(root, "wide.ts"),
      `${"a".repeat(400)}needle${"b".repeat(400)}\n`,
    );

    const result = await new LocalWorkspace(root).searchText({
      query: "needle",
    });
    const preview = result.matches[0]?.preview;

    expect(preview).toContain("needle");
    expect([...(preview ?? "")].length).toBeLessThanOrEqual(300);
  });

  it("skips ignored and sensitive paths without counting them", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(root, "ignored.ts"), "needle");
    await writeFile(path.join(root, "dist", "bundle.js"), "needle");
    await writeFile(path.join(root, ".env"), "needle=secret");
    await writeFile(path.join(root, "visible.ts"), "needle");

    const result = await new LocalWorkspace(root).searchText({
      query: "needle",
    });

    expect(result.matches).toEqual([
      { path: "visible.ts", line: 1, preview: "needle" },
    ]);
    expect(result).toMatchObject({ scannedFiles: 2, skippedFiles: 0 });
  });

  it("skips binary, invalid UTF-8, and oversized candidate files", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, "large.txt"), "x".repeat(20));
    await writeFile(path.join(root, "visible.txt"), "needle");

    const result = await new LocalWorkspace(root, {
      maxFileBytes: 16,
    }).searchText({ query: "needle" });

    expect(result.matches).toEqual([
      { path: "visible.txt", line: 1, preview: "needle" },
    ]);
    expect(result).toMatchObject({ scannedFiles: 1, skippedFiles: 3 });
  });

  it("marks result, file, and byte limits as truncation", async () => {
    const resultRoot = await temporaryDirectory("chivgent-search-results-");
    await writeFile(path.join(resultRoot, "matches.txt"), "needle\nneedle\n");
    const resultLimited = await new LocalWorkspace(resultRoot).searchText({
      query: "needle",
      maxResults: 1,
    });

    const fileRoot = await temporaryDirectory("chivgent-search-files-");
    await writeFile(path.join(fileRoot, "a.txt"), "none");
    await writeFile(path.join(fileRoot, "b.txt"), "needle");
    const fileLimited = await new LocalWorkspace(fileRoot, {
      maxSearchFiles: 1,
    }).searchText({ query: "needle" });

    const byteRoot = await temporaryDirectory("chivgent-search-bytes-");
    await writeFile(path.join(byteRoot, "large.txt"), "needle");
    const byteLimited = await new LocalWorkspace(byteRoot, {
      maxSearchBytes: 5,
    }).searchText({ query: "needle" });

    expect(resultLimited).toMatchObject({
      matches: [{ path: "matches.txt", line: 1, preview: "needle" }],
      truncated: true,
    });
    expect(fileLimited).toMatchObject({
      matches: [],
      scannedFiles: 1,
      truncated: true,
    });
    expect(byteLimited).toMatchObject({
      matches: [],
      scannedFiles: 0,
      skippedFiles: 0,
      truncated: true,
    });
  });

  it("does not follow directory symlinks", async () => {
    const parent = await temporaryDirectory("chivgent-search-parent-");
    const root = path.join(parent, "workspace");
    const external = path.join(parent, "external");
    await mkdir(root);
    await mkdir(external);
    await writeFile(path.join(external, "secret.txt"), "needle");
    await writeFile(path.join(root, "visible.txt"), "needle");
    await symlink(external, path.join(root, "linked"));

    const result = await new LocalWorkspace(root).searchText({
      query: "needle",
    });

    expect(result.matches.map((match) => match.path)).toEqual(["visible.txt"]);
  });

  it("formats no-match and truncation metadata for the model", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await writeFile(path.join(root, "file.txt"), "haystack");
    const tool = new SearchTextTool();

    const result = await tool.execute(
      { query: "needle", path: ".", max_results: 50 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toEqual({
      content: "No matches found.\n[scanned: 1 files; skipped: 0]",
      isError: false,
    });
  });

  it("rejects invalid queries and explicit sensitive paths", async () => {
    const root = await temporaryDirectory("chivgent-search-");
    await writeFile(path.join(root, ".env"), "TOKEN=secret");
    const tool = new SearchTextTool();
    const workspace = new LocalWorkspace(root);

    const invalid = await tool.execute(
      { query: "two\nlines", path: ".", max_results: 50 },
      { workspace },
    );
    const forbidden = await tool.execute(
      { query: "TOKEN", path: ".env", max_results: 50 },
      { workspace },
    );

    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content).toContain("Invalid arguments");
    expect(forbidden).toMatchObject({ isError: true });
    expect(forbidden.content).toBe(
      "Access to this sensitive workspace path is not allowed.",
    );
  });

  it("keeps formatted matches within 64 KiB", async () => {
    const workspace: Workspace = {
      root: "/workspace",
      ...readOnlyWorkspaceWrites,
      async readTextFile() {
        throw new Error("not used");
      },
      async listFiles() {
        throw new Error("not used");
      },
      async searchText() {
        return {
          matches: Array.from({ length: 200 }, (_, index) => ({
            path: `${"segment/".repeat(100)}file-${index}.ts`,
            line: index + 1,
            preview: "needle",
          })),
          truncated: false,
          scannedFiles: 200,
          skippedFiles: 0,
        };
      },
    };

    const result = await new SearchTextTool().execute(
      { query: "needle", path: ".", max_results: 200 },
      { workspace },
    );

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(result.content).toContain("[truncated:");
    expect(result.content).toContain("[scanned: 200 files; skipped: 0]");
  });
});

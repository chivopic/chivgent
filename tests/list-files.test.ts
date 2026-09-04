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
import { ListFilesTool } from "../src/tools/list-files.js";
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

describe("ListFilesTool", () => {
  it("lists entries in deterministic order and respects depth", async () => {
    const root = await temporaryDirectory("chivgent-list-");
    await mkdir(path.join(root, "src", "nested", "deep"), {
      recursive: true,
    });
    await writeFile(path.join(root, "b.ts"), "b");
    await writeFile(path.join(root, "a.ts"), "a");
    await writeFile(path.join(root, "src", "index.ts"), "index");
    await writeFile(path.join(root, "src", "nested", "value.ts"), "value");
    await writeFile(
      path.join(root, "src", "nested", "deep", "hidden.ts"),
      "deep",
    );
    const workspace = new LocalWorkspace(root);

    const shallow = await workspace.listFiles({ path: ".", maxDepth: 1 });
    const deeper = await workspace.listFiles({ path: ".", maxDepth: 2 });

    expect(shallow.entries.map((entry) => entry.path)).toEqual([
      "a.ts",
      "b.ts",
      "src/",
    ]);
    expect(deeper.entries.map((entry) => entry.path)).toEqual([
      "a.ts",
      "b.ts",
      "src/",
      "src/index.ts",
      "src/nested/",
    ]);
  });

  it("applies fixed ignores, root .gitignore, and sensitive-path rules", async () => {
    const root = await temporaryDirectory("chivgent-list-");
    await mkdir(path.join(root, "node_modules", "package"), { recursive: true });
    await mkdir(path.join(root, "dist"));
    await mkdir(path.join(root, ".git"));
    await writeFile(
      path.join(root, ".gitignore"),
      "ignored.txt\n*.log\n!kept.log\n!node_modules/\n",
    );
    await writeFile(path.join(root, "ignored.txt"), "ignored");
    await writeFile(path.join(root, "debug.log"), "ignored");
    await writeFile(path.join(root, "kept.log"), "kept");
    await writeFile(path.join(root, ".env"), "TOKEN=secret");
    await writeFile(path.join(root, ".env.example"), "TOKEN=");
    await writeFile(path.join(root, "private.pem"), "private");
    await writeFile(path.join(root, "visible.ts"), "visible");
    await writeFile(path.join(root, ".git", "config"), "git");
    await writeFile(path.join(root, "dist", "bundle.js"), "built");
    await writeFile(
      path.join(root, "node_modules", "package", "index.js"),
      "dependency",
    );

    const result = await new LocalWorkspace(root).listFiles();
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toEqual([
      ".env.example",
      ".gitignore",
      "kept.log",
      "visible.ts",
    ]);
  });

  it("does not follow symlink entries", async () => {
    const parent = await temporaryDirectory("chivgent-list-parent-");
    const root = path.join(parent, "workspace");
    const external = path.join(parent, "external");
    await mkdir(root);
    await mkdir(external);
    await writeFile(path.join(external, "secret.ts"), "secret");
    await writeFile(path.join(root, "visible.ts"), "visible");
    await symlink(external, path.join(root, "linked-directory"));
    await symlink(
      path.join(root, "visible.ts"),
      path.join(root, "linked-file.ts"),
    );

    const result = await new LocalWorkspace(root).listFiles();

    expect(result.entries.map((entry) => entry.path)).toEqual(["visible.ts"]);
  });

  it("rejects an explicitly selected directory symlink", async () => {
    const root = await temporaryDirectory("chivgent-list-");
    await mkdir(path.join(root, "target"));
    await symlink(path.join(root, "target"), path.join(root, "linked"));

    const result = await new ListFilesTool().execute(
      { path: "linked", max_depth: 4 },
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("Directory symlinks are not followed");
  });

  it("reports truncation at the workspace entry limit", async () => {
    const root = await temporaryDirectory("chivgent-list-");
    await Promise.all(
      ["a.ts", "b.ts", "c.ts"].map((name) =>
        writeFile(path.join(root, name), name),
      ),
    );

    const result = await new LocalWorkspace(root).listFiles({
      maxEntries: 2,
    });

    expect(result).toEqual({
      entries: [
        { path: "a.ts", type: "file" },
        { path: "b.ts", type: "file" },
      ],
      truncated: true,
    });
  });

  it("formats tool output and accepts legacy omitted defaults", async () => {
    const root = await temporaryDirectory("chivgent-list-");
    await writeFile(path.join(root, "index.ts"), "index");

    const result = await new ListFilesTool().execute(
      {},
      { workspace: new LocalWorkspace(root) },
    );

    expect(result).toEqual({ content: "index.ts", isError: false });
  });

  it("rejects invalid arguments and non-directory paths", async () => {
    const root = await temporaryDirectory("chivgent-list-");
    await writeFile(path.join(root, "file.ts"), "file");
    const tool = new ListFilesTool();
    const workspace = new LocalWorkspace(root);

    const invalid = await tool.execute(
      { path: ".", max_depth: 0 },
      { workspace },
    );
    const file = await tool.execute(
      { path: "file.ts", max_depth: 4 },
      { workspace },
    );

    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content).toContain("Invalid arguments");
    expect(file).toMatchObject({ isError: true });
    expect(file.content).toContain("not a directory");
  });

  it("keeps formatted listings within 64 KiB", async () => {
    const workspace: Workspace = {
      root: "/workspace",
      ...readOnlyWorkspaceWrites,
      async readTextFile() {
        throw new Error("not used");
      },
      async listFiles() {
        return {
          entries: Array.from({ length: 200 }, (_, index) => ({
            path: `${"segment/".repeat(100)}file-${index}.ts`,
            type: "file" as const,
          })),
          truncated: false,
        };
      },
      async searchText() {
        throw new Error("not used");
      },
    };

    const result = await new ListFilesTool().execute(
      { path: ".", max_depth: 4 },
      { workspace },
    );

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(result.content).toContain("[truncated:");
  });
});

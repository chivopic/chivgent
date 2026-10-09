import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePatch, PatchError } from "../src/patch/parse.js";
import { ApplyPatchTool } from "../src/tools/apply-patch.js";
import { LocalWorkspace } from "../src/workspace.js";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-patch-"));
  dirs.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("apply_patch", () => {
  it("updates two files, adds one and deletes one with a single patch", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.ts"), "alpha\nbeta\ngamma\n");
    await writeFile(path.join(root, "src/b.ts"), "one\ntwo\n");
    await writeFile(path.join(root, "obsolete.ts"), "remove me\n");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    const result = await workspace.applyPatch([
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** Update File: src/b.ts",
      "@@",
      "-one",
      "+ONE",
      " two",
      "*** Add File: src/new.ts",
      "+export const created = true;",
      "*** Delete File: obsolete.ts",
      "*** End Patch",
    ].join("\n"));
    expect(result).toEqual({
      added: ["src/new.ts"], updated: ["src/a.ts", "src/b.ts"], deleted: ["obsolete.ts"],
    });
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(await readFile(path.join(root, "src/b.ts"), "utf8")).toBe("ONE\ntwo\n");
    expect(await readFile(path.join(root, "src/new.ts"), "utf8")).toBe("export const created = true;\n");
    await expect(readFile(path.join(root, "obsolete.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights all hunks before touching the first file", async () => {
    const root = await temp();
    await writeFile(path.join(root, "a.txt"), "before\n");
    await writeFile(path.join(root, "b.txt"), "actual\n");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await expect(workspace.applyPatch([
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-before",
      "+after",
      "*** Update File: b.txt",
      "@@",
      "-stale",
      "+new",
      "*** End Patch",
    ].join("\n"))).rejects.toThrow(/context not found/);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("before\n");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("actual\n");
  });

  it("rejects ambiguous context instead of modifying a guessed occurrence", async () => {
    const root = await temp();
    await writeFile(path.join(root, "a.txt"), "same\nsame\n");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await expect(workspace.applyPatch(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-same\n+new\n*** End Patch",
    )).rejects.toThrow(/Ambiguous/);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("same\nsame\n");
  });

  it("supports multiple ordered hunks in one file", async () => {
    const root = await temp();
    await writeFile(path.join(root, "a.ts"), "first\nkeep\nlast\n");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await workspace.applyPatch([
      "*** Begin Patch", "*** Update File: a.ts",
      "@@", "-first", "+FIRST", " keep",
      "@@", "-last", "+LAST",
      "*** End Patch",
    ].join("\n"));
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("FIRST\nkeep\nLAST\n");
  });

  it("preserves uniform CRLF and a UTF-8 BOM", async () => {
    const root = await temp();
    await writeFile(path.join(root, "a.txt"), "\uFEFFalpha\r\nbeta\r\n");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await workspace.applyPatch("*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n beta\n*** End Patch");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("\uFEFFALPHA\r\nbeta\r\n");
  });

  it("refuses read-only mode and sensitive or escaping paths", async () => {
    const root = await temp();
    const patch = "*** Begin Patch\n*** Add File: x.txt\n+hello\n*** End Patch";
    await expect(new LocalWorkspace(root).applyPatch(patch)).rejects.toMatchObject({ code: "writes_disabled" });
    const writable = new LocalWorkspace(root, { allowWrites: true });
    for (const pathname of ["../escape.txt", ".git/config", ".env", "a/../../escape.txt"]) {
      await expect(writable.applyPatch(
        `*** Begin Patch\n*** Add File: ${pathname}\n+secret\n*** End Patch`,
      )).rejects.toThrow();
    }
  });

  it("does not follow directory symlinks", async () => {
    const root = await temp();
    const outside = await temp();
    await symlink(outside, path.join(root, "linked"));
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await expect(workspace.applyPatch(
      "*** Begin Patch\n*** Add File: linked/payload.txt\n+hello\n*** End Patch",
    )).rejects.toThrow(/Symlinks/);
    await expect(readFile(path.join(outside, "payload.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate aliases, overwrites via Add File and malformed lines", async () => {
    const root = await temp();
    await writeFile(path.join(root, "existing.txt"), "before");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await expect(workspace.applyPatch(
      "*** Begin Patch\n*** Add File: existing.txt\n+after\n*** End Patch",
    )).rejects.toThrow(/already exists/);
    await expect(workspace.applyPatch([
      "*** Begin Patch",
      "*** Add File: x.txt", "+one",
      "*** Add File: nested/../x.txt", "+two",
      "*** End Patch",
    ].join("\n"))).rejects.toThrow(/Duplicate normalized/);
    expect(() => parsePatch(
      "*** Begin Patch\n*** Add File: x\nbad line\n*** End Patch",
    )).toThrow(PatchError);
    expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("before");
  });

  it("summarizes modified lines and affected files after a successful patch", async () => {
    const root = await temp();
    await writeFile(path.join(root, "file.txt"), "before\n");
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    const outcome = await new ApplyPatchTool().execute({
      patch: "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch",
    }, { workspace });
    expect(outcome).toEqual({
      content: "Patch applied (1 file):\nM file.txt (+1/-1, 1 hunk(s))",
      isError: false,
    });
  });

  it("returns a structured tool error for conflicts, without writing files", async () => {
    const root = await temp();
    await writeFile(path.join(root, "file.txt"), "real\n");
    const tool = new ApplyPatchTool();
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    const outcome = await tool.execute({
      patch: "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch",
    }, { workspace });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toMatch(/context not found/);
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe("real\n");
  });

  it("cancels a patch without changing any files", async () => {
    const root = await temp();
    const signal = AbortSignal.abort();
    const workspace = new LocalWorkspace(root, { allowWrites: true });
    await expect(workspace.applyPatch(
      "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch",
      signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

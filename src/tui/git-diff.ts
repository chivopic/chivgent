import { terminalText } from "./text.js";
import { readOnlyGit } from "../workspace/git-read.js";
import { isForbiddenRelativePath, isPathInside } from "../workspace/paths.js";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export type GitDiffMode = "working" | "staged" | "all";
const REVIEW_LIMIT = 256 * 1024;
const UNTRACKED_FILE_LIMIT = 64 * 1024;
const REVIEW_TIMEOUT = 7_000;

async function disabledFilterConfig(workspace: string, deadline: number): Promise<string[]> {
  const names = await readOnlyGit(workspace, ["config", "--name-only", "--null", "--list", "--includes"],
    REVIEW_LIMIT, Math.max(1, deadline - Date.now()));
  const keys = new Set(names.split("\0").filter(name => /^filter\..+\.(?:clean|process|smudge|required)$/i.test(name)));
  for (const key of [...keys]) {
    if (key.endsWith(".clean") || key.endsWith(".process") || key.endsWith(".smudge")) {
      keys.add(`${key.slice(0, key.lastIndexOf("."))}.required`);
    }
  }
  return [...keys].flatMap(name => ["-c", `${name}=${name.endsWith(".required") ? "false" : ""}`]);
}

/**
 * Only a user-approved read-only Git diff. This never invokes a shell, hooks,
 * an external diff, textconv, or network. It does not grant the LLM execution.
 */
export async function readLiveGitDiff(workspace: string, mode: GitDiffMode): Promise<string> {
  const args = [
    "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
    "--no-renames", "--ignore-submodules=all",
    ...(mode === "staged" ? ["--cached"] : []), "--", ".",
  ];
  try {
    const deadline = Date.now() + REVIEW_TIMEOUT;
    const filterOverrides = await disabledFilterConfig(workspace, deadline);
    if (mode !== "all") {
      return terminalText(await readOnlyGit(workspace, [...filterOverrides, ...args], REVIEW_LIMIT,
        Math.max(1, deadline - Date.now())));
    }
    const staged = await readOnlyGit(workspace, [
      ...filterOverrides,
      "--no-pager", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color",
      "--no-renames", "--ignore-submodules=all", "--", ".",
    ], REVIEW_LIMIT, Math.max(1, deadline - Date.now()));
    const unstaged = await readOnlyGit(workspace, [...filterOverrides, ...args], REVIEW_LIMIT, Math.max(1, deadline - Date.now()));
    if (Buffer.byteLength(staged) + Buffer.byteLength(unstaged) > REVIEW_LIMIT) {
      throw new Error("Git review exceeds the 256 KiB limit.");
    }
    const root = await realpath(workspace);
    const listing = await readOnlyGit(root, [
      ...filterOverrides, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z", "--", ".",
    ], REVIEW_LIMIT, Math.max(1, deadline - Date.now()));
    const pieces: string[] = [];
    if (staged.length > 0) pieces.push("=== Staged changes ===\n", staged);
    if (unstaged.length > 0) pieces.push("=== Unstaged changes ===\n", unstaged);
    let total = pieces.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
    const omitted: string[] = [];
    const names = listing.split("\0").filter(Boolean);
    if (names.length > 256) omitted.push(`${names.length - 256} files beyond 256-file limit`);
    for (const name of names.slice(0, 256)) {
      if (Date.now() >= deadline) {
        omitted.push("review timed out");
        break;
      }
      const segments = name.split("/");
      if (isForbiddenRelativePath(name)) {
        omitted.push("protected workspace path");
        continue;
      }
      if (path.isAbsolute(name) || segments.some(segment => segment === ".." || segment === ".git")) {
        omitted.push("unsafe path");
        continue;
      }
      const file = path.resolve(root, ...segments);
      if (!isPathInside(root, file) || file === root) {
        omitted.push("unsafe path");
        continue;
      }
      let stat;
      try {
        let current = root;
        let safe = true;
        for (let index = 0; index < segments.length; index += 1) {
          current = path.join(current, segments[index]!);
          const item = await lstat(current);
          if (item.isSymbolicLink() || (index < segments.length - 1 && !item.isDirectory())) {
            safe = false;
            break;
          }
          if (index === segments.length - 1) stat = item;
        }
        if (!safe || !stat?.isFile()) {
          omitted.push("symlink or non-regular file");
          continue;
        }
      } catch {
        omitted.push("unreadable file");
        continue;
      }
      if (stat.size > UNTRACKED_FILE_LIMIT) {
        omitted.push("file over 64 KiB");
        continue;
      }
      let bytes: Buffer;
      try {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) {
            omitted.push("symlink or non-regular file");
            continue;
          }
          if (opened.size > UNTRACKED_FILE_LIMIT) {
            omitted.push("file over 64 KiB");
            continue;
          }
          const buffer = Buffer.alloc(UNTRACKED_FILE_LIMIT + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > UNTRACKED_FILE_LIMIT) {
            omitted.push("file over 64 KiB");
            continue;
          }
          bytes = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch {
        omitted.push("unreadable file");
        continue;
      }
      if (bytes.includes(0)) {
        const label = JSON.stringify(name);
        const piece = `=== Untracked binary file ===\n${label} (binary, ${bytes.length} bytes)\n`;
        if (total + Buffer.byteLength(piece) > REVIEW_LIMIT) {
          omitted.push("review over 256 KiB");
          continue;
        }
        pieces.push(piece);
        total += Buffer.byteLength(piece);
        continue;
      }
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        const label = JSON.stringify(name);
        const piece = `=== Untracked binary or invalid UTF-8 file ===\n${label} (${bytes.length} bytes)\n`;
        if (total + Buffer.byteLength(piece) > REVIEW_LIMIT) {
          omitted.push("review over 256 KiB");
          continue;
        }
        pieces.push(piece);
        total += Buffer.byteLength(piece);
        continue;
      }
      const hasTrailingNewline = text.endsWith("\n");
      const lines = text.length === 0 ? [] : text.split("\n");
      if (hasTrailingNewline) lines.pop();
      const label = JSON.stringify(name);
      const hunk = lines.length === 0 ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join("")}${hasTrailingNewline ? "" : "\\ No newline at end of file\n"}`;
      const piece = `=== Untracked file ===\n--- /dev/null\n+++ b/${label}\n${hunk}`;
      if (total + Buffer.byteLength(piece) > REVIEW_LIMIT) {
        omitted.push("review over 256 KiB");
        continue;
      }
      pieces.push(piece);
      total += Buffer.byteLength(piece);
    }
    if (omitted.length > 0) pieces.push(`\n[Review omitted ${omitted.length} item(s): ${[...new Set(omitted)].join(", ")}.]\n`);
    const result = terminalText(pieces.join(""));
    if (Buffer.byteLength(result) > REVIEW_LIMIT) throw new Error("Git review exceeds the 256 KiB limit after terminal sanitization.");
    return result;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Git review exceeds")) throw error;
    const typed = error as NodeJS.ErrnoException & { killed?: boolean };
    if (typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Git diff exceeds the 256 KiB review limit.");
    }
    if (typed.killed) throw new Error("Git diff timed out; no changes were made.");
    throw new Error("Unable to read Git diff from this workspace.");
  }
}

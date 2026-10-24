import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { WorkspaceReviewData, WorkspaceReviewFile } from "../protocol/messages.js";
import { readOnlyGit } from "@chivgent/workspace/git-read.ts";
import { normalizeRelativePath, rejectExplicitDirectorySymlink, resolveExistingPath } from "@chivgent/workspace/paths.ts";
import { WorkspaceError } from "@chivgent/workspace/types.ts";
import { isForbiddenDesktopReviewPath } from "../workspace-policy.js";

const MAX_DIFF_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_UNTRACKED_FILES = 500;
const MAX_DIFF_FILES = 500;

export type UntrackedReview = WorkspaceReviewFile;
export type WorkspaceReview = WorkspaceReviewData;

/** Read-only, bounded workspace data. Git hooks, external diff and textconv are disabled. */
export async function readWorkspaceReview(workspace: string): Promise<WorkspaceReview> {
  let root: string;
  try { root = await realpath(workspace); }
  catch { return { kind: "not-git" }; }
  try { await runGit(root, ["rev-parse", "--show-toplevel"]); }
  catch (error: unknown) {
    if (isNotRepository(error)) return { kind: "not-git" };
    throw gitError(error);
  }
  const [staged, unstaged, paths] = await Promise.all([
    readDiff(root, ["diff", "--cached"]), readDiff(root, ["diff"]), listUntracked(root),
  ]);
  const truncated = paths.length > MAX_UNTRACKED_FILES;
  const untracked: UntrackedReview[] = [];
  for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) untracked.push(await preview(root, path));
  return { kind: "git", staged, unstaged, untracked, truncated };
}

async function readDiff(root: string, args: string[]): Promise<string> {
  try {
    const names = await runGit(root, ["--literal-pathspecs", ...args, "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all", "--", "."]);
    const allowed = names.split("\0").filter((path) => path.length > 0 && !isForbiddenDesktopReviewPath(path));
    if (allowed.length > MAX_DIFF_FILES) throw new Error("Diff contains more than 500 reviewable files.");
    if (allowed.length === 0) return "";
    const diff = await runGit(root, ["--literal-pathspecs", ...args, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all", "--", ...allowed]);
    if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) throw new Error("Diff exceeds the 256 KiB review limit.");
    return diff;
  } catch (error: unknown) {
    if (error instanceof Error && (error.message.includes("review limit") || error.message.includes("reviewable files"))) throw error;
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Diff exceeds the 256 KiB review limit.");
    throw gitError(error);
  }
}
async function listUntracked(root: string): Promise<string[]> {
  try {
    const stdout = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
    return stdout.split("\0").filter(Boolean);
  } catch (error: unknown) { throw gitError(error); }
}
async function preview(root: string, path: string): Promise<UntrackedReview> {
  let target: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (isForbiddenDesktopReviewPath(path)) return { path, kind: "unsafe" };
    normalizeRelativePath(root, path);
    const resolved = await resolveExistingPath(root, path);
    await rejectExplicitDirectorySymlink(root, resolved, path);
    target = resolved.realTarget;
    const before = await stat(target);
    if (!before.isFile() || before.size > MAX_PREVIEW_BYTES) return { path, kind: before.size > MAX_PREVIEW_BYTES ? "too-large" : "unsafe" };
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile()) return { path, kind: "unsafe" };
    if (after.size > MAX_PREVIEW_BYTES) return { path, kind: "too-large" };
    const bounded = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_PREVIEW_BYTES) return { path, kind: "too-large" };
    const bytes = bounded.subarray(0, bytesRead);
    if (bytes.includes(0)) return { path, kind: "binary" };
    try { return { path, kind: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
    catch { return { path, kind: "binary" }; }
  } catch (error: unknown) {
    if (error instanceof WorkspaceError) return { path, kind: "unsafe" };
    if (["ELOOP", "ENOENT", "EACCES"].includes(String((error as NodeJS.ErrnoException).code))) return { path, kind: "unsafe" };
    return { path, kind: "unavailable" };
  } finally { await handle?.close(); }
}
async function runGit(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES + 1): Promise<string> { return readOnlyGit(cwd, args, maxBuffer); }
function isNotRepository(error: unknown): boolean { return String((error as { stderr?: unknown }).stderr ?? "").includes("not a git repository"); }
function gitError(error: unknown): Error {
  if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) return new Error("Git workspace review timed out.");
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Error("Git is unavailable; workspace changes could not be read.");
  if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new Error("Git workspace output exceeds the review limit.");
  return new Error("Unable to read workspace changes.");
}

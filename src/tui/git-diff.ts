import { terminalText } from "./text.js";
import { readOnlyGit } from "../workspace/git-read.js";

export type GitDiffMode = "working" | "staged";

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
    const stdout = await readOnlyGit(workspace, args, 256 * 1024);
    return terminalText(stdout);
  } catch (error: unknown) {
    const typed = error as NodeJS.ErrnoException & { killed?: boolean };
    if (typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Git diff exceeds the 256 KiB review limit.");
    }
    if (typed.killed) throw new Error("Git diff timed out; no changes were made.");
    throw new Error("Unable to read Git diff from this workspace.");
  }
}

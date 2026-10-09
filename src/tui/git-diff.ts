import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { terminalText } from "./text.js";

const execute = promisify(execFile);
export type GitDiffMode = "working" | "staged";

/**
 * Only a user-approved read-only Git diff. This never invokes a shell, hooks,
 * an external diff, textconv, or network. It does not grant the LLM execution.
 */
export async function readLiveGitDiff(workspace: string, mode: GitDiffMode): Promise<string> {
  const root = await realpath(workspace);
  const args = [
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
    "--no-renames", "--ignore-submodules=all",
    ...(mode === "staged" ? ["--cached"] : []), "--", ".",
  ];
  try {
    const { stdout } = await execute("git", args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      timeout: 7_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ATTR_NOSYSTEM: "1",
      },
    });
    return terminalText(stdout);
  } catch (error: unknown) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Git diff exceeds the 256 KiB review limit.");
    }
    if (typed.killed) throw new Error("Git diff timed out; no changes were made.");
    throw new Error("Unable to read Git diff from this workspace.");
  }
}

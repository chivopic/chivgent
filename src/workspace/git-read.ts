import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Runs a bounded, read-only Git query without a shell or user/system configuration. */
export async function readOnlyGit(cwd: string, args: readonly string[], maxBuffer = 256 * 1024): Promise<string> {
  const root = await realpath(cwd);
  const { stdout } = await execute("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
    cwd: root, shell: false, windowsHide: true, timeout: 7_000, maxBuffer,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ATTR_NOSYSTEM: "1",
    },
  });
  return stdout;
}

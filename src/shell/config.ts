import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ShellUnavailableError } from "./types.js";

export interface ShellConfig {
  readonly shell: string;
  readonly args: readonly string[];
}

function whichBash(): string | undefined {
  try {
    const result = spawnSync("which", ["bash"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const first = result.stdout.trim().split("\n")[0];
      if (first !== undefined && first.length > 0) {
        return first;
      }
    }
  } catch {
    // Fall through to sh.
  }
  return undefined;
}

/**
 * Resolves the shell to run commands with.
 *
 * Windows is deliberately unsupported for now: doing it properly means Git Bash
 * discovery, WSL's `bash.exe -s` (which takes the command on stdin rather than
 * argv), and a separate PowerShell tool. That is a stage of its own, and a
 * clear error is more useful than a half-working shell.
 */
export function resolveShellConfig(
  platform: NodeJS.Platform = process.platform,
): ShellConfig {
  if (platform === "win32") {
    throw new ShellUnavailableError(
      "The bash tool is not supported on Windows yet. Run chivgent under WSL.",
    );
  }
  if (existsSync("/bin/bash")) {
    return { shell: "/bin/bash", args: ["-c"] };
  }
  const bash = whichBash();
  if (bash !== undefined) {
    return { shell: bash, args: ["-c"] };
  }
  return { shell: "sh", args: ["-c"] };
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveShellConfig, type ShellConfig } from "./config.js";
import {
  killProcessTree,
  trackChildPid,
  untrackChildPid,
  waitForChildProcess,
} from "./process.js";
import {
  ShellAbortError,
  ShellTimeoutError,
  ShellUnavailableError,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOperations,
} from "./types.js";

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

/** Kept as a call so narrowing never hides a signal that aborts mid-command. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export function validateTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeout must be a positive number of seconds.");
  }
  if (value > MAX_TIMEOUT_SECONDS) {
    throw new TypeError(
      `timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return value;
}

export interface LocalShellOptions {
  /** Resolved once per command so a shell installed mid-session is picked up. */
  readonly resolveConfig?: () => ShellConfig;
}

/** Runs commands as child processes of this one. */
export function createLocalShellOperations(
  options: LocalShellOptions = {},
): ShellOperations {
  const resolveConfig = options.resolveConfig ?? (() => resolveShellConfig());

  return {
    async exec(
      command: string,
      cwd: string,
      execOptions: ShellExecOptions,
    ): Promise<ShellExecResult> {
      const { onData, signal, timeoutSeconds, env } = execOptions;
      if (isAborted(signal)) {
        throw new ShellAbortError();
      }
      if (!existsSync(cwd)) {
        throw new ShellUnavailableError(
          `Working directory does not exist: ${cwd}`,
        );
      }

      const config = resolveConfig();
      // detached makes the child a process group leader, which is what lets a
      // cancel kill its descendants too.
      const child = spawn(config.shell, [...config.args, command], {
        cwd,
        detached: true,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (child.pid !== undefined) {
        trackChildPid(child.pid);
      }

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        if (child.pid !== undefined) {
          killProcessTree(child.pid);
        }
      };

      try {
        if (timeoutSeconds !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            onAbort();
          }, timeoutSeconds * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal !== undefined) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        const exitCode = await waitForChildProcess(child);
        // Order matters: an abort that also tripped the timeout is an abort.
        if (isAborted(signal)) {
          throw new ShellAbortError();
        }
        if (timedOut) {
          throw new ShellTimeoutError(timeoutSeconds ?? 0);
        }
        return { exitCode };
      } finally {
        if (child.pid !== undefined) {
          untrackChildPid(child.pid);
        }
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

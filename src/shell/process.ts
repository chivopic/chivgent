import type { ChildProcess } from "node:child_process";

/**
 * How long to keep reading after a child exits.
 *
 * A short-lived command can exit while a descendant it detached still holds the
 * stdout pipe and keeps writing. Finalising on `exit` would destroy the stream
 * mid-write and silently drop that tail, so the timer is re-armed on every
 * chunk: a descendant that is still writing keeps us reading, while a quiet
 * inherited handle that never lets `close` fire still releases us.
 */
const POST_EXIT_IDLE_MS = 100;

/**
 * Kills a process and everything it spawned.
 *
 * Children are spawned detached, which makes each one a process group leader,
 * so a negative pid signals the whole group. Killing only the direct child
 * would leave its grandchildren running: stopping `npm test` would kill the npm
 * process and leave the test workers holding CPU and ports.
 */
export function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const trackedPids = new Set<number>();

/** Detached children outlive the parent, so every pid is tracked until it exits. */
export function trackChildPid(pid: number): void {
  trackedPids.add(pid);
}

export function untrackChildPid(pid: number): void {
  trackedPids.delete(pid);
}

/** Kills every command still running. Called when chivgent itself is shutting down. */
export function killTrackedChildren(): void {
  for (const pid of trackedPids) {
    killProcessTree(pid);
  }
  trackedPids.clear();
}

/**
 * Resolves with the exit code once the child has exited and its pipes have
 * fallen idle. Rejects only when the process could not be spawned.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const finalizeIfPipesClosed = (): void => {
      if (exited && !settled && stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => finalize(exitCode), POST_EXIT_IDLE_MS);
    };

    const onData = (): void => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };

    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      finalizeIfPipesClosed();
    };

    const onStderrEnd = (): void => {
      stderrEnded = true;
      finalizeIfPipesClosed();
    };

    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      finalizeIfPipesClosed();
      if (!settled) {
        armIdleTimer();
      }
    };

    const onClose = (code: number | null): void => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

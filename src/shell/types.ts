// Shared contracts for shell execution.

/** Raised when a command was killed because its AbortSignal fired. */
export class ShellAbortError extends Error {
  constructor() {
    super("Command aborted");
    // The Agent recognises this name and ends the run as aborted, exactly as
    // it does for a cancelled Provider call.
    this.name = "AbortError";
  }
}

/** Raised when a command outlived the timeout it was given. */
export class ShellTimeoutError extends Error {
  constructor(readonly timeoutSeconds: number) {
    super(`Command timed out after ${timeoutSeconds} seconds`);
    this.name = "ShellTimeoutError";
  }
}

export class ShellUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellUnavailableError";
  }
}

export interface ShellExecOptions {
  /** Receives raw stdout and stderr chunks, interleaved in arrival order. */
  readonly onData: (chunk: Buffer) => void;
  readonly signal?: AbortSignal;
  readonly timeoutSeconds?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ShellExecResult {
  /** null when the process was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
}

/**
 * Pluggable command execution.
 *
 * Local `spawn` is one implementation. A container or an SSH backend is
 * another, and the shell tool never needs to know which it has.
 */
export interface ShellOperations {
  exec(
    command: string,
    cwd: string,
    options: ShellExecOptions,
  ): Promise<ShellExecResult>;
}

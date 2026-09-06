import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { createLocalShellOperations, validateTimeoutSeconds } from "../shell/local.js";
import { OutputAccumulator } from "../shell/output.js";
import { formatSize, type TruncationResult } from "../shell/truncate.js";
import {
  ShellTimeoutError,
  ShellUnavailableError,
  type ShellOperations,
} from "../shell/types.js";

/** How often a running command may push an output snapshot. */
export const OUTPUT_UPDATE_THROTTLE_MS = 100;

const inputSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Shell command to run in the workspace root. Not interactive: it has no stdin.",
    },
    timeout: {
      type: "number",
      description:
        "Optional timeout in seconds. There is no default; set one for commands that may hang.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

interface BashArguments {
  readonly command: string;
  readonly timeoutSeconds?: number;
}

export interface BashToolOptions {
  readonly cwd: string;
  /** Swap in a container or SSH backend without touching the tool. */
  readonly operations?: ShellOperations;
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly tempDirectory?: string;
  readonly throttleMs?: number;
}

export class BashTool implements Tool {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the workspace root and return its combined stdout and stderr. Output is truncated to the last part of the run; the full output is written to a temp file when that happens. Not interactive: commands get no stdin.";
  readonly inputSchema = inputSchema;

  private readonly cwd: string;
  private readonly operations: ShellOperations;
  private readonly maxLines?: number;
  private readonly maxBytes?: number;
  private readonly tempDirectory?: string;
  private readonly throttleMs: number;

  constructor(options: BashToolOptions) {
    this.cwd = options.cwd;
    this.operations = options.operations ?? createLocalShellOperations();
    if (options.maxLines !== undefined) {
      this.maxLines = options.maxLines;
    }
    if (options.maxBytes !== undefined) {
      this.maxBytes = options.maxBytes;
    }
    if (options.tempDirectory !== undefined) {
      this.tempDirectory = options.tempDirectory;
    }
    this.throttleMs = options.throttleMs ?? OUTPUT_UPDATE_THROTTLE_MS;
  }

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    let parsed: BashArguments | undefined;
    try {
      parsed = parseArguments(argumentsValue);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? error.message : "Invalid arguments.",
        isError: true,
      };
    }
    if (parsed === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"command":"npm test","timeout":120} with a non-empty command.',
        isError: true,
      };
    }

    const output = new OutputAccumulator({
      ...(this.maxLines === undefined ? {} : { maxLines: this.maxLines }),
      ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }),
      ...(this.tempDirectory === undefined
        ? {}
        : { tempDirectory: this.tempDirectory }),
    });
    const publish = createThrottledPublisher(
      output,
      context.onUpdate,
      this.throttleMs,
    );

    try {
      let exitCode: number | null;
      try {
        const result = await this.operations.exec(parsed.command, this.cwd, {
          onData: (chunk) => {
            output.append(chunk);
            publish.schedule();
          },
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(parsed.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: parsed.timeoutSeconds }),
        });
        exitCode = result.exitCode;
      } catch (error: unknown) {
        // An abort ends the whole run, so it propagates; everything else is a
        // tool error that still has to carry whatever the command printed.
        if (isAbortError(error)) {
          throw error;
        }
        const text = await this.finish(output, publish, "");
        if (error instanceof ShellTimeoutError) {
          return { content: appendStatus(text, error.message), isError: true };
        }
        if (error instanceof ShellUnavailableError) {
          return { content: appendStatus(text, error.message), isError: true };
        }
        return {
          content: appendStatus(
            text,
            error instanceof Error ? error.message : "Command failed to start",
          ),
          isError: true,
        };
      }

      const text = await this.finish(output, publish, "(no output)");
      if (exitCode !== 0 && exitCode !== null) {
        return {
          content: appendStatus(text, `Command exited with code ${exitCode}`),
          isError: true,
        };
      }
      return { content: text, isError: false };
    } finally {
      publish.cancel();
    }
  }

  private async finish(
    output: OutputAccumulator,
    publish: ThrottledPublisher,
    emptyText: string,
  ): Promise<string> {
    output.finish();
    publish.cancel();
    publish.flush();
    const snapshot = output.snapshot();
    await output.close();
    return renderOutput(snapshot.content, snapshot.truncation, snapshot.fullOutputPath, emptyText);
  }
}

interface ThrottledPublisher {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

/**
 * Rate-limits output snapshots.
 *
 * A build can print thousands of lines a second; one event per chunk would cost
 * more than the command. Snapshots are sent at most once per interval, and the
 * final result is authoritative anyway.
 */
function createThrottledPublisher(
  output: OutputAccumulator,
  onUpdate: ((content: string) => void) | undefined,
  throttleMs: number,
): ThrottledPublisher {
  if (onUpdate === undefined) {
    return { schedule: () => undefined, flush: () => undefined, cancel: () => undefined };
  }

  let timer: NodeJS.Timeout | undefined;
  let dirty = false;
  let lastPublishedAt = 0;

  const publish = (): void => {
    if (!dirty) {
      return;
    }
    dirty = false;
    lastPublishedAt = Date.now();
    onUpdate(output.snapshot().content);
  };

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    schedule(): void {
      dirty = true;
      const delay = throttleMs - (Date.now() - lastPublishedAt);
      if (delay <= 0) {
        clear();
        publish();
        return;
      }
      timer ??= setTimeout(() => {
        timer = undefined;
        publish();
      }, delay);
    },
    flush(): void {
      clear();
      publish();
    },
    cancel: clear,
  };
}

function renderOutput(
  content: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
  emptyText: string,
): string {
  const text = content.length > 0 ? content : emptyText;
  if (!truncation.truncated) {
    return text;
  }

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const location = truncation.lastLinePartial
    ? `Showing the last ${formatSize(truncation.outputBytes)} of line ${truncation.totalLines}`
    : `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`;
  const reason =
    truncation.truncatedBy === "bytes"
      ? ` (${formatSize(truncation.maxBytes)} limit)`
      : "";
  const full =
    fullOutputPath === undefined ? "" : `. Full output: ${fullOutputPath}`;
  return `${text}\n\n[${location}${reason}${full}]`;
}

function appendStatus(text: string, status: string): string {
  return text.length > 0 ? `${text}\n\n${status}` : status;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function parseArguments(value: unknown): BashArguments | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "command" && key !== "timeout")
  ) {
    return undefined;
  }
  if (typeof record.command !== "string" || record.command.trim().length === 0) {
    return undefined;
  }
  if (record.timeout === undefined) {
    return { command: record.command };
  }
  if (typeof record.timeout !== "number") {
    return undefined;
  }
  return {
    command: record.command,
    timeoutSeconds: validateTimeoutSeconds(record.timeout),
  };
}

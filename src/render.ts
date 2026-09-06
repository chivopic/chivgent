import type { AgentEvent, AgentEventListener } from "./events.js";

const MAX_ARGUMENT_CHARACTERS = 120;
const MAX_RESULT_CHARACTERS = 100;
const MAX_PROGRESS_CHARACTERS = 100;

const DIM = "\u001B[2m";
const RED = "\u001B[31m";
const RESET = "\u001B[0m";

export interface OutputStream {
  write(chunk: string): unknown;
}

export interface RendererStreams {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
}

export interface RendererOptions {
  /** Print assistant text as it arrives instead of at the end of a turn. */
  readonly stream?: boolean;
  /** Print tool activity to stderr. */
  readonly showToolActivity?: boolean;
  /**
   * Print a self-rewriting progress line while a tool runs. Needs a terminal:
   * the line is redrawn with a carriage return.
   */
  readonly showToolProgress?: boolean;
  readonly color?: boolean;
}

/**
 * Renders runtime events for a terminal. The answer goes to stdout so it stays
 * pipeable; tool activity and run status go to stderr.
 */
export function createEventRenderer(
  streams: RendererStreams,
  options: RendererOptions = {},
): AgentEventListener {
  const stream = options.stream ?? true;
  const showToolActivity = options.showToolActivity ?? true;
  const showToolProgress = options.showToolProgress ?? false;
  const color = options.color ?? false;
  const paint = (value: string, code: string): string =>
    color ? `${code}${value}${RESET}` : value;
  let lineOpen = false;
  let progressWidth = 0;
  // Whether this turn actually produced deltas. Streaming is the sender's
  // choice, not the renderer's: a remote client asks for streaming but is
  // attached to a server that may not be streaming, and printing nothing in
  // that case loses the answer entirely.
  let sawDelta = false;

  // Overwrite the progress line with spaces before anything else is written,
  // or the leftovers of a longer line stay on screen.
  const clearProgress = (): void => {
    if (progressWidth > 0) {
      streams.stderr.write(`\r${" ".repeat(progressWidth)}\r`);
      progressWidth = 0;
    }
  };

  const endLine = (): void => {
    if (lineOpen) {
      streams.stdout.write("\n");
      lineOpen = false;
    }
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "message_start":
        sawDelta = false;
        return;

      case "message_update":
        if (stream && event.delta.length > 0) {
          sawDelta = true;
          streams.stdout.write(event.delta);
          lineOpen = !event.delta.endsWith("\n");
        }
        return;

      case "message_end":
        if (
          (!stream || !sawDelta) &&
          event.message.content.length > 0
        ) {
          streams.stdout.write(`${event.message.content}\n`);
        }
        endLine();
        return;

      case "tool_execution_update":
        if (showToolProgress) {
          const line = lastNonEmptyLine(event.content);
          if (line.length > 0) {
            const text = `  ${truncate(line, MAX_PROGRESS_CHARACTERS)}`;
            clearProgress();
            streams.stderr.write(`\r${paint(text, DIM)}`);
            progressWidth = text.length;
          }
        }
        return;

      case "tool_execution_start":
        if (showToolActivity) {
          clearProgress();
          streams.stderr.write(
            paint(
              `· ${event.toolName} ${summariseArguments(event.arguments)}\n`,
              DIM,
            ),
          );
        }
        return;

      case "tool_execution_end":
        clearProgress();
        if (showToolActivity) {
          const summary = `  ↳ ${summariseResult(event.content, event.isError)}\n`;
          streams.stderr.write(paint(summary, event.isError ? RED : DIM));
        }
        return;

      case "agent_end":
        clearProgress();
        endLine();
        if (event.status === "max_turns") {
          streams.stderr.write(
            `Stopped after ${event.turnCount} turns without a final answer.\n`,
          );
        } else if (event.status === "aborted") {
          streams.stderr.write("Interrupted.\n");
        }
        // A failed run is reported by whoever awaited it, with the real error.
        return;

      default:
        return;
    }
  };
}

/**
 * Writes one JSON object per line: the session header first, then every event.
 * This is the machine-readable counterpart of the terminal renderer.
 */
export function createJsonEventWriter(
  output: OutputStream,
  header?: object,
): AgentEventListener {
  if (header !== undefined) {
    output.write(`${JSON.stringify(header)}\n`);
  }
  return (event: AgentEvent): void => {
    output.write(`${JSON.stringify(event)}\n`);
  };
}

function summariseArguments(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = "[unserialisable arguments]";
  }
  return truncate(text.replaceAll(/\s+/g, " "), MAX_ARGUMENT_CHARACTERS);
}

function summariseResult(content: string, isError: boolean): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const lineCount = content.length === 0 ? 0 : content.split("\n").length;
  const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";
  return `${isError ? "error: " : ""}${truncate(firstLine, MAX_RESULT_CHARACTERS)}${suffix}`;
}

/** The tail of a command's output is the part worth showing while it runs. */
function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length > 0) {
      return line;
    }
  }
  return "";
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 1)}…`;
}

import type { AgentEvent, AgentEventListener } from "./events.js";

const MAX_ARGUMENT_CHARACTERS = 120;
const MAX_RESULT_CHARACTERS = 100;

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
  const color = options.color ?? false;
  const paint = (value: string, code: string): string =>
    color ? `${code}${value}${RESET}` : value;
  let lineOpen = false;

  const endLine = (): void => {
    if (lineOpen) {
      streams.stdout.write("\n");
      lineOpen = false;
    }
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "message_update":
        if (stream && event.delta.length > 0) {
          streams.stdout.write(event.delta);
          lineOpen = !event.delta.endsWith("\n");
        }
        return;

      case "message_end":
        if (!stream && event.message.content.length > 0) {
          streams.stdout.write(`${event.message.content}\n`);
        }
        endLine();
        return;

      case "tool_execution_start":
        if (showToolActivity) {
          streams.stderr.write(
            paint(
              `· ${event.toolName} ${summariseArguments(event.arguments)}\n`,
              DIM,
            ),
          );
        }
        return;

      case "tool_execution_end":
        if (showToolActivity) {
          const summary = `  ↳ ${summariseResult(event.content, event.isError)}\n`;
          streams.stderr.write(paint(summary, event.isError ? RED : DIM));
        }
        return;

      case "agent_end":
        endLine();
        if (event.status === "max_turns") {
          streams.stderr.write(
            `Stopped after ${event.turnCount} turns without a final answer.\n`,
          );
        } else if (event.status === "aborted") {
          streams.stderr.write("Interrupted.\n");
        } else if (event.status === "error") {
          streams.stderr.write(
            `Run failed: ${event.error ?? "Unknown error"}\n`,
          );
        }
        return;

      default:
        return;
    }
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

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 1)}…`;
}

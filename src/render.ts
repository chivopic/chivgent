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

      case "compaction_start":
        if (showToolActivity) {
          endLine();
          // A forced compaction is not over budget, so do not claim it is.
          const comparison =
            event.estimatedTokens > event.budgetTokens ? ">" : "of";
          streams.stderr.write(
            paint(
              `· compacting context (${formatTokens(event.estimatedTokens)} ${comparison} ${formatTokens(event.budgetTokens)} budget)\n`,
              DIM,
            ),
          );
        }
        return;

      case "compaction_end":
        if (showToolActivity) {
          streams.stderr.write(
            paint(`  ↳ ${describeCompaction(event)}\n`, DIM),
          );
        }
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

function describeCompaction(event: {
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summarisedMessages: number;
  readonly shrunkToolResults: number;
  readonly droppedMessages: number;
  readonly degraded: boolean;
}): string {
  if (
    event.summarisedMessages === 0 &&
    event.shrunkToolResults === 0 &&
    event.droppedMessages === 0
  ) {
    return "nothing to compact";
  }

  const parts = [
    `${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)}`,
  ];
  if (event.summarisedMessages > 0) {
    parts.push(`${event.summarisedMessages} messages summarised`);
  }
  if (event.shrunkToolResults > 0) {
    parts.push(`${event.shrunkToolResults} tool results trimmed`);
  }
  if (event.droppedMessages > 0) {
    parts.push(`${event.droppedMessages} messages dropped`);
  }
  if (event.degraded) {
    parts.push("summary unavailable, used a digest");
  }
  return parts.join(", ");
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
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

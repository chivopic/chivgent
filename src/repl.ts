import { createInterface } from "node:readline";
import { formatTokens, type OutputStream } from "./render.js";
import type { AgentSession } from "./session.js";

export const REPL_PROMPT = "› ";

export type SlashCommandOutcome =
  | "handled"
  | "exit"
  | "compact"
  | "not-a-command";

export interface SlashCommandContext {
  readonly session: AgentSession;
  readonly write: (text: string) => void;
  readonly sessionFile?: string;
}

const HELP = `Commands:
  /help      Show this help
  /session   Show the current session id, workspace, and size
  /context   Show the estimated context use and token totals
  /compact   Summarise earlier turns to free context now
  /tools     List the tools available to the model
  /clear     Start a new transcript in the same session
  /exit      Leave chivgent (Ctrl+D also works)

Anything else is sent to the model. Ctrl+C stops the answer in progress.
`;

/**
 * Interprets one line of REPL input. Returns `not-a-command` when the line is
 * an ordinary prompt for the model.
 */
export function handleSlashCommand(
  line: string,
  context: SlashCommandContext,
): SlashCommandOutcome {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return "not-a-command";
  }

  switch (trimmed.split(/\s+/, 1)[0]) {
    case "/help":
    case "/?":
      context.write(HELP);
      return "handled";

    case "/session":
      context.write(describeSession(context));
      return "handled";

    case "/context":
      context.write(describeContext(context));
      return "handled";

    case "/compact":
      // Compaction is asynchronous; the REPL loop performs it.
      return "compact";

    case "/tools":
      context.write(
        `${context.session.toolNames.map((name) => `  ${name}`).join("\n")}\n`,
      );
      return "handled";

    case "/clear":
      context.session.clear();
      context.write("Transcript cleared.\n");
      return "handled";

    case "/exit":
    case "/quit":
      return "exit";

    default:
      context.write(`Unknown command: ${trimmed}. Try /help.\n`);
      return "handled";
  }
}

function describeContext(context: SlashCommandContext): string {
  const status = context.session.contextStatus();
  const usage = context.session.usage;
  const lines = [
    status === undefined
      ? "context:   no budget configured (compaction is off)"
      : `context:   ~${formatTokens(status.estimatedTokens)} of ${formatTokens(
          status.maxInputTokens,
        )} tokens, compacting above ${formatTokens(status.budgetTokens)}`,
    `messages:  ${context.session.messages.length}`,
    `usage:     ${formatTokens(usage.inputTokens)} in, ${formatTokens(
      usage.outputTokens,
    )} out (Provider-reported, this session)`,
  ];
  return `${lines.join("\n")}\n`;
}

function describeSession(context: SlashCommandContext): string {
  const lines = [
    `id:        ${context.session.id}`,
    `workspace: ${context.session.cwd}`,
    `prompts:   ${context.session.turns}`,
    `messages:  ${context.session.messages.length}`,
  ];
  if (context.sessionFile !== undefined) {
    lines.push(`log:       ${context.sessionFile}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface ReplOptions {
  readonly session: AgentSession;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly stderr: OutputStream;
  readonly banner?: string;
  readonly sessionFile?: string;
}

/**
 * Reads prompts until the user leaves. One run at a time: Ctrl+C cancels the
 * answer in progress instead of killing the process, so the transcript and the
 * session log survive an interrupt.
 */
export async function runRepl(options: ReplOptions): Promise<number> {
  const write = (text: string): void => {
    options.stderr.write(text);
  };
  const readline = createInterface({
    input: options.input,
    output: options.output,
    terminal: true,
    prompt: REPL_PROMPT,
  });

  let controller: AbortController | undefined;
  readline.on("SIGINT", () => {
    if (controller === undefined) {
      write("Press Ctrl+D or /exit to leave.\n");
      readline.prompt();
      return;
    }
    controller.abort();
  });

  if (options.banner !== undefined) {
    write(options.banner);
  }
  readline.prompt();

  for await (const line of readline) {
    if (line.trim().length === 0) {
      readline.prompt();
      continue;
    }

    const outcome = handleSlashCommand(line, {
      session: options.session,
      write,
      ...(options.sessionFile === undefined
        ? {}
        : { sessionFile: options.sessionFile }),
    });
    if (outcome === "exit") {
      break;
    }
    if (outcome === "handled") {
      readline.prompt();
      continue;
    }
    if (outcome === "compact") {
      const compacted = await options.session.compact();
      if (compacted === undefined) {
        write("Nothing to compact: no context budget is configured.\n");
      }
      readline.prompt();
      continue;
    }

    controller = new AbortController();
    try {
      await options.session.prompt(line, { signal: controller.signal });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      write(`Agent failed: ${message}\n`);
    } finally {
      controller = undefined;
    }
    readline.prompt();
  }

  readline.close();
  return 0;
}

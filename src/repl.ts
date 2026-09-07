import { createInterface, type Interface } from "node:readline";
import type { AgentSession } from "./session.js";
import type { OutputStream } from "./render.js";
import type { RegisteredCommand } from "./extensions/api.js";

export const REPL_PROMPT = "› ";

export type SlashCommandOutcome =
  | "handled"
  | "exit"
  | "not-a-command"
  /** The REPL runs the sign-in flow, which needs to read from the terminal. */
  | { readonly kind: "login" }
  /** An extension command matched; the REPL runs it, since it may be async. */
  | {
      readonly kind: "extension";
      readonly command: RegisteredCommand;
      readonly argument: string;
    };

export interface SlashCommandContext {
  readonly session: AgentSession;
  readonly write: (text: string) => void;
  readonly sessionFile?: string;
  /** Commands contributed by extensions, keyed by name without the slash. */
  readonly extensionCommands?: readonly RegisteredCommand[];
  /** Present when this session can store a key; absent for a signed-in remote. */
  readonly signIn?: SignIn;
}

export interface SignIn {
  readonly provider: string;
  readonly authFile: string;
  /** Live check: /login can make this true part-way through a session. */
  ready(): boolean;
  /** Saves the key and puts it to use, or returns why it could not. */
  submit(apiKey: string): Promise<string | undefined>;
}

export const BUILT_IN_COMMANDS = [
  "help",
  "session",
  "tools",
  "clear",
  "exit",
  "quit",
  "login",
] as const;

const HELP = `Commands:
  /help      Show this help
  /session   Show the current session id, workspace, and size
  /tools     List the tools available to the model
  /clear     Start a new transcript in the same session
  /login     Store an API key for this Provider
  /exit      Leave chivgent (Ctrl+D also works)

Anything else is sent to the model. Ctrl+C stops the answer in progress.
`;

function helpText(context: SlashCommandContext): string {
  const extras = context.extensionCommands ?? [];
  if (extras.length === 0) {
    return HELP;
  }
  const width = Math.max(...extras.map((command) => command.name.length)) + 3;
  const lines = extras.map(
    (command) => `  /${command.name.padEnd(width)}${command.description}`,
  );
  // Extension commands are listed apart from the built-ins so it is always
  // clear which of them came from code this project supplied.
  return `${HELP}\nFrom extensions:\n${lines.join("\n")}\n`;
}

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
      context.write(helpText(context));
      return "handled";

    case "/session":
      context.write(describeSession(context));
      return "handled";

    case "/tools":
      context.write(
        `${context.session.toolNames.map((name) => `  ${name}`).join("\n")}\n`,
      );
      return "handled";

    case "/clear":
      context.session.clear();
      context.write("Transcript cleared.\n");
      return "handled";

    case "/login":
      if (context.signIn === undefined) {
        context.write(
          "This session cannot store a key; it is attached to a server that already has one.\n",
        );
        return "handled";
      }
      return { kind: "login" };

    case "/exit":
    case "/quit":
      return "exit";

    default: {
      const name = (trimmed.split(/\s+/, 1)[0] ?? "").slice(1);
      const command = (context.extensionCommands ?? []).find(
        (candidate) => candidate.name === name,
      );
      if (command !== undefined) {
        return { kind: "extension", command, argument: trimmed.slice(name.length + 1).trim() };
      }
      context.write(`Unknown command: ${trimmed}. Try /help.\n`);
      return "handled";
    }
  }
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
  readonly extensionCommands?: readonly RegisteredCommand[];
  readonly signIn?: SignIn;
}

/**
 * Hides what is typed for the duration of one answer.
 *
 * readline echoes every keystroke through `_writeToOutput`, so silencing that
 * keeps an API key off the screen and out of the scrollback. The original
 * writer is always restored, even if reading throws.
 */
async function withoutEcho<T>(
  readline: Interface,
  read: () => Promise<T>,
): Promise<T> {
  const internals = readline as unknown as {
    _writeToOutput?: (text: string) => void;
  };
  const original = internals._writeToOutput?.bind(readline);
  if (original === undefined) {
    return read();
  }
  internals._writeToOutput = (): void => undefined;
  try {
    return await read();
  } finally {
    internals._writeToOutput = original;
  }
}

async function runSignIn(
  readline: Interface,
  readNextLine: () => Promise<string | undefined>,
  write: (text: string) => void,
  signIn: SignIn,
): Promise<void> {
  write(
    [
      `Paste an API key for ${signIn.provider}. It is not echoed.`,
      `It will be stored in ${signIn.authFile}, readable only by you.`,
      "API key: ",
    ].join("\n"),
  );

  // The key is read from the same line source the loop uses. readline's
  // question() competes with the loop's own iterator for input, so the answer
  // would be swallowed or never arrive.
  const answer = await withoutEcho(readline, readNextLine);
  write("\n");
  if (answer === undefined) {
    return;
  }

  const key = answer.trim();
  if (key.length === 0) {
    write("Nothing entered; no key was stored.\n");
    return;
  }

  const failure = await signIn.submit(key);
  if (failure !== undefined) {
    write(`${failure}\n`);
    return;
  }
  write(
    `Stored the key for ${signIn.provider}. The key is not checked until your next prompt.\n`,
  );
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

  const lines = readline[Symbol.asyncIterator]();
  const readNextLine = async (): Promise<string | undefined> => {
    const next = await lines.next();
    return next.done === true ? undefined : next.value;
  };

  for (;;) {
    const line = await readNextLine();
    if (line === undefined) {
      break;
    }
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
      ...(options.extensionCommands === undefined
        ? {}
        : { extensionCommands: options.extensionCommands }),
      ...(options.signIn === undefined ? {} : { signIn: options.signIn }),
    });
    if (outcome === "exit") {
      break;
    }
    if (typeof outcome === "object" && outcome.kind === "login") {
      if (options.signIn !== undefined) {
        await runSignIn(readline, readNextLine, write, options.signIn);
      }
      readline.prompt();
      continue;
    }
    if (typeof outcome === "object") {
      // An extension command runs here rather than inside the parser so it may
      // be async, and so a throwing command cannot take the REPL down.
      try {
        await outcome.command.run({
          session: options.session,
          write,
          argument: outcome.argument,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        write(`/${outcome.command.name} failed: ${message}\n`);
      }
      readline.prompt();
      continue;
    }
    if (outcome === "handled") {
      readline.prompt();
      continue;
    }

    if (options.signIn !== undefined && !options.signIn.ready()) {
      // Saying this before the run starts is clearer than letting the Provider
      // call fail and reporting it as an agent failure.
      write("No API key yet. Run /login to add one.\n");
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

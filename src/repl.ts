import { TuiInput } from "./tui/input.js";
import { InputMenu, type MenuItem } from "./tui/menu.js";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import type { AgentSession } from "./session.js";
import type { OutputStream } from "./render.js";
import type { RegisteredCommand } from "./extensions/api.js";
import { formatTokens } from "./providers/usage.js";
import { approvalPreview, commandReviewable } from "./tui/activity.js";
import { terminalWidth } from "./tui/live.js";
import { formatDiffPage, mostRecentSuccessfulPatch } from "./tui/diff.js";
import type { LiveRegion } from "./tui/live.js";
import type { ShellApprovalGate } from "./shell/approval.js";

export const REPL_PROMPT = "› ";

export type SlashCommandOutcome =
  | "handled"
  | "exit"
  | "not-a-command"
  /** The REPL runs the sign-in flow, which needs to read from the terminal. */
  | { readonly kind: "login"; readonly providerArgument: string }
  | { readonly kind: "provider"; readonly argument: string }
  | { readonly kind: "model"; readonly argument: string }
  | { readonly kind: "endpoint"; readonly argument: string }
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
  readonly providers?: ProviderControl;
  readonly width?: number;
  readonly color?: boolean;
}

export interface ProviderSelection {
  readonly ok: boolean;
  readonly message: string;
}

export interface ProviderControl {
  readonly provider: string;
  readonly model?: string;
  describe(): string;
  unavailableMessage?(): string;
  providerIds(): readonly string[];
  select(argument: string): Promise<ProviderSelection>;
  changeModel(model: string): Promise<ProviderSelection>;
  changeEndpoint(url: string): Promise<ProviderSelection>;
}

export interface SignIn {
  readonly provider: string;
  readonly authFile: string;
  /** Live check: /login can make this true part-way through a session. */
  ready(): boolean;
  /** Checks credentials even if the current model or endpoint is still incomplete. */
  needsApiKey?(): Promise<boolean>;
  /** Saves the key and puts it to use, or returns why it could not. */
  submit(apiKey: string): Promise<string | undefined>;
  unavailableMessage?(): string;
}

export const BUILT_IN_COMMANDS = [
  "help",
  "session",
  "tools",
  "diff",
  "compose",
  "clear",
  "exit",
  "quit",
  "login",
  "provider",
  "model",
  "endpoint",
] as const;

const HELP = `Commands:
  /help      Show this help
  /session   Show the current session id, workspace, and size
  /tools     List the tools available to the model
  /diff [N]  Review the latest successful apply_patch, page N
  /compose   Write a multi-line prompt (/send to submit, /cancel to discard)
  /clear     Start a new transcript in the same session
  /provider  Choose a Provider (↑↓ and Enter in the TUI)
  /model     Show or change the current model: /model MODEL
  /endpoint  Set the URL for an OpenAI-compatible Provider
  /login     Store a key for the current Provider; /login NAME switches first
  /exit      Leave chivgent (Ctrl+C or Ctrl+D also works)

Anything else is sent to the model. Ctrl+C stops a running answer; at the prompt it exits.
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

    case "/diff": {
      const argument = trimmed.slice("/diff".length).trim();
      if (argument.length > 0 && !/^[1-9]\d*$/.test(argument)) {
        context.write("Usage: /diff [positive page number]\n");
        return "handled";
      }
      const patch = mostRecentSuccessfulPatch(context.session.messages);
      if (patch === undefined) {
        context.write("No successfully applied patch found in this session.\n");
        return "handled";
      }
      const page = argument.length === 0 ? 1 : Number(argument);
      context.write(formatDiffPage(patch, page, context.width ?? 80, context.color === true).text);
      return "handled";
    }

    case "/compose":
      context.write("Use /compose at the interactive prompt to enter multi-line mode.\n");
      return "handled";

    case "/clear":
      context.session.clear();
      context.write("Transcript cleared.\n");
      return "handled";

    case "/provider":
      if (context.providers === undefined) {
        context.write("Provider switching is unavailable in this session.\n");
        return "handled";
      }
      if (trimmed === "/provider") {
        context.write(context.providers.describe());
        return "handled";
      }
      return { kind: "provider", argument: trimmed.slice("/provider".length).trim() };

    case "/model":
      if (context.providers === undefined) {
        context.write("Model switching is unavailable in this session.\n");
        return "handled";
      }
      if (trimmed === "/model") {
        context.write(`Current model: ${context.providers.model ?? "not set"}. Use /model MODEL to change it.\n`);
        return "handled";
      }
      return { kind: "model", argument: trimmed.slice("/model".length).trim() };

    case "/endpoint":
      if (context.providers === undefined) {
        context.write("Endpoint configuration is unavailable in this session.\n");
        return "handled";
      }
      if (trimmed === "/endpoint") {
        context.write("Use /endpoint https://api.example.com/v1 for an OpenAI-compatible Provider.\n");
        return "handled";
      }
      return { kind: "endpoint", argument: trimmed.slice("/endpoint".length).trim() };

    case "/login":
      if (context.signIn === undefined) {
        context.write(
          "This session cannot store a key; it is attached to a server that already has one.\n",
        );
        return "handled";
      }
      return { kind: "login", providerArgument: trimmed.slice("/login".length).trim() };

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

function describeUsage(context: SlashCommandContext): readonly string[] {
  const usage = context.session.usage;
  if (usage === undefined || usage.usage.totalTokens === 0) {
    return [];
  }
  // Shown on request rather than after every answer: a token count printed
  // beneath each reply is noise for the ninety-nine turns you did not ask.
  const parts = [
    `${formatTokens(usage.usage.totalTokens)} total`,
    `${formatTokens(usage.usage.inputTokens)} in`,
    `${formatTokens(usage.usage.outputTokens)} out`,
  ];
  if (usage.usage.cachedInputTokens !== undefined) {
    parts.push(`${formatTokens(usage.usage.cachedInputTokens)} cached`);
  }
  return [
    `tokens:    ${parts.join(", ")}${usage.complete ? "" : " (a turn reported none)"}`,
  ];
}

function describeSession(context: SlashCommandContext): string {
  const lines = [
    `id:        ${context.session.id}`,
    `workspace: ${context.session.cwd}`,
    `prompts:   ${context.session.turns}`,
    `messages:  ${context.session.messages.length}`,
    ...describeUsage(context),
  ];
  if (context.sessionFile !== undefined) {
    lines.push(`log:       ${context.sessionFile}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface ReplOptions {
  readonly tui?: boolean;
  readonly session: AgentSession;
  readonly shellApproval?: ShellApprovalGate;
  readonly liveRegion?: Pick<LiveRegion, "pause" | "resume">;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly stderr: OutputStream;
  readonly banner?: string;
  readonly sessionFile?: string;
  readonly extensionCommands?: readonly RegisteredCommand[];
  readonly signIn?: SignIn;
  readonly providers?: ProviderControl;
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
    `API key for ${signIn.provider} (hidden, saved locally; Enter skips): `,
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
  write(signIn.ready()
    ? `Stored the key for ${signIn.provider}. Ready for your next prompt.\n`
    : `Stored the key for ${signIn.provider}. ${signIn.unavailableMessage?.() ?? "Finish Provider setup before sending a prompt."}\n`);
}

/**
 * Reads prompts until the user leaves. Ctrl+C cancels a running answer, keeping
 * its transcript and log; at an idle prompt it closes the REPL.
 */
export async function runRepl(options: ReplOptions): Promise<number> {
  const write = (text: string): void => {
    options.stderr.write(text);
  };
  const tuiInput = options.tui ? new TuiInput(options.input) : undefined;
  // Decode independently so readline uses normal editing for every key. Its
  // chunked-paste fast path can lose wrapped cursor rows or overwrite text
  // when inserting a paste in the middle of an existing draft.
  if (tuiInput !== undefined) emitKeypressEvents(tuiInput);
  const readline = createInterface({
    input: tuiInput ?? options.input,
    output: options.output,
    terminal: true,
    prompt: REPL_PROMPT,
  });

  const menu = tuiInput === undefined ? undefined : new InputMenu(readline, options.output);
  let dismissedLine: string | undefined;
  let refreshQueued = false;
  const commands: readonly MenuItem[] = [...BUILT_IN_COMMANDS, ...(options.extensionCommands ?? []).map((command) => command.name)]
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name) => ({ value: name, label: `/${name}${name === "provider" ? "  ·  choose a Provider" : name === "model" ? "  ·  change model" : ""}` }));
  const menuItems = (line: string): readonly MenuItem[] => {
    if (line === "/provider" || line.startsWith("/provider ")) {
      const query = line.slice("/provider".length).trim().toLowerCase();
      return (options.providers?.providerIds() ?? []).filter((id) => id.includes(query))
        .map((id) => ({ value: `provider ${id}`, label: `${id === options.providers?.provider ? "●" : "○"} ${id}` }));
    }
    if (line.startsWith("/") && !/\s/.test(line)) {
      return commands.filter((item) => item.label.startsWith(line));
    }
    return [];
  };
  const refreshMenu = (): void => {
    if (menu === undefined || inputClosed || signingIn || controller !== undefined) return;
    const line = readline.line;
    menu.show(line === dismissedLine ? [] : menuItems(line), true);
  };
  const queueRefresh = (): void => {
    if (refreshQueued) return;
    refreshQueued = true;
    setImmediate(() => { refreshQueued = false; refreshMenu(); });
  };
  const replaceDraft = (value: string): void => {
    menu?.reset();
    readline.write(null, { ctrl: true, name: "a" });
    readline.write(null, { ctrl: true, name: "k" });
    readline.write(value);
  };

  let controller: AbortController | undefined;
  let promptVisible = false;
  let inputClosed = false;
  let signingIn = false;
  let composing = false;
  let composeCancelled = false;
  let interrupted = false;
  if (tuiInput !== undefined) {
    tuiInput.setMenuControls(() => {
      menu?.clear();
      dismissedLine = undefined;
    }, (key) => {
      if (signingIn || controller !== undefined) return false;
      if (key === "enter" && !menu?.active && readline.line === "/provider" && options.providers !== undefined) {
        menu?.show(menuItems(readline.line));
        return true;
      }
      if (key === "tab" && !menu?.active) {
        const first = menuItems(readline.line)[0]?.value;
        if (first !== undefined) {
          replaceDraft(`/${first}${first === "model" || first === "endpoint" ? " " : ""}`);
          queueRefresh();
          return true;
        }
      }
      if (!menu?.active) return false;
      if (key === "up" || key === "down") {
        menu.move(key === "up" ? -1 : 1);
        return true;
      }
      if (key === "escape") {
        dismissedLine = readline.line;
        menu.clear();
        return true;
      }
      const chosen = menu.selection;
      if (chosen === undefined) return false;
      const replacement = `/${chosen}`;
      if (key === "tab") {
        replaceDraft(replacement + (chosen === "model" || chosen === "endpoint" ? " " : ""));
        queueRefresh();
        return true;
      }
      if (key === "enter") {
        replaceDraft(replacement);
        if (chosen === "provider" || chosen === "model" || chosen === "endpoint") {
          if (chosen !== "provider") readline.write(" ");
          queueRefresh();
        } else {
          tuiInput.markSubmitted();
          readline.write("\r");
        }
        return true;
      }
      return false;
    });
    tuiInput.on("keypress", queueRefresh);
  }
  const showPrompt = (): void => {
    if (inputClosed) return;
    promptVisible = true;
    readline.prompt();
  };
  readline.on("line", () => { menu?.reset(); promptVisible = false; });
  readline.on("close", () => {
    menu?.reset();
    inputClosed = true;
    controller?.abort();
    if (options.tui && promptVisible) {
      // Ctrl+D closes an empty input line without printing a newline.
      options.output.write("\r\u001B[2K");
      promptVisible = false;
    }
  });
  readline.on("SIGINT", () => {
    if (composing) {
      composeCancelled = true;
      readline.write("\r");
      return;
    }
    if (controller === undefined) {
      if (options.tui) {
        // Erase wrapped drafts before removing the prompt on close.
        readline.write(null, { ctrl: true, name: "e" });
        readline.write(null, { ctrl: true, name: "u" });
      } else {
        options.output.write("\n");
      }
      interrupted = true;
      readline.close();
      return;
    }
    controller.abort();
  });

  if (options.banner !== undefined) {
    write(options.banner);
  }
  showPrompt();

  const lines = readline[Symbol.asyncIterator]();
  const readNextLine = async (): Promise<string | undefined> => {
    tuiInput?.acceptLine();
    const next = await lines.next();
    return next.done === true ? undefined : next.value;
  };

  // Approval and normal input share the same readline iterator.
  if (options.shellApproval !== undefined) {
    options.shellApproval.setHandler(async (command, signal) => {
      if (signal?.aborted) return false;
      menu?.clear();
      options.liveRegion?.pause();
      tuiInput?.setApprovalMode(true);
      tuiInput?.setBusy(false);
      try {
        const width = terminalWidth({ columns: (options.output as typeof options.output & { columns?: number }).columns });
        write(approvalPreview(command, width));
        if (!commandReviewable(command, width)) {
          write("  Denied: command cannot be fully reviewed at this width. Ask for a shorter command.\n");
          return false;
        }
        readline.setPrompt("approve> ");
        readline.prompt();
        // Ctrl+C must unblock the pending line read, not leave the agent
        // stuck waiting for a reply to an approval that was cancelled.
        const unblockOnAbort = (): void => {
          readline.write("\n");
        };
        signal?.addEventListener("abort", unblockOnAbort, { once: true });
        try {
          if (signal?.aborted) return false;
          const answer = await readNextLine();
          return answer?.trim().toLowerCase() === "y" && signal?.aborted !== true;
        } finally {
          signal?.removeEventListener("abort", unblockOnAbort);
        }
      } finally {
        readline.setPrompt(REPL_PROMPT);
        tuiInput?.setApprovalMode(false);
        tuiInput?.setBusy(true);
        options.liveRegion?.resume();
      }
    });
  }

  /** Modal composer retains readline editing, Unicode and native history. */
  const collectMultiline = async (): Promise<string | undefined> => {
    const parts: string[] = [];
    let bytes = 0;
    composing = true;
    composeCancelled = false;
    tuiInput?.setComposeMode(true);
    menu?.clear();
    dismissedLine = undefined;
    readline.setPrompt("  │ ");
    write("\nCompose prompt · Enter adds a line · /send submits · /cancel discards\n");
    try {
      for (;;) {
        readline.prompt();
        const part = await readNextLine();
        if (tuiInput?.composeLimitExceeded) {
          write("Draft too large (64 KiB paste buffer). Nothing was sent.\n");
          return undefined;
        }
        if (composeCancelled || part === undefined || part.trim() === "/cancel") {
          write("Draft discarded.\n");
          return undefined;
        }
        if (part.trim() === "/send") {
          const message = parts.join("\n");
          if (message.trim().length === 0) {
            write("Empty draft discarded.\n");
            return undefined;
          }
          write(`Submitted ${parts.length} lines.\n`);
          return message;
        }
        bytes += Buffer.byteLength(part, "utf8") + 1;
        if (parts.length >= 200 || bytes > 64 * 1024) {
          write("Draft too large (200 lines / 64 KiB). Nothing was sent.\n");
          return undefined;
        }
        // //send and //cancel are literal lines instead of commands.
        parts.push(part.startsWith("//send") || part.startsWith("//cancel") ? part.slice(1) : part);
      }
    } finally {
      composing = false;
      composeCancelled = false;
      tuiInput?.setComposeMode(false);
      readline.setPrompt(REPL_PROMPT);
    }
  };

  const signInAfterProviderSelection = async (): Promise<void> => {
    if (!options.tui || options.signIn === undefined) return;
    let missingKey: boolean;
    try {
      missingKey = options.signIn.needsApiKey === undefined
        ? !options.signIn.ready()
        : await options.signIn.needsApiKey();
    } catch (error: unknown) {
      write(`Could not check saved API key: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    if (!missingKey) return;
    signingIn = true;
    try {
      await runSignIn(readline, readNextLine, write, options.signIn);
    } finally {
      signingIn = false;
    }
  };

  try {
    for (;;) {
      let line = await readNextLine();
      if (line === undefined) {
        break;
      }
      if (line.trim().length === 0) {
        showPrompt();
        continue;
      }

      const fromComposer = line.trim() === "/compose";
      if (fromComposer) {
        const draft = await collectMultiline();
        if (draft === undefined) {
          if (inputClosed) break;
          showPrompt();
          continue;
        }
        line = draft;
      }
      const outcome = fromComposer ? "not-a-command" : handleSlashCommand(line, {
        session: options.session,
        write,
        width: terminalWidth({ columns: (options.output as typeof options.output & { columns?: number }).columns }),
        color: options.tui === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
        ...(options.sessionFile === undefined
          ? {}
          : { sessionFile: options.sessionFile }),
        ...(options.extensionCommands === undefined
          ? {}
          : { extensionCommands: options.extensionCommands }),
        ...(options.signIn === undefined ? {} : { signIn: options.signIn }),
        ...(options.providers === undefined ? {} : { providers: options.providers }),
      });
      if (outcome === "exit") {
        break;
      }
      if (typeof outcome === "object" && outcome.kind === "login") {
        if (outcome.providerArgument.length > 0) {
          if (options.providers === undefined) {
            write("Provider switching is unavailable in this session.\n");
            showPrompt();
            continue;
          }
          const selected = await options.providers.select(outcome.providerArgument);
          write(selected.message);
          if (!selected.ok) {
            showPrompt();
            continue;
          }
        }
        if (options.signIn !== undefined) {
          signingIn = true;
          try {
            await runSignIn(readline, readNextLine, write, options.signIn);
          } finally {
            signingIn = false;
          }
        }
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && (outcome.kind === "provider" || outcome.kind === "model" || outcome.kind === "endpoint")) {
        if (options.providers !== undefined) {
          const selected = outcome.kind === "provider"
            ? await options.providers.select(outcome.argument)
            : outcome.kind === "model" ? await options.providers.changeModel(outcome.argument)
              : await options.providers.changeEndpoint(outcome.argument);
          write(selected.message);
          if (selected.ok && outcome.kind === "provider") await signInAfterProviderSelection();
        }
        showPrompt();
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
        showPrompt();
        continue;
      }
      if (outcome === "handled") {
        showPrompt();
        continue;
      }

      if (options.signIn !== undefined && !options.signIn.ready()) {
        // Saying this before the run starts is clearer than letting the Provider
        // call fail and reporting it as an agent failure.
        write(`${options.providers?.unavailableMessage?.() ?? `No API key for ${options.signIn.provider}. Run /login or use /provider to switch.`}\n`);
        showPrompt();
        continue;
      }

      controller = new AbortController();
      tuiInput?.setBusy(true);
      try {
        const signal = controller.signal;
        const prompt = () => options.session.prompt(line, { signal });
        if (options.tui) await withoutEcho(readline, prompt);
        else await prompt();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        write(`Agent failed: ${message}\n`);
      } finally {
        controller = undefined;
        tuiInput?.setBusy(false);
      }
      showPrompt();
    }

  } finally {
    options.shellApproval?.setHandler(undefined);
    readline.close();
    tuiInput?.dispose();
  }
  return interrupted ? 130 : 0;
}

import { TuiInput } from "./tui/input.js";
import { EditorController } from "./tui/editor-input.js";
import { readLiveGitDiff, type GitDiffMode } from "./tui/git-diff.js";
import { displayWidth, terminalText } from "./tui/text.js";
import { terminalColorEnabled } from "./tui/selection.js";
import { PatchReviewController } from "./tui/review.js";
import { ProviderPickerController } from "./tui/provider-picker.js";
import { InputMenu, type MenuItem } from "./tui/menu.js";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";
import type { AgentSession } from "./session.js";
import type { OutputStream } from "./render.js";
import type { RegisteredCommand } from "./extensions/api.js";
import { formatTokens } from "./providers/usage.js";
import { approvalPreview, commandReviewable } from "./tui/activity.js";
import { fitLine } from "./tui/text.js";
import { terminalWidth } from "./tui/live.js";
import { formatDiffPage, mostRecentSuccessfulPatch } from "./tui/diff.js";
import type { LiveRegion } from "./tui/live.js";
import type { ApprovalDecision, ShellApprovalGate } from "./shell/approval.js";
import { describePermissionMode, parsePermissionMode, WEB_SEARCH_APPROVAL_PREFIX, type PermissionMode, type PermissionPolicy } from "./permissions.js";
import { HeuristicTokenEstimator } from "./context/token-estimator.js";
import type { Question, QuestionAnswer, QuestionPresenter } from "./questions.js";

export const REPL_PROMPT = "› ";

function parseQuestionAnswer(question: Question, input: string): string | readonly string[] | undefined {
  const value = input.trim();
  if (value.length === 0 || value.length > 2_000) return undefined;
  if (question.options === undefined) return value;
  if (question.multiple === true) {
    const selected: string[] = [];
    for (const part of value.split(",").map(item => item.trim())) {
      if (/^text:/i.test(part) && question.allowFreeText === true) {
        const custom = part.slice(5).trim();
        if (custom.length === 0 || custom.length > 2_000) return undefined;
        selected.push(custom);
      } else {
        if (!/^\d+$/.test(part)) return undefined;
        const option = question.options[Number(part) - 1];
        if (option === undefined || selected.includes(option.label)) return undefined;
        selected.push(option.label);
      }
    }
    return selected.length === 0 ? undefined : selected;
  }
  if (/^text:/i.test(value) && question.allowFreeText === true) {
    const custom = value.slice(5).trim();
    return custom.length > 0 && custom.length <= 2_000 ? custom : undefined;
  }
  if (!/^\d+$/.test(value)) return undefined;
  const option = question.options[Number(value) - 1];
  return option?.label;
}

function wrapQuestionText(value: string, width: number): readonly string[] {
  const lines: string[] = [];
  let line = "";
  let cells = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    if (part.segment === "\n") {
      lines.push(line);
      line = "";
      cells = 0;
      continue;
    }
    const cellsInPart = displayWidth(part.segment);
    if (line.length > 0 && cells + cellsInPart > width) {
      lines.push(line);
      line = "";
      cells = 0;
    }
    line += part.segment;
    cells += cellsInPart;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

export type SlashCommandOutcome =
  | "handled"
  | "exit"
  | "not-a-command"
  /** The REPL runs the sign-in flow, which needs to read from the terminal. */
  | { readonly kind: "login"; readonly providerArgument: string }
  | { readonly kind: "provider"; readonly argument: string }
  | { readonly kind: "model"; readonly argument: string }
  | { readonly kind: "endpoint"; readonly argument: string }
  | { readonly kind: "compact" }
  | { readonly kind: "rename"; readonly title: string }
  | { readonly kind: "plan"; readonly enabled: boolean }
  | { readonly kind: "permission-mode"; readonly mode: PermissionMode }
  | { readonly kind: "new-session"; readonly title?: string }
  | { readonly kind: "resume-session"; readonly id?: string }
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
  readonly compactionEnabled?: boolean;
  readonly providerName?: string;
  readonly modelName?: string;
  /** Configured search provider, absent when web_search is not registered. */
  readonly webSearch?: { readonly provider: string };
  readonly permissions?: readonly string[];
  readonly permissionPolicy?: PermissionPolicy;
  readonly inlineComposer?: boolean;
  readonly interactivePicker?: boolean;
  readonly sessionOptions?: {
    readonly list?: () => Promise<readonly { readonly id: string; readonly title?: string }[]>;
    readonly create?: (title?: string) => Promise<AgentSession>;
    readonly resume?: (id: string) => Promise<AgentSession | undefined>;
  };
  readonly sessionFileForSession?: (session: AgentSession) => string | undefined;
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
  oauth?(provider: "openai" | "xai", signal?: AbortSignal): Promise<string | undefined>;
  signOut?(): Promise<string | undefined>;
  unavailableMessage?(): string;
}

export const BUILT_IN_COMMANDS = [
  "help",
  "status",
  "new",
  "resume",
  "rename",
  "diff",
  "clear",
  "compact",
  "permissions",
  "provider",
  "model",
  "endpoint",
  "login",
  "exit",
] as const;

export const LEGACY_COMMAND_ALIASES = [
  "session",
  "plan",
  "tools",
  "compose",
  "editor",
  "review",
  "gitdiff",
  "quit",
  "logout",
] as const;

export const BUILT_IN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  help: "show this help",
  status: "show session, model, tokens & permissions",
  new: "save and start a fresh session",
  resume: "switch to a saved session in workspace",
  rename: "set current session title",
  diff: "review current Git changes (/diff --staged for index only)",
  clear: "clear transcript in current session",
  compact: "summarise older history for the model",
  permissions: "inspect or change permission policy",
  provider: "choose a Provider",
  model: "show or change current model",
  endpoint: "set URL for OpenAI-compatible Provider",
  login: "store API key or sign in with subscription",
  exit: "leave chivgent",
};

const HELP = `Commands:
  /help      Show this help
  /status    Show live session, model, permissions, plan state, and usage (alias: /session)
  /compact   Summarise older history for the model; keeps the full transcript
  /plan [on|off]  Toggle restricted read-only Plan Mode
  /permissions [ask-first|workspace|unrestricted|plan]  Inspect or change this process's policy
  /new [title]    Save this session and start a fresh session
  /resume [id]    Switch to a saved session in this workspace
  /rename TITLE  Set the current session title
  /diff [--staged|patch [page]]  Review current Git changes (or latest patch)
  /clear     Start a new transcript in the same session
  /provider  Choose a Provider (↑↓ and Enter in the TUI)
  /model     Show or change the current model: /model MODEL
  /endpoint  Set the URL for an OpenAI-compatible Provider
  /login     Store API key or sign in with subscription (/login logout to sign out)
  /exit      Leave chivgent

Anything else is sent to the model. Ctrl+C stops a running answer.
`;

function helpText(context: SlashCommandContext): string {
  const controls = context.inlineComposer
    ? `Rich TUI input: Enter sends; Ctrl+O inserts a newline; Ctrl+R searches prompt history; arrows move the cursor. Ctrl+C clears the current draft; Ctrl+D exits when it is empty.${context.permissionPolicy === undefined ? "" : " Shift+Tab cycles Plan → Auto mode → Ask for me at the idle prompt."}\n\n`
    : "";
  const exit = context.inlineComposer ? "" : "At the simple prompt Ctrl+C or Ctrl+D exits.\n";
  const extras = context.extensionCommands ?? [];
  if (extras.length === 0) {
    return `${controls}${HELP}${exit}`;
  }
  const width = Math.max(...extras.map((command) => command.name.length)) + 3;
  const lines = extras.map(
    (command) => `  /${command.name.padEnd(width)}${command.description}`,
  );
  // Extension commands are listed apart from the built-ins so it is always
  // clear which of them came from code this project supplied.
  return `${controls}${HELP}${exit}\nFrom extensions:\n${lines.join("\n")}\n`;
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
    case "/status":
      context.write(describeStatus(context));
      return "handled";

    case "/compact":
      return { kind: "compact" };

    case "/rename": {
      const title = trimmed.slice("/rename".length).trim();
      if (!title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) {
        context.write("Usage: /rename <title> (1–120 characters, no control characters)\n");
        return "handled";
      }
      return { kind: "rename", title };
    }

    case "/plan": {
      const argument = trimmed.slice("/plan".length).trim().toLowerCase();
      if (argument && argument !== "on" && argument !== "off") {
        context.write("Usage: /plan [on|off]\n");
      } else {
        const enabled = argument === "on" ? true : argument === "off" ? false : !context.session.planMode;
        return { kind: "plan", enabled };
      }
      return "handled";
    }

    case "/permissions": {
      const argument = trimmed.slice("/permissions".length).trim().toLowerCase();
      if (argument === "plan" || argument === "plan on") {
        return { kind: "plan", enabled: true };
      }
      if (argument === "plan off") {
        return { kind: "plan", enabled: false };
      }
      if (context.permissionPolicy === undefined) {
        context.write("Named permission modes are unavailable because this session uses legacy capability flags. Start with --permission-mode to enable them.\n");
      } else if (!argument) {
        context.write(`Permission mode: ${context.permissionPolicy.mode}\n${describePermissionMode(context.permissionPolicy.mode)}\nMode changes last for this process and are not restored from saved sessions.\n`);
      } else {
        try { return { kind: "permission-mode", mode: parsePermissionMode(argument) }; }
        catch { context.write("Usage: /permissions [ask-first|workspace|unrestricted|plan]\n"); }
      }
      return "handled";
    }

    case "/new":
      if (context.sessionOptions?.create === undefined) context.write("/new is unavailable in this session.\n");
      else {
        const title = trimmed.slice("/new".length).trim();
        if (title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) {
          context.write("Usage: /new [title] (title must be at most 120 characters, without control characters)\n");
          return "handled";
        }
        return { kind: "new-session", ...(title ? { title } : {}) };
      }
      return "handled";

    case "/resume":
      if (context.sessionOptions?.resume === undefined) context.write("/resume is unavailable in this session.\n");
      else return { kind: "resume-session", ...(trimmed.slice("/resume".length).trim() ? { id: trimmed.slice("/resume".length).trim() } : {}) };
      return "handled";

    case "/tools":
      context.write(
        `${context.session.toolNames.map((name) => `  ${name}`).join("\n")}\n`,
      );
      return "handled";

    case "/diff": {
      const argument = trimmed.slice("/diff".length).trim();
      if (argument === "patch" || argument.startsWith("patch ")) {
        const pageArg = argument.slice("patch".length).trim();
        if (pageArg.length > 0 && !/^[1-9]\d*$/.test(pageArg)) {
          context.write("Usage: /diff patch [positive page number]\n");
          return "handled";
        }
        const patch = mostRecentSuccessfulPatch(context.session.messages);
        if (patch === undefined) {
          context.write("No successfully applied patch found in this session.\n");
          return "handled";
        }
        const page = pageArg.length === 0 ? 1 : Number(pageArg);
        context.write(formatDiffPage(patch, page, context.width ?? 80, context.color === true).text);
        return "handled";
      }
      if (argument.length > 0 && !/^[1-9]\d*$/.test(argument) && argument !== "--staged") {
        context.write("Usage: /diff [--staged|patch [positive page number]]\n");
        return "handled";
      }
      const patch = mostRecentSuccessfulPatch(context.session.messages);
      if (patch === undefined) {
        context.write("No successfully applied patch found in this session. In interactive TUI, use /diff to review workspace Git changes.\n");
        return "handled";
      }
      const page = argument.length === 0 ? 1 : Number(argument);
      context.write(formatDiffPage(patch, page, context.width ?? 80, context.color === true).text);
      return "handled";
    }

    case "/compose":
      context.write(context.inlineComposer
        ? "The multiline editor is already active in this prompt. Enter sends; Ctrl+O inserts a newline.\n"
        : "Use /compose at the interactive prompt to enter multi-line mode.\n");
      return "handled";

    case "/editor":
      context.write(context.inlineComposer
        ? "The cursor-addressable multiline editor is already active in this prompt. Enter sends; Ctrl+O inserts a newline.\n"
        : "Use /editor in the rich interactive TUI to open the multiline editor.\n");
      return "handled";

    case "/review":
      context.write("Use /review in an interactive TUI to browse the most recent successful patch.\n");
      return "handled";

    case "/gitdiff":
      context.write("Use /gitdiff [--staged] in an interactive TUI to approve read-only Git diff.\n");
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
        if (context.interactivePicker === true) {
          return { kind: "provider", argument: "" };
        }
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

    case "/login": {
      const argument = trimmed.slice("/login".length).trim();
      if (argument === "logout" || argument === "--logout") {
        if (context.signIn?.signOut === undefined) {
          context.write("OAuth sign-out is unavailable in this session.\n");
          return "handled";
        }
        return { kind: "login", providerArgument: "__logout__" };
      }
      if (context.signIn === undefined) {
        context.write(
          "This session cannot store a key; it is attached to a server that already has one.\n",
        );
        return "handled";
      }
      return { kind: "login", providerArgument: argument };
    }

    case "/logout":
      if (context.signIn?.signOut === undefined) {
        context.write("OAuth sign-out is unavailable in this session.\n");
        return "handled";
      }
      return { kind: "login", providerArgument: "__logout__" };

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


function describeStatus(context: SlashCommandContext): string {
  const usage = describeUsage(context);
  let contextEstimate = "unavailable";
  try { contextEstimate = `approximately ${new HeuristicTokenEstimator().estimateMessages(context.session.messages)} tokens (transcript only; excludes system prompt and tool schemas)`; }
  catch { /* inaccessible estimates are reported explicitly */ }
  const sessionFile = context.sessionFileForSession?.(context.session) ?? context.sessionFile;
  const lines = [
    `provider:  ${context.providers?.provider ?? context.providerName ?? "unavailable"}`,
    `model:     ${context.providers === undefined ? context.modelName ?? "unavailable" : context.providers.model ?? "unavailable"}`,
    `workspace: ${context.session.cwd}`,
    `id:        ${context.session.id}${context.session.title ? ` · ${context.session.title}` : ""}`,
    `prompts:   ${context.session.turns}`,
    `messages:  ${context.session.messages.length}`,
    `plan:      ${context.session.planMode ? "on (writes and Shell blocked for this session)" : "off"}`,
    ...(context.permissionPolicy === undefined ? [] : [`permissions: ${context.permissionPolicy.mode} (${describePermissionMode(context.permissionPolicy.mode)})`]),
    ...(context.webSearch === undefined ? [] : [
      `web search: ${context.webSearch.provider}${context.permissionPolicy === undefined || context.permissionPolicy.mode === "unrestricted" ? "" : " (each query asks for approval)"}`,
    ]),
    ...(context.permissionPolicy === undefined ? [
      `file write grant: ${context.permissions === undefined ? "unavailable" : context.permissions.includes("file-write") ? "enabled" : "disabled"}`,
      `Shell grant:      ${context.permissions === undefined ? "unavailable" : context.permissions.includes("shell") ? "enabled" : "disabled"}`,
      `network grant:    ${context.permissions === undefined ? "unavailable" : !context.permissions.includes("shell") ? "unavailable (Shell disabled)" : context.permissions.includes("network") ? "enabled" : "disabled"}`,
    ] : []),
    ...usage,
    `context:   ${contextEstimate}`,
    ...(sessionFile !== undefined ? [`log:       ${sessionFile}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

export interface ReplOptions {
  readonly tui?: boolean;
  /** Opt in to cursor-editable composer as the primary interactive input. */
  readonly inlineComposer?: boolean;
  readonly session: AgentSession;
  readonly shellApproval?: ShellApprovalGate;
  readonly liveRegion?: Pick<LiveRegion, "pause" | "resume">;
  /** Injectable read-only Git implementation for terminal integration tests. */
  readonly gitDiffReader?: typeof readLiveGitDiff;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly stderr: OutputStream;
  readonly banner?: string;
  readonly sessionFile?: string;
  readonly extensionCommands?: readonly RegisteredCommand[];
  readonly signIn?: SignIn;
  readonly providers?: ProviderControl;
  readonly sessionOptions?: SlashCommandContext["sessionOptions"];
  readonly compactionEnabled?: boolean;
  readonly providerName?: string;
  readonly modelName?: string;
  /** Configured search provider, absent when web_search is not registered. */
  readonly webSearch?: { readonly provider: string };
  readonly permissions?: readonly string[];
  readonly permissionPolicy?: PermissionPolicy;
  readonly sessionFileForSession?: SlashCommandContext["sessionFileForSession"];
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
  echoWhile: () => boolean = () => false,
): Promise<T> {
  const internals = readline as unknown as {
    _writeToOutput?: (text: string) => void;
  };
  const original = internals._writeToOutput?.bind(readline);
  if (original === undefined) {
    return read();
  }
  internals._writeToOutput = (text: string): void => { if (echoWhile()) original(text); };
  try {
    return await read();
  } finally {
    internals._writeToOutput = original;
  }
}

/** Plain-REPL Provider chooser; only the API key itself is hidden. */
async function readProviderChoice(
  readNextLine: () => Promise<string | undefined>,
  write: (text: string) => void,
  providerIds: readonly string[],
  active: string,
): Promise<string | undefined> {
  write("Select a Provider for /login:\n");
  providerIds.forEach((id, index) => {
    write(`  ${index + 1}. ${id}${id === active ? " (current)" : ""}\n`);
  });
  write("Provider (number or name, Enter cancels): ");
  const answer = await readNextLine();
  if (answer === undefined) return undefined;
  const choice = answer.trim();
  if (choice.length === 0) return undefined;
  const number = Number(choice);
  if (Number.isInteger(number) && number >= 1 && number <= providerIds.length) {
    return providerIds[number - 1];
  }
  return providerIds.find((id) => id.toLowerCase() === choice.toLowerCase());
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
  let activeSession = options.session;
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
  const menuPriority = ["status", "diff", "provider", "model", "new", "resume", "help"];
  const commands: readonly MenuItem[] = [...BUILT_IN_COMMANDS, ...(options.extensionCommands ?? []).map((command) => command.name)]
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort((a, b) => {
      const rank = (name: string): number => {
        const index = menuPriority.indexOf(name);
        return index < 0 ? menuPriority.length : index;
      };
      return rank(a) - rank(b);
    })
    .map((name) => {
      const description = BUILT_IN_DESCRIPTIONS[name]
        ?? options.extensionCommands?.find(command => command.name === name)?.description;
      const suffix = description === undefined ? "" : `  ·  ${description}`;
      return { value: name, label: `/${name}${suffix}` };
    });
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
  let questionMode = false;
  let questionCancel: (() => void) | undefined;
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
      if (questionCancel !== undefined && key === "escape") {
        questionCancel();
        return true;
      }
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
    if (inputClosed || options.inlineComposer) return;
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

  const questionPresenter: QuestionPresenter = async (request, signal) => {
    if (inputClosed || controller?.signal.aborted === true) return { status: "unavailable", reason: "the local input channel is closed" };
    menu?.clear();
    dismissedLine = undefined;
    options.liveRegion?.pause();
    tuiInput?.setBusy(false);
    questionMode = true;
    const answers: QuestionAnswer[] = [];
    try {
      for (let index = 0; index < request.questions.length; index += 1) {
        const question = request.questions[index];
        if (question === undefined) continue;
        if (signal?.aborted) return { status: "cancelled" };
        let answer: QuestionAnswer["value"] | undefined;
        for (;;) {
          const width = Math.max(1, terminalWidth({ columns: (options.output as typeof options.output & { columns?: number }).columns }) - 1);
          const line = (value: string): void => { for (const part of wrapQuestionText(terminalText(value), width)) write(`${part}\n`); };
          line(`Question ${index + 1}/${request.questions.length} · ${question.header}`);
          line(question.question);
          question.options?.forEach((option, optionIndex) => {
            line(`  ${optionIndex + 1}. ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`);
          });
          if (question.options === undefined) line("Enter your answer.");
          else if (question.multiple === true) line(`Enter choice numbers separated by commas${question.allowFreeText === true ? "; use text:… to add a custom answer" : ""}.`);
          else line(`Enter a choice number${question.allowFreeText === true ? " or text:… for another answer" : ""}.`);
          line(options.tui === true
            ? "Type /cancel or press Esc to cancel this question. Ctrl+C cancels the run."
            : "Type /cancel to cancel this question. Ctrl+C cancels the run.");
          readline.setPrompt("answer> ");
          readline.prompt();
          let escaped = false;
          const cancelOnEscape = (): void => { escaped = true; if (!inputClosed) readline.write("\n"); };
          questionCancel = cancelOnEscape;
          const unblockOnAbort = (): void => { if (!inputClosed) readline.write("\n"); };
          signal?.addEventListener("abort", unblockOnAbort, { once: true });
          try {
            if (signal?.aborted) return { status: "cancelled" };
            const input = await readNextLine();
            if (signal?.aborted) return { status: "cancelled" };
            if (input === undefined) return { status: "unavailable", reason: "the local input channel closed before an answer arrived" };
            if (escaped || input.trim().toLowerCase() === "/cancel") return { status: "cancelled" };
            answer = parseQuestionAnswer(question, input);
            if (answer !== undefined) break;
            line("That answer does not match this question. Choose a listed number or enter a non-empty answer.");
          } finally {
            questionCancel = undefined;
            signal?.removeEventListener("abort", unblockOnAbort);
          }
        }
        answers.push({ questionId: question.id, value: answer });
      }
      if (inputClosed) return { status: "unavailable", reason: "the local input channel closed before the answer could be submitted" };
      return { ...request, answers };
    } finally {
      questionCancel = undefined;
      questionMode = false;
      readline.setPrompt(REPL_PROMPT);
      tuiInput?.setBusy(true);
      options.liveRegion?.resume();
    }
  };

  // Approval and normal input share the same readline iterator.
  if (options.shellApproval !== undefined) {
    options.shellApproval.setHandler(async (command, signal, context): Promise<ApprovalDecision> => {
      if (signal?.aborted) return { approved: false, reason: "cancelled" };
      let resizeListener: (() => void) | undefined;
      menu?.clear();
      options.liveRegion?.pause();
      tuiInput?.setApprovalMode(true);
      tuiInput?.setBusy(false);
      try {
        const width = terminalWidth({ columns: (options.output as typeof options.output & { columns?: number }).columns });
        const wraps = context?.startsWith(WEB_SEARCH_APPROVAL_PREFIX) === true;
        const reviewable = wraps || commandReviewable(command, width);
        const approvalOutput = options.output as typeof options.output & { columns?: number };
        let previewInvalidated = false;
        const invalidateOnResize = (): void => {
          if (approvalOutput.columns !== width) previewInvalidated = true;
        };
        if (!wraps) {
          resizeListener = invalidateOnResize;
          options.output.on("resize", invalidateOnResize);
        }
        write(approvalPreview(command, width, context ?? "Shell command", wraps ? { wrap: true } : {}));
        if (!reviewable) {
          return { approved: false, reason: "unreviewable" };
        }
        readline.setPrompt("approve> ");
        readline.prompt();
        // Ctrl+C must unblock the pending line read, not leave the agent
        // stuck waiting for a reply to an approval that was cancelled.
        const unblockOnAbort = (): void => {
          if (!inputClosed) readline.write("\n");
        };
        signal?.addEventListener("abort", unblockOnAbort, { once: true });
        try {
          if (signal?.aborted) return { approved: false, reason: "cancelled" };
          const answer = await readNextLine();
          if (signal?.aborted) return { approved: false, reason: "cancelled" };
          if (answer === undefined) return { approved: false, reason: "unavailable" };
          if (answer.trim().toLowerCase() !== "y") return { approved: false, reason: "user" };
          const currentWidth = terminalWidth({ columns: (options.output as typeof options.output & { columns?: number }).columns });
          if (!wraps && (previewInvalidated || currentWidth !== width || !commandReviewable(command, currentWidth))) {
            write(`${fitLine("  Denied: resized; review again.", currentWidth - 1)}\n`);
            return { approved: false, reason: "unreviewable" };
          }
          return { approved: true };
        } finally {
          signal?.removeEventListener("abort", unblockOnAbort);
        }
      } finally {
        if (resizeListener !== undefined) options.output.off("resize", resizeListener);
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

  /** Cursor-editable modal, with exclusive keyboard and paint ownership. */
  const collectEditor = async (isDefault = false): Promise<string | undefined> => {
    if (tuiInput === undefined) {
      write("The cursor editor requires the rich TUI in an interactive terminal. Use /compose here instead.\n");
      return undefined;
    }
    menu?.clear();
    dismissedLine = undefined;
    composing = true;
    let resolveDraft!: (draft: string | undefined) => void;
    const pending = new Promise<string | undefined>(resolve => { resolveDraft = resolve; });
    const output = options.output as typeof options.output & { columns?: number; rows?: number };
    const recent = activeSession.messages
      .filter((message): message is Extract<(typeof activeSession.messages)[number], { role: "user" }> => message.role === "user")
      .map(message => message.content)
      .filter(message => message.length > 0)
      .slice(-100);
    const footerIdentity = (): string | undefined => {
      const provider = options.providers?.provider ?? options.providerName;
      // A live Provider wins. Do not fall back to the startup model, and do
      // not invent a name when the model or provider is still unset.
      const model = options.providers === undefined ? options.modelName : options.providers.model;
      if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) return undefined;
      return `${provider} · ${model}`;
    };
    const editor = new EditorController(output, resolveDraft, {
      submitOnEnter: isDefault,
      history: recent,
      slashCommands: commands.map(item => ({ value: item.value, label: item.label })),
      mouse: isDefault && options.tui === true && (output as typeof output & { isTTY?: boolean }).isTTY === true,
      color: isDefault && terminalColorEnabled((output as { isTTY?: boolean }).isTTY === true, process.env),
      ...(isDefault && options.tui ? { footerIdentity } : {}),
      ...(isDefault && options.tui && options.permissionPolicy !== undefined ? {
        footerStatus: () => {
          if (activeSession.planMode) return "Plan · Shift+Tab Auto mode · /help";
          if (options.permissionPolicy?.mode === "workspace") return "Auto mode · Shift+Tab Ask for me · /help";
          if (options.permissionPolicy?.mode === "unrestricted") return "Unrestricted · Shift+Tab Plan · /help";
          return "Ask for me · Shift+Tab Plan · /help";
        },
        onShiftTab: async () => {
          const policy = options.permissionPolicy;
          if (policy === undefined) return;
          if (activeSession.planMode) {
            await activeSession.setPlanMode(false);
            policy.setMode("workspace");
          } else if (policy.mode === "workspace") {
            policy.setMode("ask-first");
          } else {
            await activeSession.setPlanMode(true);
          }
        },
      } : {}),
    });
    const resized = (): void => { editor.resized(); };
    const closed = (): void => { editor.cancel(); };
    tuiInput.setRawHandler(chunk => { editor.receive(chunk); });
    output.on("resize", resized);
    readline.once("close", closed);
    options.input.once("end", closed);
    try {
      editor.begin();
      const result = await pending;
      if (editor.exitRequested.value) readline.close();
      if (!isDefault) write(result === undefined ? "Draft discarded.\n" : "Draft submitted.\n");
      return result;
    } finally {
      tuiInput.setRawHandler(undefined);
      output.off("resize", resized);
      readline.off("close", closed);
      options.input.off("end", closed);
      composing = false;
    }
  };

  /** Read-only patch viewer, safe and separate from the model's tool calls. */
  const inspectPatch = async (override?: string, label?: string): Promise<void> => {
    const patch = override ?? mostRecentSuccessfulPatch(activeSession.messages);
    if (patch === undefined) {
      write("No successfully applied patch found in this session.\n");
      return;
    }
    if (tuiInput === undefined) {
      write("Interactive patch review requires the rich TUI in an interactive terminal; use /diff instead.\n");
      return;
    }
    menu?.clear();
    let resolveReview!: () => void;
    const pending = new Promise<void>(resolve => { resolveReview = resolve; });
    const output = options.output as typeof options.output & { columns?: number; rows?: number };
    const review = new PatchReviewController(output, patch, resolveReview,
      process.env.NO_COLOR === undefined && process.env.TERM !== "dumb", label);
    const resized = (): void => { review.resized(); };
    const closed = (): void => { review.cancel(); };
    tuiInput.setRawHandler(chunk => { review.receive(chunk); });
    output.on("resize", resized);
    readline.once("close", closed);
    try {
      review.begin();
      await pending;
    } finally {
      tuiInput.setRawHandler(undefined);
      output.off("resize", resized);
      readline.off("close", closed);
    }
  };

  const inspectLiveGitDiff = async (line: string): Promise<void> => {
    if (tuiInput === undefined) {
      write("Live Git review requires the rich TUI in an interactive terminal.\n");
      return;
    }
    if (line !== "/gitdiff" && line !== "/gitdiff --staged") {
      write("Usage: /diff [--staged]\n");
      return;
    }
    const mode: GitDiffMode = line.endsWith("--staged") ? "staged" : "all";
    // Explicit user confirmation before starting any local Git process.
    const root = terminalText(activeSession.cwd);
    write(`\nRead-only local Git review (${mode === "all" ? "staged, unstaged, and untracked" : "staged"}) in:\n${root}\nNo network, hooks, external diff or repository filters run; no files are written. Approve once? [y/N]\n`);
    tuiInput.acceptLine();
    tuiInput.setApprovalMode(true);
    readline.setPrompt("gitdiff> ");
    let allowed = false;
    try {
      readline.prompt();
      const answer = await readNextLine();
      allowed = answer?.trim().toLowerCase() === "y";
    } finally {
      tuiInput.setApprovalMode(false);
      readline.setPrompt(REPL_PROMPT);
    }
    if (!allowed) {
      write("Git diff review denied; no process started.\n");
      return;
    }
    try {
      const diff = await (options.gitDiffReader ?? readLiveGitDiff)(activeSession.cwd, mode);
      if (diff.trim().length === 0) {
        write(mode === "all" ? "No Git changes found.\n" : "No staged tracked Git changes found.\n");
        return;
      }
      await inspectPatch(diff, mode === "all" ? "live Git changes" : "live Git diff (staged)");
    } catch (error: unknown) {
      write(`${error instanceof Error ? error.message : "Git diff unavailable"}\n`);
    }
  };

  /** `/login` must name its target before any hidden key prompt. */
  const chooseLoginProvider = async (): Promise<string | undefined> => {
    const providers = options.providers;
    if (providers === undefined) return undefined;
    const ids = [...providers.providerIds()];
    if (ids.length === 0) return undefined;
    if (tuiInput === undefined) {
      return readProviderChoice(readNextLine, write, ids, providers.provider);
    }

    menu?.clear();
    dismissedLine = undefined;
    let resolveChoice!: (provider: string | undefined) => void;
    const pending = new Promise<string | undefined>(resolve => { resolveChoice = resolve; });
    const output = options.output as typeof options.output & { columns?: number; rows?: number };
    const picker = new ProviderPickerController(output, ids, providers.provider, resolveChoice);
    const resized = (): void => { picker.resized(); };
    const closed = (): void => { picker.cancel(); };
    tuiInput.setRawHandler(chunk => { picker.receive(chunk); });
    output.on("resize", resized);
    readline.once("close", closed);
    options.input.once("end", closed);
    try {
      picker.begin();
      return await pending;
    } finally {
      tuiInput.setRawHandler(undefined);
      output.off("resize", resized);
      readline.off("close", closed);
      options.input.off("end", closed);
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
      let line = options.inlineComposer && tuiInput !== undefined
        ? await collectEditor(true)
        : await readNextLine();
      if (line === undefined) {
        if (inputClosed) break;
        continue;
      }
      if (line.trim().length === 0) {
        showPrompt();
        continue;
      }

      const fromComposer = line.trim() === "/compose";
      const fromEditor = line.trim() === "/editor";
      if (line.trim() === "/review" || line.trim() === "/diff patch") {
        await inspectPatch();
        if (inputClosed) break;
        showPrompt();
        continue;
      }
      if (line.trim() === "/diff" || line.trim() === "/diff --staged" || line.trim().startsWith("/gitdiff")) {
        const gitDiffLine = line.trim().startsWith("/gitdiff")
          ? line.trim()
          : `/gitdiff${line.trim().slice("/diff".length)}`;
        await inspectLiveGitDiff(gitDiffLine);
        if (inputClosed) break;
        showPrompt();
        continue;
      }
      if (fromComposer || fromEditor) {
        if (options.inlineComposer && tuiInput !== undefined) {
          write("The cursor-addressable multiline editor is already active in this prompt. Enter sends; Ctrl+O inserts a newline.\n");
          if (inputClosed) break;
          showPrompt();
          continue;
        }
        const draft = fromEditor ? await collectEditor() : await collectMultiline();
        if (draft === undefined) {
          if (inputClosed) break;
          showPrompt();
          continue;
        }
        line = draft;
      }
      if (options.inlineComposer && tuiInput !== undefined) {
        const isOutputTTY = typeof options.output === "object" && options.output !== null && "isTTY" in options.output && options.output.isTTY === true;
        const useColor = options.tui === true && terminalColorEnabled(isOutputTTY, process.env);
        const prefix = useColor ? "\u001b[1m\u001b[2m›\u001b[0m " : "› ";
        const lines = line.split("\n");
        const formattedPrompt = lines.map((l, i) => `${i === 0 ? prefix : "  "}${terminalText(l)}`).join("\n");
        write(`\n${formattedPrompt}\n\n`);
      }
      const outcome = fromComposer || fromEditor ? "not-a-command" : handleSlashCommand(line, {
        session: activeSession,
        write,
        width: terminalWidth({ columns: (options.output as typeof options.output & { columns?: number }).columns }),
        color: options.tui === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
        ...(options.sessionFile === undefined
          ? {}
          : { sessionFile: options.sessionFile }),
        ...(options.sessionFileForSession === undefined ? {} : { sessionFileForSession: options.sessionFileForSession }),
        ...(options.extensionCommands === undefined
          ? {}
          : { extensionCommands: options.extensionCommands }),
        ...(options.signIn === undefined ? {} : { signIn: options.signIn }),
        ...(options.providers === undefined ? {} : { providers: options.providers }),
        ...(options.compactionEnabled === undefined ? {} : { compactionEnabled: options.compactionEnabled }),
        ...(options.providerName === undefined ? {} : { providerName: options.providerName }),
        ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
        ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        ...(options.permissionPolicy === undefined ? {} : { permissionPolicy: options.permissionPolicy }),
        ...(options.inlineComposer === true ? { inlineComposer: true } : {}),
        ...(tuiInput !== undefined ? { interactivePicker: true } : {}),
        ...(options.sessionOptions === undefined ? {} : { sessionOptions: options.sessionOptions }),
      });
      if (outcome === "exit") {
        break;
      }
      if (typeof outcome === "object" && outcome.kind === "login") {
        if (outcome.providerArgument === "__logout__") {
          const result = await options.signIn?.signOut?.();
          write(`${result ?? "Signed out of the current OAuth subscription."}\n`);
          showPrompt();
          continue;
        }
        if (outcome.providerArgument === "oauth" || /^oauth\s+(openai|xai)$/.test(outcome.providerArgument)) {
          const [, requested] = outcome.providerArgument.split(/\s+/, 2);
          const target = requested ?? options.providers?.provider ?? options.providerName;
          if (target !== "openai" && target !== "xai") {
            write("Use /login oauth openai or /login oauth xai.\n");
            showPrompt();
            continue;
          }
          if (options.signIn?.oauth === undefined) {
            write("OAuth sign-in is unavailable in this session.\n");
            showPrompt();
            continue;
          }
          if (options.providers && options.providers.provider !== target) {
            const selected = await options.providers.select(target);
            write(selected.message);
            if (!selected.ok) { showPrompt(); continue; }
          }
          controller = new AbortController();
          try {
            const failure = await options.signIn.oauth(target, controller.signal);
            write(failure ?? `Signed in to ${target} subscription for this session. API keys remain preferred on the next launch.\n`);
          } finally { controller = undefined; }
          showPrompt();
          continue;
        }
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
        } else if (options.providers !== undefined) {
          signingIn = true;
          let chosen: string | undefined;
          try {
            chosen = await chooseLoginProvider();
          } finally {
            signingIn = false;
          }
          if (chosen === undefined) {
            write("No Provider selected; no key was stored.\n");
            if (inputClosed) break;
            showPrompt();
            continue;
          }
          const selected = await options.providers.select(chosen);
          write(selected.message);
          if (!selected.ok) {
            if (inputClosed) break;
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
        if (inputClosed) break;
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && (outcome.kind === "provider" || outcome.kind === "model" || outcome.kind === "endpoint")) {
        if (options.providers !== undefined) {
          if (outcome.kind === "provider" && outcome.argument.length === 0 && tuiInput !== undefined) {
            signingIn = true;
            let chosen: string | undefined;
            try {
              chosen = await chooseLoginProvider();
            } finally {
              signingIn = false;
            }
            if (chosen === undefined) {
              write("No Provider selected; current Provider retained.\n");
              if (inputClosed) break;
              showPrompt();
              continue;
            }
            const selected = await options.providers.select(chosen);
            write(selected.message);
            if (selected.ok) await signInAfterProviderSelection();
            if (inputClosed) break;
            showPrompt();
            continue;
          }
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
      if (typeof outcome === "object" && outcome.kind === "compact") {
        if (options.compactionEnabled === false) write("Manual compaction is unavailable because --no-compaction is active.\n");
        else {
          controller = new AbortController();
          tuiInput?.setBusy(true);
          write("Compacting older conversation history… Ctrl+C cancels.\n");
          try {
            const compacted = await activeSession.compact(controller.signal);
            write(compacted ? "Compaction checkpoint saved. Full transcript retained.\n" : "Nothing new to compact; existing checkpoint retained.\n");
          } catch (error: unknown) {
            write(`Compaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
          } finally { controller = undefined; tuiInput?.setBusy(false); }
        }
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && outcome.kind === "rename") {
        try { await activeSession.rename(outcome.title); write(`Session renamed: ${activeSession.title}\n`); }
        catch (error: unknown) { write(`Rename failed: ${error instanceof Error ? error.message : String(error)}\n`); }
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && outcome.kind === "plan") {
        try {
          await activeSession.setPlanMode(outcome.enabled);
          write(`Plan Mode ${activeSession.planMode ? "on" : "off"}. ${activeSession.planMode ? "Only built-in read tools and update_plan may execute." : "Session capabilities restored."}\n`);
        } catch (error: unknown) { write(`Could not change Plan Mode: ${error instanceof Error ? error.message : String(error)}\n`); }
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && outcome.kind === "permission-mode") {
        options.permissionPolicy?.setMode(outcome.mode);
        write(`Permission mode set to ${outcome.mode}. ${describePermissionMode(outcome.mode)} This mode lasts for this process and will not be restored from a saved session.\n`);
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && outcome.kind === "new-session") {
        try {
          const next = await options.sessionOptions?.create?.(outcome.title);
          if (next === undefined) throw new Error("Session creation is unavailable.");
          await activeSession.close();
          activeSession = next;
          write(`Started a new session${next.title ? ` · ${next.title}` : ""}. Previous session saved.\n`);
        } catch (error: unknown) { write(`Could not start a new session: ${error instanceof Error ? error.message : String(error)}\n`); }
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && outcome.kind === "resume-session") {
        try {
          let id = outcome.id;
          if (!id) {
            const items = await options.sessionOptions?.list?.();
            if (!items?.length) throw new Error("No saved sessions in this workspace.");
            write(`Saved sessions in ${activeSession.cwd}:\n${items.map(item => `  ${item.id}${item.title ? ` · ${item.title}` : ""}`).join("\n")}\nUse /resume ID to switch.\n`);
          } else {
            const next = await options.sessionOptions?.resume?.(id);
            if (next === undefined) throw new Error(`Unknown session in this workspace: ${id}`);
            await activeSession.close();
            activeSession = next;
            write(`Resumed saved session${next.title ? ` · ${next.title}` : ""}.\n`);
          }
        } catch (error: unknown) { write(`Could not resume session: ${error instanceof Error ? error.message : String(error)}\n`); }
        showPrompt();
        continue;
      }
      if (typeof outcome === "object" && outcome.kind === "extension") {
        // An extension command runs here rather than inside the parser so it may
        // be async, and so a throwing command cannot take the REPL down.
        try {
          await outcome.command.run({
            session: activeSession,
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
        const prompt = () => activeSession.prompt(line, { signal, questionPresenter });
        if (options.tui) await withoutEcho(readline, prompt, () => questionMode);
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
    await activeSession.close();
  }
  return interrupted ? 130 : 0;
}

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { readonly version?: unknown };

export const VERSION =
  typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

import {
  defaultProviderRegistry,
  ProviderRegistry,
} from "./providers/registry.js";
import { DEFAULT_CONTEXT_WINDOW } from "./context/context-manager.js";
import type { ShellBackend } from "./shell/factory.js";
import { parsePermissionMode, type PermissionMode } from "./permissions.js";
import { parseBackendURL } from "./websearch/backend.js";

/** A Provider id known to the registry. */
export type Provider = string;

export const DEFAULT_MAX_TURNS = 8;
/**
 * Editing costs turns that reading does not: the model reads, edits, then
 * re-reads to confirm. Eight turns runs out mid-change, so enabling writes or
 * a shell raises the default unless --max-turns says otherwise.
 */
export const DEFAULT_WRITE_MAX_TURNS = 16;
const MIN_CONTEXT_WINDOW = 1_000;
const MAX_MAX_TURNS = 100;

/**
 * Provider-specific variables are declared by each Provider definition rather
 * than listed here, so adding a Provider does not touch this module.
 */
export type CliEnvironment = NodeJS.ProcessEnv;

export interface CliOptions {
  readonly prompt?: string;
  readonly provider: Provider;
  readonly model?: string;
  readonly baseURL?: string;
  readonly maxTurns: number;
  readonly stream: boolean;
  readonly quiet: boolean;
  /** Write the run as JSON lines instead of rendering it for a terminal. */
  readonly json: boolean;
  /** Record the session under the chivgent home directory. */
  readonly session: boolean;
  /** Resume this session id. */
  readonly resume?: string;
  /** Resume the most recent session recorded for this workspace. */
  readonly continueSession: boolean;
  /** List recorded sessions and exit. */
  readonly listSessions: boolean;
  /** Allow the agent to create and modify files in the workspace. */
  readonly allowWrites: boolean;
  /** Allow the agent to run shell commands inside the selected sandbox. */
  readonly allowShell: boolean;
  /** Explicitly approve every command in this session; sandbox isolation still applies. */
  readonly approveAllShell: boolean;
  readonly shellBackend: ShellBackend;
  readonly shellNetwork: boolean;
  /** Explicitly configured SearXNG endpoint; absent means no web search tool. */
  readonly webSearch?: {
    readonly url: string;
    /** Bearer token from CHIVGENT_WEB_SEARCH_TOKEN, never argv. */
    readonly token?: string;
  };
  /** Explicit policy for tool approval boundaries; absent preserves legacy flags. */
  readonly permissionMode?: PermissionMode;
  /** Explicitly request the rich terminal interface. */
  readonly tui: boolean;
  /** Force the traditional append-only terminal interface. */
  readonly simple: boolean;
  /** Load extensions from the user and (once trusted) the project directory. */
  readonly extensions: boolean;
  /** List loaded extensions and what they registered, then exit. */
  readonly listExtensions: boolean;
  /** Forget the trust decision covering this workspace and exit. */
  readonly forgetTrust: boolean;
  /** Expose this session on a local socket and stay running. */
  readonly serve: boolean;
  /** Attach to a session served elsewhere; a session id or a socket path. */
  readonly connect?: string;
  /** List the servers that are still answering, then exit. */
  readonly listServers: boolean;
  /** API key supplied for this run only, overriding every other source. */
  readonly apiKey?: string;
  /** Token budget the context is kept inside. */
  readonly contextWindow: number;
  /** Summarise old history when the context approaches the window. */
  readonly compaction: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export function parseCliArgs(
  argv: readonly string[],
  environment: CliEnvironment,
  registry: ProviderRegistry = defaultProviderRegistry,
): CliOptions {
  let provider: Provider = "openai";
  let requestedModel: string | undefined;
  let apiKey: string | undefined;
  let contextWindow = DEFAULT_CONTEXT_WINDOW;
  let compaction = true;
  let maxTurns = DEFAULT_MAX_TURNS;
  let stream = true;
  let quiet = false;
  let json = false;
  let session = true;
  let resume: string | undefined;
  let continueSession = false;
  let listSessions = false;
  let allowWrites = false;
  let allowShell = false;
  let approveAllShell = false;
  let shellBackend: ShellBackend = "auto";
  let shellNetwork = false;
  let webSearchURL: string | undefined;
  let permissionMode: PermissionMode | undefined;
  let tui = false;
  let simple = false;
  let extensions = true;
  let serve = false;
  let connect: string | undefined;
  let listServers = false;
  let listExtensions = false;
  let forgetTrust = false;
  let maxTurnsExplicit = false;
  let help = false;
  let version = false;
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--version" || argument === "-v") {
      version = true;
    } else if (argument === "--provider") {
      const value = readOptionValue(argv, index, "--provider");
      provider = parseProvider(value, registry);
      index += 1;
    } else if (argument === "--model") {
      requestedModel = readOptionValue(argv, index, "--model");
      index += 1;
    } else if (argument === "--api-key") {
      apiKey = readOptionValue(argv, index, "--api-key");
      if (apiKey.length === 0) {
        // An empty key would fall through to the environment and then the
        // stored file, so an unset shell variable would silently run against
        // a different credential than the one named on the command line.
        throw new TypeError("--api-key requires a value.");
      }
      index += 1;
    } else if (argument === "--max-turns") {
      maxTurns = parseMaxTurns(readOptionValue(argv, index, "--max-turns"));
      maxTurnsExplicit = true;
      index += 1;
    } else if (argument === "--no-stream") {
      stream = false;
    } else if (argument === "--tui") {
      tui = true;
    } else if (argument === "--simple") {
      simple = true;
    } else if (argument === "--quiet" || argument === "-q") {
      quiet = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--no-session") {
      session = false;
    } else if (argument === "--resume") {
      resume = readOptionValue(argv, index, "--resume");
      index += 1;
    } else if (argument === "--continue" || argument === "-c") {
      continueSession = true;
    } else if (argument === "--sessions") {
      listSessions = true;
    } else if (argument === "--allow-writes") {
      allowWrites = true;
    } else if (argument === "--allow-shell") {
      allowShell = true;
    } else if (argument === "--approve-all-shell") {
      approveAllShell = true;
    } else if (argument === "--shell-backend") {
      const value = readOptionValue(argv, index, "--shell-backend");
      if (value !== "auto" && value !== "native" && value !== "docker") throw new TypeError("--shell-backend must be auto, native, or docker.");
      shellBackend = value;
      index += 1;
    } else if (argument === "--shell-network") {
      shellNetwork = true;
    } else if (argument === "--web-search") {
      webSearchURL = readOptionValue(argv, index, "--web-search");
      parseBackendURL(webSearchURL);
      index += 1;
    } else if (argument === "--permission-mode") {
      permissionMode = parsePermissionMode(readOptionValue(argv, index, "--permission-mode"));
      index += 1;
    } else if (argument === "--serve") {
      serve = true;
    } else if (argument === "--connect") {
      connect = readOptionValue(argv, index, "--connect");
      index += 1;
    } else if (argument === "--servers") {
      listServers = true;
    } else if (argument === "--no-extensions") {
      extensions = false;
    } else if (argument === "--extensions") {
      listExtensions = true;
    } else if (argument === "--forget-trust") {
      forgetTrust = true;
    } else if (argument === "--context-window") {
      contextWindow = parseContextWindow(
        readOptionValue(argv, index, "--context-window"),
      );
      index += 1;
    } else if (argument === "--no-compaction") {
      compaction = false;
    } else if (argument === "--") {
      promptParts.push(...argv.slice(index + 1));
      break;
    } else if (argument?.startsWith("-")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      promptParts.push(argument);
    }
  }

  if (approveAllShell && !allowShell) {
    throw new TypeError("--approve-all-shell requires --allow-shell.");
  }
  if (tui && simple) {
    throw new TypeError("--tui and --simple cannot be used together.");
  }
  if (permissionMode !== undefined && (allowWrites || allowShell || approveAllShell || shellNetwork)) {
    throw new TypeError("--permission-mode cannot be combined with --allow-writes, --allow-shell, --approve-all-shell, or --shell-network; select the complete policy mode instead.");
  }
  if (permissionMode !== undefined && connect !== undefined) {
    throw new TypeError("--permission-mode applies to local sessions and cannot be used with --connect.");
  }
  if (webSearchURL !== undefined && connect !== undefined) {
    throw new TypeError("--web-search applies to local sessions and cannot be used with --connect.");
  }
  if (permissionMode !== undefined && serve) {
    throw new TypeError("--permission-mode cannot be used with --serve because served sessions do not have an interactive approval channel.");
  }

  const definition = registry.get(provider);
  const model =
    requestedModel ||
    firstEnvironmentValue(environment, definition.modelEnvKeys) ||
    definition.defaultModel;
  const baseURL =
    firstEnvironmentValue(environment, definition.baseUrlEnvKeys) ||
    definition.defaultBaseURL;

  return {
    ...(promptParts.length === 0 ? {} : { prompt: promptParts.join(" ") }),
    provider,
    ...(model === undefined ? {} : { model }),
    ...(baseURL === undefined ? {} : { baseURL }),
    maxTurns:
      (allowWrites || allowShell || permissionMode !== undefined) && !maxTurnsExplicit
        ? DEFAULT_WRITE_MAX_TURNS
        : maxTurns,
    stream,
    quiet,
    json,
    session,
    ...(resume === undefined ? {} : { resume }),
    continueSession,
    listSessions,
    allowWrites,
    allowShell,
    approveAllShell,
    shellBackend,
    shellNetwork,
    ...(webSearchURL === undefined ? {} : {
      webSearch: {
        url: webSearchURL,
        ...(environment.CHIVGENT_WEB_SEARCH_TOKEN === undefined ||
            environment.CHIVGENT_WEB_SEARCH_TOKEN.length === 0
          ? {}
          : { token: environment.CHIVGENT_WEB_SEARCH_TOKEN }),
      },
    }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    tui,
    simple,
    extensions,
    serve,
    ...(connect === undefined ? {} : { connect }),
    listServers,
    listExtensions,
    forgetTrust,
    ...(apiKey === undefined ? {} : { apiKey }),
    contextWindow,
    compaction,
    help,
    version,
  };
}

export function helpText(
  registry: ProviderRegistry = defaultProviderRegistry,
): string {
  return `chivgent ${VERSION}

Usage:
  chivgent [options] "question"     Answer one question and exit
  chivgent [options]                Start an interactive session
  chivgent update [--check]         Update the npm global installation

Options:
  --provider NAME  ${registry.ids().join(", ")} (default: openai)
  --model MODEL    Provider model override
  --api-key KEY    API key for this run; prefer an environment variable
  --max-turns N    Tool-calling turn limit (default: ${DEFAULT_MAX_TURNS}, ${DEFAULT_WRITE_MAX_TURNS} with --allow-writes or --allow-shell)
  --no-stream      Wait for the full answer instead of streaming tokens
  --tui            Explicitly request the rich interface (default in local TTY sessions)
  --simple         Use the simple append-only interface
  -q, --quiet      Hide tool activity on stderr
  --json           Write the run as JSON lines instead of rendered text
  -c, --continue   Resume the most recent session for this workspace
  --resume ID      Resume a specific session
  --sessions       List recorded sessions and exit
  --allow-writes   Let the agent create and change files (default: read-only)
  --allow-shell    Expose bash inside a native macOS sandbox or Docker (network denied).
                   Interactive commands require individual confirmation.
  --shell-backend MODE  auto, native, or docker (default: auto; macOS uses native).
  --shell-network  Allow shell network access (explicit opt-in for either backend).
  --web-search URL  Enable web_search through a SearXNG JSON endpoint. Ask-first
                   and workspace modes prompt for each query.
  --permission-mode MODE  ask-first, workspace, or unrestricted (network enabled).
  --approve-all-shell  Explicitly approve all shell commands this session;
                   use only with --allow-shell when individual prompts are unavailable.
  --serve          Expose this session on a local socket and keep running
  --connect TARGET Attach to a served session, by id or socket path
  --servers        List the servers still answering, then exit
  --no-extensions  Do not load any extension, and do not ask about trust
  --extensions     List loaded extensions and what they register, then exit
  --forget-trust   Forget the trust decision covering this workspace, then exit
  --context-window N  Token budget for the context (default: ${DEFAULT_CONTEXT_WINDOW})
  --no-compaction  Send the whole transcript instead of summarising old turns
  --no-session     Do not record this run
  -h, --help       Show help
  -v, --version    Show version

API keys are resolved in this order, first match wins:
  --api-key  ->  environment variable  ->  <CHIVGENT_HOME>/auth.json

Providers:
${describeProviders(registry)}
Extensions:
  <CHIVGENT_HOME>/extensions/*.js   Always loaded
  <workspace>/.chivgent/extensions/*.js
                   Loaded only after you trust the project. An extension runs
                   as code inside chivgent, with your permissions, and is not
                   limited by the workspace.

Remote sessions:
  chivgent --serve             Hold a session and expose it locally
  chivgent --connect ID        Attach from another terminal
  Anyone who can reach the socket gets everything the server was started with.
  Sockets live in <CHIVGENT_HOME>/sockets, an owner-only directory.

Environment:
  OPENAI_BASE_URL  Required when --provider openai-compatible
  CHIVGENT_HOME    Session, auth, trust and extension directory (default: ~/.chivgent)
  CHIVGENT_WEB_SEARCH_TOKEN  Bearer token for --web-search; never put it in argv
`;
}

function describeProviders(registry: ProviderRegistry): string {
  const ids = registry.ids();
  const width = Math.max(...ids.map((id) => id.length)) + 2;
  return ids
    .map((id) => {
      const definition = registry.get(id);
      const model =
        definition.defaultModel === undefined
          ? "model required"
          : `default ${definition.defaultModel}`;
      return `  ${id.padEnd(width)}${definition.envKeys.join(", ")} (${model})`;
    })
    .join("\n");
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new TypeError(`${option} requires a value.`);
  }
  return value;
}

function parseContextWindow(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CONTEXT_WINDOW) {
    throw new TypeError(
      `--context-window must be an integer of at least ${MIN_CONTEXT_WINDOW}.`,
    );
  }
  return parsed;
}

function parseMaxTurns(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MAX_TURNS) {
    throw new TypeError(
      `--max-turns must be an integer from 1 to ${MAX_MAX_TURNS}.`,
    );
  }
  return parsed;
}

function parseProvider(value: string, registry: ProviderRegistry): Provider {
  if (!registry.has(value)) {
    throw new TypeError(
      `Unsupported provider: ${value}. Expected one of ${registry.ids().join(", ")}.`,
    );
  }
  return value;
}

function firstEnvironmentValue(
  environment: CliEnvironment,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = environment[key];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

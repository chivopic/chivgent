import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { readonly version?: unknown };

export const VERSION =
  typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

export type Provider = "openai" | "deepseek" | "openai-compatible";

export const DEFAULT_MAX_TURNS = 8;
const MAX_MAX_TURNS = 100;

const DEFAULT_MODELS = {
  openai: "gpt-5.6",
  deepseek: "deepseek-v4-flash",
} as const;

export interface CliEnvironment {
  readonly OPENAI_MODEL?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly DEEPSEEK_MODEL?: string;
  readonly CHIVGENT_HOME?: string;
}

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
  readonly help: boolean;
  readonly version: boolean;
}

export function parseCliArgs(
  argv: readonly string[],
  environment: CliEnvironment,
): CliOptions {
  let provider: Provider = "openai";
  let requestedModel: string | undefined;
  let maxTurns = DEFAULT_MAX_TURNS;
  let stream = true;
  let quiet = false;
  let json = false;
  let session = true;
  let resume: string | undefined;
  let continueSession = false;
  let listSessions = false;
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
      provider = parseProvider(value);
      index += 1;
    } else if (argument === "--model") {
      requestedModel = readOptionValue(argv, index, "--model");
      index += 1;
    } else if (argument === "--max-turns") {
      maxTurns = parseMaxTurns(readOptionValue(argv, index, "--max-turns"));
      index += 1;
    } else if (argument === "--no-stream") {
      stream = false;
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
    } else if (argument?.startsWith("-")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      promptParts.push(argument);
    }
  }

  const environmentModel =
    provider === "deepseek"
      ? environment.DEEPSEEK_MODEL
      : environment.OPENAI_MODEL;
  const defaultModel =
    provider === "openai-compatible" ? undefined : DEFAULT_MODELS[provider];
  const model = requestedModel || environmentModel || defaultModel;

  return {
    ...(promptParts.length === 0 ? {} : { prompt: promptParts.join(" ") }),
    provider,
    ...(model === undefined ? {} : { model }),
    ...(provider === "openai-compatible" && environment.OPENAI_BASE_URL
      ? { baseURL: environment.OPENAI_BASE_URL }
      : {}),
    maxTurns,
    stream,
    quiet,
    json,
    session,
    ...(resume === undefined ? {} : { resume }),
    continueSession,
    listSessions,
    help,
    version,
  };
}

export function helpText(): string {
  return `chivgent ${VERSION}

Usage:
  chivgent [options] "question"     Answer one question and exit
  chivgent [options]                Start an interactive session

Options:
  --provider NAME  openai, deepseek, or openai-compatible (default: openai)
  --model MODEL    Provider model override
  --max-turns N    Tool-calling turn limit (default: ${DEFAULT_MAX_TURNS})
  --no-stream      Wait for the full answer instead of streaming tokens
  -q, --quiet      Hide tool activity on stderr
  --json           Write the run as JSON lines instead of rendered text
  -c, --continue   Resume the most recent session for this workspace
  --resume ID      Resume a specific session
  --sessions       List recorded sessions and exit
  --no-session     Do not record this run
  -h, --help       Show help
  -v, --version    Show version

Environment:
  OPENAI_API_KEY   Required for openai and openai-compatible
  OPENAI_MODEL     OpenAI model (default: ${DEFAULT_MODELS.openai}); required for compatible
  OPENAI_BASE_URL  Required when --provider openai-compatible
  DEEPSEEK_API_KEY Required when --provider deepseek
  DEEPSEEK_MODEL   Optional DeepSeek model (default: ${DEFAULT_MODELS.deepseek})
  CHIVGENT_HOME    Session directory (default: ~/.chivgent)
`;
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

function parseMaxTurns(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MAX_TURNS) {
    throw new TypeError(
      `--max-turns must be an integer from 1 to ${MAX_MAX_TURNS}.`,
    );
  }
  return parsed;
}

function parseProvider(value: string): Provider {
  if (
    value !== "openai" &&
    value !== "deepseek" &&
    value !== "openai-compatible"
  ) {
    throw new TypeError(
      `Unsupported provider: ${value}. Expected openai, deepseek, or openai-compatible.`,
    );
  }
  return value;
}

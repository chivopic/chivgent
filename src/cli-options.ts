import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { readonly version?: unknown };

export const VERSION =
  typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

import {
  defaultProviderRegistry,
  ProviderRegistry,
} from "./providers/registry.js";

/** A Provider id known to the registry. */
export type Provider = string;

export const DEFAULT_MAX_TURNS = 8;
/**
 * Editing costs turns that reading does not: the model reads, edits, then
 * re-reads to confirm. Eight turns runs out mid-change, so enabling writes
 * raises the default unless --max-turns says otherwise.
 */
export const DEFAULT_WRITE_MAX_TURNS = 16;
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
  /** API key supplied for this run only, overriding every other source. */
  readonly apiKey?: string;
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
  let maxTurns = DEFAULT_MAX_TURNS;
  let stream = true;
  let quiet = false;
  let json = false;
  let session = true;
  let resume: string | undefined;
  let continueSession = false;
  let listSessions = false;
  let allowWrites = false;
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
      index += 1;
    } else if (argument === "--max-turns") {
      maxTurns = parseMaxTurns(readOptionValue(argv, index, "--max-turns"));
      maxTurnsExplicit = true;
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
    } else if (argument === "--allow-writes") {
      allowWrites = true;
    } else if (argument?.startsWith("-")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      promptParts.push(argument);
    }
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
      allowWrites && !maxTurnsExplicit ? DEFAULT_WRITE_MAX_TURNS : maxTurns,
    stream,
    quiet,
    json,
    session,
    ...(resume === undefined ? {} : { resume }),
    continueSession,
    listSessions,
    allowWrites,
    ...(apiKey === undefined ? {} : { apiKey }),
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

Options:
  --provider NAME  ${registry.ids().join(", ")} (default: openai)
  --model MODEL    Provider model override
  --api-key KEY    API key for this run; prefer an environment variable
  --max-turns N    Tool-calling turn limit (default: ${DEFAULT_MAX_TURNS}, ${DEFAULT_WRITE_MAX_TURNS} with --allow-writes)
  --no-stream      Wait for the full answer instead of streaming tokens
  -q, --quiet      Hide tool activity on stderr
  --json           Write the run as JSON lines instead of rendered text
  -c, --continue   Resume the most recent session for this workspace
  --resume ID      Resume a specific session
  --sessions       List recorded sessions and exit
  --allow-writes   Let the agent create and change files (default: read-only)
  --no-session     Do not record this run
  -h, --help       Show help
  -v, --version    Show version

API keys are resolved in this order, first match wins:
  --api-key  ->  environment variable  ->  <CHIVGENT_HOME>/auth.json

Providers:
${describeProviders(registry)}
Environment:
  OPENAI_BASE_URL  Required when --provider openai-compatible
  CHIVGENT_HOME    Session and auth directory (default: ~/.chivgent)
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

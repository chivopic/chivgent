export const VERSION = "0.4.0";

export type Provider = "openai" | "deepseek" | "openai-compatible";

const DEFAULT_MODELS = {
  openai: "gpt-5.6",
  deepseek: "deepseek-v4-flash",
} as const;

export interface CliEnvironment {
  readonly OPENAI_MODEL?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly DEEPSEEK_MODEL?: string;
}

export interface CliOptions {
  readonly prompt?: string;
  readonly provider: Provider;
  readonly model?: string;
  readonly baseURL?: string;
  readonly help: boolean;
  readonly version: boolean;
}

export function parseCliArgs(
  argv: readonly string[],
  environment: CliEnvironment,
): CliOptions {
  let provider: Provider = "openai";
  let requestedModel: string | undefined;
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
    help,
    version,
  };
}

export function helpText(): string {
  return `chivgent ${VERSION}

Usage:
  chivgent [--provider openai|deepseek|openai-compatible] [--model MODEL] "question"

Options:
  --provider NAME  openai, deepseek, or openai-compatible (default: openai)
  --model MODEL    Provider model override
  -h, --help       Show help
  -v, --version    Show version

Environment:
  OPENAI_API_KEY   Required for openai and openai-compatible
  OPENAI_MODEL     OpenAI model (default: ${DEFAULT_MODELS.openai}); required for compatible
  OPENAI_BASE_URL  Required when --provider openai-compatible
  DEEPSEEK_API_KEY Required when --provider deepseek
  DEEPSEEK_MODEL   Optional DeepSeek model (default: ${DEFAULT_MODELS.deepseek})
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

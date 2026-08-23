export const VERSION = "0.2.0";

export type Provider = "openai" | "deepseek";

const DEFAULT_MODELS: Readonly<Record<Provider, string>> = {
  openai: "gpt-5.6",
  deepseek: "deepseek-v4-flash",
};

export interface CliEnvironment {
  readonly OPENAI_MODEL?: string;
  readonly DEEPSEEK_MODEL?: string;
}

export interface CliOptions {
  readonly prompt?: string;
  readonly provider: Provider;
  readonly model: string;
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
    provider === "openai"
      ? environment.OPENAI_MODEL
      : environment.DEEPSEEK_MODEL;

  return {
    ...(promptParts.length === 0 ? {} : { prompt: promptParts.join(" ") }),
    provider,
    model: requestedModel || environmentModel || DEFAULT_MODELS[provider],
    help,
    version,
  };
}

export function helpText(): string {
  return `chivgent ${VERSION}

Usage:
  chivgent [--provider openai|deepseek] [--model MODEL] "question"

Options:
  --provider NAME  LLM Provider: openai or deepseek (default: openai)
  --model MODEL    Provider model override
  -h, --help       Show help
  -v, --version    Show version

Environment:
  OPENAI_API_KEY   Required when --provider openai
  OPENAI_MODEL     Optional OpenAI model (default: ${DEFAULT_MODELS.openai})
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
  if (value !== "openai" && value !== "deepseek") {
    throw new TypeError(
      `Unsupported provider: ${value}. Expected openai or deepseek.`,
    );
  }
  return value;
}

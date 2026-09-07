import type { Capability } from "./task.js";

/**
 * Argument parsing lives apart from the entry point.
 *
 * cli.ts runs main() when imported, so anything that wants to test the parsing
 * would start an eval run just by importing it.
 */
export interface EvalOptions {
  readonly tasks: readonly string[];
  readonly attempts?: number;
  readonly directory: string;
  readonly jsonPath?: string;
  readonly capabilities: readonly Capability[];
  readonly providerArgs: readonly string[];
  readonly help: boolean;
}

/**
 * Options handed straight to the main CLI's parser.
 *
 * --api-key is here because the credential chain names it the highest-priority
 * source: an ephemeral machine gets its key as a flag, not as stored state.
 */
const PROVIDER_OPTIONS = new Set(["--provider", "--model", "--api-key"]);

export function parseEvalArgs(argv: readonly string[]): EvalOptions {
  const tasks: string[] = [];
  const capabilities: Capability[] = [];
  const providerArgs: string[] = [];
  let attempts: number | undefined;
  let directory = "evals";
  let jsonPath: string | undefined;
  let help = false;

  const value = (index: number, option: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new TypeError(`${option} requires a value.`);
    }
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--task") {
      tasks.push(value(index, "--task"));
      index += 1;
    } else if (argument === "--attempts") {
      const parsed = Number(value(index, "--attempts"));
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
        throw new TypeError("--attempts must be an integer from 1 to 50.");
      }
      attempts = parsed;
      index += 1;
    } else if (argument === "--dir") {
      directory = value(index, "--dir");
      index += 1;
    } else if (argument === "--json") {
      jsonPath = value(index, "--json");
      index += 1;
    } else if (argument === "--allow-writes") {
      capabilities.push("writes");
    } else if (argument === "--allow-shell") {
      capabilities.push("shell");
    } else if (argument !== undefined && PROVIDER_OPTIONS.has(argument)) {
      // Passed through so the Provider registry resolves them exactly as the
      // real CLI does, including environment fallbacks.
      providerArgs.push(argument, value(index, argument));
      index += 1;
    } else if (argument !== undefined) {
      throw new TypeError(`Unknown option: ${argument}`);
    }
  }

  return {
    tasks,
    ...(attempts === undefined ? {} : { attempts }),
    directory,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    capabilities,
    providerArgs,
    help,
  };
}
